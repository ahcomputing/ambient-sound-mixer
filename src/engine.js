/* The audio engine. Web Audio only — no DOM, no storage.
 *
 * Graph, per row:
 *
 *   BufferSource(loop, loopStart, loopEnd)  ─┐
 *      or  Osc(200) → ChannelMerger ch0      ├→ row gain → master gain → destination
 *          Osc(206) → ChannelMerger ch1     ─┘
 *
 * The working shape of all of this was proven in scripts/audition.html, which
 * Aaron listened to and signed off. Keep them behaviourally identical: that rig
 * is the A/B reference, and a difference between it and the app means the gain
 * path here is wrong.
 */

/* Rows connect through master, not straight to destination, so a future
 * "mute all" has somewhere to live (spec §5). It ships at exactly 1.0 because
 * the audition rig connected rows straight to destination — every defaultVolume
 * in the manifest is calibrated against unity here. Raising it silently
 * invalidates the lot. */
const MASTER_GAIN = 1.0;

const FADE_IN = 0.25;      // starting at loopStart means starting mid-waveform
const FADE_OUT = 0.30;     // spec §1: 300-500ms, never a hard stop
const STOP_PAD = 0.05;     // let the ramp finish before the node is torn down
const GLIDE_TC = 0.02;     // slider glide: fast enough to feel live, slow enough not to zip

export class AudioLoadError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AudioLoadError';
    this.kind = kind;      // 'missing' | 'offline' | 'decode'
  }
}

let ctx = null;
let master = null;
const buffers = new Map();     // id -> AudioBuffer            (decode once, keep)
const decoding = new Map();    // id -> Promise<AudioBuffer>   (dedupe double taps)
const voices = new Map();      // id -> { gain, stop(when) }
const listeners = new Set();

export function isSupported() {
  return !!(window.AudioContext || window.webkitAudioContext);
}

export function contextState() {
  return ctx ? ctx.state : 'none';
}

function emit() {
  const payload = { activeIds: activeIds(), state: contextState() };
  for (const fn of listeners) {
    try { fn(payload); } catch (err) { console.warn('[engine] listener threw', err); }
  }
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* MUST stay synchronous, and MUST be called from the synchronous prefix of
 * start() — before any await. Constructing the AudioContext inside the user
 * gesture's call stack is what satisfies the autoplay policy; move it after an
 * await and playback silently never unlocks. */
function ensureContext() {
  if (ctx) return ctx;

  // Tells the OS this is long-form playback rather than a UI blip. Harmless
  // where unsupported; part of surviving a screen lock where it is.
  if (navigator.audioSession) {
    try { navigator.audioSession.type = 'playback'; } catch { /* not fatal */ }
  }

  const Ctor = window.AudioContext || window.webkitAudioContext;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);
  ctx.addEventListener('statechange', emit);
  return ctx;
}

