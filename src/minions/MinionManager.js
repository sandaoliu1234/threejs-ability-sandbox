import { Color, Group, MeshStandardMaterial, Vector3 } from 'three';

import { settings } from '../config/settings.js';
import { frame } from '../core/FrameUniforms.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';

import { HealthBars } from './HealthBars.js';
import { Minion } from './Minion.js';

const _up = new Vector3(0, 1, 0);

/**
 * Owns every minion: the wave director that sends them in, the pool they
 * live in, the damage queries the abilities call, and the on/off switch.
 *
 * The combat contract is deliberately tiny. Abilities do not know minions
 * exist as *things* — they call two verbs on `this.ctx.minions`:
 *
 *   damageSegment(from, to, width, damage, { hitSet }) — a band swept along a
 *     line (the skillshot fronts, the standing beam). Falloff toward the edge
 *     of the band; knockback along the sweep.
 *   damageCircle(center, radius, damage, { hitSet }) — an area (the far casts'
 *     footprints, the meteor's detonation). Falloff toward the rim; knockback
 *     radially outward.
 *
 * Both accept an optional `hitSet` — a Map the *caller* owns. While it is
 * passed, each minion is struck at most once per set: it stores the minion's
 * `token`, which is bumped on every spawn, so a pooled minion's next life is
 * never mistaken for the one that was already hit. Omit it and the call is a
 * damage-over-time tick, free to hit the same minion again next frame.
 *
 * Nothing is allocated per frame: the separation pass works on plain fields,
 * the pool recycles bodies, and the bars are one instanced draw.
 */
export class MinionManager {
  /**
   * @param {object} context
   * @param {import('three').Scene} scene
   * @param {import('../particles/ParticleEngine.js').ParticleEngine} particles
   */
  constructor({ scene, particles }) {
    this.scene = scene;
    this.particles = particles;

    /** The point the swarm converges on — the character's live position. */
    this.target = new Vector3();

    /** Set by App for the HUD readout. */
    this.onKill = null;

    this.root = new Group();
    this.root.name = 'Minions';
    scene.add(this.root);

    this.bars = new HealthBars();
    this.root.add(this.bars.mesh);

    /* --- shared materials: one body base (cloned per minion for the
           hit-flash), one eye material shared by the whole swarm --- */
    this.bodyBase = new MeshStandardMaterial({
      color: 0x54283a,
      roughness: settings.minions.roughness,
      metalness: 0,
      emissive: 0xffffff,
      emissiveIntensity: 0
    });
    this.eyeMaterial = new MeshStandardMaterial({
      color: 0xff6a3c,
      emissive: 0xff6a3c,
      emissiveIntensity: settings.minions.eyeGlow,
      roughness: 0.4
    });
    /** Live body colour, sampled from settings once per frame. */
    this.bodyColor = new Color();
    this.flashColor = new Color();
    this._eyeColor = new Color();

    this.pool = new ObjectPool(() => {
      // Bodies stay parented to the group for their whole lifetime — hidden
      // when pooled, which also keeps them in the tree for the warm draw.
      const minion = new Minion(this, this.bodyBase, this.eyeMaterial);
      this.root.add(minion.root);
      return minion;
    });
    this.active = [];

    // The first wave comes soon after the load, not after a full interval.
    this.spawnTimer = 1.2;

    this._puff = null;
    this._emit = {};
  }

  /**
   * Point the swarm at the character. Stored by reference — the character
   * never re-assigns `root.position`.
   * @param {Vector3} position
   */
  setTarget(position) {
    this.target = position;
  }

  get enabled() {
    return settings.minions.enabled;
  }

  /**
   * Flip the whole system. Off = the director stops and the minions on the
   * floor dissolve quickly; on = the next wave is a moment away.
   * Mutates `settings.minions.enabled`, so the editor checkbox follows.
   */
  toggle() {
    settings.minions.enabled = !settings.minions.enabled;
    if (!settings.minions.enabled) {
      for (const minion of this.active) minion.vanish();
    } else {
      this.spawnTimer = Math.min(this.spawnTimer, 0.4);
    }
    return settings.minions.enabled;
  }

