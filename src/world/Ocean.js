import { Mesh, RingGeometry, MeshStandardMaterial, Color } from 'three';
import { settings } from '../config/settings.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';

/**
 * The sea: a live annulus of water ringing the arena.
 *
 * One draw call, and every bit of motion — swell, foam, the glitter path the
 * low sun drags across it — happens in the shader, so the per-frame CPU cost is
 * a handful of uniform writes. The mesh is a full disc built once at an
 * oversized radius; the shoreline is drawn by the *shader*, which sinks any
 * vertex outside the configured radii two metres below the floor. That is what
 * makes the radius sliders genuinely live: moving `innerRadius` drags the
 * tideline in real time with no geometry rebuild, and the sunk ring is hidden
 * by the ground's depth rather than paying for discard.
 *
 * Shadows: the surface receives but casts nothing. It sits far outside the
 * sun's 26 m shadow camera anyway, so a depth pass would be pure waste.
 */
export class Ocean {
  constructor() {
    // Real metres, built once. 300 m clears every preset's fogFar, and the
    // inner 0.5 m hole is always sunk by the shader (no preset puts water at
    // the origin — the arena floor owns it).
    const geometry = new RingGeometry(0.5, 300, 220, 28);
    geometry.rotateX(-Math.PI / 2);

    this.uniforms = {
      uTime: { value: 0 },
      uLevel: { value: settings.ocean.level },
      uInner: { value: settings.ocean.innerRadius },
      uOuter: { value: settings.ocean.outerRadius },
      uWaveHeight: { value: settings.ocean.waveHeight },
      uWaveSpeed: { value: settings.ocean.waveSpeed },
      uWaveScale: { value: settings.ocean.waveScale },
      uFoamAmount: { value: settings.ocean.foamAmount },
      uFoamWidth: { value: settings.ocean.foamWidth },
      uRoughness: { value: settings.ocean.seaRoughness },
      uSeaColor: { value: new Color(settings.ocean.seaColor) },
      uDeepColor: { value: new Color(settings.ocean.deepColor) },
      uFoamColor: { value: new Color(settings.ocean.foamColor) }
    };

    this.material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.22,
      metalness: 0.0
    });
    // Unique program-cache key: the inline onBeforeCompile below is one of a
    // kind, but naming the key keeps this material out of any future collision.
    this.material.customProgramCacheKey = () => 'ocean-v1';

    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vOceanWorld;
           varying float vOceanWave;
           uniform float uTime;
           uniform float uLevel;
           uniform float uInner;
           uniform float uOuter;
           uniform float uWaveHeight;
           uniform float uWaveSpeed;
           uniform float uWaveScale;
           ${noiseGLSL}`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vOceanWorld = (modelMatrix * vec4(position, 1.0)).xyz;
           {
             float oceanR = length(vOceanWorld.xz);

             // Two octaves of drifting simplex: a long swell plus a shorter
             // chop on top. uWaveHeight is the swell's own amplitude, so the
             // trough can never reach below level minus 1.35 times waveHeight
             // and the default 0.34 m level keeps clearance over the sand.
             float oceanW = snoise(vec3(vOceanWorld.xz * uWaveScale, uTime * uWaveSpeed)) * uWaveHeight
                          + snoise(vec3(vOceanWorld.xz * uWaveScale * 2.7 + 31.7, uTime * uWaveSpeed * 1.6)) * uWaveHeight * 0.35;

             // Soft feather at both ends so the live disc dissolves into the
             // sand (inside) and the fog (outside) instead of showing an edge.
             float live = smoothstep(uInner - 1.5, uInner + 1.5, oceanR)
                        * (1.0 - smoothstep(uOuter - 1.5, uOuter + 1.5, oceanR));

             vOceanWave = oceanW * live;
             // Outside the live band the surface sinks 2 m underground, where
             // the ground's depth hides it — the shoreline is drawn, not
             // modelled.
             transformed.y = (uLevel + oceanW) * live - 2.0 * (1.0 - live);
           }`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vOceanWorld;
           varying float vOceanWave;
           uniform float uTime;
           uniform float uInner;
           uniform float uOuter;
           uniform float uWaveHeight;
           uniform float uFoamAmount;
           uniform float uFoamWidth;
           uniform float uRoughness;
           uniform vec3 uSeaColor;
           uniform vec3 uDeepColor;
           uniform vec3 uFoamColor;
           ${noiseGLSL}`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           // oceanFoam lives at main() scope so the roughness hook further down
           // can reuse it; everything else stays inside the block.
           float oceanFoam = 0.0;
           {
             float oceanR = length(vOceanWorld.xz);

             // Depth grade: shallow near the tideline, deep blue offshore. The
             // gradient completes at 55% of the way out so the far half reads
             // as open water rather than a smooth ramp to the horizon.
             float depthT = smoothstep(uInner, uInner + (uOuter - uInner) * 0.55, oceanR);
             vec3 waterBase = mix(uSeaColor, uDeepColor, depthT);

             // Shoreline foam: strongest right at the water's edge, broken up
             // by a slow noise field so it surges rather than sitting as a
             // static ring.
             float shoreNoise = snoise01(vec3(vOceanWorld.xz * 0.35, uTime * 0.5));
             float shore = (1.0 - smoothstep(uInner + 0.2, uInner + uFoamWidth, oceanR))
                         * (0.55 + 0.45 * shoreNoise);
             // Crest foam: the top of the swell whitens, scaled by uFoamAmount.
             float crest = smoothstep(uWaveHeight * 0.55, uWaveHeight * 0.95, vOceanWave) * uFoamAmount;
             oceanFoam = clamp(max(shore, crest), 0.0, 1.0);

             diffuseColor.rgb = mix(waterBase, uFoamColor, oceanFoam);
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           // Foam is aerated water: matte. Open water stays glossy so the low
           // sun draws its long glitter path down the middle of the frame.
           roughnessFactor = mix(uRoughness, 0.85, oceanFoam);`
        );
    };

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.renderOrder = -2;
    this.mesh.name = 'Ocean';
  }

  update(elapsed) {
    const o = settings.ocean;
    this.mesh.visible = o.enabled;
    if (!o.enabled) return;

    this.uniforms.uTime.value = elapsed;
    this.uniforms.uLevel.value = o.level;
    this.uniforms.uInner.value = o.innerRadius;
    this.uniforms.uOuter.value = o.outerRadius;
    this.uniforms.uWaveHeight.value = o.waveHeight;
    this.uniforms.uWaveSpeed.value = o.waveSpeed;
    this.uniforms.uWaveScale.value = o.waveScale;
    this.uniforms.uFoamAmount.value = o.foamAmount;
    this.uniforms.uFoamWidth.value = o.foamWidth;
    this.uniforms.uRoughness.value = o.seaRoughness;
    this.uniforms.uSeaColor.value.set(o.seaColor);
    this.uniforms.uDeepColor.value.set(o.deepColor);
    this.uniforms.uFoamColor.value.set(o.foamColor);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
