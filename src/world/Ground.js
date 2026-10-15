import {
  Mesh,
  PlaneGeometry,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2
} from 'three';
import { settings, FLOOR_STYLES } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';

/** Side length of the floor plane, metres — the texture repeat is derived from it. */
const PLANE_SIZE = 400;

/**
 * The stone maps that dress the floor: ambientCG Rock030 (CC0), a rough natural
 * rock tiling. Colour is authored sRGB; the rest are linear data.
 */
const TEXTURE_URLS = {
  map: './textures/cathedral/color.jpg',
  normalMap: './textures/cathedral/normal.jpg',
  roughnessMap: './textures/cathedral/roughness.jpg',
  aoMap: './textures/cathedral/ao.jpg'
};

/**
 * Per-style floor detail, injected after `noiseGLSL`.
 *
 * Each style returns `vec4(albedoMultiplier, glow)`. The glow rides in the
 * fourth channel rather than being written straight to a global so a style
 * stays a pure function of its input — the caller decides what to do with it
 * (it gets the light-pool falloff applied before it reaches the emissive term,
 * otherwise ember cracks stay bright at 200 m and float off the ground).
 *
 * The glow colour is `uFloorTint`, so a preset's floor tint *is* its ember or
 * lattice colour. That is deliberate: two knobs for one colour drift apart the
 * moment someone drags one of them.
 *
 * Budget note — the floor plane covers most of the screen, so each style stays
 * at or under the 7 simplex samples the shipped stone path already spends.
 */
const FLOOR_STYLE_GLSL = `
uniform float uFloorStyle;

// Sand: wind ripples. A directional wave whose phase is warped by
// low-frequency noise so the crests meander instead of running dead straight,
// plus a fine grain that stops the surface reading as moulded plastic.
vec4 floorSand(vec3 wp) {
  float warp = fbm3(wp * 0.045 + 21.0) * 3.2;
  float ripple = sin((wp.x * 0.62 + wp.z * 0.38) * 2.4 + warp);
  float crest = smoothstep(0.05, 0.95, ripple * 0.5 + 0.5);
  float grain = snoise01(wp * 3.1) - 0.5;
  return vec4(vec3(1.0 + (crest - 0.5) * 0.18 + grain * 0.055), 0.0);
}

// Snow: wind-packed crust. Broad drifts, a mid-frequency crust, and a sparse
// facet sparkle. The sparkle is a narrow band of the noise on purpose — dense
// specular on a snowfield reads as glitter — and it carries no time term,
// because snow does not twinkle on its own.
vec4 floorSnow(vec3 wp) {
  float drift = fbm3(wp * 0.07 + 3.0);
  float crust = snoise01(wp * 0.55) - 0.5;
  float facet = smoothstep(0.80, 0.98, snoise01(wp * 1.7 + 7.0));
  return vec4(vec3(1.0 + drift * 0.10 + crust * 0.10 + facet * 0.17), 0.0);
}

// Ash: cooled lava. \`ridged\` gives thin filaments, so the high band of it is
// the crack network; the ember glow rides in that same mask, which is what
// makes the light come *out* of the cracks rather than sit on top of them.
// Squaring the mask sharpens it into a line.
vec4 floorAsh(vec3 wp) {
  float crack = smoothstep(0.70, 0.90, ridged(wp * 0.13, 4));
  float soot = snoise01(wp * 0.9 + 13.0) - 0.5;
  return vec4(vec3(1.0 + soot * 0.14 - crack * 0.25), crack * crack * 0.9);
}

// Void: two analytic lattices — a fine 6 m one and a coarse 30 m one — with a
// pulse travelling out from the origin. Deliberately noise-free: a grid that
// wobbles stops reading as a grid, and being mathematically exact is the whole
// identity of this style. The smoothstep width is driven by \`fwidth\`, so the
// lines dissolve into the distance instead of shimmering into moire.
vec4 floorGrid(vec3 wp) {
  vec2 pFine = wp.xz / 6.0;
  vec2 pCoarse = wp.xz / 30.0;
  vec2 dFine = abs(fract(pFine - 0.5) - 0.5);
  vec2 dCoarse = abs(fract(pCoarse - 0.5) - 0.5);

  vec2 wFine = fwidth(pFine) * 0.9;
  vec2 wCoarse = fwidth(pCoarse) * 0.9;
  float f = 1.0 - smoothstep(0.0, max(wFine.x, wFine.y) + 0.012, min(dFine.x, dFine.y));
  float c = 1.0 - smoothstep(0.0, max(wCoarse.x, wCoarse.y) + 0.003, min(dCoarse.x, dCoarse.y));

  float pulse = 0.62 + 0.38 * sin(uTime * 0.9 - length(wp.xz) * 0.09);
  float line = max(f * 0.55, c);
  return vec4(vec3(1.0 - line * 0.35), line * pulse);
}

// Index -> style. The branch condition is a uniform, so it is coherent across
// the whole plane and costs nothing to keep as an if-chain.
vec4 floorDetail(vec3 wp) {
  int style = int(uFloorStyle + 0.5);
  if (style == 1) return floorSand(wp);
  if (style == 2) return floorSnow(wp);
  if (style == 3) return floorAsh(wp);
  if (style == 4) return floorGrid(wp);
  return vec4(vec3(1.0), 0.0);
}
`;

