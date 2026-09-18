/**
 * workshop/js/midautumn-skin.js
 * 小松绿个人工作台专属节日皮肤 · 中秋·月满桂香 (Living World Edition)
 * 设计灵感：ThreeUI Sakura Sunset (Sylva)
 * 核心特性：
 * 1. 苍劲古桂覆穹与清辉满月多层景深微视差 (Multi-plane Mouse Parallax)
 * 2. 古桂枝桠防穿模安全限幅引擎（彻底根治鼠标移到最左边时树根切边露底穿模 Bug）
 * 3. 水乡月夜山水原画沉浸层、划空浪漫流星与星云流光天幕 (消除背景死黑空洞)
 * 4. 伪 3D 翻滚、流体风力扰动与点击繁花迸发金桂雨粒子引擎 (3D Tumbling & Interactive Blossom Physics)
 * 5. 时空光影中枢联动与全卡片琉璃夜景定制
 * 6. 视口隐藏 0% GPU 损耗挂起与 prefers-reduced-motion 无障碍平滑降级
 */

(function () {
  'use strict';

  if (window.XSLWorkshopMidAutumnInitialized) return;
  window.XSLWorkshopMidAutumnInitialized = true;

  const STORAGE_KEY = 'xsl_midautumn_skin_pref';
  const ASSET_BASE = 'assets/midautumn';

  // ===== 1. 农历节气智能判定 (八月初一至二十) =====
  function isMidAutumnPeriod(now = new Date()) {
    try {
      const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' });
      const parts = fmt.formatToParts(now);
      const mp = parts.find(p => p.type === 'month');
      const dp = parts.find(p => p.type === 'day');
      if (mp && dp) {
        const lm = parseInt(mp.value, 10);
        const ld = parseInt(dp.value, 10);
        if (!isNaN(lm) && !isNaN(ld) && lm === 8 && ld >= 1 && ld <= 20) {
          return true;
        }
      }
    } catch (e) {}

    // 公历对应中秋区间兜底 (2024-2030)
    try {
      const y = now.getFullYear();
      const intervals = {
        2024: [[9, 10], [9, 23]],
        2025: [[9, 28], [10, 12]],
        2026: [[9, 15], [9, 30]],
        2027: [[9, 8], [9, 22]],
        2028: [[9, 25], [10, 8]],
        2029: [[9, 15], [9, 28]],
        2030: [[9, 5], [9, 18]]
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

  function getPreference() {
    try {
      const pref = localStorage.getItem(STORAGE_KEY);
      if (pref === 'on' || pref === 'off') return pref;
    } catch (e) {}
    return 'auto';
  }

  function isEnabled() {
    const pref = getPreference();
    if (pref === 'on') return true;
    if (pref === 'off') return false;
    return isMidAutumnPeriod();
  }

  // ===== 2. Sakura Sunset 风格多层景深微视差引擎 (Multi-plane Parallax) =====
  class ParallaxEngine {
    constructor(backdropEl) {
      this.el = backdropEl;
      this.targetX = 0;
      this.targetY = 0;
      this.currentX = 0;
      this.currentY = 0;
      this.rafId = null;
      this.startTime = performance.now();
      this.boundOnMouseMove = this.onMouseMove.bind(this);
      this.animate = this.animate.bind(this);
    }

    start() {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return; // 减弱动效降级
      }
      window.addEventListener('mousemove', this.boundOnMouseMove, { passive: true });
      if (!this.rafId) {
        this.rafId = requestAnimationFrame(this.animate);
      }
    }

    stop() {
      window.removeEventListener('mousemove', this.boundOnMouseMove);
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }

    onMouseMove(e) {
      const w = window.innerWidth || 1920;
      const h = window.innerHeight || 1080;
      // 归一化为 [-1, 1]
      this.targetX = ((e.clientX / w) - 0.5) * 2;
      this.targetY = ((e.clientY / h) - 0.5) * 2;
    }

    animate(now) {
      // 平滑缓动插值 (LERP)
      this.currentX += (this.targetX - this.currentX) * 0.05;
      this.currentY += (this.targetY - this.currentY) * 0.05;

      // 静止时的微妙正弦微呼吸
      const elapsed = (now - this.startTime) * 0.001;
      const idleX = Math.sin(elapsed * 0.6) * 3.0;
      const idleY = Math.cos(elapsed * 0.8) * 2.0;

      // 各图层不同深度位移
      const moonX = this.currentX * 12 + idleX * 0.4;
      const moonY = this.currentY * 8 + idleY * 0.4;
      const cloudsX = this.currentX * 22;
      const scenicX = this.currentX * -10 + idleX * 0.25;
      const scenicY = this.currentY * -6 + idleY * 0.25;

      /* ========================================================================
         【关键修复：左上角桂花树鼠标移到最左边时穿模露底问题】
         原因剖析：
         原代码中 canopyX = this.currentX * -36 + idleX。当鼠标移到最左端时（currentX -> -1），
         canopyX 计算为正数（+36px ~ +40px），即向右平移！
         原 CSS left 仅为 -10px，向右位移 +38px 后，图片左侧硬切边被推到屏幕内 +28px 处，
         悬空露底穿模！
         防护加固策略：
         1. CSS 容器已设置 left: -85px，预留高达 85px 的出血容错区
         2. 此处对 canopyX 严格限幅在 [-45px, 28px] 区间内
         3. 无论鼠标如何极速甩动，left + canopyX 最大仅为 -57px，树根截面永远严密隐藏在屏幕外侧！
         ======================================================================== */
      const rawCanopyX = this.currentX * -24 + idleX * 0.8;
      const canopyX = Math.max(-45, Math.min(28, rawCanopyX));
      const rawCanopyY = this.currentY * -12 + idleY * 0.8;
      const canopyY = Math.max(-25, Math.min(16, rawCanopyY));
      const canopyRot = Math.max(-0.6, Math.min(0.6, this.currentX * -0.5));

      if (this.el) {
        this.el.style.setProperty('--moon-px', `${moonX.toFixed(2)}px`);
        this.el.style.setProperty('--moon-py', `${moonY.toFixed(2)}px`);
        this.el.style.setProperty('--clouds-px', `${cloudsX.toFixed(2)}px`);
        this.el.style.setProperty('--scenic-px', `${scenicX.toFixed(2)}px`);
        this.el.style.setProperty('--scenic-py', `${scenicY.toFixed(2)}px`);
        this.el.style.setProperty('--canopy-px', `${canopyX.toFixed(2)}px`);
        this.el.style.setProperty('--canopy-py', `${canopyY.toFixed(2)}px`);
        this.el.style.setProperty('--canopy-rot', `${canopyRot.toFixed(2)}deg`);
      }

      this.rafId = requestAnimationFrame(this.animate);
    }
  }

  // ===== 3. 伪 3D 翻滚、流体气流扰动与点击绽放金桂雨粒子引擎 =====
  class OsmanthusPetalEngine {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.petals = [];
      this.sparkles = [];
      this.images = [];
      this.animId = null;
      this.isRunning = false;
      this.mouse = { x: -9999, y: -9999, vx: 0, vy: 0, lastX: -9999, lastY: -9999, lastTime: performance.now() };
      this.cleanupFns = [];
    }

    start() {
      if (this.isRunning) return;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return; // 无障碍降级
      }

      this.initCanvas();
      this.loadPetalImages();
      this.createPetals();
      this.createSparkles();
      this.bindEvents();

      this.isRunning = true;
      this.animate = this.animate.bind(this);
      this.animId = requestAnimationFrame(this.animate);
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
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    loadPetalImages() {
      const files = ['petal_1.webp', 'petal_2.webp', 'petal_3.webp', 'petal_4.webp'];
      this.images = files.map(f => {
        const img = new Image();
        img.src = `${ASSET_BASE}/${f}`;
        return img;
      });
    }

    createPetals() {
      const isMobile = window.innerWidth <= 768;
      const count = isMobile ? 28 : 52;
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.petals = [];

      for (let i = 0; i < count; i++) {
        const z = 0.35 + Math.random() * 0.75; // 景深因子 [0.35, 1.1]
        this.petals.push({
          x: Math.random() * w,
          y: Math.random() * h,
          z: z,
          imgIdx: i % 4,
          baseSize: 12 + Math.random() * 14,
          vx: (0.35 + Math.random() * 0.65) * z,
          vy: (0.75 + Math.random() * 1.15) * z,
          rotZ: Math.random() * Math.PI * 2,
          vRotZ: (Math.random() - 0.5) * 0.035,
          rotX: Math.random() * Math.PI * 2,
          vRotX: 0.015 + Math.random() * 0.03,
          rotY: Math.random() * Math.PI * 2,
          vRotY: 0.012 + Math.random() * 0.025,
          swayPhase: Math.random() * Math.PI * 2,
          swaySpeed: 0.012 + Math.random() * 0.018,
          opacity: (0.6 + Math.random() * 0.38) * (0.65 + z * 0.35),
          pushX: 0,
          pushY: 0
        });
      }
    }

    createSparkles() {
      const count = window.innerWidth <= 768 ? 20 : 36;
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.sparkles = [];

      for (let i = 0; i < count; i++) {
        this.sparkles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          radius: 1.0 + Math.random() * 1.8,
          alpha: 0.2 + Math.random() * 0.7,
          pulseSpeed: 0.015 + Math.random() * 0.025,
          vy: 0.3 + Math.random() * 0.5,
          vx: (Math.random() - 0.4) * 0.3,
          color: Math.random() > 0.3 ? '#ffd666' : '#fff'
        });
      }
    }

    // 交互特效：点击迸发金色花瓣与微光尘埃
    spawnClickBurst(clientX, clientY) {
      if (!this.isRunning) return;
      if (this.petals.length > 120 || this.sparkles.length > 150) return;
      const count = 14;
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 / count) * i + (Math.random() - 0.5) * 0.4;
        const speed = 2.5 + Math.random() * 5.0;
        const z = 0.6 + Math.random() * 0.5;

        this.petals.push({
          x: clientX,
          y: clientY,
          z: z,
          imgIdx: Math.floor(Math.random() * 4),
          baseSize: 13 + Math.random() * 13,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          rotZ: Math.random() * Math.PI * 2,
          vRotZ: (Math.random() - 0.5) * 0.08,
          rotX: Math.random() * Math.PI * 2,
          vRotX: 0.03 + Math.random() * 0.04,
          rotY: Math.random() * Math.PI * 2,
          vRotY: 0.03 + Math.random() * 0.04,
          swayPhase: Math.random() * Math.PI * 2,
          swaySpeed: 0.02,
          opacity: 0.95,
          pushX: 0,
          pushY: 0,
          isBurst: true
        });
      }

      for (let j = 0; j < 20; j++) {
        const a = Math.random() * Math.PI * 2;
        const s = 1.5 + Math.random() * 4.5;
        this.sparkles.push({
          x: clientX,
          y: clientY,
          radius: 1.5 + Math.random() * 2.0,
          alpha: 1.0,
          pulseSpeed: 0.03,
          vy: Math.sin(a) * s,
          vx: Math.cos(a) * s,
          color: '#ffd666',
          isBurst: true
        });
      }
    }

    bindEvents() {
      const onResize = () => this.resize();
      window.addEventListener('resize', onResize, { passive: true });
      this.cleanupFns.push(() => window.removeEventListener('resize', onResize));

      const onMouseMove = (e) => {
        const now = performance.now();
        const dt = Math.max((now - this.mouse.lastTime) / 1000, 0.016);
        if (this.mouse.lastX > -9000) {
          this.mouse.vx = (e.clientX - this.mouse.lastX) / dt * 0.03;
          this.mouse.vy = (e.clientY - this.mouse.lastY) / dt * 0.03;
        }
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        this.mouse.lastX = e.clientX;
        this.mouse.lastY = e.clientY;
        this.mouse.lastTime = now;
      };
      window.addEventListener('mousemove', onMouseMove, { passive: true });
      this.cleanupFns.push(() => window.removeEventListener('mousemove', onMouseMove));

      const onClick = (e) => {
        // 点击任意位置触发桂花微光绽放涟漪
        this.spawnClickBurst(e.clientX, e.clientY);
      };
      window.addEventListener('pointerdown', onClick, { passive: true });
      this.cleanupFns.push(() => window.removeEventListener('pointerdown', onClick));
    }

    animate() {
      if (!this.isRunning || !this.ctx || !this.canvas) return;

      const w = window.innerWidth;
      const h = window.innerHeight;
      this.ctx.clearRect(0, 0, w, h);

      // 衰减鼠标流体速度
      this.mouse.vx *= 0.88;
      this.mouse.vy *= 0.88;

      const mx = this.mouse.x;
      const my = this.mouse.y;

      // 1. 绘制星尘微光
      for (let sIdx = this.sparkles.length - 1; sIdx >= 0; sIdx--) {
        const s = this.sparkles[sIdx];
        s.alpha += Math.sin(performance.now() * 0.003 + sIdx) * s.pulseSpeed;
        s.y += s.vy;
        s.x += s.vx;

        if (s.isBurst) {
          s.vx *= 0.94;
          s.vy *= 0.94;
          s.vy += 0.08; // 微重力
          s.alpha -= 0.015;
          if (s.alpha <= 0) {
            this.sparkles.splice(sIdx, 1);
            continue;
          }
        } else {
          if (s.y > h + 10) {
            s.y = -10;
            s.x = Math.random() * w;
          }
        }

        const clampedAlpha = Math.max(0, Math.min(1, s.alpha));
        this.ctx.save();
        this.ctx.fillStyle = s.color;
        this.ctx.globalAlpha = clampedAlpha;
        this.ctx.beginPath();
        this.ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.restore();
      }

      // 2. 绘制 3D 翻转花瓣
      for (let i = this.petals.length - 1; i >= 0; i--) {
        const p = this.petals[i];

        // 3D 姿态更新
        p.rotZ += p.vRotZ;
        p.rotX += p.vRotX;
        p.rotY += p.vRotY;
        p.swayPhase += p.swaySpeed;

        if (p.isBurst) {
          p.vx *= 0.95;
          p.vy *= 0.95;
          p.vy += 0.06;
          p.opacity -= 0.008;
          p.x += p.vx;
          p.y += p.vy;

          if (p.opacity <= 0.05) {
            this.petals.splice(i, 1);
            continue;
          }
        } else {
          // 鼠标微风扰动 (Cursor Wind & Repulsion)
          if (mx > -9000) {
            const dx = p.x - mx;
            const dy = p.y - my;
            const dist = Math.hypot(dx, dy);
            if (dist < 140 && dist > 1) {
              const force = (1 - dist / 140) * 4.5;
              p.pushX += (dx / dist) * force + this.mouse.vx * 0.25;
              p.pushY += (dy / dist) * force + this.mouse.vy * 0.25;
              p.vRotX += (Math.random() - 0.5) * 0.04;
              p.vRotY += (Math.random() - 0.5) * 0.04;
            }
          }

          // 阻尼回弹与重力飘移
          p.pushX *= 0.93;
          p.pushY *= 0.93;

          p.x += p.vx + Math.sin(p.swayPhase) * 0.75 + p.pushX;
          p.y += p.vy + p.pushY;

          // 越界平滑回环
          if (p.y > h + 35) {
            p.y = -30;
            p.x = Math.random() * w;
            p.pushX = 0;
            p.pushY = 0;
          }
          if (p.x > w + 35) {
            p.x = -35;
          } else if (p.x < -35) {
            p.x = w + 35;
          }
        }

        // 3D 透视缩放与翻转绘制 (Sakura Sunset 风格)
        const scaleX = Math.cos(p.rotY) * p.z;
        const scaleY = Math.sin(p.rotX) * p.z;
        const size = p.baseSize;

        this.ctx.save();
        this.ctx.translate(p.x, p.y);
        this.ctx.scale(scaleX, scaleY);
        this.ctx.rotate(p.rotZ);
        this.ctx.globalAlpha = Math.max(0, Math.min(1, p.opacity));

        const img = this.images[p.imgIdx];
        if (img && img.complete && img.naturalWidth > 0) {
          this.ctx.drawImage(img, -size / 2, -size / 2, size, size);
        } else {
          // 优雅金色花瓣切片兜底
          this.ctx.fillStyle = '#ffd666';
          this.ctx.beginPath();
          this.ctx.ellipse(0, 0, size * 0.45, size * 0.25, 0, 0, Math.PI * 2);
          this.ctx.fill();
        }
        this.ctx.restore();
      }

      this.animId = requestAnimationFrame(this.animate);
    }
  }

  // ===== 4. 场景 DOM 管理与引擎协调器 =====
  let backdropEl = null;
  let parallaxEngine = null;
  const petalEngine = new OsmanthusPetalEngine();

  function ensureBackdrop() {
    if (!backdropEl) {
      backdropEl = document.getElementById('midautumnBgBackdrop');
    }
    if (!backdropEl) {
      backdropEl = document.createElement('div');
      backdropEl.id = 'midautumnBgBackdrop';
      backdropEl.className = 'midautumn-bg-backdrop';
      backdropEl.setAttribute('aria-hidden', 'true');
      backdropEl.innerHTML = `
        <div class="midautumn-nightsky"></div>
        <div class="midautumn-sky-glow"></div>
        <div class="midautumn-starfield"></div>
        <div class="midautumn-meteors">
          <span class="meteor m1"></span>
          <span class="meteor m2"></span>
          <span class="meteor m3"></span>
        </div>
        <div class="midautumn-scenic-art" id="midautumnScenic"></div>
        <div class="midautumn-clouds" id="midautumnClouds"></div>
        <div class="midautumn-river-mist"></div>
        <div class="midautumn-water-waves"></div>
        <div class="midautumn-water-reflections"></div>
        <div class="midautumn-lanterns">
          <div class="midautumn-lantern lantern-1">
            <span class="lantern-flame"></span>
          </div>
          <div class="midautumn-lantern lantern-2">
            <span class="lantern-flame"></span>
          </div>
          <div class="midautumn-lantern lantern-3">
            <span class="lantern-flame"></span>
          </div>
        </div>
        <div class="midautumn-celestial-moon" id="midautumnMoon">
          <div class="moon-halo-outer"></div>
          <div class="moon-halo"></div>
          <div class="moon-corona"></div>
          <img class="moon-img" src="${ASSET_BASE}/moon_luminous.webp" alt="满月">
          <div class="moon-wisp"></div>
          <div class="moon-wisp wisp-2"></div>
        </div>
        <div class="midautumn-canopy-wrap" id="midautumnCanopy">
          <img class="canopy-img" src="${ASSET_BASE}/bough_canopy.webp" alt="古桂天幕枝桠">
        </div>
        <div class="midautumn-fireflies">
          <span class="firefly f1"></span>
          <span class="firefly f2"></span>
          <span class="firefly f3"></span>
          <span class="firefly f4"></span>
          <span class="firefly f5"></span>
          <span class="firefly f6"></span>
          <span class="firefly f7"></span>
          <span class="firefly f8"></span>
          <span class="firefly f9"></span>
          <span class="firefly f10"></span>
        </div>
      `;
      if (document.body && document.body.prepend) {
        document.body.prepend(backdropEl);
      } else if (document.body) {
        document.body.appendChild(backdropEl);
      }
    }

    if (!parallaxEngine && backdropEl) {
      parallaxEngine = new ParallaxEngine(backdropEl);
    }
  }

  function removeBackdrop() {
    if (parallaxEngine) {
      parallaxEngine.stop();
      parallaxEngine = null;
    }
    if (backdropEl && backdropEl.parentNode) {
      backdropEl.parentNode.removeChild(backdropEl);
    }
    backdropEl = null;
  }

  // ===== 5. 皮肤应用与全局状态切换 =====
  function applySkin(enable) {
    const root = document.documentElement;
    if (enable) {
      root.setAttribute('data-skin', 'midautumn');
      root.setAttribute('data-midautumn-skin', 'true');
      root.setAttribute('data-ambience-time', 'night');

      const metaCs = document.querySelector('meta[name="color-scheme"]');
      if (metaCs) metaCs.content = 'dark';

      ensureBackdrop();
      if (parallaxEngine) parallaxEngine.start();
      petalEngine.start();
    } else {
      root.removeAttribute('data-skin');
      root.removeAttribute('data-midautumn-skin');

      petalEngine.stop();
      removeBackdrop();

      // 恢复日间/正常天气色彩
      const metaCs = document.querySelector('meta[name="color-scheme"]');
      if (metaCs) metaCs.content = 'light';
    }

    // 广播中秋皮肤改变事件，供 weather-ambience 等协同模块联动
    window.dispatchEvent(new CustomEvent('xsl-midautumn-skin-changed', {
      detail: { enabled: enable }
    }));
  }

  function setEnabled(enable) {
    try {
      localStorage.setItem(STORAGE_KEY, enable ? 'on' : 'off');
    } catch (e) {}
    applySkin(enable);
  }

  function toggle() {
    setEnabled(!isEnabled());
  }

  // 页面离开/切换时休眠降低功耗
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (parallaxEngine) parallaxEngine.stop();
      if (petalEngine.isRunning) {
        cancelAnimationFrame(petalEngine.animId);
      }
    } else if (document.visibilityState === 'visible' && isEnabled()) {
      if (parallaxEngine) parallaxEngine.start();
      if (petalEngine.isRunning) {
        petalEngine.animId = requestAnimationFrame(petalEngine.animate);
      }
    }
  });

  // ===== 6. 挂载全局 API =====
  window.MidAutumnSkin = {
    isEnabled,
    setEnabled,
    toggle,
    isMidAutumnPeriod,
    getPreference
  };
  window.XSLFestivalSkin = window.MidAutumnSkin;

  // 初始化自启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applySkin(isEnabled()));
  } else {
    applySkin(isEnabled());
  }
})();
