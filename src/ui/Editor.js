import GUI from 'lil-gui';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { PresetManager } from './PresetManager.js';

/**
 * Real-time VFX editor.
 *
 * Every control binds straight to a field in `config/settings.js`. Because all
 * shaders, particle systems, lights and post passes *read* those fields each
 * frame, no controller needs an onChange handler: moving a slider updates the
 * ice field that is already standing, the bolt that is already in the air, the
 * next cast, the environment and the post stack simultaneously, with no rebuild
 * and no shader recompilation.
 *
 * That holds while the simulation is paused (`P`), which is the point — the
 * silhouette of a frozen eruption and the shape of a frozen bolt are the things
 * worth tuning, and both abilities re-resolve themselves from these values on a
 * zero-length frame.
 */
export class Editor {
  /**
   * @param {object} hooks { onClear, onToast }
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.presets = new PresetManager();

    this.gui = new GUI({ title: '特效编辑器', width: 330 });
    this.gui.domElement.style.setProperty('--title-height', '30px');

    this._presetState = { name: '我的预设', selected: this.presets.names[0] ?? '' };

    this._buildPresets();
    this._buildGlobal();
    this._buildAim();
    this._buildZone();
    this._buildIce();
    this._buildThunder();
    this._buildMeteor();
    this._buildBeam();
    this._buildSnare();
    this._buildGlacier();
    this._buildBanknote();
    this._buildMinions();
    this._buildEnvironment();
    this._buildPost();
    this._buildCamera();
    this._buildCharacter();

    // Everything starts collapsed, top-level folders included. There are enough
    // controls here that any folder left open pushes the rest off the screen,
    // so the panel opens as a list of sections and the user picks one.
    this.gui.foldersRecursive().forEach((folder) => folder.close());
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  static range(folder, object, key, min, max, step, label) {
    return folder.add(object, key, min, max, step).name(label ?? key);
  }

  /**
   * Which clip the body throws when this ability fires.
   *
   * One per ability, because the gesture is part of how a spell reads — the
   * beam and the snare should not be cast the same way. `App` reads the value
   * at the moment of the cast, so switching it applies to the very next click.
   */
  static castAnimation(folder, object) {
    return folder.add(object, 'castAnim', CAST_ANIMATIONS).name('施放动画');
  }

  /**
   * The four colour stops of a particle system's lifetime gradient.
   *
   * `ParticleSystem#setGradient` samples them across a particle's own life, so
   * they are labelled by *when* they are seen rather than by what they are —
   * `A` is the instant it is born, `D` is the moment it dies.
   *
   * @param {string} prefix settings key without the A/B/C/D suffix
   */
  static gradient(folder, object, prefix, title) {
    const group = folder.addFolder(title);
    group.addColor(object, `${prefix}A`).name('初生');
    group.addColor(object, `${prefix}B`).name('前段');
    group.addColor(object, `${prefix}C`).name('后段');
    group.addColor(object, `${prefix}D`).name('消亡');
    return group;
  }

  refresh() {
    this.gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  }

  toggle() {
    this._hidden = !this._hidden;
    this.gui.show(!this._hidden);
  }

  /* ------------------------------------------------------------------ */
  /* folders                                                             */
  /* ------------------------------------------------------------------ */

  _buildPresets() {
    const folder = this.gui.addFolder('预设');
    const state = this._presetState;

    let selector = folder
      .add(state, 'selected', this.presets.names.length ? this.presets.names : [''])
      .name('预设选择');

    // lil-gui rebuilds the controller when the option list changes, so the
    // reference has to be replaced rather than mutated.
    const refreshOptions = () => {
      const names = this.presets.names;
      selector = selector.options(names.length ? names : ['']).name('预设选择');
      selector.setValue(names.includes(state.selected) ? state.selected : (names[0] ?? ''));
    };

    folder.add(state, 'name').name('名称');

    folder
      .add(
        {
          save: () => {
            this.presets.save(state.name);
            state.selected = state.name;
            refreshOptions();
            this.hooks.onToast?.(`已保存预设「${state.name}」`);
          }
        },
        'save'
      )
      .name('保存预设');

    folder
      .add(
        {
          load: () => {
            if (this.presets.load(state.selected)) {
              this.refresh();
              this.hooks.onToast?.(`已加载「${state.selected}」`);
            }
          }
        },
        'load'
      )
      .name('加载预设');

    folder
      .add(
        {
          duplicate: () => {
            const copy = this.presets.duplicate(state.selected);
            if (copy) {
              state.selected = copy;
              refreshOptions();
              this.hooks.onToast?.(`已复制为「${copy}」`);
            }
          }
        },
        'duplicate'
      )
      .name('创建副本');

    folder
      .add(
        {
          remove: () => {
            if (this.presets.remove(state.selected)) {
              refreshOptions();
              this.hooks.onToast?.('预设已删除');
            }
          }
        },
        'remove'
      )
      .name('删除');

    folder.add({ exportOne: () => this.presets.exportJSON() }, 'exportOne').name('导出当前 (JSON)');
    folder.add({ exportAll: () => this.presets.exportAll() }, 'exportAll').name('导出全部预设');

    folder
      .add(
        {
          import: async () => {
            const result = await this.presets.importFromFile();
            refreshOptions();
            this.refresh();
            this.hooks.onToast?.(
              result.applied
                ? '设置已导入'
                : result.imported.length
                  ? `已导入 ${result.imported.length} 个预设`
                  : '未导入任何内容'
            );
          }
        },
        'import'
      )
      .name('导入 JSON…');

    folder
      .add(
        {
          reset: () => {
            this.presets.reset();
            this.refresh();
            this.hooks.onToast?.('已恢复默认设置');
          }
        },
        'reset'
      )
      .name('恢复默认');

    this.presetFolder = folder;
  }

