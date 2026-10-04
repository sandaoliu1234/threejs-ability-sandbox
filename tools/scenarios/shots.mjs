/**
 * Stages one frame per system and screenshots it.
 *
 * Assertions can be green while the picture is wrong — a beam that ticks for
 * the right damage but renders as a dot, a boss that is the right size but the
 * wrong colour. This is the scenario that looks.
 *
 * Every frame is staged deterministically (frozen clock, fixed step) and shot
 * with the real render path, so what lands in output/shots is what the game
 * draws.
 */
import { harness } from './_harness.mjs';

const SHOTS = 'output/shots';

export default async function run(ctx) {
  const h = harness(ctx);
  const { expect, rec } = h;

  await h.install();

  // Everything below stages a scene; this puts the pieces in place first.
  await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    window.round = (v, p = 3) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(p) : v);

    window.__reset = () => {
      app.aim.cancel();
      app.abilities.clear();
      app.minions.clearAll();
      app.drops.clear();
      app.minions.waveCount = 0;
      s.minions.enabled = false;
      s.minions.ranged.enabled = false;
      app.input.keys.clear();
      window.__settings.progression.gold = 0;
      app.player.reset();
      app.character.setDead(false);
      app.character.resetPlacement();
      app.character.root.position.set(0, 0, 0);
      app.character.setFacing(0);
      app.__fast(120, 1 / 60);
      return true;
    };

    // One body, stopped where it is put, with enough health to survive the shot.
    window.__prop = (x, z, hp = 5000, opts = {}) => {
      app.minions._spawnWave(1);
      const m = app.minions.active[app.minions.active.length - 1];
      m.phase = opts.phase ?? 'crowd';
      m.root.position.set(x, 0, z);
      m.root.rotation.y = Math.atan2(-x, -z);
      m.hp = hp;
      m.maxHp = hp;
      m._attackTimer = 0;
      m._slamTimer = opts.slamIn ?? 0;
      m.isBoss = !!opts.boss;
      return { index: app.minions.active.indexOf(m), x, z };
    };

    window.__aimAt = (metres, ndcX = 0) => {
      const a = app.aim;
      a.arm();
      a.armed = true;
      a._hasPointer = true;
      let best = null;
      for (let i = -400; i <= 400; i++) {
        const y = i / 400;
        a.point({ x: ndcX, y });
        a._resolve();
        if (!a.valid) continue;
        if (best === null || Math.abs(a.distance - metres) < Math.abs(best.distance - metres)) best = { y };
      }
      if (!best) return null;
      a.point({ x: ndcX, y: best.y });
      a._resolve();
      return window.round(a.distance);
    };

    if (app.editor?.gui) app.editor.gui.hide();
    return true;
  })()`);

  const shot = async (name) => {
    const size = await ctx.shot(name);
    rec(`shot ${name}`, size);
    return size;
  };

  // 1. The somersault, caught at its apex. Nine frames is the top of the arc.
  //    Deliberately no aim: an armed aim draws its own ground arrow, which
  //    would sit in front of the pose this shot exists to show. The heading
  //    0.973 rad is across the view — perpendicular to the rig's forward — so
  //    the body keeps its distance from the camera instead of shrinking toward
  //    the horizon or swelling into it.
  await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset();
    app.character.setFacing(0.973);
    app._dash();
    app.__fast(9, 1 / 60);
    return true;
  })()`);
  const roll = await ctx.evaluate(`(() => {
    const app = window.app;
    return {
      y: window.round(app.character.root.position.y, 4),
      tiltW: window.round(app.character.tilt.quaternion.w, 4),
      rolling: app.character._rolling
    };
  })()`);
  rec('somersault apex', roll);
  await shot('01-somersault-apex');

  // 2. The swarm closing in, mid-bite: three bodies at different distances, one
  //    winding up its lunge so the telegraph is in frame.
  await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset();
    window.__prop(-1.3, -1.2, 5000);
    window.__prop(1.5, -0.9, 5000);
    window.__prop(-0.4, 1.6, 5000);
    window.__prop(3.4, 1.2, 90);
    app.__fast(140, 1 / 60);
    return true;
  })()`);
  const bite = await ctx.evaluate(`(() => {
    const app = window.app;
    return {
      active: app.minions.active.length,
      hp: window.round(app.player.hp),
      lunging: app.minions.active.filter((m) => m.lunge > 0.05).length
    };
  })()`);
  rec('the swarm bites', bite);
  await shot('02-swarm-bite');

  // 3. A boss at the top of its inflate, with the shockwave radius visible.
  await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    window.__reset();
    // Two frames in, the slam clock has barely moved, so the inflate is caught
    // near its peak and the slam itself is still ahead of us.
    // Away from the camera, where the 2.1x body still fits in frame beside the
    // caster — up close it overruns the right edge.
    window.__prop(-1.2, -7.6, 1400, { boss: true, slamIn: 0.33, phase: 'seek' });
    app.__fast(2, 1 / 60);
    return true;
  })()`);
  const boss = await ctx.evaluate(`(() => {
    const app = window.app;
    const b = app.minions.active[0];
    return {
      boss: b?.isBoss,
      hp: b ? window.round(b.hp, 1) : null,
      inflate: b ? window.round(b.bodyPivot.scale.x, 3) : null,
      slamIn: b ? window.round(b._slamTimer, 3) : null,
      playerHp: window.round(app.player.hp)
    };
  })()`);
  rec('boss inflating', boss);
  await shot('03-boss-inflate');

  // 4. Loot on the floor: coins and one heal orb, close enough to magnet.
  await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    window.__reset();
    s.drops.healChance = 1;
    app.drops.drop({ x: 1.1, y: 0, z: 3.4 });
    s.drops.healChance = 0;
    // Well outside the magnet radius (2.6 m): nothing here may be collected
    // before the shot, or the frame is an empty floor.
    for (let i = 0; i < 7; i++) {
      const a = i * 1.44;
      app.drops.drop({ x: Math.sin(a) * 1.9, y: 0, z: 3.2 + Math.cos(a) * 1.1 });
    }
    // A hair of motion so the bob and spin are off their initial frame.
    app.__fast(6, 1 / 60);
    return true;
  })()`);
  const loot = await ctx.evaluate(`(() => {
    const app = window.app;
    const items = app.drops.items;
    return {
      live: items.length,
      heals: items.filter((i) => i.heal).length,
      coins: items.filter((i) => !i.heal).length,
      visible: items.filter((i) => i.mesh.visible).length,
      nearest: items.length ? window.round(Math.hypot(items[0].mesh.position.x, items[0].mesh.position.z), 2) : null
    };
  })()`);
  rec('loot on the floor', loot);
  await shot('04-loot');

  // 5. Tether, mid-channel, sweeping a rank of bodies.
  await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset();
    window.__aimAt(9, -0.35);
    app.selectAbility('tether');
    app.armAbility('tether');
    // Bodies go on the line the beam will actually occupy: the aim direction is
    // live state, so it has to be read rather than guessed.
    const o = app.aim.origin;
    const d = app.aim.direction;
    const reach = app.aim.distance;
    for (const t of [0.4, 0.65, 0.9]) {
      window.__prop(o.x + d.x * reach * t, o.z + d.z * reach * t, 5000);
    }
    app.aim.press();
    // A few frames past the last tick, so the hit flash has decayed and the
    // bodies read as bodies rather than as white blobs.
    app.__fast(24, 1 / 60);
    app.__fast(7, 1 / 60);
    return true;
  })()`);
  const tether = await ctx.evaluate(`(() => {
    const app = window.app;
    const b = app.abilities.holds.get('tether');
    return {
      phase: b?.phase,
      length: b ? window.round(app.character.position.distanceTo(b.target), 2) : null,
      damaged: app.minions.active.filter((m) => m.hp < 5000).length
    };
  })()`);
  rec('tether channel', tether);
  await shot('05-tether');

  // 6. Implosion at full charge, just before the release.
  await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset();
    window.__aimAt(8);
    app.selectAbility('implosion');
    app.armAbility('implosion');
    // The orb sits where the aim resolves, so the body goes there too — inside
    // the collapse, which is the whole point of the frame.
    const o = app.aim.origin;
    const d = app.aim.direction;
    const reach = app.aim.distance;
    window.__prop(o.x + d.x * reach, o.z + d.z * reach, 5000, { phase: 'seek' });
    app.aim.press();
    app.__fast(132, 1 / 60);
    return true;
  })()`);
  const implosion = await ctx.evaluate(`(() => {
    const app = window.app;
    const b = app.abilities.holds.get('implosion');
    return {
      phase: b?.phase,
      charge: b ? window.round(b.charge, 3) : null,
      charge01: b ? window.round(b.charge01, 3) : null,
      radius: b ? window.round(b.radius, 3) : null,
      ranged: b ? window.round(b.target.distanceTo(app.character.position), 2) : null
    };
  })()`);
  rec('implosion at full charge', implosion);
  await shot('06-implosion-charged');

  // 7. A reaction: brand a body with ice, then hit it with thunder, and catch
  //    the spark burst on the frame it detonates.
  await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset();
    window.__prop(0.9, 2.8, 5000, { phase: 'seek' });
    app.minions.damageCircle({ x: 0.9, y: 0, z: 2.8 }, 1.0, 1, { element: 'ice' });
    app.minions.damageCircle({ x: 0.9, y: 0, z: 2.8 }, 1.0, 150, { element: 'thunder' });
    // Long enough for the sparks to leave the body and short enough that the
    // hit flash has faded: the detonation has to be visible as a burst.
    app.__fast(9, 1 / 60);
    return true;
  })()`);
  const reaction = await ctx.evaluate(`(() => {
    const app = window.app;
    const m = app.minions.active[0];
    return {
      hp: m ? window.round(m.hp, 1) : null,
      memory: m ? m.statusElement : null,
      timer: m ? window.round(m.statusTimer, 3) : null,
      sparkPool: !!app.minions._reaction
    };
  })()`);
  rec('reaction detonation', reaction);
  await shot('07-reaction');

  // 8. The death card, since it is the one screen the player cannot miss.
  await ctx.evaluate(`(() => {
    const app = window.app;
    window.__reset();
    app.kills = 17;
    app.minions.waveCount = 6;
    window.__settings.progression.gold = 84;
    app.player.damage(9999, 0, -1);
    app.hud.refreshShop();
    app.__fast(4, 1 / 60);
    return true;
  })()`);
  const death = await ctx.evaluate(`(() => {
    const card = document.querySelector('.hud__death');
    return { visible: card ? !card.hidden : null, text: card ? card.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160) : null };
  })()`);
  rec('death card', death);
  await shot('08-death-card');

  expect(roll.rolling === true && roll.y > 0.4, 'the somersault is off the ground in shot 1', roll);
  expect(loot.heals === 1 && loot.coins === 7, 'shot 4 has both kinds of loot', loot);
  expect(tether.phase === 'hold', 'shot 5 is mid-channel', tether);
  expect(implosion.charge01 === 1, 'shot 6 is at full charge', implosion);
  expect(death.visible === true, 'shot 8 shows the death card', death);

  // 9. The shop, which is the one screen the player spends their loot in.
  await ctx.evaluate(`(() => {
    const app = window.app;
    const s = window.__settings;
    window.__reset();
    app.character.setDead(false);
    app.hud.hideDeath();
    app.player.reset();
    s.progression.gold = 40;
    s.progression.vitalityLevel = 1;
    s.progression.damageLevel = 3;
    app.hud.toggleShop();
    app.hud.refreshShop();
    return true;
  })()`);
  const shop = await ctx.evaluate(`(() => {
    const app = window.app;
    const rows = [...document.querySelectorAll('.hud__shop-row')].map((r) => ({
      name: r.querySelector('.hud__shop-name')?.textContent,
      cost: r.querySelector('[data-cost]')?.textContent,
      affordable: r.classList.contains('is-affordable')
    }));
    return { open: app.hud.shopOpen, gold: window.__settings.progression.gold, rows };
  })()`);
  rec('shop panel', shop);
  await shot('09-shop');

  expect(shop.open === true && shop.rows.length === 4, 'shot 9 shows four shop tracks', shop);

  return { shots: 9, dir: SHOTS };
}
