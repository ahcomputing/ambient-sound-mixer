# Ambient Sound Mixer

A layered ambient sound mixer, built as an installable PWA for falling asleep to.
Rain on several surfaces, thunder, and theta-range binaural and isochronic tones
— each independently toggleable with its own volume, all mixing in real time.

**Live demo: <https://sounds.ahcomputing.com>**

Tick a row to start it — browsers require a tap before any audio can play. It
installs to a home screen and works fully offline afterwards. Use headphones for
the binaural theta rows; on a speaker only the isochronic one does anything.

No build step, no framework, no npm. Vanilla ES modules and Web Audio.

**Playback never stops on its own.** No sleep timer, no auto-fade, no
max-duration cutoff. It runs until a person unchecks it. That constraint drove a
lot of the design below.

---

## The interesting part: the audio is generated, not sampled

Seven of the eight loops are synthesised from scratch by
[`scripts/synth-audio.py`](scripts/synth-audio.py). Two problems shaped how.

### Filtered noise does not sound like rain

The first version shaped noise through per-surface filters and it read as
*static*. The difference turns out to be statistical rather than spectral: noise
is Gaussian, so its amplitude distribution is thin-tailed and every instant
sounds like every other. Real rain is a heavy-tailed shower of discrete impacts
— thousands of faint far ones per second and the occasional near one twenty
times louder. That ratio is what the ear reads as rain.

So each bed is now Poisson-scattered impacts with power-law amplitudes,
convolved with per-surface resonator templates. Peak-to-RMS is the tell, and the
script prints it: shaped noise sits near 12 dB, real rain around 16 dB.

Surfaces differ in three ways — where the far wash sits spectrally, what a single
drop hitting them rings like, and how dense the near drops are. Getting shingle
to sound different from sheet metal needed the *droplet transients* low-passed
per surface, not just the bed; the attack is a broadband click, and unfiltered it
puts the same top octave on every row.

### Loops must be seamless, and crossfades are not free

A crossfade between two uncorrelated noise segments dips about 3 dB in the middle
if it is linear — an audible "breath" once per pass, which is exactly the kind of
thing nobody notices at noon and everybody notices at 3am.

Generated beds sidestep it entirely: everything is convolved **circularly over
exactly one loop length**, so the last sample leads into the first as a
mathematical identity, and a grain landing near the end wraps into the head. No
crossfade at all.

The one real recording (`rain-true`) does use a crossfade, but an *equal-power*
one — the gains square to 1, so uncorrelated material holds level across the
join. Its 24-second window was chosen by scanning all 72 minutes of the source
for the least eventful stretch rather than picking by ear.

### MP3 padding breaks gapless looping

MP3 carries encoder delay and padding that browsers do not strip uniformly, so
`loop = true` over a whole decoded buffer ticks at the seam. Each file is
therefore `[last 1s][full period][first 1s]`, and `assets/audio/manifest.json`
carries `loopStart`/`loopEnd` pointing at the interior. Because the content is
periodic, *any* window of exactly one period is seamless — so the encoder's
few-hundred-sample shift lands harmlessly in the pre-roll.

[`scripts/verify-audio.py`](scripts/verify-audio.py) gates all of this. It
measures the discontinuity at the loop junction against the signal's own typical
sample-to-sample motion; under 1.0 means the join is quieter than ordinary
waveform movement, i.e. inaudible.

### Master to loudness, not to RMS

Matching the files by RMS produced a 24 dB spread in where the sliders wanted to
sit — tin roof at 5%, thunder at 80% — because RMS is not loudness. Tin is
bright, right where the ear is most sensitive; thunder is nearly all sub-bass,
where it is least. Everything targets −26 LUFS (K-weighted) so equal slider
positions mean equal perceived level.

## Theta tones, and why a phone speaker changes the answer

The theta rows are generated live and never become files: joint-stereo MP3 coding
folds the channels together and smears the exact per-ear separation a binaural
beat depends on.

All variants beat at 6 Hz. What differs is the carrier, which is free to choose
because the beat is the *difference* between two tones, not their pitch — and it
matters enormously, because a phone speaker cannot move air low down. Measured
through a small-speaker model at matched loudness, against rain at −26 LUFS:

| variant | through a phone speaker |
|---|---|
| binaural 200/206 Hz | −63.6 LUFS |
| binaural 400/406 Hz | −40.0 |
| binaural 528/534 Hz | −31.7 |
| binaural 700/706 Hz | −27.0 (parity with rain) |
| isochronic 528 Hz | −31.8 |

The trade runs the other way for the effect itself — the binaural percept is
strongest at low carriers and degrades above roughly 1 kHz — so all of them ship
as rows to pick between.

**Only the isochronic variant works without headphones.** A binaural beat is
manufactured in the listener from two hard-panned tones; on a speaker they mix in
the air first and there is no beat. The isochronic row is one amplitude-modulated
tone, identical in both ears, so it survives.

Each generated row carries a measured source trim. A raw oscillator peaks at 1.0,
about 25 dB hotter than the mastered files, so without one the slider would mean
something different on those rows.

## Structure

```
src/catalog.js     what rows exist; merges a static table with the audio manifest
src/engine.js      Web Audio only — buffer cache, loop points, fades, oscillators
src/state.js       persistence, via a namespaced localStorage wrapper
src/view.js        DOM only; mounts once and never re-renders a row
src/keepalive.js   surviving screen-lock on Android
src/app.js         controller wiring the above
```

Nothing crosses those seams: the catalog knows no DOM, the engine knows no
storage, the view knows neither.

A few decisions that look like mistakes and are not:

- **The volume slider is linear**, and the master gain is exactly 1.0. Every
  per-row default volume was calibrated against that; a perceptual curve would
  invalidate all of them.
- **`view.mount()` runs once and nothing afterwards re-renders a row.** A
  re-render during a slider drag drops the drag.
- **The state sanitiser uses `Number.isFinite`, not truthiness.**
  `saved.volume || 60` turns a deliberate 0 into 60 — a muted sound coming back
  at 60% in the dark.
- **The audio has its own service-worker cache**, versioned on `assets/` alone.
  `cache.addAll` is atomic, so several MB of MP3 in the shell precache means one
  dropped request on bad wifi fails the whole install; and hashing the whole tree
  would re-download every file on every CSS change.
- **No wake lock.** It keeps the display on, which for a bedtime app is wrong.

## Running it

```bash
python3 -m http.server 8000
```

Then <http://localhost:8000>. There is nothing to install or compile.

To produce a deployable directory:

```bash
./scripts/build.sh dist
```

That generates the service worker's precache list from what is actually shipping
and stamps a content hash as the cache version — the two things that must never
be maintained by hand. Serve `dist/` with any static server. Deployment beyond
that point is site-specific and not included.

## Regenerating the audio

```bash
./scripts/synth-audio.py           # all generated beds, ~45s
./scripts/verify-audio.py          # gate: seams, peaks, loudness
```

Needs `ffmpeg`, `numpy` and `scipy`. To rebuild the recorded loop you also need
the source file — see the docstring in [`scripts/prep-rain.py`](scripts/prep-rain.py).

[`scripts/audition.html`](scripts/audition.html) is a listening rig for comparing
loops. Its "Seam" button plays a 4-second window straddling the loop junction, so
a click you would otherwise meet once every 24 seconds arrives every 4.

## Licences

Code is MIT. The generated audio is CC0. One recorded loop is CC BY 3.0 and
**requires attribution**, and the bundled fonts are OFL. See
[NOTICE.md](NOTICE.md) — the details matter if you fork this.

Built on a small vanilla-PWA starter template; the deployment tooling for that
template is not part of this repository.
