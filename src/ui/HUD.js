import { ELEMENTS, ELEMENT_META } from '../config/settings.js';
import { ELEMENT_SIGILS } from './glyphs.js';
import { CONTACT_MARKUP, ContactCard } from './contact.js';

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
    this._toastTimer = 0;
    this._statsAccumulator = 0;
    this._frames = 0;
    this._fps = 0;
    /** Last sweep ratio pushed to the DOM, per element. */
    this._cooldownShown = new Map();
    this._armedShown = null;

    root.innerHTML = `
      <div class="hud__panel hud__title">
        元素法术沙盒
        <span data-blurb>按 Q、E、R、F、V、X 或 B 选定法术，瞄准后点击施放。</span>
      </div>

      <div class="hud__panel hud__stats">
        <div>帧率 <b data-stat="fps">—</b></div>
        <div>粒子 <b data-stat="particles">0</b></div>
        <div>实例 <b data-stat="spikes">0</b></div>
        <div>小兵 <b data-stat="minions">0</b></div>
        <div>击杀 <b data-stat="kills">0</b></div>
        <div>绘制调用 <b data-stat="calls">0</b></div>
      </div>

      <div class="hud__panel hud__help">
        <div><strong>Q</strong> — 寒霜长枪 &nbsp; <strong>E</strong> — 风暴长枪</div>
        <div><strong>R</strong> — 灰烬坠落 &nbsp; <strong>F</strong> — 新星光束</div>
        <div><strong>V</strong> — 雷电陷阱 &nbsp; <strong>X</strong> — 冰晶王冠</div>
        <div><strong>B</strong> — 钞票风暴</div>
        <div class="hud__help-note">V、X 和 B 是远距施放 —— 以圆形指示器瞄准，而非箭头。</div>
        <div><strong>移动</strong> — 瞄准 &nbsp; <strong>左键点击</strong> — 施放</div>
        <div><strong>Esc / 右键</strong> — 取消施放</div>
        <div><strong>右键拖动</strong> — 环绕视角 &nbsp; <strong>滚轮</strong> — 缩放</div>
        <div style="margin-top:6px">
          <kbd>G</kbd> 编辑器 &nbsp; <kbd>P</kbd> 暂停 &nbsp; <kbd>C</kbd> 清除 &nbsp; <kbd>M</kbd> 小兵
        </div>
        <div><kbd>H</kbd> 隐藏本面板</div>
        <div class="hud__help-note">暂停状态下，编辑器的每一处修改依然实时生效。</div>
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

      ${CONTACT_MARKUP}

      <div class="hud__toast" data-toast></div>
      <div class="hud__paused" data-paused>已暂停</div>
    `;

    this.cards = new Map();
    for (const card of root.querySelectorAll('.ability-card')) {
      this.cards.set(card.dataset.element, card);
      card.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        this.onAbility?.(card.dataset.element);
      });
    }

    this.minionToggle = root.querySelector('[data-minion-toggle]');
    this.minionState = root.querySelector('[data-minion-state]');
    this.minionToggle.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      this.onToggleMinions?.();
    });

    this.stats = {
      fps: root.querySelector('[data-stat="fps"]'),
      particles: root.querySelector('[data-stat="particles"]'),
      spikes: root.querySelector('[data-stat="spikes"]'),
      calls: root.querySelector('[data-stat="calls"]'),
      minions: root.querySelector('[data-stat="minions"]'),
      kills: root.querySelector('[data-stat="kills"]')
    };
    this.help = root.querySelector('.hud__help');
    this.toast = root.querySelector('[data-toast]');
    this.pausedBadge = root.querySelector('[data-paused]');
    this.abilityBar = root.querySelector('.hud__abilities');
    this.contact = new ContactCard(root);
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
