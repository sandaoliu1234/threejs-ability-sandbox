/**
 * The player: hit points, the purse and the shop, in one small state object.
 *
 * Everything numeric lives in `settings.player` and `settings.progression`
 * (so the editor can watch it), while this class owns the *state*: the current
 * hp, the invulnerability window after a hit, the dash clock and the four
 * upgrade levels the shop panel buys on T. Gold is just a number in settings —
 * the HUD reads it and the shop writes it — but the purchase rules (cost
 * curve, what vitality pays back) are gameplay, so they live here.
 *
 * App wires `onHurt` / `onDeath` to the presentation; damage from minions and
 * bolts all funnels through `damage()`, which is where the invulnerability
 * gate and the death transition are enforced.
 */
import { settings } from '../config/settings.js';
import { sfx } from '../audio/Sound.js';

/** The four shop tracks, in the order the panel lists them. */
export const SHOP_TRACKS = ['damage', 'cooldown', 'vitality', 'pace'];

export class Player {
  constructor() {
    /** Wired by App: presentation hooks. */
    this.onHurt = null; // (hpRatio) — drives the vignette
    this.onDeath = null;

    this._invuln = 0;
    this._sinceHit = Infinity;

    /* --- dash clock --- */
    this.dashTimeLeft = 0;
    this._dashCooldown = 0;
    /** Unit direction the dash is carrying the body, XZ. */
    this.dashDirX = 0;
    this.dashDirZ = 0;

    this.reset();
  }

  /* ------------------------------------------------------------------ */
  /* derived numbers — the shop's reach, resolved live                   */
  /* ------------------------------------------------------------------ */

  get maxHp() {
    const p = settings.progression;
    return settings.player.maxHp + p.vitalityPerLevel * p.vitalityLevel;
  }

  get hp() {
    return this._hp;
  }

  get alive() {
    return this._alive;
  }

  /** Multiplier every ability's damage rides through `MinionManager`. */
  get damageMult() {
    return 1 + settings.progression.damagePerLevel * settings.progression.damageLevel;
  }

  /** Multiplier on every ability's cooldown, floored so it never hits zero. */
  get cooldownMult() {
    return Math.max(0.35, 1 - settings.progression.cooldownPerLevel * settings.progression.cooldownLevel);
  }

  get moveSpeed() {
    return settings.player.moveSpeed * (1 + settings.progression.pacePerLevel * settings.progression.paceLevel);
  }

  /** The pickup magnet widens with pace, so one track buys two feelings. */
  get magnetRadius() {
    return settings.drops.magnetRadius * (1 + settings.progression.pacePerLevel * settings.progression.paceLevel);
  }

  /* ------------------------------------------------------------------ */

  reset() {
    this._hp = this.maxHp;
    this._alive = true;
    this._invuln = 0;
    this._sinceHit = Infinity;
    this.dashTimeLeft = 0;
    this._dashCooldown = 0;
  }

  /**
   * Take a hit. Returns whether it landed — while invulnerable the swing
   * passes through, which is what makes the dash feel like a dodge.
   *
   * @param {number} amount
   * @param {number} [dirX] blow direction, XZ, for the presentation
   * @param {number} [dirZ]
   */
  damage(amount, dirX = 0, dirZ = 0) {
    if (!this._alive || amount <= 0) return false;
    if (this._invuln > 0) return false;

    this._hp = Math.max(0, this._hp - amount);
    this._sinceHit = 0;
    this._invuln = settings.player.hurtInvuln;
    sfx.hurt();
    this.onHurt?.(this._hp / this.maxHp, dirX, dirZ);

    if (this._hp <= 0) {
      this._alive = false;
      this.onDeath?.();
    }
    return true;
  }

  /** Restore hp; returns how much was actually absorbed (an overheal wastes it). */
  heal(amount) {
    if (!this._alive || amount <= 0) return 0;
    const before = this._hp;
    this._hp = Math.min(this.maxHp, this._hp + amount);
    return this._hp - before;
  }

  addGold(n) {
    settings.progression.gold += n;
  }

  /** Price of the next level on a track: the curve bites by purchase three. */
  cost(track) {
    const level = settings.progression[`${track}Level`];
    return Math.round(settings.progression.baseCost * settings.progression.costGrowth ** level);
  }

  /**
   * Buy one level. Vitality pays its raise back immediately as a heal, so the
   * purchase is felt at once; the rest simply bend their multipliers.
   *
   * @param {string} track one of `SHOP_TRACKS`
   * @returns {boolean} whether the purchase went through
   */
  buy(track) {
    const p = settings.progression;
    const key = `${track}Level`;
    if (!(key in p)) return false;

    const price = this.cost(track);
    if (p.gold < price) return false;

    p.gold -= price;
    p[key] += 1;

    if (track === 'vitality') this._hp = Math.min(this.maxHp, this._hp + p.vitalityPerLevel);
    sfx.pickup();
    return true;
  }

  /**
   * Start a dash toward a unit XZ direction. Refused while cooling down or
   * dead; grants its invulnerability window on the way.
   *
   * @param {number} dirX
   * @param {number} dirZ
   */
  dash(dirX, dirZ) {
    if (!this._alive || this._dashCooldown > 0) return false;
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-4) return false;

    this.dashDirX = dirX / len;
    this.dashDirZ = dirZ / len;
    this.dashTimeLeft = settings.player.dashTime;
    this._dashCooldown = settings.player.dashCooldown;
    this._invuln = Math.max(this._invuln, settings.player.dashInvuln);
    sfx.dash();
    return true;
  }

  /** Seconds until the dash is ready again, for the HUD pip. */
  get dashCooldownLeft() {
    return this._dashCooldown;
  }

  update(dt) {
    this._invuln = Math.max(0, this._invuln - dt);
    this._dashCooldown = Math.max(0, this._dashCooldown - dt);
    this.dashTimeLeft = Math.max(0, this.dashTimeLeft - dt);

    if (this._alive) {
      this._sinceHit += dt;
      if (this._sinceHit >= settings.player.regenDelay && this._hp < this.maxHp) {
        this._hp = Math.min(this.maxHp, this._hp + settings.player.regen * dt);
      }
    }
  }
}
