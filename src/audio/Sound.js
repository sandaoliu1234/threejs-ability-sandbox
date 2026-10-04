/**
 * Procedural sound, in the same spirit as everything else in the sandbox:
 * there is not a single audio file on disk. Every sound is synthesised on the
 * fly from oscillators and one shared buffer of white noise, shaped by filters
 * and gain envelopes — the audio counterpart of the GLSL that builds the ice.
 *
 * This is a singleton (like `frame`), because sound is a service, not a system
 * with a scene graph: the HUD, the abilities, the minions and the shake all
 * import the same `sfx` and call one verb each. Nothing allocates per call —
 * the WebAudio nodes are throwaway by design, created with the sound and
 * garbage-collected after their stop time.
 *
 * Browsers start an AudioContext suspended until a user gesture, so `unlock`
 * is wired to the first pointerdown/keydown; every call before that is a
 * no-op, which also means the loading screen stays silent.
 *
 * The mix is controlled by `settings.audio`, so the editor owns the volume
 * knobs like it owns every other number in the project.
 */
import { settings } from '../config/settings.js';

class Sound {
  constructor() {
    /** @type {AudioContext|null} built lazily; null until the first gesture. */
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this._last = new Map(); // sound name → time of last play, for retrigger gates
  }

  /**
   * Build the context on the first user gesture (or resume it if the tab took
   * it away). Safe to call repeatedly.
   */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();

    // One compressor over everything: casts stack with impacts, and the clip
    // that would otherwise shatter the mix becomes a push instead.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 22;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    comp.connect(this.ctx.destination);

    this.master = this.ctx.createGain();
    this.master.connect(comp);

    // A second of white noise, shared by every hiss, crackle and boom.
    const length = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  /** Master volume sits in settings, so the editor can ride it live. */
  _gain(channel) {
    const a = settings.audio;
    if (!this.ctx || !a.enabled) return 0;
    const channelGain = channel ? a[channel] ?? 1 : 1;
    return Math.max(0, a.master * channelGain);
  }

