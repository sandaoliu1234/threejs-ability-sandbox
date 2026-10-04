/**
 * Stage 4 of the six-stage pass — loot and the shop.
 *
 * What this locks down:
 *   - the item pool starts empty (a regression guard: it used to be seeded into
 *     the *live* list, so the first frame banked all 96 invisible coins as gold
 *     and pushed every one back onto the free list a second time);
 *   - a kill sheds exactly one piece of loot, gold or medicine;
 *   - coin worth is `goldMin..goldMax`, and a boss flings a ring of them;
 *   - the two radii: inside `magnetRadius` loot accelerates to the purse,
 *     inside `pickupRadius` it is banked, outside the magnet it just sits;
 *   - loot expires on its own clock and is never banked;
 *   - `settings.drops.enabled` really is the master switch;
 *   - the shop's price curve, its refusal when the purse is short, what each of
 *     the four tracks actually bends, and the fact that a restart wipes it all.
 *
 * Everything that the win screen would spoil (crit, healing, the boss cadence)
 * is pinned per-test and restored at the end from `window.__keep4`.
 */
import { harness, round } from './_harness.mjs';

export default async function (ctx) {
  const h = harness(ctx);
  await h.install();

  await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    const d = app.drops;

    window.__keep4 = {
      enabled: s.drops.enabled,
      healChance: s.drops.healChance,
      goldLife: s.drops.goldLife,
      goldMin: s.drops.goldMin,
      goldMax: s.drops.goldMax,
      minions: s.minions.enabled,
      critChance: s.minions.critChance,
      everyNWaves: s.minions.boss.everyNWaves
    };

    /** The whole ledger, so one assertion can stand for the entire economy. */
    window.__ledger = () => {
      const p = app.player;
      return {
        gold: s.progression.gold,
        levels: [s.progression.damageLevel, s.progression.cooldownLevel, s.progression.vitalityLevel, s.progression.paceLevel],
        live: d.items.length,
        free: d._free.length,
        hp: +p.hp.toFixed(4),
        maxHp: +p.maxHp.toFixed(4),
        damageMult: +p.damageMult.toFixed(4),
        cooldownMult: +p.cooldownMult.toFixed(4),
        moveSpeed: +p.moveSpeed.toFixed(4),
        magnet: +p.magnetRadius.toFixed(4)
      };
    };

    /** Live loot, described. */
    window.__loot = () =>
      d.items.map((i) => ({
        heal: i.heal,
        worth: i.worth,
        at: [+i.mesh.position.x.toFixed(2), +i.mesh.position.z.toFixed(2)],
        life: +i.life.toFixed(3)
      }));

    /**
     * A clean ledger: nothing on the floor, no upgrades, full health at the
     * origin, no minions. The argument is the purse the test wants to start from.
     *
     * The sweep has to run long enough to bury the dead, and clearAll() does
     * *not* do it: vanish() opens with 'if (!this.alive) return;', so a body
     * that was killed outright is already dying and is left alone. It then
     * takes its full fall — fallTime + deadPause + sinkTime = 0.55 + 0.3 +
     * 0.85 = 1.7 s, because _updateDying's 2.2x speed-up only applies to a
     * body that actually went through vanish(). 102 frames at 1/60; the sweep
     * is 120 so there is margin. Get this wrong and active[0] is a corpse,
     * applyDamage returns early on !alive, and the test silently measures
     * nothing.
     */
    window.__reset = (gold) => {
      app.aim.cancel();
      app.minions.clearAll();
      app.minions.waveCount = 0;
      s.minions.enabled = false;
      app.drops.clear();
      for (const t of ['damage', 'cooldown', 'vitality', 'pace']) s.progression[t + 'Level'] = 0;
      s.progression.gold = gold || 0;
      app.player.reset();
      app.hud.hideDeath();
      app.character.setDead(false);
      app.character.resetPlacement();
      app.character.root.position.set(0, 0, 0);
      app.__fast(120, 1 / 60);
      if (app.minions.active.length) {
        throw new Error('the floor did not clear: ' + app.minions.active.length + ' bodies left in active');
      }
      return window.__ledger();
    };

    // Loot placed by hand, so the magnet is measured against a known distance
    // rather than wherever a minion happened to fall.
    window.__coinAt = (x, z, worth) => {
      d._spawnCoin(x, z, worth);
      return d.items.length;
    };
    window.__healAt = (x, z) => {
      d._spawnHeal(x, z);
      return d.items.length;
    };

    window.__restore = () => {
      const k = window.__keep4;
      s.drops.enabled = k.enabled;
      s.drops.healChance = k.healChance;
      s.drops.goldLife = k.goldLife;
      s.drops.goldMin = k.goldMin;
      s.drops.goldMax = k.goldMax;
      s.minions.enabled = k.minions;
      s.minions.critChance = k.critChance;
      s.minions.boss.everyNWaves = k.everyNWaves;
      return true;
    };

    return true;
  })()`);

  /* ------------------------------------------------------------------ */
  /* 1. the pool itself                                                  */
  /* ------------------------------------------------------------------ */

  // Read before touching anything: this is the state the running app reached
  // on its own, a good ten seconds of frames after boot, standing at origin.
  const attached = await ctx.evaluate('window.__ledger()');
  const boot = await ctx.evaluate(`(() => {
    const d = window.app.drops;
    return { live: d.items.length, free: d._free.length, alive: d.items.filter((i) => i.active).length };
  })()`);
  h.rec('state at attach', { ...boot, gold: attached.gold });
  h.expect(
    boot.live === 0 && boot.alive === 0,
    'the pool starts empty, not strewn invisible across the floor',
    boot
  );
  h.expect(boot.free === boot.live + boot.free && boot.free === 96, 'and every pooled item rests on the free list exactly once', {
    free: boot.free,
    expected: 96
  });
  h.expect(attached.gold === 0, 'a fresh run starts broke, not with the pool banked as gold', {
    gold: attached.gold
  });

  /* ------------------------------------------------------------------ */
  /* 2. a kill sheds loot                                                */
  /* ------------------------------------------------------------------ */

  await ctx.evaluate(`(() => {
    window.__settings.drops.healChance = 0;
    window.__settings.drops.goldMin = 1;
    window.__settings.drops.goldMax = 3;
    return window.__reset(0);
  })()`);

  const death = await ctx.evaluate(`(() => {
    const app = window.app;
    app.minions._spawnWave(1);
    const before = app.drops.items.length;
    app.minions.active[0].applyDamage(1e6, 0, 1);
    return { before, after: app.drops.items.length, loot: window.__loot(), kills: app.kills };
  })()`);
  h.expect(death.after === death.before + 1, 'a dead minion sheds exactly one piece of loot', death);
  h.expect(
    death.loot.length === 1 && death.loot[0].heal === false,
    'with healChance at zero the drop is metal, not medicine',
    { loot: death.loot }
  );
  h.expect(
    death.loot[0].worth >= 1 && death.loot[0].worth <= 3,
    'a coin is worth goldMin..goldMax',
    { worth: death.loot[0].worth, goldMin: 1, goldMax: 3 }
  );

  // The whole range should actually show up, or `goldMax` is a dead setting.
  const spread = await ctx.evaluate(`(() => {
    const app = window.app;
    app.drops.clear();
    window.__settings.progression.gold = 0;
    for (let i = 0; i < 80; i++) app.drops.drop({ x: 9, y: 0, z: 9 }, false);
    const worths = app.drops.items.map((i) => i.worth);
    return { count: worths.length, seen: [...new Set(worths)].sort(), min: Math.min(...worths), max: Math.max(...worths) };
  })()`);
  h.rec('eighty drops', spread);
  h.expect(spread.min >= 1 && spread.max <= 3, 'eighty drops all land inside the spread', spread);
  h.expect(spread.seen.length === 3, 'and the spread actually covers goldMin..goldMax', { seen: spread.seen });

  const medicine = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    window.__settings.drops.healChance = 1;
    app.minions._spawnWave(1);
    app.minions.active[0].applyDamage(1e6, 0, -1);
    return { loot: window.__loot(), healAmount: window.__settings.drops.healAmount };
  })()`);
  h.expect(
    medicine.loot.length === 1 && medicine.loot[0].heal === true,
    'healChance 1 turns the roll into an orb',
    medicine
  );
  h.expect(medicine.loot[0].worth === 20, "and the orb is worth healAmount", {
    worth: medicine.loot[0].worth,
    healAmount: 20
  });

  // An orb is only worth banking if it heals: at full health it must be
  // refused and merely rattled into the purse as sound.
  const overflow = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    window.__settings.drops.healChance = 1;
    const full = app.player.hp;
    app.minions._spawnWave(1);
    app.minions.active[0].applyDamage(1e6, 0, -1);
    const orb = app.drops.items[0];
    orb.mesh.position.set(0, 0.3, window.__settings.drops.pickupRadius - 0.05);
    app.__fast(2 / 60, 1 / 60);
    return { full, hp: +app.player.hp.toFixed(3), gold: window.__settings.progression.gold, live: app.drops.items.length };
  })()`);
  h.expect(
    overflow.gold === 0 && overflow.live === 0,
    'an orb at full health is picked up but banks no gold',
    overflow
  );

  const wounded = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    window.__settings.drops.healChance = 1;
    app.player.damage(40, 0, 1);
    app.__fast(1 / 60, 1 / 60);
    app.minions._spawnWave(1);
    app.minions.active[0].applyDamage(1e6, 0, -1);
    const orb = app.drops.items[0];
    orb.mesh.position.set(0, 0.3, window.__settings.drops.pickupRadius - 0.05);
    const before = +app.player.hp.toFixed(3);
    app.__fast(2 / 60, 1 / 60);
    return { before, after: +app.player.hp.toFixed(3), healAmount: window.__settings.drops.healAmount };
  })()`);
  h.expect(
    wounded.after === wounded.before + 20,
    'a wounded caster drinks the orb for healAmount',
    wounded
  );

  /* ------------------------------------------------------------------ */
  /* 3. a boss pays a purse                                              */
  /* ------------------------------------------------------------------ */

  const boss = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    window.__settings.drops.healChance = 0;
    window.__settings.minions.boss.everyNWaves = 1;
    app.minions._spawnWave(2);
    const isBoss = app.minions.active.map((m) => m.isBoss);
    app.minions.active[0].applyDamage(1e6, 0, 1);
    return { isBoss, loot: window.__loot() };
  })()`);
  h.expect(boss.isBoss[0] === true, 'the first body of a boss wave is the boss', { isBoss: boss.isBoss });
  h.expect(boss.loot.length === 10, 'a boss flings a ring of ten coins', { count: boss.loot.length });
  h.expect(
    boss.loot.every((c) => c.worth === 6),
    'each of them is worth a flat six',
    { worths: boss.loot.map((c) => c.worth) }
  );

  /* ------------------------------------------------------------------ */
  /* 4. the magnet and the pickup radius                                 */
  /* ------------------------------------------------------------------ */

  const radii = await ctx.evaluate(`(() => {
    const app = window.app;
    const reset = window.__reset(0);
    return {
      magnet: reset.magnet,
      pickup: window.__settings.drops.pickupRadius,
      floor: app.drops.items.length
    };
  })()`);
  h.expect(radii.floor === 0, 'the floor is bare before the magnet test', { floor: radii.floor });

  // Outside the magnet: the coin just sits there, however long you wait.
  await ctx.evaluate('(() => { window.__coinAt(0, 5.0, 3); return true; })()');
  await h.fast(1.2);
  const far = await ctx.evaluate('({ gold: window.__settings.progression.gold, live: window.app.drops.items.length })');
  h.expect(far.gold === 0 && far.live === 1, 'loot outside magnetRadius is not touched', {
    ...far,
    magnet: radii.magnet
  });

  // Inside it: home in, and bank exactly the coin's worth.
  await ctx.evaluate('(() => { const i = window.app.drops.items[0]; i.mesh.position.set(0, 0.25, 1.8); i.vx = 0; i.vz = 0; return true; })()');
  await h.fast(0.6);
  const near = await ctx.evaluate('({ gold: window.__settings.progression.gold, live: window.app.drops.items.length })');
  h.expect(near.gold === 3 && near.live === 0, 'inside magnetRadius the coin flies to the purse for its own worth', {
    ...near,
    worth: 3
  });

  // Inside the pickup radius it never even has to fly.
  const brushed = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    window.__coinAt(0, window.__settings.drops.pickupRadius - 0.05, 2);
    return { placed: app.drops.items.length, pickup: window.__settings.drops.pickupRadius };
  })()`);
  await h.fast(1 / 60);
  const banked = await ctx.evaluate('({ gold: window.__settings.progression.gold, live: window.app.drops.items.length })');
  h.expect(
    brushed.placed === 1 && banked.gold === 2 && banked.live === 0,
    'loot inside pickupRadius is banked on the next frame',
    { ...banked, pickup: brushed.pickup }
  );

  /* ------------------------------------------------------------------ */
  /* 5. expiry, and the master switch                                    */
  /* ------------------------------------------------------------------ */

  const stale = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    window.__settings.drops.goldLife = 1.0;
    window.__coinAt(0, 5.0, 3);
    return { live: app.drops.items.length, life: +app.drops.items[0].life.toFixed(3) };
  })()`);
  await h.fast(3);
  const rotted = await ctx.evaluate('({ gold: window.__settings.progression.gold, live: window.app.drops.items.length, free: window.app.drops._free.length })');
  h.expect(
    rotted.live === 0 && rotted.gold === 0,
    'loot that is never reached sinks away unbanked',
    { ...rotted, life: stale.life }
  );
  h.expect(rotted.free === 96, 'and an expired item goes back to the pool', { free: rotted.free });

  const off = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    window.__settings.drops.enabled = false;
    app.minions._spawnWave(1);
    app.minions.active[0].applyDamage(1e6, 0, 1);
    const disabled = { live: app.drops.items.length, gold: window.__settings.progression.gold };
    window.__settings.drops.enabled = true;
    return disabled;
  })()`);
  h.expect(off.live === 0 && off.gold === 0, 'settings.drops.enabled is the master switch', off);

  /* ------------------------------------------------------------------ */
  /* 6. the price curve                                                  */
  /* ------------------------------------------------------------------ */

  const curve = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    const seq = [];
    for (let level = 0; level < 5; level++) {
      window.__settings.progression.damageLevel = level;
      seq.push(app.player.cost('damage'));
    }
    window.__settings.progression.damageLevel = 0;
    return { seq, baseCost: window.__settings.progression.baseCost, growth: window.__settings.progression.costGrowth };
  })()`);
  h.expect(
    JSON.stringify(curve.seq) === JSON.stringify([20, 32, 51, 82, 131]),
    'the price curve is baseCost * costGrowth^n, rounded',
    curve
  );

  const broke = await ctx.evaluate(`(() => {
    const app = window.app;
    const ledger = window.__reset(19);
    const bought = app.player.buy('damage');
    return { bought, ...window.__ledger(), price: 20 };
  })()`);
  h.expect(
    broke.bought === false && broke.gold === 19 && broke.levels[0] === 0,
    'a purse one coin short buys nothing',
    broke
  );

  const bogus = await ctx.evaluate('window.app.player.buy("volume")');
  h.expect(bogus === false, 'a track that is not a track is refused', { returned: bogus });

  const sold = await ctx.evaluate(`(() => {
    const app = window.app;
    const before = window.__reset(1000);
    const steps = [];
    for (const id of ['damage', 'cooldown', 'vitality', 'pace']) {
      const price = app.player.cost(id);
      const bought = app.player.buy(id);
      steps.push({ id, price, bought, gold: window.__settings.progression.gold });
    }
    return { before, steps, after: window.__ledger() };
  })()`);
  h.rec('one level of each track', sold);
  h.expect(
    sold.steps.every((s) => s.bought === true),
    'with gold in hand every track sells its first level',
    { steps: sold.steps }
  );
  h.expect(
    sold.after.damageMult === 1.15 && sold.after.cooldownMult === 0.92,
    'damage and cooldown bend their multipliers by one level each',
    { damageMult: sold.after.damageMult, cooldownMult: sold.after.cooldownMult }
  );
  h.expect(
    sold.after.maxHp === 125 && sold.after.hp === 125,
    'vitality raises the ceiling and heals the raise immediately',
    { maxHp: sold.after.maxHp, hp: sold.after.hp }
  );
  h.expect(
    sold.after.moveSpeed === 4.84 && sold.after.magnet === 2.86,
    'pace bends both the walk and the magnet',
    { moveSpeed: sold.after.moveSpeed, magnet: sold.after.magnet }
  );
  h.expect(
    sold.after.gold === 1000 - (20 + 20 + 20 + 20),
    'and the purse pays exactly the four first-level prices',
    { gold: sold.after.gold, spent: 80 }
  );

  const floorMult = await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    window.__reset(1e6);
    let bought = 0;
    for (let i = 0; i < 40; i++) if (app.player.buy('cooldown')) bought++;
    // What the purse could actually reach, and whether it ran dry reaching it.
    const deep = {
      bought,
      level: s.progression.cooldownLevel,
      mult: +app.player.cooldownMult.toFixed(6),
      gold: s.progression.gold,
      dry: app.player.buy('cooldown') === false,
      nextCost: app.player.cost('cooldown'),
      growth: s.progression.costGrowth
    };
    // The floor must not depend on the purse: ask the getter far past it.
    s.progression.cooldownLevel = 60;
    const atSixty = +app.player.cooldownMult.toFixed(6);
    s.progression.cooldownLevel = 0;
    const atZero = +app.player.cooldownMult.toFixed(6);
    s.progression.cooldownLevel = deep.level;
    return { deep, atSixty, atZero, floor: 0.35 };
  })()`);
  h.rec('how deep the cooldown track goes', floorMult);
  h.expect(
    floorMult.atSixty === 0.35 && floorMult.deep.mult === 0.35,
    'the cooldown multiplier is floored at 0.35, however deep the track is bought',
    { atSixty: floorMult.atSixty, atReachable: floorMult.deep.mult, floor: 0.35 }
  );
  h.expect(
    floorMult.deep.dry === true && floorMult.deep.nextCost > floorMult.deep.gold,
    'and the price curve is what stops the buying, not the floor',
    { level: floorMult.deep.level, gold: floorMult.deep.gold, nextCost: floorMult.deep.nextCost, growth: floorMult.deep.growth }
  );
  h.expect(
    floorMult.atZero === 1,
    'at zero levels the multiplier is exactly one',
    { atZero: floorMult.atZero }
  );

  /* ------------------------------------------------------------------ */
  /* 7. the panel                                                        */
  /* ------------------------------------------------------------------ */

  const panel = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(100);
    app.hud.refreshShop();
    const rows = [...document.querySelectorAll('.hud__shop-row')];
    return {
      gold: document.querySelector('[data-shop-gold]').textContent,
      count: rows.length,
      costs: rows.map((r) => r.querySelector('[data-cost]').textContent),
      affordable: rows.map((r) => r.classList.contains('is-affordable'))
    };
  })()`);
  h.expect(panel.count === 4 && panel.gold === '100', 'the shop lists four tracks and reads the purse', panel);
  h.expect(
    panel.costs.every((c) => c.includes('20')),
    'every track opens at baseCost',
    { costs: panel.costs }
  );

  const tight = await ctx.evaluate(`(() => {
    window.__settings.progression.gold = 19;
    window.app.hud.refreshShop();
    const rows = [...document.querySelectorAll('.hud__shop-row')];
    return rows.map((r) => r.classList.contains('is-affordable'));
  })()`);
  h.expect(
    tight.every((v) => v === false),
    'at 19 gold no row is marked affordable',
    { affordable: tight }
  );

  // The row is a real button: drive the same pointerdown the player would.
  const clicked = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(60);
    app.hud.refreshShop();
    const row = document.querySelectorAll('.hud__shop-row')[0];
    const before = window.__ledger();
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return { before, after: window.__ledger(), cost: document.querySelectorAll('[data-cost]')[0].textContent };
  })()`);
  h.rec('clicking the damage row', clicked);
  h.expect(
    clicked.after.levels[0] === 1 && clicked.after.gold === 40,
    'clicking a row buys that level',
    { levels: clicked.after.levels, gold: clicked.after.gold }
  );
  h.expect(
    clicked.cost.includes('32'),
    'and the row immediately quotes the next price',
    { cost: clicked.cost, expected: 32 }
  );

  const keyed = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    const first = app.hud.shopOpen;
    app._handleAction('toggleShop');
    const opened = { open: app.hud.shopOpen, shopping: app.hud.root.classList.contains('is-shopping') };
    app._handleAction('toggleShop');
    const closed = { open: app.hud.shopOpen, shopping: app.hud.root.classList.contains('is-shopping') };
    return { first, opened, closed };
  })()`);
  h.expect(
    keyed.first === false && keyed.opened.open === true && keyed.opened.shopping === true,
    'T opens the shop and hands the hint panel its column',
    keyed
  );
  h.expect(
    keyed.closed.open === false && keyed.closed.shopping === false,
    'and T closes it again',
    keyed.closed
  );

  const deadShop = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    app.player.damage(1e6, 0, 1);
    app._handleAction('toggleShop');
    return { alive: app.player.alive, open: app.hud.shopOpen };
  })()`);
  h.expect(deadShop.open === false, 'a dead caster cannot shop', deadShop);

  /* ------------------------------------------------------------------ */
  /* 8. a new run wipes the ledger                                       */
  /* ------------------------------------------------------------------ */

  const restart = await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset(0);
    window.__settings.progression.gold = 500;
    for (const id of ['damage', 'cooldown', 'vitality', 'pace']) app.player.buy(id);
    app.player.buy('vitality');
    const rich = window.__ledger();
    app._restartRun();
    return { rich, fresh: window.__ledger() };
  })()`);
  h.rec('before and after a restart', restart);
  h.expect(
    restart.rich.levels.join() === '1,1,2,1' && restart.rich.gold > 0,
    'the ledger is genuinely deep before the restart',
    restart.rich
  );
  h.expect(
    restart.fresh.levels.join() === '0,0,0,0' &&
      restart.fresh.gold === 0 &&
      restart.fresh.maxHp === 100 &&
      restart.fresh.hp === 100,
    'a new run zeroes every track, the purse and the health ceiling',
    restart.fresh
  );

  await ctx.evaluate('window.__restore()');
  const restored = await ctx.evaluate(`(() => {
    const s = window.__settings;
    return {
      healChance: s.drops.healChance,
      goldLife: s.drops.goldLife,
      everyNWaves: s.minions.boss.everyNWaves,
      gold: s.progression.gold
    };
  })()`);
  h.expect(restored.healChance === 0.08 && restored.goldLife === 25 && restored.everyNWaves === 5, 'every pinned setting is handed back', restored);

  return { failures: h.failures, steps: h.steps, console: { errors: ctx.errors, warnings: ctx.warnings.length } };
}
