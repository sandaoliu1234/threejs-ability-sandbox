import {
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  Vector3
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { settings } from '../config/settings.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';

/** Hard allocation caps — the editor sliders stop here, meshes never grow. */
const MAX_PALMS = 24;
const MAX_SHADES = 6;

/**
 * Part ids, stamped into an `aPart` attribute so one draw call can wear four
 * different materials: the fragment shader picks a uniform colour per vertex
 * from this number. That is what keeps every colour a live slider while the
 * whole palm stays a single instanced draw.
 */
const PART = {
  TRUNK: 0,
  FROND: 1,
  COCONUT: 2,
  THATCH: 3,
  WOOD: 4
};

/**
 * Stamp a part id across a geometry's vertices before it is merged.
 *
 * This is PER-VERTEX data — one float per vertex — so it must be a plain
 * BufferAttribute. Wrapping it in an InstancedBufferAttribute would claim the
 * array describes whole instances; `mergeGeometries` keeps that flag, and the
 * shader would then read array[0] for every vertex of the merged tree, painting
 * the trunk and the fronds the same single colour.
 */
function stampPart(geometry, part) {
  const count = geometry.attributes.position.count;
  const parts = new Float32Array(count).fill(part);
  geometry.setAttribute('aPart', new BufferAttribute(parts, 1));
  return geometry;
}

/**
 * Programmatic coconut palm, local space: origin at the base, +y up, fronds
 * reaching out along +z before their own yaw spin.
 *
 * The trunk is deliberately built STRAIGHT — six tapering segments — and bent
 * in the vertex shader by `pow(y, 1.7) * lean`. Bending it in geometry would
 * mean rebuilding the buffer whenever the lean slider moved; bending it in the
 * shader makes the slider free and gives every instance its own curve from its
 * seed, which is the same trick the gull's wings use.
 */
function palmGeometry() {
  const parts = [];
  const SEGMENTS = 6;
  const TRUNK_H = 5.2;

  // Tapering trunk: r 0.24 at the sand down to 0.13 under the crown.
  for (let i = 0; i < SEGMENTS; i++) {
    const t0 = i / SEGMENTS;
    const t1 = (i + 1) / SEGMENTS;
    const r0 = 0.24 + (0.13 - 0.24) * t0;
    const r1 = 0.24 + (0.13 - 0.24) * t1;
    const seg = new CylinderGeometry(r1, r0, TRUNK_H / SEGMENTS, 8, 1);
    seg.translate(0, (t0 + t1) * 0.5 * TRUNK_H, 0);
    parts.push(stampPart(seg, PART.TRUNK));
  }

  // A slight root flare, so the trunk is planted rather than poked in.
  const flare = new CylinderGeometry(0.3, 0.46, 0.3, 8, 1);
  flare.translate(0, 0.15, 0);
  parts.push(stampPart(flare, PART.TRUNK));

  // Nine fronds. Each is built reaching out along +z, drooped, then spun
  // around the trunk — so the crown reads as a proper radial spread.
  const FRONDS = 9;
  const FROND_L = 2.05;
  for (let i = 0; i < FRONDS; i++) {
    const angle = (i / FRONDS) * Math.PI * 2;
    const droop = 0.42 + (i % 3) * 0.13;

    const blade = new BoxGeometry(0.3, 0.035, FROND_L);
    // Pivot at the crown: shift the blade out so its inner edge touches origin.
    blade.translate(0, 0, FROND_L * 0.5);
    blade.rotateX(droop);
    blade.rotateY(angle);
    blade.translate(0, TRUNK_H, 0);
    parts.push(stampPart(blade, PART.FROND));

    // A narrow secondary blade per frond breaks the single-slab silhouette.
    const leaf = new BoxGeometry(0.16, 0.03, FROND_L * 0.72);
    leaf.translate(0, 0, FROND_L * 0.36);
    leaf.rotateX(droop + 0.3);
    leaf.rotateY(angle + 0.22);
    leaf.translate(0, TRUNK_H - 0.16, 0);
    parts.push(stampPart(leaf, PART.FROND));
  }

  // Coconuts in the crown.
  for (const [ax, ay, az] of [[0.19, -0.12, 0.12], [-0.16, -0.2, 0.05], [0.02, -0.22, -0.2]]) {
    const nut = new SphereGeometry(0.13, 8, 6);
    nut.translate(ax, TRUNK_H + ay, az);
    parts.push(stampPart(nut, PART.COCONUT));
  }

  return mergeGeometries(parts, false);
}

/**
 * The leisure pocket from the reference photo: a thatch parasol on a dark pole
 * over a round timber deck with two loungers. Origin at the deck centre, +y up,
 * everything static — no shader animation, so this one needs no depth-material
 * patch (the default depth pass already matches it exactly).
 */
function shadeGeometry() {
  const parts = [];
  const POLE_H = 2.5;
  const DECK_R = 1.15;

  // Round deck, raised a little off the sand.
  const deck = new CylinderGeometry(DECK_R, DECK_R, 0.09, 20, 1);
  deck.translate(0, 0.14, 0);
  parts.push(stampPart(deck, PART.WOOD));

  // Thatch canopy: a wide cone, flattened, sitting on top of the pole. The
  // cone's own point is the peak, so it reads as woven straw rather than a lid.
  const canopy = new CylinderGeometry(0.16, 2.0, 0.95, 18, 1, false);
  canopy.translate(0, POLE_H + 0.32, 0);
  parts.push(stampPart(canopy, PART.THATCH));

  // A second, wider straw skirt under the canopy gives the parasol its brim.
  const brim = new CylinderGeometry(1.55, 2.15, 0.22, 18, 1, true);
  brim.translate(0, POLE_H - 0.1, 0);
  parts.push(stampPart(brim, PART.THATCH));

  const pole = new CylinderGeometry(0.075, 0.085, POLE_H, 10, 1);
  pole.translate(0, POLE_H * 0.5 + 0.18, 0);
  parts.push(stampPart(pole, PART.WOOD));

  // Two loungers, facing each other across the deck: a flat bench plus a
  // raked backrest on four stubby legs.
  for (const side of [-1, 1]) {
    const z = side * 0.62;
    const bench = new BoxGeometry(0.62, 0.07, 1.06);
    bench.translate(0, 0.34, z);
    parts.push(stampPart(bench, PART.WOOD));

    const back = new BoxGeometry(0.6, 0.06, 0.52);
    back.rotateX(side * 0.85);
    back.translate(0, 0.55, z + side * 0.44);
    parts.push(stampPart(back, PART.WOOD));

    for (const lx of [-0.24, 0.24]) {
      for (const lz of [-0.36, 0.36]) {
        const leg = new BoxGeometry(0.06, 0.24, 0.06);
        leg.translate(lx, 0.2, z + lz);
        parts.push(stampPart(leg, PART.WOOD));
      }
    }
  }

  return mergeGeometries(parts, false);
}

/* Shared uniform declarations + the displacement itself, kept in one string so
   the colour pass and the shadow-depth pass can never disagree about where a
   palm is. A mismatch there is the classic "shadow of a different object". */
const PALM_UNIFORMS_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uPalmLean;
  uniform float uFrondSway;
  uniform float uFrondSwaySpeed;
`;

const PALM_DISPLACE_GLSL = /* glsl */ `
  float pSeed = aSeed;
  float pLeanSide = hash11(pSeed * 13.7) < 0.5 ? -1.0 : 1.0;
  float pLeanAmt = uPalmLean * (0.6 + hash11(pSeed * 41.3) * 0.8);

  // Bend the trunk: displacement grows with height, so the base stays planted
  // and the crown swings out. This is what turns straight cylinder segments
  // into a curved palm without ever rebuilding the buffer.
  float pUp = max(0.0, position.y);
  transformed.x += pow(pUp, 1.7) * pLeanAmt * pLeanSide * 0.5;
  transformed.z += pow(pUp, 1.7) * pLeanAmt * hash11(pSeed * 71.9) * 0.28;

  // Fronds rock around the crown. Weighted by the same height term so the tips
  // travel and the trunk does not, which is how a real crown in a breeze moves.
  float pCrown = max(0.0, position.y - 4.6);
  float pSway = sin(uTime * uFrondSwaySpeed * 6.2831 + pSeed * 21.7) * pCrown * uFrondSway;
  transformed.x += pSway * pLeanSide;
  transformed.z += pSway * 0.6;
`;

/* Colours arrive per-part through `aPart` rather than baked vertex colours, so
   every one of them stays a live editor slider. */
const PART_COLOR_GLSL = /* glsl */ `
  uniform vec3 uTrunkColor;
  uniform vec3 uFrondColor;
  uniform vec3 uCoconutColor;
  uniform vec3 uThatchColor;
  uniform vec3 uWoodColor;

  vec3 partColor(float id) {
    if (id < 0.5) return uTrunkColor;
    if (id < 1.5) return uFrondColor;
    if (id < 2.5) return uCoconutColor;
    if (id < 3.5) return uThatchColor;
    return uWoodColor;
  }
`;

/**
 * Inject the palm displacement into any material's vertex shader. Used for both
 * the visible MeshStandardMaterial and its MeshDepthMaterial twin.
 */
function patchPalmVertex(material, defines = {}) {
  material.onBeforeCompile = (shader) => {
    // `shader.defines` is not guaranteed to exist on the depth material's raw
    // ShaderLib program. Assigning into `undefined` throws inside three's own
    // getProgram(), which takes the whole render loop down with it — so seed
    // the object defensively rather than merging into whatever is there.
    shader.defines = Object.assign({}, shader.defines, defines);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aPart;
         ${PALM_UNIFORMS_GLSL}
         ${noiseGLSL}`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           ${PALM_DISPLACE_GLSL}
         }`
      );
  };
  return material;
}

/**
 * Deterministic per-instance hash in the same family as the shader's `hash11`,
 * so the CPU placement and the GPU displacement agree on each tree's identity.
 */
function hash01(p) {
  let x = (p * 0.1031) % 1;
  x = (x * (x + 33.33)) % 1;
  x = (x * (x + x)) % 1;
  return x < 0 ? x + 1 : x;
}

/**
 * Collapse an unused instance to nothing. Object3D has no `makeScale`, so the
 * matrix is written directly: a zero column-0/1/2 is a zero-scale transform,
 * which rasterises to nothing while keeping the matrix finite.
 */
function hideInstance(mesh, index) {
  _hidden.identity();
  _hidden.scale(_ZERO);
  _hidden.setPosition(0, 0, 0);
  mesh.setMatrixAt(index, _hidden);
}

const _hidden = new Matrix4();
const _ZERO = new Vector3(0, 0, 0);

/**
 * Lay the grove out on the dry-sand ring between `palmInner` and `palmOuter`.
 *
 * The instances are written into the InstancedMesh matrix rather than derived
 * in the vertex shader, which keeps scale and heading on the CPU where the
 * editor sliders can reach them, and leaves the shader doing only the one thing
 * geometry cannot: bending the trunk.
 *
 * Each palm keeps a fixed hash of its own, so the lean direction the shader
 * picks matches the heading chosen here — otherwise the grove would reshuffle
 * every time a slider moved.
 */
function placePalms(mesh, props, dummy) {
  const count = Math.min(Math.max(0, Math.round(props.palms)), MAX_PALMS);
  const inner = Math.min(props.palmInner, props.palmOuter);
  const outer = Math.max(props.palmInner, props.palmOuter);

  // The drawn count is the slider; the unused instances are collapsed to a zero
  // matrix below so a stale one can never appear in the arena.
  mesh.count = count;

  for (let i = 0; i < MAX_PALMS; i++) {
    if (i >= count) {
      hideInstance(mesh, i);
      continue;
    }

    const h1 = hash01(i * 0.618 + 0.17);
    const h2 = hash01(i * 0.347 + 0.61);
    const h3 = hash01(i * 0.911 + 0.29);

    // Golden-angle stepping keeps successive palms apart instead of letting
    // two hashes land on top of each other the way pure randoms do.
    const angle = (i * 2.39996 + h1 * 0.7) % (Math.PI * 2);
    const radius = inner + (outer - inner) * (0.15 + h2 * 0.85);
    const scale = props.palmScale * (0.82 + h3 * 0.36);

    dummy.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
    dummy.rotation.set(0, h1 * Math.PI * 2, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Place the leisure pockets. They stand outside the walkable arena and face
 * the water, so the parasol reads against the horizon the way it does in the
 * reference shot rather than being buried in the grove.
 */
function placeShades(mesh, props, dummy) {
  const count = Math.min(Math.max(0, Math.round(props.shade)), MAX_SHADES);
  const base = settings.beachProps.shadeRadius;

  mesh.count = count;

  for (let i = 0; i < MAX_SHADES; i++) {
    if (i >= count) {
      hideInstance(mesh, i);
      continue;
    }

    // Spread them along the sand rather than clustering: each pocket takes its
    // own point on a wide arc, clear of the tideline the crabs work.
    const angle = 0.9 + (i / Math.max(1, count)) * Math.PI * 1.15;
    const radius = base * (1 + i * 0.06);

    dummy.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
    // Yaw only: a deck that tilted would let the loungers float off the sand.
    dummy.rotation.set(0, angle + Math.PI, 0);
    dummy.scale.setScalar(props.shadeScale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

export class BeachProps {
  constructor() {
    this.group = new Group();
    this.group.name = 'BeachProps';

    const identity = new Matrix4();
    const props = settings.beachProps;

    /* ---------------- Palms ---------------- */
    this.palmUniforms = {
      uTime: { value: 0 },
      uPalmLean: { value: props.palmLean },
      uFrondSway: { value: props.frondSway },
      uFrondSwaySpeed: { value: props.frondSwaySpeed },
      // Colour uniforms need a THREE.Color, not the raw hex the settings carry:
      // three uploads a vec3 via uniform3fv, which cannot convert a number.
      uTrunkColor: { value: new Color(0xffffff) },
      uFrondColor: { value: new Color(0xffffff) },
      uCoconutColor: { value: new Color(0xffffff) },
      uThatchColor: { value: new Color(0xffffff) },
      uWoodColor: { value: new Color(0xffffff) }
    };

    const palmMat = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.0,
      vertexColors: false
    });
    palmMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.palmUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aSeed;
           attribute float aPart;
           varying float vPart;
           ${PALM_UNIFORMS_GLSL}
           ${PART_COLOR_GLSL}
           ${noiseGLSL}`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           {
             vPart = aPart;
             ${PALM_DISPLACE_GLSL}
           }`
        );
      // `aPart` is an attribute, so the fragment stage cannot see it — the part
      // id has to travel across the stage boundary as a varying, and the colour
      // helper has to be declared here too. Declaring only the vertex side (or
      // calling partColor(aPart) in the fragment) leaves the whole assignment
      // unresolved and the palm renders flat white.
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying float vPart;
           ${PART_COLOR_GLSL}`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           diffuseColor.rgb = partColor(vPart);`
        );
    };
    palmMat.customProgramCacheKey = () => 'beach-palm-v1';

    // The palms stand inside the sun's 26 m shadow camera, so they have to cast
    // — and a depth pass that did not run the same displacement would drop a
    // straight trunk's shadow under a bent tree.
    const palmDepth = patchPalmVertex(new MeshDepthMaterial({ depthPacking: 3201 }), {});
    Object.assign(palmDepth.uniforms ?? {}, this.palmUniforms);
    palmDepth.customProgramCacheKey = () => 'beach-palm-depth-v1';

    const palmGeo = palmGeometry();
    const seeds = new Float32Array(MAX_PALMS);
    // A per-instance hash drives the lean direction, so the grove is irregular.
    for (let i = 0; i < MAX_PALMS; i++) seeds[i] = (i + 0.41) / MAX_PALMS;
    palmGeo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
    // `aPart` is deliberately NOT instanced: `stampPart` writes one id per
    // VERTEX (trunk / frond / coconut), which is what lets a single draw paint
    // the trunk brown and the fronds green. Wrapping it in an
    // InstancedBufferAttribute declares one value for the whole tree, so every
    // vertex would take vertex 0's id and the palm would come out one flat
    // colour. Leave it as the plain per-vertex attribute `palmGeometry` built.

    this.palms = new InstancedMesh(palmGeo, palmMat, MAX_PALMS);
    for (let i = 0; i < MAX_PALMS; i++) this.palms.setMatrixAt(i, identity);
    this.palms.instanceMatrix.needsUpdate = true;
    this.palms.castShadow = true;
    this.palms.frustumCulled = false;
    this.palms.layers.set(LAYER.WORLD);
    this.palms.name = 'Palms';
    this.palms.customDepthMaterial = palmDepth;

    /* ---------------- Leisure pocket ---------------- */
    this.shadeUniforms = {
      // `shadeColorGLSL` declares all five so it can be shared with the palms,
      // so all five need a real Color value even though the shade only uses two.
      uTrunkColor: { value: new Color(0xffffff) },
      uFrondColor: { value: new Color(0xffffff) },
      uCoconutColor: { value: new Color(0xffffff) },
      uThatchColor: { value: new Color(0xffffff) },
      uWoodColor: { value: new Color(0xffffff) }
    };

    const shadeMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0.0 });
    shadeMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.shadeUniforms);
      // The leisure pocket has no animated displacement, so it only needs the
      // part colours. Its three unused colour uniforms are declared as plain
      // uniforms (never `= vec3(0.0)` — a default initialiser on a uniform is
      // illegal in GLSL ES 1.00 and fails the whole vertex shader), and it
      // declares `aPart` in BOTH stages: the fragment stage reads it to pick the
      // colour, and an attribute has to be declared wherever it is used.
      const shadeColorGLSL = /* glsl */ `
        uniform vec3 uTrunkColor;
        uniform vec3 uFrondColor;
        uniform vec3 uCoconutColor;
        uniform vec3 uThatchColor;
        uniform vec3 uWoodColor;

        vec3 partColor(float id) {
          if (id < 0.5) return uTrunkColor;
          if (id < 1.5) return uFrondColor;
          if (id < 2.5) return uCoconutColor;
          if (id < 3.5) return uThatchColor;
          return uWoodColor;
        }
      `;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
         attribute float aPart;
         varying float vPart;
         ${shadeColorGLSL}`
      ).replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vPart = aPart;`
      );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying float vPart;
           ${shadeColorGLSL}`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           diffuseColor.rgb = partColor(vPart);`
        );
    };
    shadeMat.customProgramCacheKey = () => 'beach-shade-v1';

    const shadeGeo = shadeGeometry();
    shadeGeo.setAttribute(
      'aSeed',
      new InstancedBufferAttribute(new Float32Array(MAX_SHADES).fill(0), 1)
    );
    // `aPart` stays the per-vertex attribute `shadeGeometry` built — see
    // `stampPart` for why wrapping it as instanced flattens every colour.

    this.shades = new InstancedMesh(shadeGeo, shadeMat, MAX_SHADES);
    for (let i = 0; i < MAX_SHADES; i++) this.shades.setMatrixAt(i, identity);
    this.shades.instanceMatrix.needsUpdate = true;
    this.shades.castShadow = true;
    this.shades.frustumCulled = false;
    this.shades.layers.set(LAYER.WORLD);
    this.shades.name = 'ShadeSets';

    this.group.add(this.palms, this.shades);
    // Placement is re-derived from the sliders every frame, so the grove follows
    // the ring controls live instead of only on reload.
    this._dummy = new Object3D();
    this.update(0);
  }

  update(elapsed) {
    const props = settings.beachProps;
    this.group.visible = props.enabled;
    if (!props.enabled) return;

    this.palmUniforms.uTime.value = elapsed;
    this.palmUniforms.uPalmLean.value = props.palmLean;
    this.palmUniforms.uFrondSway.value = props.frondSway;
    this.palmUniforms.uFrondSwaySpeed.value = props.frondSwaySpeed;
    // `.set()` MUTATES the Color — assigning the raw '#rrggbb' string here would
    // replace the object and hand uniform3fv a string, which it cannot upload.
    this.palmUniforms.uTrunkColor.value.set(props.trunkColor);
    this.palmUniforms.uFrondColor.value.set(props.frondColor);
    this.palmUniforms.uCoconutColor.value.set(props.trunkColor);
    this.palmUniforms.uThatchColor.value.set(props.shadeColor);
    this.palmUniforms.uWoodColor.value.set(props.woodColor);
    placePalms(this.palms, props, this._dummy);

    this.shadeUniforms.uThatchColor.value.set(props.shadeColor);
    this.shadeUniforms.uWoodColor.value.set(props.woodColor);
    placeShades(this.shades, props, this._dummy);
  }

  dispose() {
    this.palms.geometry.dispose();
    this.palms.material.dispose();
    this.palms.customDepthMaterial?.dispose();
    this.shades.geometry.dispose();
    this.shades.material.dispose();
  }
}
