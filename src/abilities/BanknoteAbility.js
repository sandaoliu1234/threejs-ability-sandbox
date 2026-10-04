import {
  BackSide,
  DynamicDrawUsage,
  Euler,
  FrontSide,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3
} from 'three';
import { Ability } from './Ability.js';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { saturate, Easing } from '../utils/math.js';

/**
 * Hard ceiling on the instance count. The editor's slider clamps here, and the
 * two instanced draws (front / back) are built against it once per pooled cast.
 */
const MAX_NOTES = 320;

/** Unitless dice rolls per note: angle, radius, height, two spin rates, phase, size, delay. */
const DICE = 8;

/** The scans are 240×119; one constant keeps every note at the true aspect. */
const NOTE_ASPECT = 240 / 119;

const TAU = Math.PI * 2;

/* ---- per-frame scratch (one shared set; the update allocates nothing) ---- */
const _centre = new Vector3();
const _pos = new Vector3();
const _scale = new Vector3();
const _euler = new Euler();
const _quat = new Quaternion();
const _matrix = new Matrix4();

/**
 * A tiny deterministic PRNG so a cast's storm is reproducible from one seed —
 * the CPU counterpart of the `uSeed` convention the shader-driven abilities use.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * BANKNOTE — the far cast that rains money.
 *
 * Aimed with the shared circle (the third `ZONE` cast, after the snare and the
 * crown): the boundary the indicator draws is the footprint the cyclone fills,
 * so `zoneRadius` scales what you aim with and what you get together.
 *
 * Three beats on the base class's three phases:
 *
 *   1. **travel** — the cast front races to the point; nothing is in the air yet.
 *   2. **hold** — the impact phase, `lifetime` long: notes punch up off the
 *      floor inside the footprint and settle into a slow cyclone — a climbing,
 *      breathing spiral of tumbling banknotes.
 *   3. **let-go** — the fade phase: the vortex decelerates, the spiral widens
 *      and every note flutters down like a leaf, shrinking out where it lands.
 *
 * The notes are one unit plane drawn **twice** as an InstancedMesh: the front
 * pass renders the obverse scan to front-facing fragments, the back pass the
 * reverse scan to back-facing ones — so a note flips between its two faces as
 * it tumbles, at two draw calls for the whole storm.
 *
 * **The rule that makes the editor work.** A cast captures one seed and nothing
 * else: every metre, radian and second is resolved against `settings.banknote`
 * each frame from the dice below, which is why dragging any slider re-shapes a
 * storm that is already standing — including with the clock stopped.
 */
export class BanknoteAbility extends Ability {
  /** Set by `App#load` (via the ability manager) before the pools are warmed. */
  static _textures = null;

  static setTextures(front, back) {
    for (const texture of [front, back]) {
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
    }
    BanknoteAbility._textures = { front, back };
  }

