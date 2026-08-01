#!/usr/bin/env python3
"""prep-rain.py — turn a real field recording into a seamless loop.

    ./scripts/prep-rain.py --scan  SOURCE          # find the calmest windows
    ./scripts/prep-rain.py SOURCE [--start SEC]    # cut, loop and encode

The source is not committed — it is 63 MB. Fetch it with:

    curl -A 'contact-email' -o valvalion.oga \\
      https://upload.wikimedia.org/wikipedia/commons/4/4f/Falling_Rain_SFX_1_2016-11-19.oga

  "Falling Rain SFX 1", valvalion, Wikimedia Commons, CC BY 3.0.
  72 minutes, 44.1 kHz stereo. Attribution is a licence condition, so the
  credit travels in manifest.json where the app can display it — note that
  deploy.sh excludes *.md from the webroot, so a CREDITS.md would not ship.

WHY A CROSSFADE IS FINE HERE
----------------------------
The generated beds avoid crossfades because a *linear* crossfade of two
uncorrelated noise segments dips ~3 dB in the middle — an audible breath once a
pass. That is a property of linear fades, not of crossfading: an equal-power
fade (sqrt, so the gains square to 1) holds power constant across the join for
uncorrelated material, which rain is. So a real recording can be looped without
the dip after all.

The window is chosen by search rather than by ear-and-guess. Rain recordings are
full of things you do not want on repeat every 24 seconds — a bird, a car, a
gust, the recordist shifting — and the scan scores candidate windows on how
little their level and brightness move.
"""

import argparse
import subprocess
import sys

import numpy as np

from audiolib import SR, crest_db, master, update_manifest, write_mp3

LOOP_S = 24.0          # matches the generated beds
OVERLAP_S = 3.0        # equal-power join; long enough to hide, short enough to waste little
SCAN_SR = 11025

CREDIT = dict(
    credit="Falling Rain SFX 1 — valvalion",
    license="CC BY 3.0",
    sourceUrl="https://commons.wikimedia.org/wiki/File:Falling_Rain_SFX_1_2016-11-19.oga",
)


def decode(path, sr, ac, start=None, dur=None):
    cmd = ["ffmpeg", "-hide_banner", "-v", "error"]
    if start is not None:
        cmd += ["-ss", f"{start:.6f}"]
    if dur is not None:
        cmd += ["-t", f"{dur:.6f}"]
    cmd += ["-i", str(path), "-f", "f32le", "-ar", str(sr), "-ac", str(ac), "pipe:1"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    x = np.frombuffer(raw, dtype="<f4")
    return x.reshape(-1, ac) if ac > 1 else x


def scan(path, need_s, top=8):
    """Rank windows by how little happens in them.

    Brightness is tracked as the energy of the first difference relative to the
    signal — a cheap high-pass. It is enough to catch a bird or a passing car,
    which move the spectrum far more than rain varying in intensity does.
    """
    x = decode(path, SCAN_SR, 1)
    hop = SCAN_SR // 10                                   # 0.1 s frames
    frames = x[:len(x) // hop * hop].reshape(-1, hop)

    rms_db = 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-12)
    hf = np.diff(x, prepend=x[0])[:frames.size].reshape(-1, hop)
    bright = np.sqrt((hf ** 2).mean(axis=1)) / (np.sqrt((frames ** 2).mean(axis=1)) + 1e-12)

    span = int(need_s * 10)
    step = 10                                             # candidate every 1 s
    results = []
    for i in range(0, len(frames) - span, step):
        r, b = rms_db[i:i + span], bright[i:i + span]
        if np.median(r) < -60:                            # near-silence, skip
            continue
        score = r.std() + 12.0 * b.std() + 0.35 * (r.max() - np.median(r))
        results.append((score, i / 10.0, r.mean(), r.std(), r.max() - np.median(r)))

    results.sort()
    print(f"{'start':>9}  {'score':>6}  {'mean dB':>8}  {'sd dB':>6}  {'peak over median':>16}")
    for s, t, mean, sd, pk in results[:top]:
        print(f"{t:>8.1f}s  {s:>6.2f}  {mean:>8.1f}  {sd:>6.2f}  {pk:>15.1f} dB")
    return results[0][1] if results else 0.0


def make_loop(path, start):
    """Cut LOOP_S + OVERLAP_S, then fold the tail back over the head."""
    n = int(LOOP_S * SR)
    ov = int(OVERLAP_S * SR)
    seg = decode(path, SR, 2, start=start, dur=LOOP_S + OVERLAP_S + 0.5)
    if len(seg) < n + ov:
        sys.exit(f"source too short at {start}s: got {len(seg) / SR:.1f}s")

    loop = seg[:n].copy()
    t = np.linspace(0.0, 1.0, ov, endpoint=False)[:, None]
    # Equal power: the two gains square to 1, so uncorrelated material holds
    # level across the join instead of dipping.
    loop[:ov] = seg[:ov] * np.sqrt(t) + seg[n:n + ov] * np.sqrt(1.0 - t)

    # Field recordings carry handling rumble and wind thump below ~35 Hz that
    # costs headroom and reproduces as nothing on a phone.
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    hp = (freqs / 35.0) ** 2 / np.sqrt(1.0 + (freqs / 35.0) ** 4)
    for c in range(2):
        loop[:, c] = np.fft.irfft(np.fft.rfft(loop[:, c]) * hp, n)
    return loop


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--scan", action="store_true", help="report calm windows and exit")
    ap.add_argument("--start", type=float, help="window start in seconds")
    ap.add_argument("--name", default="rain-true")
    ap.add_argument("--default-volume", type=int, default=60)
    args = ap.parse_args()

    if args.scan:
        scan(args.source, LOOP_S + OVERLAP_S)
        return

    start = args.start if args.start is not None else scan(args.source, LOOP_S + OVERLAP_S, top=3)
    print(f"  {args.name} … from {start:.1f}s")

    loop = make_loop(args.source, start)
    print(f"      crest {crest_db(loop):.1f} dB")

    period, achieved = master(loop, -26.0)
    entry = write_mp3(args.name, period)
    entry.update(source="recording", sourceStart=round(start, 2),
                 lufs=round(achieved, 2), defaultVolume=args.default_volume, **CREDIT)
    print(f"      {achieved:.1f} LUFS, loop {LOOP_S:.0f}s, {entry['bytes'] / 1024:.0f} KB")
    print(f"→ {update_manifest({args.name: entry})}")


if __name__ == "__main__":
    main()
