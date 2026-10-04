/**
 * Shared harness for the staged scenarios.
 *
 * ## Why it exists
 *
 * `App.frame()` is cheap except for its last two calls, `contactShadows.render()`
 * and `post.render()`. Under SwiftShader those cost ~400ms a frame, so the app
 * advances at about a tenth of wall time (measured: 0.102 app seconds per wall
 * second) and every test that waits for something to happen becomes a test of
 * patience.
 *
 * Two things fix that, and both are needed:
 *
 * `install()` **freezes the live clock** — `time.tick` returns 0, so the rAF
 * loop keeps drawing but nothing advances. Without this, real frames run in the
 * gaps between one `evaluate` round-trip and the next and quietly corrupt any
 * assertion with a tolerance on it (a few hundred milliseconds of walking or
 * regenerating, unaccounted for). With it, the simulation only moves when the
 * scenario says so.
 *
 * `fast(seconds)` then advances it on a **fixed step** with the two render calls
 * stubbed, running the *real* `App.frame()`. Simulation, pooling, damage,
 * drops, HUD readouts and the input layer are all exactly the code that ships;
 * only the pixels are skipped. Ten seconds of swarm movement lands in about two
 * seconds of wall time instead of a hundred, and because the step is fixed it is
 * deterministic.
 *
 * Screenshots still need the real render path, which the rAF loop is still
 * running — it just draws a frozen world, which is what a screenshot wants.
 */

export function harness(ctx) {
  const trace = ctx.trace ?? (() => {});
  const failures = [];
  const steps = [];

  const rec = (name, value) => {
    const brief = typeof value === 'object' && value !== null ? JSON.stringify(value).slice(0, 220) : String(value);
    trace(name, brief);
    steps.push({ name, value });
  };

  const expect = (ok, what, detail) => {
    if (!ok) failures.push({ where: what, message: `assertion failed: ${JSON.stringify(detail)}` });
    trace(`assert ${ok ? 'PASS' : 'FAIL'} ${what}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 200));
    return ok;
  };

  const probe = async (name, fn, args = []) => {
    try {
      const value = await ctx.call(fn, ...args);
      rec(name, value);
      return value;
    } catch (error) {
      const message = String(error.message || error);
      failures.push({ where: name, message });
      rec(name, { __probeFailed: message });
      return null;
    }
  };

  /** Poll a page-side predicate until it returns truthy, or give up. */
  const waitFor = async (expr, { timeoutMs = 60000, every = 400, label = expr } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await ctx.evaluate(expr).catch((error) => ({ __err: String(error.message || error) }));
      if (last && last !== false && !last.__err) return last;
      await ctx.sleep(every);
    }
    trace(`waitFor TIMEOUT (${label})`, JSON.stringify(last).slice(0, 200));
    return last;
  };

  /**
   * Install the fixed-step driver and freeze the live clock. Safe to call more
   * than once; the driver itself is idempotent.
   */
  const install = async () => {
    const ok = await ctx.evaluate(`(() => {
      const app = window.app;
      if (!app) return false;
      if (app.__fast) { app.__freeze(); return true; }

      const time = app.time;
      const post = app.post;
      const shadows = app.contactShadows;
      const realTick = time.tick.bind(time);
      const frozen = () => 0;
      const realPost = post.render.bind(post);
      const realShadow = shadows.render.bind(shadows);

      let inside = false;
      app.__freeze = () => { if (!inside) time.tick = frozen; };
      app.__unfreeze = () => { if (!inside) time.tick = realTick; };
      app.__fast = (count, dt) => {
        const restore = time.tick;
        inside = true;
        time.tick = () => dt;
        post.render = () => {};
        shadows.render = () => {};
        try {
          for (let i = 0; i < count; i++) app.frame();
        } finally {
          time.tick = restore;
          post.render = realPost;
          shadows.render = realShadow;
          inside = false;
        }
        return app.elapsed;
      };
      app.__freeze();
      return true;
    })()`);
    if (!ok) throw new Error('harness: window.app is not there to instrument');
    return ok;
  };

  /** Hand the clock back to the browser (rarely wanted: it un-determinises). */
  const unfreeze = () => ctx.evaluate('(window.app.__unfreeze(), true)');

  /**
   * Advance the simulation by `seconds` of app time and report where the body
   * ended up. `dt` is the fixed step; 1/60 keeps every interpolator (lean,
   * flash decay, the fall) in its normal regime, so nothing ever sees a step
   * larger than a real frame at 60fps.
   *
   * The displacement is measured inside the page, across the loop, because
   * measuring it from here would include whatever the render loop did in
   * between.
   */
  const fast = async (seconds, dt = 1 / 60) => {
    const count = Math.max(1, Math.round(seconds / dt));
    return ctx.call((n, step) => {
      const app = window.app;
      const p = app.character.position;
      const x0 = p.x;
      const z0 = p.z;
      const elapsed0 = app.elapsed;
      app.__fast(n, step);
      return {
        seconds: +(app.elapsed - elapsed0).toFixed(4),
        dx: +(p.x - x0).toFixed(4),
        dz: +(p.z - z0).toFixed(4),
        metres: +Math.hypot(p.x - x0, p.z - z0).toFixed(4),
        x: +p.x.toFixed(4),
        z: +p.z.toFixed(4),
        ground: +Math.hypot(p.x, p.z).toFixed(4)
      };
    }, count, dt);
  };

  /**
   * Same fixed-step driver, but it keeps a trace: `body` is the source of a
   * page-side function of `(app, i, out)` whose result is pushed per frame.
   *
   * This exists because some things are only visible *during* a transient — the
   * somersault's hop arc and rotation sweep, a death fall, a flash decaying.
   * Sampling before and after a run would miss the whole event, and a
   * screenshot costs four seconds of wall time and blocks the loop it is meant
   * to observe.
   */
  const sample = async (body, seconds, dt = 1 / 60) => {
    const count = Math.max(1, Math.round(seconds / dt));
    return ctx.call((src, n, step) => {
      const app = window.app;
      const time = app.time;
      const post = app.post;
      const shadows = app.contactShadows;
      const restore = time.tick;
      const realPost = post.render.bind(post);
      const realShadow = shadows.render.bind(shadows);
      const read = new Function('app', 'i', 'out', src);
      const out = [];
      time.tick = () => step;
      post.render = () => {};
      shadows.render = () => {};
      try {
        for (let i = 0; i < n; i++) {
          app.frame();
          out.push(read(app, i, out));
        }
      } finally {
        time.tick = restore;
        post.render = realPost;
        shadows.render = realShadow;
      }
      return out;
    }, body, count, dt);
  };

  const appElapsed = () => ctx.evaluate('window.app.elapsed');

  return { ctx, trace, failures, steps, rec, expect, probe, waitFor, install, unfreeze, fast, sample, appElapsed };
}

/** Round to n places, for readable report values. */
export const round = (value, places = 2) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

export default harness;
