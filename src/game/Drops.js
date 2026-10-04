import { AdditiveBlending, Color, Group, IcosahedronGeometry, Mesh, MeshBasicMaterial, OctahedronGeometry } from 'three';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { sfx } from '../audio/Sound.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate } from '../utils/math.js';

const _gold = new Color();
const _heal = new Color();

/**
 * What the swarm leaves behind: gold coins and the occasional heal orb.
 *
 * The floor reads as an economy the moment coins exist on it, so the objects
 * are deliberately humble — one octahedron spinning on a shared additive
 * material, one icosahedron for the heal — pooled and recycled like every
 * other body in the scene. Coins magnetise: inside `magnetRadius` they stop
 * being floor decoration and start accelerating toward the player, which is
 * the small dopamine loop that makes walking over to where a minion died
 * feel like a decision.
 *
 * The boss pays `bossGoldMult` coins worth the whole wave, flung in a ring —
 * the one moment the magnet gets to work hard.
 */
const MAX_ITEMS = 96;

export class Drops {
  /**
   * @param {import('three').Scene} scene
   * @param {import('../particles/ParticleEngine.js').ParticleEngine} particles
   */
  constructor(scene, particles) {
    this.scene = scene;
    this.particles = particles;

    this.root = new Group();
    this.root.name = 'Drops';
    scene.add(this.root);

    const coinGeo = new OctahedronGeometry(0.16, 0);
    coinGeo.scale(1, 1.35, 0.45);
    const healGeo = new IcosahedronGeometry(0.17, 0);

    this.coinMaterial = new MeshBasicMaterial({
      color: getColor(settings.drops.colorGold),
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false
    });
    this.healMaterial = new MeshBasicMaterial({
      color: getColor(settings.drops.colorHeal),
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false
    });

    /** @type {{mesh: Mesh, heal: boolean, worth: number, age: number, life: number, vx: number, vz: number, active: boolean}[]} */
    this.items = [];
    this._free = [];

    for (let i = 0; i < MAX_ITEMS; i++) {
      const mesh = new Mesh(coinGeo, this.coinMaterial);
      mesh.layers.set(LAYER.VFX);
      mesh.visible = false;
      this.root.add(mesh);
      const item = { mesh, heal: false, worth: 1, age: 0, life: 0, vx: 0, vz: 0, active: false };
      this.items.push(item);
      this._free.push(item);
    }

    /** One sparkle system serves coins and orbs alike. */
    this._sparkle = null;
    this._emit = {};
  }

  get gold() {
    return settings.progression.gold;
  }

  /**
   * Shed loot where a minion fell. Bosses fling a ring of coins worth a whole
   * wave; everyone else rolls a heal orb against `healChance`, else gold.
   *
   * @param {import('three').Vector3} position
   * @param {boolean} [boss]
   */
  drop(position, boss = false) {
    const c = settings.drops;
    if (!c.enabled) return;

    if (boss) {
      const count = 10;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
        this._spawnCoin(
          position.x + Math.cos(angle) * (0.6 + Math.random() * 0.5),
          position.z + Math.sin(angle) * (0.6 + Math.random() * 0.5),
          6
        );
      }
      return;
    }

    if (Math.random() < c.healChance) {
      this._spawnHeal(position.x, position.z);
      return;
    }

