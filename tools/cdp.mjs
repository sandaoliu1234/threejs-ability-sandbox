/**
 * Minimal CDP driver for smoke-testing the sandbox in a real browser.
 *
 * Launches headless Chrome with the DevTools protocol, navigates to the dev
 * server, records every console message / exception / failed request, and then
 * exposes a `Runtime.evaluate` bridge so a scenario script can poke the live
 * app (`window.app`) between frames.
 *
 * Usage:
 *   node tools/cdp.mjs <scenario.mjs> [--url=...] [--shots=dir] [--keep]
 *
 * A scenario module default-exports `async (ctx) => {}`, where ctx = {
 *   evaluate(expr)  -> Promise<value>     // JSON-serialised across the wire
 *   call(fn, ...args)                     // evaluate a function with args
 *   shot(name)      -> Promise<filePath>  // page screenshot
 *   viewport(w, h)                        // resize the layout viewport mid-run
 *   send(method, params)                  // raw CDP, session-scoped
 *   errors, warnings, logs, requests      // collected telemetry (live arrays)
 *   sleep(ms)
 * }
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const a of args) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags.set(m[1], m[2] ?? 'true');
  else positional.push(a);
}

const scriptPath = positional[0];
if (!scriptPath) {
  console.error('usage: node tools/cdp.mjs <scenario.mjs> [--url=...] [--shots=dir]');
  process.exit(2);
}

const URL_TO_OPEN = flags.get('url') ?? 'http://127.0.0.1:5199/';
const SHOT_DIR = resolve(flags.get('shots') ?? 'output/playwright');
const KEEP = flags.get('keep') === 'true';
const PORT = Number(flags.get('port') ?? 9333);
const READY_TIMEOUT = Number(flags.get('readyTimeout') ?? 45000);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

async function waitForDevtools(timeoutMs = 20000) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeoutMs) {
    try {
      return await fetchJson('/json/version');
    } catch (e) {
      lastErr = e;
      await sleep(200);
    }
  }
  throw new Error(`devtools endpoint never came up: ${lastErr?.message}`);
}

/* ------------------------------------------------------------------ */
/* Launch                                                              */
/* ------------------------------------------------------------------ */

const { existsSync } = await import('node:fs');

const chromePath =
  CHROME_CANDIDATES.find((c) => existsSync(c)) ?? null;
if (!chromePath) {
  console.error('No Chrome/Edge binary found. Set CHROME_PATH.');
  process.exit(3);
}

const userDataDir = join(process.env.TEMP ?? '/tmp', `dsh-cdp-${PORT}`);
const chromeArgs = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--window-size=1600,900',
  '--hide-scrollbars',
  '--mute-audio',
  // The sandbox's sound is procedural and starts suspended until a gesture
  // (correctly so — see audio/Sound.js). A test that has to fake a gesture
  // before it can hear anything is testing the autoplay policy, not the mix,
  // so take the gesture out of the equation. Output still goes to the null
  // sink, which is what `--mute-audio` above buys.
  '--autoplay-policy=no-user-gesture-required',
  'about:blank'
];

const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });

let ws = null;
let msgId = 0;
const pending = new Map();
const errors = [];
const warnings = [];
const logs = [];
const requests = [];
const badResponses = [];
const redirects = [];

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

function fmtRemote(obj) {
  if (!obj) return '';
  if (obj.value !== undefined) return typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value);
  if (obj.description) return obj.description;
  if (obj.unserializableValue) return obj.unserializableValue;
  return obj.type ?? '';
}

