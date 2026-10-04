/**
 * HUD layout sweep.
 *
 * The bottom band is shared by the centred ability bar, the help card in the
 * left corner and the contact card in the right one, and the bar's width is
 * fixed by nine slots plus the minion pill. Every breakpoint in styles.css
 * exists to keep those three from touching, so this walks the widths where the
 * steps live and reads the boxes back off the live DOM rather than trusting the
 * arithmetic in a comment.
 *
 * Pure DOM: no rendering work, so it runs fast even under SwiftShader.
 */
const WIDTHS = [
  [1920, 1080],
  [1700, 950],
  [1661, 900],
  [1660, 900],
  [1600, 900],
  [1440, 900],
  [1366, 768],
  [1280, 720],
  [1180, 800],
  [1100, 800],
  [1060, 720],
  [1024, 768],
  [900, 700],
  [800, 640],
  [760, 600]
];

/** Read every box the HUD keeps in a corner, live, with the shop's state. */
function readBoxes() {
  const q = (s) => document.querySelector(s);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: +r.left.toFixed(1),
      right: +r.right.toFixed(1),
      top: +r.top.toFixed(1),
      bottom: +r.bottom.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1)
    };
  };
  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01;
  };

  const els = {
    bar: q('.hud__abilities'),
    help: q('.hud__help'),
    contact: q('.hud__contact'),
    player: q('.hud__player'),
    stats: q('.hud__stats'),
    title: q('.hud__title'),
    shop: q('[data-shop]')
  };

  const out = { vw: innerWidth, vh: innerHeight, shopOpen: !!(els.shop && !els.shop.hidden) };
  for (const [key, el] of Object.entries(els)) {
    out[key] = box(el);
    out[`${key}Visible`] = visible(el);
  }

  const cards = [...document.querySelectorAll('.ability-card')];
  out.cardCount = cards.length;
  out.cardWidth = cards.length ? +cards[0].getBoundingClientRect().width.toFixed(1) : null;
  // A wrapped CJK label is the failure mode that rules out shrinking the slots
  // instead of moving the corner cards: one client rect per line box.
  out.labelLines = cards.map((c) => c.querySelector('.ability-card__label')?.getClientRects().length ?? 0);
  // Does the glyph (a fixed 34px square) still fit the box it sits in?
  const glyph = cards[0]?.querySelector('.glyph-svg');
  out.glyphWidth = glyph ? +glyph.getBoundingClientRect().width.toFixed(1) : null;
  const cardClip = cards[0];
  out.cardOverflowX = cardClip ? +(cardClip.scrollWidth - cardClip.clientWidth).toFixed(1) : null;
  return out;
}

/** Intersection of two boxes, in both axes — the only kind that matters. */
function overlap(a, b) {
  if (!a || !b) return { w: 0, h: 0, hits: false };
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return { w: +w.toFixed(1), h: +h.toFixed(1), hits: w > 0.5 && h > 0.5 };
}

export default async function layout(ctx) {
  const failures = [];
  const rows = [];

  const check = (where, ok, detail) => {
    if (!ok) failures.push({ where, detail });
    ctx.trace(`${ok ? 'PASS' : 'FAIL'} ${where}`, ok ? '' : JSON.stringify(detail));
  };

  // Fades (the shop standing the hint card down) are 0.3s transitions, and a
  // software-rendered page only turns a frame every ~500ms — so read the settled
  // state instead of racing the clock.
  await ctx.evaluate(`(() => {
    const s = document.createElement('style');
    s.id = 'cdp-no-motion';
    s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
    document.head.appendChild(s);
    return true;
  })()`);

  for (const [w, h] of WIDTHS) {
    await ctx.viewport(w, h);

    for (const shopOpen of [false, true]) {
      const state = await ctx.call(async (open) => {
        const app = window.app;
        if (!app) return null;
        const isOpen = !!app.hud.shopOpen;
        if (isOpen !== open) app.hud.toggleShop();
        return null;
      }, shopOpen);
      void state;

      const m = await ctx.evaluate(`(${readBoxes.toString()})()`);
      const label = `${w}x${h}${shopOpen ? ' +shop' : ''}`;
      rows.push({ view: label, ...m });

      // 1. The action bar is the primary target; the corner cards give way.
      check(`${label}: bar clears the help card`, !overlap(m.bar, m.help).hits, {
        bar: m.bar,
        help: m.help,
        overlap: overlap(m.bar, m.help)
      });
      check(`${label}: bar clears the contact card`, !overlap(m.bar, m.contact).hits, {
        bar: m.bar,
        contact: m.contact,
        overlap: overlap(m.bar, m.contact)
      });
      // 2. Corner panels must not walk off the viewport or on top of each other.
      check(`${label}: help card stays inside the viewport`, !m.helpVisible || (m.help.left >= 0 && m.help.right <= m.vw + 0.5 && m.help.top >= 0), m.help);
      check(`${label}: contact card stays inside the viewport`, !m.contactVisible || (m.contact.left >= 0 && m.contact.right <= m.vw + 0.5 && m.contact.top >= 0), m.contact);
      check(`${label}: help card clears the hp bar`, !m.helpVisible || !overlap(m.help, m.player).hits, { help: m.help, player: m.player, overlap: overlap(m.help, m.player) });
      check(`${label}: help card clears the stat stack`, !m.helpVisible || !overlap(m.help, m.stats).hits, { help: m.help, stats: m.stats });
      // 3. Labels stay on one line and the glyph stays inside its slot.
      check(`${label}: all nine labels are single-line`, m.labelLines.every((n) => n <= 1), { labelLines: m.labelLines, cardWidth: m.cardWidth });
      check(`${label}: the glyph fits its slot`, m.glyphWidth == null || m.glyphWidth <= (m.cardWidth ?? 0) - 8, { glyphWidth: m.glyphWidth, cardWidth: m.cardWidth });
      check(`${label}: the slot does not clip its contents`, m.cardOverflowX == null || m.cardOverflowX <= 0, { cardOverflowX: m.cardOverflowX });
      // 4. The shop owns the help panel's column while it is open.
      if (shopOpen) {
        check(`${label}: the shop stands the help card down`, !m.helpVisible, { helpVisible: m.helpVisible, helpOpacity: m.help });
      }
    }

    if ((w === 1920 && h) || (w === 1280 && h === 720)) {
      await ctx.shot(`layout-${w}x${h}`);
    }
  }

  // Leave the shop shut for whatever runs next.
  await ctx.evaluate('window.app?.hud.shopOpen && window.app.hud.toggleShop()');

  return { failures, rows, errors: ctx.errors.length, warnings: ctx.warnings.length };
}
