import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';
import { sfx } from '../audio/Sound.js';

import { HealthBars } from './HealthBars.js';
import { Minion } from './Minion.js';

const _up = new Vector3(0, 1, 0);
const _white = new Color(0xffffff);
const _c = new Color();

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
    /** Set by App: a boss slam just landed (camera work lives over there). */
    this.onSlam = null;

    /** The player state (`game/Player.js`) — null until App wires it. */
    this.player = null;
    /** The loot system (`game/Drops.js`) — deaths shed coins through it. */
    this.drops = null;

    /** Completed waves since the last restart; bosses ride every Nth. */
    this.waveCount = 0;

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
    /** Caste tints, refreshed per frame from settings. */
    this.rangedColor = new Color();
    this.bossColor = new Color();

    /* --- the bolts the throwers lob --- */
    this._boltGeometry = new SphereGeometry(0.09, 8, 6);
    this._boltMaterial = new MeshBasicMaterial({
      color: getColor(settings.minions.ranged.color),
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false
    });
    this._boltRoot = new Group();
    this._boltRoot.name = 'Bolts';
    scene.add(this._boltRoot);
    /** @type {{mesh: Mesh, vx: number, vz: number, life: number, active: boolean}[]} */
    this.bolts = [];

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

  /** Hand the swarm its two rivals-turned-counterparties. */
  setPlayer(player) {
    this.player = player;
  }

  setDrops(drops) {
    this.drops = drops;
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
    this.rangedColor.copy(getColor(c.ranged.color));
    this.bossColor.copy(getColor(c.boss.color));
    this._boltMaterial.color.copy(getColor(c.ranged.color));
    this.bodyBase.roughness = c.roughness;
    this.root.visible = c.enabled || this.active.length > 0;

    if (this.active.length) {
      this._separation();
      for (let i = this.active.length - 1; i >= 0; i--) {
        this.active[i].update(dt);
      }
    }

    this._updateBolts(dt);

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
    this.waveCount++;

    // Every Nth wave arrives led by a boss: one body, the health of a squad,
    // and the slam. It comes out of the same pool, so it costs nothing extra.
    const bossWave = c.boss.everyNWaves > 0 && this.waveCount % c.boss.everyNWaves === 0;

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = c.spawnRadius + (Math.random() * 2 - 1) * c.spawnJitter;
      const x = this.target.x + Math.sin(angle) * radius;
      const z = this.target.z + Math.cos(angle) * radius;

      const isBoss = bossWave && i === 0;
      const minion = this.pool.acquire();
      this.active.push(minion);
      minion.spawn(x, z, {
        boss: isBoss,
        ranged: !isBoss && c.ranged.enabled && Math.random() < c.ranged.share
      });

      // A puff of dust where it breaks through the floor.
      this._puffAt(minion.position, isBoss ? 26 : 6, isBoss ? 1.0 : 0.3);
      if (isBoss) {
        sfx.boss();
        this._puffAt(minion.position, 20, 1.4);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* their answer                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * A bite lands. The damage arrives resolved for the caste; the player's own
   * invulnerability gate decides whether it matters.
   */
  attackPlayer(minion, damage, dirX, dirZ) {
    if (!this.player) return;
    this.player.damage(damage, dirX, dirZ);
  }

  /** The boss's shockwave: punished for standing close, announced either way. */
  bossSlam(minion, dirX, dirZ) {
    const c = settings.minions.boss;
    this._puffAt(minion.position, 30, c.slamRadius * 0.55);
    sfx.impact(0.7);
    this.onSlam?.(minion.position, c.slamRadius);

    if (!this.player) return;
    // `this.target` is the character's live position — the player's feet.
    const px = this.target.x;
    const pz = this.target.z;
    const dist = Math.hypot(px - minion.position.x, pz - minion.position.z);
    if (dist <= c.slamRadius) {
      const nx = dist > 1e-4 ? (px - minion.position.x) / dist : dirX;
      const nz = dist > 1e-4 ? (pz - minion.position.z) / dist : dirZ;
      this.player.damage(c.slamDamage, nx, nz);
    }
  }

  /**
   * A thrower lobs a bolt. The mesh comes off a small pool; the bolt flies
   * flat, leaves a spark trail and only ever threatens the player.
   */
  fireBolt(minion) {
    const c = settings.minions.ranged;
    let bolt = this.bolts.find((b) => !b.active);
    if (!bolt) {
      if (this.bolts.length >= 48) return;
      const mesh = new Mesh(this._boltGeometry, this._boltMaterial);
      mesh.layers.set(LAYER.VFX);
      mesh.visible = false;
      this._boltRoot.add(mesh);
      bolt = { mesh, vx: 0, vz: 0, life: 0, active: false };
      this.bolts.push(bolt);
    }

    const px = this.target.x;
    const pz = this.target.z;
    const dx = px - minion.position.x;
    const dz = pz - minion.position.z;
    const dist = Math.hypot(dx, dz) || 1;

    bolt.active = true;
    bolt.life = c.boltLife;
    bolt.vx = (dx / dist) * c.speed;
    bolt.vz = (dz / dist) * c.speed;
    bolt.mesh.position.set(minion.position.x, 0.75 * minion.root.scale.y, minion.position.z);
    bolt.mesh.visible = true;
  }

  /** Fly, sparkle, hit or die. */
  _updateBolts(dt) {
    const c = settings.minions.ranged;
    if (!this.bolts.length) return;

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bolt = this.bolts[i];
      if (!bolt.active) continue;

      bolt.life -= dt;
      bolt.mesh.position.x += bolt.vx * dt;
      bolt.mesh.position.z += bolt.vz * dt;
      bolt.mesh.position.y = 0.75 + Math.sin(frame.uTime.value * 9 + i) * 0.05;

      let done = bolt.life <= 0;

      if (!done && this.player && this.player.alive) {
        const dx = bolt.mesh.position.x - this.target.x;
        const dz = bolt.mesh.position.z - this.target.z;
        if (Math.hypot(dx, dz) < 0.7) {
          const speed = Math.hypot(bolt.vx, bolt.vz) || 1;
          this.player.damage(c.damage, -bolt.vx / speed, -bolt.vz / speed);
          done = true;
        }
      }

      if (!done) {
        // One spark per frame per bolt — the trail is the projectile's body.
        this._sparkAt(bolt.mesh.position);
      }

      if (done) {
        bolt.active = false;
        bolt.mesh.visible = false;
      }
    }
  }

  _sparkAt(position) {
    if (!this._spark) {
      this._spark = this.particles.get('minion.boltTrail', {
        capacity: 200,
        shape: ParticleShape.SPARK,
        additive: true,
        softFade: 0.5
      });
      this._spark.uniforms.uFadeIn.value = 0.01;
      this._spark.uniforms.uFadeOut.value = 0.25;
      this._spark.setGradient(
        getColor(settings.minions.ranged.color).clone(),
        getColor(settings.minions.ranged.color).clone().multiplyScalar(0.7),
        getColor(settings.minions.ranged.color).clone().multiplyScalar(0.3),
        new Color(0x140502)
      );
    }
    const emit = this._emit;
    emit.position = position;
    emit.radius = 0.06;
    emit.speed = 0.4;
    emit.speedVariance = 0.3;
    emit.spread = 1.0;
    emit.size = 0.22;
    emit.sizeVariance = 0.1;
    emit.life = 0.3;
    emit.lifeVariance = 0.1;
    emit.time = frame.uTime.value;
    this._spark.emit(1, emit);
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
    sfx.death();
    this.drops?.drop(minion.position, minion.isBoss);
    this._puffAt(minion.position, settings.minions.deathBurst * (minion.isBoss ? 2.2 : 1), 0.4);
  }

  /**
   * Everything goes back into the floor at once — the restart path. Bolts
   * die instantly, bodies take the quick dissolve so the field clears with
   * a beat rather than a pop.
   */
  clearAll() {
    for (const minion of this.active) minion.vanish();
    for (const bolt of this.bolts) {
      bolt.active = false;
      bolt.mesh.visible = false;
    }
    this.waveCount = 0;
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
  /* reactions                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * A reaction just detonated on a body: a burst in the reaction's colour and
   * its own sound. One shared emitter, re-tinted per detonation — the same
   * trick the drops and the death puff already use.
   *
   * @param {Vector3} position
   * @param {{name: string, color: string, bonus: number}} reaction
   */
  reactionAt(position, reaction) {
    if (!this._reaction) {
      this._reaction = this.particles.get('minion.reaction', {
        capacity: 240,
        shape: ParticleShape.SPARK,
        additive: true,
        softFade: 0.4
      });
      this._reaction.uniforms.uFadeIn.value = 0.015;
      this._reaction.uniforms.uFadeOut.value = 0.28;
    }
    _c.set(reaction.color);
    this._reaction.setGradient(
      _c.clone().lerp(_white, 0.65),
      _c.clone(),
      _c.clone().multiplyScalar(0.45),
      new Color(0x0a0a12)
    );

    const emit = this._emit;
    emit.position = position;
    emit.radius = 0.4;
    emit.direction = _up;
    emit.speed = 5.5;
    emit.speedVariance = 1.6;
    emit.spread = 1.0;
    emit.size = 0.34;
    emit.sizeVariance = 0.2;
    emit.life = 0.42;
    emit.lifeVariance = 0.14;
    emit.spin = 2.5;
    emit.time = frame.uTime.value;
    this._reaction.emit(14, emit);

    sfx.reaction();
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
   * @param {{hitSet?: Map, element?: string}} [options] pass the caster's registry for hit-once
   */
  damageSegment(from, to, width, damage, options = {}) {
    if (damage <= 0 || width <= 0 || !this.active.length) return;

    const c = settings.minions;
    const boost = this.player?.damageMult ?? 1;
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
      const lateral = Math.hypot(px - dx * t, pz - dz * t) - minion.bodyRadius;
      if (lateral > width) continue;
      if (hitSet && hitSet.get(minion) === minion.token) continue;

      const edge = saturate(Math.max(0, lateral) / width);
      const falloff = Math.max(0.1, 1 - c.falloff * edge);
      // Bowled over along the sweep, not sideways off it.
      const dirX = len > 1e-6 ? dx / len : 0;
      const dirZ = len > 1e-6 ? dz / len : 0;

      if (hitSet) hitSet.set(minion, minion.token);
      minion.applyDamage(damage * boost * falloff, dirX, dirZ, options.element ?? null);
    }
  }

  /**
   * Strike every living minion within `radius` of `center` (XZ).
   *
   * @param {Vector3} center
   * @param {number} radius metres
   * @param {number} damage at the centre, before falloff
   * @param {{hitSet?: Map, element?: string}} [options]
   */
  damageCircle(center, radius, damage, options = {}) {
    if (damage <= 0 || radius <= 0 || !this.active.length) return;

    const c = settings.minions;
    const boost = this.player?.damageMult ?? 1;
    const hitSet = options.hitSet;

    for (const minion of this.active) {
      if (!minion.alive) continue;
      const dx = minion.position.x - center.x;
      const dz = minion.position.z - center.z;
      const d = Math.hypot(dx, dz);
      const dist = d - minion.bodyRadius;
      if (dist > radius) continue;
      if (hitSet && hitSet.get(minion) === minion.token) continue;

      const edge = saturate(Math.max(0, dist) / radius);
      // The 1.2 lets the rim bite a little harder than a line hit does; the
      // clamp keeps an aggressive `falloff` from producing healing hits.
      const falloff = Math.max(0.1, 1 - c.falloff * 1.2 * edge);
      const dirX = d > 1e-4 ? dx / d : 0;
      const dirZ = d > 1e-4 ? dz / d : 0;

      if (hitSet) hitSet.set(minion, minion.token);
      minion.applyDamage(damage * boost * falloff, dirX, dirZ, options.element ?? null);
    }
  }

  dispose() {
    for (const minion of this.active) minion.destroy();
    this.active.length = 0;
    this.pool.dispose((minion) => minion.dispose());
    this.bars.dispose();
    this.bodyBase.dispose();
    this.eyeMaterial.dispose();
    for (const bolt of this.bolts) bolt.mesh.removeFromParent();
    this.bolts.length = 0;
    this._boltGeometry.dispose();
    this._boltMaterial.dispose();
    this._boltRoot.removeFromParent();
    this.root.removeFromParent();
  }
}
