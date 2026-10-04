/**
 * Stage 3 — the swarm answers.
 *
 * Before this pass the minions were scenery: they walked at the caster and
 * evaporated when hit. Now they have a director that sends waves (every fifth
 * one led by a boss), three attack clocks, and the two damage queries the
 * abilities call. This scenario tests all of it on the fixed-step driver.
 *
 * The numbers are all exact on purpose. `critChance` is zeroed and
 * `speedJitter` pinned so a hit costs precisely `attack.damage` and a walk
 * covers precisely `moveSpeed` metres — otherwise the dice would hide the very
 * arithmetic that makes the combat legible.
 *
 * What is *not* here: loot. Kills do shed it (one assertion checks the wiring),
 * but the coins, the magnet and the shop belong to stage 4.
 */
import { harness, round } from './_harness.mjs';

/** The director and the floor, as one snapshot. */
const SWARM = `(() => {
  const app = window.app;
  const m = app.minions;
  return {
    enabled: window.__settings.minions.enabled,
    wave: m.waveCount,
    active: m.active.length,
    idle: m.pool.free.length,
    spawnTimer: +m.spawnTimer.toFixed(3),
    phase: m.active.map((x) => x.phase),
    bosses: m.active.filter((x) => x.isBoss).length,
    throwers: m.active.filter((x) => x.isRanged).length,
    bolts: m.bolts.filter((b) => b.active).length,
    hp: +app.player.hp.toFixed(4),
    alive: app.player.alive,
    kills: app.kills
  };
})()`;

