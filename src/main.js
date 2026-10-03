import { App } from './core/App.js';
import { LoadingScreen } from './ui/HUD.js';

/**
 * Entry point.
 *
 * Everything interesting lives in `core/App.js`; this file only wires the app
 * to the page and reports fatal boot errors somewhere the user can see them.
 */
const canvas = document.getElementById('viewport');

async function boot() {
  try {
    const app = new App(canvas);
    await app.load();

    // Handy for poking at the scene from the console.
    window.app = app;
  } catch (error) {
    console.error('[boot] failed to start', error);
    new LoadingScreen().fail(
      error?.message ? `启动失败：${error.message}` : '启动失败 —— 详情请查看控制台。'
    );
  }
}

boot();
