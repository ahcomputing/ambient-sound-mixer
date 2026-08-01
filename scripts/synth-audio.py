#!/usr/bin/env python3
"""synth-audio.py — generate the mixer's rain/thunder beds from scratch.

    ./scripts/synth-audio.py [id ...]      # default: all of them

Writes assets/audio/{id}.mp3 and updates assets/audio/manifest.json.
Run scripts/verify-audio.py afterwards; it is the gate.

WHY GRANULAR AND NOT SHAPED NOISE
---------------------------------
The first version built each bed as filtered noise and it read as static, not
rain. The reason is statistical rather than spectral: filtered noise is
Gaussian, so its amplitude distribution is thin-tailed and every instant sounds
like every other instant. Real rain is a heavy-tailed shower of discrete
impacts — thousands of faint far ones per second and the occasional near one
several times louder. That ratio, not the spectrum, is what the ear reads as
"rain". Peak-to-RMS tells them apart: shaped noise sits near 12 dB, and the
real field recording behind `rain-true` measures 16.4 dB.

So the beds are now built by scattering Poisson-distributed impacts with a
power-law amplitude distribution and convolving them with per-surface resonator
templates. The convolution is circular, over exactly one loop length, which is
also what keeps the loop seamless: a grain landing near the end wraps into the
head instead of being truncated. No crossfade anywhere.
"""

import sys

import numpy as np
from scipy import fft as sfft

from audiolib import SR, crest_db, master, update_manifest, write_mp3


# ── spectral building blocks (magnitude responses on a frequency grid) ───────

def lowpass(f, fc, order=2):
    return 1.0 / np.sqrt(1.0 + (f / fc) ** (2 * order))


def highpass(f, fc, order=2):
    x = (np.maximum(f, 1e-6) / fc) ** order
    return x / np.sqrt(1.0 + x ** 2)


def tilt(f, f0, db_per_oct):
    return 10.0 ** (db_per_oct * np.log2(np.maximum(f, 1e-6) / f0) / 20.0)


def peak(f, fc, q, gain_db):
    """Broad resonant bump. Keep the gains modest — this is the knob that made
    the first metal and tin roofs 'too metallic', and it is cheap to overdo."""
    fs = np.maximum(f, 1e-6)
    return 1.0 + (10.0 ** (gain_db / 20.0) - 1.0) / (1.0 + ((fs / fc - fc / fs) * q) ** 2)


# ── periodic primitives ─────────────────────────────────────────────────────

def periodic_noise(n, shape, rng, mono_below=500.0):
    """Stereo noise exactly periodic over n samples. Phase is randomised per
    channel above `mono_below` for width, shared below it to keep bass centred."""
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    mag = shape(freqs)
    ph_l = rng.uniform(0, 2 * np.pi, freqs.size)
    ph_r = rng.uniform(0, 2 * np.pi, freqs.size)
    ph_r[freqs < mono_below] = ph_l[freqs < mono_below]

    chans = []
    for ph in (ph_l, ph_r):
        spec = mag * np.exp(1j * ph)
        spec[0] = 0.0                       # no DC
        spec[-1] = np.abs(spec[-1])         # Nyquist bin must be real
        chans.append(np.fft.irfft(spec, n))
    return np.stack(chans, axis=1)


def periodic_lfo(n, rng, fc, order=2):
    """Slow periodic wander in [-1, 1] — rain intensity, thunder swell."""
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    mag = lowpass(freqs, fc, order) * highpass(freqs, fc / 6.0, 1)
    spec = mag * np.exp(1j * rng.uniform(0, 2 * np.pi, freqs.size))
    spec[0] = 0.0
    spec[-1] = np.abs(spec[-1])
    x = np.fft.irfft(spec, n)
    return x / (np.max(np.abs(x)) + 1e-12)


def unit(x):
    """Normalise to unit RMS so layer weights mean something."""
    return x / (np.sqrt(np.mean(x ** 2)) + 1e-12)


# ── grains ──────────────────────────────────────────────────────────────────

def make_drop(rng, f0_lo, f0_hi, decay_ms, partials, click, lp_hz):
    """One impact: a struck resonance plus its attack transient.

    `lp_hz` is not decoration. The attack is a broadband click, and unfiltered
    it puts the same top octave on every surface — which made asphalt shingle
    measure as bright as sheet metal and collapsed the catalogue into one sound
    with different beds.
    """
    tau = decay_ms / 1000.0
    n = max(64, int(SR * tau * 6))
    t = np.arange(n) / SR
    w = np.zeros(n)
    f0 = rng.uniform(f0_lo, f0_hi)
    for k in range(partials):
        # Higher modes are both detuned and shorter-lived, as struck bodies are.
        fk = f0 if k == 0 else f0 * rng.uniform(1.4, 3.6)
        w += rng.uniform(0.35, 1.0) * np.sin(2 * np.pi * fk * t + rng.uniform(0, 2 * np.pi)) \
             * np.exp(-t / (tau / (1.0 + 0.8 * k)))
    w += click * rng.standard_normal(n) * np.exp(-t / 0.0016)

    spec = np.fft.rfft(w)
    spec *= lowpass(np.fft.rfftfreq(n, 1.0 / SR), lp_hz, 2)
    w = np.fft.irfft(spec, n)
    return w / (np.max(np.abs(w)) + 1e-12)


