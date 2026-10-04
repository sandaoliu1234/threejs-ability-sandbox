/**
 * Stage 2 — the player's body: walking, the health bar, and the dodge.
 *
 * Everything here runs on the fixed-step driver, so distances are metres per
 * simulated second rather than "whatever the software rasteriser managed". The
 * keys go in as real CDP key events, not by poking `input.keys`, so the whole
 * chain is under test: DOM event → InputManager → action → App → Player →
 * CharacterController.
 *
 * The somersault is the interesting one. It is a transient of a third of a
 * second riding on top of a shove of a sixth, and the only way to see it is a
 * per-frame trace: `sample()` records the body's height and the tilt
 * quaternion's angle on every frame of the roll.
 */
import { harness, round } from './_harness.mjs';

/** Trace body: height off the floor, rotation about the tilt axis, roll flag. */
const ROLL_TRACE = `
  const q = app.character.tilt.quaternion;
  return {
    t: +app.elapsed.toFixed(3),
    y: +app.character.root.position.y.toFixed(4),
    turn: +((2 * Math.acos(Math.max(-1, Math.min(1, q.w))))).toFixed(4),
    rolling: app.character._rolling,
    shove: +app.player.dashTimeLeft.toFixed(3)
  };`;

export default async function (ctx) {
  const h = harness(ctx);
  await h.install();

  /* --- a quiet arena: no minions, no coins, standing at the origin ----- */

  await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    s.minions.enabled = false;
    s.drops.enabled = false;
    app.minions.clearAll();
    app.drops.clear();
    app.aim.cancel();
    app._restartRun();
    app.hud.hideDeath();
    return true;
  })()`);

  const resting = await ctx.evaluate(`(() => {
    const app = window.app;
    const p = app.player;
    return {
      hp: p.hp, maxHp: p.maxHp, alive: p.alive,
      dashLeft: +p.dashTimeLeft.toFixed(3),
      cooldownLeft: +p.dashCooldownLeft.toFixed(3),
      gold: window.__settings.progression.gold,
      pos: [+app.character.position.x.toFixed(3), +app.character.position.y.toFixed(3), +app.character.position.z.toFixed(3)],
      deathHidden: document.querySelector('.hud__death').hidden
    };
  })()`);
  h.rec('fresh run', resting);
  h.expect(resting.hp === 100 && resting.maxHp === 100, 'a fresh run is at full health', resting);
  h.expect(resting.alive === true, 'a fresh run is alive', resting);
  h.expect(resting.deathHidden === true, 'the death card is hidden on a fresh run', resting);

  /* --- walking ------------------------------------------------------- */

  const key = (type, code, keyName, vk) =>
    ctx.send('Input.dispatchKeyEvent', {
      type,
      code,
      key: keyName,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk
    });

  const where = () => ctx.evaluate(`(() => {
    const p = window.app.character.position;
    return { x: p.x, z: p.z, ground: +Math.hypot(p.x, p.z).toFixed(4) };
  })()`);

  const from = await where();
  await key('keyDown', 'KeyW', 'w', 87);
  const keysHeld = await ctx.evaluate(`[...window.app.input.keys]`);
  h.rec('keys held after a real keydown', keysHeld);
  h.expect(keysHeld.includes('KeyW'), 'a real keydown lands in the input map', keysHeld);

  const walk = await h.fast(1.0);
  h.rec('one second of holding W', { from: round(from.ground, 3), to: walk.ground, metres: walk.metres });
  h.expect(
    Math.abs(walk.metres - 4.4) < 0.02,
    'one second of W covers moveSpeed metres',
    { metres: walk.metres, expected: 4.4 }
  );

  // Diagonal input must be normalised, or walking two keys at once would be
  // 41% faster than walking one.
  await key('keyDown', 'KeyD', 'd', 68);
  const diagonal = await h.fast(1.0);
  h.rec('one second of W+D', { metres: diagonal.metres });
  h.expect(
    Math.abs(diagonal.metres - 4.4) < 0.02,
    'W+D is normalised, not faster than W',
    { metres: diagonal.metres, diagIfUnnormalised: round(4.4 * Math.SQRT2, 3) }
  );
  await key('keyUp', 'KeyD', 'd', 68);

  // Let go and the body has to actually stop.
  await key('keyUp', 'KeyW', 'w', 87);
  const drift = await h.fast(0.5);
  h.rec('drift after releasing W', { metres: drift.metres });
  h.expect(drift.metres < 1e-3, 'the body stops when the key comes up', { metres: drift.metres });

  /* --- the arena edge ------------------------------------------------- */

  await ctx.evaluate('window.app.character.root.position.set(0, 0, 0)');
  await key('keyDown', 'KeyW', 'w', 87);
  const edge = await h.fast(12);
  h.rec('after 12s of walking one way', edge);
  h.expect(
    edge.ground <= 24 + 1e-3 && edge.ground > 23.5,
    'the soft clamp pins the body to groundRadius',
    { ground: edge.ground, groundRadius: 24 }
  );
  await key('keyUp', 'KeyW', 'w', 87);
  await ctx.evaluate('window.app.character.root.position.set(0, 0, 0)');

  /* --- taking a hit --------------------------------------------------- */

  // Wrap the hook App installed so the presentation signature is on record.
  await ctx.evaluate(`(() => {
    const p = window.app.player;
    window.__hurtLog = [];
    const original = p.onHurt;
    window.__restoreHurt = () => { p.onHurt = original; };
    p.onHurt = (ratio, dx, dz) => { window.__hurtLog.push([+ratio.toFixed(3), +dx.toFixed(2), +dz.toFixed(2)]); original?.(ratio, dx, dz); };
    return true;
  })()`);

  const firstHit = await ctx.evaluate(`(() => {
    const p = window.app.player;
    const landed = p.damage(25, 0.6, 0.8);
    return { landed, hp: p.hp, log: window.__hurtLog.slice() };
  })()`);
  h.rec('damage(25) at full health', firstHit);
  h.expect(firstHit.landed === true, 'a hit at full health lands', firstHit);
  h.expect(firstHit.hp === 75, '25 damage takes 25 hp', firstHit);
  h.expect(
    firstHit.log.length === 1 && firstHit.log[0][0] === 0.75,
    'onHurt reports the hp ratio and the blow direction',
    firstHit.log
  );

  const blocked = await ctx.evaluate(`(() => {
    const p = window.app.player;
    const landed = p.damage(25);
    return { landed, hp: p.hp, invuln: +p._invuln.toFixed(3) };
  })()`);
  h.rec('an immediate second hit', blocked);
  h.expect(blocked.landed === false && blocked.hp === 75, 'the invulnerability window swallows the next swing', blocked);

  await h.fast(0.45);
  const stillBlocked = await ctx.evaluate(`(() => {
    const p = window.app.player;
    const landed = p.damage(5);
    return { landed, invuln: +p._invuln.toFixed(3) };
  })()`);
  h.rec('a hit 0.45s later', stillBlocked);
  h.expect(stillBlocked.landed === false, 'hurtInvuln is at least 0.45s', stillBlocked);

  await h.fast(0.15);
  const landedAgain = await ctx.evaluate(`(() => {
    const p = window.app.player;
    const landed = p.damage(5);
    return { landed, hp: p.hp };
  })()`);
  h.rec('a hit just past hurtInvuln', landedAgain);
  h.expect(landedAgain.landed === true && landedAgain.hp === 70, 'hurtInvuln is not much more than 0.5s', landedAgain);

  /* --- regeneration --------------------------------------------------- */

  // The clock restarts on the last hit, so 4.5s of quiet must heal nothing.
  await h.fast(4.5);
  const beforeRegen = await ctx.evaluate('window.app.player.hp');
  h.rec('hp 4.5s after the last hit', round(beforeRegen, 3));
  h.expect(Math.abs(beforeRegen - 70) < 1e-6, 'nothing regenerates inside regenDelay', { hp: beforeRegen });

  await h.fast(1.5);
  const afterRegen = await ctx.evaluate('window.app.player.hp');
  const healed = afterRegen - beforeRegen;
  h.rec('hp after 1.5s more', { hp: round(afterRegen, 3), healed: round(healed, 3) });
  // 4.5s + 1.5s = 6.0s since the hit, so one second of regen has been paid out.
  h.expect(
    Math.abs(healed - 2.0) < 0.05,
    'regen runs at settings.player.regen per second once the delay passes',
    { healed: round(healed, 3), expected: 2.0, rate: 2.0 }
  );

  // A hit must reset the clock rather than merely pause it.
  const resetClock = await ctx.evaluate(`(() => {
    const p = window.app.player;
    p.damage(1);
    return { hp: p.hp, sinceHit: +p._sinceHit.toFixed(3) };
  })()`);
  h.rec('the clock after a new hit', resetClock);
  h.expect(resetClock.sinceHit === 0, 'a hit resets the regeneration clock', resetClock);

  const overheal = await ctx.evaluate(`(() => {
    const p = window.app.player;
    const absorbed = p.heal(1000);
    return { absorbed: +absorbed.toFixed(3), hp: p.hp, maxHp: p.maxHp };
  })()`);
  h.rec('heal(1000)', overheal);
  h.expect(overheal.hp === overheal.maxHp && Math.abs(overheal.absorbed - (overheal.maxHp - resetClock.hp)) < 1e-6, 'an overheal stops at maxHp and reports what it absorbed', overheal);

  /* --- death and the fall --------------------------------------------- */

  // The last hit left an invulnerability window open; the killing blow has to
  // wait it out like any other.
  await h.fast(0.6);

  const death = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__deathCount = 0;
    const original = app.player.onDeath;
    window.__restoreDeath = () => { app.player.onDeath = original; };
    app.player.onDeath = () => { window.__deathCount++; original?.(); };
    const landed = app.player.damage(1000);
    return {
      landed,
      hp: app.player.hp,
      alive: app.player.alive,
      deaths: window.__deathCount,
      cardVisible: document.querySelector('.hud__death').hidden === false,
      characterDead: app.character.dead
    };
  })()`);
  h.rec('a killing blow', death);
  h.expect(death.landed === true && death.hp === 0 && death.alive === false, 'a killing blow empties the bar', death);
  h.expect(death.deaths === 1, 'onDeath fires exactly once', death);
  h.expect(death.cardVisible === true, 'the death card comes up', death);
  h.expect(death.characterDead === true, 'the body is told it died', death);

  const afterDeath = await ctx.evaluate(`(() => {
    const p = window.app.player;
    return { hit: p.damage(10), heal: p.heal(10), hp: p.hp, dash: p.dash(1, 0) };
  })()`);
  h.rec('a dead body ignores everything', afterDeath);
  h.expect(
    afterDeath.hit === false && afterDeath.heal === 0 && afterDeath.hp === 0 && afterDeath.dash === false,
    'a dead body takes no damage, heals nothing and cannot dodge',
    afterDeath
  );

  // The fall is a 0.55s pitch onto the floor, all of it on the tilt quaternion.
  const fall = await h.sample(ROLL_TRACE, 0.65);
  const fallAngles = fall.map((s) => s.turn);
  const fallEnd = fallAngles[fallAngles.length - 1];
  const fallMid = fallAngles.find((a) => a > 1.0) ?? null;
  h.rec('the fall, first and last frames', { first: fall[0], last: fall[fall.length - 1] });
  h.rec('the fall reaches 1.0 rad at', fallMid);
  h.expect(fallAngles[0] < 0.01, 'the fall starts upright', { turn: fallAngles[0] });
  h.expect(
    fallEnd > 1.4 && fallEnd < 1.5,
    'the fall settles at settings dead pitch (1.45 rad)',
    { end: round(fallEnd, 4), target: 1.45 }
  );

  /* --- restart -------------------------------------------------------- */

  const restarted = await ctx.evaluate(`(() => {
    const app = window.app;
    app._restartRun();
    const p = app.player;
    return {
      hp: p.hp, alive: p.alive, deaths: window.__deathCount,
      cardHidden: document.querySelector('.hud__death').hidden,
      characterDead: app.character.dead,
      gold: window.__settings.progression.gold,
      kills: app.kills,
      pos: [+app.character.position.x.toFixed(3), +app.character.position.z.toFixed(3)],
      tiltTurn: +(2 * Math.acos(Math.abs(app.character.tilt.quaternion.w))).toFixed(4),
      y: +app.character.position.y.toFixed(4)
    };
  })()`);
  h.rec('after a restart', restarted);
  h.expect(restarted.hp === 100 && restarted.alive === true, 'a restart refills the bar', restarted);
  h.expect(restarted.cardHidden === true && restarted.characterDead === false, 'a restart puts the card away and stands the body up', restarted);
  h.expect(restarted.gold === 0 && restarted.kills === 0, 'a restart wipes the run', restarted);
  h.expect(restarted.pos[0] === 0 && restarted.pos[1] === 0, 'a restart returns the body to the origin', restarted);
  // Not `< 1e-3`: the frozen clock means the walk gait's lean and bob do not
  // decay between calls, so what is being asserted is that the *death pitch*
  // and the somersault are gone, not that the body is a statue.
  h.expect(
    restarted.tiltTurn < 0.2 && Math.abs(restarted.y) < 0.07,
    'a restart stands the body back up',
    { turn: restarted.tiltTurn, y: restarted.y, deathPitch: 1.45, rollTurn: round(Math.PI * 2, 3) }
  );

  /* --- the dodge, through the real key binding ------------------------ */

  const beforeDash = await ctx.evaluate(`(() => {
    const p = window.app.character.position;
    return { x: p.x, z: p.z, rolling: window.app.character._rolling };
  })()`);

  await key('keyDown', 'Space', ' ', 32);
  // The action fires on the input event but the posture is only applied by the
  // next frame. Freezing the clock means the dash state is a fixed point once
  // that frame lands, so waiting for the roll to appear costs no simulation.
  await h.waitFor('window.app.character._rolling === true', { timeoutMs: 8000, every: 100, label: 'the somersault to launch' });
  const dashing = await ctx.evaluate(`(() => {
    const p = window.app.player;
    return {
      timeLeft: +p.dashTimeLeft.toFixed(4),
      cooldown: +p.dashCooldownLeft.toFixed(4),
      invuln: +p._invuln.toFixed(4),
      dir: [+p.dashDirX.toFixed(3), +p.dashDirZ.toFixed(3)],
      rolling: window.app.character._rolling
    };
  })()`);
  h.rec('the frame Space goes down', dashing);
  h.expect(dashing.timeLeft === 0.16, 'the shove lasts dashTime', dashing);
  h.expect(dashing.cooldown === 1.5, 'the shove starts its full cooldown', dashing);
  h.expect(dashing.invuln === 0.3, 'the shove grants dashInvuln', dashing);
  h.expect(dashing.rolling === true, 'the shove launches the somersault', dashing);
  await key('keyUp', 'Space', ' ', 32);

  // Standing still, the dodge goes wherever the body is facing.
  h.expect(Math.abs(Math.hypot(dashing.dir[0], dashing.dir[1]) - 1) < 1e-3, 'the dodge direction is a unit vector', dashing.dir);

  const secondDashRefused = await ctx.evaluate(`(() => window.app.player.dash(1, 0))()`);
  h.rec('a second dodge while cooling down', secondDashRefused);
  h.expect(secondDashRefused === false, 'the dodge refuses while it is cooling down', { returned: secondDashRefused });

  // Invulnerability is the point of the dodge: a swing during it passes through.
  const dodged = await ctx.evaluate(`(() => {
    const p = window.app.player;
    const landed = p.damage(25);
    return { landed, hp: p.hp };
  })()`);
  h.rec('a hit during the dodge', dodged);
  h.expect(dodged.landed === false && dodged.hp === 100, 'the dodge dodges: the swing passes through', dodged);

  /* --- the somersault, frame by frame --------------------------------- */

  await ctx.evaluate(`(() => {
    const app = window.app;
    app.player.reset();
    app.character.root.position.set(0, 0, 0);
    app.character.resetPlacement();
    return true;
  })()`);

  await key('keyDown', 'KeyW', 'w', 87);
  await key('keyDown', 'Space', ' ', 32);
  const roll = await h.sample(ROLL_TRACE, 0.55);
  await key('keyUp', 'Space', ' ', 32);
  await key('keyUp', 'KeyW', 'w', 87);

  const apex = roll.reduce((best, s) => (s.y > best.y ? s : best), roll[0]);
  const highest = apex.y;
  const turnAtApex = apex.turn;
  const lastRolling = roll.filter((s) => s.rolling).pop();
  // Only the rolling frames: once the roll is over the tilt goes back to the
  // walk's lean, so the whole trace is not monotone and should not be.
  const rollingTurns = roll.filter((s) => s.rolling).map((s) => s.turn);
  const monotone = rollingTurns.every((v, i) => i === 0 || v >= rollingTurns[i - 1] - 1e-6);
  const final = roll[roll.length - 1];

  h.rec('somersault apex', { t: apex.t, y: round(highest, 4), turn: round(turnAtApex, 4), index: roll.indexOf(apex) });
  h.rec('last rolling frame', lastRolling);
  h.rec('final frame', final);

  h.expect(
    Math.abs(highest - 0.6) < 0.02,
    'the hop arc peaks at rollHeight',
    { peak: round(highest, 4), rollHeight: 0.6 }
  );
  // The rotation is in phase with the hop: the flip is half-done at the top of
  // the arc, so the body passes through inverted exactly where it is highest.
  h.expect(
    Math.abs(turnAtApex - Math.PI) < 0.15,
    'the body is inverted at the top of the arc',
    { turn: round(turnAtApex, 4), expected: round(Math.PI, 4) }
  );
  h.expect(monotone, 'the rotation never goes backwards', { from: round(rollingTurns[0], 3), to: round(rollingTurns[rollingTurns.length - 1], 3), frames: rollingTurns.length });
  h.expect(
    lastRolling && lastRolling.turn > 6.0,
    'the roll completes a full turn (2π)',
    { turnAtEnd: lastRolling ? round(lastRolling.turn, 4) : null, expected: round(Math.PI * 2, 4) }
  );
  h.expect(
    lastRolling && lastRolling.shove === 0,
    'the roll outlives the shove — the body lands after the momentum is gone',
    { shoveAtRollEnd: lastRolling ? lastRolling.shove : null, dashTime: 0.16, rollTime: 0.34 }
  );
  h.expect(
    final.rolling === false && final.turn < 0.2 && final.y < 0.07,
    'the roll lands the body upright and back on the floor',
    { rolling: final.rolling, turn: round(final.turn, 4), y: round(final.y, 4), note: '0.055|sin| is the walk gait, so y need not be exactly 0' }
  );

  // The somersault must not leak into the walk: a plain step stays a step.
  await h.fast(0.4);
  const settled = await ctx.evaluate(`(() => {
    const c = window.app.character;
    return { rolling: c._rolling, turn: +(2 * Math.acos(Math.abs(c.tilt.quaternion.w))).toFixed(4), y: +c.position.y.toFixed(4), stride: +c._stride.toFixed(3) };
  })()`);
  h.rec('after the roll, walking again', settled);
  h.expect(settled.rolling === false && settled.y < 0.08, 'walking resumes with the normal gait, not the roll', settled);

  // --- the gait, the pause, and the chain ---------------------------------
  // Three regressions from one pass over the movement. Two of them were only
  // visible as silhouette problems (a leg that kicked instead of stepping, a
  // roll whose limbs stayed stiff), so they are pinned here as geometry.

  await ctx.evaluate(`(() => {
    const app = window.app;
    const c = app.character;
    app.input.keys.clear();
    c._rolling = false;
    c._dead = false;
    c._stride = 1;
    window.__bone = (short) => {
      let hit = null;
      c.tilt.traverse((o) => {
        if (hit || !o.isBone) return;
        if (o.name.split(':').pop().replace(/^mixamorig/i, '') === short) hit = o;
      });
      return hit;
    };
    window.__at = (short) => {
      const v = new c.root.position.constructor();
      window.__bone(short).getWorldPosition(v);
      return [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
    };
    window.__gait = (phase) => {
      c._walkPhase = phase;
      c.update(0);
      return { lFoot: window.__at('LeftFoot'), rFoot: window.__at('RightFoot'), lKnee: window.__at('LeftLeg'), rKnee: window.__at('RightLeg') };
    };
    return true;
  })()`);

  // A step, not a kick: the shin folds BACKWARDS from the knee (a shin rotated
  // the same way as its thigh hyperextends and throws the foot up and forward),
  // so through the whole cycle the ankle must stay at or below its knee.
  const gait = await ctx.evaluate(`(() => {
    const out = {};
    for (const p of [0, 1.5708, 3.1416, 4.7124]) out['p' + p] = window.__gait(p);
    return out;
  })()`);
  h.rec('the walk at four phases', gait);
  for (const [phase, s] of Object.entries(gait)) {
    h.expect(
      s.lFoot[1] <= s.lKnee[1] + 0.05 && s.rFoot[1] <= s.rKnee[1] + 0.05,
      'the knee folds backwards: no ankle rises above its knee (' + phase + ')',
      { lFoot: s.lFoot[1], lKnee: s.lKnee[1], rFoot: s.rFoot[1], rKnee: s.rKnee[1] }
    );
    h.expect(
      Math.abs(s.lFoot[1]) < 0.35 && Math.abs(s.rFoot[1]) < 0.35,
      'the swing foot stays under a third of a metre (' + phase + ')',
      { lFoot: s.lFoot[1], rFoot: s.rFoot[1], note: 'hyperextension measured 0.62 before the fix' }
    );
  }

  // The stacked poses are multiplicative, and the mixer only rewrites the bones
  // when time advances. Re-applying them on a frozen frame used to crank the
  // character into a pretzel: the ankle climbed ~0.16m per zero-dt frame.
  const frozen = await ctx.evaluate(`(() => {
    const c = window.app.character;
    c._stride = 1;
    c._walkPhase = 1.0;
    c.update(0);
    const first = window.__at('LeftFoot');
    for (let i = 0; i < 12; i++) c.update(0);
    const last = window.__at('LeftFoot');
    return { first: first, last: last, drift: +Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]).toFixed(5) };
  })()`);
  h.rec('twelve paused frames mid-stride', frozen);
  h.expect(frozen.drift < 1e-3, 'a paused frame re-applies the gait without stacking it', frozen);

  // Hammering the dodge: a press during a roll is remembered and takes over the
  // frame that roll ends, so the chain keeps going without waiting out the
  // cooldown — and outside the window the cooldown still refuses.
  const chain = await ctx.evaluate(`(() => {
    const p = window.app.player;
    const s = window.__settings;
    window.app.input.keys.clear();
    p._dashCooldown = 0; p._sinceDash = Infinity; p.dashTimeLeft = 0;
    p._dashQueuedX = 0; p._dashQueuedZ = 0;
    const first = p.dash(1, 0);
    const midRoll = p.dash(0, 1);
    const reserved = { x: p._dashQueuedX, z: p._dashQueuedZ };
    let launches = 0;
    let prev = p.dashTimeLeft;
    for (let i = 0; i < 60; i++) {
      p.dash(1, 0);
      p.update(1 / 60);
      // A chained roll restarts on the very frame the previous one ends, so
      // the dash timer never reads zero between them — count the restarts.
      if (p.dashTimeLeft > prev + 1e-6) launches++;
      prev = p.dashTimeLeft;
    }
    const rolled = launches;
    // Outside the chain window the cooldown is back in charge.
    p.dashTimeLeft = 0; p._sinceDash = 99; p._dashCooldown = 1.0;
    const blocked = { can: p.canDash, dash: p.dash(1, 0) };
    // Surviving the roll puts the press inside the window.
    p.dashTimeLeft = 0; p._sinceDash = s.player.dashChainWindow * 0.5; p._dashCooldown = 1.0;
    const windowed = p.canDash;
    p.dashTimeLeft = 0; p._dashCooldown = 0; p._sinceDash = Infinity;
    return { first: first, midRoll: midRoll, reserved: reserved, launches: rolled, blocked: blocked, windowed: windowed };
  })()`);
  h.rec('hammering the dodge for a second', chain);
  h.expect(chain.first === true && chain.midRoll === false, 'a press mid-roll is reserved, not restarted', chain);
  h.expect(
    chain.reserved.x === 0 && chain.reserved.z === 1,
    'the reserved press keeps its own direction', chain.reserved
  );
  h.expect(chain.launches >= 5, 'mashing dodge chains rolls back to back', { launches: chain.launches, note: 'dashTime 0.16s in a 1s window' });
  h.expect(
    chain.blocked.can === false && chain.blocked.dash === false,
    'outside the chain window the cooldown still refuses', chain.blocked
  );
  h.expect(chain.windowed === true, 'inside the chain window the cooldown is waived', { windowed: chain.windowed });

  await ctx.evaluate(`(() => {
    window.__restoreHurt?.();
    window.__restoreDeath?.();
    return true;
  })()`);

  return { failures: h.failures, steps: h.steps, console: { errors: ctx.errors, warnings: ctx.warnings.length } };
}
