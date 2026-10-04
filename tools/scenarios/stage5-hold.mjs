/**
 * Stage 5 of the six-stage pass — the two hold mechanics.
 *
 * `implosion` (Z) is a charge: hold to grow a collapse, let go to drop it.
 * `tether` (N) is a channel: hold to weld a beam to the cursor and grind
 * whatever stands on the line.
 *
 * What this locks down:
 *   - the registry still lists nine elements and the aim indicator knows which
 *     of them are aimed by holding (`aim.holdToCast`);
 *   - `implosion`'s aim circle measures out its `radiusMin`, not the one-metre
 *     fallback that a missing `zoneRadius` used to leave it with;
 *   - a *tap* is a legal cast of a hold element — the degenerate hold, zero
 *     charge, released the same frame (this used to throw and leak the pooled
 *     instance, because `HoldAbility` has no `spawn` of its own);
 *   - a body that throws on its way out of the pool still goes home;
 *   - charge accumulates on the simulation clock and saturates at `chargeMax`;
 *   - damage is linear in the charge and the radius is an ease-*out* of it,
 *     and the radius is real: what it promises is what takes the hit;
 *   - the cooldown is paid on the release, never on the press;
 *   - an aborted hold spends nothing at all;
 *   - the tether's first tick is immediate (no travel time), its ticks are
 *     `tickInterval` apart and worth exactly `tickDamage`, and the band follows
 *     the cursor mid-channel.
 *
 * The clock is frozen throughout, so every charge below is a fixed number of
 * frames. `AimController.release()` measures its `charge` on `performance.now()`
 * for the toast's benefit only — the number that lands damage is
 * `HoldAbility.charge`, which accumulates on `dt`. That is why the sweep can be
 * simulated here at all.
 */
import { harness, round } from './_harness.mjs';