  /**
   * Build (and immediately retire) the full cast of bodies so the first wave
   * costs nothing, and hand back the root for the loading-veil warm draw.
   * @returns {Group}
   */
  prewarm() {
    const warmed = [];
    const count = Math.max(1, Math.ceil(settings.minions.maxAlive));
    for (let i = 0; i < count; i++) warmed.push(this.pool.acquire());
    for (const minion of warmed) {
      minion.destroy();
      this.pool.release(minion);
    }
    return this.root;
  }

  /* ------------------------------------------------------------------ */
  /* per frame                                                           */
  /* ------------------------------------------------------------------ */

  update(dt) {
    const c = settings.minions;

    // Keep the shared look live — every body copies these per frame.
    this.bodyColor.copy(getColor(c.colorBody));
    this.flashColor.copy(getColor(c.flashColor));
    this._eyeColor.copy(getColor(c.colorEye));
    this.eyeMaterial.color.copy(this._eyeColor);
    this.eyeMaterial.emissive.copy(this._eyeColor);
    this.eyeMaterial.emissiveIntensity = c.eyeGlow;
    this.bodyBase.roughness = c.roughness;
    this.root.visible = c.enabled || this.active.length > 0;

    if (this.active.length) {
      this._separation();
      for (let i = this.active.length - 1; i >= 0; i--) {
        this.active[i].update(dt);
      }
    }

    // The director. Paused (dt = 0) it never fires, like every other clock.
    if (c.enabled && dt > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.active.length < c.maxAlive) {
        this._spawnWave(Math.min(c.waveSize, c.maxAlive - this.active.length));
        this.spawnTimer = c.spawnInterval;
      }
    }