export async function resume() {
  if (!ctx) return false;
  if (ctx.state === 'running') return true;
  try {
    await ctx.resume();
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

async function getBuffer(sound) {
  const hit = buffers.get(sound.id);
  if (hit) return hit;
  const inFlight = decoding.get(sound.id);
  if (inFlight) return inFlight;

  const job = (async () => {
    let resp;
    try {
      resp = await fetch(sound.url);
    } catch (err) {
      // Distinguished from a 404 on purpose: offline is transient and must not
      // permanently disable the row.
      throw new AudioLoadError('offline', `could not reach ${sound.url}`);
    }
    if (!resp.ok) throw new AudioLoadError('missing', `${sound.url} returned ${resp.status}`);

    let buf;
    try {
      buf = await ctx.decodeAudioData(await resp.arrayBuffer());
    } catch (err) {
      throw new AudioLoadError('decode', `${sound.url} would not decode`);
    }
    buffers.set(sound.id, buf);
    return buf;
  })().finally(() => decoding.delete(sound.id));

  decoding.set(sound.id, job);
  return job;
}

/* Two oscillators hard-panned by a ChannelMerger so each tone reaches one ear
 * only. That separation is the entire mechanism of a binaural beat. */
function buildGenerator(sound, gain) {
  /* Source trim, as its own node rather than folded into the row gain. An
   * oscillator peaks at 1.0, about 25 dB hotter than the mastered files, so
   * without this the slider would mean something different on these rows than
   * on every other one. It stays separate because setVolume() writes
   * volume/100 straight into the row gain for all rows, and that arithmetic
   * must not grow a per-row exception. */
  const trim = ctx.createGain();
  trim.gain.value = sound.gain ?? 1;
  trim.connect(gain);

  const oscs = [];

  if (sound.mode === 'isochronic') {
    /* One tone, amplitude-modulated, identical in both ears. That last part is
     * the point: it survives the acoustic mixing that destroys a binaural beat
     * on a speaker, so it is the only variant that works without headphones.
     *
     * The LFO drives the modulator's gain around a 0.5 offset with 0.5 depth,
     * so the envelope sweeps 0..1. An AudioParam sums its own value with any
     * connected signal, which is what makes the offset work. */
    const carrier = ctx.createOscillator();
    carrier.frequency.value = sound.carrier;
    const mod = ctx.createGain();
    mod.gain.value = 0.5;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = sound.beat;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(mod.gain);

    carrier.connect(mod).connect(trim);
    oscs.push(carrier, lfo);
  } else {
    /* Two tones hard-panned by a ChannelMerger so each reaches one ear only.
     * That separation is the entire mechanism — the "beat" is manufactured in
     * the listener, not in the signal. */
    const merger = ctx.createChannelMerger(2);
    for (const [i, hz] of [sound.left, sound.right].entries()) {
      const osc = ctx.createOscillator();
      osc.frequency.value = hz;
      osc.connect(merger, 0, i);
      oscs.push(osc);
    }
    merger.connect(trim);
  }

  oscs.forEach((o) => o.start());
  oscs[0].onended = () => { trim.disconnect(); gain.disconnect(); };
  return (when) => oscs.forEach((o) => o.stop(when));
}

function buildFile(sound, buffer, gain) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  /* Never loop the whole decoded buffer. MP3 carries encoder delay and padding
   * that browsers do not strip uniformly, so a whole-buffer loop ticks at the
   * seam. Each file is [last 1s][period][first 1s]; these points skip it. */
  src.loopStart = sound.loopStart;
  src.loopEnd = sound.loopEnd;
  src.connect(gain);
  src.onended = () => gain.disconnect();
  src.start(0, sound.loopStart);
  return (when) => src.stop(when);
}

/* volume is 0-100. Throws AudioLoadError; the caller decides what that means
 * for the row. */
export async function start(sound, volume) {
  const c = ensureContext();          // synchronous, inside the gesture
  await resume();

  if (voices.has(sound.id)) stop(sound.id);   // guard against a double start

  let buffer = null;
  if (sound.kind !== 'generator') buffer = await getBuffer(sound);

  const gain = c.createGain();
  gain.connect(master);

  const stopFn = sound.kind === 'generator'
    ? buildGenerator(sound, gain)
    : buildFile(sound, buffer, gain);

  // Linear, never exponential: an exponential ramp to or from zero is illegal
  // and silently does nothing.
  const now = c.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(volume / 100, now + FADE_IN);

  voices.set(sound.id, { gain, stop: stopFn });
  emit();
}

export function stop(id) {
  const voice = voices.get(id);
  if (!voice) return;

  // Deleted immediately, not after the fade: isPlaying() must be false at once
  // so a fast re-check builds a fresh voice instead of being swallowed.
  voices.delete(id);

  const now = ctx.currentTime;
  const param = voice.gain.gain;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(0.0001, now + FADE_OUT);
  voice.stop(now + FADE_OUT + STOP_PAD);   // onended then disconnects the gain
  emit();
}

/* Live — no restart, per spec §1. */
export function setVolume(id, volume) {
  const voice = voices.get(id);
  if (!voice) return;                       // not playing; state still records it
  const now = ctx.currentTime;
  const param = voice.gain.gain;

  /* Cancel first, or a slider dragged during the 250ms fade-in leaves that
   * scheduled ramp fighting the setTargetAtTime below. cancelAndHoldAtTime is
   * the clean way; the fallback covers browsers without it. */
  if (param.cancelAndHoldAtTime) {
    param.cancelAndHoldAtTime(now);
  } else {
    const current = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(current, now);
  }
  /* Linear v/100. Do NOT introduce a perceptual/squared curve: every
   * defaultVolume in the manifest was derived from Aaron's audition mix in
   * linear terms and a curve change invalidates all of them. */
  param.setTargetAtTime(volume / 100, now, GLIDE_TC);
}

export function setMasterVolume(v01) {
  if (!master) return;
  master.gain.setTargetAtTime(v01, ctx.currentTime, GLIDE_TC);
}

export function isPlaying(id) {
  return voices.has(id);
}

export function activeIds() {
  return [...voices.keys()];
}

export function stopAll() {
  for (const id of activeIds()) stop(id);
}
