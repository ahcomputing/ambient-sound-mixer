#!/usr/bin/env python3
"""audiolib.py — shared mastering and packaging for the mixer's loops.

Imported by synth-audio.py (generated beds) and prep-rain.py (real recording).
Not a deliverable on its own; scripts/ is excluded from the webroot.

LOUDNESS, NOT RMS
-----------------
The first pass matched every file to the same RMS and the result was a 24 dB
spread in where the sliders wanted to sit: tin roof at 5%, thunder at 80%. RMS
is not loudness. Tin is bright, right where the ear is most sensitive; thunder
is nearly all sub-bass, where it is least. Equal RMS therefore means wildly
unequal loudness. Everything here masters to integrated LUFS (K-weighted, via
ffmpeg's ebur128) so that equal slider positions mean equal perceived level and
the sliders are about taste again instead of correcting a mastering error.
"""

import json
import re
import subprocess
from pathlib import Path

import numpy as np

SR = 48000
PAD_S = 1.0                 # pre/post-roll guarding the MP3 encoder's padding
PEAK_CEILING = 0.6          # see master()

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "audio"


def _pipe_ffmpeg(args, buf):
    """Feed a float buffer to ffmpeg as raw s16le.

    Deliberately raw, never WAV: a WAV header carries chunk sizes up front and
    ffmpeg cannot seek back to fill them on a pipe, so it leaves 0xffffffff
    placeholders that readers take literally.
    """
    raw = (np.clip(buf, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "info",
         "-f", "s16le", "-ar", str(SR), "-ac", "2", "-i", "pipe:0"] + args,
        input=raw, capture_output=True,
    )


def lufs(buf):
    """Integrated loudness, K-weighted, as ffmpeg measures it.

    The buffer is scaled to a safe peak before measuring and the scaling is
    subtracted back out. Measuring in place would be wrong for anything not
    already normalised: the pipe carries s16, so a raw synth buffer peaking at
    8.0 gets clipped to ±1 on the way in and the measurement describes a square
    wave rather than the signal. That silently cost 3.5 dB on the rain beds and
    over 20 dB on thunder, which is nearly all sub-bass and peaks hardest.
    """
    scale = 0.5 / (np.max(np.abs(buf)) + 1e-12)
    res = _pipe_ffmpeg(["-af", "loudnorm=print_format=json", "-f", "null", "-"], buf * scale)
    m = re.search(r"\{[^{}]*input_i[^{}]*\}", res.stderr.decode("utf-8", "replace"), re.S)
    if not m:
        raise RuntimeError("loudnorm produced no measurement")
    return float(json.loads(m.group())["input_i"]) - 20.0 * np.log10(scale)


def master(buf, target_lufs, ceiling=PEAK_CEILING):
    """Normalise to `target_lufs`, then keep peaks under `ceiling`.

    The ceiling is low on purpose and both reasons were measured here. Lossy
    decode overshoots the encoded peak by a couple of dB on broadband noise — a
    file mastered to -1 dBFS decoded at +1.8 dBFS and clipped. And every row is
    designed to play at once: seven uncorrelated sources sum about 8 dB above
    one of them. Level is made up at the master gain, not in the files.

    Returns (buf, achieved_lufs). Sub-bass content (thunder) can be peak-limited
    out of reach of the target; the caller reports the shortfall rather than
    pretending it hit.
    """
    buf = buf - buf.mean(axis=0)                      # any DC would eat headroom
    buf = buf * 10.0 ** ((target_lufs - lufs(buf)) / 20.0)

    if np.max(np.abs(buf)) > ceiling:
        # Static soft knee: no time constant, so it cannot breathe at the seam.
        buf = np.tanh(buf / ceiling) * ceiling
    return buf, lufs(buf)


def write_mp3(name, period, quality=4):
    """Encode one loop period, wrapped in the pre/post-roll the loop points need.

    MP3 carries encoder delay and padding that browsers do not strip uniformly,
    so looping a whole decoded buffer ticks at the seam. Each file is
    [last 1s][full period][first 1s] and the manifest carries loopStart/loopEnd
    pointing at the interior. Because the content is periodic, any window of
    exactly one period is seamless — so the encoder's few-hundred-sample shift
    lands in the pre-roll and cannot matter.
    """
    OUT.mkdir(parents=True, exist_ok=True)
    pad = int(SR * PAD_S)
    full = np.concatenate([period[-pad:], period, period[:pad]], axis=0)

    dest = OUT / f"{name}.mp3"
    res = _pipe_ffmpeg(["-c:a", "libmp3lame", "-q:a", str(quality), "-y", str(dest)], full)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.decode("utf-8", "replace")[-800:])

    return {
        "file": f"{name}.mp3",
        "duration": round(full.shape[0] / SR, 6),
        "loopStart": round(PAD_S, 6),
        "loopEnd": round(PAD_S + period.shape[0] / SR, 6),
        "bytes": dest.stat().st_size,
    }


def crest_db(buf):
    """Peak-to-RMS in dB. Rain is not Gaussian noise and this is where it shows:
    a few near drops are far louder than the wash, so rain sits well above the
    ~12 dB of shaped noise.

    Reference point, measured rather than assumed: the Wikimedia field
    recording used for `rain-true` comes in at 16.4 dB. Treat that as the
    target for the generated beds; anything much past 20 dB is grains standing
    too far out of their own wash.
    """
    rms = np.sqrt(np.mean(buf ** 2))
    return 20 * np.log10(np.max(np.abs(buf)) / (rms + 1e-12) + 1e-12)


def update_manifest(entries):
    path = OUT / "manifest.json"
    manifest = json.loads(path.read_text()) if path.exists() else {}
    manifest.update(entries)
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return path
