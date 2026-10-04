/**
 * Stage 1 鈥?procedural sound.
 *
 * There are no audio files to check, so the assertions are about the contract
 * the rest of the code relies on:
 *
 *   - before the first gesture every verb is a silent no-op (the loading screen
 *     must not throw), and `unlock()` on the first keydown builds the graph;
 *   - every verb the HUD, the abilities, the minions and the shake call exists
 *     and does not throw, with the arguments they actually pass;
 *   - `settings.audio` is the live mix: the editor's sliders read through the
 *     same `_gain()` the envelopes multiply by, so muting is one flag;
 *   - the retrigger gate keeps a dozen simultaneous hits from stacking into one
 *     click.
 *
 * What it cannot check is whether it *sounds* right 鈥?that needs ears. It can
 * check that the graph is running and that each verb schedules nodes.
 */
import { harness } from './_harness.mjs';

/** Verbs with the arguments their real call sites pass. */
const CALLS = [
  ['cast', 'ice'],
  ['cast', 'thunder'],
  ['cast', 'meteor'],
  ['cast', 'beam'],
  ['cast', 'snare'],
  ['cast', 'glacier'],
  ['cast', 'banknote'],
  ['cast', 'implosion'],
  ['cast', 'tether'],
  ['impact', 0.9],
  ['hit'],
  ['death'],
  ['hurt'],
  ['dash'],
  ['pickup'],
  ['heal'],
  ['boss'],
  ['ui', 1.2],
  ['holdStart', 'implosion'],
  ['holdStart', 'tether'],
  ['channelTick'],
  ['reaction'],
  ['gameOver']
];

export default async function (ctx) {
  const h = harness(ctx);
  await h.install();

  /* --- 1. the pre-gesture contract ---------------------------------- */

  const before = await ctx.evaluate(`(() => {
    const sfx = window.__sfx;
    return sfx ? { ctx: sfx.ctx === null, state: sfx.ctx?.state ?? null } : null;
  })()`);

  if (before === null) {
    h.rec('audio singleton reachable from the page', false);
    h.expect(false, 'the page exposes the sound singleton', { hint: 'window.__sfx is undefined' });
    return { failures: h.failures, steps: h.steps };
  }

  h.rec('before any gesture', before);
  h.expect(before.ctx === true, 'no AudioContext is built before a gesture', before);

  // Every verb must survive being called with no context at all.
  const silent = await h.probe('verbs before unlock are no-ops', (calls) => {
    const sfx = window.__sfx;
    let thrown = null;
    for (const [name, arg] of calls) {
      try {
        sfx[name](arg);
      } catch (error) {
        thrown = `${name}: ${error.message}`;
        break;
      }
    }
    return { thrown, built: sfx.ctx !== null };
  }, [CALLS]);
  h.expect(silent?.thrown === null, 'every verb is silent-safe before unlock', silent);
  h.expect(silent?.built === false, 'a silent verb does not build the context', silent);

  /* --- 2. the real gesture path ------------------------------------- */

  // Drive the wiring the app actually installed: App._bindEvents puts
  // `sfx.unlock()` on window keydown, so a trusted key event must build it.
  await ctx.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
    nativeVirtualKeyCode: 87
  });
  await ctx.sleep(120);

  const afterGesture = await ctx.evaluate(`(() => {
    const sfx = window.__sfx;
    return { built: sfx.ctx !== null, state: sfx.ctx?.state ?? null, sampleRate: sfx.ctx?.sampleRate ?? null, noise: !!sfx.noise, master: !!sfx.master };
  })()`);
  h.rec('after a keydown', afterGesture);
  h.expect(afterGesture.built === true, 'the keydown handler builds the audio graph', afterGesture);
  h.expect(afterGesture.noise === true && afterGesture.master === true, 'the graph has its master gain and noise buffer', afterGesture);

  await ctx.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });

  // A suspended context is resumed by a second unlock; either state is fine as
  // long as it is not stuck closed.
  await ctx.evaluate('window.__sfx.unlock()');
  const state = await ctx.evaluate('window.__sfx.ctx.state');
  h.rec('context state after resume', state);
  h.expect(state !== 'closed', 'the context is alive', { state });

  /* --- 3. every verb, on a live graph ------------------------------- */

  const live = await h.probe('every verb on a live graph', (calls) => {
    const sfx = window.__sfx;
    const failures = [];
    for (const [name, arg] of calls) {
      try {
        sfx[name](arg);
      } catch (error) {
        failures.push(`${name}(${arg ?? ''}): ${error.message}`);
      }
    }
    return { tested: calls.length, failures, state: sfx.ctx.state };
  }, [CALLS]);
  h.expect(live?.failures?.length === 0, 'all 23 verbs schedule without throwing', live);

  /* --- 4. settings own the mix -------------------------------------- */

  const mix = await h.probe('the mix reads settings.audio live', () => {
    const sfx = window.__sfx;
    const audio = window.__settings.audio;
    const saved = { enabled: audio.enabled, master: audio.master, cast: audio.cast };
    const read = () => ({
      enabled: audio.enabled,
      master: audio.master,
      cast: audio.cast,
      gainCast: +sfx._gain('cast').toFixed(4),
      gainNone: +sfx._gain().toFixed(4)
    });
    const asShipped = read();
    audio.enabled = false;
    const muted = read();
    audio.enabled = true;
    audio.master = 0.25;
    audio.cast = 0.5;
    const quiet = read();
    Object.assign(audio, saved);
    return { asShipped, muted, quiet, restored: read() };
  });
  h.rec('mix at shipped settings', mix?.asShipped);
  h.rec('mix muted', mix?.muted);
  h.rec('mix at master 0.25 / cast 0.5', mix?.quiet);
  h.expect(mix?.asShipped?.gainCast > 0, 'the shipped master is audible', mix?.asShipped);
  h.expect(mix?.muted?.gainCast === 0, 'audio.enabled=false silences every channel', mix?.muted);
  h.expect(
    mix?.quiet?.gainCast === 0.125 && mix?.quiet?.gainNone === 0.25,
    'master multiplies the channel, and channel defaults to 1',
    mix?.quiet
  );
  h.expect(mix?.restored?.enabled === true && mix?.restored?.master !== 0.25, 'the probe put the mix back', mix?.restored);

  /* --- 5. the retrigger gate ---------------------------------------- */

  const gate = await h.probe('the retrigger gate throttles a burst', () => {
    const sfx = window.__sfx;
    sfx._last.delete('__probe');
    return {
      first: sfx._gate('__probe', 0.08),
      immediate: sfx._gate('__probe', 0.08),
      third: sfx._gate('__probe', 0.08)
    };
  });
  h.rec('gate on a burst of three', gate);
  h.expect(gate?.first === true && gate?.immediate === false && gate?.third === false, 'a burst of hits plays once', gate);

  /* --- 6. per-element cast voices differ --------------------------- */

  const voices = await h.probe('each element has its own cast voice', () => {
    const sfx = window.__sfx;
    const ids = ['ice', 'thunder', 'meteor', 'beam', 'snare', 'glacier', 'banknote', 'implosion', 'tether'];
    const seen = {};
    for (const id of ids) {
      sfx._last.delete(`cast:${id}`);
      sfx.cast(id);
      seen[id] = sfx._last.has(`cast:${id}`);
    }
    return seen;
  });
  h.rec('cast gate keys seen', voices);
  h.expect(voices != null && Object.values(voices).every((v) => v === true), 'each element gates under its own name', voices);

  return {
    failures: h.failures,
    steps: h.steps,
    console: { errors: ctx.errors, warnings: ctx.warnings.length }
  };
}
