# Licences and attribution

This project bundles work under four different licences. They are separated
below because the MIT licence in `LICENSE` covers **only the code** — the audio
and the fonts have their own terms, and a fork that ignores them is
non-compliant.

## Code — MIT

Everything in `src/`, `scripts/`, `styles/*.css`, `sw.js`, `index.html`,
`offline.html`, `manifest.webmanifest`. See `LICENSE`.

## Generated audio — CC0 1.0 (public domain dedication)

    assets/audio/rain-field.mp3
    assets/audio/rain-window.mp3
    assets/audio/rain-shingle-roof.mp3
    assets/audio/rain-metal-roof.mp3
    assets/audio/rain-tin-roof.mp3
    assets/audio/thunder-distant.mp3
    assets/audio/thunder-close.mp3

These are synthesised from scratch by `scripts/synth-audio.py` — no recording is
sampled or derived. They contain nothing anyone else owns, so they are released
into the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/): use them for
anything, with or without credit.

Regenerate them yourself with `./scripts/synth-audio.py`; the parameters live in
one table near the bottom of that file.

## Recorded audio — CC BY 3.0, attribution required

    assets/audio/rain-true.mp3

Derived from **"Falling Rain SFX 1" by valvalion**, from Wikimedia Commons,
licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

- Source: <https://commons.wikimedia.org/wiki/File:Falling_Rain_SFX_1_2016-11-19.oga>
- Changes made: a 24-second excerpt was taken from 4243 s of the 72-minute
  original, folded into a seamless loop with an equal-power crossfade,
  high-passed below 35 Hz, and normalised to −26 LUFS.

**If you redistribute this file, or a build containing it, you must keep that
attribution visible.** In this app it is carried in
`assets/audio/manifest.json` and rendered at the bottom of the UI — not in a
README, because the deploy step strips Markdown and the credit would silently
stop shipping.

The simplest way to drop this obligation is to delete `rain-true.mp3` and its
manifest entry; the app degrades gracefully, showing that row as unavailable.

## Fonts — SIL Open Font License 1.1

    styles/fonts/dm-sans-*.woff2        DM Sans, © the DM Sans Project Authors
    styles/fonts/plex-mono-*.woff2      IBM Plex Mono, © 2017 IBM Corp.

Full licence texts are in `styles/fonts/OFL-DM-Sans.txt` and
`styles/fonts/OFL-IBM-Plex-Mono.txt`. They are self-hosted rather than loaded
from a CDN deliberately: the service worker leaves cross-origin requests alone,
so a CDN font would silently fall back to a system font offline.