    const worth = c.goldMin + Math.floor(Math.random() * (c.goldMax - c.goldMin + 1));
    this._spawnCoin(position.x, position.z, worth);
  }

  _acquire(heal) {
    const item = this._free.pop();
    if (!item) return null;
    item.heal = heal;
    item.active = true;
    item.age = 0;
    item.life = settings.drops.goldLife * (0.9 + Math.random() * 0.2);
    item.vx = (Math.random() * 2 - 1) * 1.6;
    item.vz = (Math.random() * 2 - 1) * 1.6;
    item.mesh.material = heal ? this.healMaterial : this.coinMaterial;
    item.mesh.visible = true;
    this.items.push(item);
    return item;
  }

  _spawnCoin(x, z, worth) {
    const item = this._acquire(false);
    if (!item) return;
    item.worth = worth;
    item.mesh.position.set(x, 0.25, z);
    item.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  }

  _spawnHeal(x, z) {
    const item = this._acquire(true);
    if (!item) return;
    item.worth = settings.drops.healAmount;
    item.mesh.position.set(x, 0.3, z);
  }

  /**
   * Ride, magnetise, bank, expire.
   *
   * @param {number} dt
   * @param {import('./Player.js').Player} player
   * @param {import('three').Vector3} playerPos the character's live position
   */
  update(dt, player, playerPos) {
    const c = settings.drops;
    this.root.visible = this.items.length > 0;
    if (!this.items.length || dt <= 0) return;

    _gold.copy(getColor(c.colorGold));
    _heal.copy(getColor(c.colorHeal));
    this.coinMaterial.color.copy(_gold);
    this.healMaterial.color.copy(_heal);

    const magnet = player.magnetRadius;
    const pickup = c.pickupRadius;
    const t = frame.uTime.value;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.age += dt;

      // Coins skid a little where they land before settling into the spin.
      const settle = Math.max(0, 1 - item.age * 2.2);
      item.mesh.position.x += item.vx * settle * dt;
      item.mesh.position.z += item.vz * settle * dt;

      const pos = item.mesh.position;
      const dx = pos.x - playerPos.x;
      const dz = pos.z - playerPos.z;
      const dist = Math.hypot(dx, dz);

      let taken = false;
      if (player.alive && dist < magnet) {
        // Inside the magnet the item stops being floor loot and accelerates
        // toward the purse — stronger the deeper into the field it gets.
        const pull = (1 - saturate(dist / magnet)) * 22 + 3;
        pos.x -= (dx / (dist || 1)) * pull * dt;
        pos.z -= (dz / (dist || 1)) * pull * dt;

        if (dist < pickup) {
          if (item.heal) {
            if (player.heal(item.worth) > 0) sfx.heal();
            else sfx.pickup();
          } else {
            player.addGold(item.worth);
            sfx.pickup();
          }
          this._sparkleAt(pos, item.heal);
          taken = true;
        }
      }

      if (!taken) {
        // The ride and the spin — cheap, and it is what says "pickup".
        pos.y = 0.26 + Math.sin(t * c.bobSpeed + item.age * 1.7) * c.bobHeight;
        item.mesh.rotation.y += dt * 2.6;
        if (item.heal) item.mesh.rotation.x += dt * 1.8;

        if (item.age >= item.life) {
          // Expire: sink into the floor rather than pop out.
          const sink = saturate((item.age - item.life) / 0.5);
          pos.y -= sink * 0.5;
          item.mesh.scale.setScalar(Math.max(0.001, 1 - sink));
          if (sink >= 1) taken = true;
        } else {
          item.mesh.scale.setScalar(1);
        }
      }

      if (taken) {
        item.active = false;
        item.mesh.visible = false;
        item.mesh.scale.setScalar(1);
        this.items.splice(i, 1);
        this._free.push(item);
      }
    }
  }

  _sparkleAt(position, heal) {
    if (!this._sparkle) {
      this._sparkle = this.particles.get('drops.sparkle', {
        capacity: 120,
        shape: ParticleShape.SPARK,
        additive: true,
        softFade: 0.4
      });
      this._sparkle.uniforms.uFadeIn.value = 0.02;
      this._sparkle.uniforms.uFadeOut.value = 0.3;
      this._sparkle.setGradient(new Color('#fff4d6'), new Color('#ffd75f'), new Color('#ff9d4d'), new Color('#42200a'));
    }
    if (heal) this._sparkle.setGradient(new Color('#eafff2'), new Color('#6dff9e'), new Color('#2fd47a'), new Color('#0a2416'));

    const emit = this._emit;
    emit.position = position;
    emit.radius = 0.22;
    emit.speed = 2.4;
    emit.speedVariance = 0.8;
    emit.spread = 1.0;
    emit.size = 0.3;
    emit.sizeVariance = 0.2;
    emit.life = 0.4;
    emit.lifeVariance = 0.15;
    emit.time = frame.uTime.value;
    this._sparkle.emit(8, emit);
  }

  /** Everything on the floor goes back (restart, clear). */
  clear() {
    for (const item of this.items) {
      item.active = false;
      item.mesh.visible = false;
      this._free.push(item);
    }
    this.items.length = 0;
  }

  dispose() {
    this.clear();
    for (const item of this._free) item.mesh.removeFromParent();
    this.coinMaterial.dispose();
    this.healMaterial.dispose();
    this.root.removeFromParent();
  }
}