def impacts(n, rng, rate, drop, seconds, alpha=1.6, clip=25.0, spread=1.0, variants=14):
    """Scatter Poisson impacts and convolve them circularly with a template bank.

    Amplitudes follow a power law (u**(-1/alpha), clipped) rather than anything
    bounded and well-behaved. That heavy tail is the whole point: most grains
    are barely there and a few are twenty times louder, which is the amplitude
    statistic that separates rain from static.

    Done as one circular FFT convolution per template, so grain count is
    essentially free — a quarter-million impacts costs the same as a thousand.
    """
    count = int(rate * seconds)
    pos = rng.integers(0, n, count)
    amp = np.minimum(rng.random(count) ** (-1.0 / alpha), clip) / clip
    pan = rng.uniform(-spread, spread, count)
    var = rng.integers(0, variants, count)
    gl = amp * np.sqrt((1.0 - pan) / 2.0)
    gr = amp * np.sqrt((1.0 + pan) / 2.0)

    out = np.zeros((n, 2))
    for v in range(variants):
        m = var == v
        if not m.any():
            continue
        tmpl = np.zeros(n)
        w = make_drop(rng, *drop)
        tmpl[:min(w.size, n)] = w[:n]
        spec = sfft.rfft(tmpl, workers=-1)
        for ch, g in ((0, gl), (1, gr)):
            sparse = np.bincount(pos[m], g[m], minlength=n)
            out[:, ch] += sfft.irfft(sfft.rfft(sparse, workers=-1) * spec, n, workers=-1)
    return out


# ── voices ──────────────────────────────────────────────────────────────────

def rain(seconds, seed, bed_shape, layers, w_bed, gust_depth, gust_fc, mono_below=500.0):
    """A far wash plus two grain layers: the dense mist that merges into a roar,
    and the sparser near drops you actually resolve one at a time."""
    rng = np.random.default_rng(seed)
    n = int(SR * seconds)

    buf = w_bed * unit(periodic_noise(n, bed_shape, rng, mono_below=mono_below))
    for w, rate, drop, kw in layers:
        buf += w * unit(impacts(n, rng, rate, drop, seconds, **kw))

    # Shallow: real steady rain does not pulse, and anything periodic enough to
    # notice becomes the thing you listen for instead of sleeping through.
    return buf * (1.0 + gust_depth * periodic_lfo(n, rng, gust_fc))[:, None]


def thunder(seconds, seed, body_lp, air_mix, swells, rise_s, fall_s, floor=0.18):
    """A rumble *bed* — swells, never a crack. Discrete strikes are out of scope
    for v1, and a transient is the one thing guaranteed to wake somebody. Even
    the close variant only rises over ~1.2s, which is assertive without being a
    startle."""
    rng = np.random.default_rng(seed)
    n = int(SR * seconds)

    body = periodic_noise(n, lambda f: highpass(f, 22, 2) * lowpass(f, body_lp, 2), rng, mono_below=200)
    air = periodic_noise(n, lambda f: highpass(f, 200, 1) * lowpass(f, 1400, 2) * tilt(f, 400, -3), rng)

    env = np.full(n, floor)
    t = np.arange(n) / SR
    for _ in range(swells):
        pos = rng.uniform(0, seconds)
        # Signed circular offset, so a swell may straddle the loop point and
        # still rise and fall in the right order.
        dd = ((t - pos + seconds / 2) % seconds) - seconds / 2
        width = np.where(dd < 0, rise_s * rng.uniform(0.8, 1.3), fall_s * rng.uniform(0.8, 1.3))
        env += rng.uniform(0.5, 1.0) * np.exp(-(dd / width) ** 2)
    env *= 1.0 + 0.25 * periodic_lfo(n, rng, 0.12)

    return (body + air_mix * air) * env[:, None]


# ── the catalogue ───────────────────────────────────────────────────────────
# Surfaces differ in three ways: where the far wash sits spectrally, what a
# single drop hitting them rings like, and how dense the near drops are.
#
# `default` is the slider position the app starts a row at. These are derived
# from Aaron's own audition mix, converted to loudness terms — see README notes
# in audiolib.master(). Metal and tin are nudged up from what that maths gave,
# because his levels were set against the over-resonant first versions and were
# partly compensating for harshness that has since been reduced.

RAIN_S, THUNDER_S = 24.0, 40.0
TARGET_LUFS = -26.0

