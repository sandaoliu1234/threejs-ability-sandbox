/**
 * Stage 6 of the six-stage pass — elemental reactions.
 *
 * The rule the game states in its own help panel: hit a body with a *different*
 * element inside `settings.reactions.window` and the second hit detonates a
 * bonus and consumes the memory.
 *
 * This scenario never reads the reaction table out of the source. It rebuilds
 * the whole matrix by hitting one body with every ordered pair of the nine
 * elements and measuring what actually came off its health bar, then compares
 * that against the documented table. That way the test fails if the table is
 * edited, if `reactionOf` is wired up backwards, or if `applyDamage` stops
 * consulting it — three different failures that a source-reading test would
 * sail past.
 *
 * What it locks down:
 *   - the matrix, pair by pair, bonus and name, and that it is symmetric;
 *   - the bonus is what reaches the health bar, not just what is reported;
 *   - the three layers resolve in order: the hand-written pair wins, then the
 *     family matrix, then the generic resonance for two elements of one family;
 *   - the matrix is *complete* — all thirty-six pairs land somewhere, and no
 *     element is stranded without a reaction of its own;
 *   - a reaction consumes the memory, so a third hit starts over;
 *   - the memory is on the simulation clock and expires at `window`;
 *   - two hits of the same element never react;
 *   - `reactions.enabled = false` gates the bonus (but not the bookkeeping);
 *   - the whole thing runs through the real `damageCircle` the abilities use.
 */
import { harness, round } from './_harness.mjs';

/**
 * The system as designed, restated here on purpose. If someone edits the
 * tables in `settings.js`, this is the second opinion that disagrees.
 */

/** Layer 1: the hand-written pairs the help panel names. */
const NAMED = {
  'ice+thunder': { name: '超导', bonus: 1.5 },
  'ice+meteor': { name: '蒸爆', bonus: 1.35 },
  'meteor+thunder': { name: '感电', bonus: 1.4 },
  'beam+ice': { name: '霜辉', bonus: 1.3 },
  'glacier+thunder': { name: '电网', bonus: 1.35 }
};

/** Layer 2: every element in one family, and what two families make. */
const FAMILIES = {
  frost: ['ice', 'glacier', 'beam'],
  storm: ['thunder', 'snare', 'tether'],
  ember: ['meteor'],
  arcane: ['banknote', 'implosion']
};
const VS = {
  'frost+storm': { name: '超导', bonus: 1.5 },
  'frost+ember': { name: '蒸爆', bonus: 1.35 },
  'storm+ember': { name: '感电', bonus: 1.4 },
  'frost+arcane': { name: '霜蚀', bonus: 1.35 },
  'storm+arcane': { name: '过载', bonus: 1.45 },
  'ember+arcane': { name: '燃荒', bonus: 1.4 }
};

/** Layer 3: two elements of the same family are more of the same element. */
const FALLBACK = { name: '共鸣', bonus: 1.35 };

const familyOf = (el) => Object.keys(FAMILIES).find((f) => FAMILIES[f].includes(el)) ?? null;

/**
 * Resolve one unordered key the way the design says it should, and say which
 * layer decided it — the layer is the interesting part, since that is what the
 * "no element is stranded" and "same family means resonance" checks are about.
 */
function expectedFor(key) {
  if (NAMED[key]) return { ...NAMED[key], layer: 'named' };
  const [a, b] = key.split('+');
  const fa = familyOf(a);
  const fb = familyOf(b);
  if (!fa || !fb || fa === fb) return { ...FALLBACK, layer: 'same-family' };
  // Both orders, because the family table is keyed on readable names rather
  // than on a canonical sort — see the note in `reactionOf`.
  const hit = VS[fa + '+' + fb] ?? VS[fb + '+' + fa];
  return hit ? { ...hit, layer: 'family' } : { ...FALLBACK, layer: 'family-unlisted' };
}

