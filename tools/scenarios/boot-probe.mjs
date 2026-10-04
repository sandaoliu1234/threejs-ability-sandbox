/**
 * Boot probe: does the page reach `window.app` at all, how long does it take,
 * and does the renderer actually produce frames? Nothing here mutates state.
 */

export default async function (ctx) {
  const { evaluate, shot, sleep } = ctx;

  const report = { ready: ctx.ready };
  report.progressText = await evaluate(`(() => {
    const l = document.getElementById('loader-status');
    return l ? l.textContent : null;
  })()`).catch((e) => `threw: ${e.message}`);
  report.loaderHidden = await evaluate(`document.getElementById('loader')?.getAttribute('aria-hidden') ?? null`).catch((e) => `threw: ${e.message}`);
  report.webgl = await evaluate(`(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return gl ? { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER) } : 'no context';
  })()`).catch((e) => `threw: ${e.message}`);

  // Watch the frame counter for a second: if it does not advance, the loop is dead.
  const a = await evaluate(`(() => {
    const x = window.app;
    if (!x) return { noApp: true };
    return { elapsed: +x.elapsed.toFixed(2), frames: x.renderer.gl.info.render.frame, calls: x.renderer.gl.info.render.calls };
  })()`).catch((e) => ({ threw: e.message }));
  report.appA = a;
  await sleep(1500);
  report.appB = await evaluate(`(() => {
    const x = window.app;
    if (!x) return { noApp: true };
    return { elapsed: +x.elapsed.toFixed(2), frames: x.renderer.gl.info.render.frame, calls: x.renderer.gl.info.render.calls };
  })()`).catch((e) => ({ threw: e.message }));

  report.canvasSize = await evaluate(`(() => {
    const c = document.getElementById('viewport');
    return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight };
  })()`).catch((e) => ({ threw: e.message }));

  await shot('boot-probe');

  // Is the canvas actually drawing anything? Sample the centre pixel.
  report.pixel = await evaluate(`(() => {
    const app = window.app;
    if (!app) return { noApp: true };
    const gl = app.renderer.gl.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(4);
    gl.readPixels((w / 2) | 0, (h / 2) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w, h, px: Array.from(px), glError: gl.getError() };
  })()`).catch((e) => ({ threw: e.message }));

  return report;
}
