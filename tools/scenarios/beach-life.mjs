/**
 * Beach life acceptance.
 *
 * The ocean and its critters live or die by one contract: every frame reads
 * `settings.ocean` and `settings.beachLife`, so a slider must move the world
 * without a rebuild, the six presets must toggle both systems explicitly (the
 * deep merge only applies the keys a preset names, so every preset has to take
 * a stand), and instance counts are clamped by draw range rather than geometry.
 *
 * Everything is read back out of the live page; shader compile failures would
 * land in the console-error channel and fail the report regardless.
 */
import { harness } from './_harness.mjs';

export default async function run(ctx) {
  const h = harness(ctx);

  await h.install();

  const { expect, rec } = h;

  // The page has no round global; define one here.
  await ctx.evaluate(`(() => {
    window.__r = (v, p = 3) => {
      const s = Math.pow(10, p);
      return Math.round(v * s) / s;
    };
    return true;
  })()`);

  // Reset to the shipped background first so the scenario is repeatable no
  // matter what ran before it in the same tab — and force a few frames so the
  // update() calls have run at least once: both meshes are born visible=true,
  // and under SwiftShader the first rAF frame can lag the "ready" signal.
  await ctx.evaluate(`(() => {
    window.app.setBackground('stage');
    window.app.__fast(6, 1/60);
    return true;
  })()`);

  // ---- off by default --------------------------------------------------
  const off = await ctx.evaluate(`(() => {
    const app = window.app;
    return {
      oceanEnabled: window.__settings.ocean.enabled,
      lifeEnabled: window.__settings.beachLife.enabled,
      oceanVisible: app.ocean.mesh.visible,
      lifeVisible: app.critters.group.visible
    };
  })()`);

  rec('stage-default', off);

  expect(
    off.oceanEnabled === false && off.lifeEnabled === false,
    'the shipped stage preset starts with no sea and no critters',
    off
  );
  expect(
    off.oceanVisible === false && off.lifeVisible === false,
    'disabled systems stay off the render list',
    off
  );

  // ---- manual enable, uniforms follow ----------------------------------
  await ctx.evaluate(`(() => {
    window.__settings.ocean.enabled = true;
    window.__settings.beachLife.enabled = true;
    window.app.__fast(6, 1/60);
    return true;
  })()`);

  const on = await ctx.evaluate(`(() => {
    const app = window.app;
    const o = window.__settings.ocean;
    return {
      oceanVisible: app.ocean.mesh.visible,
      lifeVisible: app.critters.group.visible,
      uInner: window.__r(app.ocean.uniforms.uInner.value),
      innerRadius: window.__r(o.innerRadius),
      uLevel: window.__r(app.ocean.uniforms.uLevel.value),
      level: window.__r(o.level)
    };
  })()`);

  rec('manual-on', on);

  expect(on.oceanVisible === true && on.lifeVisible === true, 'enabling both systems puts them on the render list', on);
  expect(
    Math.abs(on.uInner - on.innerRadius) < 0.001 && Math.abs(on.uLevel - on.level) < 0.001,
    'ocean uniforms mirror their settings on enable',
    on
  );

  // ---- the shoreline is a uniform, not a rebuild ------------------------
  await ctx.evaluate(`(() => {
    window.__settings.ocean.innerRadius = 33;
    window.app.__fast(6, 1/60);
    return true;
  })()`);

  const moved = await ctx.evaluate(`(() => {
    const app = window.app;
    return {
      uInner: window.__r(app.ocean.uniforms.uInner.value),
      setting: window.__r(window.__settings.ocean.innerRadius)
    };
  })()`);

  expect(
    Math.abs(moved.uInner - 33) < 0.001,
    'moving innerRadius retargets the shader live (no geometry rebuild)',
    moved
  );

  await ctx.evaluate(`window.__settings.ocean.innerRadius = 27`);

  // ---- colour sliders reach the shader ---------------------------------
  await ctx.evaluate(`(() => {
    window.__settings.ocean.seaColor = '#ff0000';
    window.app.__fast(6, 1/60);
    return true;
  })()`);

  const color = await ctx.evaluate(`window.app.ocean.uniforms.uSeaColor.value.getHexString()`);
  expect(color === 'ff0000', 'sea colour sliders reach the shader uniform', color);

  await ctx.evaluate(`window.__settings.ocean.seaColor = '#2f6d84'`);

  // ---- switching back off ----------------------------------------------
  await ctx.evaluate(`(() => {
    window.__settings.ocean.enabled = false;
    window.__settings.beachLife.enabled = false;
    window.app.__fast(6, 1/60);
    return true;
  })()`);

  const offAgain = await ctx.evaluate(`(() => {
    const app = window.app;
    return { oceanVisible: app.ocean.mesh.visible, lifeVisible: app.critters.group.visible };
  })()`);

  expect(
    offAgain.oceanVisible === false && offAgain.lifeVisible === false,
    'disabling again removes both systems from the render list',
    offAgain
  );

  // ---- presets take a stand --------------------------------------------
  await ctx.evaluate(`window.app.setBackground('beach')`);

  const beach = await ctx.evaluate(`(() => {
    window.app.__fast(6, 1/60);
    const app = window.app;
    return {
      ocean: window.__settings.ocean.enabled,
      life: window.__settings.beachLife.enabled,
      oceanVisible: app.ocean.mesh.visible,
      lifeVisible: app.critters.group.visible,
      uTime: window.__r(app.ocean.uniforms.uTime.value),
      crabs: app.critters.crabs.count,
      gulls: app.critters.gulls.count
    };
  })()`);

  rec('beach-preset', beach);

  expect(beach.ocean === true && beach.life === true, 'the beach preset turns both systems on', beach);
  expect(beach.oceanVisible && beach.lifeVisible, 'both systems render on the beach', beach);
  expect(beach.uTime > 0, 'the sea clock advances (the swell moves)', beach);
  expect(beach.crabs > 0 && beach.gulls > 0, 'the beach spawns crabs and gulls', beach);

  // ---- count clamping ---------------------------------------------------
  await ctx.evaluate(`(() => {
    window.__settings.beachLife.crabs = 99;
    window.__settings.beachLife.gulls = 99;
    window.app.__fast(6, 1/60);
    return true;
  })()`);

  const clamp = await ctx.evaluate(`(() => {
    const app = window.app;
    return { crabs: app.critters.crabs.count, gulls: app.critters.gulls.count };
  })()`);

  rec('clamped', clamp);

  expect(clamp.crabs === 16, 'crab draws clamp at the pool cap (16)', clamp);
  expect(clamp.gulls === 10, 'gull draws clamp at the pool cap (10)', clamp);

  await ctx.evaluate(`(() => {
    window.__settings.beachLife.crabs = 3;
    window.app.__fast(6, 1/60);
    return true;
  })()`);

  const backDown = await ctx.evaluate(`window.app.critters.crabs.count`);
  expect(backDown === 3, 'crab draws follow the slider back down', backDown);

  await ctx.evaluate(`window.app.setBackground('desert')`);

  const desert = await ctx.evaluate(`(() => {
    window.app.__fast(6, 1/60);
    return {
      ocean: window.__settings.ocean.enabled,
      life: window.__settings.beachLife.enabled,
      oceanVisible: window.app.ocean.mesh.visible,
      lifeVisible: window.app.critters.group.visible
    };
  })()`);

  rec('desert-preset', desert);

  expect(
    desert.ocean === false && desert.life === false,
    'leaving the beach kills both systems (every preset must take a stand)',
    desert
  );
  expect(
    desert.oceanVisible === false && desert.lifeVisible === false,
    'the desert renders no sea and no critters',
    desert
  );

  // ---- the editor carries both folders ----------------------------------
  // lil-gui's public traversal (same as sliders.mjs): foldersRecursive plus
  // the $title text node. Private __folders maps are not an API.
  const folders = await ctx.evaluate(`(() => {
    const gui = window.app.editor.gui;
    const title = (f) => f.$title.textContent.trim();
    const find = (name) => gui.foldersRecursive().find((f) => title(f) === name) ?? null;
    const env = find('环境');
    const ocean = find('海洋');
    const life = find('海滩生物');
    return {
      ocean: ocean ? ocean.controllersRecursive().length : null,
      life: life ? life.controllersRecursive().length : null
    };
  })()`);

  rec('editor-folders', folders);

  expect(folders !== null && folders.ocean === 13, 'the editor carries the ocean folder with all 13 controls', folders);
  expect(folders !== null && folders.life === 13, 'the editor carries the beach-life folder with all 13 controls', folders);

  // Leave the page on the shipped background.
  await ctx.evaluate(`window.app.setBackground('stage')`);

  return { beachLife: true };
}
