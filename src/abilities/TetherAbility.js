import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  SphereGeometry,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { HoldAbility, HoldPhase } from './HoldAbility.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { frame } from '../core/FrameUniforms.js';
import { sfx } from '../audio/Sound.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';

const _up = new Vector3(0, 1, 0);
const _hand = new Vector3();
const _end = new Vector3();
const _dir = new Vector3();
const _a = new Vector3();
const _c = new Color();
const _d = new Color();
const _e = new Color();

/**
 * The sheath: ionised air around the core, displaced by a travelling wobble
 * that grows toward the far end (the hand is steady, the anchor is where the
 * chaos lives) and broken up by scrolling noise so it reads as current rather
 * than as a tube.
 */
const SHEATH_VERTEX = /* glsl */ `
  uniform float uAge;
  uniform float uWobble;
  uniform float uSpeed;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 pos = position;
    float w =
      sin(uv.y * 18.0 - uAge * uSpeed) * 0.5 +
      sin(uv.y * 7.0 + uAge * uSpeed * 0.63) * 0.5;
    pos.x += w * uWobble * uv.y;
    pos.z += w * uWobble * uv.y * 0.8;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const SHEATH_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAge;
  uniform float uNoise;
  uniform float uOpacity;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    float n = noise(vec2(vUv.x * 6.0, vUv.y * 10.0 - uAge * 3.0));
    float alpha = (0.3 + 0.7 * n) * mix(1.0, n, uNoise);
    // Fade the lips so the tube does not show hard caps at hand and anchor.
    alpha *= smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.94, vUv.y);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColor * uOpacity, alpha * uOpacity);
  }
`;

/**
 * N — 雷光锁链. The channel: hold the button and an arc of lightning stays
 * welded from the caster's hand to whatever point the cursor is over,
 * following it for as long as it stays down. Damage is a fast tick along the
 * line — no travel time, no footprint, a steering wheel rather than a shot —
 * and every tick is what feeds the reaction system.
 *
 * The beam is two tubes (a white-hot core inside a noisy sheath) stretched
 * between hand and anchor each frame; the anchor is a pulsing ball of
 * lightning that sheds sparks. Release snaps the arc with a small discharge.
 */
export class TetherAbility extends HoldAbility {
  /** The pool constructs with the shared context only; the element is fixed. */
  constructor(context) {
    super('tether', context);
  }

  createEffects() {
    const c = this.config;

    this.beam = new Vector3();

    /* --- the core: straight, white, confident --- */
    this.coreMaterial = new MeshBasicMaterial({
      color: getColor(c.colorCore).clone(),
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false
    });
    this.core = new Mesh(new CylinderGeometry(1, 1, 1, 8, 1, true), this.coreMaterial);
    this.core.visible = false;

    /* --- the sheath: the living part --- */
    this.sheathMaterial = new ShaderMaterial({
      vertexShader: SHEATH_VERTEX,
      fragmentShader: SHEATH_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uAge: { value: 0 },
        uWobble: { value: c.wobble },
        uSpeed: { value: c.wobbleSpeed },
        uNoise: { value: c.noise },
        uColor: { value: getColor(c.colorSheath).clone() },
        uOpacity: { value: 1 }
      }
    });
    this.sheath = new Mesh(new CylinderGeometry(1, 1, 1, 10, 24, true), this.sheathMaterial);
    this.sheath.visible = false;

    // Both tubes live in one group so one transform points them all; the radii
    // are per-mesh scales against a unit-radius cylinder.
    this.arc = new Vector3();
    this.beamGroup = new Group();
    this.beamGroup.add(this.core, this.sheath);
    this.group.add(this.beamGroup);

    /* --- the anchor: the ball of lightning at the far end --- */
    this.anchorMaterial = new MeshBasicMaterial({
      color: getColor(c.colorAnchor).clone(),
      transparent: true,
      opacity: 0.85,
      blending: AdditiveBlending,
      depthWrite: false
    });
    this.anchor = new Mesh(new SphereGeometry(1, 14, 10), this.anchorMaterial);
    this.anchor.visible = false;
    this.group.add(this.anchor);

    /* --- sparks at the anchor and along the span --- */
    this._spark = this.ctx.particles.get('tether.spark', {
      capacity: 500,
      shape: ParticleShape.SPARK,
      additive: true,
      softFade: 0.4
    });
    this._spark.uniforms.uFadeIn.value = 0.015;
    this._spark.uniforms.uFadeOut.value = 0.22;
    this._spark.setGradient(
      getColor(c.colorCore).clone(),
      getColor(c.colorSheath).clone(),
      getColor(c.colorSheath).clone().multiplyScalar(0.55),
      new Color(0x0c1401)
    );

