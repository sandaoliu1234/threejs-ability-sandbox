import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';

/**
 * Every minion's health bar, drawn as **one instanced mesh** — one draw call
 * however many minions are on the floor.
 *
 * Each instance is a quad billboarded in the vertex shader from the view
 * matrix, pinned at `aCenter` (the minion's head). The bar itself is a rounded
 * rectangle evaluated in *metres* in the fragment shader — the same signed-
 * distance idiom the aim indicator uses — so every dimension is live: dragging
 * `barWidth` or `barRound` in the editor reshapes every bar on screen at once.
 *
 * Per instance the CPU writes four floats-and-a-point each frame:
 *
 *   aCenter — where the bar hangs
 *   aRatio  — current health fraction (the coloured fill)
 *   aGhost  — where the fill was a moment ago (the white trailing segment)
 *   aAlpha  — display fade (shown after a hit, distance fade, death fade)
 *
 * Full-health minions write `aAlpha = 0`, so the common case is one cheap
 * draw of invisible quads rather than any bookkeeping about which bars are up.
 */
const MAX_BARS = 48;

const BAR_VERTEX = /* glsl */ `
  attribute vec3 aCenter;
  attribute float aRatio;
  attribute float aGhost;
  attribute float aAlpha;

  uniform float uBarWidth;
  uniform float uBarHeight;
  uniform float uFadeDistance;

  varying vec2 vPoint;   // metres from the bar's centre
  varying float vRatio;
  varying float vGhost;
  varying float vAlpha;

  void main() {
    vRatio = aRatio;
    vGhost = aGhost;
    vAlpha = aAlpha;

    // Billboard from the view matrix basis, so no per-instance quaternion.
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 world = aCenter
      + right * position.x * uBarWidth
      + up * position.y * uBarHeight;

    vPoint = position.xy * vec2(uBarWidth, uBarHeight);

    // Fade with distance so a far swarm doesn't read as a band of noise.
    float dist = distance(cameraPosition, aCenter);
    vAlpha *= smoothstep(uFadeDistance, uFadeDistance * 0.55, dist);

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const BAR_FRAGMENT = /* glsl */ `
  uniform float uBarWidth;
  uniform float uBarHeight;
  uniform float uRound;      // corner radius, metres
  uniform float uEdgeWidth;  // rim thickness, metres
  uniform float uEdgeGlow;
  uniform vec3 uFill;
  uniform vec3 uBack;
  uniform vec3 uEdge;
  uniform vec3 uGhost;

  varying vec2 vPoint;
  varying float vRatio;
  varying float vGhost;
  varying float vAlpha;

  void main() {
    if (vAlpha < 0.004) discard;

    float halfW = uBarWidth * 0.5;
    float halfH = uBarHeight * 0.5;
    float round = min(uRound, halfH);

    // Rounded box, metres in, metres out.
    vec2 b = vec2(halfW - round, halfH - round);
    vec2 q = abs(vPoint) - b;
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - round;

    float aa = fwidth(sd) * 1.2;
    float body = 1.0 - smoothstep(-aa, aa, sd);
    if (body <= 0.0) discard;

    // Three horizontal layers: the dark back, the white trail where health
    // just was, and the fill. Boundaries measured from the left edge.
    float x = vPoint.x + halfW;
    float fillEdge = uBarWidth * vRatio;
    float ghostEdge = uBarWidth * max(vGhost, vRatio);
    float aaX = fwidth(x) * 1.2;

    float inFill = 1.0 - smoothstep(fillEdge - aaX, fillEdge + aaX, x);
    float inGhost = (1.0 - smoothstep(ghostEdge - aaX, ghostEdge + aaX, x)) * (1.0 - inFill);

    vec3 col = uBack;
    col = mix(col, uGhost, inGhost * 0.85);
    col = mix(col, uFill, inFill);

    // The rim, and the bloom it is allowed to push into.
    float rim = smoothstep(-uEdgeWidth, 0.0, sd) * (1.0 - smoothstep(0.0, aa, sd));
    col = mix(col, uEdge, rim * 0.85);

    float alpha = body * vAlpha;
    gl_FragColor = vec4(col * (1.0 + uEdgeGlow * rim), alpha);
  }
