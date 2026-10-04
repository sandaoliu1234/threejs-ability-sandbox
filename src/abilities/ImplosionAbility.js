import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { HoldAbility, HoldPhase } from './HoldAbility.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { DecalType } from '../effects/GroundDecals.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { frame } from '../core/FrameUniforms.js';
import { sfx } from '../audio/Sound.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate } from '../utils/math.js';

const _a = new Vector3();
const _b = new Vector3();
const _c = new Color();
const _d = new Color();
const _e = new Color();

const MARKER_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The charge marker: one ground quad whose fragment shader is all signed
 * distance, like the aim indicator it sits beside. The ring it draws is the
 * *live* answer to "how big is this going to be" — it swells with the charge,
 * dashes run around it faster the fuller it gets, and the interior washes
 * toward white as the power piles up.
 */
const MARKER_FRAGMENT = /* glsl */ `
  uniform float uAge;
  uniform float uRadius;   // metres, the live boundary
  uniform float uSize;     // metres, the full quad span
  uniform float uEdge;
  uniform float uTicks;
  uniform float uSpin;
  uniform float uFill;
  uniform float uCharge;   // 0..1
  uniform float uValid;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3 uColorCore;
  uniform vec3 uColorMid;
  uniform vec3 uColorInvalid;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv - 0.5;
    float d = length(p) * uSize;
    float angle = atan(p.y, p.x);

    // The swelling boundary, with dashes running around it — the spin speeds
    // up with the charge, so the marker itself reads as winding up.
    float ring = 1.0 - smoothstep(0.0, uEdge, abs(d - uRadius));
    float dashes = 0.6 + 0.4 * step(0.5, fract(angle / 6.28318 * uTicks + uAge * uSpin * (1.0 + uCharge * 2.0)));

    // Interior wash: brighter toward the rim, swirling faster as it fills.
    float inside = 1.0 - smoothstep(0.0, max(uRadius, 0.01), d);
    float swirl = 0.72 + 0.28 * sin(angle * 3.0 - uAge * (2.0 + uCharge * 7.0));
    float fill = inside * uFill * swirl * (0.35 + 0.65 * uCharge);

    // The core brightens as the singularity matures.
    float core = (1.0 - smoothstep(0.0, 0.3 + uCharge * 0.9, d)) * (0.35 + 0.65 * uCharge);

    vec3 col = mix(uColorMid, uColorCore, core);
    col = mix(col, uColorInvalid, (1.0 - uValid) * 0.8);

    float alpha = max(max(fill, core), ring * dashes);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col * uGlow * uOpacity, alpha * uOpacity);
  }
`;

/**
 * Z — 聚能奇点. The hold-to-charge: press, watch the circle at the cursor
 * swell while the air pours into it, release to collapse it. Radius, damage
 * and the shake all ride one slider — how long you held.
 *
 * Everything is generated from the shared services: the marker is an SDF
 * shader quad, the pull is two particle streams spiralling inward, the
 * collapse is one BurstSystem pressure shell plus a scorch decal tinted to
 * the element, and the boom arrives through the shake, which is where every
 * impact sound already lives.
 */
export class ImplosionAbility extends HoldAbility {
  /** The pool constructs with the shared context only; the element is fixed. */
  constructor(context) {
    super('implosion', context);
  }

