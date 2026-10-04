/**
 * Counts the live editor controls and checks that every settings block worth
 * tuning actually has a knob. The README quotes the total, so this is the
 * thing that says whether that number is still true.
 */
import { harness } from './_harness.mjs';

export default async function run(ctx) {
  const h = harness(ctx);
  const { expect, rec } = h;

  await h.install();

  const out = await ctx.evaluate(`(() => {
    const gui = window.app.editor.gui;
    const all = gui.controllersRecursive();
    const folders = gui.foldersRecursive();
    const title = (f) => f.$title.textContent.trim();
    const names = folders.map(title);
    const find = (name) => folders.find((f) => title(f) === name) ?? null;
    const minion = find('👺  小兵');
    const count = (name) => {
      const f = find(name);
      return f ? f.controllersRecursive().length : -1;
    };
    const s = window.__settings;
    // Every leaf of a settings branch, to compare against the knobs on offer.
    const leaves = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) ? leaves(v, prefix + k + '.') : [prefix + k]
    );
    return {
      total: all.length,
      folders: folders.length,
      names,
      minionKids: minion ? minion.folders.map(title) : [],
      bite: count('还击'),
      ranged: count('远程'),
      boss: count('BOSS'),
      attackLeaves: leaves(s.minions.attack),
      rangedLeaves: leaves(s.minions.ranged),
      bossLeaves: leaves(s.minions.boss)
    };
  })()`);

  rec('editor', {
    total: out.total,
    folders: out.folders,
    minionKids: out.minionKids,
    knobs: { bite: out.bite, ranged: out.ranged, boss: out.boss }
  });

  // Each new block is four to nine leaves wide, and the project's contract is
  // that every tunable value is a live slider — a block reachable only from the
  // console is the one thing the editor promises never to have.
  expect(out.minionKids.includes('还击'), 'the bite has a folder', { kids: out.minionKids });
  expect(out.minionKids.includes('远程'), 'the throwers have a folder', {});
  expect(out.minionKids.includes('BOSS'), 'the boss has a folder', {});
  expect(out.bite === out.attackLeaves.length, 'one knob per bite setting', { knobs: out.bite, leaves: out.attackLeaves });
  expect(out.ranged === out.rangedLeaves.length, 'one knob per thrower setting', { knobs: out.ranged, leaves: out.rangedLeaves });
  expect(out.boss === out.bossLeaves.length, 'one knob per boss setting', { knobs: out.boss, leaves: out.bossLeaves });
  expect(out.total > 1289, 'the editor grew rather than shrank', { total: out.total });

  return { total: out.total };
}
