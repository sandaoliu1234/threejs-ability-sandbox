import { Color, Group, Vector3 } from 'three';
import { settings } from '../config/settings.js';
import { saturate } from '../utils/math.js';
import { getColor } from '../utils/color.js';
import { LAYER } from '../core/Layers.js';

export const HoldPhase = Object.freeze({
  IDLE: 'idle',
  HOLD: 'hold',
  RELEASE: 'release',
  DONE: 'done'
});

/**
 * Base for the two **hold** abilities — the mechanics that live on the length
 * of a mouse press rather than in the instant of a click.
 *
 * The click casts extend `Ability`, whose whole shape is a front travelling
 * down a line; a charge and a channel share none of that. What they *do*
 * share is each other: both begin on `holdstart` with the cursor's ground
 * point, both follow the cursor while the button is down, both end on
 * release, and both ride the same light and pooling contracts as every other
 * cast. This base owns exactly that frame, and the pool treats the two of
 * them like any other element (`group`, `update`, `isFinished`, `destroy`).
 *
 * Subclasses implement: `createEffects`, `onBegin`, `onHold`, `onRelease`,
 * `onReleaseUpdate`, `onDestroy`, and `releaseDuration`.
 *
 * Phases:  HOLD — button is down, cursor steers
 *          RELEASE — the payoff plays itself out, then DONE recycles
 *
 * Pausing (dt = 0) freezes a hold mid-charge like every other clock here,
 * which is exactly the point of the sandbox.
 */
export class HoldAbility {
  /**
   * @param {string} element  key into `settings` ('implosion')
   * @param {object} context  shared systems (see AbilityManager)
   */
  constructor(element, context) {
    this.element = element;
    this.ctx = context;

    this.group = new Group();
    this.group.name = `Ability:${element}`;
    this.group.layers.set(LAYER.VFX);
    this.group.matrixAutoUpdate = false;

    this.phase = HoldPhase.IDLE;

    /** The caster's feet, on the floor. */
    this.origin = new Vector3();
    /** The point under the cursor, clamped to the ability's reach. */
    this.target = new Vector3();
    /** Flat unit heading origin → target. */
    this.direction = new Vector3(0, 0, 1);
    this.distance = 0;

    this.age = 0;
    /** Seconds the button has been down; the charge slider's raw value. */
    this.charge = 0;
    this.releaseTime = 0;

    /**
     * The camera frames the most recent active cast through `position` and
     * `u` (see `AbilityManager#focus` and `App#frame`), and the hold plays by
     * the same contract: `position` mirrors the live target point, `u` rides
     * the charge so a maturing singularity pulls the camera in.
     */
    this.position = new Vector3();
    this.u = 0;

    this.light = null;
    this.lightColor = new Color();
    /** Transient additive light punch. Decays on its own, as in `Ability`. */
    this.lightBoost = 0;

    /** Hit-once registry for the release burst's damage circle. */
    this.minionsHit = new Map();

    this.createEffects();
  }

  /** Live settings block for this element. */
  get config() {
    return settings[this.element];
  }

  get isActive() {
    return this.phase !== HoldPhase.IDLE && this.phase !== HoldPhase.DONE;
  }

  get isFinished() {
    return this.phase === HoldPhase.DONE;
  }

  /** Instanced geometry this cast is currently drawing. HUD readout only. */
  get instanceCount() {
    return 0;
  }

  /** 0..1 through the charge window. */
  get charge01() {
    return saturate(this.charge / Math.max(0.05, this.config.chargeMax ?? 1));
  }

  /** How long the payoff plays before the pool takes the body back. */
  get releaseDuration() {
    return 0.8;
  }

  /* ------------------------------------------------------------------ */
  /* subclass hooks                                                      */
  /* ------------------------------------------------------------------ */

  /** Build meshes/materials/particles once, at construction. */
  createEffects() {}

  /** First frame of the hold. */
  onBegin() {}

  /** Per-frame while the button is down. */
  onHold(_dt) {}

  /** One-shot the moment the button comes up. */
  onRelease() {}

  /** Per-frame through the payoff. */
  onReleaseUpdate(_dt) {}

  /** Release any per-cast resources (app teardown only). */
  onDestroy() {}

  /** Where the dynamic light sits this frame. Default: over the target. */
  lightPosition(out) {
    return out.copy(this.target).setY(1.2);
  }

  /** Per-frame multiplier on the light — a charge scales its own glow. */
  lightScale() {
    return 1;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle — driven by AimController's hold events via App           */
  /* ------------------------------------------------------------------ */

  beginHold(origin, direction, distance) {
    this.origin.copy(origin).setY(0);
    this.direction.copy(direction).setY(0).normalize();
    this.distance = Math.max(0.1, distance);
    this.target.copy(this.origin).addScaledVector(this.direction, this.distance);

    this.age = 0;
    this.charge = 0;
    this.releaseTime = 0;
    this.phase = HoldPhase.HOLD;
    this.minionsHit.clear();

    this.light = this.ctx.lights.acquire();
    this.group.visible = true;
    this.onBegin();
  }

  /** The cursor moved — re-aim the hold. Ignored once released. */
  setHoldTarget(origin, direction, distance) {
    if (this.phase !== HoldPhase.HOLD) return;
    this.origin.copy(origin).setY(0);
    this.direction.copy(direction).setY(0).normalize();
    this.distance = Math.max(0.1, distance);
    this.target.copy(this.origin).addScaledVector(this.direction, this.distance);
  }

  /** The button came up. */
  releaseHold() {
    if (this.phase !== HoldPhase.HOLD) return;
    this.phase = HoldPhase.RELEASE;
    this.releaseTime = 0;
    this.onRelease();
  }

  update(dt) {
    if (!this.isActive) return;
    this.age += dt;

    if (this.phase === HoldPhase.HOLD) {
      this.charge += dt;
      this.onHold(dt);
    } else {
      this.releaseTime += dt;
      this.onReleaseUpdate(dt);
      if (this.releaseTime >= this.releaseDuration) this.phase = HoldPhase.DONE;
    }

    // The camera-contract mirror: frame the target, weighted by the charge.
    this.position.copy(this.target);
    this.u = this.charge01;

    this._updateLight(dt);
  }

  /* ------------------------------------------------------------------ */

  _updateLight(dt) {
    if (!this.light) return;
    const cfg = this.config;
    this.lightColor.copy(getColor(cfg.lightColor));
    this.ctx.lights.set(
      this.light,
      this.lightPosition(this.target),
      this.lightColor,
      cfg.lightIntensity * this.lightScale() + this.lightBoost,
      cfg.lightRadius,
      dt
    );
    this.lightBoost = Math.max(0, this.lightBoost - this.lightBoost * 4.5 * dt - 0.5 * dt);
  }

  /** Return to the pool. Must leave the instance reusable. */
  destroy() {
    this.onDestroy();
    this.ctx.lights.release(this.light);
    this.light = null;
    this.group.visible = false;
    this.phase = HoldPhase.IDLE;
  }

  dispose() {
    this.group.parent?.remove(this.group);
  }
}