    this.bars.sync(this.active);
  }

  /**
   * One O(n²) pass pushes overlapping neighbours apart — with a couple dozen
   * minions this is far cheaper than a spatial hash, and it is what turns the
   * swarm into a ring instead of a stack.
   */
  _separation() {
    const c = settings.minions;
    const minDist = c.separateRadius * c.scale;
    const list = this.active;

    for (const minion of list) {
      minion.sepX = 0;
      minion.sepZ = 0;
    }

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const d = Math.hypot(dx, dz);
        if (d >= minDist) continue;
        if (d < 1e-4) {
          // Dead centre: nudge on a random bearing so they never weld.
          const angle = Math.random() * Math.PI * 2;
          a.sepX -= Math.cos(angle) * c.separateStrength;
          b.sepX += Math.cos(angle) * c.separateStrength;
          continue;
        }
        const push = ((minDist - d) / minDist) * c.separateStrength;
        const nx = dx / d;
        const nz = dz / d;
        a.sepX -= nx * push;
        a.sepZ -= nz * push;
        b.sepX += nx * push;
        b.sepZ += nz * push;
      }
    }
  }

  _spawnWave(count) {
    const c = settings.minions;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = c.spawnRadius + (Math.random() * 2 - 1) * c.spawnJitter;
      const x = this.target.x + Math.sin(angle) * radius;
      const z = this.target.z + Math.cos(angle) * radius;

      const minion = this.pool.acquire();
      this.active.push(minion);
      minion.spawn(x, z);

      // A puff of dust where it breaks through the floor.
      this._puffAt(minion.position, 6, 0.3);
    }
  }

  /** Called by a minion's own `update` once its corpse finishes sinking. */
  recycle(minion) {
    const index = this.active.indexOf(minion);
    if (index >= 0) this.active.splice(index, 1);
    minion.destroy(); // hides the body; it stays parented for reuse
    this.pool.release(minion);
  }

  /** Called the moment a minion's health empties — the body is still falling. */
  onDeath(minion) {
    this.onKill?.();
    this._puffAt(minion.position, settings.minions.deathBurst, 0.4);
  }

  /* ------------------------------------------------------------------ */
  /* the death puff                                                      */
  /* ------------------------------------------------------------------ */

  _puffAt(position, count, radius) {
    const c = settings.minions;
    if (!this._puff) {
      this._puff = this.particles.get('minion.puff', {
        capacity: 600,
        shape: ParticleShape.SOFT,
        additive: true,
        curl: true,
        softFade: 0.6
      });
      this._puff.uniforms.uDrag.value = 1.6;
      this._puff.uniforms.uEndSize.value = 2.2;
      this._puff.uniforms.uFadeIn.value = 0.06;
      this._puff.uniforms.uFadeOut.value = 0.55;
      this._puff.setGradient(
        getColor(c.colorEye).clone(),
        getColor(c.colorBody).clone().multiplyScalar(3),
        getColor(c.colorBody).clone(),
        new Color(0x050508)
      );
    }

    const emit = this._emit;
    emit.position = position;
    emit.radius = radius;
    emit.direction = _up;
    emit.speed = 2.2;
    emit.speedVariance = 0.7;
    emit.spread = 1.0;
    emit.size = 0.5;
    emit.sizeVariance = 0.6;
    emit.life = 0.7;
    emit.lifeVariance = 0.4;
    emit.spin = 1.2;
    emit.time = frame.uTime.value;
    this._puff.emit(count, emit);
  }

  /* ------------------------------------------------------------------ */
  /* damage queries                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Strike every living minion within `width` of the segment `from`→`to`
   * (XZ; heights are ignored — the minions are on the floor).
   *
   * @param {Vector3} from
   * @param {Vector3} to
   * @param {number} width  half-width of the band, metres
   * @param {number} damage on the centre line, before falloff
   * @param {{hitSet?: Map}} [options] pass the caster's registry for hit-once
   */
  damageSegment(from, to, width, damage, options = {}) {
    if (damage <= 0 || width <= 0 || !this.active.length) return;

    const c = settings.minions;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const lengthSq = dx * dx + dz * dz;
    const len = Math.sqrt(lengthSq);
    const hitSet = options.hitSet;

    for (const minion of this.active) {
      if (!minion.alive) continue;
      const px = minion.position.x - from.x;
      const pz = minion.position.z - from.z;
      let t = lengthSq > 1e-8 ? (px * dx + pz * dz) / lengthSq : 0;
      t = saturate(t);
      const lateral = Math.hypot(px - dx * t, pz - dz * t) - c.bodyRadius * c.scale;
      if (lateral > width) continue;
      if (hitSet && hitSet.get(minion) === minion.token) continue;

      const edge = saturate(Math.max(0, lateral) / width);
      const falloff = Math.max(0.1, 1 - c.falloff * edge);
      // Bowled over along the sweep, not sideways off it.
      const dirX = len > 1e-6 ? dx / len : 0;
      const dirZ = len > 1e-6 ? dz / len : 0;

      if (hitSet) hitSet.set(minion, minion.token);
      minion.applyDamage(damage * falloff, dirX, dirZ);
    }
  }

  /**
   * Strike every living minion within `radius` of `center` (XZ).
   *
   * @param {Vector3} center
   * @param {number} radius metres
   * @param {number} damage at the centre, before falloff
   * @param {{hitSet?: Map}} [options]
   */
  damageCircle(center, radius, damage, options = {}) {
    if (damage <= 0 || radius <= 0 || !this.active.length) return;

    const c = settings.minions;
    const hitSet = options.hitSet;

    for (const minion of this.active) {
      if (!minion.alive) continue;
      const dx = minion.position.x - center.x;
      const dz = minion.position.z - center.z;
      const d = Math.hypot(dx, dz);
      const dist = d - c.bodyRadius * c.scale;
      if (dist > radius) continue;
      if (hitSet && hitSet.get(minion) === minion.token) continue;

      const edge = saturate(Math.max(0, dist) / radius);
      // The 1.2 lets the rim bite a little harder than a line hit does; the
      // clamp keeps an aggressive `falloff` from producing healing hits.
      const falloff = Math.max(0.1, 1 - c.falloff * 1.2 * edge);
      const dirX = d > 1e-4 ? dx / d : 0;
      const dirZ = d > 1e-4 ? dz / d : 0;

      if (hitSet) hitSet.set(minion, minion.token);
      minion.applyDamage(damage * falloff, dirX, dirZ);
    }
  }

  dispose() {
    for (const minion of this.active) minion.destroy();
    this.active.length = 0;
    this.pool.dispose((minion) => minion.dispose());
    this.bars.dispose();
    this.bodyBase.dispose();
    this.eyeMaterial.dispose();
    this.root.removeFromParent();
  }
}