`;

export class HealthBars {
  constructor() {
    const geometry = new InstancedBufferGeometry();
    // Unit quad: position.xy feeds the billboard, uv is unused (SDF in metres).
    // `position` is per-vertex; the a* attributes below are per-instance.
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3)
    );
    geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this.centerData = new Float32Array(MAX_BARS * 3);
    this.ratioData = new Float32Array(MAX_BARS);
    this.ghostData = new Float32Array(MAX_BARS);
    this.alphaData = new Float32Array(MAX_BARS);

    // Per-instance data has to be InstancedBufferAttribute — a plain
    // BufferAttribute inside an instanced draw is read with a wrong stride and
    // every bar lands somewhere nonsensical.
    const bind = (array, itemSize) =>
      new InstancedBufferAttribute(array, itemSize).setUsage(DynamicDrawUsage);
    geometry.setAttribute('aCenter', bind(this.centerData, 3));
    geometry.setAttribute('aRatio', bind(this.ratioData, 1));
    geometry.setAttribute('aGhost', bind(this.ghostData, 1));
    geometry.setAttribute('aAlpha', bind(this.alphaData, 1));
    // Capacity from the start: the shader compiles during the loading veil's
    // warm draw even before the first minion is alive.
    geometry.instanceCount = MAX_BARS;
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      vertexShader: BAR_VERTEX,
      fragmentShader: BAR_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: NormalBlending,
      toneMapped: false,
      uniforms: {
        uBarWidth: { value: 0.85 },
        uBarHeight: { value: 0.085 },
        uFadeDistance: { value: 36 },
        uRound: { value: 0.045 },
        uEdgeWidth: { value: 0.004 },
        uEdgeGlow: { value: 1.1 },
        // Real colours from the start: the loading-veil warm draw renders this
        // material before the first `sync` has ever run, and a null uniform
        // would throw inside the uploader.
        uFill: { value: getColor(settings.minions.colorBarFill).clone() },
        uBack: { value: getColor(settings.minions.colorBarBack).clone() },
        uEdge: { value: getColor(settings.minions.colorBarEdge).clone() },
        uGhost: { value: getColor(settings.minions.colorBarGhost).clone() }
      }
    });
    this.uniforms = this.material.uniforms;

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14; // over the ability VFX — bars are readouts
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.name = 'MinionHealthBars';
  }

  /**
   * Push one frame of bar data. `minions` is the manager's active list — the
   * dead ones at the tail write themselves out as they fade.
   *
   * @param {import('./Minion.js').Minion[]} minions
   */
  sync(minions) {
    const c = settings.minions;
    const u = this.uniforms;
    u.uBarWidth.value = c.barWidth;
    u.uBarHeight.value = c.barHeight;
    u.uFadeDistance.value = c.barFadeDistance;
    u.uRound.value = c.barRound * c.barHeight;
    u.uEdgeWidth.value = c.barEdge * c.barHeight;
    u.uEdgeGlow.value = c.barEdgeGlow;
    u.uFill.value.copy(getColor(c.colorBarFill));
    u.uBack.value.copy(getColor(c.colorBarBack));
    u.uEdge.value.copy(getColor(c.colorBarEdge));
    u.uGhost.value.copy(getColor(c.colorBarGhost));

    const lift = c.barLift * c.scale;
    let n = 0;
    for (const minion of minions) {
      if (n >= MAX_BARS) break;
      const o = n * 3;
      this.centerData[o] = minion.position.x;
      this.centerData[o + 1] = minion.position.y + lift;
      this.centerData[o + 2] = minion.position.z;
      this.ratioData[n] = minion.healthRatio;
      this.ghostData[n] = minion.ghost;
      this.alphaData[n] = minion.barAlpha;
      n++;
    }

    this.geometry.instanceCount = n;
    this.geometry.attributes.aCenter.needsUpdate = true;
    this.geometry.attributes.aRatio.needsUpdate = true;
    this.geometry.attributes.aGhost.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