export default async function (ctx) {
  const h = harness(ctx);
  await h.install();

  await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;

    // The harness's round() is a driver-side import; the page needs its own.
    window.round = (v, places = 3) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(places) : v);

    window.__keep6 = {
      enabled: s.reactions.enabled,
      window: s.reactions.window,
      bonus: s.reactions.bonus,
      critChance: s.minions.critChance,
      damageTaken: s.minions.damageTaken,
      health: s.minions.health,
      knockback: s.minions.knockback,
      separateStrength: s.minions.separateStrength,
      speedJitter: s.minions.speedJitter,
      attackDamage: s.minions.attack.damage,
      rangedEnabled: s.minions.ranged.enabled,
      everyNWaves: s.minions.boss.everyNWaves
    };

    // 120 frames: clearAll() cannot touch a killed body, and a corpse takes its
    // full fallTime + deadPause + sinkTime = 1.7 s to leave under its own power.
    window.__floor = () => {
      app.aim.cancel();
      app.abilities.clear();
      app.minions.clearAll();
      app.minions.waveCount = 0;
      s.minions.enabled = false;
      app.drops.clear();
      // Nothing should still be held down: a stale key walks the caster through
      // every __fast, which moves the aim origin out from under anything the
      // blocks park relative to it.
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
      return true;
    };

    window.__pin = () => {
      s.minions.enabled = false;
      s.minions.health = 5000;
      s.minions.critChance = 0;
      s.minions.damageTaken = 1;
      s.minions.knockback = 0;
      s.minions.separateStrength = 0;
      s.minions.speedJitter = 0;
      s.minions.attack.damage = 0;
      s.minions.ranged.enabled = false;
      s.minions.boss.everyNWaves = 0;
      s.reactions.enabled = true;
      return true;
    };

    window.__restore6 = () => {
      const k = window.__keep6;
      s.reactions.enabled = k.enabled;
      s.reactions.window = k.window;
      s.reactions.bonus = k.bonus;
      s.minions.critChance = k.critChance;
      s.minions.damageTaken = k.damageTaken;
      s.minions.health = k.health;
      s.minions.knockback = k.knockback;
      s.minions.separateStrength = k.separateStrength;
      s.minions.speedJitter = k.speedJitter;
      s.minions.attack.damage = k.attackDamage;
      s.minions.ranged.enabled = k.rangedEnabled;
      s.minions.boss.everyNWaves = k.everyNWaves;
      return true;
    };

    /** One parked body at the origin, kept alive and still. */
    window.__victim = (hp) => {
      app.minions._spawnWave(1);
      const m = app.minions.active[app.minions.active.length - 1];
      m.phase = 'crowd';
      m.age = 0;
      m.root.position.set(0, 0, 0);
      m.root.rotation.y = 0;
      m.maxHp = hp;
      m.hp = hp;
      m.flash = 0;
      m.stagger = 0;
      m._knockX = 0;
      m._knockZ = 0;
      m.sepX = 0;
      m.sepZ = 0;
      m._attackTimer = 9999;
      m._slamTimer = 9999;
      m.statusElement = null;
      m.statusTimer = 0;
      return app.minions.active.length - 1;
    };

    window.__state = (i) => {
      const m = app.minions.active[i];
      return { hp: round(m.hp, 4), status: m.statusElement, timer: round(m.statusTimer, 4), alive: m.alive };
    };

    /** Hit a body directly and report what it cost. */
    window.__hit = (i, amount, element) => {
      const m = app.minions.active[i];
      const before = m.hp;
      m.applyDamage(amount, 0, 0, element);
      return { element, dealt: round(before - m.hp, 4), status: m.statusElement, timer: round(m.statusTimer, 4) };
    };

    /** Record what the detonation was reported as, without changing it. */
    window.__watchReaction = () => {
      const m = app.minions;
      window.__reactions = [];
      if (!window.__reactionReal) window.__reactionReal = m.reactionAt.bind(m);
      m.reactionAt = (position, reaction) => {
        window.__reactions.push({ name: reaction.name, bonus: reaction.bonus, color: reaction.color });
        return window.__reactionReal(position, reaction);
      };
      return true;
    };
    window.__unwatchReaction = () => {
      if (window.__reactionReal) delete app.minions.reactionAt;
      return true;
    };
    window.__detonations = () => window.__reactions;

    return true;
  })()`);

  /* ------------------------------------------------------------------ */
  /* 1. the whole matrix, recovered by hitting a body with every pair     */
  /* ------------------------------------------------------------------ */

  const matrix = await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    window.__floor();
    window.__pin();
    window.__watchReaction();
    const victim = window.__victim(5000);
    const elements = app.abilities.elements.slice();

    const pairs = [];
    for (const a of elements) {
      for (const b of elements) {
        if (a === b) continue;
        const m = app.minions.active[victim];
        m.hp = 5000;
        m.statusElement = null;
        m.statusTimer = 0;
        m.flash = 0;
        const detonationsBefore = window.__detonations().length;
        const first = window.__hit(victim, 100, a);
        const second = window.__hit(victim, 100, b);
        const fired = window.__detonations().length - detonationsBefore;
        pairs.push({
          pair: [a, b].join('+'),
          key: [a, b].sort().join('+'),
          firstCost: first.dealt,
          secondCost: second.dealt,
          multiplier: round(second.dealt / 100, 4),
          fired,
          reported: fired ? window.__detonations()[window.__detonations().length - 1] : null,
          statusAfter: second.status
        });
      }
    }
    return { elements, pairs, window: s.reactions.window, bonus: s.reactions.bonus };
  })()`);

  // One row per unordered pair: the two orderings must agree.
  const byKey = new Map();
  for (const p of matrix.pairs) {
    if (!byKey.has(p.key)) byKey.set(p.key, []);
    byKey.get(p.key).push(p);
  }
  const symmetric = [...byKey.values()].filter((rows) => rows.length !== 2 || rows[0].multiplier !== rows[1].multiplier);
  h.rec('the reaction matrix', {
    elements: matrix.elements,
    unorderedPairs: byKey.size,
    window: matrix.window,
    named: [...byKey.entries()]
      .filter(([, rows]) => rows[0].reported && rows[0].reported.name !== '共鸣')
      .map(([key, rows]) => ({ key, name: rows[0].reported.name, bonus: rows[0].reported.bonus })),
    fallbackOnly: [...byKey.entries()]
      .filter(([, rows]) => rows.every((r) => !r.reported || r.reported.name === '共鸣'))
      .map(([key]) => key)
  });
  h.expect(
    matrix.pairs.every((p) => p.firstCost === 100),
    'a lone first hit lands its bare damage — no reaction to feed on yet',
    { odd: matrix.pairs.filter((p) => p.firstCost !== 100).slice(0, 3) }
  );
  h.expect(symmetric.length === 0, 'and the reaction is symmetric — the pair is sorted, not ordered', { disagree: symmetric.slice(0, 4) });

  let namedSeen = 0;
  const layers = { named: [], family: [], 'same-family': [], 'family-unlisted': [] };
  for (const [key, rows] of byKey) {
    const want = expectedFor(key);
    const got = rows[0];
    const okName = got.reported !== null && got.reported.name === want.name;
    const okBonus = got.reported !== null && Math.abs(got.reported.bonus - want.bonus) < 1e-9;
    const okLanded = Math.abs(got.multiplier - want.bonus) < 1e-6;
    if (NAMED[key]) namedSeen++;
    layers[want.layer].push(key);
    h.expect(
      okName && okBonus,
      key + ' resolves via ' + want.layer + ' as ' + want.name + ' x' + want.bonus,
      { reported: got.reported, want }
    );
    h.expect(
      okLanded,
      'and ' + key + "'s bonus is what reaches the health bar (" + want.bonus + 'x)',
      { measured: got.multiplier, want: want.bonus, secondCost: got.secondCost }
    );
  }
  h.rec('which layer decided each pair', {
    named: layers.named,
    family: layers.family,
    sameFamily: layers['same-family'],
    familyUnlisted: layers['family-unlisted']
  });
  h.expect(
    namedSeen === Object.keys(NAMED).length,
    'every hand-written pair exists in the table and wins over the family layer',
    { found: namedSeen, documented: Object.keys(NAMED) }
  );

  // The family layer is what makes the table complete. Two checks, one per
  // direction: crossing families always produces a phenomenon, and staying
  // inside one falls through to 共鸣 — which is a rule, not a hole in the
  // table. A hand-written pair is the exception that proves the point: `beam`
  // and `ice` are both frost and still have a name of their own, so layer 1
  // pairs are excluded from the same-family rule.
  const crossFamily = [...byKey.entries()].filter(([key]) => {
    const [a, b] = key.split('+');
    const fa = familyOf(a);
    return fa && familyOf(b) && fa !== familyOf(b);
  });
  const sameFamily = [...byKey.entries()].filter(([key]) => {
    if (NAMED[key]) return false;
    const [a, b] = key.split('+');
    const fa = familyOf(a);
    return fa && fa === familyOf(b);
  });
  h.expect(
    sameFamily.length > 0,
    'and the family layer actually caught something — the rule is not vacuously true',
    { sameFamilyPairs: sameFamily.map(([key]) => key) }
  );
  h.expect(
    crossFamily.every(([, rows]) => rows[0].reported && rows[0].reported.name !== '共鸣'),
    'crossing families always produces a named phenomenon',
    { unnamed: crossFamily.filter(([, r]) => !r[0].reported || r[0].reported.name === '共鸣').map(([k]) => k) }
  );
  h.expect(
    sameFamily.every(([, rows]) => rows[0].reported && rows[0].reported.name === '共鸣'),
    'same-family pairs fall back to the generic resonance',
    { odd: sameFamily.filter(([, r]) => !r[0].reported || r[0].reported.name !== '共鸣').map(([k]) => k) }
  );

  const unwired = new Set();
  for (const el of matrix.elements) {
    let hasNamed = false;
    for (const [key, rows] of byKey) {
      if (key.includes(el) && rows[0].reported && rows[0].reported.name !== '共鸣') hasNamed = true;
    }
    if (!hasNamed) unwired.add(el);
  }
  h.expect(
    unwired.size === 0,
    'no element is stranded without a reaction of its own',
    { unwired: [...unwired], elements: matrix.elements }
  );

  /* ------------------------------------------------------------------ */
  /* 2. the memory: consumed by a detonation, never by a repeat           */
  /* ------------------------------------------------------------------ */

  const memory = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__floor();
    window.__pin();
    window.__watchReaction();
    const v = window.__victim(5000);

    const first = window.__hit(v, 100, 'ice');
    const second = window.__hit(v, 100, 'thunder');
    const afterDetonation = window.__state(v);
    const third = window.__hit(v, 100, 'thunder');
    const fourth = window.__hit(v, 100, 'meteor');
    const afterFourth = window.__state(v);

    // A repeat of the element already carried must not detonate...
    const m = app.minions.active[v];
    m.hp = 5000;
    m.statusElement = null;
    m.statusTimer = 0;
    const carried = window.__hit(v, 100, 'ice');
    const repeat = window.__hit(v, 100, 'ice');
    const repeatAgain = window.__hit(v, 100, 'ice');
    const timerAfterRepeats = window.__state(v);

    return {
      first,
      second,
      afterDetonation,
      third,
      fourth,
      afterFourth,
      carried,
      repeat,
      repeatAgain,
      timerAfterRepeats,
      detonations: window.__detonations().length
    };
  })()`);
  h.rec('the memory', memory);
  h.expect(
    memory.first.status === 'ice' && memory.first.timer === 2,
    'the first element is remembered for the full window',
    memory.first
  );
  h.expect(
    memory.second.dealt === 150 && memory.second.status === null,
    'a second, different element detonates for its bonus and consumes the memory',
    memory.second
  );
  h.expect(
    memory.third.dealt === 100 && memory.fourth.dealt === 140 && memory.afterFourth.status === null,
    'so a third hit only starts a new memory, and the fourth detonates on that one (thunder+meteor = 感电 x1.4)',
    { third: memory.third, fourth: memory.fourth, afterFourth: memory.afterFourth }
  );
  h.expect(
    memory.repeat.dealt === 100 && memory.repeatAgain.dealt === 100 && memory.timerAfterRepeats.timer === 2,
    'the same element never detonates against itself',
    { repeat: memory.repeat, repeatAgain: memory.repeatAgain, timer: memory.timerAfterRepeats.timer }
  );
  h.expect(
    memory.timerAfterRepeats.status === 'ice',
    'and it leaves the carried element in place rather than clearing it',
    memory.timerAfterRepeats
  );
  h.expect(memory.detonations === 2, 'exactly two detonations in that sequence', { detonations: memory.detonations });

  /* ------------------------------------------------------------------ */
  /* 3. the window runs on the simulation clock                           */
  /* ------------------------------------------------------------------ */

  const expiry = await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    const windowSeconds = s.reactions.window;
    const frame = 1 / 60;
    // The last two sit one frame either side of the boundary rather than on
    // it. Landing exactly on it is a coin toss: 120 steps of 1/60 do not sum
    // to exactly 2.0 in binary floating point, so the residue keeps
    // statusTimer a hair above zero and the memory survives a frame longer
    // than its nominal window. That is a float artefact, not a mechanic, and
    // asserting it either way would enshrine one.
    const out = [];
    for (const hold of [0, 1.5, windowSeconds - frame, windowSeconds + frame]) {
      window.__floor();
      window.__pin();
      window.__watchReaction();
      const v = window.__victim(5000);
      window.__hit(v, 100, 'ice');
      const frames = Math.round(hold * 60);
      if (frames) app.__fast(frames, 1 / 60);
      const carried = window.__state(v);
      const strike = window.__hit(v, 100, 'thunder');
      out.push({
        waited: round(hold, 4),
        carriedStatus: carried.status,
        carriedTimer: carried.timer,
        dealt: strike.dealt,
        detonated: strike.dealt > 100
      });
    }
    return { out, windowSeconds };
  })()`);
  h.rec('the reaction window', expiry);
  h.expect(
    expiry.out[0].detonated && expiry.out[1].detonated,
    'a strike while the memory is fresh detonates',
    { atZero: expiry.out[0], at1p5: expiry.out[1] }
  );
  h.expect(
    expiry.out[1].carriedTimer === 0.5,
    'and the memory really is ageing on the simulated clock',
    { after1p5s: expiry.out[1].carriedTimer }
  );
  h.expect(
    expiry.out[2].detonated && expiry.out[2].carriedStatus === 'ice',
    'one frame short of the window it still reacts',
    expiry.out[2]
  );
  h.expect(
    !expiry.out[3].detonated && expiry.out[3].carriedStatus === null && expiry.out[3].dealt === 100,
    'and one frame past it the memory is gone and the strike is a plain hit',
    expiry.out[3]
  );

  /* ------------------------------------------------------------------ */
  /* 4. the switch                                                        */
  /* ------------------------------------------------------------------ */

  const off = await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    window.__floor();
    window.__pin();
    window.__watchReaction();
    const v = window.__victim(5000);
    window.__hit(v, 100, 'ice');
    s.reactions.enabled = false;
    const withOff = window.__hit(v, 100, 'thunder');
    const detonations = window.__detonations().length;
    s.reactions.enabled = true;
    const m = app.minions.active[v];
    m.statusElement = null;
    m.statusTimer = 0;
    window.__hit(v, 100, 'ice');
    const backOn = window.__hit(v, 100, 'thunder');
    return { withOff, detonations, backOn, total: window.__detonations().length };
  })()`);
  h.rec('the reactions switch', off);
  h.expect(
    off.withOff.dealt === 100 && off.detonations === 0,
    'with reactions off, a different element lands bare damage and detonates nothing',
    { dealt: off.withOff.dealt, detonations: off.detonations }
  );
  h.expect(
    off.withOff.status === 'thunder',
    'though the body still remembers what hit it — the switch gates the bonus, not the bookkeeping',
    { status: off.withOff.status }
  );
  h.expect(
    off.backOn.dealt === 150 && off.total === 1,
    'and turning it back on restores the bonus immediately',
    { dealt: off.backOn.dealt, total: off.total }
  );

  /* ------------------------------------------------------------------ */
  /* 5. through the real damage query the abilities use                   */
  /* ------------------------------------------------------------------ */

  const live = await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    window.__floor();
    window.__pin();
    window.__watchReaction();
    const v = window.__victim(5000);
    const m = app.minions.active[v];
    const centre = { x: 0, y: 0, z: 0 };
    const before = m.hp;
    app.minions.damageCircle(centre, 6, 100, { element: 'ice' });
    const first = round(before - m.hp, 4);
    const status = m.statusElement;
    app.minions.damageCircle(centre, 6, 100, { element: 'thunder' });
    const second = round(before - first - m.hp, 4);
    // Snapshot the count here: the total is read at the end of the block, and
    // by then the later hits have fired too.
    const afterSecond = window.__detonations().length;
    // The detonation consumed the memory, so the next hit can only start a new
    // one — it takes a second elemental hit to fire again.
    const m2before = m.hp;
    app.minions.damageCircle(centre, 6, 100, { element: 'ice' });
    const third = round(m2before - m.hp, 4);
    const afterThird = window.__detonations().length;
    const m3before = m.hp;
    app.minions.damageCircle(centre, 6, 100, { element: 'thunder' });
    const fourth = round(m3before - m.hp, 4);
    return {
      first,
      second,
      third,
      fourth,
      status,
      afterSecond,
      afterThird,
      detonations: window.__detonations().length,
      falloff: s.minions.falloff
    };
  })()`);
  h.rec('a real elemental combo through damageCircle', live);
  h.expect(live.first === 100, 'a dead-centre hit takes the full damage — falloff is 1 at the core', live);
  h.expect(live.status === 'ice', 'and it leaves the body carrying ice', { status: live.status });
  h.expect(
    live.second === 150 && live.afterSecond === 1,
    'the follow-up thunder detonates off the ice for 1.5x through the real query path',
    { dealt: live.second, detonations: live.afterSecond }
  );
  h.expect(
    live.third === 100 && live.afterThird === 1,
    'the hit after a detonation only starts a fresh memory — one hit is never enough to fire again',
    { dealt: live.third, detonations: live.afterThird }
  );
  h.expect(
    live.fourth === 150 && live.detonations === 2,
    'and the one after that detonates on the new memory',
    { dealt: live.fourth, detonations: live.detonations }
  );

  /* ------------------------------------------------------------------ */
  /* 6. everything handed back                                           */
  /* ------------------------------------------------------------------ */

  await ctx.evaluate('(() => { window.__unwatchReaction(); window.__restore6(); window.__floor(); return true; })()');
  const restored = await ctx.evaluate(`(() => {
    const s = window.__settings;
    return {
      enabled: s.reactions.enabled,
      window: s.reactions.window,
      bonus: s.reactions.bonus,
      critChance: s.minions.critChance,
      knockback: s.minions.knockback,
      attackDamage: s.minions.attack.damage,
      rangedEnabled: s.minions.ranged.enabled,
      bossEvery: s.minions.boss.everyNWaves,
      health: s.minions.health
    };
  })()`);
  h.rec('restored', restored);
  h.expect(
    restored.enabled === true &&
      restored.window === 2 &&
      restored.bonus === 1.35 &&
      restored.critChance === 0.12 &&
      restored.knockback === 0.6 &&
      restored.attackDamage === 8 &&
      restored.rangedEnabled === true &&
      restored.bossEvery === 5 &&
      restored.health === 100,
    'every pinned setting is handed back',
    restored
  );

  return { failures: h.failures, steps: h.steps, console: { errors: ctx.errors, warnings: ctx.warnings.length } };
}