async function main() {
  const version = await waitForDevtools();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
      else res(msg.result);
      return;
    }
    const { method, params } = msg;
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args ?? []).map(fmtRemote).join(' ');
      const rec = { type: params.type, text };
      if (params.type === 'error') errors.push(`console.error: ${text}`);
      else if (params.type === 'warning') warnings.push(text);
      else logs.push(rec);
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      const stack = (d.stackTrace?.callFrames ?? [])
        .slice(0, 4)
        .map((f) => `    at ${f.functionName || '<anon>'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
        .join('\n');
      errors.push(`Uncaught ${d.exception?.description ?? d.text}\n${stack}`);
    } else if (method === 'Log.entryAdded') {
      const e = params.entry;
      if (e.level === 'error') errors.push(`[${e.source}] ${e.text}`);
      else if (e.level === 'warning') warnings.push(`[${e.source}] ${e.text}`);
    } else if (method === 'Network.loadingFailed') {
      // ERR_ABORTED is the browser cancelling its own speculative fetches, not
      // a broken asset; only real failures belong in the report.
      if (params.errorText && !params.errorText.includes('ERR_ABORTED')) {
        requests.push(`${params.type} ${params.errorText}`);
      }
    } else if (method === 'Network.responseReceived') {
      const { status, url, mimeType } = params.response ?? {};
      if (status >= 400) badResponses.push(`${status} ${url} (${mimeType ?? '?'})`);
      else if (status >= 300 && status < 400) redirects.push(`${status} ${url} → ${params.response.headers?.Location ?? ''}`);
    }
  });

  // Discover the page target created for about:blank.
  let targets = await fetchJson('/json/list');
  let page = targets.find((t) => t.type === 'page');
  if (!page) {
    await sleep(400);
    targets = await fetchJson('/json/list');
    page = targets.find((t) => t.type === 'page');
  }
  if (!page) throw new Error('no page target');

  const attach = await send('Target.attachToTarget', { targetId: page.id, flatten: true });
  const session = attach.sessionId;

  await send('Runtime.enable', {}, session);
  await send('Log.enable', {}, session);
  await send('Network.enable', {}, session);
  await send('Page.enable', {}, session);
  // Pin the layout viewport: headless screenshots otherwise depend on the
  // window manager, which makes before/after comparisons meaningless.
  await send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: Number(flags.get('width') ?? 1280),
      height: Number(flags.get('height') ?? 720),
      deviceScaleFactor: 1,
      mobile: false
    },
    session
  );

  mkdirSync(SHOT_DIR, { recursive: true });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Timestamped progress on stderr: when a scenario stalls, the last line names
  // the step it stalled on, which a final report never can.
  const t0 = Date.now();
  const trace = (what, extra = '') => {
    process.stderr.write(`[cdp +${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}${extra ? ' ' + extra : ''}\n`);
  };

  const evaluate = async (expression, timeoutMs = 20000) => {
    // A page-side infinite loop (or a paused render loop holding the main
    // thread) would otherwise hang the driver until the watchdog. Fail the one
    // probe instead, so the rest of the scenario still runs.
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`evaluate timed out after ${timeoutMs}ms: ${expression.slice(0, 120)}`)), timeoutMs);
    });
    try {
      const r = await Promise.race([
        send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true, userGesture: true },
          session
        ),
        timeout
      ]);
      if (r.exceptionDetails) {
        throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      }
      return r.result?.value;
    } finally {
      clearTimeout(timer);
    }
  };

  const shot = async (name) => {
    const started = Date.now();
    const r = await send('Page.captureScreenshot', { format: 'png' }, session);
    const file = join(SHOT_DIR, `${name}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    const ms = Date.now() - started;
    trace(`shot ${name}`, `${ms}ms ${(r.data.length / 1024) | 0}KB`);
    return file;
  };

  // Navigate.
  const loaded = new Promise((res) => {
    const onLoad = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Page.loadEventFired') {
        ws.removeEventListener('message', onLoad);
        res();
      }
    };
    ws.addEventListener('message', onLoad);
  });
  await send('Page.navigate', { url: URL_TO_OPEN }, session);
  await Promise.race([loaded, sleep(15000)]);

  // Wait for the app to finish booting (`window.app` is set by main.js after
  // `app.load()` resolves).
  const readyStart = Date.now();
  let ready = false;
  while (Date.now() - readyStart < READY_TIMEOUT) {
    ready = await evaluate('!!window.app').catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  trace('app ready', `=${ready} after ${((Date.now() - readyStart) / 1000).toFixed(1)}s`);

  const ctx = {
    evaluate,
    async call(fn, ...fnArgs) {
      const expr = `(${fn.toString()})(${fnArgs.map((a) => JSON.stringify(a)).join(',')})`;
      return evaluate(expr);
    },
    shot,
    // Resize the layout viewport mid-run: a responsive HUD has to be checked at
    // several widths, and relaunching Chrome per width costs ~15s each time.
    async viewport(w, h) {
      await send(
        'Emulation.setDeviceMetricsOverride',
        { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: false },
        session
      );
      // One layout pass must complete before anything measures it.
      await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      await sleep(120);
    },
    send: (method, params) => send(method, params, session),
    sleep: async (ms) => {
      await sleep(ms);
    },
    trace,
    errors,
    warnings,
    logs,
    requests,
    badResponses,
    redirects,
    ready,
    url: URL_TO_OPEN
  };

  const mod = await import(pathToFileURL(resolve(scriptPath)).href);

  // The watchdog only has to cover the scenario body; once that resolves the
  // driver exits on its own. A browser that is slow to quit must not turn a
  // finished run into "watchdog fired".
  const watchdog = setTimeout(() => {
    console.error('cdp.mjs watchdog fired while the scenario was still running');
    try { chrome.kill(); } catch {}
    process.exit(4);
  }, Number(flags.get('watchdog') ?? 600000));
  watchdog.unref?.();

  let result;
  try {
    result = await mod.default(ctx);
  } finally {
    clearTimeout(watchdog);
  }

  if (!KEEP) {
    try {
      await send('Browser.close', {}, undefined);
    } catch {}
  }
  chrome.kill();

  const report = { url: URL_TO_OPEN, ready, result, errors, warnings, requests, badResponses };
  console.log('\n===CDP-REPORT===');
  console.log(JSON.stringify(report, null, 2));
  console.log('===END-REPORT===');
  process.exit(errors.length ? 1 : 0);
}

// The watchdog lives inside main(), scoped to the scenario body — see there.

main().catch(async (err) => {
  console.error('driver error:', err?.stack ?? err);
  try { chrome.kill(); } catch {}
  process.exit(5);
});