    this._emit = {};
    this._tickTimer = 0;
  }

  /* ------------------------------------------------------------------ */

  onBegin() {
    this.core.visible = true;
    this.sheath.visible = true;
    this.anchor.visible = true;
    this.coreMaterial.opacity = 0.9;
    this.sheathMaterial.uniforms.uOpacity.value = 1;
    this._tickTimer = 0;
  }

  onHold(dt) {
    const c = this.config;
    const u = this.sheathMaterial.uniforms;
    // Live settings: the editor reshapes the arc mid-channel, paused included.
    u.uAge.value = frame.uTime.value;
    u.uWobble.value = c.wobble;
    u.uSpeed.value = c.wobbleSpeed;
    u.uNoise.value = c.noise;
    u.uColor.value.copy(getColor(c.colorSheath));
    this.coreMaterial.color.copy(getColor(c.colorCore));
    this.anchorMaterial.color.copy(getColor(c.colorAnchor));

    // Hand to anchor: the arc hangs from the casting hand, not the feet.
    _hand.set(this.origin.x, 1.25, this.origin.z);
    _end.set(this.target.x, 0.15, this.target.z);
    _dir.copy(_end).sub(_hand);
    const length = Math.max(0.1, _dir.length());
    _dir.multiplyScalar(1 / length);

    this.beamGroup.position.copy(_hand).addScaledVector(_dir, length * 0.5);
    this.beamGroup.quaternion.setFromUnitVectors(_up, _dir);
    this.beamGroup.scale.set(1, length, 1);
    this.core.scale.set(c.coreRadius, 1, c.coreRadius);
    this.sheath.scale.set(c.sheathRadius, 1, c.sheathRadius);
    this.beamGroup.updateMatrix();

    this.anchor.position.set(this.target.x, 0.35, this.target.z);
    const pulse = c.anchorRadius * (1 + 0.16 * Math.sin(frame.uTime.value * c.anchorPulse * 3.0));
    this.anchor.scale.setScalar(pulse);
    this.anchor.updateMatrix();

    /* --- the ticks: the whole point of the channel --- */
    this._tickTimer -= dt;
    if (this._tickTimer <= 0) {
      this._tickTimer = c.tickInterval;
      _a.set(this.origin.x, 0, this.origin.z);
      this.ctx.minions?.damageSegment(_a, this.target, c.hitWidth, c.tickDamage, {
        element: this.element
      });
      sfx.channelTick();
    }

    /* --- sparks: the anchor sheds, the span spits --- */
    const emit = this._emit;
    emit.radius = c.anchorRadius * 0.9;
    emit.direction = _dir.set(0, 1, 0);
    emit.speed = 3.2;
    emit.speedVariance = 1.6;
    emit.spread = 1.0;
    emit.size = 0.3;
    emit.sizeVariance = 0.18;
    emit.life = 0.3;
    emit.lifeVariance = 0.12;
    emit.spin = 3.0;
    emit.time = frame.uTime.value;
    emit.position = _a.set(this.target.x, 0.35, this.target.z);
    this._spark.emit(2, emit);

    // One spark at a random point of the span — the arc spits as it carries.
    const t = 0.15 + Math.random() * 0.75;
    emit.position = _a.copy(_hand).addScaledVector(
      _dir.copy(_end).sub(_hand).normalize(),
      length * t
    );
    emit.radius = c.sheathRadius;
    this._spark.emit(1, emit);
  }

  onRelease() {
    const c = this.config;

    // The snap: a small storm shell where the anchor stood, and a last flurry.
    _c.copy(getColor(c.colorCore));
    _d.copy(getColor(c.colorSheath));
    this.ctx.bursts?.spawn(BurstMode.STORM, this.target, {
      radius: 0.35,
      endRadius: 1.6,
      life: 0.5,
      intensity: 1.1,
      fresnel: 1.6,
      displace: 0.7,
      colorA: _c,
      colorB: _d,
      squash: 0.7
    });
    const emit = this._emit;
    emit.position = _a.set(this.target.x, 0.35, this.target.z);
    emit.radius = 0.6;
    emit.direction = _dir.set(0, 1, 0);
    emit.speed = 7;
    emit.speedVariance = 2;
    emit.spread = 1.0;
    emit.size = 0.32;
    emit.sizeVariance = 0.15;
    emit.life = 0.4;
    emit.lifeVariance = 0.15;
    emit.spin = 3.0;
    emit.time = frame.uTime.value;
    this._spark.emit(12, emit);
    this.ctx.shake?.add(0.12, 2.4, 20);
  }

  onReleaseUpdate(dt) {
    const t = saturate(this.releaseTime / this.releaseDuration);
    // The arc whips away: it shrinks toward the hand and fades as it goes.
    const fade = 1 - t;
    this.coreMaterial.opacity = 0.9 * fade;
    this.sheathMaterial.uniforms.uOpacity.value = fade;
    this.anchorMaterial.opacity = 0.85 * fade;
    this.beamGroup.scale.y = Math.max(0.05, this.beamGroup.scale.y * (1 - 6 * dt));
    this.anchor.scale.setScalar(Math.max(0.02, this.anchor.scale.x * (1 - 5 * dt)));
    if (t >= 1) {
      this.core.visible = false;
      this.sheath.visible = false;
      this.anchor.visible = false;
    }
  }

  get releaseDuration() {
    return 0.45;
  }

  /** The light splits its time: brighter while the channel feeds. */
  lightScale() {
    return this.phase === HoldPhase.HOLD ? 1 : 0.4;
  }

  onDestroy() {}
}