VOICES = {
    "rain-field": dict(
        default=71,
        make=lambda: rain(
            RAIN_S, 1001,
            lambda f: highpass(f, 110, 2) * lowpass(f, 7000, 1) * tilt(f, 1000, -3.5),
            layers=[
                (0.85, 9000, (700, 3000, 2.2, 1, 0.9, 7000), {}),
                (0.40, 220, (900, 2500, 6.0, 1, 0.6, 6000), {}),
            ],
            w_bed=0.40, gust_depth=0.16, gust_fc=0.10,
        ),
    ),
    "rain-metal-roof": dict(
        default=30,
        make=lambda: rain(
            RAIN_S, 1002,
            # Resonance pulled back from +8/+5 dB to +4/+2.5: the ring is meant
            # to colour the roar, not to be the sound.
            lambda f: highpass(f, 100, 2) * lowpass(f, 8000, 1)
                      * peak(f, 2200, 1.0, 4.0) * peak(f, 3800, 1.6, 2.5),
            layers=[
                (0.80, 9000, (900, 3200, 2.5, 1, 0.9, 8000), {}),
                # Decay 45ms -> 16ms and one fewer partial. A long ring on every
                # near drop is what read as tinny.
                (0.50, 340, (1200, 2600, 16.0, 2, 0.85, 8000), {}),
            ],
            w_bed=0.42, gust_depth=0.15, gust_fc=0.09,
        ),
    ),
    "rain-tin-roof": dict(
        default=22,
        make=lambda: rain(
            RAIN_S, 1003,
            lambda f: highpass(f, 220, 2) * lowpass(f, 11000, 1)
                      * peak(f, 4200, 1.2, 3.5) * peak(f, 6500, 1.6, 2.0),
            layers=[
                (0.80, 10000, (1800, 5000, 1.8, 1, 1.0, 12000), {}),
                # Thin sheet: brighter and drier than the metal roof, but 22ms
                # of ring per drop was a xylophone. 9ms.
                (0.48, 380, (2600, 5500, 9.0, 1, 0.95, 12000), {}),
            ],
            w_bed=0.42, gust_depth=0.15, gust_fc=0.11,
        ),
    ),
    "rain-shingle-roof": dict(
        default=37,
        make=lambda: rain(
            RAIN_S, 1004,
            lambda f: highpass(f, 80, 2) * lowpass(f, 2600, 2) * peak(f, 420, 0.9, 4.0),
            layers=[
                (0.85, 8000, (400, 1400, 2.5, 1, 0.7, 2600), {}),
                # Asphalt damps almost everything: a thud, not a ring.
                (0.45, 260, (300, 900, 8.0, 1, 0.45, 2200), {}),
            ],
            w_bed=0.45, gust_depth=0.18, gust_fc=0.08,
        ),
    ),
    "rain-window": dict(
        default=33,
        make=lambda: rain(
            RAIN_S, 1005,
            # You are inside: the roar arrives muffled through the wall...
            lambda f: highpass(f, 60, 2) * lowpass(f, 1400, 2) * tilt(f, 300, -2.0),
            layers=[
                (0.70, 5000, (600, 1600, 3.0, 1, 0.6, 2500), {}),
                # ...and only the glass itself is bright, close and countable.
                (0.55, 120, (800, 1800, 12.0, 1, 0.5, 3000), {}),
                (0.35, 22, (2200, 4200, 40.0, 2, 0.6, 7000), dict(spread=0.8, alpha=2.0)),
            ],
            w_bed=0.50, gust_depth=0.20, gust_fc=0.07, mono_below=300.0,
        ),
    ),
    "thunder-distant": dict(
        default=81,
        make=lambda: thunder(THUNDER_S, 2001, body_lp=85, air_mix=0.055,
                             swells=5, rise_s=2.6, fall_s=3.2),
    ),
    "thunder-close": dict(
        default=45,
        make=lambda: thunder(THUNDER_S, 2002, body_lp=55, air_mix=0.10,
                             # Fast rise, long decay — the asymmetry is what
                             # reads as "close" rather than just "louder".
                             swells=4, rise_s=1.2, fall_s=7.0, floor=0.10),
    ),
}


def main():
    wanted = sys.argv[1:] or list(VOICES)
    unknown = [w for w in wanted if w not in VOICES]
    if unknown:
        sys.exit(f"unknown id(s): {', '.join(unknown)}")

    entries = {}
    for name in wanted:
        cfg = VOICES[name]
        print(f"  {name} …", flush=True)
        raw = cfg["make"]()
        print(f"      crest {crest_db(raw):.1f} dB (shaped noise ~12, rain-true 16.4)")

        period, achieved = master(raw, TARGET_LUFS)
        entry = write_mp3(name, period)
        entry.update(source="synthesised", lufs=round(achieved, 2),
                     defaultVolume=cfg["default"])
        entries[name] = entry

        short = "" if achieved > TARGET_LUFS - 1.0 else \
                f"  (peak-limited {TARGET_LUFS - achieved:.1f} dB short of target)"
        print(f"      {achieved:.1f} LUFS, loop {entry['loopEnd'] - entry['loopStart']:.0f}s, "
              f"{entry['bytes'] / 1024:.0f} KB{short}")

    print(f"→ {update_manifest(entries)}")


if __name__ == "__main__":
    main()
