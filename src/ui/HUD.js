import { settings, ELEMENTS, ELEMENT_META } from '../config/settings.js';
import { ELEMENT_SIGILS } from './glyphs.js';
import { CONTACT_MARKUP, ContactCard } from './contact.js';
import { sfx } from '../audio/Sound.js';

/** The shop's four tracks — mirrored in `game/Player.js`, which prices them. */
const SHOP_TRACKS = [
  { id: 'damage', label: '法术强度', effect: (p) => `伤害 +${Math.round(p.damagePerLevel * 100)}%` },
  { id: 'cooldown', label: '急速施法', effect: (p) => `冷却 -${Math.round(p.cooldownPerLevel * 100)}%` },
  { id: 'vitality', label: '活力', effect: (p) => `生命上限 +${p.vitalityPerLevel}` },
  { id: 'pace', label: '轻盈', effect: (p) => `移速/磁吸 +${Math.round(p.pacePerLevel * 100)}%` }
];

/**
 * Heads-up display: the ability bar, controls, live stats and toasts.
 *
 * Plain DOM — no framework. The bar is built from `ELEMENTS`, so a new ability
 * appears in it on its own; the slots are the only interactive part, and they
 * mirror the keyboard shortcuts through `onAbility`.
 *
 * The cooldown sweep is a `conic-gradient` driven by a CSS custom property, so
 * updating it every frame is one `setProperty` call and never touches layout.
 */
