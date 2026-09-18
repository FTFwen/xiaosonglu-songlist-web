/**
 * js/midautumn-skin.js
 * 小松绿节日皮肤系统 · 中秋·月满桂香 (Universal Festival Skin System)
 * 适配：主站歌单 (index.html)、按钮墙 (/buttons)、个人工作台 (/workshop)
 * 功能特性：
 * 1. 节气智能双轨控制：农历八月（十三至十八，中秋前后共六天）自动点亮满月中秋氛围，亦支持用户随时自由切换；
 * 2. 跨页面轻巧开关小按钮：顶栏/横幅常驻轻量胶囊按钮，弹出通透琉璃皮肤选择器，面向未来节日多皮肤平滑扩展；
 * 3. 沉浸光影与动效：全屏金桂雨飘落粒子系统、鼠标微风扰动、满月流光呼吸、玉兔桂枝装饰；
 * 4. 极致性能与无障碍：离开视口/切换标签页 GPU 零占用暂停、严格遵循 prefers-reduced-motion 降级；
 * 5. 全面兼容 window.MidAutumnSkin 与 window.XSLFestivalSkin。
 */

(function () {
  'use strict';

  if (window.XSLFestivalSkin) return;

  const STORAGE_KEY = 'xsl_festival_skin_pref';
  const LEGACY_STORAGE_KEY = 'xsl_midautumn_skin_pref';

  // 资源根路径智能解析
  function resolveAssetBase() {
    try {
      const script = document.querySelector('script[src*="midautumn-skin.js"]');
      if (script && script.src) {
        return new URL('../assets/midautumn', script.src).href;
      }
    } catch (e) {}
    const isSubDir = (
      window.location.pathname.includes('/buttons') ||
      window.location.pathname.includes('/workshop') ||
      window.location.pathname.includes('/24xsl')
    );
    return isSubDir ? '../assets/midautumn' : 'assets/midautumn';
  }
  const ASSET_BASE = resolveAssetBase();

  // ===== 1. 节日皮肤注册表 (面向未来节日皮肤扩展设计) =====
  const SKINS = {
    default: {
      id: 'default',
      name: '常态·绿意森林',
      icon: '🌿',
      badge: '经典',
      desc: '清新初秋橄榄绿，通透轻盈'
    },
    midautumn: {
      id: 'midautumn',
      name: '中秋·月满桂香',
      icon: '🥮',
      badge: '佳节限定',
      desc: '月满水乡 · 桂雨玉兔 · 沉浸夜色',
      isPeriod: () => isMidAutumnPeriod()
    }
    // 未来可便捷扩展：springfestival (新春), dragonboat (端午), qixi (七夕) 等
  };

  // ===== 2. 农历节气智能判定算法 =====
  function isMidAutumnPeriod(now = new Date()) {
    try {
      // 现代原生 Intl 农历转换引擎，使用 formatToParts 稳妥解析
      const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' });
      const parts = fmt.formatToParts(now);
      const mp = parts.find(p => p.type === 'month');
      const dp = parts.find(p => p.type === 'day');
      if (mp && dp) {
        const lunarMonth = parseInt(mp.value, 10);
        const lunarDay = parseInt(dp.value, 10);
        // 农历八月（十三至十八，中秋前后共六天：迎月、中秋正日、追月与观潮黄金期）
        if (!isNaN(lunarMonth) && !isNaN(lunarDay) && lunarMonth === 8 && lunarDay >= 13 && lunarDay <= 18) {
          return true;
        }
      }
    } catch (e) {}

    // 算法兜底：公历对应中秋节气前后共六天区间 (2024-2030)
    try {
      const y = now.getFullYear();
      const intervals = {
        2024: [[9, 15], [9, 20]],
        2025: [[10, 4], [10, 9]],
        2026: [[9, 23], [9, 28]],
        2027: [[9, 13], [9, 18]],
        2028: [[10, 1], [10, 6]],
        2029: [[9, 20], [9, 25]],
        2030: [[9, 10], [9, 15]]
      };
      if (intervals[y]) {
        const [[m1, d1], [m2, d2]] = intervals[y];
        const start = new Date(y, m1 - 1, d1, 0, 0, 0);
        const end = new Date(y, m2 - 1, d2, 23, 59, 59);
        if (now >= start && now <= end) return true;
      }
    } catch (e) {}

    return false;
  }

  // ===== 3. 用户偏好与激活态读取 =====
  function getPreference() {
    try {
      const pref = localStorage.getItem(STORAGE_KEY);
      if (pref) return pref;
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy === 'on') return 'midautumn';
      if (legacy === 'off') return 'default';
    } catch (e) {}
    return 'auto';
  }

  function getActiveSkinId() {
    const pref = getPreference();
    if (pref === 'midautumn') return 'midautumn';
    if (pref === 'default') return 'default';
    // auto 模式
    return isMidAutumnPeriod() ? 'midautumn' : 'default';
  }

  function isEnabled() {
    return getActiveSkinId() === 'midautumn';
  }

  // ===== 4. 全屏金桂雨粒子引擎 (Canvas 2D, 高性能轻量化) =====
  class OsmanthusPetalEngine {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.petals = [];
      this.animId = null;
      this.isRunning = false;
      this.images = [];
      this.mouse = { x: -9999, y: -9999, vx: 0, vy: 0, lastX: 0, lastY: 0 };
      this.cleanupFns = [];
    }

    start() {
      if (this.isRunning) return;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return; // 无障碍降级，避免眩晕
      }

      this.initCanvas();
      this.loadPetalImages();
      this.createPetals();
      this.bindEvents();

      this.isRunning = true;
      this.animate();
    }

    stop() {
      this.isRunning = false;
      if (this.animId) {
        cancelAnimationFrame(this.animId);
        this.animId = null;
      }
      this.cleanupFns.forEach(fn => { try { fn(); } catch (e) {} });
      this.cleanupFns = [];

      if (this.canvas && this.canvas.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas);
      }
      this.canvas = null;
      this.ctx = null;
      this.petals = [];
      this.sparkles = [];
    }

    initCanvas() {
      let canvas = document.getElementById('festivalSkinCanvas');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'festivalSkinCanvas';
        if (document.body && document.body.prepend) {
          document.body.prepend(canvas);
        } else if (document.body) {
          document.body.appendChild(canvas);
        }
      }
      if (!canvas || typeof canvas.getContext !== 'function') return;
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.resize();
    }

    resize() {
      if (!this.canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      if (this.ctx) {
        if (typeof this.ctx.setTransform === 'function') {
          this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        } else if (typeof this.ctx.scale === 'function') {
          this.ctx.scale(dpr, dpr);
        }
      }
    }

    loadPetalImages() {
      const petalFiles = ['petal_1.webp', 'petal_2.webp', 'petal_3.webp', 'petal_4.webp'];
      this.images = petalFiles.map(file => {
        const img = new Image();
        img.src = `${ASSET_BASE}/${file}`;
        return img;
      });
    }

    createPetals() {
      const isMobile = window.innerWidth <= 768;
      const count = isMobile ? 24 : 44;
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.petals = [];
      this.sparkles = [];

      for (let i = 0; i < count; i++) {
        this.petals.push({
          x: Math.random() * w,
          y: Math.random() * h,
          imgIdx: i % 4,
          size: 11 + Math.random() * 18,
          vx: 0.35 + Math.random() * 0.75,
          vy: 0.65 + Math.random() * 1.15,
          rot: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.035,
          swayPhase: Math.random() * Math.PI * 2,
          swaySpeed: 0.015 + Math.random() * 0.02,
          opacity: 0.55 + Math.random() * 0.4,
          pushX: 0,
          pushY: 0
        });
      }

      // 细密璀璨星尘微光粒子
      const sparkCount = isMobile ? 20 : 38;
      for (let j = 0; j < sparkCount; j++) {
        this.sparkles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          size: 1.5 + Math.random() * 2.5,
          phase: Math.random() * Math.PI * 2,
          speed: 0.02 + Math.random() * 0.03,
          vy: -0.2 - Math.random() * 0.45,
          vx: (Math.random() - 0.5) * 0.35
        });
      }
    }

    bindEvents() {
      const onResize = () => this.resize();
      window.addEventListener('resize', onResize, { passive: true });
      this.cleanupFns.push(() => window.removeEventListener('resize', onResize));

      const onMouseMove = (e) => {
        const mx = e.clientX;
        const my = e.clientY;
        const dx = mx - this.mouse.lastX;
        const dy = my - this.mouse.lastY;
        this.mouse.lastX = mx;
        this.mouse.lastY = my;
        this.mouse.x = mx;
        this.mouse.y = my;
        this.mouse.vx = dx;
        this.mouse.vy = dy;

        // 鼠标附近花瓣微风扰动
        for (let i = 0; i < this.petals.length; i++) {
          const p = this.petals[i];
          const dist = Math.hypot(p.x - mx, p.y - my);
          if (dist < 120) {
            const force = (1 - dist / 120) * 2.2;
            const angle = Math.atan2(p.y - my, p.x - mx);
            p.pushX += Math.cos(angle) * force;
            p.pushY += Math.sin(angle) * force - 0.5; // 赋予微微向上轻盈升力
          }
        }
      };
      window.addEventListener('mousemove', onMouseMove, { passive: true });
      this.cleanupFns.push(() => window.removeEventListener('mousemove', onMouseMove));

      // 标签页休眠监测 (离开标签页零 CPU 开销)
      const onVisChange = () => {
        if (document.hidden) {
          this.isRunning = false;
          if (this.animId) cancelAnimationFrame(this.animId);
        } else {
          if (!this.isRunning && isEnabled()) {
            this.isRunning = true;
            this.animate();
          }
        }
      };
      document.addEventListener('visibilitychange', onVisChange);
      this.cleanupFns.push(() => document.removeEventListener('visibilitychange', onVisChange));
    }

    animate() {
      if (!this.isRunning || !this.ctx) return;
      this.animId = requestAnimationFrame(() => this.animate());

      const w = window.innerWidth;
      const h = window.innerHeight;
      this.ctx.clearRect(0, 0, w, h);

      // 1. 绘制璀璨星尘微光粒子
      if (this.sparkles && this.sparkles.length > 0) {
        for (let j = 0; j < this.sparkles.length; j++) {
          const s = this.sparkles[j];
          s.phase += s.speed;
          s.y += s.vy;
          s.x += s.vx;
          if (s.y < -10) s.y = h + 10;
          if (s.x < -10) s.x = w + 10;
          if (s.x > w + 10) s.x = -10;

          const sparkAlpha = 0.25 + 0.5 * Math.sin(s.phase);
          if (sparkAlpha > 0.05) {
            this.ctx.save();
            this.ctx.fillStyle = '#ffd666';
            this.ctx.globalAlpha = Math.min(1, Math.max(0, sparkAlpha));
            this.ctx.shadowColor = '#ffeaa7';
            this.ctx.shadowBlur = 4;
            this.ctx.beginPath();
            this.ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();
          }
        }
      }

      // 2. 绘制金桂飘落花瓣
      for (let i = 0; i < this.petals.length; i++) {
        const p = this.petals[i];

        p.swayPhase += p.swaySpeed;
        p.pushX *= 0.93;
        p.pushY *= 0.93;

        const currentVx = p.vx + Math.sin(p.swayPhase) * 0.8 + p.pushX;
        const currentVy = p.vy + Math.cos(p.swayPhase * 0.7) * 0.3 + p.pushY;

        p.x += currentVx;
        p.y += currentVy;
        p.rot += p.rotSpeed;

        // 边界平滑回环
        if (p.y > h + 30) {
          p.y = -30;
          p.x = Math.random() * w;
          p.pushX = 0;
          p.pushY = 0;
        }
        if (p.x > w + 30) {
          p.x = -30;
        } else if (p.x < -30) {
          p.x = w + 30;
        }

        this.ctx.save();
        this.ctx.translate(p.x, p.y);
        this.ctx.rotate(p.rot);
        this.ctx.globalAlpha = p.opacity;

        const img = this.images[p.imgIdx];
        if (img && img.complete && img.naturalWidth > 0) {
          this.ctx.drawImage(img, -p.size / 2, -p.size / 2, p.size, p.size);
        } else {
          // 图像未就绪时的金黄桂花切片优雅兜底
          this.ctx.fillStyle = '#ffd666';
          this.ctx.beginPath();
          this.ctx.ellipse(0, 0, p.size * 0.45, p.size * 0.25, 0, 0, Math.PI * 2);
          this.ctx.fill();
        }
        this.ctx.restore();
      }
    }
  }

  const petalEngine = new OsmanthusPetalEngine();

  // ===== 4.5. 全站沉浸夜景背景管理 (天幕满月、水乡山水画卷、两侧桂影、星芒星尘、流光薄雾、暗夜流萤) =====
  function ensureBackdrop() {
    let backdrop = document.getElementById('midautumnBgBackdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'midautumnBgBackdrop';
      backdrop.className = 'midautumn-bg-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      backdrop.innerHTML = `
        <div class="midautumn-sky-glow"></div>
        <div class="midautumn-scenic-art"></div>
        <div class="midautumn-celestial-moon">
          <div class="moon-disk"></div>
          <div class="moon-halo"></div>
          <div class="moon-wisp"></div>
        </div>
        <div class="midautumn-side-branch-left"></div>
        <div class="midautumn-side-branch-right"></div>
        <div class="midautumn-starfield"></div>
        <div class="midautumn-clouds"></div>
        <div class="midautumn-water-waves"></div>
        <div class="midautumn-fireflies">
          <span class="firefly f1"></span>
          <span class="firefly f2"></span>
          <span class="firefly f3"></span>
          <span class="firefly f4"></span>
          <span class="firefly f5"></span>
          <span class="firefly f6"></span>
        </div>
      `;
      if (document.body && document.body.prepend) {
        document.body.prepend(backdrop);
      } else if (document.body) {
        document.body.appendChild(backdrop);
      }
    }
  }

  function removeBackdrop() {
    const backdrop = document.getElementById('midautumnBgBackdrop');
    if (backdrop && backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
  }

  // ===== 5. 顶栏/横幅玉兔金桂微饰件管理 =====
  function ensureHeaderOrnament() {
    const header = document.querySelector('.header') || document.querySelector('.banner');
    if (!header) return;

    let ornament = header.querySelector('.midautumn-header-ornament');
    if (!ornament) {
      ornament = document.createElement('div');
      ornament.className = 'midautumn-header-ornament';
      ornament.title = '中秋佳节 · 玉兔抱饼 · 桂子飘香';
      ornament.innerHTML = `
        <img src="${ASSET_BASE}/rabbit.webp" alt="玉兔" class="ornament-rabbit">
        <img src="${ASSET_BASE}/branch.webp" alt="金桂" class="ornament-branch">
      `;
      header.appendChild(ornament);
    }
  }

  function removeHeaderOrnament() {
    const ornaments = document.querySelectorAll('.midautumn-header-ornament');
    ornaments.forEach(el => el.parentNode?.removeChild(el));
  }

  // ===== 6. 节日皮肤开关小按钮与 Popover 选择面板 =====
  let popoverEl = null;

  function ensureSkinButtons() {
    // 1. 桌面端入口定位：主站 .header-actions 或 按钮墙 .banner-top
    const desktopActions = document.querySelector('.header-actions') || document.querySelector('.banner-top');
    let dBtn = document.getElementById('festivalSkinBtn');
    if (!dBtn && desktopActions) {
      dBtn = document.createElement('button');
      dBtn.id = 'festivalSkinBtn';
      dBtn.className = 'skin-switch-btn';
      dBtn.type = 'button';
      dBtn.title = '节日皮肤切换';
      dBtn.innerHTML = `
        <span class="skin-switch-icon" aria-hidden="true">🥮</span>
        <span class="skin-switch-label">中秋</span>
        <span class="skin-switch-badge">限定</span>
      `;
      desktopActions.appendChild(dBtn);
    }
    if (dBtn && !dBtn.dataset.bound) {
      dBtn.dataset.bound = '1';
      dBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSkinPopover(dBtn);
      });
    }

    // 2. 手机端入口定位：主站 .header-nav 或 按钮墙 .banner-nav
    const mobileNav = document.querySelector('.header-nav') || document.querySelector('.banner-nav');
    let mBtn = document.getElementById('mobileFestivalSkinBtn');
    if (!mBtn && mobileNav) {
      mBtn = document.createElement('button');
      mBtn.id = 'mobileFestivalSkinBtn';
      mBtn.className = 'skin-switch-btn mobile-skin-btn';
      mBtn.type = 'button';
      mBtn.title = '节日皮肤切换';
      mBtn.innerHTML = `
        <span class="skin-switch-icon" aria-hidden="true">🥮</span>
        <span class="skin-switch-label">中秋</span>
      `;
      mobileNav.appendChild(mBtn);
    }
    if (mBtn && !mBtn.dataset.bound) {
      mBtn.dataset.bound = '1';
      mBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSkinPopover(mBtn);
      });
    }

    updateSkinButtonsUI();
  }

  function updateSkinButtonsUI() {
    const activeSkin = getActiveSkinId();
    const pref = getPreference();
    const isMid = (activeSkin === 'midautumn');

    const btns = [
      document.getElementById('festivalSkinBtn'),
      document.getElementById('mobileFestivalSkinBtn')
    ].filter(Boolean);

    btns.forEach(btn => {
      const icon = btn.querySelector('.skin-switch-icon');
      const label = btn.querySelector('.skin-switch-label');
      const badge = btn.querySelector('.skin-switch-badge');

      if (isMid) {
        if (icon) icon.textContent = '🥮';
        if (label) label.textContent = '中秋';
        if (badge) badge.textContent = pref === 'auto' ? '节气' : '开启';
        btn.classList.add('active');
        btn.setAttribute('aria-label', '当前皮肤：中秋·月满桂香');
      } else {
        if (icon) icon.textContent = '🌿';
        if (label) label.textContent = '皮肤';
        if (badge) badge.textContent = '常态';
        btn.classList.remove('active');
        btn.setAttribute('aria-label', '当前皮肤：常态·绿意森林');
      }
    });

    // 联动 workshop weather-ambience 面板开关（如果存在）
    const wsToggle = document.getElementById('midautumnSkinToggle');
    const wsTag = document.getElementById('midautumnStatusTag');
    if (wsToggle) wsToggle.checked = isMid;
    if (wsTag) {
      wsTag.textContent = isMid ? '已开启' : (isMidAutumnPeriod() ? '佳节开启' : '已停用');
    }
  }

  function ensurePopoverMenu() {
    if (popoverEl) return popoverEl;

    popoverEl = document.createElement('div');
    popoverEl.className = 'skin-popover-menu';
    popoverEl.setAttribute('role', 'dialog');
    popoverEl.setAttribute('aria-label', '节日皮肤与主题选择');

    renderPopoverContent();
    document.body.appendChild(popoverEl);

    // 点击外部或按 ESC 自动收起
    document.addEventListener('click', (e) => {
      if (popoverEl && popoverEl.classList.contains('open')) {
        if (!popoverEl.contains(e.target) && !e.target.closest('.skin-switch-btn')) {
          closeSkinPopover();
        }
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popoverEl && popoverEl.classList.contains('open')) {
        closeSkinPopover();
      }
    });

    return popoverEl;
  }

  function renderPopoverContent() {
    if (!popoverEl) return;
    const pref = getPreference();
    const activeSkin = getActiveSkinId();
    const inPeriod = isMidAutumnPeriod();

    popoverEl.innerHTML = `
      <div class="skin-popover-header">
        <span class="skin-popover-title">✨ 节日皮肤与氛围</span>
        <button class="skin-popover-close" id="skinPopoverCloseBtn" title="关闭" aria-label="关闭">✕</button>
      </div>
      <div class="skin-option-list">
        <button class="skin-option-item ${pref === 'midautumn' ? 'active' : ''}" data-skin-target="midautumn">
          <span class="skin-option-icon">🥮</span>
          <div class="skin-option-info">
            <div class="skin-option-name">
              <span>中秋 · 月满桂香</span>
              <span class="skin-option-badge">佳节限定</span>
            </div>
            <div class="skin-option-desc">月满水乡 · 桂雨玉兔 · 沉浸夜色</div>
          </div>
        </button>

        <button class="skin-option-item ${pref === 'default' ? 'active' : ''}" data-skin-target="default">
          <span class="skin-option-icon">🌿</span>
          <div class="skin-option-info">
            <div class="skin-option-name">
              <span>常态 · 绿意森林</span>
            </div>
            <div class="skin-option-desc">经典小松绿，通透轻盈护眼</div>
          </div>
        </button>

        <button class="skin-option-item ${pref === 'auto' ? 'active' : ''}" data-skin-target="auto">
          <span class="skin-option-icon">⚙️</span>
          <div class="skin-option-info">
            <div class="skin-option-name">
              <span>随节气自然启用</span>
              <span class="skin-option-badge">${inPeriod ? '中秋期生效' : '日常保持常态'}</span>
            </div>
            <div class="skin-option-desc">中秋前后共六天自动满月中秋，平日经典森林</div>
          </div>
        </button>
      </div>
      <div class="skin-popover-footer">
        更多节日皮肤敬请期待（元宵、端午、新春…）
      </div>
    `;

    popoverEl.querySelector('#skinPopoverCloseBtn')?.addEventListener('click', closeSkinPopover);

    popoverEl.querySelectorAll('.skin-option-item').forEach(item => {
      item.addEventListener('click', () => {
        const target = item.getAttribute('data-skin-target');
        setPreference(target);
        renderPopoverContent();
        setTimeout(closeSkinPopover, 240);
      });
    });
  }

  function toggleSkinPopover(anchorBtn) {
    const pop = ensurePopoverMenu();
    if (pop.classList.contains('open')) {
      closeSkinPopover();
      return;
    }

    renderPopoverContent();

    const rect = anchorBtn.getBoundingClientRect();
    const isMobile = window.innerWidth <= 768;
    const popW = 290;

    if (isMobile) {
      const left = Math.max(10, (window.innerWidth - popW) / 2);
      pop.style.left = `${left}px`;
      pop.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 300)}px`;
    } else {
      let left = rect.right - popW;
      if (left < 10) left = 10;
      if (left + popW > window.innerWidth - 10) left = window.innerWidth - popW - 10;
      pop.style.left = `${left}px`;
      pop.style.top = `${rect.bottom + 8}px`;
    }
    // 移除内联 transform 干扰，让 CSS 类掌控进入与退出动画
    pop.style.transform = '';

    requestAnimationFrame(() => {
      pop.classList.add('open');
    });
  }

  function closeSkinPopover() {
    if (popoverEl) {
      popoverEl.classList.remove('open');
    }
  }

  // ===== 7. 皮肤应用与全局状态分发 =====
  function setPreference(pref) {
    if (pref === 'auto') {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, pref);
      localStorage.setItem(LEGACY_STORAGE_KEY, pref === 'midautumn' ? 'on' : 'off');
    }
    applySkin(getActiveSkinId());
  }

  function applySkin(skinId) {
    const enableMid = (skinId === 'midautumn');

    if (enableMid) {
      document.documentElement.setAttribute('data-skin', 'midautumn');
      document.documentElement.setAttribute('data-midautumn-skin', 'true');
      document.documentElement.setAttribute('data-ambience-time', 'night');

      const metaCs = document.querySelector('meta[name="color-scheme"]');
      if (metaCs) metaCs.content = 'dark';

      // 挂载全站沉浸夜景氛围层 (星空、薄雾、水波暗纹、暖金流光)
      ensureBackdrop();
      // 启动全屏桂雨与星尘微光粒子
      petalEngine.start();
      // 挂载顶栏装饰物
      ensureHeaderOrnament();
    } else {
      document.documentElement.removeAttribute('data-skin');
      document.documentElement.removeAttribute('data-midautumn-skin');

      const metaCs = document.querySelector('meta[name="color-scheme"]');
      if (metaCs) metaCs.content = 'light';

      // 移除全站沉浸夜景氛围层
      removeBackdrop();
      // 停止粒子
      petalEngine.stop();
      // 移除装饰物
      removeHeaderOrnament();
    }

    // 更新界面按钮状态
    updateSkinButtonsUI();

    // 分发全站自定义事件
    window.dispatchEvent(new CustomEvent('xsl-skin-changed', {
      detail: { skin: skinId, pref: getPreference() }
    }));
    window.dispatchEvent(new CustomEvent('xsl-midautumn-skin-changed', {
      detail: { enabled: enableMid }
    }));
  }

  function toggle() {
    const active = isEnabled();
    setPreference(active ? 'default' : 'midautumn');
  }

  function setEnabled(val) {
    setPreference(val ? 'midautumn' : 'default');
  }

  // ===== 8. 生命周期与初始化 =====
  function init() {
    // 1. 根据节气或用户偏好应用皮肤
    applySkin(getActiveSkinId());

    // 2. 挂载小按钮
    ensureSkinButtons();
  }

  // 暴露公共 API
  window.XSLFestivalSkin = {
    SKINS,
    init,
    isEnabled,
    isMidAutumnPeriod,
    getPreference,
    setPreference,
    getActiveSkinId,
    setEnabled,
    toggle,
    applySkin,
    startPetalParticles: () => petalEngine.start(),
    stopPetalParticles: () => petalEngine.stop(),
    loadThreeLibrary: () => Promise.resolve(window.THREE),
    applyMouseWindDisturbance: (x, y) => petalEngine.mouse && (petalEngine.mouse.x = x),
    destroy: () => petalEngine.stop()
  };

  // 兼容别名
  window.MidAutumnSkin = window.XSLFestivalSkin;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
