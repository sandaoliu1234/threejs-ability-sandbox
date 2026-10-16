/**
 * Right-drag orbit regression check.
 *
 * Reverting the orbit gesture from Ctrl+left back to right-drag moves the
 * binding onto a button that USED to mean "cancel", so the interesting cases
 * are the two that share it: a right-click must still cancel, and a right-drag
 * must rotate without cancelling. Neither regression is visible to the build.
 *
 * Contract notes for this harness:
 *   - the driver imports and calls `default(ctx)`, there is no `run` export
 *   - there is no `page`; raw CDP goes through `ctx.send`, JS through `ctx.evaluate`
 *   - `ctx.evaluate` must return JSON-serialisable values
 */

export default async function (ctx) {
  const results = [];

  const check = (label, pass, detail) => {
    results.push({ label, pass: !!pass, detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };

  // Synchronous expression eval, JSON-safe.
  const js = (expr) => ctx.evaluate(`(() => { ${expr} })()`);

  // --- 1. OrbitControls must claim RIGHT and leave LEFT free -------------
  const binding = await js(`
    const rig = window.app?.rig;
    if (!rig) return { error: 'rig not on window.app' };
    const mb = rig.controls.mouseButtons;
    return { left: mb.LEFT, middle: mb.MIDDLE, right: mb.RIGHT, rotate: 0 };
  `);

  if (binding.error) {
    check('cameraRig reachable', false, binding.error);
    return { results };
  }
  check(
    'RIGHT is bound to orbit',
    binding.right === binding.rotate,
    `mouseButtons.RIGHT = ${binding.right} (want ${binding.rotate})`
  );
  check(
    'LEFT stays unbound (so bare left-click casts)',
    binding.left === null,
    `LEFT = ${binding.left}`
  );

  // --- 2. No leftover Ctrl-era machinery --------------------------------
  const leftovers = await js(`
    const rig = window.app?.rig;
    return {
      fn: typeof rig?._syncMouseButtons,
      handlers: ['_onOrbitPointerDown','_onOrbitPointerUp','_onOrbitKey']
        .filter((k) => rig?.[k] !== undefined)
    };
  `);
  check(
    'Ctrl-era helpers are gone',
    leftovers.fn === 'undefined' && leftovers.handlers.length === 0,
    `_syncMouseButtons=${leftovers.fn}, leftover handlers=[${leftovers.handlers}]`
  );

  // --- 3. DRAG_SLOP declared --------------------------------------------
  const slop = await js(`return window.app?.input?.constructor?.DRAG_SLOP;`);
  check('DRAG_SLOP declared', typeof slop === 'number' && slop > 0, `DRAG_SLOP = ${slop}`);

  // Instrument emit() once so cancel/confirm counts can be read later.
  await js(`
    const input = window.app.input;
    window.__cancelCount = 0;
    window.__confirmCount = 0;
    if (!input.__instrumented) {
      const orig = input.emit.bind(input);
      input.emit = (evt, ...rest) => {
        if (evt === 'action' && rest[0] === 'cancel') window.__cancelCount++;
        if (evt === 'pointer:confirm') window.__confirmCount++;
        return orig(evt, ...rest);
      };
      input.__instrumented = true;
    }
    return true;
  `);

  // Camera *position* is a bad observable here: `App.update` calls
  // `rig.setAnchor()` + `rig.update()` every frame, and `CameraRig.update`
  // rebuilds `camera.position` from `controls.target` + `this.distance`. Any
  // rotation the drag applied is folded into the spherical offset before we
  // could sample the absolute position, so read the orbit angle itself.
  const camPos = () =>
    js(`
      const rig = window.app.rig;
      const c = rig.camera;
      const t = rig.controls.target;
      const dx = c.position.x - t.x, dy = c.position.y - t.y, dz = c.position.z - t.z;
      return {
        azimuth: Math.atan2(dx, dz),
        polar: Math.atan2(Math.hypot(dx, dz), dy),
        radius: Math.hypot(dx, dy, dz)
      };
    `);

  // `window.app` is set by main.js before the boot overlay is dismissed, and
  // `#loader` is a fixed z-index:100 full-viewport layer, so every synthetic
  // pointer event dispatched before it fades would land on the overlay instead
  // of the canvas. Wait for `is-hidden` (applied 220ms after load) plus the
  // 0.7s opacity/visibility transition before touching anything.
  const loaderGone = await ctx.evaluate(`
    new Promise((resolve) => {
      const el = document.getElementById('loader');
      if (!el) return resolve('no loader element');
      const done = () => el.classList.contains('is-hidden');
      if (done()) return resolve('already hidden');
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (done() || Date.now() - t0 > 20000) {
          clearInterval(iv);
          resolve(done() ? 'hidden after ' + (Date.now() - t0) + 'ms' : 'TIMEOUT');
        }
      }, 100);
    })
  `);
  check('boot overlay dismissed', loaderGone !== 'TIMEOUT', String(loaderGone));
  await ctx.sleep(900); // let the 0.7s transition finish

  // Hit-test for a point on the canvas that is NOT covered by HUD/editor DOM.
  // `InputManager._onPointerDown` (and OrbitControls) ignore events whose target
  // is UI, so dispatching at screen centre can land on a panel and silently do
  // nothing. Probe a few candidates and take the first real canvas hit.
  const probe = await js(`
    const canvas = window.app.input.dom;
    const cands = [
      [0.5, 0.5], [0.35, 0.5], [0.65, 0.5],
      [0.5, 0.28], [0.5, 0.72], [0.3, 0.75], [0.7, 0.72]
    ];
    const hits = [];
    for (const [fx, fy] of cands) {
      const x = Math.round(window.innerWidth * fx);
      const y = Math.round(window.innerHeight * fy);
      const el = document.elementFromPoint(x, y);
      hits.push({ x, y, target: el === canvas ? 'canvas' : (el?.className || el?.tagName || 'unknown') });
    }
    return { hits, canvasTag: canvas.tagName };
  `);

  const spot = probe.hits.find((h) => h.target === 'canvas');
  check(
    'found a canvas-free point to dispatch at',
    !!spot,
    spot
      ? `(${spot.x}, ${spot.y}) hits canvas`
      : `all candidates covered by UI: ${probe.hits.map((h) => h.target).join(', ')}`
  );
  if (!spot) return { results };

  const cx = spot.x;
  const cy = spot.y;
  const reset = () => js(`window.__cancelCount = 0; window.__confirmCount = 0; return true;`);

  /** Drive a real right-button gesture through raw CDP mouse events. */
  const rightGesture = async (steps) => {
    await ctx.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: cx,
      y: cy,
      button: 'right',
      buttons: 2,
      clickCount: 1,
    });
    for (const [dx, dy] of steps) {
      await ctx.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: cx + dx,
        y: cy + dy,
        button: 'right',
        buttons: 2,
      });
      await ctx.sleep(16);
    }
    await ctx.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: cx + (steps.at(-1)?.[0] ?? 0),
      y: cy + (steps.at(-1)?.[1] ?? 0),
      button: 'right',
      buttons: 0,
      clickCount: 1,
    });
    await ctx.sleep(220);
  };

  // --- 4. Right-DRAG must rotate the camera and NOT cancel --------------
  const before = await camPos();
  await rightGesture([
    [12, 3],
    [24, 6],
    [36, 9],
    [48, 12],
    [60, 15],
    [72, 18],
    [84, 21],
  ]);
  const after = await camPos();
  const counts = await js(
    `return { cancel: window.__cancelCount, confirm: window.__confirmCount };`
  );

  // Azimuth is the meaningful observable: a horizontal drag must swing the
  // camera around the character. Polar barely moves for this mostly-X drag, and
  // radius is pinned by the distance enforcement, so neither is asserted.
  const deltaAz = Math.abs(after.azimuth - before.azimuth);
  check(
    'right-drag rotates the camera',
    deltaAz > 0.05,
    `|Δazimuth| = ${deltaAz.toFixed(4)} rad (before ${before.azimuth.toFixed(3)}, after ${after.azimuth.toFixed(3)})`
  );
  check('right-drag does NOT cancel', counts.cancel === 0, `cancel fired ${counts.cancel}x`);

  // --- 5. Right-CLICK with no movement must still cancel ----------------
  await reset();
  await rightGesture([]);
  const clickCancel = await js(`return window.__cancelCount;`);
  check('right-click still cancels', clickCancel === 1, `cancel fired ${clickCancel}x (want 1)`);

  // --- 6. Sub-slop jitter must count as a click, not a drag -------------
  await reset();
  await rightGesture([[3, 2]]); // 3.6px < 6px slop
  const jitterCancel = await js(`return window.__cancelCount;`);
  check(
    '3.6px jitter still counts as a click',
    jitterCancel === 1,
    `cancel fired ${jitterCancel}x (want 1)`
  );

  // --- 7. Bare left-click still casts, with no modifier -----------------
  await reset();
  await ctx.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: cx,
    y: cy,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await ctx.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: cx,
    y: cy,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await ctx.sleep(180);
  const confirms = await js(`return window.__confirmCount;`);
  check(
    'bare left-click still casts (no Ctrl needed)',
    confirms === 1,
    `pointer:confirm fired ${confirms}x (want 1)`
  );

  await ctx.shot('orbit-right-final');

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n  ${passed}/${results.length} checks passed`);
  return { results, passed, total: results.length, cameraDelta: deltaAz };
}