  _buildGlobal() {
    const folder = this.gui.addFolder('全局');
    const g = settings.global;
    const R = Editor.range;

    R(folder, g, 'timeScale', 0.02, 2, 0.01, '时间缩放');
    R(folder, g, 'speed', 0.1, 4, 0.01, '施放速度');
    R(folder, g, 'lifetime', 0.1, 4, 0.01, '持续时间');
    R(folder, g, 'glow', 0, 5, 0.01, '辉光强度');
    R(folder, g, 'shaderIntensity', 0, 2, 0.01, '着色器强度');
    R(folder, g, 'opacity', 0, 2, 0.01, '不透明度');
    R(folder, g, 'noiseFrequency', 0.1, 4, 0.01, '噪声频率');
    R(folder, g, 'noiseSpeed', 0, 4, 0.01, '噪声速度');
    R(folder, g, 'turbulence', 0, 4, 0.01, '湍流');
    R(folder, g, 'randomness', 0, 2, 0.01, '随机度');
    R(folder, g, 'fresnel', 0, 3, 0.01, '菲涅尔强度');
    R(folder, g, 'distortion', 0, 3, 0.01, '热扭曲');

    const particles = folder.addFolder('粒子');
    R(particles, g, 'particleCount', 0, 3, 0.01, '数量');
    R(particles, g, 'particleLifetime', 0.1, 3, 0.01, '持续时间');
    R(particles, g, 'particleSpeed', 0.1, 3, 0.01, '速度');
    R(particles, g, 'particleSize', 0.1, 3, 0.01, '大小');
    R(particles, g, 'emissionRate', 0, 3, 0.01, '发射速率');

    const lighting = folder.addFolder('光照与冲击');
    R(lighting, g, 'lightIntensity', 0, 4, 0.01, '光照强度');
    R(lighting, g, 'lightRadius', 0.1, 4, 0.01, '光照半径');
    R(lighting, g, 'explosionIntensity', 0, 3, 0.01, '撞击强度');
    R(lighting, g, 'cameraShake', 0, 3, 0.01, '镜头震动');
    R(lighting, g, 'animationSpeed', 0, 3, 0.01, '动画速度');

    this.globalFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildAim() {
    const folder = this.gui.addFolder('➤  瞄准指示器');
    const a = settings.aim;
    const R = Editor.range;

    const shape = folder.addFolder('轮廓（米）');
    R(shape, a, 'shaftWidth', 0.05, 2, 0.01, '箭杆半宽');
    R(shape, a, 'headLength', 0.2, 8, 0.05, '箭头长度');
    R(shape, a, 'headWidth', 0.1, 5, 0.01, '箭头半宽');
    R(shape, a, 'round', 0, 0.6, 0.01, '边角圆滑');
    R(shape, a, 'startOffset', 0, 5, 0.05, '距施法者间距');
    R(shape, a, 'height', 0.005, 0.4, 0.005, '悬浮高度');

    const look = folder.addFolder('渲染');
    R(look, a, 'edge', 0.01, 0.5, 0.005, '描边粗细');
    R(look, a, 'edgeGlow', 0, 8, 0.05, '描边辉光');
    R(look, a, 'softness', 0.005, 0.5, 0.005, '边缘柔化');
    R(look, a, 'fill', 0, 1.5, 0.01, '内部填充');
    R(look, a, 'fillFalloff', 0.1, 4, 0.05, '填充衰减');
    R(look, a, 'opacity', 0, 2, 0.01, '不透明度');
    look.addColor(a, 'colorCore').name('中心颜色');
    look.addColor(a, 'colorEdge').name('边缘颜色');
    look.addColor(a, 'colorInvalid').name('过近提示色');

    const energy = folder.addFolder('能量与寒霜');
    R(energy, a, 'stripes', 0, 4, 0.01, '箭羽纹/米');
    R(energy, a, 'stripeSharp', 0, 1, 0.01, '箭羽锐度');
    R(energy, a, 'stripeDepth', 0, 1, 0.01, '箭羽深度');
    R(energy, a, 'scrollSpeed', -10, 10, 0.05, '滚动速度');
    R(energy, a, 'pulse', 0, 1, 0.01, '脉动');
    R(energy, a, 'pulseSpeed', 0, 8, 0.05, '脉冲速度');
    R(energy, a, 'noise', 0, 1.5, 0.01, '寒霜噪声');
    R(energy, a, 'noiseScale', 0.1, 8, 0.05, '噪声缩放');
    R(energy, a, 'noiseSpeed', 0, 3, 0.01, '噪声速度');
    R(energy, a, 'crystals', 0, 2, 0.01, '霜纹板块');
    R(energy, a, 'crystalScale', 0.2, 10, 0.05, '板块缩放');

    const furniture = folder.addFolder('圆环与花饰');
    R(furniture, a, 'baseRing', 0, 3, 0.01, '基环半径');
    R(furniture, a, 'baseRingWidth', 0.005, 0.4, 0.005, '基环宽度');
    R(furniture, a, 'tipGlyph', 0, 2, 0.01, '落点花饰');
    R(furniture, a, 'tipGlyphSize', 0.1, 4, 0.05, '花饰半径');
    R(furniture, a, 'tipSpin', -3, 3, 0.01, '花饰旋转');
    R(furniture, a, 'rangeArc', 0, 2, 0.01, '射程弧线');
    R(furniture, a, 'reveal', 0.01, 1, 0.005, '展开时间');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The far-cast indicator — the circle every zone ability is aimed with.
   *
   * Shared, like the arrow: it is a property of the *targeting*, not of any one
   * ability, so a second far cast inherits the whole thing and brings only its
   * own `zoneRadius`. The two controls worth reaching for first are `boundary`
   * (how thick the footprint edge reads) and `snap` (how hard it overshoots on
   * the way out), which between them decide whether the circle feels like a UI
   * overlay or like something the caster is doing.
   */
  _buildZone() {
    const folder = this.gui.addFolder('◎  远距施放圆环');
    const z = settings.zone;
    const R = Editor.range;

    const edge = folder.addFolder('边界（米）');
    R(edge, z, 'boundary', 0.02, 2, 0.01, '环带厚度');
    R(edge, z, 'boundaryBias', 0, 1, 0.01, '环带偏向（外/内）');
    R(edge, z, 'boundaryGlow', 0, 8, 0.05, '环带辉光');
    R(edge, z, 'liner', 0.005, 0.4, 0.005, '内侧亮线');
    R(edge, z, 'softness', 0.005, 0.4, 0.005, '边缘柔化');
    R(edge, z, 'height', 0.005, 0.4, 0.005, '悬浮高度');

    const inside = folder.addFolder('内部区域');
    R(inside, z, 'fill', 0, 1.5, 0.01, '内部填充');
    R(inside, z, 'fillFalloff', 0.1, 5, 0.05, '填充衰减');
    R(inside, z, 'rings', 0, 12, 0.1, '等高环纹');
    R(inside, z, 'ringWidth', 0.005, 0.5, 0.005, '环纹宽度');
    R(inside, z, 'ringSpeed', -4, 4, 0.01, '环纹速度');
    R(inside, z, 'crawl', 0, 3, 0.01, '丝状数量');
    R(inside, z, 'crawlScale', 0.1, 8, 0.05, '丝状纹/米');
    R(inside, z, 'crawlSpeed', -4, 4, 0.01, '丝状爬行速度');
    R(inside, z, 'noise', 0, 1.5, 0.01, '破碎侵蚀');
    R(inside, z, 'noiseScale', 0.1, 8, 0.05, '破碎缩放');

    const furniture = folder.addFolder('刻度、扫掠与准星');
    R(furniture, z, 'ticks', 0, 96, 1, '边界刻度');
    R(furniture, z, 'tickLength', 0.05, 3, 0.01, '刻度长度');
    R(furniture, z, 'tickWidth', 0.02, 0.9, 0.01, '刻度占空比');
    R(furniture, z, 'tickSpin', -2, 2, 0.005, '刻度旋转');
    R(furniture, z, 'sweep', 0, 3, 0.01, '雷达扫掠');
    R(furniture, z, 'sweepSpeed', -3, 3, 0.01, '扫掠速度');
    R(furniture, z, 'core', 0, 3, 0.01, '中心标记');
    R(furniture, z, 'coreSize', 0.05, 3, 0.01, '中心大小');
    R(furniture, z, 'crosshair', 0, 3, 0.01, '准星臂');
    R(furniture, z, 'crosshairLength', 0.1, 6, 0.05, '准星臂长');
    R(furniture, z, 'pulse', 0, 1, 0.01, '脉动');
    R(furniture, z, 'pulseSpeed', 0, 8, 0.05, '脉冲速度');

    const reach = folder.addFolder('射程环');
    R(reach, z, 'reach', 0, 3, 0.01, '射程环亮度');
    R(reach, z, 'reachWidth', 0.005, 0.5, 0.005, '射程环宽度');
    R(reach, z, 'reachDashes', 0, 200, 1, '虚线段数');
    R(reach, z, 'reachDashGap', 0, 0.95, 0.01, '虚线间隔');
    R(reach, z, 'reachSpin', -1, 1, 0.005, '虚线漂移');
    R(reach, z, 'reachLead', 0, 3, 0.01, '光标侧高亮');

    const look = folder.addFolder('渲染');
    R(look, z, 'opacity', 0, 2, 0.01, '不透明度');
    R(look, z, 'reveal', 0.01, 1, 0.005, '弹出时间');
    R(look, z, 'snap', 1, 2, 0.01, '弹出过冲');
    look.addColor(z, 'colorCore').name('中心颜色');
    look.addColor(z, 'colorEdge').name('填充颜色');
    look.addColor(z, 'colorInvalid').name('过近提示色');
  }

  /* ------------------------------------------------------------------ */

  _buildIce() {
    const folder = this.gui.addFolder('❄  寒霜长枪');
    const c = settings.ice;
    const R = Editor.range;

    const cast = folder.addFolder('施放');
    R(cast, c, 'range', 2, 40, 0.1, '最大距离');
    R(cast, c, 'minRange', 0, 10, 0.1, '最小距离');
    R(cast, c, 'speed', 2, 80, 0.5, '锋面速度');
    R(cast, c, 'lifetime', 0.2, 12, 0.1, '冰场持续时间');
    R(cast, c, 'cooldown', 0, 6, 0.05, '冷却时间');
    Editor.castAnimation(cast, c);

    const field = folder.addFolder('覆盖范围');
    R(field, c, 'widthNear', 0.05, 6, 0.01, '施法者处宽度');
    R(field, c, 'width', 0.1, 10, 0.05, '目标处宽度');
    R(field, c, 'widthCurve', 0.2, 4, 0.01, '宽度曲线');
    R(field, c, 'spikeCount', 4, 288, 1, '水晶数量');
    R(field, c, 'density', 0.05, 1, 0.01, '密度');
    R(field, c, 'clumping', 0.3, 4, 0.01, '向中线聚拢');
    R(field, c, 'scatter', 0, 2, 0.01, '横向散布');
    R(field, c, 'frontBias', 0.3, 3, 0.01, '向目标聚集');

    const shape = folder.addFolder('轮廓');
    R(shape, c, 'heightNear', 0.05, 6, 0.01, '施法者处高度');
    R(shape, c, 'height', 0.1, 12, 0.05, '落点高度');
    R(shape, c, 'heightCurve', 0.2, 5, 0.01, '高度曲线');
    R(shape, c, 'heightJitter', 0, 1.5, 0.01, '高度抖动');
    R(shape, c, 'crown', 0, 0.95, 0.01, '两侧衰减');
    R(shape, c, 'peak', 1, 4, 0.01, '目标处隆起');
    R(shape, c, 'peakWidth', 0.02, 1, 0.01, '隆起范围');
    R(shape, c, 'rubble', 0, 1, 0.01, '碎石占比');
    R(shape, c, 'rubbleScale', 0.05, 1, 0.01, '碎石高度');

    // These four regenerate the crystal geometry — see IceAbility#_syncGeometry.
    const crystal = folder.addFolder('水晶');
    R(crystal, c, 'radius', 0.02, 1.5, 0.01, '底部半径');
    R(crystal, c, 'radiusJitter', 0, 1.5, 0.01, '半径抖动');
    R(crystal, c, 'taper', 0.01, 0.8, 0.01, '尖端收分');
    R(crystal, c, 'facets', 3, 10, 1, '棱面数');
    R(crystal, c, 'roughness', 0, 1, 0.01, '表面粗糙度');
    R(crystal, c, 'bend', 0, 1.5, 0.01, '弯曲');
    R(crystal, c, 'lean', 0, 1.4, 0.01, '离施法者倾角');
    R(crystal, c, 'leanJitter', 0, 1.5, 0.01, '倾角抖动');
    R(crystal, c, 'twist', 0, 1, 0.01, '随机偏航');

    const rise = folder.addFolder('喷发');
    R(rise, c, 'riseTime', 0.02, 1.5, 0.01, '升起时间');
    R(rise, c, 'riseOvershoot', 0, 1, 0.01, '冲出过冲');
    R(rise, c, 'riseStagger', 0, 1, 0.005, '错峰延迟');
    R(rise, c, 'settle', 0.05, 2, 0.01, '回稳时间');
    R(rise, c, 'shatterDelay', 0, 4, 0.05, '下沉前停留');
    R(rise, c, 'sinkTime', 0.1, 4, 0.05, '下沉时间');

    const material = folder.addFolder('冰材质');
    material.addColor(c, 'colorDeep').name('深处');
    material.addColor(c, 'colorIce').name('主体');
    material.addColor(c, 'colorRim').name('轮廓');
    material.addColor(c, 'colorCore').name('内部透光');
    R(material, c, 'opacity', 0, 1, 0.01, '不透明度');
    R(material, c, 'depthTint', 0, 3, 0.01, '厚度染色');
    R(material, c, 'fresnel', 0, 6, 0.01, '菲涅尔');
    R(material, c, 'fresnelPower', 0.5, 6, 0.05, '菲涅尔幂');
    R(material, c, 'translucency', 0, 4, 0.01, '透光度');
    R(material, c, 'envIntensity', 0, 3, 0.01, '环境反射');
    R(material, c, 'facetSharp', 0, 1.5, 0.01, '棱面对比');
    R(material, c, 'fracture', 0, 2, 0.01, '内部裂纹');
    R(material, c, 'fractureScale', 0.5, 20, 0.1, '裂纹缩放');
    R(material, c, 'veins', 0, 2, 0.01, '羽状霜纹');
    R(material, c, 'veinScale', 0.2, 10, 0.05, '霜纹缩放');
    R(material, c, 'glint', 0, 5, 0.01, '表面闪光');
    R(material, c, 'glintScale', 4, 90, 0.5, '闪光密度');
    R(material, c, 'glintSpeed', 0, 4, 0.01, '闪光速度');
    R(material, c, 'frostLine', 0, 1.5, 0.01, '底部霜层');
    R(material, c, 'glow', 0, 5, 0.01, '辉光');
    R(material, c, 'edgeGlow', 0, 6, 0.01, '轮廓辉光');
    R(material, c, 'birthGlow', 0, 10, 0.05, '诞生闪光');
    R(material, c, 'birthFade', 0.02, 2, 0.01, '闪光持续');

    const ground = folder.addFolder('地面霜雪');
    R(ground, c, 'frostSpread', 0.1, 5, 0.01, '霜斑半径');
    R(ground, c, 'frostRate', 0.2, 12, 0.1, '霜斑数/米');
    R(ground, c, 'frostLife', 0.5, 20, 0.1, '霜斑持续');
    R(ground, c, 'frostIntensity', 0, 2, 0.01, '强度');
    R(ground, c, 'frostCrystals', 0, 4, 0.01, '雪粒颗粒感');
    R(ground, c, 'shockRadius', 0.5, 20, 0.1, '冲击波半径');
    ground.addColor(c, 'colorFrost').name('积雪');
    ground.addColor(c, 'colorFrostEdge').name('积雪阴影');
    ground.addColor(c, 'colorShockA').name('冲击波环');
    ground.addColor(c, 'colorShockB').name('冲击波峰');

    const mist = folder.addFolder('雾气、冰屑与闪光');
    R(mist, c, 'mistRate', 0, 900, 1, '雾气速率');
    R(mist, c, 'mistSize', 0.05, 4, 0.01, '雾气大小');
    R(mist, c, 'mistSpeed', 0, 8, 0.05, '雾气速度');
    R(mist, c, 'mistLifetime', 0.2, 8, 0.05, '雾气持续');
    R(mist, c, 'mistOpacity', 0, 2, 0.01, '雾气不透明度');
    R(mist, c, 'mistRise', -2, 4, 0.01, '雾气上升');
    R(mist, c, 'shardRate', 0, 500, 1, '冰屑速率');
    R(mist, c, 'shardSize', 0.005, 0.5, 0.005, '冰屑大小');
    R(mist, c, 'shardSpeed', 0, 25, 0.1, '冰屑速度');
    R(mist, c, 'shardLifetime', 0.1, 5, 0.05, '冰屑持续');
    R(mist, c, 'shardGravity', -40, 0, 0.1, '冰屑重力');
    R(mist, c, 'sparkleRate', 0, 600, 1, '闪光速率');
    R(mist, c, 'sparkleSize', 0.005, 0.4, 0.005, '闪光大小');
    R(mist, c, 'sparkleSpeed', 0, 12, 0.05, '闪光速度');
    R(mist, c, 'sparkleLifetime', 0.2, 8, 0.05, '闪光持续');
    R(mist, c, 'sparkleRise', -2, 8, 0.05, '闪光上升');
    R(mist, c, 'sparkleTurbulence', 0, 3, 0.01, '闪光湍流');
    Editor.gradient(mist, c, 'colorMist', '雾气颜色');
    Editor.gradient(mist, c, 'colorShard', '冰屑颜色');
    Editor.gradient(mist, c, 'colorSparkle', '闪光颜色');

    const impact = folder.addFolder('撞击');
    R(impact, c, 'burstSize', 0.2, 14, 0.05, '爆裂尺寸');
    R(impact, c, 'burstIntensity', 0, 4, 0.01, '爆裂强度');
    R(impact, c, 'burstShards', 0, 400, 1, '爆裂冰屑量');
    R(impact, c, 'impactShake', 0, 3, 0.01, '震动');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, '震动时长');
    R(impact, c, 'impactFlash', 0, 2, 0.01, '全屏闪光');
    R(impact, c, 'rumble', 0, 0.5, 0.005, '行进震颤');
    impact.addColor(c, 'colorBurstA').name('雾气外壳');
    impact.addColor(c, 'colorBurstB').name('外壳主体');
    impact.addColor(c, 'colorBurstC').name('晶板与轮廓');
    impact.addColor(c, 'colorFlash').name('闪光颜色');

    const light = folder.addFolder('动态光源');
    R(light, c, 'lightIntensity', 0, 80, 0.1, '光照强度');
    R(light, c, 'lightRadius', 0.5, 40, 0.1, '光照半径');
    light.addColor(c, 'lightColor').name('光照颜色');

    this.iceFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Storm Lance.
   *
   * Every control here is read by the vertex shader on the frame it changes, so
   * the whole folder reshapes a bolt that is already in the air. The ones worth
   * reaching for first are `jitter` and `jitterScale` (how violently it kinks),
   * `strands` and `spread` (how wide the bundle reads) and `restrike` (how hard
   * it strobes) — those four carry the character of the effect.
   */
  _buildThunder() {
    const folder = this.gui.addFolder('⚡  风暴长枪');
    const c = settings.thunder;
    const R = Editor.range;

    const cast = folder.addFolder('施放');
    R(cast, c, 'range', 2, 60, 0.1, '最大距离');
    R(cast, c, 'minRange', 0, 10, 0.1, '最小距离');
    R(cast, c, 'speed', 5, 400, 1, '落雷速度');
    R(cast, c, 'lifetime', 0.05, 6, 0.01, '闪电持续时间');
    R(cast, c, 'fadeTime', 0.05, 4, 0.01, '消散时间');
    R(cast, c, 'cooldown', 0, 6, 0.05, '冷却时间');
    Editor.castAnimation(cast, c);

    const anchor = folder.addFolder('出手位置');
    R(anchor, c, 'handHeight', 0, 3, 0.01, '手掌高度');
    R(anchor, c, 'handForward', -1, 3, 0.01, '手掌前伸');
    R(anchor, c, 'handSide', -1.5, 1.5, 0.01, '手掌偏移');
    R(anchor, c, 'endHeight', 0, 4, 0.01, '落点高度');
    R(anchor, c, 'sag', -3, 3, 0.01, '中段弓起');

    const bundle = folder.addFolder('电束');
    R(bundle, c, 'strands', 1, 24, 1, '丝状数量');
    R(bundle, c, 'spread', 0, 5, 0.01, '落点散开');
    R(bundle, c, 'spreadNear', 0, 2, 0.01, '出手处散开');
    R(bundle, c, 'spreadCurve', 0.2, 5, 0.01, '散开曲线');
    R(bundle, c, 'twist', -4, 4, 0.01, '沿线扭转');
    R(bundle, c, 'twistSpeed', -6, 6, 0.01, '扭转速度');
    R(bundle, c, 'branchDim', 0, 1, 0.01, '外丝变暗');

    const shape = folder.addFolder('单丝形态');
    R(shape, c, 'jitter', 0, 3, 0.01, '折弯幅度');
    R(shape, c, 'jitterScale', 0.05, 6, 0.01, '折弯数/米');
    R(shape, c, 'octaves', 1, 5, 1, '倍频层数');
    R(shape, c, 'jitterFalloff', 0.1, 0.95, 0.01, '倍频衰减');
    R(shape, c, 'crawl', -20, 20, 0.1, '折弯流动');
    R(shape, c, 'pinch', 0.01, 0.5, 0.005, '端部收束');
    R(shape, c, 'converge', 0, 1, 0.01, '锁定目标');

    const ribbon = folder.addFolder('光带');
    R(ribbon, c, 'width', 0.005, 0.6, 0.005, '出手处宽度');
    R(ribbon, c, 'widthTip', 0.02, 3, 0.01, '目标处宽度');
    R(ribbon, c, 'widthCurve', 0.1, 4, 0.01, '收分曲线');
    R(ribbon, c, 'coreWidth', 1, 6, 0.01, '主芯厚度');
    R(ribbon, c, 'coreSharp', 0.5, 12, 0.05, '核心锐度');
    R(ribbon, c, 'glowWidth', 1, 30, 0.1, '光晕宽度');
    R(ribbon, c, 'glowFalloff', 0.2, 8, 0.05, '光晕衰减');
    R(ribbon, c, 'glowOpacity', 0, 2, 0.01, '光晕不透明度');
    R(ribbon, c, 'softFade', 0.02, 3, 0.01, '相交柔化');

    const strobe = folder.addFolder('闪烁与重塑');
    R(strobe, c, 'restrike', 0.5, 90, 0.5, '重塑次数/秒');
    R(strobe, c, 'flicker', 0, 1, 0.01, '亮度抖动');
    R(strobe, c, 'flickerSpeed', 1, 120, 1, '抖动频率');
    R(strobe, c, 'strandFlash', 0, 1, 0.01, '丝状闪烁');
    R(strobe, c, 'tipGlow', 0, 8, 0.05, '前端辉光');
    R(strobe, c, 'tipLength', 0.005, 0.5, 0.005, '前端长度');

    const material = folder.addFolder('闪电颜色');
    material.addColor(c, 'colorCore').name('核心');
    material.addColor(c, 'colorInner').name('内层');
    material.addColor(c, 'colorOuter').name('外层');
    material.addColor(c, 'colorHalo').name('光晕');
    R(material, c, 'glow', 0, 8, 0.01, '辉光');
    R(material, c, 'opacity', 0, 2, 0.01, '不透明度');

    const ground = folder.addFolder('地面灼痕');
    R(ground, c, 'arcRate', 0.05, 8, 0.05, '灼痕数/米');
    R(ground, c, 'arcRadius', 0.1, 8, 0.05, '灼痕半径');
    R(ground, c, 'arcLife', 0.05, 5, 0.05, '灼痕持续');
    R(ground, c, 'arcIntensity', 0, 3, 0.01, '灼痕强度');
    R(ground, c, 'arcBranches', 0, 3, 0.01, '分叉细节');
    R(ground, c, 'scorchRadius', 0.05, 4, 0.05, '焦痕半径');
    R(ground, c, 'scorchLife', 0.5, 20, 0.1, '焦痕持续');
    R(ground, c, 'scorchIntensity', 0, 2, 0.01, '焦痕强度');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, '冲击波半径');
    ground.addColor(c, 'colorArc').name('灼痕');
    ground.addColor(c, 'colorEmber').name('余烬');
    ground.addColor(c, 'colorScorch').name('焦黑');
    ground.addColor(c, 'colorShockA').name('冲击波环');
    ground.addColor(c, 'colorShockB').name('冲击波峰');

    const sparks = folder.addFolder('火花与微尘');
    R(sparks, c, 'sparkRate', 0, 1200, 1, '火花速率');
    R(sparks, c, 'sparkSize', 0.005, 0.8, 0.005, '火花大小');
    R(sparks, c, 'sparkSpeed', 0, 40, 0.1, '火花速度');
    R(sparks, c, 'sparkLifetime', 0.05, 4, 0.01, '火花持续');
    R(sparks, c, 'sparkGravity', -50, 5, 0.1, '火花重力');
    R(sparks, c, 'sparkStretch', 0, 3, 0.01, '火花拖尾');
    R(sparks, c, 'moteRate', 0, 600, 1, '微尘速率');
    R(sparks, c, 'moteSize', 0.005, 0.4, 0.005, '微尘大小');
    R(sparks, c, 'moteSpeed', 0, 12, 0.05, '微尘速度');
    R(sparks, c, 'moteLifetime', 0.1, 8, 0.05, '微尘持续');
    R(sparks, c, 'moteRise', -3, 8, 0.05, '微尘上升');
    R(sparks, c, 'moteTurbulence', 0, 3, 0.01, '微尘湍流');
    Editor.gradient(sparks, c, 'colorSpark', '火花颜色');
    Editor.gradient(sparks, c, 'colorMote', '微尘颜色');

    const dust = folder.addFolder('烟雾与碎屑');
    R(dust, c, 'smokeRate', 0, 500, 1, '烟雾速率');
    R(dust, c, 'smokeSize', 0.05, 4, 0.01, '烟雾大小');
    R(dust, c, 'smokeSpeed', 0, 8, 0.05, '烟雾速度');
    R(dust, c, 'smokeLifetime', 0.2, 8, 0.05, '烟雾持续');
    R(dust, c, 'smokeOpacity', 0, 1, 0.005, '烟雾不透明度');
    R(dust, c, 'smokeRise', -2, 4, 0.01, '烟雾上升');
    R(dust, c, 'debrisRate', 0, 300, 1, '碎屑速率');
    R(dust, c, 'debrisSize', 0.005, 0.4, 0.005, '碎屑大小');
    R(dust, c, 'debrisSpeed', 0, 25, 0.1, '碎屑速度');
    R(dust, c, 'debrisLifetime', 0.1, 5, 0.05, '碎屑持续');
    R(dust, c, 'debrisGravity', -50, 0, 0.1, '碎屑重力');
    Editor.gradient(dust, c, 'colorSmoke', '烟雾颜色');
    Editor.gradient(dust, c, 'colorDebris', '碎屑颜色');

    const impact = folder.addFolder('出手与撞击');
    R(impact, c, 'muzzleSize', 0.05, 6, 0.05, '出手闪光尺寸');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, '出手闪光强度');
    R(impact, c, 'castFlash', 0, 2, 0.01, '释放闪光');
    impact.addColor(c, 'colorMuzzleA').name('出手外壳');
    impact.addColor(c, 'colorMuzzleB').name('出手主体');
    impact.addColor(c, 'colorMuzzleC').name('出手电弧');
    impact.addColor(c, 'colorCastFlash').name('释放闪光颜色');
    R(impact, c, 'burstSize', 0.2, 14, 0.05, '爆裂尺寸');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, '爆裂强度');
    R(impact, c, 'burstSparks', 0, 600, 1, '爆裂火花数');
    R(impact, c, 'burstDebris', 0, 300, 1, '爆裂碎屑数');
    R(impact, c, 'impactShake', 0, 3, 0.01, '震动');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, '震动时长');
    R(impact, c, 'impactFlash', 0, 2, 0.01, '全屏闪光');
    R(impact, c, 'rumble', 0, 0.5, 0.005, '行进震颤');
    impact.addColor(c, 'colorBurstA').name('爆裂外壳');
    impact.addColor(c, 'colorBurstB').name('爆裂主体');
    impact.addColor(c, 'colorBurstC').name('爆裂电弧');
    impact.addColor(c, 'colorFlash').name('撞击闪光颜色');

    const light = folder.addFolder('动态光源');
    R(light, c, 'lightIntensity', 0, 120, 0.5, '光照强度');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, '光照半径');
    R(light, c, 'lightFlicker', 0, 1, 0.01, '光强闪变');
    R(light, c, 'lightFlickerSpeed', 1, 90, 1, '闪变频率');
    light.addColor(c, 'lightColor').name('光照颜色');

    this.thunderFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Cinder Fall.
   *
   * The seven controls under "The rock" regenerate real geometry — see
   * `MeteorAbility#_syncGeometry` — and everything else is read by a shader or
   * resolved from scratch on the frame it changes, so the whole folder reshapes
   * a meteor that is already in the air. The ones worth reaching for first are
   * `arc` (how hard it is lobbed), `crackWidth` and `chargeCurve` (how the lava
   * seams open on the way in), `trailSpan` and `trailWidth` (how much fire
   * streams off it) and `chunkSpeed` (how far the wreckage is thrown).
   */
  _buildMeteor() {
    const folder = this.gui.addFolder('☄  灰烬坠落');
    const c = settings.meteor;
    const R = Editor.range;

    const cast = folder.addFolder('施放');
    R(cast, c, 'range', 2, 60, 0.1, '最大距离');
    R(cast, c, 'minRange', 0, 10, 0.1, '最小距离');
    R(cast, c, 'speed', 3, 90, 0.5, '飞行速度');
    R(cast, c, 'lifetime', 0.2, 10, 0.1, '弹坑持续时间');
    R(cast, c, 'fadeTime', 0.1, 6, 0.05, '消散时间');
    R(cast, c, 'cooldown', 0, 6, 0.05, '冷却时间');
    Editor.castAnimation(cast, c);

    const path = folder.addFolder('飞行路径');
    R(path, c, 'handHeight', 0, 3, 0.01, '手掌高度');
    R(path, c, 'handForward', -1, 3, 0.01, '手掌前伸');
    R(path, c, 'handSide', -1.5, 1.5, 0.01, '手掌偏移');
    R(path, c, 'endHeight', 0, 4, 0.01, '落点高度');
    R(path, c, 'arc', -4, 12, 0.05, '抛射高度');
    R(path, c, 'arcCurve', 0.1, 4, 0.01, '抛射曲线');

    // Everything down to `craterSize` rebuilds the asteroid geometry. `cuts` is
    // the one that decides whether it reads as stone: it slices flat fracture
    // faces off the ball, which no amount of noise can fake.
    const rock = folder.addFolder('陨石本体');
    R(rock, c, 'radius', 0.05, 3, 0.01, '半径');
    R(rock, c, 'facets', 0, 3, 1, '细分等级');
    R(rock, c, 'lumpiness', 0, 0.8, 0.01, '凹凸起伏');
    R(rock, c, 'lumpScale', 0.2, 6, 0.05, '凸块数/半径');
    R(rock, c, 'surfaceRoughness', 0, 1, 0.01, '表面粗糙度');
    R(rock, c, 'cuts', 0, 16, 1, '断裂面数');
    R(rock, c, 'cutDepth', 0, 0.5, 0.01, '断裂深度');
    R(rock, c, 'craters', 0, 14, 1, '陨坑数');
    R(rock, c, 'craterDepth', 0, 0.6, 0.01, '陨坑深度');
    R(rock, c, 'craterSize', 0.05, 1.4, 0.01, '陨坑大小');
    R(rock, c, 'spin', -20, 20, 0.1, '翻滚速度');

    const seams = folder.addFolder('熔岩裂缝');
    R(seams, c, 'chargeCurve', 0.1, 5, 0.01, '升温曲线');
    R(seams, c, 'crackScale', 0.3, 10, 0.05, '裂缝数/半径');
    R(seams, c, 'crackWidth', 0.005, 0.5, 0.005, '裂缝宽度');
    R(seams, c, 'crackBranches', 0, 1.5, 0.01, '分支裂缝');
    R(seams, c, 'crackGlow', 0, 10, 0.05, '裂缝辉光');
    R(seams, c, 'crackFlow', 0, 1, 0.01, '岩浆流动');
    R(seams, c, 'crackFlowSpeed', 0, 5, 0.01, '流动速度');
    R(seams, c, 'rockScale', 0.2, 10, 0.05, '岩石斑驳');
    R(seams, c, 'facetTint', 0, 1.2, 0.01, '棱面色调');
    R(seams, c, 'cavity', 0, 1, 0.01, '凹陷阴影');
    R(seams, c, 'soot', 0, 1.5, 0.01, '裂缝烟熏');
    R(seams, c, 'rimHeat', 0, 4, 0.01, '热浪护层');
    R(seams, c, 'leadGlow', 0, 6, 0.01, '迎面灼热');
    R(seams, c, 'leadSharp', 0.5, 8, 0.05, '迎面衰减');
    R(seams, c, 'glow', 0, 4, 0.01, '辉光');
    R(seams, c, 'envIntensity', 0, 3, 0.01, '环境反射');
    seams.addColor(c, 'colorRock').name('岩石');
    seams.addColor(c, 'colorChar').name('焦炭');
    seams.addColor(c, 'colorCrack').name('裂缝');
    seams.addColor(c, 'colorHot').name('白热');

    // The trail is a raymarched volume, so these are volume parameters, not
    // surface ones — see `materials/VolumetricFireMaterial.js`. `trailWidth`,
    // `trailPlume` and `trailSpan` set its shape; `trailSteps` is the cost dial.
    const trail = folder.addFolder('火焰尾迹');
    R(trail, c, 'trailSpan', 0.5, 30, 0.1, '尾迹长度');
    R(trail, c, 'trailWidth', 0.02, 2, 0.01, '管道半径');
    R(trail, c, 'trailHeadSize', 0.5, 5, 0.01, '火球尺寸');
    R(trail, c, 'trailPlume', 0.3, 4, 0.01, '向上拉伸');
    R(trail, c, 'trailWakeSpread', 0, 3, 0.01, '尾流扩散');
    R(trail, c, 'trailRise', 0, 3, 0.01, '尾流上浮');
    R(trail, c, 'trailDetachment', 0, 1.5, 0.01, '尾部撕裂');
    R(trail, c, 'trailSoftness', 0.05, 1, 0.01, '表面柔化');
    R(trail, c, 'trailBurnout', 0.05, 4, 0.05, '燃尽时间');
    R(trail, c, 'trailTailFade', 0.01, 0.8, 0.01, '尾部燃尽');

    // Metre-scale lobes. Without these the outline stays a capsule no matter how
    // much fine turbulence is piled on top of it.
    const silhouette = trail.addFolder('轮廓');
    R(silhouette, c, 'trailBulge', 0, 1, 0.01, '瓣状起伏');
    R(silhouette, c, 'trailBulgeScale', 0.05, 2, 0.01, '瓣数/米');
    R(silhouette, c, 'trailShred', 0, 4, 0.01, '边缘撕裂');
    R(silhouette, c, 'trailWisps', 0, 2, 0.01, '丝缕');
    R(silhouette, c, 'trailLick', 0, 8, 0.05, '径向错切');

    const motion = trail.addFolder('运动与湍流');
    R(motion, c, 'trailSpeed', 0, 12, 0.01, '流动速度');
    R(motion, c, 'trailBuoyancy', 0, 10, 0.01, '浮力');
    R(motion, c, 'trailTurbulence', 0, 8, 0.01, '湍流');
    R(motion, c, 'trailNoiseStrength', 0, 4, 0.01, '噪声强度');
    R(motion, c, 'trailNoiseFrequency', 0.1, 10, 0.01, '噪声频率');
    R(motion, c, 'trailWarp', 0, 1.5, 0.01, '域扭曲');
    R(motion, c, 'trailCurl', 0, 3, 0.01, '轴向旋卷');
    R(motion, c, 'trailVortex', 0, 2, 0.01, '涡旋卷起');
    R(motion, c, 'trailRingFrequency', 0, 3, 0.01, '涡环数/米');
    R(motion, c, 'trailRingSpeed', 0, 10, 0.05, '涡环速度');
    R(motion, c, 'trailTongue', 0.2, 3, 0.01, '火舌拉伸');
    R(motion, c, 'trailStreamStretch', 0.2, 3, 0.01, '顺流拉伸');
    R(motion, c, 'trailFlicker', 0, 2, 0.01, '闪烁');
    R(motion, c, 'trailOctaves', 1, 5, 1, '细节倍频');

    // The flame is shaded as a Planckian radiator: colour comes out of the
    // temperature. `trailPalette` blends toward the hand-authored stops instead.
    const heat = trail.addFolder('温度与辐射');
    R(heat, c, 'trailTempCore', 1000, 5000, 10, '核心温度 (K)');
    R(heat, c, 'trailTempEdge', 1000, 4000, 10, '边缘温度 (K)');
    R(heat, c, 'trailEmissionCurve', 1, 6, 0.01, '辐射指数');
    R(heat, c, 'trailHeatFocus', 0.05, 3, 0.01, '聚热程度');
    R(heat, c, 'trailHeatFalloff', 0.05, 4, 0.01, '热度衰减');
    R(heat, c, 'trailHeatFollow', 0, 1, 0.01, '温度随噪声');
    R(heat, c, 'trailTailHeat', 0, 1, 0.01, '废气温度');
    R(heat, c, 'trailScatter', 0, 4, 0.01, '散射');
    R(heat, c, 'trailScatterFalloff', 0.2, 8, 0.05, '散射衰减');
    R(heat, c, 'trailPalette', 0, 1, 0.01, '调色/物理混合');
    heat.addColor(c, 'colorFlameMid').name('火焰中部');
    heat.addColor(c, 'colorFlameEdge').name('火焰边缘');
    heat.addColor(c, 'colorFlameSmoke').name('火焰烟色');

    const march = trail.addFolder('体积渲染');
    R(march, c, 'trailDensity', 0, 6, 0.01, '密度');
    R(march, c, 'trailSoot', 0, 5, 0.01, '烟尘吸收');
    R(march, c, 'trailCoreClarity', 0, 1, 0.01, '核心清晰度');
    R(march, c, 'trailGlow', 0, 8, 0.01, '辉光');
    R(march, c, 'trailOpacity', 0, 2, 0.01, '不透明度');
    R(march, c, 'trailSteps', 6, 72, 1, '步进采样数');

    const chunks = folder.addFolder('崩碎石块');
    R(chunks, c, 'chunkCount', 0, 28, 1, '碎块数');
    R(chunks, c, 'chunkScale', 0.05, 0.8, 0.01, '碎块大小');
    R(chunks, c, 'chunkSpeed', 0, 30, 0.1, '抛出速度');
    R(chunks, c, 'chunkForward', 0, 2, 0.01, '向前偏置');
    R(chunks, c, 'chunkLoft', 0, 1.5, 0.01, '抛射角');
    R(chunks, c, 'chunkGravity', -50, -1, 0.1, '重力');
    R(chunks, c, 'chunkSpin', 0, 20, 0.1, '翻滚速度');
    R(chunks, c, 'chunkCool', 0.1, 8, 0.05, '冷却耗时');
    R(chunks, c, 'chunkLinger', 0, 4, 0.05, '下沉前停留');
    R(chunks, c, 'chunkSink', 0.1, 4, 0.05, '下沉时间');

    const embers = folder.addFolder('余烬与火花');
    R(embers, c, 'emberRate', 0, 900, 1, '余烬速率');
    R(embers, c, 'emberSize', 0.005, 0.5, 0.005, '余烬大小');
    R(embers, c, 'emberSpeed', 0, 15, 0.05, '余烬速度');
    R(embers, c, 'emberLifetime', 0.1, 8, 0.05, '余烬持续');
    R(embers, c, 'emberRise', -3, 8, 0.05, '余烬上升');
    R(embers, c, 'emberGlow', 0, 4, 0.01, '余烬辉光');
    R(embers, c, 'emberTurbulence', 0, 3, 0.01, '余烬湍流');
    R(embers, c, 'sparkRate', 0, 900, 1, '火花速率');
    R(embers, c, 'sparkSize', 0.005, 0.8, 0.005, '火花大小');
    R(embers, c, 'sparkSpeed', 0, 40, 0.1, '火花速度');
    R(embers, c, 'sparkLifetime', 0.05, 4, 0.01, '火花持续');
    R(embers, c, 'sparkGravity', -50, 5, 0.1, '火花重力');
    R(embers, c, 'sparkStretch', 0, 3, 0.01, '火花拖尾');
    Editor.gradient(embers, c, 'colorEmber', '余烬颜色');
    Editor.gradient(embers, c, 'colorSpark', '火花颜色');

    const dust = folder.addFolder('烟雾与尘砾');
    R(dust, c, 'smokeRate', 0, 500, 1, '烟雾速率');
    R(dust, c, 'smokeSize', 0.05, 4, 0.01, '烟雾大小');
    R(dust, c, 'smokeSpeed', 0, 8, 0.05, '烟雾速度');
    R(dust, c, 'smokeLifetime', 0.2, 10, 0.05, '烟雾持续');
    R(dust, c, 'smokeOpacity', 0, 1, 0.005, '烟雾不透明度');
    R(dust, c, 'smokeRise', -2, 5, 0.01, '烟雾上升');
    R(dust, c, 'debrisSize', 0.005, 0.4, 0.005, '尘砾大小');
    R(dust, c, 'debrisSpeed', 0, 25, 0.1, '尘砾速度');
    R(dust, c, 'debrisLifetime', 0.1, 5, 0.05, '尘砾持续');
    R(dust, c, 'debrisGravity', -50, 0, 0.1, '尘砾重力');
    Editor.gradient(dust, c, 'colorSmoke', '烟雾颜色');
    Editor.gradient(dust, c, 'colorDebris', '尘砾颜色');

    const cracks = folder.addFolder('熔岩裂隙');
    R(cracks, c, 'fissureRadius', 0.5, 16, 0.05, '蔓延范围');
    R(cracks, c, 'fissureLife', 0.5, 25, 0.1, '持续时间');
    R(cracks, c, 'fissureArms', 2, 12, 1, '主裂缝数');
    R(cracks, c, 'fissureWander', 0, 6, 0.05, '蜿蜒程度');
    R(cracks, c, 'fissureBranches', 0, 1, 0.01, '分支密度');
    R(cracks, c, 'fissureBranchLength', 0, 1, 0.01, '分支长度');
    R(cracks, c, 'fissureWidth', 0.01, 1, 0.005, '裂缝宽度');
    R(cracks, c, 'fissureHeat', 0, 4, 0.01, '核心热度');
    R(cracks, c, 'fissurePulse', 0, 5, 0.01, '热浪速度');
    R(cracks, c, 'fissureGrowth', 0.5, 40, 0.1, '蔓延速度');
    R(cracks, c, 'fissureRockSize', 0, 1.2, 0.01, '裂缘碎石');

    const ground = folder.addFolder('弹坑');
    R(ground, c, 'scorchRadius', 0.2, 12, 0.05, '焦痕半径');
    R(ground, c, 'scorchLife', 0.5, 20, 0.1, '焦痕持续');
    R(ground, c, 'scorchIntensity', 0, 2, 0.01, '焦痕强度');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, '冲击波半径');
    ground.addColor(c, 'colorScorch').name('焦黑');
    ground.addColor(c, 'colorShockA').name('冲击波环');
    ground.addColor(c, 'colorShockB').name('冲击波峰');

    const impact = folder.addFolder('发射与引爆');
    R(impact, c, 'muzzleSize', 0, 6, 0.05, '发射光焰'); // 0 = no flare
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, '发射强度');
    R(impact, c, 'castFlash', 0, 2, 0.01, '释放闪光');
    impact.addColor(c, 'colorCastFlash').name('释放闪光颜色');
    R(impact, c, 'burstSize', 0.2, 18, 0.05, '火球尺寸');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, '火球强度');
    R(impact, c, 'burstTurbulence', 0, 4, 0.01, '火球湍流');
    R(impact, c, 'burstEmbers', 0, 800, 1, '爆裂余烬数');
    R(impact, c, 'burstSparks', 0, 600, 1, '爆裂火花数');
    R(impact, c, 'burstDebris', 0, 400, 1, '爆裂尘砾数');
    R(impact, c, 'burstSmoke', 0, 300, 1, '爆裂烟雾量');
    R(impact, c, 'impactShake', 0, 3, 0.01, '震动');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, '震动时长');
    R(impact, c, 'impactFlash', 0, 2, 0.01, '全屏闪光');
    R(impact, c, 'rumble', 0, 0.5, 0.005, '行进震颤');
    impact.addColor(c, 'colorFlash').name('撞击闪光颜色');

    const light = folder.addFolder('动态光源');
    R(light, c, 'lightIntensity', 0, 120, 0.5, '光照强度');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, '光照半径');
    R(light, c, 'lightFlicker', 0, 1, 0.01, '光强闪变');
    R(light, c, 'lightFlickerSpeed', 1, 60, 0.5, '闪变频率');
    light.addColor(c, 'lightColor').name('光照颜色');

    this.meteorFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Nova Beam.
   *
   * Every control here is read by a shader on the frame it changes, so the whole
   * folder reshapes a beam that is already burning — pause with **P** halfway
   * through the hold and the entire panel stays live. The ones worth reaching
   * for first are `radius` and `flare` (how heavy the column reads), `charge`
   * and `lifetime` (the wind-up and the hold, which are what make this ability
   * different from the other three), `coils` / `coilTurns` (the ribbons around
   * it) and `streak` / `flowSpeed` (how hard the energy streams downrange).
   */
  _buildBeam() {
    const folder = this.gui.addFolder('✦  新星光束');
    const c = settings.beam;
    const R = Editor.range;

    const cast = folder.addFolder('施放');
    R(cast, c, 'range', 2, 60, 0.1, '最大距离');
    R(cast, c, 'minRange', 0, 10, 0.1, '最小距离');
    R(cast, c, 'charge', 0, 3, 0.01, '蓄力时间');
    R(cast, c, 'speed', 5, 400, 1, '飞行速度');
    R(cast, c, 'lifetime', 0.05, 8, 0.01, '灼烧时间');
    R(cast, c, 'fadeTime', 0.05, 4, 0.01, '塌缩时间');
    R(cast, c, 'cooldown', 0, 6, 0.05, '冷却时间');
    Editor.castAnimation(cast, c);

    const anchor = folder.addFolder('双手出手位置');
    R(anchor, c, 'handHeight', 0, 3, 0.01, '手掌高度');
    R(anchor, c, 'handForward', -1, 3, 0.01, '手掌前伸');
    R(anchor, c, 'handSide', -1.5, 1.5, 0.01, '手掌偏移');
    R(anchor, c, 'endHeight', 0, 4, 0.01, '落点高度');

    const column = folder.addFolder('光柱');
    R(column, c, 'radiusNear', 0.01, 3, 0.01, '出手处半径');
    R(column, c, 'radius', 0.02, 5, 0.01, '落点半径');
    R(column, c, 'radiusCurve', 0.1, 4, 0.01, '半径曲线');
    R(column, c, 'flare', 0, 4, 0.01, '落点扩张');
    R(column, c, 'flareWidth', 0.02, 1, 0.01, '扩张范围');
    R(column, c, 'throb', 0, 0.6, 0.005, '压力波');
    R(column, c, 'throbScale', 0, 12, 0.1, '波数/长度');
    R(column, c, 'throbSpeed', 0, 10, 0.05, '波速');
    R(column, c, 'wander', 0, 1, 0.005, '轴线漂移');
    R(column, c, 'wanderScale', 0.1, 6, 0.05, '漂移缩放');
    R(column, c, 'wanderSpeed', 0, 5, 0.01, '漂移速度');

    // The three tube passes. `coreSharp` and `shellRim` are the pair that decide
    // whether the beam reads as a solid rod or as a lit pipe — see
    // `materials/BeamMaterial.js`.
    const layers = folder.addFolder('核心、外鞘与光晕');
    R(layers, c, 'coreWidth', 0.05, 1.5, 0.01, '核心宽度');
    R(layers, c, 'coreSharp', 0.1, 8, 0.05, '核心聚焦');
    R(layers, c, 'coreFill', 0, 3, 0.01, '核心填充');
    R(layers, c, 'shellWidth', 0.2, 3, 0.01, '外鞘宽度');
    R(layers, c, 'shellRim', 0, 3, 0.01, '外鞘轮廓');
    R(layers, c, 'shellFill', 0, 1.5, 0.01, '外鞘填充');
    R(layers, c, 'shellOpacity', 0, 2, 0.01, '外鞘不透明度');
    R(layers, c, 'edgePower', 0.2, 8, 0.05, '轮廓衰减');
    R(layers, c, 'haloWidth', 0.5, 8, 0.05, '光晕宽度');
    R(layers, c, 'haloRim', 0.5, 10, 0.05, '光晕衰减');
    R(layers, c, 'haloOpacity', 0, 2, 0.01, '光晕不透明度');

    const surface = folder.addFolder('表面与流动');
    R(surface, c, 'ripple', 0, 1, 0.005, '表面涟漪');
    R(surface, c, 'rippleBands', 0.1, 8, 0.05, '环向涟漪');
    R(surface, c, 'rippleScale', 0.1, 12, 0.05, '纵向涟漪');
    R(surface, c, 'rippleSpeed', 0, 12, 0.05, '涟漪爬行');
    R(surface, c, 'streak', 0, 3, 0.01, '丝状数量');
    R(surface, c, 'streakSharp', 0, 1, 0.01, '丝状锐度');
    R(surface, c, 'streakScale', 0.2, 20, 0.1, '丝数/长度');
    R(surface, c, 'streakBands', 0.2, 10, 0.05, '环向丝数');
    R(surface, c, 'streakGlow', 0, 4, 0.01, '丝状热度');
    R(surface, c, 'flowSpeed', 0, 30, 0.1, '流动速度');
    R(surface, c, 'mouthGlow', 0, 6, 0.05, '出手热度');
    R(surface, c, 'mouthLength', 0.005, 0.5, 0.005, '出手范围');
    R(surface, c, 'tipGlow', 0, 6, 0.05, '灼热端热度');
    R(surface, c, 'tipLength', 0.005, 0.5, 0.005, '灼热端长度');
    R(surface, c, 'softFade', 0.02, 3, 0.01, '相交柔化');

    const material = folder.addFolder('光束颜色');
    material.addColor(c, 'colorCore').name('轴线');
    material.addColor(c, 'colorInner').name('内层');
    material.addColor(c, 'colorOuter').name('外鞘');
    material.addColor(c, 'colorHalo').name('光晕');
    R(material, c, 'glow', 0, 8, 0.01, '辉光');
    R(material, c, 'opacity', 0, 2, 0.01, '不透明度');

    const coils = folder.addFolder('螺旋带');
    R(coils, c, 'coils', 0, 8, 1, '带数');
    R(coils, c, 'coilTurns', -8, 8, 0.05, '全长圈数');
    R(coils, c, 'coilSpeed', -6, 6, 0.01, '滚动速度');
    R(coils, c, 'coilRadius', 0.2, 4, 0.01, '环绕半径');
    R(coils, c, 'coilFlare', 0, 4, 0.01, '落点扩张');
    R(coils, c, 'coilWidth', 0.005, 0.6, 0.005, '出手处宽度');
    R(coils, c, 'coilWidthTip', 0.05, 6, 0.01, '目标处宽度');
    R(coils, c, 'coilSharp', 0.2, 8, 0.05, '边缘衰减');
    R(coils, c, 'coilPulse', 0, 1, 0.01, '能量脉冲');
    R(coils, c, 'coilPulseFreq', 0, 12, 0.05, '脉冲数/长度');
    R(coils, c, 'coilPulseSpeed', -8, 8, 0.05, '脉冲速度');
    // Headroom above the shipped values on purpose — they sit high, and a
    // control that starts pinned to its own maximum can only ever come down.
    R(coils, c, 'coilGlow', 0, 14, 0.01, '辉光');
    R(coils, c, 'coilOpacity', 0, 3, 0.01, '不透明度');
    coils.addColor(c, 'colorCoil').name('带核心');
    coils.addColor(c, 'colorCoilEdge').name('带边缘');

    const rings = folder.addFolder('冲击盘');
    R(rings, c, 'rings', 0, 12, 1, '盘数');
    R(rings, c, 'ringSpeed', 0, 6, 0.01, '往返次数/秒');
    R(rings, c, 'ringInner', 0.2, 4, 0.01, '内缘');
    R(rings, c, 'ringOuter', 0.3, 6, 0.01, '外缘');
    R(rings, c, 'ringSwell', 0, 3, 0.01, '前进扩张');
    R(rings, c, 'ringFade', 0, 1, 0.01, '前进淡出');
    R(rings, c, 'ringSharp', 0.2, 8, 0.05, '环带锐度');
    R(rings, c, 'ringGlow', 0, 8, 0.01, '辉光');
    R(rings, c, 'ringOpacity', 0, 2, 0.01, '不透明度');
    rings.addColor(c, 'colorRing').name('圆盘颜色');

    const orb = folder.addFolder('蓄力');
    R(orb, c, 'orbSize', 0.02, 2, 0.01, '光球半径');
    R(orb, c, 'orbThrob', 0, 0.6, 0.005, '光球脉动');
    R(orb, c, 'orbThrobSpeed', 0, 20, 0.1, '脉动频率');
    R(orb, c, 'orbTurbulence', 0, 1, 0.01, '表面湍流');
    R(orb, c, 'orbScale', 0.2, 8, 0.05, '表面细节');
    R(orb, c, 'orbFlow', 0, 5, 0.01, '表面爬行');
    R(orb, c, 'orbBands', 0.5, 15, 0.1, '丝状密度');
    R(orb, c, 'orbRim', 0.2, 6, 0.05, '轮廓衰减');
    R(orb, c, 'orbGlow', 0, 8, 0.01, '辉光');
    R(orb, c, 'orbOpacity', 0, 2, 0.01, '不透明度');
    R(orb, c, 'intakeRate', 0, 900, 1, '吸入速率');
    R(orb, c, 'intakeRadius', 0.2, 8, 0.05, '吸入半径');
    R(orb, c, 'intakeSpeed', 0.5, 25, 0.1, '吸入速度');
    R(orb, c, 'chargeShake', 0, 0.5, 0.005, '蓄力震颤');

    const ground = folder.addFolder('地面反应');
    R(ground, c, 'scorchRate', 0.05, 8, 0.05, '灼痕数/米');
    R(ground, c, 'scorchRadius', 0.05, 4, 0.05, '灼痕半径');
    R(ground, c, 'scorchLife', 0.5, 20, 0.1, '灼痕持续');
    R(ground, c, 'scorchIntensity', 0, 2, 0.01, '灼痕强度');
    R(ground, c, 'dustRate', 0, 20, 0.1, '尘环数/秒');
    R(ground, c, 'dustRadius', 0.2, 10, 0.05, '尘环半径');
    R(ground, c, 'dustLife', 0.1, 5, 0.05, '尘环持续');
    R(ground, c, 'shockRate', 0, 20, 0.1, '冲击环数/秒');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, '冲击波半径');
    ground.addColor(c, 'colorScorch').name('焦黑');
    ground.addColor(c, 'colorEmber').name('余烬');
    ground.addColor(c, 'colorDustA').name('尘埃');
    ground.addColor(c, 'colorDustB').name('尘环波峰');
    ground.addColor(c, 'colorShockA').name('冲击波环');
    ground.addColor(c, 'colorShockB').name('冲击波峰');

    const sparks = folder.addFolder('火花与微尘');
    R(sparks, c, 'sparkRate', 0, 1200, 1, '火花速率');
    R(sparks, c, 'sparkSize', 0.005, 0.8, 0.005, '火花大小');
    R(sparks, c, 'sparkSpeed', 0, 40, 0.1, '火花速度');
    R(sparks, c, 'sparkLifetime', 0.05, 4, 0.01, '火花持续');
    R(sparks, c, 'sparkGravity', -50, 5, 0.1, '火花重力');
    R(sparks, c, 'sparkStretch', 0, 3, 0.01, '火花拖尾');
    R(sparks, c, 'sparkForward', 0, 4, 0.01, '向前拖拽');
    R(sparks, c, 'moteRate', 0, 600, 1, '微尘速率');
    R(sparks, c, 'moteSize', 0.005, 0.4, 0.005, '微尘大小');
    R(sparks, c, 'moteSpeed', 0, 12, 0.05, '微尘速度');
    R(sparks, c, 'moteLifetime', 0.1, 8, 0.05, '微尘持续');
    R(sparks, c, 'moteRise', -3, 8, 0.05, '微尘上升');
    R(sparks, c, 'moteTurbulence', 0, 3, 0.01, '微尘湍流');
    Editor.gradient(sparks, c, 'colorSpark', '火花颜色');
    Editor.gradient(sparks, c, 'colorMote', '微尘颜色');

    const dust = folder.addFolder('蒸汽与碎屑');
    R(dust, c, 'smokeRate', 0, 500, 1, '蒸汽速率');
    R(dust, c, 'smokeSize', 0.05, 4, 0.01, '蒸汽大小');
    R(dust, c, 'smokeSpeed', 0, 8, 0.05, '蒸汽速度');
    R(dust, c, 'smokeLifetime', 0.2, 8, 0.05, '蒸汽持续');
    R(dust, c, 'smokeOpacity', 0, 1, 0.005, '蒸汽不透明度');
    R(dust, c, 'smokeRise', -2, 4, 0.01, '蒸汽上升');
    R(dust, c, 'debrisRate', 0, 300, 1, '碎屑速率');
    R(dust, c, 'debrisSize', 0.005, 0.4, 0.005, '碎屑大小');
    R(dust, c, 'debrisSpeed', 0, 25, 0.1, '碎屑速度');
    R(dust, c, 'debrisLifetime', 0.1, 5, 0.05, '碎屑持续');
    R(dust, c, 'debrisGravity', -50, 0, 0.1, '碎屑重力');
    Editor.gradient(dust, c, 'colorSmoke', '蒸汽颜色');
    Editor.gradient(dust, c, 'colorDebris', '碎屑颜色');

    const impact = folder.addFolder('释放、撞击与灼烧');
    R(impact, c, 'muzzleSize', 0.05, 8, 0.05, '释放外壳');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, '释放强度');
    R(impact, c, 'castFlash', 0, 2, 0.01, '释放闪光');
    impact.addColor(c, 'colorCastFlash').name('释放闪光颜色');
    R(impact, c, 'burstSize', 0.2, 18, 0.05, '撞击外壳');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, '撞击强度');
    R(impact, c, 'burstSparks', 0, 800, 1, '撞击火花数');
    R(impact, c, 'burstDebris', 0, 400, 1, '撞击碎屑数');
    R(impact, c, 'pulseRate', 0, 12, 0.1, '灼烧外壳/秒');
    R(impact, c, 'pulseSize', 0.1, 10, 0.05, '灼烧外壳尺寸');
    R(impact, c, 'pulseIntensity', 0, 5, 0.01, '灼烧外壳强度');
    R(impact, c, 'splashRate', 0, 900, 1, '回溅速率');
    R(impact, c, 'impactShake', 0, 3, 0.01, '震动');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, '震动时长');
    R(impact, c, 'impactFlash', 0, 2, 0.01, '全屏闪光');
    R(impact, c, 'rumble', 0, 0.5, 0.005, '行进震颤');
    R(impact, c, 'burnShake', 0, 0.5, 0.005, '灼烧震颤');
    impact.addColor(c, 'colorBurstA').name('撞击外壳');
    impact.addColor(c, 'colorBurstB').name('撞击主体');
    impact.addColor(c, 'colorBurstC').name('撞击电弧');
    impact.addColor(c, 'colorFlash').name('撞击闪光颜色');

    const light = folder.addFolder('动态光源');
    R(light, c, 'lightIntensity', 0, 120, 0.5, '光束光强');
    R(light, c, 'lightRadius', 0.5, 60, 0.1, '光束半径');
    R(light, c, 'lightPulse', 0, 1, 0.01, '嗡鸣深度');
    R(light, c, 'lightPulseSpeed', 0, 30, 0.1, '嗡鸣频率');
    R(light, c, 'muzzleLightIntensity', 0, 120, 0.5, '手部光强');
    R(light, c, 'muzzleLightRadius', 0.5, 40, 0.1, '手部光半径');
    light.addColor(c, 'lightColor').name('光照颜色');

    this.beamFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Voltaic Snare — the first far cast.
   *
   * `zoneRadius` is the control that matters most here and the only one that
   * reaches outside the ability: it is read by the circle indicator *and* by
   * the tendrils, the rim arcs and the burnt field, so dragging it re-scales
   * what you aim with and what you get at the same time. After that,
   * `snapTime` and `height` carry the moment the trap opens, and `tendrils` /
   * `rimArcs` / `strands` decide how much of the footprint is actually lit.
   */
  _buildSnare() {
    const folder = this.gui.addFolder('◈  雷电陷阱');
    const c = settings.snare;
    const R = Editor.range;

    const cast = folder.addFolder('施放');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, '范围半径');
    R(cast, c, 'range', 2, 50, 0.1, '最大距离');
    R(cast, c, 'minRange', 0, 10, 0.1, '最小距离');
    R(cast, c, 'speed', 5, 300, 1, '电鞭速度');
    R(cast, c, 'snapTime', 0.02, 1.5, 0.01, '张开时间');
    R(cast, c, 'lifetime', 0.1, 12, 0.05, '维持时间');
    R(cast, c, 'fadeTime', 0.05, 4, 0.01, '塌缩时间');
    R(cast, c, 'cooldown', 0, 8, 0.05, '冷却时间');
    Editor.castAnimation(cast, c);

    const leash = folder.addFolder('电鞭');
    R(leash, c, 'handHeight', 0, 3, 0.01, '手掌高度');
    R(leash, c, 'handForward', -1, 3, 0.01, '手掌前伸');
    R(leash, c, 'handSide', -1.5, 1.5, 0.01, '手掌偏移');
    R(leash, c, 'leashStrands', 0, 6, 1, '丝状数量');
    R(leash, c, 'leashSag', -3, 3, 0.01, '中段弓起');
    R(leash, c, 'leashSpread', 0, 2, 0.01, '散开幅度');
    R(leash, c, 'leashCling', 0, 1.5, 0.01, '鞭梢高度');
    R(leash, c, 'leashKink', 0, 2, 0.01, '折弯幅度');
    R(leash, c, 'leashWidth', 0.1, 4, 0.01, '光带宽度');

    const column = folder.addFolder('光柱');
    R(column, c, 'strands', 0, 16, 1, '丝状数量');
    R(column, c, 'height', 0.5, 24, 0.1, '高度');
    R(column, c, 'heightCurve', 0.1, 4, 0.01, '攀升曲线');
    R(column, c, 'throat', 0.005, 1, 0.005, '底部半径（×范围）');
    R(column, c, 'columnSpread', 0.01, 1, 0.005, '顶部半径（×范围）');
    R(column, c, 'columnCurve', 0.1, 5, 0.01, '张开曲线');
    R(column, c, 'columnFlare', 0, 1, 0.005, '顶部扩张');
    R(column, c, 'columnTwist', -4, 4, 0.01, '随高度扭转');
    R(column, c, 'columnSpin', -4, 4, 0.01, '旋转');
    R(column, c, 'columnKink', 0, 2, 0.01, '折弯幅度');
    R(column, c, 'columnWidth', 0.1, 6, 0.01, '光带宽度');
    R(column, c, 'columnTaper', 0.05, 2, 0.01, '向顶收分');

    const tendrils = folder.addFolder('蔓延触须');
    R(tendrils, c, 'tendrils', 0, 20, 1, '触须数');
    R(tendrils, c, 'tendrilInner', 0, 1, 0.005, '起点（×范围）');
    R(tendrils, c, 'tendrilReach', 0.05, 1.6, 0.01, '终点（×范围）');
    R(tendrils, c, 'tendrilCurve', 0.1, 4, 0.01, '延伸曲线');
    R(tendrils, c, 'tendrilWander', 0, 4, 0.01, '偏转幅度');
    R(tendrils, c, 'tendrilArch', 0, 3, 0.01, '跃起高度');
    R(tendrils, c, 'tendrilHug', 0.005, 1, 0.005, '离地间隙');
    R(tendrils, c, 'tendrilSpin', -2, 2, 0.005, '扇形旋转');
    R(tendrils, c, 'tendrilKink', 0, 2, 0.01, '折弯幅度');
    R(tendrils, c, 'tendrilWidth', 0.05, 4, 0.01, '光带宽度');
    R(tendrils, c, 'tendrilDim', 0, 1, 0.01, '相对光柱暗度');

    const rim = folder.addFolder('边缘电弧');
    R(rim, c, 'rimArcs', 0, 14, 1, '电弧数');
    R(rim, c, 'rimSpan', 0.01, 1, 0.005, '弧长（×圆周）');
    R(rim, c, 'rimSpeed', -3, 3, 0.01, '环行速度');
    R(rim, c, 'rimHeight', 0, 3, 0.01, '跃起高度');
    R(rim, c, 'rimJitter', 0, 1, 0.01, '径向摆动');
    R(rim, c, 'rimKink', 0, 2, 0.01, '折弯幅度');
    R(rim, c, 'rimWidth', 0.05, 4, 0.01, '光带宽度');
    R(rim, c, 'rimDim', 0, 1, 0.01, '相对光柱暗度');

    const shape = folder.addFolder('丝状与闪烁');
    R(shape, c, 'jitter', 0, 4, 0.01, '折弯总控');
    R(shape, c, 'jitterScale', 0.05, 8, 0.01, '折弯数/米');
    R(shape, c, 'octaves', 1, 5, 1, '倍频层数');
    R(shape, c, 'jitterFalloff', 0.1, 0.95, 0.01, '倍频衰减');
    R(shape, c, 'crawl', -20, 20, 0.1, '折弯流动');
    R(shape, c, 'pinch', 0.01, 0.5, 0.005, '端部收束');
    R(shape, c, 'restrike', 0.5, 90, 0.5, '重塑次数/秒');
    R(shape, c, 'flicker', 0, 1, 0.01, '亮度抖动');
    R(shape, c, 'flickerSpeed', 1, 120, 1, '抖动频率');
    R(shape, c, 'strandFlash', 0, 1, 0.01, '丝状闪烁');

    const ribbon = folder.addFolder('光带与颜色');
    R(ribbon, c, 'width', 0.005, 0.4, 0.001, '丝状宽度');
    R(ribbon, c, 'coreSharp', 0.5, 12, 0.05, '核心锐度');
    R(ribbon, c, 'glowWidth', 1, 30, 0.1, '光晕宽度');
    R(ribbon, c, 'glowFalloff', 0.2, 8, 0.05, '光晕衰减');
    R(ribbon, c, 'glowOpacity', 0, 2, 0.01, '光晕不透明度');
    R(ribbon, c, 'softFade', 0.02, 3, 0.01, '相交柔化');
    R(ribbon, c, 'glow', 0, 8, 0.01, '辉光');
    R(ribbon, c, 'opacity', 0, 2, 0.01, '不透明度');
    ribbon.addColor(c, 'colorCore').name('核心');
    ribbon.addColor(c, 'colorInner').name('内层');
    ribbon.addColor(c, 'colorOuter').name('外层');
    ribbon.addColor(c, 'colorHalo').name('光晕');

    const field = folder.addFolder('地面法阵');
    R(field, c, 'fieldBoundary', 0.02, 2, 0.01, '环带厚度');
    R(field, c, 'fieldBoundaryGlow', 0, 8, 0.05, '环带辉光');
    R(field, c, 'fieldFill', 0, 2, 0.01, '内部填充');
    R(field, c, 'fieldFalloff', 0.1, 5, 0.05, '填充衰减');
    R(field, c, 'fieldVeins', 0, 3, 0.01, '灼烧纹路');
    R(field, c, 'fieldVeinScale', 0.1, 8, 0.05, '纹路数/米');
    R(field, c, 'fieldVeinSharp', 0, 1, 0.01, '纹路锐度');
    R(field, c, 'fieldWarp', 0, 2, 0.01, '域扭曲');
    R(field, c, 'fieldCrawl', -4, 4, 0.01, '纹路爬行');
    R(field, c, 'fieldRings', 0, 12, 0.1, '压力环数');
    R(field, c, 'fieldRingSpeed', -6, 6, 0.01, '环纹速度');
    R(field, c, 'fieldSpokes', 0, 96, 1, '边界刻度');
    R(field, c, 'fieldSpokeLength', 0.05, 3, 0.01, '刻度长度');
    R(field, c, 'fieldSpin', -2, 2, 0.005, '刻度旋转');
    R(field, c, 'fieldCore', 0, 4, 0.01, '中心光池');
    R(field, c, 'fieldCoreSize', 0.02, 1, 0.005, '光池大小（×范围）');
    R(field, c, 'fieldPulse', 0, 1, 0.01, '脉动');
    R(field, c, 'fieldPulseSpeed', 0, 10, 0.05, '脉冲速度');
    R(field, c, 'fieldOpacity', 0, 2, 0.01, '不透明度');
    R(field, c, 'fieldHeight', 0.005, 0.4, 0.005, '悬浮高度');
    field.addColor(c, 'colorField').name('法阵');
    field.addColor(c, 'colorFieldEdge').name('环带与光池');

    const ground = folder.addFolder('地面灼痕');
    R(ground, c, 'arcRate', 0, 30, 0.1, '边缘灼痕/秒');
    R(ground, c, 'arcRadius', 0.1, 8, 0.05, '灼痕半径');
    R(ground, c, 'arcLife', 0.05, 5, 0.05, '灼痕持续');
    R(ground, c, 'arcIntensity', 0, 3, 0.01, '灼痕强度');
    R(ground, c, 'arcBranches', 0, 3, 0.01, '分叉细节');
    R(ground, c, 'trailRate', 0.05, 8, 0.05, '电鞭灼痕/米');
    R(ground, c, 'scorchRadius', 0.05, 8, 0.05, '焦痕半径');
    R(ground, c, 'scorchLife', 0.5, 20, 0.1, '焦痕持续');
    R(ground, c, 'scorchIntensity', 0, 2, 0.01, '焦痕强度');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, '冲击波半径');
    R(ground, c, 'ringRate', 0, 12, 0.1, '尘环数/秒');
    ground.addColor(c, 'colorArc').name('灼痕');
    ground.addColor(c, 'colorEmber').name('余烬');
    ground.addColor(c, 'colorScorch').name('焦黑');
    ground.addColor(c, 'colorShockA').name('冲击波环');
    ground.addColor(c, 'colorShockB').name('冲击波峰');

    const sparks = folder.addFolder('火花与上升气流');
    R(sparks, c, 'sparkRate', 0, 1200, 1, '火花速率');
    R(sparks, c, 'sparkSize', 0.005, 0.8, 0.005, '火花大小');
    R(sparks, c, 'sparkSpeed', 0, 40, 0.1, '火花速度');
    R(sparks, c, 'sparkLifetime', 0.05, 4, 0.01, '火花持续');
    R(sparks, c, 'sparkGravity', -50, 5, 0.1, '火花重力');
    R(sparks, c, 'sparkStretch', 0, 3, 0.01, '火花拖尾');
    R(sparks, c, 'updraftRate', 0, 900, 1, '气流速率');
    R(sparks, c, 'updraftSize', 0.005, 0.4, 0.005, '气流微尘大小');
    R(sparks, c, 'updraftSpeed', 0, 25, 0.1, '吸入速度');
    R(sparks, c, 'updraftLifetime', 0.1, 8, 0.05, '气流持续');
    R(sparks, c, 'updraftRise', -5, 25, 0.1, '黑位提升');
    R(sparks, c, 'updraftInset', 0, 0.95, 0.01, '吸附内缩');
    R(sparks, c, 'updraftTurbulence', 0, 3, 0.01, '气流旋卷');
    Editor.gradient(sparks, c, 'colorSpark', '火花颜色');
    Editor.gradient(sparks, c, 'colorUpdraft', '气流颜色');

    const dust = folder.addFolder('烟雾与碎屑');
    R(dust, c, 'smokeRate', 0, 500, 1, '烟雾速率');
    R(dust, c, 'smokeSize', 0.05, 4, 0.01, '烟雾大小');
    R(dust, c, 'smokeSpeed', 0, 8, 0.05, '烟雾速度');
    R(dust, c, 'smokeLifetime', 0.2, 8, 0.05, '烟雾持续');
    R(dust, c, 'smokeOpacity', 0, 1, 0.005, '烟雾不透明度');
    R(dust, c, 'smokeRise', -2, 4, 0.01, '烟雾上升');
    R(dust, c, 'debrisRate', 0, 300, 1, '碎屑速率');
    R(dust, c, 'debrisSize', 0.005, 0.4, 0.005, '碎屑大小');
    R(dust, c, 'debrisSpeed', 0, 25, 0.1, '碎屑速度');
    R(dust, c, 'debrisLifetime', 0.1, 5, 0.05, '碎屑持续');
    R(dust, c, 'debrisGravity', -50, 0, 0.1, '碎屑重力');
    Editor.gradient(dust, c, 'colorSmoke', '烟雾颜色');
    Editor.gradient(dust, c, 'colorDebris', '碎屑颜色');

    const impact = folder.addFolder('投掷、张开与维持');
    R(impact, c, 'muzzleSize', 0.05, 6, 0.05, '出手闪光尺寸');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, '出手闪光强度');
    R(impact, c, 'castFlash', 0, 2, 0.01, '释放闪光');
    R(impact, c, 'burstSize', 0.2, 14, 0.05, '张开外壳尺寸');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, '张开外壳强度');
    R(impact, c, 'burstSparks', 0, 600, 1, '张开火花数');
    R(impact, c, 'burstDebris', 0, 300, 1, '张开碎屑数');
    R(impact, c, 'pulseRate', 0, 12, 0.1, '维持外壳/秒');
    R(impact, c, 'pulseSize', 0.1, 10, 0.05, '维持外壳尺寸');
    R(impact, c, 'pulseIntensity', 0, 5, 0.01, '维持外壳强度');
    R(impact, c, 'impactShake', 0, 3, 0.01, '震动');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, '震动时长');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, '维持震颤');
    R(impact, c, 'impactFlash', 0, 2, 0.01, '全屏闪光');
    R(impact, c, 'rumble', 0, 0.5, 0.005, '行进震颤');
    impact.addColor(c, 'colorCastFlash').name('释放闪光颜色');
    impact.addColor(c, 'colorBurstA').name('外壳');
    impact.addColor(c, 'colorBurstB').name('外壳主体');
    impact.addColor(c, 'colorBurstC').name('外壳电弧');
    impact.addColor(c, 'colorFlash').name('张开闪光颜色');

    const light = folder.addFolder('动态光源');
    R(light, c, 'lightIntensity', 0, 120, 0.5, '光照强度');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, '光照半径');
    R(light, c, 'lightHeight', 0, 1, 0.01, '沿光柱高度');
    R(light, c, 'lightFlicker', 0, 1, 0.01, '光强闪变');
    R(light, c, 'lightFlickerSpeed', 1, 90, 1, '闪变频率');
    light.addColor(c, 'lightColor').name('光照颜色');

    this.snareFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Glacial Crown — the far cast that comes out of the floor.
   *
   * `zoneRadius` is again the control that reaches outside the ability: it is
   * read by the circle indicator *and* by the ring of blades, the sheet and the
   * curtain, so dragging it re-scales what you aim with and what you get
   * together. After that the two groups that carry the cast are **The bloom**,
   * where `sweepTime` decides how the ring closes, and **Freeze front &
   * shatter**, which is how the ice arrives and how it leaves.
   */
  _buildGlacier() {
    const folder = this.gui.addFolder('❆  冰晶王冠');
    const c = settings.glacier;
    const R = Editor.range;

    const cast = folder.addFolder('施放');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, '范围半径');
    R(cast, c, 'range', 2, 50, 0.1, '最大距离');
    R(cast, c, 'minRange', 0, 10, 0.1, '最小距离');
    R(cast, c, 'speed', 5, 200, 1, '锋面速度');
    R(cast, c, 'snapTime', 0.02, 1.5, 0.01, '冻结时间');
    R(cast, c, 'lifetime', 0.2, 14, 0.05, '维持时间');
    R(cast, c, 'shatterDelay', 0, 4, 0.01, '碎裂前延迟');
    R(cast, c, 'shatterStagger', 0, 3, 0.01, '碎裂错峰');
    R(cast, c, 'sinkTime', 0.05, 5, 0.01, '崩塌时间');
    R(cast, c, 'cooldown', 0, 8, 0.05, '冷却时间');
    Editor.castAnimation(cast, c);

    const hand = folder.addFolder('锋面出手位置');
    R(hand, c, 'handHeight', 0, 3, 0.01, '手掌高度');
    R(hand, c, 'handForward', -1, 3, 0.01, '手掌前伸');
    R(hand, c, 'handSide', -1.5, 1.5, 0.01, '手掌偏移');
    R(hand, c, 'muzzleSize', 0.05, 6, 0.05, '出手闪光尺寸');
    R(hand, c, 'muzzleIntensity', 0, 5, 0.01, '出手闪光强度');
    R(hand, c, 'castFlash', 0, 2, 0.01, '释放闪光');
    hand.addColor(c, 'colorCastFlash').name('释放闪光颜色');

    const fill = folder.addFolder('填充范围');
    R(fill, c, 'spikeCount', 1, 320, 1, '冰刃数量');
    R(fill, c, 'density', 0.1, 2, 0.01, '密度');
    R(fill, c, 'ringShare', 0, 1, 0.01, '环墙占比');
    R(fill, c, 'coreShare', 0, 0.5, 0.01, '尖塔占比');
    R(fill, c, 'lateShare', 0, 0.5, 0.01, '后发占比');
    R(fill, c, 'ringSeat', 0.2, 1.4, 0.01, '环墙位置（×范围）');
    R(fill, c, 'ringScatter', 0, 0.6, 0.005, '环墙抖动（×范围）');
    R(fill, c, 'skirtSeat', 0, 1.4, 0.01, '裙摆内缘（×范围）');
    R(fill, c, 'skirtBand', 0.02, 1.4, 0.01, '裙摆宽度（×范围）');
    R(fill, c, 'skirtBias', 0.2, 3, 0.01, '裙摆聚拢');
    R(fill, c, 'coreSpread', 0.01, 0.6, 0.005, '尖塔聚簇（×范围）');

    const shape = folder.addFolder('轮廓');
    R(shape, c, 'ringHeight', 0.2, 12, 0.05, '环墙高度');
    R(shape, c, 'ringWave', 0, 1, 0.01, '墙顶起伏');
    R(shape, c, 'skirtHeight', 0.05, 6, 0.05, '裙摆高度');
    R(shape, c, 'coreHeight', 0.2, 12, 0.05, '尖塔高度');
    R(shape, c, 'heightJitter', 0, 1.5, 0.01, '高度抖动');
    R(shape, c, 'ringLean', -1.5, 1.5, 0.01, '环墙倾斜（0 = 栅栏状）');
    R(shape, c, 'skirtLean', -1.5, 1.5, 0.01, '裙摆倾斜');
    R(shape, c, 'coreLean', -1.5, 1.5, 0.01, '尖塔倾斜');
    R(shape, c, 'leanJitter', 0, 3, 0.01, '倾角抖动');
    R(shape, c, 'fan', 0, 1.6, 0.01, '离心展开');
    R(shape, c, 'twist', 0, 1, 0.01, '随机偏航');
    R(shape, c, 'rubble', 0, 1, 0.01, '碎石占比');
    R(shape, c, 'rubbleScale', 0.05, 1, 0.01, '碎石高度');

    const crystal = folder.addFolder('水晶');
    R(crystal, c, 'radius', 0.05, 1.2, 0.005, '底部半径');
    R(crystal, c, 'radiusJitter', 0, 1.5, 0.01, '半径抖动');
    R(crystal, c, 'taper', 0.01, 0.9, 0.01, '尖端收分');
    R(crystal, c, 'facets', 3, 12, 1, '棱面数');
    R(crystal, c, 'roughness', 0, 1, 0.01, '棱面粗糙度');
    R(crystal, c, 'bend', 0, 1.5, 0.01, '弯曲');

    const bloom = folder.addFolder('绽放');
    R(bloom, c, 'sweepTime', 0, 3, 0.01, '环向扫掠');
    R(bloom, c, 'skirtDelay', 0, 2, 0.01, '裙摆延迟');
    R(bloom, c, 'skirtWave', 0, 2, 0.01, '裙摆波浪');
    R(bloom, c, 'coreDelay', 0, 2, 0.01, '尖塔延迟');
    R(bloom, c, 'stagger', 0, 1, 0.005, '随机错峰');
    R(bloom, c, 'bloomSpread', 0, 1, 0.01, '后发冰刃散布');
    R(bloom, c, 'riseTime', 0.02, 1.5, 0.01, '升起时间');
    R(bloom, c, 'riseOvershoot', 0, 1.5, 0.01, '冲出过冲');
    R(bloom, c, 'settle', 0.05, 2, 0.01, '回稳');

    const material = folder.addFolder('棱镜冰晶');
    R(material, c, 'opacity', 0, 1, 0.01, '不透明度');
    R(material, c, 'body', 0, 2, 0.01, '主体（0 = 纯轮廓）');
    R(material, c, 'edgePower', 0.5, 8, 0.01, '边缘收紧');
    R(material, c, 'edgeGain', 0, 6, 0.01, '边缘增益');
    R(material, c, 'dispersion', 0, 1, 0.01, '色散分离');
    R(material, c, 'pipe', 0, 5, 0.01, '透射光');
    R(material, c, 'tipBias', 0.2, 6, 0.01, '尖端聚集');
    R(material, c, 'bands', 0, 8, 0.05, '流动条纹');
    R(material, c, 'pulseSpeed', -4, 4, 0.01, '条纹速度');
    R(material, c, 'tipStart', 0, 1, 0.01, '尖端起始');
    R(material, c, 'tipGlow', 0, 6, 0.01, '尖端辉光');
    R(material, c, 'stria', 0, 3, 0.01, '流线');
    R(material, c, 'striaScale', 0.5, 24, 0.1, '流线密度');
    R(material, c, 'envIntensity', 0, 3, 0.01, '环境反射');
    R(material, c, 'specular', 0, 8, 0.05, '日光闪耀');
    R(material, c, 'glow', 0, 4, 0.01, '辉光');
    R(material, c, 'birthGlow', 0, 6, 0.01, '诞生闪光');
    R(material, c, 'birthFade', 0.02, 3, 0.01, '诞生淡出');
    material.addColor(c, 'colorGlass').name('主体');
    material.addColor(c, 'colorEdge').name('边缘与闪光');
    material.addColor(c, 'colorPrismA').name('色散 A');
    material.addColor(c, 'colorPrismB').name('色散 B');
    material.addColor(c, 'colorCore').name('透射光');
    material.addColor(c, 'colorTip').name('尖端');

    const growth = folder.addFolder('冻结锋面与碎裂');
    R(growth, c, 'frontRough', 0, 1.5, 0.01, '锋面参差');
    R(growth, c, 'frontWidth', 0.01, 0.8, 0.01, '锋面宽度');
    R(growth, c, 'frontGlow', 0, 8, 0.05, '锋面辉光');
    R(growth, c, 'shatterScale', 1, 24, 0.1, '碎裂网格');
    R(growth, c, 'shatterEdge', 0.005, 0.4, 0.005, '裂纹宽度');
    R(growth, c, 'shatterGlow', 0, 8, 0.05, '碎裂辉光');

    const field = folder.addFolder('地面冰面');
    R(field, c, 'fieldBoundary', 0.02, 2, 0.01, '环带厚度');
    R(field, c, 'fieldBoundaryGlow', 0, 8, 0.05, '环带辉光');
    R(field, c, 'fieldFill', 0, 2, 0.01, '内部填充');
    R(field, c, 'fieldFalloff', 0.1, 5, 0.05, '填充衰减');
    R(field, c, 'fieldPlates', 0, 3, 0.01, '板块破碎');
    R(field, c, 'fieldPlateScale', 0.2, 10, 0.05, '板块数/米');
    R(field, c, 'fieldSeam', 0, 3, 0.01, '接缝霜线');
    R(field, c, 'fieldFingers', 0, 3, 0.01, '霜指数');
    R(field, c, 'fieldFingerScale', 0.1, 8, 0.05, '霜指数/米');
    R(field, c, 'fieldWarp', 0, 2, 0.01, '域扭曲');
    R(field, c, 'fieldCrawl', -4, 4, 0.01, '霜指爬行');
    R(field, c, 'fieldRings', 0, 12, 0.1, '压力环数');
    R(field, c, 'fieldRingSpeed', -6, 6, 0.01, '环纹速度');
    R(field, c, 'fieldSweep', 0, 3, 0.01, '寒潮扫掠');
    R(field, c, 'fieldSweepSpeed', -2, 2, 0.01, '扫掠速度');
    R(field, c, 'fieldCore', 0, 4, 0.01, '中心光池');
    R(field, c, 'fieldCoreSize', 0.02, 1, 0.005, '光池大小（×范围）');
    R(field, c, 'fieldPulse', 0, 1, 0.01, '脉动');
    R(field, c, 'fieldPulseSpeed', 0, 10, 0.05, '脉冲速度');
    R(field, c, 'fieldOpacity', 0, 2, 0.01, '不透明度');
    R(field, c, 'fieldHeight', 0.005, 0.4, 0.005, '悬浮高度');
    field.addColor(c, 'colorField').name('冰面');
    field.addColor(c, 'colorFieldEdge').name('环带与接缝');

    const veil = folder.addFolder('寒气帘幕');
    R(veil, c, 'veil', 0, 2, 0.01, '不透明度（0 = 隐藏）');
    R(veil, c, 'veilHeight', 0.1, 8, 0.05, '高度');
    R(veil, c, 'veilRadius', 0.5, 1.6, 0.005, '落位（×范围）');
    R(veil, c, 'veilFlare', -0.5, 1.5, 0.01, '外倾');
    R(veil, c, 'veilBillow', 0, 1.5, 0.01, '轮廓瓣状');
    R(veil, c, 'veilScale', 0.1, 6, 0.05, '噪声/米');
    R(veil, c, 'veilStretch', 0.05, 3, 0.01, '垂直拉伸');
    R(veil, c, 'veilFlow', -4, 4, 0.01, '下落速度');
    R(veil, c, 'veilErode', 0, 1, 0.01, '随高度侵蚀');
    R(veil, c, 'veilFalloff', 0.2, 6, 0.05, '随高度变薄');
    R(veil, c, 'veilSpin', -1, 1, 0.005, '旋转');
    R(veil, c, 'veilSoftFade', 0.02, 3, 0.01, '相交柔化');
    veil.addColor(c, 'colorVeil').name('帘幕');
    veil.addColor(c, 'colorVeilCrest').name('顶部');

    const ground = folder.addFolder('霜华');
    R(ground, c, 'trailFrostRate', 0.05, 10, 0.05, '尾迹霜华/米');
    R(ground, c, 'trailFrostRadius', 0.05, 6, 0.05, '尾迹霜华半径');
    R(ground, c, 'frostSpread', 0.2, 4, 0.05, '落点霜华（×范围）');
    R(ground, c, 'frostLife', 0.5, 20, 0.1, '霜华持续');
    R(ground, c, 'frostIntensity', 0, 2, 0.01, '霜华强度');
    R(ground, c, 'frostCrystals', 0, 4, 0.01, '雪粒颗粒感');
    R(ground, c, 'frostCollar', 0, 8, 0.05, '冰刃基座（×冰刃半径）');
    R(ground, c, 'rimeRate', 0, 20, 0.1, '边缘霜华/秒');
    R(ground, c, 'rimeRadius', 0.05, 6, 0.05, '边缘霜华半径');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, '冲击波半径');
    R(ground, c, 'ringRate', 0, 12, 0.1, '压力环数/秒');
    ground.addColor(c, 'colorFrost').name('积雪');
    ground.addColor(c, 'colorFrostEdge').name('积雪阴影');
    ground.addColor(c, 'colorShockA').name('冲击波环');
    ground.addColor(c, 'colorShockB').name('冲击波峰');

    const air = folder.addFolder('雾气、闪光与落雪');
    R(air, c, 'mistRate', 0, 900, 1, '雾气速率');
    R(air, c, 'mistSize', 0.05, 4, 0.01, '雾气大小');
    R(air, c, 'mistSpeed', 0, 8, 0.05, '雾气速度');
    R(air, c, 'mistLifetime', 0.2, 8, 0.05, '雾气持续');
    R(air, c, 'mistOpacity', 0, 1, 0.005, '雾气不透明度');
    R(air, c, 'mistRise', -3, 3, 0.01, '雾气升降（负 = 下沉）');
    R(air, c, 'mistTurbulence', 0, 3, 0.01, '雾气旋卷');
    R(air, c, 'glitterRate', 0, 900, 1, '闪光速率');
    R(air, c, 'glitterSize', 0.005, 0.4, 0.005, '闪光大小');
    R(air, c, 'glitterSpeed', 0, 20, 0.1, '闪光速度');
    R(air, c, 'glitterLifetime', 0.1, 8, 0.05, '闪光持续');
    R(air, c, 'glitterRise', -3, 8, 0.01, '闪光升力');
    R(air, c, 'glitterTurbulence', 0, 3, 0.01, '闪光旋卷');
    R(air, c, 'glitterGlow', 0, 4, 0.01, '闪光辉光');
    R(air, c, 'snowRate', 0, 600, 1, '落雪速率');
    R(air, c, 'snowSize', 0.005, 0.4, 0.005, '雪花大小');
    R(air, c, 'snowSpeed', 0, 10, 0.05, '初始推力');
    R(air, c, 'snowLifetime', 0.2, 10, 0.05, '雪花持续');
    R(air, c, 'snowFall', -12, 2, 0.05, '落雪重力');
    R(air, c, 'snowTurbulence', 0, 3, 0.01, '雪花飘移');
    R(air, c, 'snowGlow', 0, 4, 0.01, '雪花辉光');
    R(air, c, 'snowInset', 0.05, 1.4, 0.01, '落雪内缩（×范围）');
    R(air, c, 'snowHeight', 0.2, 4, 0.05, '落雪高度（×墙高）');
    Editor.gradient(air, c, 'colorMist', '雾气颜色');
    Editor.gradient(air, c, 'colorGlitter', '闪光颜色');
    Editor.gradient(air, c, 'colorSnow', '落雪颜色');

    const chips = folder.addFolder('冰屑');
    R(chips, c, 'shardSize', 0.005, 0.5, 0.005, '冰屑大小');
    R(chips, c, 'shardSpeed', 0, 30, 0.1, '冰屑速度');
    R(chips, c, 'shardLifetime', 0.1, 6, 0.05, '冰屑持续');
    R(chips, c, 'shardGravity', -50, 0, 0.1, '冰屑重力');
    R(chips, c, 'breachShards', 0, 30, 1, '破空冰屑数');
    R(chips, c, 'shatterShards', 0, 30, 1, '碎裂冰屑数');
    Editor.gradient(chips, c, 'colorShard', '冰屑颜色');

    const impact = folder.addFolder('绽放与维持');
    R(impact, c, 'burstSize', 0.2, 14, 0.05, '雾气外壳尺寸');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, '雾气外壳强度');
    R(impact, c, 'burstShards', 0, 600, 1, '绽放冰屑数');
    R(impact, c, 'burstMist', 0, 400, 1, '绽放雾气量');
    R(impact, c, 'burstGlitter', 0, 600, 1, '绽放闪光量');
    R(impact, c, 'vapourRate', 0, 12, 0.05, '维持外壳/秒');
    R(impact, c, 'vapourSize', 0.1, 10, 0.05, '维持外壳尺寸');
    R(impact, c, 'vapourIntensity', 0, 5, 0.01, '维持外壳强度');
    R(impact, c, 'impactShake', 0, 3, 0.01, '震动');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, '震动时长');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, '维持震颤');
    R(impact, c, 'impactFlash', 0, 2, 0.01, '全屏闪光');
    R(impact, c, 'rumble', 0, 0.5, 0.005, '行进震颤');
    impact.addColor(c, 'colorBurstA').name('外壳');
    impact.addColor(c, 'colorBurstB').name('外壳主体');
    impact.addColor(c, 'colorBurstC').name('外壳晶板');
    impact.addColor(c, 'colorFlash').name('绽放闪光颜色');

    const light = folder.addFolder('动态光源');
    R(light, c, 'lightIntensity', 0, 120, 0.5, '光照强度');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, '光照半径');
    R(light, c, 'lightHeight', 0, 1, 0.01, '沿王冠高度');
    light.addColor(c, 'lightColor').name('光照颜色');

    this.glacierFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * 钞票风暴 — 第三个远距施放。
   *
   * `zoneRadius` 依然是那个牵动全局的旋钮：圆形指示器和旋风的覆盖范围都读它，
   * 拖动它会把瞄准圈和钞票风暴一起缩放。之后最值得先调的是 **气旋** 组
   * （`swirlSpeed` 决定转速、`riseHeight` 决定高度）和 **钞票** 组
   * （`noteSize`、`flutter`、`spinSpeed`），它们共同决定这场钱雨的形态。
   */
  _buildBanknote() {
    const folder = this.gui.addFolder('¥  钞票风暴');
    const c = settings.banknote;
    const R = Editor.range;

    const cast = folder.addFolder('施放');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, '范围半径');
    R(cast, c, 'range', 2, 50, 0.1, '最大距离');
    R(cast, c, 'minRange', 0, 10, 0.1, '最小距离');
    R(cast, c, 'speed', 5, 200, 1, '出手速度');
    R(cast, c, 'lifetime', 0.5, 15, 0.1, '风暴持续时间');
    R(cast, c, 'fadeTime', 0.5, 8, 0.1, '飘落消散时间');
    R(cast, c, 'cooldown', 0, 8, 0.05, '冷却时间');
    Editor.castAnimation(cast, c);

    const vortex = folder.addFolder('气旋');
    R(vortex, c, 'count', 1, 320, 1, '钞票数量');
    R(vortex, c, 'riseTime', 0.05, 3, 0.01, '升空时间');
    R(vortex, c, 'riseSpread', 0, 3, 0.01, '错峰延迟');
    R(vortex, c, 'swirlSpeed', -3, 3, 0.01, '盘旋速度（圈/秒）');
    R(vortex, c, 'riseHeight', 0.5, 14, 0.1, '旋风顶部高度');
    R(vortex, c, 'swirlSway', 0, 3, 0.01, '上下摆动');
    R(vortex, c, 'swaySpeed', 0, 8, 0.01, '摆动速度');
    R(vortex, c, 'expand', 0, 2, 0.01, '向外扩张');
    R(vortex, c, 'fallSpread', 0, 3, 0.01, '飘落散开');

    const notes = folder.addFolder('钞票');
    R(notes, c, 'noteSize', 0.1, 2, 0.01, '钞票尺寸');
    R(notes, c, 'flutter', 0, 3, 0.01, '翻飞幅度');
    R(notes, c, 'flutterFreq', 0.1, 8, 0.01, '翻飞频率');
    R(notes, c, 'spinSpeed', 0, 12, 0.05, '翻转速度');
    R(notes, c, 'glow', 0.2, 4, 0.01, '亮度增益');

    const light = folder.addFolder('动态光源');
    R(light, c, 'lightIntensity', 0, 40, 0.1, '光照强度');
    R(light, c, 'lightRadius', 0.5, 30, 0.1, '光照半径');
    light.addColor(c, 'lightColor').name('光照颜色');

    this.banknoteFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildMinions() {
    const folder = this.gui.addFolder('👺  小兵');
    const c = settings.minions;
    const R = Editor.range;

    // The same switch the M key and the HUD chip flip — `listen` keeps the
    // checkbox honest when it is toggled from either of those.
    folder.add(c, 'enabled').name('启用小兵 (M)').listen();

    const swarm = folder.addFolder('波次');
    R(swarm, c, 'maxAlive', 1, 48, 1, '同屏上限');
    R(swarm, c, 'waveSize', 1, 10, 1, '每波数量');
    R(swarm, c, 'spawnInterval', 0.5, 8, 0.1, '波次间隔（秒）');
    R(swarm, c, 'spawnRadius', 8, 30, 0.5, '刷新半径（米）');
    R(swarm, c, 'spawnJitter', 0, 6, 0.1, '半径抖动（米）');
    R(swarm, c, 'riseTime', 0.1, 2, 0.05, '钻出地面（秒）');

    const move = folder.addFolder('行动');
    R(move, c, 'moveSpeed', 0.5, 6, 0.1, '移动速度（米/秒）');
    R(move, c, 'speedJitter', 0, 1, 0.01, '个体速度差');
    R(move, c, 'attackRange', 0.6, 4, 0.05, '围拢距离（米）');
    R(move, c, 'separateRadius', 0.4, 2.5, 0.05, '彼此间距（米）');
    R(move, c, 'separateStrength', 0.5, 8, 0.1, '挤开力度');
    R(move, c, 'turnRate', 1, 20, 0.5, '转向速率');
    R(move, c, 'bobHeight', 0, 0.2, 0.005, '颠簸幅度（米）');
    R(move, c, 'bobSpeed', 1, 14, 0.1, '颠簸频率');
    R(move, c, 'waddle', 0, 0.4, 0.01, '左右摇摆');

    const combat = folder.addFolder('生存与伤害');
    R(combat, c, 'health', 10, 600, 5, '生命值');
    R(combat, c, 'damageTaken', 0.1, 4, 0.05, '受伤倍率');
    R(combat, c, 'falloff', 0, 1, 0.05, '偏轴衰减');
    R(combat, c, 'critChance', 0, 1, 0.01, '暴击几率');
    R(combat, c, 'critMultiplier', 1, 4, 0.05, '暴击倍率');
    R(combat, c, 'knockback', 0, 2, 0.05, '受击击退（米）');
    R(combat, c, 'staggerTime', 0, 1, 0.05, '受击踉跄（秒）');

    const death = folder.addFolder('死亡');
    R(death, c, 'fallTime', 0.1, 1.5, 0.05, '倒下时长（秒）');
    R(death, c, 'deadPause', 0, 1.5, 0.05, '倒地停留（秒）');
    R(death, c, 'sinkTime', 0.2, 2, 0.05, '沉没时长（秒）');
    R(death, c, 'deathBurst', 0, 40, 1, '消散粒子数');

    const look = folder.addFolder('外观');
    R(look, c, 'scale', 0.5, 2, 0.01, '体型');
    look.addColor(c, 'colorBody').name('身体');
    look.addColor(c, 'colorEye').name('眼睛');
    R(look, c, 'eyeGlow', 0, 6, 0.1, '眼睛亮度');
    look.addColor(c, 'flashColor').name('受击闪光');

    const bar = folder.addFolder('血条');
    R(bar, c, 'barWidth', 0.3, 2, 0.01, '宽度（米）');
    R(bar, c, 'barHeight', 0.03, 0.3, 0.005, '高度（米）');
    R(bar, c, 'barLift', 0.8, 3, 0.05, '悬空高度（米）');
    R(bar, c, 'barShowTime', 0.5, 6, 0.1, '受击后显示（秒）');
    R(bar, c, 'barFadeDistance', 10, 80, 1, '淡出距离（米）');
    bar.addColor(c, 'colorBarFill').name('血量');
    bar.addColor(c, 'colorBarBack').name('底条');
    bar.addColor(c, 'colorBarEdge').name('描边');
    bar.addColor(c, 'colorBarGhost').name('受伤拖尾');
  }

  _buildEnvironment() {
    const folder = this.gui.addFolder('环境');
    const e = settings.environment;
    const R = Editor.range;

    R(folder, e, 'sunIntensity', 0, 8, 0.01, '主光强度');
    folder.addColor(e, 'sunColor').name('主光颜色');
    R(folder, e, 'sunAzimuth', 0, Math.PI * 2, 0.01, '主光方位');
    R(folder, e, 'sunElevation', 0.05, 1.5, 0.01, '主光仰角');
    R(folder, e, 'ambientIntensity', 0, 3, 0.01, '环境光强度');
    folder.addColor(e, 'ambientColor').name('环境光颜色');
    R(folder, e, 'hemiIntensity', 0, 3, 0.01, '半球光');
    R(folder, e, 'envIntensity', 0, 3, 0.01, '环境反射 (IBL)');
    R(folder, e, 'shadowRadius', 0, 8, 0.05, '阴影柔化');
    R(folder, e, 'shadowBias', -0.01, 0.001, 0.0001, '阴影偏移');
    R(folder, e, 'contactShadow', 0, 1.5, 0.01, '接触阴影');

    const rim = folder.addFolder('轮廓光');
    R(rim, e, 'rimIntensity', 0, 4, 0.01, '轮廓光强度');
    rim.addColor(e, 'rimColor').name('轮廓光颜色');
    R(rim, e, 'rimAzimuth', 0, Math.PI * 2, 0.01, '轮廓光方位');
    R(rim, e, 'rimElevation', 0.05, 1.5, 0.01, '轮廓光仰角');
    rim.addColor(e, 'hemiSkyColor').name('半球天光色');
    rim.addColor(e, 'hemiGroundColor').name('半球地面反弹');

    const fog = folder.addFolder('背景、雾与浮尘');
    fog.addColor(e, 'backgroundColor').name('背景色');
    fog.add(e, 'fogEnabled').name('启用雾效');
    fog.addColor(e, 'fogColor').name('雾颜色');
    // near = where the fog starts, far = where it is total; widening the gap or
    // pushing both out thins the fog, closing it thickens it.
    R(fog, e, 'fogNear', 1, 200, 1, '雾起始距离');
    R(fog, e, 'fogFar', 10, 400, 1, '雾完全距离');
    R(fog, e, 'dustAmount', 0, 3, 0.01, '浮尘量');

    const floor = folder.addFolder('舞台地面');
    floor.add(e, 'floorTexture').name('石砖纹理');
    R(floor, e, 'floorTextureScale', 0.5, 24, 0.1, '砖块尺寸（米）');
    R(floor, e, 'floorNormalScale', 0, 3, 0.01, '浮雕强度');
    R(floor, e, 'floorTexTint', 0, 1, 0.01, '向地面染色');
    floor.addColor(e, 'floorColor').name('地面颜色');
    floor.addColor(e, 'floorTint').name('地面染色');
    R(floor, e, 'floorRoughness', 0.05, 1, 0.01, '粗糙度');
    R(floor, e, 'floorSheen', 0, 1, 0.01, '光泽');
    R(floor, e, 'floorPool', 0, 1, 0.01, '光池');
  }

  _buildPost() {
    const folder = this.gui.addFolder('后期处理');
    const p = settings.post;
    const R = Editor.range;

    folder.add(p, 'enabled').name('启用');
    R(folder, p, 'exposure', 0.1, 3, 0.01, '曝光');
    R(folder, p, 'bloomStrength', 0, 3, 0.01, '泛光强度');
    R(folder, p, 'bloomRadius', 0, 1.5, 0.01, '泛光半径');
    R(folder, p, 'bloomThreshold', 0, 2, 0.01, '泛光阈值');
    R(folder, p, 'contrast', 0.5, 2, 0.01, '对比度');
    R(folder, p, 'saturation', 0, 2.5, 0.01, '饱和度');
    R(folder, p, 'temperature', -0.5, 0.5, 0.01, '色温');
    R(folder, p, 'lift', -0.2, 0.2, 0.005, '黑位提升');
    R(folder, p, 'gain', 0.5, 2, 0.01, '增益');
    R(folder, p, 'vignette', 0, 1.5, 0.01, '暗角');
    R(folder, p, 'chromaticAberration', 0, 3, 0.01, '色差');
    R(folder, p, 'grain', 0, 0.2, 0.001, '胶片颗粒');
    R(folder, p, 'distortion', 0, 0.2, 0.001, '屏幕扭曲');
    R(folder, p, 'flashStrength', 0, 2, 0.01, '撞击闪光强度');
  }

  _buildCamera() {
    const folder = this.gui.addFolder('镜头');
    const c = settings.camera;
    const R = Editor.range;

    // The wheel writes `distance` straight into settings, so the slider listens.
    R(folder, c, 'distance', 1, 40, 0.1, '距离').listen();
    R(folder, c, 'minDistance', 1, 20, 0.1, '最小距离');
    R(folder, c, 'maxDistance', 4, 40, 0.1, '最大距离');
    R(folder, c, 'zoomSpeed', 0.1, 3, 0.01, '缩放速度');
    R(folder, c, 'fov', 20, 90, 0.5, '视场角');
    R(folder, c, 'targetHeight', 0, 4, 0.01, '目标高度');
    R(folder, c, 'minPolar', 0.05, 1.5, 0.01, '最小俯仰');
    R(folder, c, 'maxPolar', 0.2, 1.55, 0.01, '最大俯仰');
    R(folder, c, 'damping', 0.001, 0.5, 0.001, '跟随阻尼');
    R(folder, c, 'autoFrame', 0, 1, 0.01, '自动取景');

    folder.add({ clear: () => this.hooks.onClear?.() }, 'clear').name('清除特效 (C)');
  }

  _buildCharacter() {
    const folder = this.gui.addFolder('角色');
    const c = settings.character;
    const R = Editor.range;

    // The mixer's own rate, so it scales the idle and the cast clips together.
    // The same value as Global → animation speed, mirrored here where it is
    // actually reached for; `listen` keeps the two readouts honest.
    R(folder, settings.global, 'animationSpeed', 0.1, 3, 0.01, '播放速率').listen();

    // Which clip each ability throws lives in that ability's own folder, under
    // "The cast"; these are the edges of the blend that lays it over the idle.
    const cast = folder.addFolder('施放动作');
    R(cast, c, 'castBlendIn', 0.01, 1, 0.01, '混入施放动作');
    R(cast, c, 'castBlendOut', 0.01, 1.5, 0.01, '回归待机');
    cast.add(c, 'turnToAim').name('转身瞄准');
    R(cast, c, 'turnRate', 0.000001, 0.02, 0.000001, '转身跟随');

    // The procedural accent that rides on top of the clip. Zero both leans to
    // let the animation carry the cast on its own.
    const lunge = folder.addFolder('前冲');
    R(lunge, c, 'castLean', 0, 1.2, 0.01, '前冲俯身');
    R(lunge, c, 'castRecoil', 0, 0.8, 0.005, '前冲后坐');
    R(lunge, c, 'castSettle', 0.2, 8, 0.05, '前冲回稳');
  }

  dispose() {
    this.gui.destroy();
  }
}