  /**
   * Retrigger gate: pass a name and a minimum interval and get whether the
   * sound may play now. Dozens of minions take a hit the same frame; without
   * this the mix turns into one long click.
   */
  _gate(name, interval) {
    const now = this.ctx.currentTime;
    const last = this._last.get(name) ?? -Infinity;
    if (now - last < interval) return false;
    this._last.set(name, now);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* primitives                                                          */
  /* ------------------------------------------------------------------ */

  /** A band of noise swept through a filter — whooshes, hisses, booms. */
  _noiseBurst({ t = 0, dur = 0.3, gain = 0.3, f0 = 800, f1 = null, q = 1, type = 'bandpass', channel = 'cast' }) {
    const level = this._gain(channel) * gain;
    if (level <= 0.0001) return;
    const ctx = this.ctx;
    const at = ctx.currentTime + t;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(f0, at);
    if (f1 !== null) filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), at + dur * 0.18);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    src.connect(filter).connect(env).connect(this.master);
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  /** One oscillator swept between two pitches — blips, zaps, horns. */
  _tone({ t = 0, dur = 0.25, gain = 0.2, f0 = 440, f1 = null, wave = 'sine', channel = 'cast', glideCurve = 'exp' }) {
    const level = this._gain(channel) * gain;
    if (level <= 0.0001) return;
    const ctx = this.ctx;
    const at = ctx.currentTime + t;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(Math.max(20, f0), at);
    if (f1 !== null) {
      const target = Math.max(20, f1);
      if (glideCurve === 'exp') osc.frequency.exponentialRampToValueAtTime(target, at + dur);
      else osc.frequency.linearRampToValueAtTime(target, at + dur);
    }

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), at + 0.015);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    osc.connect(env).connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  /** A burst of filtered noise crackles — lightning, embers, debris. */
  _crackle({ t = 0, dur = 0.35, count = 14, gain = 0.16, f = 2400, channel = 'cast' }) {
    for (let i = 0; i < count; i++) {
      this._noiseBurst({
        t: t + Math.random() * dur,
        dur: 0.015 + Math.random() * 0.04,
        gain: gain * (0.4 + Math.random() * 0.6),
        f0: f * (0.6 + Math.random() * 0.9),
        q: 6,
        channel
      });
    }
  }

  /** The low end every impact leans on: a pitch-dropping sine thump. */
  _thump({ t = 0, dur = 0.4, gain = 0.5, f0 = 150, f1 = 42, channel = 'impact' }) {
    this._tone({ t, dur, gain, f0, f1, wave: 'sine', channel });
    this._noiseBurst({ t, dur: dur * 0.5, gain: gain * 0.5, f0: 420, f1: 90, q: 0.7, type: 'lowpass', channel });
  }

  /* ------------------------------------------------------------------ */
  /* the vocabulary                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * A cast leaves the hand. Each element gets a two-part recipe that matches
   * its look — ice is glassy and airy, thunder is a crack, the meteor rolls in
   * low, the beam charges, the snare zaps, the glacier booms, banknotes flutter.
   *
   * @param {string} element an id from `ELEMENTS`
   */
  cast(element) {
    if (!this.ctx || !this._gate(`cast:${element}`, 0.09)) return;
    switch (element) {
      case 'ice':
        this._noiseBurst({ dur: 0.38, gain: 0.22, f0: 3200, f1: 700, q: 1.4 });
        this._tone({ dur: 0.3, gain: 0.08, f0: 2100, f1: 2900, wave: 'sine' });
        break;
      case 'thunder':
        this._crackle({ dur: 0.22, count: 10, gain: 0.2, f: 3200 });
        this._thump({ dur: 0.24, gain: 0.3, f0: 220, f1: 70 });
        break;
      case 'meteor':
        this._noiseBurst({ dur: 0.65, gain: 0.26, f0: 240, f1: 950, q: 0.9, type: 'lowpass' });
        this._tone({ dur: 0.55, gain: 0.1, f0: 90, f1: 150, wave: 'sawtooth' });
        break;
      case 'beam':
        this._tone({ dur: 0.5, gain: 0.14, f0: 130, f1: 760, wave: 'sawtooth' });
        this._noiseBurst({ dur: 0.5, gain: 0.1, f0: 1800, f1: 4200, q: 2 });
        break;
      case 'snare':
        this._tone({ dur: 0.22, gain: 0.18, f0: 1050, f1: 90, wave: 'square' });
        this._crackle({ dur: 0.18, count: 6, gain: 0.1, f: 4200 });
        break;
      case 'glacier':
        this._tone({ dur: 0.7, gain: 0.16, f0: 92, f1: 60, wave: 'sawtooth' });
        this._tone({ t: 0.02, dur: 0.68, gain: 0.12, f0: 139, f1: 92, wave: 'sawtooth' });
        this._noiseBurst({ dur: 0.6, gain: 0.12, f0: 500, f1: 160, q: 1, type: 'lowpass' });
        break;
      case 'banknote':
        for (let i = 0; i < 7; i++) {
          this._noiseBurst({ t: i * 0.05, dur: 0.06, gain: 0.09, f0: 1500 + Math.random() * 2500, q: 3 });
        }
        break;
      default:
        this._noiseBurst({ dur: 0.3, gain: 0.2, f0: 900, f1: 300 });
        break;
    }
  }

  /** Everything the shake answers has already converged here. */
  impact(amount) {
    if (!this.ctx) return;
    const scaled = Math.min(1, amount);
    if (scaled < 0.04) return;
    if (!this._gate('impact', 0.08)) return;
    this._thump({ dur: 0.3 + scaled * 0.35, gain: 0.28 + scaled * 0.4, f0: 150 + scaled * 60, f1: 38 });
    this._noiseBurst({ dur: 0.25 + scaled * 0.3, gain: 0.12 + scaled * 0.2, f0: 900, f1: 140, q: 0.8, type: 'lowpass', channel: 'impact' });
  }

  /** A minion takes a hit — callers gate this per minion. */
  hit() {
    if (!this.ctx || !this._gate('hit', 0.045)) return;
    const pitch = 260 + Math.random() * 160;
    this._tone({ dur: 0.09, gain: 0.14, f0: pitch, f1: pitch * 0.55, wave: 'triangle', channel: 'combat' });
    this._noiseBurst({ dur: 0.07, gain: 0.09, f0: 1400, f1: 500, q: 1.2, channel: 'combat' });
  }

  /** A minion goes down. */
  death() {
    if (!this.ctx || !this._gate('death', 0.09)) return;
    this._tone({ dur: 0.28, gain: 0.12, f0: 520 + Math.random() * 120, f1: 70, wave: 'triangle', channel: 'combat' });
    this._noiseBurst({ dur: 0.3, gain: 0.1, f0: 800, f1: 180, q: 0.8, type: 'lowpass', channel: 'combat' });
  }

  /** The player takes a hit — heavier, with a warning edge. */
  hurt() {
    if (!this.ctx) return;
    if (!this._gate('hurt', 0.15)) return;
    this._thump({ dur: 0.32, gain: 0.4, f0: 190, f1: 48, channel: 'combat' });
    this._tone({ dur: 0.2, gain: 0.1, f0: 340, f1: 110, wave: 'sawtooth', channel: 'combat' });
  }

  /** The dodge — a short, breathy shove of air. */
  dash() {
    if (!this.ctx) return;
    this._noiseBurst({ dur: 0.22, gain: 0.2, f0: 600, f1: 2600, q: 1.1, channel: 'ui' });
    this._tone({ dur: 0.16, gain: 0.06, f0: 320, f1: 640, wave: 'sine', channel: 'ui' });
  }

  /** Gold lands in the purse. */
  pickup() {
    if (!this.ctx || !this._gate('pickup', 0.05)) return;
    const base = 1320 + Math.random() * 90;
    this._tone({ dur: 0.09, gain: 0.1, f0: base, wave: 'sine', channel: 'ui' });
    this._tone({ t: 0.07, dur: 0.16, gain: 0.1, f0: base * 1.5, wave: 'sine', channel: 'ui' });
  }

  /** A heal orb closes a wound. */
  heal() {
    if (!this.ctx) return;
    this._tone({ dur: 0.3, gain: 0.08, f0: 620, f1: 930, wave: 'sine', channel: 'ui' });
    this._tone({ t: 0.09, dur: 0.3, gain: 0.06, f0: 930, f1: 1240, wave: 'sine', channel: 'ui' });
  }

  /** The boss breaks the floor. */
  boss() {
    if (!this.ctx) return;
    this._tone({ dur: 1.1, gain: 0.26, f0: 62, f1: 44, wave: 'sawtooth', channel: 'impact' });
    this._tone({ t: 0.04, dur: 1.0, gain: 0.14, f0: 93, f1: 66, wave: 'sawtooth', channel: 'impact' });
    this._thump({ dur: 0.8, gain: 0.5, f0: 130, f1: 34 });
    this._crackle({ dur: 0.8, count: 12, gain: 0.12, f: 700, channel: 'impact' });
  }

  /** A UI click — the ability cards and the shop. */
  ui(pitch = 1) {
    if (!this.ctx) return;
    this._tone({ dur: 0.06, gain: 0.07, f0: 760 * pitch, f1: 620 * pitch, wave: 'sine', channel: 'ui' });
  }

  /**
   * A hold begins. The charge winds *up* (a rising saw the length of the
   * charge window, cut short by the release); the channel starts its hum,
   * which the ticks then ride.
   *
   * @param {string} element the element whose hold just began
   */
  holdStart(element) {
    if (!this.ctx) return;
    if (element === 'implosion') {
      this._tone({ dur: 1.6, gain: 0.16, f0: 88, f1: 340, wave: 'sawtooth' });
      this._noiseBurst({ dur: 1.4, gain: 0.1, f0: 400, f1: 2600, q: 1.2 });
    } else if (element === 'tether') {
      this._tone({ dur: 0.5, gain: 0.1, f0: 210, f1: 260, wave: 'sawtooth' });
      this._crackle({ dur: 0.4, count: 6, gain: 0.09, f: 2600 });
    }
  }

  /** One zap of the channel's damage clock. */
  channelTick() {
    if (!this.ctx || !this._gate('channelTick', 0.09)) return;
    const pitch = 520 + Math.random() * 260;
    this._tone({ dur: 0.07, gain: 0.1, f0: pitch, f1: pitch * 0.4, wave: 'square', channel: 'combat' });
  }

  /** Two elements met on one body — a bright, glassy two-note shimmer. */
  reaction() {
    if (!this.ctx || !this._gate('reaction', 0.1)) return;
    const base = 1180 + Math.random() * 160;
    this._tone({ dur: 0.14, gain: 0.12, f0: base, wave: 'sine', channel: 'combat' });
    this._tone({ t: 0.06, dur: 0.24, gain: 0.12, f0: base * 1.335, wave: 'sine', channel: 'combat' });
    this._noiseBurst({ dur: 0.22, gain: 0.08, f0: 5200, f1: 2400, q: 2.5, channel: 'combat' });
  }

  /** The run ends. */
  gameOver() {
    if (!this.ctx) return;
    this._tone({ dur: 0.5, gain: 0.16, f0: 392, f1: 388, wave: 'triangle', channel: 'ui' });
    this._tone({ t: 0.35, dur: 0.5, gain: 0.16, f0: 311, f1: 308, wave: 'triangle', channel: 'ui' });
    this._tone({ t: 0.7, dur: 1.2, gain: 0.18, f0: 233, f1: 228, wave: 'triangle', channel: 'ui' });
  }
}

/** The shared sound service. See the class comment for why this is a singleton. */
export const sfx = new Sound();