/**
 * The stage floor.
 *
 * Kept perfectly flat (y = 0) on purpose: the path-drawing raycast, every
 * ability and the earth eruptions all assume a planar surface, and a flat plane
 * makes those interactions exact.
 *
 * The base is a tiled stone flagstone (see `TEXTURE_URLS`), graded toward the
 * cool stage palette so it reads as castle rock rather than a daylit courtyard.
 * On top of the sampled albedo the shader keeps the two things that make the
 * floor sit in this scene: a luminance-preserving tint toward `floorTint`, and a
 * radial light pool that keeps the stage centre readable and sinks the floor
 * into the backdrop long before the plane's edge. When the texture is switched
 * off (or has not loaded yet) the same shader falls back to the original
 * procedural stone, so nothing depends on the download succeeding.
 */
export class Ground {
  constructor(environment) {
    this.environment = environment;

    this.material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: settings.environment.floorRoughness,
      metalness: 0.0,
      dithering: true
    });
    this.material.normalScale = new Vector2(
      settings.environment.floorNormalScale,
      settings.environment.floorNormalScale
    );

    /** The four stone maps, filled in by `loadTextures`. Null until then. */
    this.textures = null;
    this._textured = false;

    this.uniforms = {
      uFloorColor: { value: getColor(settings.environment.floorColor).clone() },
      uFloorTint: { value: getColor(settings.environment.floorTint).clone() },
      uTexTint: { value: settings.environment.floorTexTint },
      uSheen: { value: settings.environment.floorSheen },
      uPool: { value: settings.environment.floorPool },
      // Index into `FLOOR_STYLES`, as a float: GLSL has no string switch, and a
      // float keeps this a single uniform write per frame.
      uFloorStyle: { value: 0 },
      uTime: { value: 0 }
    };

    environment.registerShadowCasterWithPatch(this.material, (shader) => {
      shader.uniforms.uFloorColor = this.uniforms.uFloorColor;
      shader.uniforms.uFloorTint = this.uniforms.uFloorTint;
      shader.uniforms.uTexTint = this.uniforms.uTexTint;
      shader.uniforms.uSheen = this.uniforms.uSheen;
      shader.uniforms.uPool = this.uniforms.uPool;
      shader.uniforms.uFloorStyle = this.uniforms.uFloorStyle;
      shader.uniforms.uTime = this.uniforms.uTime;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vGroundWorld;`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vGroundWorld;
           uniform vec3 uFloorColor;
           uniform vec3 uFloorTint;
           uniform float uTexTint;
           uniform float uSheen;
           uniform float uPool;
           uniform float uTime;
           ${noiseGLSL}
           ${FLOOR_STYLE_GLSL}`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           // Declared at main() scope, not inside the block below, so the two
           // hooks further down can still see them. Three.js emits map_fragment
           // before roughnessmap_fragment and emissivemap_fragment, so one
           // evaluation is enough — and it has to be one, because the styles
           // that read it spend up to seven simplex samples each.
           vec3 floorEmissive = vec3(0.0);
           vec4 floorDetailSample = vec4(1.0, 1.0, 1.0, 0.0);
           {
             vec3 wp = vGroundWorld;

             #ifdef USE_MAP
               // The stone albedo is already in diffuseColor. Grade it toward the
               // stage's cool floor tint without dragging its brightness down:
               // normalising the tint to unit luminance shifts the hue and leaves
               // the value to the light pool below.
               vec3 tint = uFloorTint;
               float tl = max(1e-4, dot(tint, vec3(0.299, 0.587, 0.114)));
               vec3 graded = diffuseColor.rgb * (tint / tl);
               diffuseColor.rgb = mix(diffuseColor.rgb, graded, clamp(uTexTint, 0.0, 1.0));
             #else
               // No texture: the original procedural dark stone. Broad, smooth
               // variation with a warmer wash drifting through it — anything
               // higher frequency reads as gravel and fights the clean look.
               float macro = fbm3(wp * 0.018);
               float tintMask = smoothstep(-0.5, 0.6, macro);
               vec3 base = mix(uFloorColor, uFloorTint, tintMask * 0.5);
               base *= 1.0 + fbm3(wp * 0.09 + 11.0) * 0.05;
               base *= 1.0 + (snoise01(wp * 0.7) - 0.5) * 0.06;
               diffuseColor.rgb *= base;
             #endif

             // Radial light pool: the stage centre stays readable and the floor
             // sinks toward the backdrop long before the plane's edge. Shared by
             // both paths, because it is what welds the floor into the scene.
             float dist = length(wp.xz);
             float pool = mix(1.0, smoothstep(40.0, 5.0, dist), clamp(uPool, 0.0, 1.0));
             float poolFalloff = mix(0.18, 1.0, pool);
             diffuseColor.rgb *= poolFalloff;

             // Per-background surface character, on top of whatever the two
             // paths above produced. \`stone\` is the identity here, so the
             // shipped look is bit-for-bit what it was before this existed.
             vec4 detail = floorDetail(wp);
             floorDetailSample = detail;
             diffuseColor.rgb *= detail.rgb;
             // The glow gets the same falloff as the albedo. Without it, ember
             // cracks stay at full brightness at 200 m and the plane visibly
             // stops being a plane.
             floorEmissive = uFloorTint * detail.a * poolFalloff;
           }`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           // Emissive rather than a brighter albedo: embers and the void lattice
           // are light sources, so they must survive the light pool, keep their
           // colour when the sun is turned off, and be picked up by bloom.
           totalEmissiveRadiance += floorEmissive;`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           {
             // Break the sheen up: broad patches of smoother stone catch the key
             // light and the elemental glows, the rest stays matte. Rides on top
             // of the roughness map when one is present.
             float polish = smoothstep(0.3, 0.85, fbm3(vGroundWorld * 0.06 + 3.0) * 0.5 + 0.5);
             roughnessFactor *= mix(1.0, 0.45, polish * clamp(uSheen, 0.0, 1.0));

             // Sand and snow scatter instead of reflecting: their ripples should
             // catch the sun, not turn the whole plane glossy. Only the crests
             // sharpen, and only where the style actually has structure — a
             // glowing style has no crests to speak of, so it opts out.
             float stylePolish = clamp(1.0 - abs(floorDetailSample.a), 0.0, 1.0);
             float crest = smoothstep(0.45, 0.95, floorDetailSample.rgb.r);
             roughnessFactor *= mix(1.0, 0.82, crest * stylePolish * clamp(uSheen, 0.0, 1.0));
           }`
        );
    });

    this.mesh = new Mesh(new PlaneGeometry(PLANE_SIZE, PLANE_SIZE, 1, 1), this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'Ground';
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    this.group = this.mesh;
  }

  /**
   * Load the stone maps and attach them. Called during boot so the maps are in
   * place before the shader is compiled — no first-cast recompile — but the
   * ground renders fine (procedural fallback) if this is skipped or fails.
   *
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async loadTextures(assets) {
    const entries = await Promise.all(
      Object.entries(TEXTURE_URLS).map(async ([slot, url]) => [slot, await assets.loadTexture(url)])
    );

    const maxAniso = this.environment.renderer?.gl.capabilities.getMaxAnisotropy?.() ?? 1;
    const textures = {};
    for (const [slot, texture] of entries) {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.anisotropy = maxAniso;
      // TextureLoader assumes linear data; only the colour map is authored sRGB.
      if (slot === 'map') texture.colorSpace = SRGBColorSpace;
      textures[slot] = texture;
    }

    this.textures = textures;
    this._applyTiling();
    this._setTextured(settings.environment.floorTexture);
  }

  /**
   * Point every map at the same tiling, derived from metres-per-tile. Only the
   * repeat is touched — that feeds the texture's UV matrix (auto-updated each
   * render), so there is no image re-upload and this is safe to call per frame.
   */
  _applyTiling() {
    if (!this.textures) return;
    const repeat = PLANE_SIZE / Math.max(0.1, settings.environment.floorTextureScale);
    if (repeat === this._repeat) return;
    this._repeat = repeat;
    for (const texture of Object.values(this.textures)) texture.repeat.set(repeat, repeat);
  }

  /** Attach or detach the stone maps. Flipping this recompiles once (USE_MAP). */
  _setTextured(on) {
    if (!this.textures || on === this._textured) return;
    for (const slot of Object.keys(TEXTURE_URLS)) {
      this.material[slot] = on ? this.textures[slot] : null;
    }
    this.material.needsUpdate = true;
    this._textured = on;
  }

  update(elapsed) {
    const env = settings.environment;
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uFloorColor.value.copy(getColor(env.floorColor));
    this.uniforms.uFloorTint.value.copy(getColor(env.floorTint));
    this.uniforms.uTexTint.value = env.floorTexTint;
    this.uniforms.uSheen.value = env.floorSheen;
    this.uniforms.uPool.value = env.floorPool;
    // Style name -> index. An unknown name falls back to `stone` (0) rather
    // than to whatever the last valid index was, so a typo in a preset shows
    // up as a plain floor instead of as someone else's floor.
    this.uniforms.uFloorStyle.value = Math.max(0, FLOOR_STYLES.indexOf(env.floorStyle));
    this.material.roughness = env.floorRoughness;
    this.material.normalScale.set(env.floorNormalScale, env.floorNormalScale);

    if (this.textures) {
      this._applyTiling();
      this._setTextured(env.floorTexture);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this.textures) {
      for (const texture of Object.values(this.textures)) texture.dispose();
    }
  }
}
