import { Group, InstancedMesh, InstancedBufferAttribute, Matrix4, MeshStandardMaterial, SphereGeometry, BoxGeometry, ConeGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { settings } from '../config/settings.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';

/** Hard allocation caps — the editor sliders stop here, meshes never grow. */
const MAX_CRABS = 16;
const MAX_GULLS = 10;

/**
 * Programmatic crab, built from primitives and merged into one buffer.
 * Local space: +z is the front (claws), y is up. Everything is raised off the
 * origin so the crab stands on the sand instead of half-sinking into it.
 */
function crabGeometry() {
  const parts = [];
  const body = new SphereGeometry(0.5, 14, 10);
  body.scale(1.0, 0.42, 0.8);
  body.translate(0, 0.3, 0);
  parts.push(body);

  // Eyes: two tiny stalks on the top front edge.
  for (const side of [-1, 1]) {
    const eye = new SphereGeometry(0.07, 6, 5);
    eye.translate(side * 0.16, 0.54, 0.3);
    parts.push(eye);
  }

  // Claws: one per side, held slightly forward.
  for (const side of [-1, 1]) {
    const claw = new SphereGeometry(0.17, 8, 6);
    claw.scale(0.8, 0.6, 1.1);
    claw.translate(side * 0.55, 0.38, 0.42);
    parts.push(claw);
  }

  // Six legs: three thin boxes per side, angled out and back, feet on the sand.
  for (const side of [-1, 1]) {
    for (const [z, rot] of [[0.22, 0.5], [0.0, 0.0], [-0.22, -0.5]]) {
      const leg = new BoxGeometry(0.52, 0.045, 0.07);
      leg.rotateY(rot);
      leg.translate(side * 0.52, 0.03, z);
      parts.push(leg);
    }
  }

  return mergeGeometries(parts);
}

/**
 * Programmatic gull: body along z, wings as flat slabs along x. The wing
 * extent (|x| > 0.1) is what the vertex-shader flap bends — the wings are
 * built wide so the bend has leverage, and the tips travel ~4x what the roots
 * do.
 */
function gullGeometry() {
  const parts = [];
  const body = new SphereGeometry(0.28, 12, 8);
  body.scale(0.75, 0.7, 1.5);
  parts.push(body);

  const head = new SphereGeometry(0.14, 8, 6);
  head.translate(0, 0.1, 0.4);
  parts.push(head);

  // ConeGeometry points +y; rotated onto +z it becomes the beak.
  const beak = new ConeGeometry(0.045, 0.18, 6);
  beak.rotateX(Math.PI / 2);
  beak.translate(0, 0.08, 0.56);
  parts.push(beak);

  const tail = new BoxGeometry(0.18, 0.03, 0.34);
  tail.translate(0, 0.0, -0.48);
  parts.push(tail);

  for (const side of [-1, 1]) {
    const wing = new BoxGeometry(1.05, 0.035, 0.32);
    wing.translate(side * 0.66, 0.05, 0.02);
    parts.push(wing);
  }

  return mergeGeometries(parts);
}

/**
 * Shared shader scaffolding. Both species are single InstancedMeshes with
 * identity instance matrices — every per-instance position, facing, scale and
 * animation is derived from an aSeed attribute plus uTime in the vertex
 * shader, so the per-frame CPU cost is one uniform write per species.
 *
 * Chunk order is what shapes the injection: `defaultnormal_vertex` (which
 * bakes objectNormal into transformedNormal) runs BEFORE `begin_vertex`, so
 * the species block rides in at `beginnormal_vertex` — it computes the whole
 * pose AND rotates objectNormal there — and `begin_vertex` only applies the
 * already-computed pose to `transformed`, inside braces so its locals can
 * never collide with the species block's.
 *
 * Shadows are off for both species and that is deliberate: the tideline sits
 * outside the sun's 26 m shadow camera and gulls fly 11 m up, so a depth pass
 * would render nothing visible while costing two extra draws per frame.
 */
function patchSpecies(material, speciesGLSL, uniforms, defines = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    Object.assign(shader.defines, defines);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         uniform float uTime;
         ${speciesUniformsGLSL}
         ${noiseGLSL}`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         ${speciesGLSL}`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           float appScl = spScl;
           float appRoll = spRoll;
           float appYaw = spYaw;

           #ifdef SPECIES_GULL
             transformed.y += spFlap * spBend;
           #endif

           transformed *= appScl;
           float tcr = cos(appRoll), tsr = sin(appRoll);
           transformed.xy = mat2(tcr, tsr, -tsr, tcr) * transformed.xy;
           float tcy = cos(appYaw), tsy = sin(appYaw);
           transformed.xz = mat2(tcy, tsy, -tsy, tcy) * transformed.xz;
           transformed += spPos;
         }`
      );
  };
}

/* Both species emit the same five pose variables: spPos, spScl, spRoll, spYaw
   and (gull only) spFlap / spBend. The prefixed names live at main() scope
   across both injection points, so they must never collide with three's own
   locals — the sp- prefix guarantees that. */

const CRAB_GLSL = /* glsl */ `
  float ch1 = hash11(aSeed * 17.13);
  float ch2 = hash11(aSeed * 29.71 + 4.17);
  float ch3 = hash11(aSeed * 53.39 + 11.3);

  // uCrabSpeed is metres per second along the tideline. The angular amplitude
  // is derived from it — amp = walk / (omega * radius) — so the peak speed at
  // the sand is exactly uCrabSpeed no matter how far out the crab is. The
  // first version wrote the amplitude in radians and multiplied it by a 26 m
  // radius, which put the crabs at roughly 12 m/s.
  float cWalk = uCrabSpeed * (0.7 + ch3 * 0.6);
  float cOmega = 0.22 * (0.8 + ch2 * 0.4);
  float cRadRef = max(1.0, mix(uCrabInner, uCrabOuter, 0.5));
  float cAmp = cWalk / (cOmega * cRadRef);

  float cTheta = ch1 * 6.2831 + sin(uTime * cOmega + ch2 * 6.2831) * cAmp;
  // Each crab owns a personal arc of the tideline and drifts in and out with a
  // slow tide phase, so the line never reads as a bead chain.
  float cRad = mix(uCrabInner, uCrabOuter, 0.5 + 0.5 * sin(uTime * 0.06 + ch2 * 6.2831));

  // Scuttle bounce: a quick double-step hop while the arc carries it along.
  // The step rate is its own clock, not a multiple of the walk — tying it to
  // the walk made a slow crab take one step every three seconds.
  float cLift = (abs(sin(uTime * (7.0 + cWalk * 6.0) + ch1 * 9.0)) * 0.045
               + snoise01(vec3(aSeed * 41.0, uTime * 0.8, 3.0)) * 0.025) * uCrabBob;

  spPos = vec3(sin(cTheta) * cRad, cLift, cos(cTheta) * cRad);
  // The body faces radially, so the arc walk reads as the sideways scuttle it is.
  spYaw = cTheta;
  spRoll = 0.0;
  spScl = uCrabScale * (0.75 + ch3 * 0.5);
  spFlap = 0.0;
  spBend = 0.0;

  // Rotate the normal with the heading NOW — defaultnormal_vertex runs before
  // begin_vertex, so this is the last chance for lighting to follow the body.
  float cny = cos(spYaw), cns = sin(spYaw);
  objectNormal.xz = mat2(cny, cns, -cns, cny) * objectNormal.xz;
`;

const GULL_GLSL = /* glsl */ `
  float gh1 = hash11(aSeed * 17.13);
  float gh2 = hash11(aSeed * 29.71 + 4.17);
  float gh3 = hash11(aSeed * 53.39 + 11.3);

  // Half the flock wheels each way, so the sky never looks like a carousel.
  float gDir = gh1 < 0.5 ? -1.0 : 1.0;
  float gSpeed = uGullSpeed * (0.8 + gh2 * 0.4) * gDir;
  float gTheta = gh3 * 6.2831 + uTime * gSpeed;
  float gRad = uGullRadius * (0.85 + 0.3 * snoise01(vec3(aSeed * 31.0, uTime * 0.1, 7.0)));
  float gHgt = uGullHeight * (0.9 + 0.25 * sin(uTime * 0.21 + gh2 * 6.2831));

  spPos = vec3(sin(gTheta) * gRad, gHgt, cos(gTheta) * gRad);
  // Face the tangent; bank into the turn proportional to circling direction.
  spYaw = atan(cos(gTheta), -sin(gTheta));
  spRoll = gDir * 0.35;
  spScl = uGullScale * (0.85 + gh3 * 0.3);

  // Wing flap: progressive bend keyed on distance from the body, so tips travel
  // further than roots. Applied to transformed at begin_vertex.
  spFlap = sin(uTime * uGullFlap * (0.85 + gh2 * 0.3) + gh1 * 6.2831);
  spBend = max(0.0, abs(position.x) - 0.1) * 0.55;

  float gnr = cos(spRoll), gns = sin(spRoll);
  objectNormal.xy = mat2(gnr, gns, -gns, gnr) * objectNormal.xy;
  float gny = cos(spYaw), gns2 = sin(spYaw);
  objectNormal.xz = mat2(gny, gns2, -gns2, gny) * objectNormal.xz;
`;

/** The species uniforms, declared once in the vertex shader's common block. */
const speciesUniformsGLSL = /* glsl */ `
  uniform float uCrabSpeed;
  uniform float uCrabInner;
  uniform float uCrabOuter;
  uniform float uCrabScale;
  uniform float uCrabBob;
  uniform float uGullSpeed;
  uniform float uGullRadius;
  uniform float uGullHeight;
  uniform float uGullFlap;
  uniform float uGullScale;
  // Pose outputs shared by both species blocks and the begin_vertex applier.
  vec3 spPos;
  float spScl;
  float spRoll;
  float spYaw;
  float spFlap;
  float spBend;
`;

export class Critters {
  constructor() {
    this.group = new Group();
    this.group.name = 'BeachLife';

    // --- Crabs -------------------------------------------------------------
    const crabGeo = crabGeometry();
    const seeds = new Float32Array(MAX_CRABS);
    for (let i = 0; i < MAX_CRABS; i++) seeds[i] = (i + 0.5) / MAX_CRABS;
    crabGeo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));

    this.crabUniforms = {
      uTime: { value: 0 },
      uCrabSpeed: { value: settings.beachLife.crabSpeed },
      uCrabInner: { value: settings.beachLife.crabInner },
      uCrabOuter: { value: settings.beachLife.crabOuter },
      uCrabScale: { value: settings.beachLife.crabScale },
      uCrabBob: { value: settings.beachLife.crabBob }
    };
    const crabMat = new MeshStandardMaterial({ color: '#c8582f', roughness: 0.6, metalness: 0.05 });
    patchSpecies(crabMat, CRAB_GLSL, this.crabUniforms);
    // Explicit cache keys: both species share one onBeforeCompile source
    // shape, so the renderer would otherwise key them on the defines alone.
    crabMat.customProgramCacheKey = () => 'beach-crab-v1';

    this.crabs = new InstancedMesh(crabGeo, crabMat, MAX_CRABS);
    const identity = new Matrix4();
    for (let i = 0; i < MAX_CRABS; i++) this.crabs.setMatrixAt(i, identity);
    this.crabs.instanceMatrix.needsUpdate = true;
    this.crabs.frustumCulled = false;
    this.crabs.layers.set(LAYER.WORLD);
    this.crabs.name = 'Crabs';

    // --- Gulls -------------------------------------------------------------
    const gullGeo = gullGeometry();
    const gullSeeds = new Float32Array(MAX_GULLS);
    for (let i = 0; i < MAX_GULLS; i++) gullSeeds[i] = (i + 0.37) / MAX_GULLS;
    gullGeo.setAttribute('aSeed', new InstancedBufferAttribute(gullSeeds, 1));

    this.gullUniforms = {
      uTime: { value: 0 },
      uGullSpeed: { value: settings.beachLife.gullSpeed },
      uGullRadius: { value: settings.beachLife.gullRadius },
      uGullHeight: { value: settings.beachLife.gullHeight },
      uGullFlap: { value: settings.beachLife.gullFlap },
      uGullScale: { value: settings.beachLife.gullScale }
    };
    const gullMat = new MeshStandardMaterial({ color: '#e9edf1', roughness: 0.55, metalness: 0.0 });
    // The flap applier is gated on a define so crabs skip it entirely.
    patchSpecies(gullMat, GULL_GLSL, this.gullUniforms, { SPECIES_GULL: '' });
    gullMat.customProgramCacheKey = () => 'beach-gull-v1';

    this.gulls = new InstancedMesh(gullGeo, gullMat, MAX_GULLS);
    for (let i = 0; i < MAX_GULLS; i++) this.gulls.setMatrixAt(i, identity);
    this.gulls.instanceMatrix.needsUpdate = true;
    this.gulls.frustumCulled = false;
    this.gulls.layers.set(LAYER.WORLD);
    this.gulls.name = 'Gulls';

    this.group.add(this.crabs, this.gulls);
  }

  update(elapsed) {
    const life = settings.beachLife;
    this.group.visible = life.enabled;
    if (!life.enabled) return;

    this.crabUniforms.uTime.value = elapsed;
    this.crabUniforms.uCrabSpeed.value = life.crabSpeed;
    this.crabUniforms.uCrabInner.value = life.crabInner;
    this.crabUniforms.uCrabOuter.value = life.crabOuter;
    this.crabUniforms.uCrabScale.value = life.crabScale;
    this.crabUniforms.uCrabBob.value = life.crabBob;
    // Extra slider turns above the cap are clamped by draw count, not geometry.
    this.crabs.count = Math.min(Math.max(0, Math.round(life.crabs)), MAX_CRABS);

    this.gullUniforms.uTime.value = elapsed;
    this.gullUniforms.uGullSpeed.value = life.gullSpeed;
    this.gullUniforms.uGullRadius.value = life.gullRadius;
    this.gullUniforms.uGullHeight.value = life.gullHeight;
    this.gullUniforms.uGullFlap.value = life.gullFlap;
    this.gullUniforms.uGullScale.value = life.gullScale;
    this.gulls.count = Math.min(Math.max(0, Math.round(life.gulls)), MAX_GULLS);
  }

  dispose() {
    this.crabs.geometry.dispose();
    this.crabs.material.dispose();
    this.gulls.geometry.dispose();
    this.gulls.material.dispose();
  }
}
