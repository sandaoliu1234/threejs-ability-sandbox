import { App } from './core/App.js';
import { LoadingScreen } from './ui/HUD.js';
import { settings } from './config/settings.js';
import { sfx } from './audio/Sound.js';

/**
 * Entry point.
 *
 * Everything interesting lives in `core/App.js`; this file only wires the app
 * to the page and reports fatal boot errors somewhere the user can see them.
 */
const canvas = document.getElementById('viewport');

/**
 * The live settings object is the app's public API (see README), but it lives
 * behind a module import, so a console or an automated smoke test cannot reach
 * it. Hand it to `window` on a local dev server only — never on a deployed
 * origin, where it would just be a global for anyone to scribble on.
 *
 * `sfx` rides along for the same reason: "there is no sound" is almost always
 * `sfx.ctx === null` (no gesture reached the window yet), and being able to ask
 * that from the console — or from a test that has to tell a silent mix apart
 * from a broken one — is worth one more local-only global.
 */
function exposeDevHooks(app) {
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|10\.|192\.168\.)/.test(window.location.hostname);
  if (!local) return;
  window.app = app;
  window.__settings = settings;
  window.__sfx = sfx;
}

async function boot() {
  try {
    const app = new App(canvas);
    await app.load();

    // Handy for poking at the scene from the console.
    exposeDevHooks(app);
  } catch (error) {
    console.error('[boot] failed to start', error);
    new LoadingScreen().fail(
      error?.message ? `启动失败：${error.message}` : '启动失败 —— 详情请查看控制台。'
    );
  }
}

boot();