  constructor(context) {
    super('banknote', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const textures = BanknoteAbility._textures;

    this.geometry = new PlaneGeometry(1, 1);
    this.frontMaterial = new MeshBasicMaterial({
      map: textures?.front ?? null,
      side: FrontSide,
      toneMapped: false
    });
    this.backMaterial = new MeshBasicMaterial({
      map: textures?.back ?? null,
      side: BackSide,
      toneMapped: false
    });

    this.meshes = [this.frontMaterial, this.backMaterial].map((material) => {
      const mesh = new InstancedMesh(this.geometry, material, MAX_NOTES);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 6; // over the floor field, under the additive FX
      this.group.add(mesh);
      return mesh;
    });

    /** Re-rolled per cast from one seed so no two storms blow the same. */
    this._seed = 0;
    this._dice = new Float32Array(MAX_NOTES * DICE);
    /** Seconds since the vortex opened. Derived, never stored per note. */
    this._stormAge = 0;
    this._noteCount = 1;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._noteCount * this.meshes.length;
  }

  /** The cyclone holds for `lifetime`, then the notes let go and flutter down. */
  get impactDuration() {
    return Math.max(0.05, settings.banknote.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.banknote.fadeTime * settings.global.lifetime);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const cfg = settings.banknote;
    this._seed = Math.floor(Math.random() * 2 ** 31);
    const random = mulberry32(this._seed);
    const dice = this._dice;

    for (let i = 0; i < MAX_NOTES; i++) {
      const o = i * DICE;
      dice[o + 0] = random() * TAU; // base angle around the vortex
      dice[o + 1] = Math.sqrt(random()); // radius norm (√ for an even disc)
      dice[o + 2] = random(); // height norm inside the column
      dice[o + 3] = random() * 2 - 1; // tumble rate, axis X
      dice[o + 4] = random() * 2 - 1; // tumble rate, axis Y
      dice[o + 5] = random() * TAU; // flutter phase
      dice[o + 6] = 0.75 + random() * 0.4; // size jitter
      dice[o + 7] = random(); // launch delay, × riseSpread
    }

    this._stormAge = 0;
    this._tickTimer = cfg.tickInterval;
    this._noteCount = Math.min(
      MAX_NOTES,
      Math.max(1, Math.round(cfg.count * settings.global.particleCount))
    );
    for (const mesh of this.meshes) {
      mesh.count = this._noteCount;
      mesh.visible = false;
    }
  }

  onImpact() {
    // A warm punch of light as the vortex tears open; the base class decays it.
    this.lightBoost = 6;
    for (const mesh of this.meshes) mesh.visible = true;
  }

  /**
   * Per-frame while the storm stands (`t` 0..1) and lets go (`t` 1..2).
   * Everything below reads live settings — nothing is captured at spawn.
   */
  onFade(dt, t) {
    const cfg = settings.banknote;
    const LT = settings.global.lifetime;

    // Absolute seconds since the vortex opened. `impactTime` runs through the
    // hold, `fadeTime` keeps counting through the fade — the sum is continuous.
    this._stormAge = this.impactTime + this.fadeTime;
    const s = this._stormAge;
    const hold = this.impactDuration;
    const fall = this.fadeDuration;

    const count = Math.min(
      MAX_NOTES,
      Math.max(1, Math.round(cfg.count * settings.global.particleCount))
    );
    if (count !== this._noteCount) {
      this._noteCount = count;
      for (const mesh of this.meshes) mesh.count = count;
    }

    this.pointAt(1, _centre).setY(0);

    // The cyclone grinds the minions inside the footprint while it holds.
    this._tickTimer -= dt;
    if (this._tickTimer <= 0 && t <= 1) {
      const minions = this.ctx.minions;
      if (minions && cfg.tickDamage > 0) {
        minions.damageCircle(_centre, cfg.zoneRadius, cfg.tickDamage, { element: this.element });
      }
      this._tickTimer += cfg.tickInterval;
    }
    const radiusScale = Math.max(0.5, cfg.zoneRadius);
    const riseTime = Math.max(0.05, cfg.riseTime * LT);
    const spread = Math.max(0, cfg.riseSpread * LT);
    const swirl = cfg.swirlSpeed * TAU;
    const flutterFreq = Math.max(0.05, cfg.flutterFreq);

    for (let i = 0; i < count; i++) {
      const o = i * DICE;
      const a0 = this._dice[o + 0];
      const r0 = this._dice[o + 1];
      const h0 = this._dice[o + 2];
      const spinX = this._dice[o + 3];
      const spinY = this._dice[o + 4];
      const phase = this._dice[o + 5];
      const sizeJitter = this._dice[o + 6];
      const delay = this._dice[o + 7];

      const td = Math.max(0, s - delay * spread);
      const rise = Easing.outCubic(saturate(td / riseTime));
      const hold01 = saturate(s / hold);
      const fall01 = saturate((s - hold) / fall);

      /* --- position: a climbing, breathing spiral that lets go --- */
      const angle =
        a0 +
        swirl * s * (1 - 0.45 * fall01) +
        Math.sin(s * 0.7 + phase) * 0.15 * cfg.flutter;
      const radius =
        radiusScale *
        (0.12 + 0.88 * r0) *
        (0.35 + 0.65 * rise) *
        (1 + cfg.expand * hold01 + cfg.fallSpread * fall01);

      let height =
        0.35 +
        (cfg.riseHeight - 0.35) * rise * (0.55 + 0.45 * h0) +
        cfg.swirlSway * Math.sin(s * cfg.swaySpeed + phase) * rise +
        hold01 * cfg.swirlSway * 0.6;
      // The let-go: height collapses on a quadratic (gravity-like) curve.
      height *= 1 - Easing.inQuad(fall01);
      height = Math.max(0.02, height);

      // Leaf-flutter drift while falling.
      const drift = fall01 * cfg.flutter;
      _pos.set(
        _centre.x +
          Math.cos(angle) * radius +
          Math.sin(fall01 * flutterFreq * TAU + phase) * 0.45 * drift,
        height,
        _centre.z +
          Math.sin(angle) * radius +
          Math.cos(fall01 * flutterFreq * TAU * 0.83 + phase * 1.7) * 0.4 * drift
      );

      /* --- orientation: a continuous tumble with a leaf wobble on top --- */
      _euler.set(
        spinX * TAU * cfg.spinSpeed * s + phase,
        spinY * TAU * cfg.spinSpeed * s * 0.85 + a0,
        Math.sin(s * flutterFreq * TAU * 0.5 + phase) * 0.9 * cfg.flutter
      );
      _quat.setFromEuler(_euler);

      /* --- scale: back-eased birth, and out where it lands --- */
      const birth = Math.max(0.001, Easing.outBack(rise));
      const groundFade = fall01 > 0 ? saturate(height / 0.3) : 1;
      const endShrink = 1 - saturate((fall01 - 0.85) / 0.15);
      const shrink = birth * groundFade * endShrink;
      const longEdge = cfg.noteSize * sizeJitter;
      _scale.set(longEdge * shrink, (longEdge / NOTE_ASPECT) * shrink, 1);

      _matrix.compose(_pos, _quat, _scale);
      this.meshes[0].setMatrixAt(i, _matrix);
      this.meshes[1].setMatrixAt(i, _matrix);
    }

    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    // Brightness rides the live `glow` gain, breathing very slightly.
    const glow = cfg.glow * (1 + 0.08 * Math.sin(s * 3.1));
    this.frontMaterial.color.setScalar(glow);
    this.backMaterial.color.setScalar(glow);
  }

  onDestroy() {
    for (const mesh of this.meshes) mesh.visible = false;
  }
}