export default async function (ctx) {
  const h = harness(ctx);
  await h.install();

  await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;

    // The harness's round() is a driver-side import; the page needs its own.
    window.round = (v, places = 3) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(places) : v);

    window.__keep5 = {
      minionsEnabled: s.minions.enabled,
      health: s.minions.health,
      critChance: s.minions.critChance,
      damageTaken: s.minions.damageTaken,
      separateStrength: s.minions.separateStrength,
      speedJitter: s.minions.speedJitter,
      attackDamage: s.minions.attack.damage,
      rangedEnabled: s.minions.ranged.enabled,
      everyNWaves: s.minions.boss.everyNWaves,
      reactionsEnabled: s.reactions.enabled,
      implosionCooldown: s.implosion.cooldown,
      tetherCooldown: s.tether.cooldown
    };

    /**
     * An empty stage: no minions, no loot, no cooldowns, no live abilities, the
     * caster at the origin and at full health.
     *
     * 120 frames, because clearAll() cannot touch a body that was killed:
     * vanish() returns early on a body already in dying, and a corpse then takes
     * its full fallTime + deadPause + sinkTime = 1.7 s. Too short a sweep leaves
     * a corpse at active[0] and every index below points at it.
     */
    window.__floor = () => {
      app.aim.cancel();
      app.abilities.clear();
      app.minions.clearAll();
      app.minions.waveCount = 0;
      s.minions.enabled = false;
      app.drops.clear();
      // A key left down by an earlier block keeps the caster walking through
      // every __fast, which drags the aim origin — and with it the hold target
      // — away from under any victim parked on the current aim point. The
      // symptom is damage arriving low by exactly a falloff factor.
      app.input.keys.clear();
      app.player.reset();
      app.character.setDead(false);
      app.character.resetPlacement();
      app.character.root.position.set(0, 0, 0);
      app.hud.hideDeath();
      for (const key of [...app.cooldowns.keys()]) app.cooldowns.set(key, 0);
      app.__fast(120, 1 / 60);
      if (app.minions.active.length) {
        throw new Error('floor not clear: ' + app.minions.active.length + ' bodies');
      }
      if (app.abilities.active.length) {
        throw new Error('abilities not clear: ' + app.abilities.active.length);
      }
      return true;
    };

    /** Pin the numbers the arithmetic needs, then restore with __restore5. */
    window.__pin = (health) => {
      s.minions.enabled = false;
      s.minions.health = health;
      s.minions.critChance = 0;
      s.minions.damageTaken = 1;
      s.minions.separateStrength = 0;
      s.minions.speedJitter = 0;
      s.minions.attack.damage = 0;
      s.minions.ranged.enabled = false;
      s.minions.boss.everyNWaves = 0;
      // Stage 6 owns reactions; here they would silently multiply a payoff.
      s.reactions.enabled = false;
      return true;
    };

    window.__restore5 = () => {
      const k = window.__keep5;
      s.minions.enabled = k.minionsEnabled;
      s.minions.health = k.health;
      s.minions.critChance = k.critChance;
      s.minions.damageTaken = k.damageTaken;
      s.minions.separateStrength = k.separateStrength;
      s.minions.speedJitter = k.speedJitter;
      s.minions.attack.damage = k.attackDamage;
      s.minions.ranged.enabled = k.rangedEnabled;
      s.minions.boss.everyNWaves = k.everyNWaves;
      s.reactions.enabled = k.reactionsEnabled;
      s.implosion.cooldown = k.implosionCooldown;
      s.tether.cooldown = k.tetherCooldown;
      return true;
    };

    /**
     * Point the aim at a chosen ground distance. The resolve runs through the
     * same raycaster the mouse uses, so this is the real targeting path and not
     * a stub — it just searches the screen for the NDC row that lands 'want'
     * metres out instead of waiting for a human to move the mouse there.
     */
    window.__aimAt = (want) => {
      const a = app.aim;
      let best = null;
      const seen = [];
      for (let i = 0; i <= 360; i++) {
        const y = 0.9 - (i / 360) * 1.8;
        a.point({ x: 0, y });
        a._resolve();
        if (!a.valid) continue;
        const d = a.distance;
        seen.push(+d.toFixed(2));
        if (best === null || Math.abs(d - want) < Math.abs(best.distance - want)) {
          best = { y: +y.toFixed(4), distance: +d.toFixed(3) };
        }
      }
      if (!best) return { ok: false, seen: seen.slice(0, 8) };
      a.point({ x: 0, y: best.y });
      a._resolve();
      return { ok: true, y: best.y, distance: +a.distance.toFixed(3), valid: a.valid, range: seen.length, target: window.__aimTarget() };
    };

    /**
     * Where the hold is actually being aimed. App.js:673 re-feeds
     * setHoldTarget from the live aim every frame, so a hold's target is the
     * aim's target and *not* whatever a test last set by hand: a victim parked
     * on a hand-picked coordinate is a victim the beam never touches.
     */
    window.__aimTarget = () => {
      const a = app.aim;
      return {
        x: +(a.origin.x + a.direction.x * a.distance).toFixed(4),
        z: +(a.origin.z + a.direction.z * a.distance).toFixed(4)
      };
    };

    /** A point t of the way from the caster to the aim target. */
    window.__aimLine = (t) => {
      const T = window.__aimTarget();
      return { x: +(T.x * t).toFixed(4), z: +(T.z * t).toFixed(4) };
    };

    /** A point "offset" metres to the side of the aim target. */
    window.__aimSide = (offset) => {
      const T = window.__aimTarget();
      const len = Math.hypot(T.x, T.z) || 1;
      // Perpendicular to the heading, in the ground plane.
      return {
        x: +(T.x + (-T.z / len) * offset).toFixed(4),
        z: +(T.z + (T.x / len) * offset).toFixed(4)
      };
    };

    /**
     * Swing the wrist by moving the pointer, then push the new aim into the
     * hold so it takes effect this frame rather than the next.
     */
    window.__swing = (element, ndcX) => {
      const a = app.aim;
      a.point({ x: ndcX, y: a._pointer.y });
      a._resolve();
      app.abilities.setHoldTarget(element, a.origin, a.direction, a.distance);
      return window.__aimTarget();
    };

    /** Arm an element through the same call the HUD uses. */
    window.__arm = (element) => {
      app.armAbility(element);
      return {
        element: app.element,
        armed: app.aim.isArmed,
        holdToCast: app.aim.holdToCast,
        zone: round(app.aim.zoneRadius, 3),
        radiusMin: round(s[app.element].radiusMin ?? -1, 3)
      };
    };

    /** The live hold body for an element, or null. */
    window.__hold = (element) => {
      const b = app.abilities.holds.get(element);
      if (!b) return null;
      return {
        phase: b.phase,
        charge: round(b.charge, 4),
        charge01: round(b.charge01, 4),
        radius: round(b.radius, 4),
        target: [+b.target.x.toFixed(3), +b.target.z.toFixed(3)],
        visible: b.group.visible,
        element: b.element
      };
    };

    window.__holds = () => [...app.abilities.holds.keys()];
    /**
     * The live body for an element, found in the manager's active list rather
     * than the hold registry. Releasing deletes the registry entry the instant
     * the payoff starts, so anything that has to be read *after* the release —
     * the phase it is discharging in — has to come from here.
     */
    window.__live = (element) => app.abilities.active.find((b) => b.element === element) ?? null;
    window.__pool = (element) => {
      const p = app.abilities.pools.get(element);
      return { free: p.free.length, active: p.activeCount };
    };
    window.__inActive = (element) => app.abilities.active.filter((b) => b.element === element).length;
    window.__cooldown = (element) => round(app.cooldowns.get(element) ?? 0, 4);

    /**
     * One parked body that cannot bite and is immune to separation. It is NOT
     * immune to walking: a CROWD body closes on the caster, so over a long
     * hold it drifts off the point it was parked on.
     */
    window.__dummy = (x, z, hp) => {
      app.minions._spawnWave(1);
      const m = app.minions.active[app.minions.active.length - 1];
      m.phase = 'crowd';
      m.age = 0;
      m.root.position.set(x, 0, z);
      m.root.rotation.y = Math.atan2(-x, -z);
      m.maxHp = hp;
      m.hp = hp;
      m.flash = 0;
      m.stagger = 0;
      m._attackTimer = 9999;
      m._slamTimer = 9999;
      m._knockX = 0;
      m._knockZ = 0;
      m.sepX = 0;
      m.sepZ = 0;
      // A pooled body keeps the last life's element memory. Clear it, or the
      // reaction system quietly multiplies the payoff being measured.
      m.statusElement = null;
      m.statusTimer = 0;
      return { index: app.minions.active.length - 1, hp: m.hp, at: [+x.toFixed(2), +z.toFixed(2)] };
    };

    window.__hp = (index) => round(app.minions.active[index].hp, 4);

    /**
     * Put a parked body back where the query is about to look. A CROWD body
     * walks at the caster, so after a held charge it has drifted off the point
     * it was parked on — and the collapse then clips it off-centre, reporting a
     * falloff-discounted payoff. Call this after the frames, immediately before
     * the release, when the test is measuring the charge curve rather than the
     * walking.
     */
    window.__park = (index, at) => {
      const m = app.minions.active[index];
      m.root.position.set(at.x, 0, at.z);
      m._knockX = 0;
      m._knockZ = 0;
      return [+at.x.toFixed(2), +at.z.toFixed(2)];
    };

    /** Count and time the tether's ticks without touching what they do. */
    window.__watchSegment = () => {
      const m = app.minions;
      window.__segCalls = [];
      if (!window.__segReal) window.__segReal = m.damageSegment.bind(m);
      m.damageSegment = (from, to, width, damage, options) => {
        window.__segCalls.push({
          i: window.__segCalls.length,
          elapsed: round(app.elapsed, 4),
          damage,
          width,
          element: options && options.element ? options.element : null,
          to: [+to.x.toFixed(2), +to.z.toFixed(2)]
        });
        return window.__segReal(from, to, width, damage, options);
      };
      return true;
    };
    window.__unwatchSegment = () => {
      if (window.__segReal) delete app.minions.damageSegment;
      return true;
    };
    window.__ticks = () => window.__segCalls;

    return true;
  })()`);

  /* ------------------------------------------------------------------ */
  /* 1. the registry, and how each element is aimed                      */
  /* ------------------------------------------------------------------ */

  await ctx.evaluate('window.__floor()');
  const registry = await ctx.evaluate(`(() => {
    const app = window.app;
    const out = {};
    for (const id of ['implosion', 'tether', 'ice', 'snare']) out[id] = window.__arm(id);
    return { elements: app.abilities.elements, out };
  })()`);
  h.rec('how each element is aimed', registry);
  h.expect(
    registry.elements.length === 9 &&
      registry.elements.includes('implosion') &&
      registry.elements.includes('tether'),
    'the registry still lists all nine elements',
    { elements: registry.elements }
  );
  h.expect(
    registry.out.implosion.holdToCast === true && registry.out.tether.holdToCast === true,
    'both new elements are press-and-hold',
    { implosion: registry.out.implosion.holdToCast, tether: registry.out.tether.holdToCast }
  );
  h.expect(
    registry.out.ice.holdToCast === false && registry.out.snare.holdToCast === false,
    'and the older elements stay click-to-cast',
    { ice: registry.out.ice.holdToCast, snare: registry.out.snare.holdToCast }
  );
  h.expect(
    registry.out.implosion.zone === registry.out.implosion.radiusMin,
    "implosion's aim circle measures out its own radiusMin, not the 1 m fallback",
    { zone: registry.out.implosion.zone, radiusMin: registry.out.implosion.radiusMin }
  );

  /* ------------------------------------------------------------------ */
  /* 2. a tap is a legal cast (this used to throw and leak)              */
  /* ------------------------------------------------------------------ */

  const taps = await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    const out = [];
    for (const id of ['implosion', 'tether']) {
      window.__floor();
      const before = window.__pool(id);
      let body = null;
      let threw = null;
      try {
        body = app.abilities.cast({ x: 0, y: 0, z: 1.4 }, { x: 0, y: 0, z: 1 }, 6, id);
      } catch (error) {
        threw = error.message;
      }
      out.push({
        id,
        threw,
        gotBody: !!body,
        phase: body ? body.phase : null,
        visible: body ? body.group.visible : null,
        charge: body ? round(body.charge, 4) : null,
        radius: body ? round(body.radius, 3) : null,
        radiusMin: s[id].radiusMin ?? null,
        active: app.abilities.active.length,
        before,
        afterCast: window.__pool(id)
      });
    }
    return out;
  })()`);
  h.rec('tapping both hold elements', taps);
  for (const t of taps) {
    h.expect(t.threw === null && t.gotBody === true, 'tapping ' + t.id + ' does not throw', t);
    h.expect(t.phase === 'release', 'and the tap goes straight to its payoff', { id: t.id, phase: t.phase });
    h.expect(t.visible === true, 'with its group made visible', { id: t.id, visible: t.visible });
    h.expect(t.charge === 0, 'a tap is a zero-charge hold', { id: t.id, charge: t.charge });
    h.expect(
      t.active === 1 && t.afterCast.active - t.before.active === 1,
      'and exactly one body is out on loan from the pool',
      { id: t.id, active: t.active, before: t.before, after: t.afterCast }
    );
  }
  h.expect(
    taps[0].radius === 3.2 && taps[0].radiusMin === 3.2,
    'the tap collapse is the minimum radius',
    { radius: taps[0].radius, radiusMin: taps[0].radiusMin }
  );

  const recycle = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__floor();
    app.abilities.cast({ x: 0, y: 0, z: 1.4 }, { x: 0, y: 0, z: 1 }, 6, 'implosion');
    const during = { active: app.abilities.active.length, pool: window.__pool('implosion') };
    app.__fast(60, 1 / 60);
    return { during, after: { active: app.abilities.active.length, pool: window.__pool('implosion') }, burstLife: window.__settings.implosion.burstLife };
  })()`);
  h.rec('a tap retiring itself', recycle);
  h.expect(
    recycle.during.active === 1 && recycle.during.pool.active === 1,
    'a tap sits in the active list while its shell lives',
    recycle.during
  );
  h.expect(
    recycle.after.active === 0 && recycle.after.pool.active === 0,
    'and retires itself back to the pool when the shell is done',
    recycle.after
  );

  const flood = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__floor();
    let threw = null;
    try {
      for (let i = 0; i < 6; i++) app.abilities.cast({ x: 0, y: 0, z: 1.4 }, { x: 0, y: 0, z: 1 }, 5 + i, 'implosion');
    } catch (error) {
      threw = error.message;
    }
    return { threw, active: app.abilities.active.length, pool: window.__pool('implosion') };
  })()`);
  h.expect(
    flood.threw === null && flood.active === 4,
    'six taps in a row retire the oldest and settle on MAX_CONCURRENT',
    flood
  );

  /* ------------------------------------------------------------------ */
  /* 3. a body that throws on its way out still goes home                */
  /* ------------------------------------------------------------------ */

  const leak = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__floor();
    const pool = app.abilities.pools.get('implosion');
    const scout = pool.acquire();
    const proto = Object.getPrototypeOf(scout);
    pool.release(scout);
    const before = { free: pool.free.length, active: pool.activeCount, live: app.abilities.active.length };

    proto.spawn = () => {
      throw new Error('boom');
    };
    let message = null;
    try {
      app.abilities.cast({ x: 0, y: 0, z: 1.4 }, { x: 0, y: 0, z: 1 }, 6, 'implosion');
    } catch (error) {
      message = error.message;
    }
    delete proto.spawn;

    const after = { free: pool.free.length, active: pool.activeCount, live: app.abilities.active.length };
    // The pool is still usable: the next honest tap goes through.
    let recovered = null;
    try {
      recovered = app.abilities.cast({ x: 0, y: 0, z: 1.4 }, { x: 0, y: 0, z: 1 }, 6, 'implosion').phase;
    } catch (error) {
      recovered = 'threw: ' + error.message;
    }
    return { before, after, message, recovered };
  })()`);
  h.rec('the leak guard', leak);
  h.expect(leak.message === 'boom', 'a body that throws on spawn propagates the error', { message: leak.message });
  h.expect(
    leak.after.free === leak.before.free && leak.after.active === leak.before.active,
    'but it is handed back to the pool on the way out, not leaked',
    { before: leak.before, after: leak.after }
  );
  h.expect(leak.after.live === leak.before.live, 'and it never enters the active list', {
    before: leak.before.live,
    after: leak.after.live
  });
  h.expect(leak.recovered === 'release', 'the pool still works afterwards', { phase: leak.recovered });

  /* ------------------------------------------------------------------ */
  /* 4. the charge accumulates on the simulation clock                   */
  /* ------------------------------------------------------------------ */

  const charge = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__floor();
    window.__pin(5000);
    const aim = window.__aimAt(6);
    const arm = window.__arm('implosion');
    const pressed = app.aim.press();
    const steps = [];
    const snap = (tag) => steps.push({ tag, hold: window.__hold('implosion'), appHold: app.hold, cooldown: window.__cooldown('implosion') });
    snap('pressed');
    app.__fast(30, 1 / 60);
    snap('0.5s');
    app.__fast(30, 1 / 60);
    snap('1.0s');
    app.__fast(60, 1 / 60);
    snap('2.0s');
    app.__fast(60, 1 / 60);
    snap('3.0s');
    return { aim, arm, pressed, steps, chargeMax: window.__settings.implosion.chargeMax, released: app.aim.release() };
  })()`);
  h.rec('the charge clock', charge);
  h.expect(charge.aim.ok === true, 'the aim resolves a legal ground target', charge.aim);
  h.expect(charge.pressed === true, 'the press opens a hold', { pressed: charge.pressed });
  h.expect(
    charge.steps[0].hold.phase === 'hold' && charge.steps[0].hold.charge === 0,
    'a hold opens at zero charge',
    charge.steps[0].hold
  );
  h.expect(
    charge.steps[0].appHold === 'implosion' && charge.steps[0].hold.element === 'implosion',
    'and the app remembers which element is holding',
    { appHold: charge.steps[0].appHold, element: charge.steps[0].hold.element }
  );
  const expected = [
    { tag: '0.5s', charge: 0.5, charge01: 0.25 },
    { tag: '1.0s', charge: 1.0, charge01: 0.5 },
    { tag: '2.0s', charge: 2.0, charge01: 1.0 },
    { tag: '3.0s', charge: 3.0, charge01: 1.0 }
  ];
  for (let i = 0; i < expected.length; i++) {
    const step = charge.steps[i + 1];
    const want = expected[i];
    h.expect(
      step.tag === want.tag && Math.abs(step.hold.charge - want.charge) < 1e-6 && step.hold.charge01 === want.charge01,
      'at ' + want.tag + ' of holding the charge reads ' + want.charge + ' and saturates to ' + want.charge01,
      { got: step.hold, want }
    );
  }
  h.expect(
    charge.steps.every((s) => s.cooldown === 0),
    'nothing is charged to the cooldown while the button is still down',
    { cooldowns: charge.steps.map((s) => s.cooldown) }
  );

  /* ------------------------------------------------------------------ */
  /* 5. damage is linear in the charge, the radius eases out of it,      */
  /*    and the radius is real                                           */
  /* ------------------------------------------------------------------ */

  const payoff = await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    const out = [];
    // charge01 targets, and the frames of holding that produce each one.
    for (const shot of [{ k: 0, frames: 0 }, { k: 0.25, frames: 30 }, { k: 0.5, frames: 60 }, { k: 1.0, frames: 120 }]) {
      window.__floor();
      window.__pin(5000);
      window.__aimAt(6);
      window.__arm('implosion');
      app.aim.press();
      // Park the victim where the hold is genuinely aimed. Placing it by hand
      // would be pointless: App.js:673 re-feeds the target from the live aim
      // every frame, so the collapse lands on the aim's point, not on mine.
      const at = window.__aimLine(1);
      const dummy = window.__dummy(at.x, at.z, 5000);
      if (shot.frames) app.__fast(shot.frames, 1 / 60);
      const held = window.__hold('implosion');
      // Back onto the live aim point, which the probe proves does not move
      // while the button is down — the body is what moved.
      window.__park(dummy.index, window.__aimLine(1));
      const hpBefore = window.__hp(dummy.index);
      app.aim.release();
      const hpAfter = window.__hp(dummy.index);
      out.push({
        want: shot.k,
        frames: shot.frames,
        charge: held.charge,
        charge01: held.charge01,
        // __hold() hands back a snapshot rather than the live body, so taking it
        // after the frames and before the release captures the radius onHold
        // just wrote — the one onRelease will commit.
        radius: round(held.radius, 4),
        target: held.target,
        aimedAt: [+at.x.toFixed(2), +at.z.toFixed(2)],
        hpBefore,
        hpAfter,
        damage: round(hpBefore - hpAfter, 3),
        cooldown: window.__cooldown('implosion')
      });
    }
    return {
      out,
      damageMin: s.implosion.damageMin,
      damageMax: s.implosion.damageMax,
      radiusMin: s.implosion.radiusMin,
      radiusMax: s.implosion.radiusMax,
      burstLife: s.implosion.burstLife
    };
  })()`);
  h.rec('the payoff at four charges', payoff);
  for (const shot of payoff.out) {
    const span = payoff.damageMax - payoff.damageMin;
    const wantDamage = payoff.damageMin + span * shot.want;
    h.expect(
      Math.abs(shot.damage - wantDamage) < 0.01,
      'a ' + shot.want + '-charge collapse lands damageMin + span*charge = ' + wantDamage,
      { damage: shot.damage, want: wantDamage }
    );
  }
  h.expect(
    payoff.out[0].radius === payoff.radiusMin && payoff.out[3].radius === payoff.radiusMax,
    'the radius runs exactly radiusMin to radiusMax across the charge',
    { smallest: payoff.out[0].radius, largest: payoff.out[3].radius, radiusMin: payoff.radiusMin, radiusMax: payoff.radiusMax }
  );
  const midSpan = payoff.radiusMax - payoff.radiusMin;
  h.expect(
    payoff.out[2].radius - payoff.radiusMin > midSpan * 0.5 + 1e-3,
    'and it eases out rather than linearly — half a charge is past half the growth',
    {
      atHalf: round(payoff.out[2].radius - payoff.radiusMin, 4),
      linearWouldBe: round(midSpan * 0.5, 4)
    }
  );
  h.expect(
    payoff.out[3].cooldown === 6,
    'the release is what pays the cooldown',
    { cooldown: payoff.out[3].cooldown, setting: 6 }
  );

  const geometry = await ctx.evaluate(`(() => {
    const app = window.app;
    const out = [];
    for (const shot of [{ k: 0, frames: 0, inner: 1.6, outer: 4.2 }, { k: 1.0, frames: 120, inner: 4.5, outer: 10.5 }]) {
      window.__floor();
      window.__pin(5000);
      window.__aimAt(6);
      window.__arm('implosion');
      app.aim.press();
      // Sideways of the aim point, so the offsets are measured from the centre
      // of the collapse without walking the victims into bite range.
      const centre = window.__aimLine(1);
      const near = window.__dummy(centre.x, centre.z, 5000);
      const inAt = window.__aimSide(shot.inner);
      const outAt = window.__aimSide(shot.outer);
      const inside = window.__dummy(inAt.x, inAt.z, 5000);
      const outside = window.__dummy(outAt.x, outAt.z, 5000);
      if (shot.frames) app.__fast(shot.frames, 1 / 60);
      const body = window.__hold('implosion');
      // Every probe back where it was aimed, since all three have been walking
      // at the caster for the length of the charge.
      window.__park(near.index, window.__aimLine(1));
      window.__park(inside.index, window.__aimSide(shot.inner));
      window.__park(outside.index, window.__aimSide(shot.outer));
      const before = [near, inside, outside].map((d) => window.__hp(d.index));
      app.aim.release();
      const after = [near, inside, outside].map((d) => window.__hp(d.index));
      out.push({
        k: shot.k,
        radius: round(body.radius, 4),
        centreHit: round(before[0] - after[0], 2),
        insideHit: round(before[1] - after[1], 2),
        outsideHit: round(before[2] - after[2], 2),
        innerAt: shot.inner,
        outerAt: shot.outer
      });
    }
    return out;
  })()`);
  h.rec('the footprint at both ends of the charge', geometry);
  for (const g of geometry) {
    h.expect(
      g.centreHit > 0 && g.insideHit > 0,
      'a body well inside the collapse takes it (radius ' + g.radius + ')',
      g
    );
    h.expect(g.outsideHit === 0, 'and a body outside the collapse is untouched', g);
  }
  h.expect(
    geometry[1].insideHit > 0 && geometry[0].outsideHit === 0 && geometry[1].radius > geometry[0].radius,
    'so buying the charge really buys footprint',
    { small: geometry[0], large: geometry[1] }
  );

  /* ------------------------------------------------------------------ */
  /* 6. an aborted hold spends nothing                                   */
  /* ------------------------------------------------------------------ */

  const aborted = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__floor();
    window.__pin(5000);
    window.__aimAt(6);
    window.__arm('implosion');
    const baseline = window.__pool('implosion');
    app.aim.press();
    // On the aim point, so that a cancel which wrongly paid out would be caught
    // rather than landing on empty ground.
    const at = window.__aimLine(1);
    const dummy = window.__dummy(at.x, at.z, 5000);
    app.__fast(90, 1 / 60);
    const mid = {
      charge: window.__hold('implosion').charge,
      hp: window.__hp(dummy.index),
      cooldown: window.__cooldown('implosion'),
      holds: window.__holds(),
      phase: window.__hold('implosion').phase
    };
    app.aim.cancel();
    const after = {
      holds: window.__holds(),
      appHold: app.hold,
      armed: app.aim.isArmed,
      cooldown: window.__cooldown('implosion'),
      phase: window.__hold('implosion'),
      hp: window.__hp(dummy.index),
      live: app.abilities.active.length,
      pool: window.__pool('implosion')
    };
    return { baseline, mid, after };
  })()`);
  h.rec('an aborted hold', aborted);
  h.expect(
    aborted.mid.charge === 1.5 && aborted.mid.hp === 5000 && aborted.mid.phase === 'hold',
    'a full 1.5 s charge sits in the hand and has cost nothing yet',
    aborted.mid
  );
  h.expect(
    aborted.after.holds.length === 0 && aborted.after.appHold === null && aborted.after.armed === false,
    'a cancel drops the hold entirely',
    aborted.after
  );
  h.expect(
    aborted.after.hp === 5000 && aborted.after.cooldown === 0,
    'with no payoff and no cooldown — an aborted hold spends nothing',
    { hp: aborted.after.hp, cooldown: aborted.after.cooldown }
  );
  h.expect(
    aborted.after.live === 0 && aborted.after.pool.active === aborted.baseline.active,
    'and the body goes straight back to the pool',
    { after: aborted.after.pool, baseline: aborted.baseline }
  );

  /* ------------------------------------------------------------------ */
  /* 7. the cooldown gate                                                */
  /* ------------------------------------------------------------------ */

  const gate = await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    window.__floor();
    const fresh = { cooldown: window.__cooldown('implosion'), armed: window.__arm('implosion').armed };
    window.__aimAt(8);
    app.aim.press();
    app.__fast(30, 1 / 60);
    app.aim.release();
    const paid = { cooldown: window.__cooldown('implosion'), armed: app.aim.isArmed, setting: s.implosion.cooldown };
    const refused = { armed: window.__arm('implosion').armed, element: app.element };
    const toast = app.hud.root.querySelector('.hud__toast') ? app.hud.root.querySelector('.hud__toast').textContent : null;
    app.__fast(370, 1 / 60);
    const ready = { cooldown: window.__cooldown('implosion'), armed: window.__arm('implosion').armed };
    return { fresh, paid, refused, toast, ready };
  })()`);
  h.rec('the cooldown gate', gate);
  h.expect(gate.fresh.cooldown === 0 && gate.fresh.armed === true, 'a fresh element arms', gate.fresh);
  h.expect(
    gate.paid.cooldown === 6 && gate.paid.armed === false,
    'the release puts the ability cooldown on the clock and disarms',
    gate.paid
  );
  h.expect(gate.refused.armed === false, 'and an element still cooling down refuses to arm again', gate.refused);
  h.expect(gate.toast === '尚未就绪', 'telling the caster why', { toast: gate.toast });
  h.expect(gate.ready.cooldown === 0 && gate.ready.armed === true, 'once it has run out it arms again', gate.ready);

  /* ------------------------------------------------------------------ */
  /* 8. the tether: no travel time, then a tick every tickInterval        */
  /* ------------------------------------------------------------------ */

  const tether = await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    window.__floor();
    window.__pin(5000);
    window.__watchSegment();
    window.__aimAt(6);
    window.__arm('tether');
    const armed = { hold: window.__hold('tether'), zone: app.aim.zoneRadius, holdToCast: app.aim.holdToCast };
    app.aim.press();
    // Halfway down the beam, which is where the aim is actually pointing.
    const at = window.__aimLine(0.5);
    const dummy = window.__dummy(at.x, at.z, 5000);
    const hpBefore = window.__hp(dummy.index);
    // One frame: the channel's first tick lands on it, with no projectile to wait for.
    app.__fast(1, 1 / 60);
    const first = { ticks: window.__ticks().length, hp: window.__hp(dummy.index) };
    app.__fast(47, 1 / 60);
    const after48 = { ticks: window.__ticks().length, hp: window.__hp(dummy.index) };
    return {
      armed,
      aimedAt: [+at.x.toFixed(2), +at.z.toFixed(2)],
      hpBefore,
      first,
      after48,
      tickDamage: s.tether.tickDamage,
      tickInterval: s.tether.tickInterval,
      hitWidth: s.tether.hitWidth,
      calls: window.__ticks()
    };
  })()`);
  h.rec('the tether channel', tether);
  h.expect(tether.armed.holdToCast === true, 'the tether is a hold element', tether.armed);
  h.expect(
    tether.first.ticks === 1 && tether.hpBefore - tether.first.hp === 26,
    'the first tick lands on the very first frame — no travel time',
    { ticks: tether.first.ticks, dealt: round(tether.hpBefore - tether.first.hp, 3) }
  );
  h.expect(
    tether.calls.every((c) => c.damage === 26 && c.width === 0.75 && c.element === 'tether'),
    'every tick carries tickDamage, hitWidth and the element',
    { sample: tether.calls.slice(0, 3) }
  );
  const gaps = tether.calls.slice(1).map((c, i) => round(c.elapsed - tether.calls[i].elapsed, 4));
  h.rec('tick spacing', { ticks: tether.calls.length, gaps });
  h.expect(
    gaps.every((g) => g >= 0.12 - 1e-4 && g <= 0.12 + 1 / 60 + 1e-4),
    'and they come one tickInterval apart, never faster',
    { tickInterval: 0.12, gaps }
  );

  const steering = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__floor();
    window.__pin(5000);
    window.__watchSegment();
    window.__aimAt(6);
    window.__arm('tether');
    app.aim.press();
    const at = window.__aimLine(0.5);
    const dummy = window.__dummy(at.x, at.z, 5000);
    app.__fast(24, 1 / 60);
    const onLine = { ticks: window.__ticks().length, hp: window.__hp(dummy.index) };
    // Where the beam pointed before the swing, to prove afterwards that the
    // ticks genuinely moved on.
    const wasAt = window.__aimTarget();
    // Swing the wrist by moving the cursor, and push it in so it takes effect
    // this frame rather than the next.
    const swung = window.__swing('tether', -0.9);
    const aimedAt = window.__hold('tether').target;
    // How far the abandoned body now sits off the beam, in metres.
    const ux = swung.x / (Math.hypot(swung.x, swung.z) || 1);
    const uz = swung.z / (Math.hypot(swung.x, swung.z) || 1);
    const px = at.x;
    const pz = at.z;
    const t = Math.max(0, Math.min(1, px * ux + pz * uz));
    const lateral = Math.hypot(px - ux * t, pz - uz * t);
    app.__fast(24, 1 / 60);
    const offLine = { ticks: window.__ticks().length, hp: window.__hp(dummy.index) };
    const calls = window.__ticks();
    return {
      onLine,
      offLine,
      aimedAt,
      swungAt: [+swung.x.toFixed(2), +swung.z.toFixed(2)],
      away: [+at.x.toFixed(2), +at.z.toFixed(2)],
      lateral: round(lateral, 3),
      hitWidth: window.__settings.tether.hitWidth,
      // Where the aim points once the frames have run: App.js:673 re-feeds the
      // hold target from the live aim every frame, so this — not the snapshot
      // taken inside __swing — is what the last tick was given.
      liveAt: (() => { const L = window.__aimTarget(); return [+L.x.toFixed(2), +L.z.toFixed(2)]; })(),
      wasAt: [+wasAt.x.toFixed(2), +wasAt.z.toFixed(2)],
      lastTo: calls[calls.length - 1].to
    };
  })()`);
  h.rec('steering the channel', steering);
  h.expect(
    steering.onLine.hp < 5000 && steering.onLine.ticks >= 2,
    'a body on the line is chewed while the channel is held',
    steering.onLine
  );
  // The three readings below come from different helpers with different
  // rounding, so compare them with a tolerance rather than for equality.
  const near = (a, b) => Math.abs(a - b) < 0.01;
  h.expect(
    near(steering.aimedAt[0], steering.swungAt[0]) && near(steering.aimedAt[1], steering.swungAt[1]),
    'the target follows the cursor while the button is down',
    { target: steering.aimedAt, swungTo: steering.swungAt }
  );
  h.expect(
    steering.offLine.ticks > steering.onLine.ticks,
    'the channel keeps ticking after the swing',
    { before: steering.onLine.ticks, after: steering.offLine.ticks }
  );
  h.expect(
    steering.lateral > steering.hitWidth,
    'and the swing really did carry the beam off the body it was chewing',
    { lateral: steering.lateral, hitWidth: steering.hitWidth }
  );
  h.expect(
    steering.offLine.hp === steering.onLine.hp,
    'so the body the beam left behind stops taking damage',
    { before: steering.onLine.hp, after: steering.offLine.hp }
  );
  // Compass bearing of a point seen from the caster, in degrees. Positions are
  // compared as bearings rather than coordinates because steering the channel
  // turns the body (and drags the camera after it), so the beam keeps re-aiming
  // for a moment after the cursor stops: the distance to the target is still
  // settling while the heading is already the new one.
  const bearing = (p) => (Math.atan2(p[1], p[0]) * 180) / Math.PI;
  const angleBetween = (p, q) => {
    let d = Math.abs(bearing(p) - bearing(q)) % 360;
    return d > 180 ? 360 - d : d;
  };
  h.expect(
    angleBetween(steering.lastTo, steering.liveAt) < 6,
    'the ticks run along the heading the cursor is on now',
    { lastTo: steering.lastTo, liveAt: steering.liveAt, offBy: round(angleBetween(steering.lastTo, steering.liveAt), 2) }
  );
  h.expect(
    angleBetween(steering.lastTo, steering.wasAt) > 25,
    'and that heading is genuinely a new one, not the one the beam started on',
    { wasAt: steering.wasAt, lastTo: steering.lastTo, offBy: round(angleBetween(steering.lastTo, steering.wasAt), 2) }
  );

  const snap = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__floor();
    window.__pin(5000);
    window.__watchSegment();
    window.__aimAt(6);
    window.__arm('tether');
    app.aim.press();
    const at = window.__aimLine(0.5);
    window.__dummy(at.x, at.z, 5000);
    app.__fast(36, 1 / 60);
    const held = { ticks: window.__ticks().length, phase: window.__live('tether').phase };
    app.aim.release();
    // Read the phase off the live body: releasing drops the registry entry, and
    // __hold() hands back a snapshot besides.
    const released = { phase: window.__live('tether').phase, cooldown: window.__cooldown('tether') };
    // 30 frames, not 30/60 — the first argument is an iteration count.
    app.__fast(30, 1 / 60);
    const afterTick = { ticks: window.__ticks().length, phase: window.__live('tether')?.phase ?? 'retired' };
    window.__unwatchSegment();
    app.__fast(90, 1 / 60);
    return {
      held,
      released,
      afterTick,
      retired: { live: app.abilities.active.length, pool: window.__pool('tether') },
      releaseDuration: app.abilities.pools.get('tether').free.length >= 0
    };
  })()`);
  h.rec('releasing the channel', snap);
  h.expect(snap.held.phase === 'hold' && snap.held.ticks >= 4, 'the channel ticks while held', snap.held);
  h.expect(
    snap.released.phase === 'release' && snap.released.cooldown === 5,
    'releasing snaps it and pays the tether cooldown',
    snap.released
  );
  h.expect(
    snap.afterTick.ticks === snap.held.ticks,
    'and a released channel deals no further ticks — the payoff already happened',
    { held: snap.held.ticks, after: snap.afterTick.ticks }
  );
  h.expect(
    snap.retired.live === 0 && snap.retired.pool.active === 0,
    'the body retires itself when the discharge is over',
    snap.retired
  );

  /* ------------------------------------------------------------------ */
  /* 9. everything handed back                                           */
  /* ------------------------------------------------------------------ */

  await ctx.evaluate('(() => { window.__unwatchSegment(); window.__restore5(); window.__floor(); return true; })()');
  const restored = await ctx.evaluate(`(() => {
    const s = window.__settings;
    return {
      chargeMax: s.implosion.chargeMax,
      zoneRadius: s.implosion.zoneRadius,
      misfireGone: s.implosion.chargeMisfire === undefined,
      tickInterval: s.tether.tickInterval,
      tickDamage: s.tether.tickDamage,
      health: s.minions.health,
      critChance: s.minions.critChance,
      reactions: s.reactions.enabled,
      implosionCooldown: s.implosion.cooldown,
      tetherCooldown: s.tether.cooldown
    };
  })()`);
  h.rec('restored', restored);
  h.expect(
    restored.chargeMax === 2 &&
      restored.tickInterval === 0.12 &&
      restored.tickDamage === 26 &&
      restored.health === 100 &&
      restored.reactions === true,
    'every pinned setting is handed back',
    restored
  );
  h.expect(
    restored.zoneRadius === 3.2 && restored.misfireGone === true,
    'and the aim ring is still declared while the dead misfire knob is gone',
    { zoneRadius: restored.zoneRadius, misfireGone: restored.misfireGone }
  );

  return { failures: h.failures, steps: h.steps, console: { errors: ctx.errors, warnings: ctx.warnings.length } };
}