export default async function (ctx) {
  const h = harness(ctx);
  await h.install();

  /* ------------------------------------------------------------------ */
  /* setup: a quiet floor, a pinned RNG, and logs on the two callbacks   */
  /* ------------------------------------------------------------------ */

  await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;

    // Captured once so the arena can re-arm them whatever a restart does.
    window.__hurtOrig = app.player.onHurt;
    window.__hurtFn = (ratio, dx, dz) => {
      window.__hurtLog.push([+app.elapsed.toFixed(3), +app.player.hp.toFixed(4), +dx.toFixed(3), +dz.toFixed(3)]);
      window.__hurtOrig?.(ratio, dx, dz);
    };
    window.__slamOrig = app.minions.onSlam;
    window.__slamFn = (pos, radius) => {
      window.__slamLog.push([+app.elapsed.toFixed(3), +pos.x.toFixed(3), +pos.z.toFixed(3), radius]);
      window.__slamOrig?.(pos, radius);
    };

    window.__keep = {
      enabled: s.minions.enabled,
      critChance: s.minions.critChance,
      speedJitter: s.minions.speedJitter,
      share: s.minions.ranged.share,
      everyNWaves: s.minions.boss.everyNWaves
    };

    // Park every body at an exact spot, on the ground, mid-life, facing the
    // caster with a full attack interval on its clock.
    //
    // Facing matters. A body is pooled and spawn() deliberately leaves
    // root.rotation.y alone, so a reused body still points wherever it died.
    // What swings it round is _turnToward at turnRate rad/s during the
    // riseTime it spends climbing out of the ground — which is why nothing
    // ever looks wrong in play. A test that teleports a body straight into
    // SEEK skips that rise, so it has to set the heading itself or it measures
    // the arc of a body still coming about, not the speed it walks at.
    window.__place = (i, x, z, phase) => {
      const m = app.minions.active[i];
      if (!m) return null;
      m.root.position.set(x, 0, z);
      m.root.rotation.y = Math.atan2(-x, -z);
      m.phase = phase;
      m.age = 1;
      m._speedFactor = 1;
      m._attackTimer = s.minions.attack.interval;
      return m.token;
    };

    return true;
  })()`);

  /**
   * A clean run: full health at the origin, an empty floor, no corpses, and
   * the logs emptied. `director` decides whether the wave director is allowed
   * to work; `count` instead spawns one wave by hand, so the tests below
   * control every body on the floor.
   *
   * The purge matters. `clearAll()` only marks the old bodies dying — and it
   * cannot even do that to a body that was *killed*: `vanish()` opens with
   * `if (!this.alive) return;`, so a corpse already in `dying` keeps its full
   * fall (`fallTime + deadPause + sinkTime` = 1.7 s, since the 2.2x sink
   * speed-up belongs to the vanish path alone). Spawning a new wave on top of
   * them would leave the new bodies behind the corpses, and every `active[0]`
   * below would be pointing at a body that is already dissolving (and whose
   * index shifts the moment it recycles). So the director is held shut, the
   * floor is cleared, and time is run until the floor is genuinely empty — 120
   * frames covers the 102 the worst case needs. Then exactly `count` bodies are
   * on it.
   */
  const arena = async ({ director = false, count = 0, spawnTimer = null, crit = 0, jitter = 0, share = null, everyNWaves = null } = {}) =>
    ctx.evaluate(`(() => {
      const app = window.app;
      const s = window.__settings;
      app.aim.cancel();
      app._restartRun();
      app.hud.hideDeath();

      s.minions.enabled = false;
      app.minions.clearAll();
      app.minions.waveCount = 0;
      app.__fast(120, 1 / 60);
      if (app.minions.active.length) {
        throw new Error('the floor did not clear: ' + app.minions.active.length + ' bodies left in active');
      }

      // Back to the shipped dice every time, so one test's odds never leak
      // into the next one's arithmetic.
      s.minions.enabled = ${director};
      s.minions.critChance = ${crit};
      s.minions.speedJitter = ${jitter};
      s.minions.ranged.share = window.__keep.share;
      s.minions.boss.everyNWaves = window.__keep.everyNWaves;
      ${share === null ? '' : `s.minions.ranged.share = ${share};`}
      ${everyNWaves === null ? '' : `s.minions.boss.everyNWaves = ${everyNWaves};`}
      ${spawnTimer === null ? '' : `app.minions.spawnTimer = ${spawnTimer};`}

      app.player.onHurt = window.__hurtFn;
      app.minions.onSlam = window.__slamFn;
      window.__hurtLog = [];
      window.__slamLog = [];
      window.__hs = new Map();

      if (${count} > 0) app.minions._spawnWave(${count});
      return { active: app.minions.active.length, idle: app.minions.pool.free.length };
    })()`);

  const swarm = async (name) => {
    const value = await ctx.evaluate(SWARM);
    h.rec(name, value);
    return value;
  };

  /** The log entries as (app time, hp after the blow) pairs. */
  const hits = () =>
    ctx.evaluate(`(() => {
      const log = window.__hurtLog;
      const gaps = log.slice(1).map((h, i) => +Math.abs(h[0] - log[i][0]).toFixed(3));
      return {
        count: log.length,
        hp: log.map((h) => h[1]),
        gaps,
        dmg: log.slice(1).map((h, i) => +(log[i][1] - h[1]).toFixed(4)),
        first: log[0] ?? null,
        dirs: log.map((h) => [h[2], h[3]])
      };
    })()`);

  /* ------------------------------------------------------------------ */
  /* 1. the wave director                                                */
  /* ------------------------------------------------------------------ */

  await arena({ director: true, spawnTimer: 1.2 });
  await h.fast(1.3);
  const wave1 = await swarm('after 1.3s with the director on');
  h.expect(wave1.wave === 1, 'the first wave is wave 1', { wave: wave1.wave, spawnTimer: 1.2 });
  h.expect(wave1.active === 3, 'a wave sends waveSize bodies', { active: wave1.active, waveSize: 3 });
  h.expect(
    wave1.phase.every((p) => p === 'rise'),
    'bodies surface before they walk',
    { phase: wave1.phase, riseTime: 0.7 }
  );

  await h.fast(2.7);
  const wave2 = await swarm('after 4.0s');
  h.expect(wave2.wave === 2, 'the director keeps sending waves', { wave: wave2.wave });
  h.expect(wave2.active === 6, 'two waves are six bodies', { active: wave2.active, spawnInterval: 2.6 });

  // Long enough that the swarm reaches the caster and works through its clocks.
  await h.fast(34);
  const cap = await swarm('after 38s of standing still');
  h.expect(cap.active === 24, 'the swarm stops growing at maxAlive', { active: cap.active, maxAlive: 24 });
  h.expect(
    cap.phase.filter((p) => p === 'crowd').length > 12,
    'the swarm ends up crowded around the caster',
    { crowd: cap.phase.filter((p) => p === 'crowd').length, active: cap.active }
  );
  h.expect(cap.alive === false, 'a caster who never moves is eaten alive', { hp: cap.hp, alive: cap.alive });
  h.expect(cap.kills === 0, 'nothing died on its own', { kills: cap.kills });

  // A body is pooled and `spawn()` leaves its heading alone, so it comes out of
  // the ground still pointing wherever it last died. What swings it onto the
  // caster is `_turnToward` at `turnRate` rad/s during the rise — which is the
  // whole reason a reused body never looks wrong in play, and the reason every
  // teleporting probe in this file has to set the heading itself.
  await arena({ count: 1 });
  const about = await ctx.evaluate(`(() => {
    const m = window.app.minions.active[0];
    m.root.position.set(0, 0, 15);
    m.root.rotation.y = 0;
    m.phase = 'rise';
    m.age = 0;
    return { before: +m.root.rotation.y.toFixed(4), want: +Math.atan2(0, -15).toFixed(4) };
  })()`);
  await h.fast(0.7);
  const faced = await ctx.evaluate('+window.app.minions.active[0].root.rotation.y.toFixed(4)');
  const facingError = round(Math.abs(Math.atan2(Math.sin(faced - Math.PI), Math.cos(faced - Math.PI))), 4);
  h.expect(
    facingError < 0.02,
    'the rise turns a body onto the caster, whatever way it was pooled',
    { before: about.before, after: faced, target: about.want, error: facingError }
  );

  /* ------------------------------------------------------------------ */
  /* 2. the melee bite                                                   */
  /* ------------------------------------------------------------------ */

  await arena({ count: 1, share: 0 });
  await ctx.evaluate('window.__place(0, 0, 2.0, "seek")');
  await h.fast(6);
  const biting = await swarm('6s with one biter');
  const bite = await hits();

  h.expect(biting.phase[0] === 'crowd', 'the biter walks into the crowd ring', { phase: biting.phase[0] });
  h.expect(bite.count >= 4 && bite.count <= 8, 'the bite clock runs about once an interval', {
    bites: bite.count,
    interval: 1.2
  });
  h.expect(
    Math.abs(biting.hp - (100 - 8 * bite.count)) < 1e-6,
    'every bite costs exactly attack.damage',
    { hp: biting.hp, bites: bite.count, expected: 100 - 8 * bite.count, damage: 8 }
  );
  h.expect(
    bite.gaps.every((g) => g >= 0.5),
    'no two bites land inside hurtInvuln',
    { gaps: bite.gaps, hurtInvuln: 0.5 }
  );
  h.expect(
    bite.gaps.every((g) => g <= 1.35),
    'the bite keeps to its interval',
    { gaps: bite.gaps, interval: 1.2 }
  );
  h.expect(
    bite.dirs.every((d) => d[1] < -0.9 && Math.abs(d[0]) < 0.2),
    'the blow arrives from the biter, not from nowhere',
    { dirs: bite.dirs, note: 'the body sits on +z, so the blow travels -z' }
  );

  // The one frame of fairness: the lunge lives only inside `attack.windup`.
  await ctx.evaluate(`(() => {
    const m = window.app.minions.active[0];
    m._attackTimer = window.__settings.minions.attack.interval * 0.75;
    return true;
  })()`);
  const tell = await h.sample(
    `
    const m = app.minions.active[0];
    return m ? { z: +m.bodyPivot.position.z.toFixed(4), timer: +m._attackTimer.toFixed(4) } : null;`,
    1.5
  );
  const living = tell.filter(Boolean);
  const lunged = living.filter((s) => s.z > 0.01);
  const maxLunge = Math.max(0, ...living.map((s) => s.z));
  h.rec('the bite tell', { frames: living.length, lungedFrames: lunged.length, maxLunge: round(maxLunge, 4) });
  h.expect(maxLunge > 0.2, 'the bite leans the body out before it lands', { maxLunge: round(maxLunge, 4), target: 0.24 });
  h.expect(
    lunged.every((s) => s.timer < 0.29),
    'the lunge is confined to the windup',
    { windup: 0.28, worst: round(Math.max(...lunged.map((s) => s.timer)), 4) }
  );

  /* ------------------------------------------------------------------ */
  /* 3. the stand-off thrower                                            */
  /* ------------------------------------------------------------------ */

  await arena({ count: 1, share: 1 });
  const thrower = await swarm('a wave of throwers');
  h.expect(thrower.throwers === 1, 'ranged.share decides the caste', { throwers: thrower.throwers, share: 1 });

  await ctx.evaluate('window.__place(0, 0, 15.0, "seek")');
  await h.fast(3.6);
  const held = await ctx.evaluate(`(() => {
    const m = window.app.minions.active[0];
    const t = window.app.minions.target;
    return {
      phase: m.phase,
      dist: +Math.hypot(t.x - m.root.position.x, t.z - m.root.position.z).toFixed(3),
      hp: +window.app.player.hp.toFixed(4),
      bolts: window.app.minions.bolts.filter((b) => b.active).length
    };
  })()`);
  h.rec('the thrower after 3.6s', held);
  h.expect(held.phase === 'crowd', 'the thrower stops early instead of closing', { phase: held.phase });
  h.expect(
    Math.abs(held.dist - 8.5) < 0.25,
    'it holds at ranged.stop, not at attackRange',
    { dist: held.dist, stop: 8.5, attackRange: 1.5 }
  );
  h.expect(held.hp === 100, 'a thrower never bites', { hp: held.hp });

  // One bolt, watched frame by frame: it flies, then it costs ranged.damage.
  await ctx.evaluate(`(() => {
    // Whatever the stand-off clock already lobbed is cleared, so exactly one
    // ball is in the air for the trace below.
    for (const b of window.app.minions.bolts) { b.active = false; b.mesh.visible = false; }
    window.app.minions.active[0]._boltTimer = 0.01;
    return true;
  })()`);
  const flight = await h.sample(
    `
    const m = app.minions;
    const live = m.bolts.filter((b) => b.active);
    return {
      hp: +app.player.hp.toFixed(4),
      live: live.length,
      x: live.length ? +live[0].mesh.position.x.toFixed(3) : null,
      z: live.length ? +live[0].mesh.position.z.toFixed(3) : null
    };`,
    1.5
  );
  const spawnFrame = flight.findIndex((s) => s.live > 0);
  const hitFrame = flight.findIndex((s) => s.hp < 100);
  const flightSeconds = spawnFrame >= 0 && hitFrame >= 0 ? round((hitFrame - spawnFrame) / 60, 3) : null;
  h.rec('bolt flight', { spawnFrame, hitFrame, flightSeconds, tail: flight[flight.length - 1] });
  h.expect(spawnFrame >= 0, 'the bolt clock lobs a ball', { spawnFrame });
  h.expect(
    flight.some((s) => s.live > 0),
    'the ball exists as one pooled sphere while it flies',
    { framesInFlight: flight.filter((s) => s.live > 0).length }
  );
  h.expect(
    flightSeconds !== null && flightSeconds > 0.7 && flightSeconds < 1.15,
    'the bolt crosses ranged.stop at ranged.speed',
    { flightSeconds, expected: round((8.5 - 0.7) / 8.5, 3), speed: 8.5 }
  );
  const afterBolt = flight[flight.length - 1];
  h.expect(afterBolt.hp === 91, 'a bolt costs exactly ranged.damage', { hp: afterBolt.hp, damage: 9 });

  /* ------------------------------------------------------------------ */
  /* 4. the boss                                                         */
  /* ------------------------------------------------------------------ */

  await arena({ count: 2, jitter: 0, everyNWaves: 1 });
  const cast = await ctx.evaluate(`(() => {
    const app = window.app;
    const c = window.__settings.minions;
    const boss = app.minions.active.find((m) => m.isBoss);
    const plain = app.minions.active.find((m) => !m.isBoss);
    if (!boss || !plain) return { boss: !!boss, plain: !!plain };
    // One frame so the body update has written the scale and the radius getters.
    app.__fast(1, 1 / 60);
    return {
      boss: true,
      plain: true,
      wave: app.minions.waveCount,
      bossHp: boss.maxHp,
      plainHp: plain.maxHp,
      expectedBossHp: c.health * c.boss.healthMult,
      bossRadius: +boss.bodyRadius.toFixed(4),
      plainRadius: +plain.bodyRadius.toFixed(4),
      bossScale: +boss.root.scale.x.toFixed(4),
      plainScale: +plain.root.scale.x.toFixed(4),
      bossTint: boss.bodyMaterial.color.getHexString(),
      plainTint: plain.bodyMaterial.color.getHexString()
    };
  })()`);
  h.rec('the boss wave', cast);
  h.expect(cast.wave === 1 && cast.bossHp === 1400, 'every Nth wave is led by a boss', cast);
  h.expect(
    cast.bossHp === 1400 && cast.plainHp === 100,
    'the boss carries healthMult squads of health',
    { bossHp: cast.bossHp, plainHp: cast.plainHp, healthMult: 14 }
  );
  h.expect(
    Math.abs(cast.bossRadius - 0.945) < 1e-4 && Math.abs(cast.plainRadius - 0.45) < 1e-4,
    'the boss is a bigger target for every damage query',
    { bossRadius: cast.bossRadius, plainRadius: cast.plainRadius, scaleMult: 2.1 }
  );
  h.expect(
    Math.abs(cast.bossScale - 2.1) < 1e-4 && Math.abs(cast.plainScale - 1) < 1e-4,
    'the boss reads its own scale on the body',
    { bossScale: cast.bossScale, plainScale: cast.plainScale }
  );
  h.expect(cast.bossTint !== cast.plainTint, 'the castes are tinted apart', { bossTint: cast.bossTint, plainTint: cast.plainTint });

  // speedMult: with the jitter pinned, a second of walking is exactly moveSpeed.
  await ctx.evaluate('(() => { window.__place(0, 0, 15, "seek"); window.__place(1, 0, -15, "seek"); return true; })()');
  const bossIndex = await ctx.evaluate('window.app.minions.active.findIndex((m) => m.isBoss)');
  const plainIndex = bossIndex === 0 ? 1 : 0;
  const walked = await h.sample(
    `
    const m = app.minions.active;
    return {
      boss: +Math.hypot(m[${bossIndex}].root.position.x, m[${bossIndex}].root.position.z).toFixed(4),
      plain: +Math.hypot(m[${plainIndex}].root.position.x, m[${plainIndex}].root.position.z).toFixed(4)
    };`,
    1
  );
  const bossTravel = round(15 - walked[walked.length - 1].boss, 3);
  const plainTravel = round(15 - walked[walked.length - 1].plain, 3);
  h.rec('one second of walking', { bossTravel, plainTravel });
  h.expect(
    Math.abs(bossTravel - 1.44) < 0.02 && Math.abs(plainTravel - 2.0) < 0.02,
    'the boss lumbers at speedMult',
    { bossTravel, plainTravel, moveSpeed: 2.0, speedMult: 0.72 }
  );

  /* --- the slam: it only hurts inside the ring ---------------------- */

  await arena({ count: 2, jitter: 0, everyNWaves: 1 });
  await ctx.evaluate(`(() => {
    const bossIndex = window.app.minions.active.findIndex((m) => m.isBoss);
    const plainIndex = bossIndex === 0 ? 1 : 0;
    window.__bossIndex = bossIndex;
    window.__place(bossIndex, 0, 1.0, "crowd");
    window.__place(plainIndex, 0, 30, "seek");
    window.app.minions.active[bossIndex]._slamTimer = 0.05;
    return true;
  })()`);
  await h.fast(0.2);
  const inside = await ctx.evaluate('({ hp: +window.app.player.hp.toFixed(4), slams: window.__slamLog.length })');
  h.rec('the slam lands inside the ring', inside);
  h.expect(inside.hp === 76, 'a slam inside slamRadius costs slamDamage', { hp: inside.hp, slamDamage: 24 });
  h.expect(inside.slams === 1, 'the slam is announced to the camera', { slams: inside.slams });

  // Now the caster kites: the ground still shakes, but nobody is standing on it.
  await ctx.evaluate(`(() => {
    window.app.character.root.position.set(0, 0, 9);
    window.app.minions.active[window.__bossIndex]._slamTimer = 0.05;
    return true;
  })()`);
  await h.fast(0.2);
  const outside = await ctx.evaluate(`(() => {
    const m = window.app.minions.active[window.__bossIndex];
    const t = window.app.minions.target;
    return {
      hp: +window.app.player.hp.toFixed(4),
      slams: window.__slamLog.length,
      phase: m.phase,
      dist: +Math.hypot(t.x - m.root.position.x, t.z - m.root.position.z).toFixed(3)
    };
  })()`);
  h.rec('the same slam, 8m away', outside);
  h.expect(outside.dist > 5.0, 'the caster outran the ring', { dist: outside.dist, slamRadius: 5.0 });
  h.expect(outside.slams === 2, 'the slam still shakes the ground', { slams: outside.slams });
  h.expect(outside.hp === 76, 'a slam outside the ring costs nothing', { hp: outside.hp, before: 76 });

  // The telegraph: the body swells through slamWindup.
  await ctx.evaluate('(window.app.minions.active[window.__bossIndex]._slamTimer = 0.75, true)');
  const swell = await h.sample(
    `
    const m = app.minions.active[window.__bossIndex];
    return { inflate: +m.bodyPivot.scale.x.toFixed(4), timer: +m._slamTimer.toFixed(4) };`,
    0.8
  );
  const quiet = swell.filter((s) => s.timer >= 0.7);
  const charging = swell.filter((s) => s.timer < 0.7);
  const maxInflate = Math.max(...swell.map((s) => s.inflate));
  h.rec('the slam tell', { maxInflate: round(maxInflate, 4), quietFrames: quiet.length, chargingFrames: charging.length });
  h.expect(
    quiet.every((s) => s.inflate < 1.02),
    'the body is its own size until the windup starts',
    { worst: round(Math.max(...quiet.map((s) => s.inflate)), 4), slamWindup: 0.7 }
  );
  h.expect(
    maxInflate > 1.35,
    'the body swells as the clock runs out',
    { maxInflate: round(maxInflate, 4), ceiling: 1.42, chargingFrames: charging.length }
  );

  /* ------------------------------------------------------------------ */
  /* 5. the switch                                                       */
  /* ------------------------------------------------------------------ */

  await arena({ director: true, spawnTimer: 1.2 });
  await h.fast(1.3);
  const solid = await swarm('three bodies on the floor');
  h.expect(solid.active === 3 && solid.enabled === true, 'the director is on and has sent one wave', solid);

  const off = await ctx.evaluate(`(() => {
    const app = window.app;
    const on = app.minions.toggle();
    return {
      on,
      enabled: window.__settings.minions.enabled,
      phases: app.minions.active.map((m) => m.phase),
      sinking: app.minions.active.map((m) => m._sinking),
      vanish: app.minions.active.map((m) => m._vanish)
    };
  })()`);
  h.rec('after toggle()', off);
  h.expect(off.on === false && off.enabled === false, 'toggle flips the setting the editor shows', off);
  h.expect(
    off.phases.every((p) => p === 'dying') && off.sinking.every(Boolean) && off.vanish.every(Boolean),
    'switching off dissolves the swarm in place, without waiting for a topple',
    { phases: off.phases, sinking: off.sinking, vanish: off.vanish }
  );

  await h.fast(0.6);
  const gone = await swarm('0.6s later');
  h.expect(gone.active === 0, 'a dissolved body is gone in sinkTime / 2.2', { active: gone.active, sinkTime: 0.85 });

  const back = await ctx.evaluate('(() => { const on = window.app.minions.toggle(); return { on, spawnTimer: +window.app.minions.spawnTimer.toFixed(3) }; })()');
  h.rec('switching back on', back);
  h.expect(back.on === true, 'toggle flips back', back);
  h.expect(back.spawnTimer <= 0.4, 'switching on hurries the next wave', { spawnTimer: back.spawnTimer });

  await h.fast(1.6);
  const again = await swarm('after switching on');
  h.expect(again.active === 3 && again.wave === 2, 'the director picks up where it left off', {
    active: again.active,
    wave: again.wave
  });

  /* ------------------------------------------------------------------ */
  /* 6. the damage contract                                              */
  /* ------------------------------------------------------------------ */

  /* --- a circle: full damage at the centre, less at the rim ---------- */

  await arena({ count: 2, crit: 0 });
  await ctx.evaluate(`(() => {
    window.__place(0, 0, 0, "crowd");        // dead centre
    window.__place(1, 3.45, 0, "crowd");     // dist 3.0 after bodyRadius, edge 0.5
    return true;
  })()`);
  const circle = await ctx.evaluate(`(() => {
    const app = window.app;
    app.minions.damageCircle({ x: 0, y: 0, z: 0 }, 6, 40, { hitSet: window.__hs });
    const first = app.minions.active.map((m) => +m.hp.toFixed(4));
    // Same registry, same frame: the tokens are already spent.
    app.minions.damageCircle({ x: 0, y: 0, z: 0 }, 6, 40, { hitSet: window.__hs });
    const second = app.minions.active.map((m) => +m.hp.toFixed(4));
    return { first, second, tokens: app.minions.active.map((m) => m.token), registry: window.__hs.size };
  })()`);
  h.rec('damageCircle with a hitSet', circle);
  h.expect(circle.first[0] === 60, 'a hit at the centre costs the full damage', { hp: circle.first[0], damage: 40 });
  h.expect(
    Math.abs(circle.first[1] - 72) < 1e-4,
    'the rim falls off by settings.minions.falloff (x1.2)',
    { hp: circle.first[1], expected: 72, edge: 0.5, falloff: 0.5 }
  );
  h.expect(
    circle.second[0] === circle.first[0] && circle.second[1] === circle.first[1],
    'one hitSet strikes each body once',
    { afterSecondCall: circle.second, afterFirstCall: circle.first, registry: circle.registry }
  );

  /* --- a band: on the line, near the edge, and outside --------------- */

  await arena({ count: 3, crit: 0 });
  await ctx.evaluate(`(() => {
    window.__place(0, 0, -5, "crowd");     // on the line
    window.__place(1, 0.9, -5, "crowd");   // lateral 0.45 of width 1.0
    window.__place(2, 1.6, -5, "crowd");   // lateral 1.15 — outside the band
    return true;
  })()`);
  const band = await ctx.evaluate(`(() => {
    window.app.minions.damageSegment({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 }, 1.0, 30, {});
    return window.app.minions.active.map((m) => +m.hp.toFixed(4));
  })()`);
  h.rec('damageSegment across three bodies', { hp: band });
  h.expect(band[0] === 70, 'a body on the line takes the full damage', { hp: band[0], damage: 30 });
  h.expect(band[1] > band[0] && band[1] < 100, 'a body inside the band but off the line takes less', { hp: band[1] });
  h.expect(band[2] === 100, 'a body outside the band is untouched', { hp: band[2], width: 1.0 });

  /* --- the shove, and the kill path --------------------------------- */

  const shove = await ctx.evaluate(`(() => {
    const m = window.app.minions.active[0];
    m._knockX = 0;
    m._knockZ = 0;
    m.applyDamage(1, 1, 0);
    return { x: +m._knockX.toFixed(4), z: +m._knockZ.toFixed(4), stagger: +m.stagger.toFixed(4), flash: +m.flash.toFixed(3) };
  })()`);
  h.rec('the shove', shove);
  h.expect(shove.x === 0.6, 'knockback rides the blow direction', { ...shove, knockback: 0.6 });
  h.expect(shove.z === 0, 'a shove straight down +x adds no z', { z: shove.z });
  h.expect(shove.stagger === 0.25 && shove.flash === 1, 'a hit sets the stagger and the flash', shove);

  const braced = await ctx.evaluate(`(() => {
    const app = window.app;
    // A boss of our own: spawn() leaves the pooled body fully reset.
    const m = app.minions.pool.acquire();
    m.spawn(50, 50, { boss: true, ranged: false });
    app.minions.active.push(m);
    m._knockX = 0;
    m.applyDamage(1, 1, 0);
    const out = { knockX: +m._knockX.toFixed(4), stagger: +m.stagger.toFixed(4), brace: 0.12, staggerMult: 0.3 };
    app.minions.recycle(m);
    return out;
  })()`);
  h.rec('the boss braces', braced);
  h.expect(braced.knockX === 0.072, 'a boss shrugs off nearly all of a shove', braced);
  h.expect(braced.stagger === 0.075, 'a boss barely staggers', { stagger: braced.stagger, staggerTime: 0.25, mult: 0.3 });

  // Two bodies, one blow each: they topple, they are counted, they come back.
  await arena({ count: 2, crit: 0 });
  await ctx.evaluate(`(() => {
    window.__place(0, 2, 0, "crowd");
    window.__place(1, -2, 0, "crowd");
    return true;
  })()`);
  const killed = await ctx.evaluate(`(() => {
    const app = window.app;
    app.minions.damageCircle({ x: 0, y: 0, z: 0 }, 20, 1000);
    return {
      kills: app.kills,
      hp: app.minions.active.map((m) => +m.hp.toFixed(4)),
      phases: app.minions.active.map((m) => m.phase),
      alive: app.minions.active.map((m) => m.alive)
    };
  })()`);
  h.rec('a killing blow', killed);
  h.expect(killed.kills === 2, 'every death is counted once', { kills: killed.kills });
  h.expect(
    killed.phases.every((p) => p === 'dying') && killed.alive.every((a) => a === false),
    'a dead body is dying, not alive',
    killed
  );

  await h.fast(2);
  const recycled = await swarm('2s after the kill');
  h.expect(recycled.active === 0, 'a toppled body recycles after fallTime + deadPause + sinkTime', {
    active: recycled.active,
    total: round(0.55 + 0.3 + 0.85, 3)
  });
  h.expect(recycled.idle >= 2, 'the bodies are back in the pool, not destroyed', { idle: recycled.idle });

  /* ------------------------------------------------------------------ */
  /* put the settings back the way the app ships them                    */
  /* ------------------------------------------------------------------ */

  await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    const keep = window.__keep;
    s.minions.enabled = keep.enabled;
    s.minions.critChance = keep.critChance;
    s.minions.speedJitter = keep.speedJitter;
    s.minions.ranged.share = keep.share;
    s.minions.boss.everyNWaves = keep.everyNWaves;
    app.player.onHurt = window.__hurtOrig;
    app.minions.onSlam = window.__slamOrig;
    app._restartRun();
    app.hud.hideDeath();
    return true;
  })()`);

  return { failures: h.failures, steps: h.steps, console: { errors: ctx.errors, warnings: ctx.warnings.length } };
}
