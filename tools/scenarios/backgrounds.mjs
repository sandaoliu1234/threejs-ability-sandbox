/**
 * Scene picker acceptance.
 *
 * Two dropdowns can now set the background: the HUD chip a player sees, and the
 * editor's own folder. The thing worth proving is therefore not "the table has
 * six entries" (that is a `node` check) but that
 *
 *   1. picking one actually repaints the scene — lights, fog, floor pattern and
 *      grade all move together, and
 *   2. the two menus never disagree, whichever one was used.
 *
 * Point 2 is the failure mode this guards against: two controls bound to the
 * same value is fine until one of them writes without the other reading, and
 * then the HUD cheerfully displays a background the scene is not wearing.
 *
 * Everything is read back out of the live page, because the failure mode is a
 * dropdown that writes a name and changes nothing.
 */
import { harness } from './_harness.mjs';

export default async function run(ctx) {
  const h = harness(ctx);

  await h.install();

  const { expect, rec } = h;

  // Page-side helpers. `round` has to be defined here: the harness exports one
  // for the *report*, but the page has no such global.
  await ctx.evaluate(`(() => {
    window.__r = (v, p = 3) => {
      const s = Math.pow(10, p);
      return Math.round(v * s) / s;
    };
    return true;
  })()`);

  const snapshot = (label) => `(() => {
    const s = window.__settings;
    const e = s.environment;
    const g = window.app.ground;
    const sel = document.querySelector('[data-scene-select]');
    return {
      label: ${JSON.stringify(label)},
      name: e.background,
      floorStyle: e.floorStyle,
      sun: window.__r(e.sunIntensity),
      sunColor: e.sunColor,
      ambient: window.__r(e.ambientIntensity),
      fogColor: e.fogColor,
      floorColor: e.floorColor,
      exposure: window.__r(s.post.exposure),
      temperature: window.__r(s.post.temperature),
      uniformStyle: g.uniforms.uFloorStyle.value,
      uniformFloor: g.uniforms.uFloorColor.value.getHexString(),
      hud: sel ? sel.value : null
    };
  })()`;

  // ---- the HUD menu ----------------------------------------------------
  const table = await ctx.evaluate(`(() => {
    const sel = document.querySelector('[data-scene-select]');
    return {
      current: window.__settings.environment.background,
      floorStyle: window.__settings.environment.floorStyle,
      hudOptions: sel ? [...sel.options].map((o) => ({ value: o.value, text: o.textContent })) : null
    };
  })()`);

  rec('hud-menu', table);

  expect(table.hudOptions !== null, 'the HUD carries a scene picker', table.hudOptions);

  const wantLabels = ['幽暗舞台', '黄昏海滩', '正午沙漠', '极地雪原', '火山焦土', '虚空网格'];
  const gotLabels = (table.hudOptions ?? []).map((o) => o.text);
  const missingLabels = wantLabels.filter((l) => !gotLabels.includes(l));
  expect(missingLabels.length === 0, 'the picker offers every background by its Chinese label', {
    missing: missingLabels,
    got: gotLabels
  });

  const gotValues = (table.hudOptions ?? []).map((o) => o.value);
  expect(
    gotValues.join(',') === 'stage,beach,desert,tundra,caldera,void',
    'the option values are the settings keys, in declaration order',
    gotValues
  );

  // ---- the editor menu -------------------------------------------------
  // Read controllers through `getValue()`, not `$display`: the display node is
  // an implementation detail of whichever controller class lil-gui picked, and
  // a disabled string controller does not have the one an option controller
  // does. `getValue()` is the accessor every controller has.
  const gui = await ctx.evaluate(`(() => {
    const all = window.app.editor.gui.controllersRecursive();
    const byLabel = (label) => all.find((c) => c.$name && c.$name.textContent === label) ?? null;
    const bg = byLabel('场景背景');
    const hint = byLabel('说明');
    const style = byLabel('地面图案');
    const describe = (c) =>
      c && c.$select
        ? {
            isSelect: c.$select.tagName === 'SELECT',
            options: [...c.$select.options].map((o) => o.textContent),
            selected: c.$select.selectedIndex,
            value: c.getValue()
          }
        : null;
    return {
      bg: describe(bg),
      style: describe(style),
      hint: hint ? String(hint.getValue()) : null,
      // The hint is a disabled string row: lil-gui has no subtitle, so a
      // read-only controller is how this panel has always carried prose.
      hintDisabled: hint ? hint.$disable.disabled === true : null,
      inEnvironmentFolder:
        window.app.editor.gui
          .foldersRecursive()
          .some((f) => f.$title.textContent.trim() === '环境' && f.controllersRecursive().includes(bg))
    };
  })()`);

  rec('editor-menu', gui);

  expect(gui.bg !== null && gui.bg.isSelect, 'the editor has its own 场景背景 dropdown', gui.bg);
  expect(gui.style !== null && gui.style.isSelect, 'the editor has a 地面图案 dropdown', gui.style);

  const sorted = (a) => [...a].sort().join('|');
  expect(
    sorted(gui.bg?.options ?? []) === sorted(gotLabels) && gotLabels.length > 0,
    'both menus offer the same six backgrounds',
    { hud: sorted(gotLabels), editor: sorted(gui.bg?.options ?? []) }
  );

  expect(
    typeof gui.hint === 'string' && gui.hint.length > 4,
    'a 说明 row explains the current background',
    gui.hint
  );

  // ---- picking from the HUD actually changes the scene -----------------
  const before = await ctx.evaluate(snapshot('stage'));

  /**
   * Step real frames. `app.__fast` counts frames, not seconds — the harness's
   * `fast(seconds, dt)` divides, which is easy to misread here. Three frames is
   * enough for the ground's per-frame uniform write to land.
   */
  const step = (frames = 3) => ctx.evaluate(`(window.app.__fast(${frames}, 1 / 60), true)`);

  /**
   * Drive the HUD select the way a user does: set the value and fire `change`.
   */
  const pickHud = async (key) => {
    await ctx.evaluate(`(() => {
      const sel = document.querySelector('[data-scene-select]');
      sel.value = ${JSON.stringify(key)};
      sel.dispatchEvent(new Event('change'));
      return sel.value;
    })()`);
    await step(3);
    return ctx.evaluate(snapshot(key));
  };

  const picked = {};
  for (const key of ['beach', 'desert', 'tundra', 'caldera', 'void']) {
    picked[key] = await pickHud(key);
    rec(key, picked[key]);
  }

  expect(
    picked.beach.name === 'beach' &&
      picked.beach.sun !== before.sun &&
      picked.beach.fogColor !== before.fogColor &&
      picked.beach.exposure !== before.exposure,
    'picking 黄昏海滩 moves the sun, the fog and the grade together',
    { before: { sun: before.sun, fogColor: before.fogColor, exposure: before.exposure },
      after: { sun: picked.beach.sun, fogColor: picked.beach.fogColor, exposure: picked.beach.exposure } }
  );

  // FLOOR_STYLES order is stone, sand, snow, ash, grid — the shader switches on
  // the index, so the name and the uniform have to agree or the ground wears a
  // different pattern from the one the menu claims.
  const wantStyles = [
    ['beach', 'sand', 1],
    ['desert', 'sand', 1],
    ['tundra', 'snow', 2],
    ['caldera', 'ash', 3],
    ['void', 'grid', 4]
  ];
  const badStyles = wantStyles.filter(
    ([key, style, idx]) => picked[key].floorStyle !== style || picked[key].uniformStyle !== idx
  );
  expect(badStyles.length === 0, 'the floor pattern follows the background into the shader', {
    wrong: badStyles.map(
      ([k, s, i]) => `${k}: name=${picked[k].floorStyle} uniform=${picked[k].uniformStyle} want ${s}/${i}`
    )
  });

  const floorHexes = new Set(Object.values(picked).map((p) => p.uniformFloor));
  expect(floorHexes.size >= 4, 'the floor colour uniform moves between backgrounds', {
    distinct: floorHexes.size,
    values: [...floorHexes]
  });

  const wrongName = Object.entries(picked).filter(([k, v]) => v.name !== k);
  expect(wrongName.length === 0, 'no pick lands on the wrong background', {
    wrong: wrongName.map(([k, v]) => `${k} -> ${v.name}`)
  });

  const staleSelect = Object.entries(picked).filter(([k, v]) => v.hud !== k);
  expect(staleSelect.length === 0, 'the HUD select shows what it just set', {
    wrong: staleSelect.map(([k, v]) => `${k} but select reads ${v.hud}`)
  });

  // ---- the two menus agree ---------------------------------------------
  const afterHudPick = await ctx.evaluate(`(() => {
    const all = window.app.editor.gui.controllersRecursive();
    const byLabel = (label) => all.find((c) => c.$name && c.$name.textContent === label) ?? null;
    const bg = byLabel('场景背景');
    const read = (label) => {
      const c = byLabel(label);
      return c ? String(c.getValue()) : null;
    };
    return {
      editorValue: bg ? String(bg.getValue()) : null,
      editorIndex: bg ? bg.$select.selectedIndex : null,
      editorHint: byLabel('说明') ? String(byLabel('说明').getValue()) : null,
      sun: read('主光强度'),
      exposure: read('曝光')
    };
  })()`);

  rec('hud-to-editor', afterHudPick);

  expect(afterHudPick.editorValue === 'void', 'the editor menu follows a change made from the HUD', afterHudPick);

  // The panel is refreshed explicitly after a switch. Without that the sliders
  // keep showing the previous background's numbers, which reads as the switch
  // having half-failed.
  expect(
    Number(afterHudPick.sun) === picked.void.sun && Number(afterHudPick.exposure) === picked.void.exposure,
    'the editor sliders are refreshed, not stale',
    {
      panel: { sun: afterHudPick.sun, exposure: afterHudPick.exposure },
      live: { sun: picked.void.sun, exposure: picked.void.exposure }
    }
  );

  // ---- and the other direction -----------------------------------------
  const pickEditor = async (label) => {
    await ctx.evaluate(`(() => {
      const all = window.app.editor.gui.controllersRecursive();
      const c = all.find((x) => x.$name && x.$name.textContent === '场景背景');
      const idx = [...c.$select.options].findIndex((o) => o.textContent === ${JSON.stringify(label)});
      c.$select.selectedIndex = idx;
      c.$select.dispatchEvent(new Event('change'));
      return idx;
    })()`);
    await step(3);
    return ctx.evaluate(snapshot(label));
  };

  const fromEditor = await pickEditor('火山焦土');
  rec('editor-to-hud', fromEditor);

  expect(
    fromEditor.name === 'caldera' && fromEditor.hud === 'caldera',
    'the HUD chip follows a change made from the editor',
    { name: fromEditor.name, hud: fromEditor.hud }
  );

  // ---- visual evidence -------------------------------------------------
  // The numeric assertions above prove the uniforms moved. They cannot prove the
  // shader branch draws anything, which is the one part of this feature that is
  // only checkable by looking.
  await ctx.evaluate(`(() => {
    document.querySelectorAll('.hud').forEach((el) => { el.style.display = 'none'; });
    window.app.editor.gui.domElement.style.display = 'none';
    window.__settings.camera.distance = 13.5;
    return true;
  })()`);

  for (const [key, name] of [
    ['stage', 'stone'],
    ['beach', 'sand'],
    ['caldera', 'ash'],
    ['void', 'grid']
  ]) {
    await pickHud(key);
    await step(6);
    rec(`shot bg-${key}`, await ctx.shot(`bg-${key}-${name}`));
  }

  // ---- the pattern can be changed on its own ---------------------------
  // Floor style is deliberately decoupled from the background: a sand floor
  // under a night sky is a legitimate combination, and pinning the two together
  // would forbid it.
  const stylePick = await ctx.evaluate(`(() => {
    const all = window.app.editor.gui.controllersRecursive();
    const c = all.find((x) => x.$name && x.$name.textContent === '地面图案');
    if (!c) return { found: false };
    const options = [...c.$select.options].map((o) => o.textContent);
    const idx = options.findIndex((t) => t === '石板');
    c.$select.selectedIndex = idx;
    c.$select.dispatchEvent(new Event('change'));
    return { found: true, options, idx };
  })()`);

  await step(3);

  const afterStyle = await ctx.evaluate(
    `({ style: window.__settings.environment.floorStyle,
        uniform: window.app.ground.uniforms.uFloorStyle.value,
        background: window.__settings.environment.background })`
  );

  rec('style-decoupled', { stylePick, afterStyle });

  expect(
    stylePick.found && ['石板', '沙地', '积雪', '焦土', '网格'].every((l) => stylePick.options.includes(l)),
    '地面图案 offers all five patterns in Chinese',
    stylePick.options
  );

  expect(
    afterStyle.style === 'stone' && afterStyle.uniform === 0 && afterStyle.background === 'void',
    'the pattern can be changed without switching the background',
    afterStyle
  );

  // ---- unknown names must not half-switch ------------------------------
  const guard = await ctx.evaluate(`(() => {
    const s = window.__settings;
    const snapshotBefore = JSON.stringify(s.environment);
    const ok = window.app.setBackground('definitely-not-a-background');
    return { ok, unchanged: JSON.stringify(s.environment) === snapshotBefore };
  })()`);

  expect(
    guard.ok === false && guard.unchanged,
    'an unknown background name is refused, not half-applied',
    guard
  );

  // ---- back to stage, losslessly ---------------------------------------
  const back = await pickHud('stage');

  const drift = Object.keys(before).filter((k) => k !== 'label' && before[k] !== back[k]);
  expect(drift.length === 0, 'switching back to 幽暗舞台 restores the shipped look', {
    drifted: drift.map((k) => `${k}: ${before[k]} -> ${back[k]}`)
  });

  return { backgrounds: Object.keys(picked).length };
}
