#!/usr/bin/env python3
"""verify-audio.py — prove the shipped MP3s loop cleanly at their manifest points.

Decodes each file the way the browser will, then checks two things:

  seam   the sample-level discontinuity where loopEnd meets loopStart, compared
         against the signal's own typical sample-to-sample motion. A ratio near
         1.0 means the junction is indistinguishable from ordinary waveform
         movement — i.e. no click. This is the check that would have caught a
         crossfade or an off-by-a-padding-frame loop point.

  drift  how closely the period repeats: the region just after loopEnd should be
         a near-copy of the region just after loopStart, since the source is
         exactly periodic. Anything left is MP3 coding noise.
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 48000
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "audio"


def decode(path):
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
         "-f", "f32le", "-ar", str(SR), "-ac", "2", "pipe:1"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, 2)


def main():
    manifest = json.loads((OUT / "manifest.json").read_text())
    worst, hottest = 0.0, 0.0
    print(f"{'id':<20} {'peak':>7} {'rms dB':>8} {'centroid':>9} {'seam':>7} {'drift dB':>9}")
    for name, entry in sorted(manifest.items()):
        x = decode(OUT / entry["file"])
        a, b = int(entry["loopStart"] * SR), int(entry["loopEnd"] * SR)
        loop = x[a:b]

        # Two passes of the loop, so the junction is a real junction.
        twice = np.concatenate([loop, loop], axis=0)
        d = np.abs(np.diff(twice, axis=0)).max(axis=1)
        junction = d[len(loop) - 2:len(loop) + 1].max()
        typical = np.percentile(d, 99.9)
        seam = junction / (typical + 1e-12)
        worst = max(worst, seam)

        # Period repeat: for synthesised beds the content is exactly periodic,
        # so the same phase one period apart must be the same audio and anything
        # left is MP3 coding noise. A real recording is not periodic — its loop
        # is an equal-power fold, not an identity — so the test is meaningless
        # there and reporting a number would invite someone to "fix" it.
        if entry.get("source") == "recording":
            drift = None
        else:
            win = int(0.5 * SR)
            head, wrap = x[a:a + win], x[b:b + win]
            drift = 20 * np.log10(np.sqrt(np.mean((head - wrap) ** 2)) /
                                  (np.sqrt(np.mean(head ** 2)) + 1e-12) + 1e-12)

        mag = np.abs(np.fft.rfft(loop[:, 0] * np.hanning(len(loop))))
        freqs = np.fft.rfftfreq(len(loop), 1 / SR)
        centroid = float((mag * freqs).sum() / mag.sum())
        rms = 20 * np.log10(np.sqrt(np.mean(loop ** 2)) + 1e-12)

        # Decoded peak, not encoded: lossy decode overshoots, and that overshoot
        # is what actually clips on the device.
        peak_ = float(np.abs(loop).max())
        hottest = max(hottest, peak_)

        flag = "   <-- CLICK" if seam > 3.0 else ("   <-- CLIPS" if peak_ > 0.95 else "")
        drift_s = "     n/a" if drift is None else f"{drift:>9.1f}"
        print(f"{name:<20} {peak_:>7.3f} {rms:>8.1f} "
              f"{centroid:>8.0f}Hz {seam:>7.2f} {drift_s}{flag}")

    print()
    bad = False
    if worst > 3.0:
        print(f"FAIL: worst seam ratio {worst:.2f} — a loop point is audible.")
        bad = True
    if hottest > 0.95:
        print(f"FAIL: decoded peak {hottest:.3f} — clips before the mixer even sums rows.")
        bad = True
    if bad:
        return 1
    print(f"OK: worst seam {worst:.2f}× typical sample motion, hottest decoded peak "
          f"{hottest:.3f} ({20 * np.log10(hottest):.1f} dBFS).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