  createEffects() {
    const c = this.config;

    /* --- the marker --- */
    this.markerSize = c.radiusMax * 2.6;
    this.markerMaterial = new ShaderMaterial({
      vertexShader: MARKER_VERTEX,
      fragmentShader: MARKER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      uniforms: {
        uAge: { value: 0 },
        uRadius: { value: c.radiusMin },
        uSize: { value: this.markerSize },
        uEdge: { value: c.markerEdge },
        uTicks: { value: c.markerTicks },
        uSpin: { value: c.markerSpin },
        uFill: { value: c.markerFill },
        uCharge: { value: 0 },
        uValid: { value: 1 },
        uOpacity: { value: 1 },
        uGlow: { value: c.markerGlow },
        uColorCore: { value: getColor(c.colorCore).clone() },
        uColorMid: { value: getColor(c.colorMid).clone() },
        uColorInvalid: { value: getColor(settings.aim.colorInvalid).clone() }
      }
    });
    this.marker = new Mesh(new PlaneGeometry(1, 1), this.markerMaterial);
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.scale.setScalar(this.markerSize);
    this.marker.renderOrder = 6;
    this.group.add(this.marker);

    /* --- the singularity itself, swelling at the point --- */
    this.orbMaterial = new MeshBasicMaterial({
      color: getColor(c.colorMid).clone(),
      transparent: true,
      opacity: 0.55,
      blending: AdditiveBlending,
      depthWrite: false
    });
    this.orb = new Mesh(new SphereGeometry(1, 16, 12), this.orbMaterial);
    this.orb.position.y = 0.55;
    this.group.add(this.orb);

    /* --- particles: the inflow, and the radiating release --- */
    this._pull = this.ctx.particles.get('implosion.pull', {
      capacity: 500,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this._pull.uniforms.uFadeIn.value = 0.08;
    this._pull.uniforms.uFadeOut.value = 0.4;
    this._pull.setGradient(
      getColor(c.colorCore).clone(),
      getColor(c.colorMid).clone(),
      getColor(c.colorEdge).clone().multiplyScalar(1.4),
      new Color(0x0d0212)
    );

    this._burstSparks = this.ctx.particles.get('implosion.burst', {
      capacity: 600,
      shape: ParticleShape.SPARK,
      additive: true,
      softFade: 0.35
    });
    this._burstSparks.uniforms.uFadeIn.value = 0.015;
    this._burstSparks.uniforms.uFadeOut.value = 0.3;
    this._burstSparks.setGradient(
      getColor(c.colorCore).clone(),
      getColor(c.colorMid).clone(),
      getColor(c.colorEdge).clone().multiplyScalar(1.6),
      new Color(0x180318)
    );

    this._emit = {};
    this.radius = c.radiusMin;
  }

  /* ------------------------------------------------------------------ */

  onBegin() {
    sfx.holdStart(this.element);
  }

  onHold(dt) {
    const c = this.config;
    const u = this.markerMaterial.uniforms;
    const k = this.charge01;

    this.radius = c.radiusMin + (c.radiusMax - c.radiusMin) * Easing.outQuad(k);

    // Every marker uniform rides settings, so the editor reshapes the charge
    // live — paused included, like every other clock in the sandbox.
    u.uAge.value = frame.uTime.value;
    u.uRadius.value = this.radius;
    u.uCharge.value = k;
    u.uValid.value = true;
    u.uEdge.value = c.markerEdge;
    u.uTicks.value = c.markerTicks;
    u.uSpin.value = c.markerSpin;
    u.uFill.value = c.markerFill;
    u.uGlow.value = c.markerGlow;

    this.marker.position.set(this.target.x, 0.045, this.target.z);
    this.marker.updateMatrix();

    // The singularity swallows the marker's interior as it matures.
    this.orb.position.set(this.target.x, 0.55, this.target.z);
    this.orb.scale.setScalar(0.22 + k * 1.5);
    this.orb.updateMatrix();
    this.orbMaterial.opacity = 0.35 + k * 0.45;

    /* --- the inflow: two streams spiralling in from opposite bearings --- */
    const emit = this._emit;
    emit.radius = 0.25;
    emit.speed = 6.5 + k * 5;
    emit.speedVariance = 1.2;
    emit.spread = 0.25;
    emit.size = 0.42;
    emit.sizeVariance = 0.3;
    emit.life = 0.5;
    emit.lifeVariance = 0.2;
    emit.spin = 2.0;
    emit.time = frame.uTime.value;

    const ring = this.radius * 1.2;
    const base = frame.uTime.value * 2.2;
    for (const offset of [0, Math.PI]) {
      const angle = base + offset;
      _a.set(this.target.x + Math.cos(angle) * ring, 0.2, this.target.z + Math.sin(angle) * ring);
      _b.set(-Math.cos(angle), 0.12, -Math.sin(angle));
      emit.position = _a;
      emit.direction = _b;
      this._pull.emit(3, emit);
    }

    // The orb sheds a little haze where it hangs.
    emit.position = _c.set(this.target.x, 0.5, this.target.z);
    emit.direction = _b.set(0, 1, 0);
    emit.radius = 0.35;
    emit.speed = 0.8;
    emit.size = 0.5;
    emit.life = 0.32;
    this._pull.emit(2, emit);

    this.lightBoost = k;
  }

  onRelease() {
    const c = this.config;
    const k = this.charge01;

    this.radius = c.radiusMin + (c.radiusMax - c.radiusMin) * Easing.outQuad(k);
    const damage = c.damageMin + (c.damageMax - c.damageMin) * k;

    this.ctx.minions?.damageCircle(this.target, this.radius, damage, {
      hitSet: this.minionsHit,
      element: this.element
    });

    /* --- the collapse: pressure shell, radiating sparks, scorched ground --- */
    _c.copy(getColor(c.colorCore));
    _d.copy(getColor(c.colorMid));
    _e.copy(getColor(c.colorEdge));
    this.ctx.bursts?.spawn(BurstMode.AIR, this.target, {
      radius: 0.6,
      endRadius: this.radius,
      life: c.burstLife,
      intensity: c.burstIntensity * (0.55 + k * 0.7),
      displace: c.displace,
      fresnel: 1.4,
      colorA: _c,
      colorB: _d,
      colorC: _e,
      squash: 0.4
    });

    const emit = this._emit;
    emit.radius = this.radius * 0.5;
    emit.direction = _b.set(0, 1, 0);
    emit.speed = 11 + k * 7;
    emit.speedVariance = 2.5;
    emit.spread = 1.0;
    emit.size = 0.4;
    emit.sizeVariance = 0.3;
    emit.life = 0.55;
    emit.lifeVariance = 0.25;
    emit.spin = 2.5;
    emit.time = frame.uTime.value;
    emit.position = _a.set(this.target.x, 0.3, this.target.z);
    this._burstSparks.emit(Math.round(16 + k * 26), emit);

    this.ctx.decals?.spawn(DecalType.SCORCH, this.target, {
      radius: this.radius * 0.7,
      life: 3.2,
      intensity: 1.1,
      colorA: _d,
      colorB: _e
    });

    this.ctx.shake?.add(0.2 + 0.5 * k, 2.1, 16);
    this.ctx.flash?.trigger(getColor(c.colorFlash), 0.35 + 0.55 * k);

    // The orb is gone the frame it collapses.
    this.orb.scale.setScalar(0.001);
  }

  onReleaseUpdate(dt) {
    const u = this.markerMaterial.uniforms;
    const t = saturate(this.releaseTime / this.releaseDuration);

    // The boundary blows outward one last time and fades with it.
    u.uAge.value = frame.uTime.value;
    u.uRadius.value = Easing.outCubic(t) * this.radius;
    u.uCharge.value = 1;
    u.uOpacity.value = 1 - t;
    this.marker.position.set(this.target.x, 0.045, this.target.z);
    this.marker.updateMatrix();
  }

  get releaseDuration() {
    return this.config.burstLife;
  }

  /** The light rides the charge, so the room darkens into the release. */
  lightScale() {
    return this.phase === HoldPhase.HOLD ? 0.35 + this.charge01 * 0.85 : 1.1;
  }

  onDestroy() {}
}
