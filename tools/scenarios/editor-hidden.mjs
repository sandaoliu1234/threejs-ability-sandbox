/**
 * Editor panel default-visibility check.
 *
 * The panel now starts hidden. The failure mode worth guarding is a desync
 * between the Editor's `_hidden` flag and lil-gui's real visibility: `toggle()`
 * flips `_hidden` and then calls `show(!_hidden)`, so if the constructor only
 * called `gui.hide()` without setting `_hidden = true`, the first `G` press
 * would compute show(false) again and the panel could never be opened.
 *
 * Harness notes: driver calls `default(ctx)`; no `page`; `#loader` is a
 * z-index:100 full-viewport overlay that must fade before input is meaningful.
 */

export default async function (ctx) {
  const results = [];
  const check = (label, pass, detail) => {
    results.push({ label, pass: !!pass, detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };
  const js = (expr) => ctx.evaluate(`(() => { ${expr} })()`);

  // Wait out the boot overlay before touching the page.
  await ctx.evaluate(`
    new Promise((resolve) => {
      const el = document.getElementById('loader');
      if (!el) return resolve('no loader');
      if (el.classList.contains('is-hidden')) return resolve('hidden');
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (el.classList.contains('is-hidden') || Date.now() - t0 > 20000) {
          clearInterval(iv);
          resolve('done');
        }
      }, 100);
    })
  `);
  await ctx.sleep(900);

  const state = () =>
    js(`
      const ed = window.app.editor;
      const el = ed.gui.domElement;
      const cs = getComputedStyle(el);
      return {
        hiddenFlag: ed._hidden,
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        offsetParent: el.offsetParent !== null,
        rectW: Math.round(el.getBoundingClientRect().width)
      };
    `);

  const isVisible = (s) =>
    s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && s.rectW > 0;

  // --- 1. Starts hidden ------------------------------------------------
  const start = await state();
  check(
    'panel starts hidden',
    !isVisible(start),
    `display=${start.display} visibility=${start.visibility} opacity=${start.opacity} width=${start.rectW}`
  );
  check(
    '_hidden flag matches (no desync)',
    start.hiddenFlag === true,
    `_hidden = ${start.hiddenFlag}`
  );

  // --- 2. First G press must OPEN it -----------------------------------
  const pressG = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await ctx.send('Input.dispatchKeyEvent', {
        type,
        key: 'g',
        code: 'KeyG',
        windowsVirtualKeyCode: 71,
        nativeVirtualKeyCode: 71,
      });
    }
    await ctx.sleep(220);
  };

  await pressG();
  const afterFirst = await state();
  check(
    'first G press opens the panel',
    isVisible(afterFirst),
    `display=${afterFirst.display} visibility=${afterFirst.visibility} width=${afterFirst.rectW}`
  );
  check(
    '_hidden flag flipped to false',
    afterFirst.hiddenFlag === false,
    `_hidden = ${afterFirst.hiddenFlag}`
  );

  // --- 3. Second G press closes it again -------------------------------
  await pressG();
  const afterSecond = await state();
  check(
    'second G press hides it again',
    !isVisible(afterSecond),
    `display=${afterSecond.display} visibility=${afterSecond.visibility}`
  );
  check(
    '_hidden flag back to true',
    afterSecond.hiddenFlag === true,
    `_hidden = ${afterSecond.hiddenFlag}`
  );

  // --- 4. Folders stay collapsed (the pre-existing behaviour) ----------
  await pressG(); // reopen so folders can be inspected
  const folders = await js(`
    const all = window.app.editor.gui.foldersRecursive();
    return {
      total: all.length,
      open: all.filter((f) => f._closed === false).map((f) => f.$title?.textContent?.trim() ?? '?')
    };
  `);
  check(
    'all folders still collapsed',
    folders.open.length === 0,
    `${folders.open.length} open of ${folders.total}: [${folders.open.slice(0, 5).join(', ')}]`
  );

  await ctx.shot('editor-hidden-final');
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n  ${passed}/${results.length} checks passed`);
  return { results, passed, total: results.length };
}
