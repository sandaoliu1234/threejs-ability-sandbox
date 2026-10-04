import {
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  ConeGeometry,
  Vector3
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { settings, reactionOf } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { Easing, saturate } from '../utils/math.js';
import { sfx } from '../audio/Sound.js';

/**
 * One little enemy.
 *
 * The model is procedural — a merged blob of sphere/cone primitives, no assets
 * on disk — and the animation is procedural too: a bob and a waddle composed on
 * a pivot, so a minion is two draw calls and no skeleton. What a minion *keeps*
 * is dice and timestamps only: its personal speed jitter, its bob phase, the
 * axis it will topple around when it dies. Every metre, radian and second is
 * resolved against `settings.minions` each frame, on a paused frame included.
 *
 * The lifecycle mirrors the abilities' phase machine:
 *
 *   RISE — punching up out of the floor, already damageable
 *   SEEK — converging on the caster (separation is applied by the manager)
 *   CROWD — arrived at `attackRange`, milling about at the caster's feet
 *   DYING — topple around the feet, pause, sink, then back to the pool
 *
 * `spawn` fully resets state and allocates nothing; `applyDamage` is the whole
 * combat contract — health, hit-flash, knockback, stagger and death all hang
 * off it.
 */
export const MinionPhase = Object.freeze({
  RISE: 'rise',
  SEEK: 'seek',
  CROWD: 'crowd',
  DYING: 'dying'
});

const _up = new Vector3(0, 1, 0);
const _axis = new Vector3();
const _quat = new Quaternion();

/* ------------------------------------------------------------------ */
/* Shared geometry, built once per session                             */
/* ------------------------------------------------------------------ */

/**
 * The body: one squashed blob, two horns, two feet, merged into a single
 * geometry so a minion's body is a single draw call. Forward is +Z — the eyes
 * sit on that side and `root.rotation.y = atan2(dx, dz)` faces the target.
 */
function buildBodyGeometry() {
  const parts = [];

  const body = new SphereGeometry(0.5, 14, 12);
  body.scale(1.0, 1.12, 0.94);
  body.translate(0, 0.55, 0);
  parts.push(body);

  for (const side of [-1, 1]) {
    const horn = new ConeGeometry(0.1, 0.3, 6);
    horn.rotateZ(side * -0.38);
    horn.translate(side * 0.17, 1.08, 0.02);
    parts.push(horn);

    const foot = new SphereGeometry(0.14, 8, 6);
    foot.scale(1.0, 0.6, 1.25);
    foot.translate(side * 0.2, 0.07, 0.05);
    parts.push(foot);
  }

  return mergeGeometries(parts);
}

/** The eyes: two spheres merged into one emissive mesh. */
function buildEyeGeometry() {
  const parts = [];
  for (const side of [-1, 1]) {
    const eye = new SphereGeometry(0.078, 8, 6);
    eye.translate(side * 0.16, 0.72, 0.4);
    parts.push(eye);
  }
  return mergeGeometries(parts);
}

let _bodyGeometry = null;
let _eyeGeometry = null;

export function minionGeometry() {
  if (!_bodyGeometry) _bodyGeometry = buildBodyGeometry();
  return _bodyGeometry;
}

export function minionEyeGeometry() {
  if (!_eyeGeometry) _eyeGeometry = buildEyeGeometry();
  return _eyeGeometry;
}

/* ------------------------------------------------------------------ */

export class Minion {
  /**
   * @param {import('./MinionManager.js').MinionManager} manager
   * @param {MeshStandardMaterial} bodyBase cloned per minion for the hit-flash
   * @param {MeshStandardMaterial} eyeMaterial shared across every minion
   */
  constructor(manager, bodyBase, eyeMaterial) {
    this.manager = manager;

    this.root = new Group();
    this.root.name = 'Minion';

    // `tilt` carries the death topple (world-space axis, so it composes with
    // the heading on `root`); `bodyPivot` carries the walk bob and the waddle.
    this.tilt = new Group();
    this.bodyPivot = new Group();
    this.root.add(this.tilt);
    this.tilt.add(this.bodyPivot);

    this.bodyMaterial = bodyBase.clone();
    this.bodyMesh = new Mesh(minionGeometry(), this.bodyMaterial);
    this.bodyMesh.castShadow = true;
    this.bodyMesh.receiveShadow = true;
    this.bodyMesh.layers.set(LAYER.WORLD);

    this.eyeMesh = new Mesh(minionEyeGeometry(), eyeMaterial);
    this.eyeMesh.layers.set(LAYER.WORLD);

    this.bodyPivot.add(this.bodyMesh, this.eyeMesh);

    this.phase = MinionPhase.RISE;

    /** Bumped on every spawn — hit-once registries key on it, see MinionManager. */
    this.token = 0;

    /** Floor position lives on `root.position` (y carries the rise/sink). */
    this.hp = 0;
    /** This life's health ceiling — the boss multiplies it at spawn. */
    this.maxHp = 1;

    /** The two castes the director hands out: stand-off throwers and bosses. */
    this.isRanged = false;
    this.isBoss = false;

    /* --- dice, rolled at spawn --- */
    this._speedFactor = 1;
    this._bobPhase = 0;

    /* --- transient state --- */
    this.age = 0;
    this.flash = 0;
    this.stagger = 0;
    this.showTimer = 0;
    this.barAlpha = 0;
    /** Trailing bar ratio — where the health *was* a moment ago. */
    this.ghost = 1;
    this._knockX = 0;
    this._knockZ = 0;
    /** Separation, accumulated by the manager's pair pass each frame. */
    this.sepX = 0;
    this.sepZ = 0;

    /** The melee bite's own clock; a ranged body runs a bolt clock instead. */
    this._attackTimer = 0;
    /** Boss slam clock; <= windup means the telegraph is playing. */
    this._slamTimer = 0;

    /** The element this body is carrying, for the reaction system. */
    this.statusElement = null;
    this.statusTimer = 0;

    this._deadAge = 0;
    this._sinkAge = 0;
    this._sinking = false;
    this._vanish = false;
    this._fallAxis = new Vector3(1, 0, 0);

    this.root.visible = false;
  }

  get alive() {
    return this.phase !== MinionPhase.DYING;
  }

  get position() {
    return this.root.position;
  }

  /** 0..1 through its health. */
  get healthRatio() {
    return saturate(this.hp / Math.max(1, this.maxHp));
  }

  /** How wide this body is to the damage queries — the boss carries real girth. */
  get bodyRadius() {
    return settings.minions.bodyRadius * settings.minions.scale * (this.isBoss ? settings.minions.boss.scaleMult : 1);
  }

  /** Height its health bar rides at — above the head, whatever the caste. */
  get barLift() {
    return settings.minions.barLift * settings.minions.scale * (this.isBoss ? settings.minions.boss.scaleMult : 1);
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Begin a life. Must leave the instance fully reset — the pool hands out
   * whatever came back from a death.
   *
   * @param {number} x
   * @param {number} z
   * @param {{ranged?: boolean, boss?: boolean}} [caste] assigned by the director
   */
  spawn(x, z, { ranged = false, boss = false } = {}) {
    const c = settings.minions;
    this.token++;
    this.phase = MinionPhase.RISE;
    this.age = 0;
    this.isRanged = ranged && c.ranged.enabled;
    this.isBoss = boss;
    this.maxHp = c.health * (boss ? c.boss.healthMult : 1);
    this.hp = this.maxHp;

    this._speedFactor = 1 + (Math.random() * 2 - 1) * c.speedJitter;
    this._bobPhase = Math.random() * Math.PI * 2;

    this.flash = 0;
    this.stagger = 0;
    this.showTimer = 0;
    this.barAlpha = 0;
    this.ghost = 1;
    this._knockX = 0;
    this._knockZ = 0;
    this.sepX = 0;
    this.sepZ = 0;

    // The clocks stagger over their interval so a wave doesn't bite in unison.
    this._attackTimer = c.attack.interval * (0.5 + Math.random() * 0.7);
    this._slamTimer = c.boss.slamInterval;

    this.statusElement = null;
    this.statusTimer = 0;

    this._deadAge = 0;
    this._sinkAge = 0;
    this._sinking = false;
    this._vanish = false;

    this.root.position.set(x, -1.35 * c.scale, z);
    this.root.scale.setScalar(c.scale);
    const tx = this.manager.target.x - x;
    const tz = this.manager.target.z - z;
    this.root.rotation.y = Math.atan2(tx, tz);
    this.tilt.quaternion.identity();
    this.bodyPivot.position.set(0, 0, 0);
    this.bodyPivot.rotation.set(0, 0, 0);
    this.root.visible = true;
  }

  /**
   * Take a hit. `dirX/Z` is the unit direction of the blow (XZ) — the shove
   * and the topple both follow it. `element`, when given, feeds the reaction
   * system: a different element than the one this body is carrying detonates
   * a bonus and consumes the memory.
   *
   * @param {number} amount already scaled by the caller's falloff
   * @param {number} dirX
   * @param {number} dirZ
   * @param {string} [element] the striking cast's element id
   */
  applyDamage(amount, dirX = 0, dirZ = 0, element = null) {
    if (!this.alive) return;
    const c = settings.minions;

    // The hit sound rides the flash envelope: a fresh flash means this body
    // wasn't already mid-hit, which is what keeps a beam's DoT ticks from
    // turning into one long rattle.
    const fresh = this.flash <= 0.02;

    /* --- the reaction: a different element inside the window detonates --- */
    let incoming = amount;
    if (element && settings.reactions.enabled && this.statusElement && this.statusTimer > 0) {
      const reaction = reactionOf(this.statusElement, element);
      if (reaction) {
        incoming *= reaction.bonus;
        this.manager.reactionAt(this.position, reaction);
        this.statusElement = null; // consumed — one reaction per memory
      }
    } else if (element) {
      this.statusElement = element;
      this.statusTimer = settings.reactions.window;
    }

    const crit = Math.random() < c.critChance;
    this.hp = Math.max(0, this.hp - incoming * (crit ? c.critMultiplier : 1) * c.damageTaken);

    this.flash = 1;
    this.showTimer = c.barShowTime;
    // A boss shrugs off shoves — the slam has to land where it landed.
    const brace = this.isBoss ? 0.12 : 1;
    const shove = c.knockback * (crit ? 1.5 : 1) * brace;
    this._knockX += dirX * shove;
    this._knockZ += dirZ * shove;
    this.stagger = Math.max(this.stagger, this.isBoss ? c.staggerTime * 0.3 : c.staggerTime);

    if (fresh) sfx.hit();
    if (this.hp <= 0) this._die(dirX, dirZ);
  }

  /** Toggle-off path: skip the topple, dissolve in place quickly. */
  vanish() {
    if (!this.alive) return;
    this._vanish = true;
    this.phase = MinionPhase.DYING;
    this._deadAge = 0;
    this._sinking = true; // straight to the sink
  }

  _die(dirX, dirZ) {
    this.phase = MinionPhase.DYING;
    this._deadAge = 0;
    this._sinking = false;

    // Tip along the blow: rotating about the horizontal axis perpendicular to
    // `dir` carries the top of the body that way. No blow — fall anywhere.
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-4) {
      _axis.set(dirZ / len, 0, -dirX / len);
    } else {
      const a = Math.random() * Math.PI * 2;
      _axis.set(Math.cos(a), 0, Math.sin(a));
    }
    // The topple plays on `tilt`, a child of the yawed root — carry the world
    // axis into root-local space so it tips the way the blow meant it to.
    _quat.setFromAxisAngle(_up, -this.root.rotation.y);
    this._fallAxis.copy(_axis).applyQuaternion(_quat).normalize();

    this.manager.onDeath(this);
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    const c = settings.minions;
    const target = this.manager.target;
    this.age += dt;

    // Decay the feedback envelopes, dead or alive.
    this.flash = Math.max(0, this.flash - c.flashDecay * dt);
    this.stagger = Math.max(0, this.stagger - dt);
    this.statusTimer = Math.max(0, this.statusTimer - dt);
    if (this.statusTimer <= 0) this.statusElement = null;
    const knockDecay = Math.exp(-7 * Math.max(dt, 1e-4));
    this._knockX *= knockDecay;
    this._knockZ *= knockDecay;

    switch (this.phase) {
      case MinionPhase.RISE: {
        const t = saturate(this.age / Math.max(0.05, c.riseTime));
        this.root.position.y = -1.35 * c.scale * (1 - Easing.outCubic(t));
        this._steer(dt, target, 0.35); // crawl forward while it surfaces
        if (t >= 1) {
          this.phase = MinionPhase.SEEK;
          this.age = 0;
        }
        break;
      }

      case MinionPhase.SEEK: {
        // A thrower stops at its own distance; the melee hold the circle.
        const hold = this.isRanged ? c.ranged.stop : c.attackRange;
        const dist = this._steer(dt, target, 1);
        if (dist <= hold) {
          this.phase = MinionPhase.CROWD;
          this.age = 0;
        }
        break;
      }

      case MinionPhase.CROWD: {
        // Mill about: keep the separation so the circle breathes, but stop
        // closing. Face the caster and idle — and, now that the player can
        // bleed, work through the attack clocks.
        this._separate(dt);
        this._integrate(dt, 0);
        this.root.rotation.y = this._turnToward(
          Math.atan2(target.x - this.root.position.x, target.z - this.root.position.z),
          dt
        );

        const dist = Math.hypot(target.x - this.root.position.x, target.z - this.root.position.z);

        if (this.isBoss) {
          this._updateSlam(dt, target, dist);
        } else if (this.isRanged) {
          this._updateThrowing(dt, target, dist);
        } else {
          this._updateBite(dt, target, dist);
        }
        break;
      }

      case MinionPhase.DYING: {
        this._updateDying(dt);
        break;
      }

      default:
        break;
    }

    this._updateBody(dt);
    this._updateBar(dt);
  }

  /* ------------------------------------------------------------------ */
  /* movement pieces                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Turn and walk toward `target`, knockback and separation included.
   * @returns {number} the remaining distance to the target
   */
  _steer(dt, target, speedScale) {
    const dx = target.x - this.root.position.x;
    const dz = target.z - this.root.position.z;
    const dist = Math.hypot(dx, dz);

    if (dist > 1e-4) {
      const nx = dx / dist;
      const nz = dz / dist;
      const c = settings.minions;
      const speed =
        c.moveSpeed *
        (this.isBoss ? c.boss.speedMult : 1) *
        this._speedFactor *
        speedScale *
        (this.stagger > 0 ? 0.3 : 1);
      this._integrate(dt, speed);
      this.root.rotation.y = this._turnToward(Math.atan2(nx, nz), dt);
    } else {
      this._integrate(dt, 0);
    }

    return dist;
  }

  /** Position += (walk + separation + knockback) — one place, once per frame. */
  _integrate(dt, speed) {
    this.root.position.x += (speed * Math.sin(this.root.rotation.y) + this.sepX + this._knockX) * dt;
    this.root.position.z += (speed * Math.cos(this.root.rotation.y) + this.sepZ + this._knockZ) * dt;
  }

  _separate(dt) {
    this.root.position.x += (this.sepX + this._knockX) * dt;
    this.root.position.z += (this.sepZ + this._knockZ) * dt;
  }

  /* ------------------------------------------------------------------ */
  /* their answer: three attack clocks                                   */
  /* ------------------------------------------------------------------ */

  /**
   * The melee bite: wind up (a visible lunge on the body pivot), then land it
   * if the player is still in reach. The clock runs only while touching, so
   * leaving the circle genuinely resets the threat.
   */
  _updateBite(dt, target, dist) {
    const c = settings.minions;
    const reach = c.attackRange + c.attack.reach;
    if (dist > reach) {
      // Out of range: wind the clock back toward its interval so re-engaging
      // is never an instant bite.
      this._attackTimer = Math.max(this._attackTimer, c.attack.interval * 0.35);
      return;
    }

    this._attackTimer -= dt;
    if (this._attackTimer <= 0) {
      this._attackTimer = c.attack.interval;
      const dx = (target.x - this.root.position.x) / (dist || 1);
      const dz = (target.z - this.root.position.z) / (dist || 1);
      this.manager.attackPlayer(this, c.attack.damage, dx, dz);
    }
  }

  /**
   * The thrower: hold at its distance and lob bolts on a clock. It never
   * bites — its whole threat is the ball it keeps tossing from safety.
   */
  _updateThrowing(dt, target, dist) {
    const c = settings.minions;
    if (!c.ranged.enabled) return;

    this._boltTimer = (this._boltTimer ?? c.ranged.interval * Math.random()) - dt;
    if (this._boltTimer <= 0) {
      this._boltTimer = c.ranged.interval;
      this.manager.fireBolt(this);
    }
  }

  /**
   * The boss slam: a slow clock, a visible inflate as the telegraph, then a
   * shockwave that punishes standing inside the ring. The landing shakes the
   * camera whether or not the player was caught in it — the ground is the
   * event, not the damage.
   */
  _updateSlam(dt, target, dist) {
    const c = settings.minions;
    this._slamTimer -= dt;

    if (this._slamTimer <= 0) {
      this._slamTimer = c.boss.slamInterval;
      const dx = (target.x - this.root.position.x) / (dist || 1);
      const dz = (target.z - this.root.position.z) / (dist || 1);
      this.manager.bossSlam(this, dx, dz);
    }
  }

  /** Clamp-angular-velocity heading, shortest way round. */
  _turnToward(yaw, dt) {
    const delta = MathUtils.euclideanModulo(yaw - this.root.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    const step = Math.min(Math.abs(delta), settings.minions.turnRate * Math.max(dt, 0)) * Math.sign(delta);
    return this.root.rotation.y + step;
  }

  /* ------------------------------------------------------------------ */
  /* presentation                                                        */
  /* ------------------------------------------------------------------ */

  /** The walk bob, the waddle, the breathing, the hit-flash — and the attack tells. */
  _updateBody(dt) {
    const c = settings.minions;
    this.root.scale.setScalar(c.scale * (this.isBoss ? c.boss.scaleMult : 1));

    if (this.alive) {
      const moving = this.phase === MinionPhase.SEEK ? 1 : 0.25;
      const t = this.age * c.bobSpeed + this._bobPhase;
      this.bodyPivot.position.y = Math.abs(Math.sin(t)) * c.bobHeight * moving;
      this.bodyPivot.rotation.z = Math.sin(t * 0.5) * c.waddle * moving;

      // The bite's tell: a lean out and back during the last `windup` of the
      // clock. It's the one frame of fairness the player gets.
      this.bodyPivot.position.z = 0;
      if (!this.isBoss && !this.isRanged && this._attackTimer < c.attack.windup) {
        const p = 1 - this._attackTimer / Math.max(0.01, c.attack.windup);
        this.bodyPivot.position.z = Math.sin(p * Math.PI) * 0.24;
      }

      // The slam's tell: the whole body swells as the clock runs out.
      const breath = 1 + (this.phase === MinionPhase.CROWD ? 0.035 : 0.015) * Math.sin(t * 0.4);
      let inflate = 1;
      if (this.isBoss && this._slamTimer < c.boss.slamWindup) {
        inflate = 1 + 0.42 * (1 - this._slamTimer / Math.max(0.01, c.boss.slamWindup));
      }
      this.bodyPivot.scale.set(inflate, breath * inflate, inflate);
    }

    // The clones made at construction do not follow the base material, so the
    // live look rides on every minion each frame. Castes tint the body so a
    // thrower or a boss reads before it acts.
    this.bodyMaterial.color.copy(this.manager.bodyColor);
    if (this.isRanged) this.bodyMaterial.color.lerp(this.manager.rangedColor, 0.55);
    else if (this.isBoss) this.bodyMaterial.color.lerp(this.manager.bossColor, 0.6);
    this.bodyMaterial.emissive.copy(this.manager.flashColor);
    this.bodyMaterial.emissiveIntensity = this.flash * 2.6;
    this.bodyMaterial.roughness = c.roughness;
  }

  /** Health-bar alpha: up after a hit, gone again when the timer runs out. */
  _updateBar(dt) {
    const c = settings.minions;
    this.showTimer = Math.max(0, this.showTimer - dt);
    const target = this.alive ? (this.showTimer > 0 ? 1 : 0) : 0;
    const rate = this.alive ? 8 : 14;
    this.barAlpha += (target - this.barAlpha) * Math.min(1, rate * Math.max(dt, 0));

    // The white trailing segment chases the fill down instead of tracking it.
    const ratio = this.healthRatio;
    this.ghost += (ratio - this.ghost) * Math.min(1, 3.2 * Math.max(dt, 0));
  }

  /* ------------------------------------------------------------------ */

  _updateDying(dt) {
    const c = settings.minions;

    if (!this._sinking) {
      this._deadAge += dt;
      const t = saturate(this._deadAge / Math.max(0.05, c.fallTime));
      // Topple around the feet: `tilt` sits at floor level on the root.
      this.tilt.quaternion.setFromAxisAngle(this._fallAxis, Easing.inQuad(t) * Math.PI * 0.48);
      if (this._deadAge >= c.fallTime + c.deadPause) {
        this._sinking = true;
        this._sinkAge = 0;
      }
      return;
    }

    // Withdraw into the floor; the opaque ground does the hiding, so no
    // transparency is needed and no sort order is risked.
    this._sinkAge += dt;
    const rate = this._vanish ? 2.2 : 1;
    const depth = 1.4 * c.scale;
    this.root.position.y = -depth * saturate((this._sinkAge * rate) / Math.max(0.05, c.sinkTime));
    if (this._sinkAge * rate >= c.sinkTime) this.manager.recycle(this);
  }

  /** Back to the pool. Must leave the instance reusable. */
  destroy() {
    this.root.visible = false;
    this.phase = MinionPhase.RISE;
  }

  /** Free GPU resources (app teardown only — geometry is shared, keep it). */
  dispose() {
    this.bodyMaterial.dispose();
    this.root.removeFromParent();
  }
}