export class HUD {
  constructor(root) {
    this.root = root;
    this.onAbility = null;
    this.onToggleMinions = null;
    this.onRestart = null;
    this.onBuy = null; // (track) — set by App, priced by Player
    this.onToggleSound = null;
    this._toastTimer = 0;
    this._statsAccumulator = 0;
    this._frames = 0;
    this._fps = 0;
    /** Last sweep ratio pushed to the DOM, per element. */
    this._cooldownShown = new Map();
    this._armedShown = null;
    /** The hurt vignette: pumped on damage, decays every frame. */
    this._hurt = 0;
    this._hpShown = '';

    root.innerHTML = `
      <div class="hud__panel hud__title">
        元素法术沙盒
        <span data-blurb>按 Q、E、R、F、V、X、B、Z 或 N 选定法术，瞄准后点击施放。</span>
      </div>

      <div class="hud__panel hud__stats">
        <div>帧率 <b data-stat="fps">—</b></div>
        <div>粒子 <b data-stat="particles">0</b></div>
        <div>实例 <b data-stat="spikes">0</b></div>
        <div>小兵 <b data-stat="minions">0</b></div>
        <div>击杀 <b data-stat="kills">0</b></div>
        <div>波次 <b data-stat="wave">0</b></div>
        <div>金币 <b data-stat="gold">0</b></div>
        <div>绘制调用 <b data-stat="calls">0</b></div>
      </div>

      <div class="hud__panel hud__help">
        <div><strong>Q</strong> — 寒霜长枪 &nbsp; <strong>E</strong> — 风暴长枪</div>
        <div><strong>R</strong> — 灰烬坠落 &nbsp; <strong>F</strong> — 新星光束</div>
        <div><strong>V</strong> — 雷电陷阱 &nbsp; <strong>X</strong> — 冰晶王冠</div>
        <div><strong>B</strong> — 钞票风暴 &nbsp; <strong>Z</strong> — 聚能奇点</div>
        <div><strong>N</strong> — 雷光锁链</div>
        <div class="hud__help-note">V、X、B 是远距施放；<strong>Z 蓄力、N 引导</strong> —— 按住左键不放，松手释放。</div>
        <div><strong>WASD</strong> — 移动 &nbsp; <strong>空格</strong> — 翻滚闪避</div>
        <div><strong>左键点击</strong> — 施放 &nbsp; <strong>Esc / 右键</strong> — 取消施放</div>
        <div><strong>右键拖动</strong> — 环绕视角 &nbsp; <strong>滚轮</strong> — 缩放</div>
        <div style="margin-top:6px">
          <kbd>G</kbd> 编辑器 &nbsp; <kbd>P</kbd> 暂停 &nbsp; <kbd>C</kbd> 清除 &nbsp; <kbd>M</kbd> 小兵 &nbsp; <kbd>T</kbd> 商店
        </div>
        <div><kbd>H</kbd> 隐藏本面板</div>
        <div class="hud__help-note">不同元素在 2 秒内先后命中同一目标会触发<strong>元素反应</strong>（超导 / 蒸爆 / 感电…）。</div>
      </div>

      <div class="hud__abilities">
        ${ELEMENTS.map((element) => {
          const meta = ELEMENT_META[element];
          return `
            <div class="ability-card" data-element="${element}" style="--accent:${meta.accent}">
              <div class="ability-card__sweep" data-sweep></div>
              <div class="ability-card__key">${meta.key}</div>
              <div class="ability-card__glyph">${ELEMENT_SIGILS[element] ?? ''}</div>
              <div class="ability-card__label">${meta.label}</div>
            </div>`;
        }).join('')}
        <button class="minion-toggle" data-minion-toggle title="显示/隐藏小兵 (M)">
          <span class="minion-toggle__dot"></span>
          <span class="minion-toggle__label">小兵</span>
          <span class="minion-toggle__state" data-minion-state>开</span>
        </button>
      </div>

      <div class="hud__player" data-player>
        <div class="hud__hp">
          <i data-hpfill></i>
          <span data-hptext>—</span>
        </div>
        <div class="hud__dash" data-dash><i></i><span>翻滚</span></div>
      </div>

      ${CONTACT_MARKUP}

      <div class="hud__shop" data-shop hidden>
        <h3>强化商店 <kbd>T</kbd></h3>
        <p class="hud__shop__gold">金币 <b data-shop-gold>0</b> —— 小兵掉落，走过去拾取</p>
        <div data-shop-items></div>
      </div>

      <div class="hud__death" data-death hidden>
        <div class="hud__death__card">
          <h2>你倒下了</h2>
          <p data-death-stats></p>
          <button data-restart>重新开始（Enter）</button>
        </div>
      </div>

      <div class="hud__hurt" data-hurt></div>
      <div class="hud__toast" data-toast></div>
      <div class="hud__paused" data-paused>已暂停</div>
    `;

    this.cards = new Map();
    for (const card of root.querySelectorAll('.ability-card')) {
      this.cards.set(card.dataset.element, card);
      card.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        sfx.ui(1.2);
        this.onAbility?.(card.dataset.element);
      });
    }

    this.minionToggle = root.querySelector('[data-minion-toggle]');
    this.minionState = root.querySelector('[data-minion-state]');
    this.minionToggle.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      sfx.ui();
      this.onToggleMinions?.();
    });

    this.stats = {
      fps: root.querySelector('[data-stat="fps"]'),
      particles: root.querySelector('[data-stat="particles"]'),
      spikes: root.querySelector('[data-stat="spikes"]'),
      calls: root.querySelector('[data-stat="calls"]'),
      minions: root.querySelector('[data-stat="minions"]'),
      kills: root.querySelector('[data-stat="kills"]'),
      wave: root.querySelector('[data-stat="wave"]'),
      gold: root.querySelector('[data-stat="gold"]')
    };
    this.help = root.querySelector('.hud__help');
    this.toast = root.querySelector('[data-toast]');
    this.pausedBadge = root.querySelector('[data-paused]');
    this.abilityBar = root.querySelector('.hud__abilities');
    this.contact = new ContactCard(root);

    /* --- the player's corner: hp, the dash pip, the shop, the fall --- */
    this.hpFill = root.querySelector('[data-hpfill]');
    this.hpText = root.querySelector('[data-hptext]');
    this.hpBar = root.querySelector('.hud__hp');
    this.dashPip = root.querySelector('[data-dash]');
    this.hurtVeil = root.querySelector('[data-hurt]');
    this.shop = root.querySelector('[data-shop]');
    this.shopGold = root.querySelector('[data-shop-gold]');
    this.shopItems = root.querySelector('[data-shop-items]');
    this.death = root.querySelector('[data-death]');
    this.deathStats = root.querySelector('[data-death-stats]');

    root.querySelector('[data-restart]').addEventListener('click', () => {
      sfx.ui();
      this.onRestart?.();
    });

    // The shop's rows are built once; refresh() only rewrites numbers.
    this._shopRows = new Map();
    for (const track of SHOP_TRACKS) {
      const row = document.createElement('button');
      row.className = 'hud__shop-row';
      row.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        if (this.onBuy?.(track.id)) this.refreshShop();
        else sfx.ui(0.7);
      });
      row.innerHTML = `
        <span class="hud__shop-name">${track.label}</span>
        <span class="hud__shop-effect" data-effect></span>
        <span class="hud__shop-cost" data-cost></span>`;
      this.shopItems.appendChild(row);
      this._shopRows.set(track.id, {
        row,
        effect: row.querySelector('[data-effect]'),
        cost: row.querySelector('[data-cost]')
      });
    }
  }

  /** @param {{silent?: boolean}} [options] */
  setElement(element, options = {}) {
    for (const [key, card] of this.cards) {
      card.classList.toggle('is-active', key === element);
    }
    const meta = ELEMENT_META[element];
    this.contact.setAccent(meta?.accent);
    if (meta && !options.silent) this.showToast(`已选定「${meta.hint}」`);
  }

  /** Play the contact card's entrance once the loading veil is clearing. */
  reveal() {
    this.contact.reveal();
  }

  /** Highlight the slot while a cast is armed. */
  setArmed(armed) {
    if (armed === this._armedShown) return;
    this._armedShown = armed;
    this.abilityBar.classList.toggle('is-armed', armed);
  }

  /**
   * Drive one slot's cooldown sweep. Cooldowns are per ability, so this is
   * called once per element each frame.
   *
   * @param {string} element
   * @param {number} remaining seconds left
   * @param {number} total     the full cooldown, for the sweep angle
   */
  setCooldown(element, remaining, total) {
    const card = this.cards.get(element);
    if (!card) return;

    const ratio = Math.max(0, Math.min(1, remaining / Math.max(total, 0.001)));
    // Only touch the DOM when the sweep visibly moves.
    if (Math.abs(ratio - (this._cooldownShown.get(element) ?? -1)) < 0.01) return;
    this._cooldownShown.set(element, ratio);
    card.style.setProperty('--cooldown', ratio);
    card.classList.toggle('is-cooling', ratio > 0.001);
  }

  setPaused(paused) {
    this.pausedBadge.classList.toggle('is-visible', paused);
  }

  /** Mirror the minion system's on/off state onto the chip beside the bar. */
  setMinionsEnabled(enabled) {
    this.minionToggle.classList.toggle('is-on', enabled);
    this.minionState.textContent = enabled ? '开' : '关';
  }

  /* ------------------------------------------------------------------ */
  /* the player's corner                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} ratio 0..1 through the health pool
   * @param {number} hp
   * @param {number} maxHp
   */
  setPlayerHp(ratio, hp, maxHp) {
    const text = `${Math.ceil(hp)} / ${Math.ceil(maxHp)}`;
    // The text is the only layout-touching write; gate it like the sweeps.
    if (text === this._hpShown) return;
    this._hpShown = text;
    this.hpText.textContent = text;
    this.hpFill.style.setProperty('--hp', Math.max(0, Math.min(1, ratio)));
    this.hpBar.classList.toggle('is-low', ratio < 0.3);
  }

  /** Pump the hurt vignette; it decays in `update`. */
  hurtFlash(strength = 1) {
    this._hurt = Math.min(1, this._hurt + strength);
  }

  /** The dash pip: bright when ready, sweeping its cooldown otherwise. */
  setDash(ratio) {
    this.dashPip.classList.toggle('is-ready', ratio <= 0);
    this.dashPip.style.setProperty('--dash', Math.max(0, Math.min(1, ratio)));
  }

  toggleShop() {
    const open = this.shop.hidden;
    this.shop.hidden = !open;
    return open;
  }

  get shopOpen() {
    return !this.shop.hidden;
  }

  /** The shop reads prices and levels off the player, handed over once. */
  bindPlayer(player) {
    this._player = player;
  }

  /** Rewrite the shop's numbers — costs move, and the gold basket drifts. */
  refreshShop() {
    const player = this._player;
    if (!player) return;
    this.shopGold.textContent = settings.progression.gold;
    for (const [id, row] of this._shopRows) {
      const level = settings.progression[`${id}Level`];
      const track = SHOP_TRACKS.find((t) => t.id === id);
      const cost = player.cost(id);
      row.effect.textContent = `${track.effect(settings.progression)} · Lv.${level}`;
      row.cost.textContent = `${cost} ¥`;
      row.row.classList.toggle('is-affordable', settings.progression.gold >= cost);
    }
  }

  /** The run is over. */
  showDeath(kills, wave, gold) {
    this.death.hidden = false;
    this.deathStats.textContent = `击杀 ${kills} · 支撑了 ${wave} 波 · 拾得 ${gold} 金币`;
  }

  hideDeath() {
    this.death.hidden = true;
  }

  toggleHelp() {
    this.help.classList.toggle('is-hidden');
  }

  showToast(message, duration = 1600) {
    this.toast.textContent = message;
    this.toast.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toast.classList.remove('is-visible'), duration);
  }

  /**
   * @param {number} dt
   * @param {() => {particles:number, spikes:number, calls:number}} collect
   *   Called only when the readout actually refreshes, so gathering the numbers
   *   (which means walking the particle pools) stays off the hot path.
   */
  update(dt, collect) {
    // The hurt vignette decays on real time, one style write a frame.
    if (this._hurt > 0.001) {
      this._hurt = Math.max(0, this._hurt - dt * 2.2);
      this.hurtVeil.style.opacity = this._hurt;
    }

    this._frames++;
    this._statsAccumulator += dt;
    if (this._statsAccumulator < 0.4) return;

    this._fps = Math.round(this._frames / this._statsAccumulator);
    this._frames = 0;
    this._statsAccumulator = 0;

    const info = collect();
    this.stats.fps.textContent = this._fps;
    this.stats.particles.textContent = info.particles;
    this.stats.spikes.textContent = info.spikes;
    this.stats.calls.textContent = info.calls;
    this.stats.minions.textContent = info.minions ?? 0;
    this.stats.kills.textContent = info.kills ?? 0;
    this.stats.wave.textContent = info.wave ?? 0;
    this.stats.gold.textContent = info.gold ?? 0;
  }
}

/** Boot screen helper. */
export class LoadingScreen {
  constructor() {
    this.element = document.getElementById('loader');
    this.fill = document.getElementById('loader-fill');
    this.status = document.getElementById('loader-status');
  }

  setProgress(ratio, message) {
    this.fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    if (message) this.status.textContent = message;
  }

  hide() {
    this.setProgress(1);
    setTimeout(() => this.element.classList.add('is-hidden'), 220);
  }

  fail(message) {
    this.status.textContent = message;
    this.status.style.color = '#ff7a6a';
  }
}
