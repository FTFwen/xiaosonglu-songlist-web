/**
 * js/weather-ambience.js
 * 小松绿歌单首页 · 时空光影与粒子系统 (Weather & Time Ambience Engine)
 * 纯静态无冗余依赖，符合现代 Web 标准最佳实践
 */

(function () {
  'use strict';

  // 避免重复初始化
  if (window.WeatherAmbience) return;

  // ===== 1. 预设配置与常量 =====
  const TIME_PRESETS = {
    dawn: {
      id: 'dawn',
      name: '晨光熹微',
      icon: '🌅',
      desc: '朝霞与清露',
      quote: '晨光熹微，今天也是充满元气的一天！🌱'
    },
    noon: {
      id: 'noon',
      name: '明朗午后',
      icon: '☀️',
      desc: '暖阳与林荫',
      quote: '阳光正好，在林荫下听首歌放松一下吧~ 🍃'
    },
    sunset: {
      id: 'sunset',
      name: '落日融金',
      icon: '🌇',
      desc: '晚霞与余晖',
      quote: '夕阳融金，今天辛苦啦，让歌声拂去疲惫 🌇'
    },
    night: {
      id: 'night',
      name: '静谧星夜',
      icon: '🌙',
      desc: '月华与幽星',
      quote: '夜色静谧，晚风轻拂，让小松绿陪你入梦 🌙'
    }
  };

  const WEATHER_PRESETS = {
    clear: {
      id: 'clear',
      name: '晴朗',
      icon: '☀️',
      quote: '阳光明媚，向阳生长，心情也要美美的 🌻'
    },
    cloudy: {
      id: 'cloudy',
      name: '多云',
      icon: '☁️',
      quote: '云淡风轻，气候清凉，最适合安静听歌 ☁️'
    },
    rain: {
      id: 'rain',
      name: '细雨',
      icon: '🌧️',
      quote: '淅淅沥沥的小雨，带来泥土与青草的芬芳 🌧️'
    },
    mist: {
      id: 'mist',
      name: '薄雾',
      icon: '🌫️',
      quote: '林间薄雾朦胧，世界变得好温柔 🌫️'
    }
  };

  // 6 组精选情境氛围包
  const ATMOSPHERE_PACKS = [
    { id: 'dawn_clear', name: '晨光熹微', time: 'dawn', weather: 'clear', icon: '🌅', desc: '朝露晨曦 · 绿意苏醒' },
    { id: 'noon_clear', name: '午后晴阳', time: 'noon', weather: 'clear', icon: '☀️', desc: '暖阳洒落 · 晶莹透亮' },
    { id: 'sunset_clear', name: '落日融金', time: 'sunset', weather: 'clear', icon: '🌇', desc: '晚霞漫溢 · 岁月温柔' },
    { id: 'night_rain', name: '清凉雨夜', time: 'night', weather: 'rain', icon: '🌧️', desc: '细雨敲窗 · 墨蓝入眠' },
    { id: 'night_clear', name: '星空深邃', time: 'night', weather: 'clear', icon: '🌌', desc: '繁星萤火 · 深度沉浸' },
    { id: 'noon_cloudy', name: '云淡风轻', time: 'noon', weather: 'cloudy', icon: '☁️', desc: '微凉舒适 · 漫漫白云' }
  ];

  const STORAGE_KEY = 'xsl_ambience_pref_v1';

  // ===== 2. 状态模型 =====
  let state = {
    mode: 'auto', // 'auto' | 'manual'
    time: 'noon',
    weather: 'clear',
    remember: false,
    disabled: false,
    realCity: '本地',
    realTemp: 22,
    realWeatherDesc: '晴好',
    realWeatherIcon: '☀️'
  };

  // ===== 3. 轻量 Canvas 粒子光感引擎 (Luminous Particle Engine v2.0) =====
  class ParticleEngine {
    constructor(canvasEl) {
      this.canvas = canvasEl;
      this.ctx = canvasEl ? canvasEl.getContext('2d') : null;
      this.particles = [];
      this.bgStars = [];
      this.ripples = [];
      this.animId = null;
      this.isRunning = false;
      this.width = 0;
      this.height = 0;
      this.currentType = 'none';

      if (this.canvas) {
        this.resize();
        window.addEventListener('resize', () => this.resize(), { passive: true });
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) {
            this.stop();
          } else if (!state.disabled && !this.isReducedMotion()) {
            this.start();
          }
        });
      }
    }

    isReducedMotion() {
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    resize() {
      if (!this.canvas) return;
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }

    setType(weather, time) {
      if (state.disabled || this.isReducedMotion()) {
        this.stop();
        return;
      }

      let targetType = 'none';
      if (weather === 'rain') {
        targetType = 'rain';
      } else if (weather === 'mist') {
        targetType = 'mist';
      } else if (time === 'night') {
        targetType = 'fireflies';
      } else if (time === 'dawn') {
        targetType = 'dawn_sparkle';
      } else if (time === 'sunset') {
        targetType = 'sunset_ember';
      } else if (time === 'noon') {
        targetType = 'sun_dust';
      }

      if (this.currentType === targetType && this.isRunning) return;
      this.currentType = targetType;
      this.initParticles();
      this.start();
    }

    initParticles() {
      this.particles = [];
      this.bgStars = [];
      this.ripples = [];
      if (!this.ctx) return;

      if (this.currentType === 'rain') {
        const count = Math.min(42, Math.floor(this.width / 36));
        for (let i = 0; i < count; i++) {
          this.particles.push({
            x: Math.random() * this.width,
            y: Math.random() * this.height,
            length: 14 + Math.random() * 18,
            speedY: 7.5 + Math.random() * 6.5,
            speedX: -1.2 - Math.random() * 0.8,
            alpha: 0.18 + Math.random() * 0.35,
            width: 0.8 + Math.random() * 0.6
          });
        }
      } else if (this.currentType === 'fireflies') {
        // 夜空流萤 + 远景星芒
        const count = Math.min(24, Math.floor(this.width / 65));
        for (let i = 0; i < count; i++) {
          this.particles.push({
            x: Math.random() * this.width,
            y: Math.random() * this.height,
            radius: 1.6 + Math.random() * 2.2,
            speedX: (Math.random() - 0.5) * 0.35,
            speedY: (Math.random() - 0.5) * 0.35,
            alpha: 0.2 + Math.random() * 0.65,
            pulseSpeed: 0.012 + Math.random() * 0.018,
            pulseDir: Math.random() > 0.5 ? 1 : -1,
            phase: Math.random() * Math.PI * 2
          });
        }
        // 背景微星
        const starCount = Math.min(18, Math.floor(this.width / 80));
        for (let i = 0; i < starCount; i++) {
          this.bgStars.push({
            x: Math.random() * this.width,
            y: Math.random() * (this.height * 0.6),
            radius: 0.6 + Math.random() * 0.9,
            alpha: 0.15 + Math.random() * 0.5,
            twinkleSpeed: 0.01 + Math.random() * 0.015,
            twinklePhase: Math.random() * Math.PI * 2
          });
        }
      } else if (this.currentType === 'sun_dust') {
        // 午后暖阳微尘，自带柔光晕与布朗微漂浮
        const count = Math.min(26, Math.floor(this.width / 55));
        for (let i = 0; i < count; i++) {
          this.particles.push({
            x: Math.random() * this.width,
            y: Math.random() * this.height,
            radius: 1.2 + Math.random() * 2.4,
            speedX: (Math.random() - 0.35) * 0.3,
            speedY: -0.18 - Math.random() * 0.32,
            alpha: 0.2 + Math.random() * 0.45,
            wobbleSpeed: 0.015 + Math.random() * 0.02,
            wobbleAmp: 0.4 + Math.random() * 0.6,
            angle: Math.random() * Math.PI * 2
          });
        }
      } else if (this.currentType === 'dawn_sparkle') {
        // 晨光朝露微芒，带浅金朝霞折射
        const count = Math.min(22, Math.floor(this.width / 65));
        for (let i = 0; i < count; i++) {
          this.particles.push({
            x: Math.random() * this.width,
            y: Math.random() * this.height,
            radius: 1.2 + Math.random() * 2.2,
            speedX: 0.1 + Math.random() * 0.25,
            speedY: -0.12 - Math.random() * 0.2,
            alpha: 0.2 + Math.random() * 0.5,
            pulseSpeed: 0.014 + Math.random() * 0.02,
            pulseDir: 1,
            sparkle: Math.random() > 0.65
          });
        }
      } else if (this.currentType === 'sunset_ember') {
        // 落日熔金余晖飞羽与金红暖火
        const count = Math.min(25, Math.floor(this.width / 58));
        for (let i = 0; i < count; i++) {
          this.particles.push({
            x: Math.random() * this.width,
            y: Math.random() * this.height,
            radius: 1.4 + Math.random() * 2.5,
            speedX: (Math.random() - 0.4) * 0.35,
            speedY: -0.25 - Math.random() * 0.45,
            alpha: 0.25 + Math.random() * 0.5,
            angle: Math.random() * Math.PI * 2
          });
        }
      } else if (this.currentType === 'mist') {
        const count = 10;
        for (let i = 0; i < count; i++) {
          this.particles.push({
            x: Math.random() * this.width,
            y: Math.random() * this.height,
            radius: 65 + Math.random() * 95,
            speedX: (Math.random() - 0.5) * 0.2,
            speedY: (Math.random() - 0.5) * 0.1,
            alpha: 0.04 + Math.random() * 0.06
          });
        }
      }
    }

    start() {
      if (this.isRunning) return;
      if (this.currentType === 'none' || state.disabled || this.isReducedMotion()) return;
      this.isRunning = true;
      const loop = () => {
        if (!this.isRunning) return;
        this.render();
        this.animId = requestAnimationFrame(loop);
      };
      this.animId = requestAnimationFrame(loop);
    }

    stop() {
      this.isRunning = false;
      if (this.animId) {
        cancelAnimationFrame(this.animId);
        this.animId = null;
      }
      if (this.ctx) {
        this.ctx.clearRect(0, 0, this.width, this.height);
      }
    }

    render() {
      if (!this.ctx) return;
      this.ctx.clearRect(0, 0, this.width, this.height);

      if (this.currentType === 'rain') {
        // 雨丝渲染与触地水涟漪
        this.ctx.strokeStyle = 'rgba(195, 225, 255, 0.48)';
        for (const p of this.particles) {
          this.ctx.lineWidth = p.width;
          this.ctx.beginPath();
          this.ctx.moveTo(p.x, p.y);
          this.ctx.lineTo(p.x + p.speedX * 1.5, p.y + p.length);
          this.ctx.stroke();

          p.x += p.speedX;
          p.y += p.speedY;

          if (p.y > this.height - 30 && Math.random() > 0.85 && this.ripples.length < 8) {
            this.ripples.push({
              x: p.x,
              y: this.height - 15 + Math.random() * 10,
              r: 1,
              maxR: 9 + Math.random() * 8,
              alpha: 0.35
            });
          }

          if (p.y > this.height) {
            p.y = -p.length;
            p.x = Math.random() * (this.width + 100);
          }
        }

        // 水波涟漪扩散渲染
        if (this.ripples.length > 0) {
          this.ctx.lineWidth = 0.9;
          for (let i = this.ripples.length - 1; i >= 0; i--) {
            const rip = this.ripples[i];
            this.ctx.strokeStyle = `rgba(180, 215, 255, ${rip.alpha})`;
            this.ctx.beginPath();
            this.ctx.ellipse(rip.x, rip.y, rip.r * 2.2, rip.r * 0.7, 0, 0, Math.PI * 2);
            this.ctx.stroke();

            rip.r += 0.45;
            rip.alpha *= 0.92;
            if (rip.r >= rip.maxR || rip.alpha < 0.03) {
              this.ripples.splice(i, 1);
            }
          }
        }
      } else if (this.currentType === 'fireflies') {
        // 远景夜空微星
        for (const s of this.bgStars) {
          s.twinklePhase += s.twinkleSpeed;
          const a = s.alpha * (0.55 + 0.45 * Math.sin(s.twinklePhase));
          this.ctx.fillStyle = `rgba(220, 235, 255, ${a})`;
          this.ctx.beginPath();
          this.ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
          this.ctx.fill();
        }

        // 夏夜流萤 · 晶莹发光正弦呼吸
        for (const p of this.particles) {
          p.phase += p.pulseSpeed;
          p.alpha = 0.2 + 0.65 * ((Math.sin(p.phase) + 1) / 2);

          const glowRadius = p.radius * 3.8;
          const grad = this.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius);
          grad.addColorStop(0, `rgba(205, 255, 155, ${p.alpha})`);
          grad.addColorStop(0.35, `rgba(145, 230, 95, ${p.alpha * 0.55})`);
          grad.addColorStop(0.7, `rgba(90, 185, 75, ${p.alpha * 0.2})`);
          grad.addColorStop(1, 'rgba(80, 170, 70, 0)');

          this.ctx.fillStyle = grad;
          this.ctx.beginPath();
          this.ctx.arc(p.x, p.y, glowRadius, 0, Math.PI * 2);
          this.ctx.fill();

          // 微光核
          this.ctx.fillStyle = `rgba(255, 255, 230, ${Math.min(1, p.alpha * 1.2)})`;
          this.ctx.beginPath();
          this.ctx.arc(p.x, p.y, p.radius * 0.5, 0, Math.PI * 2);
          this.ctx.fill();

          p.x += p.speedX;
          p.y += p.speedY;

          if (p.x < 0) p.x = this.width;
          if (p.x > this.width) p.x = 0;
          if (p.y < 0) p.y = this.height;
          if (p.y > this.height) p.y = 0;
        }
      } else if (this.currentType === 'sun_dust') {
        // 午后暖阳浮尘 · 自带暖白高光晕
        for (const p of this.particles) {
          p.angle += p.wobbleSpeed;
          const driftX = Math.sin(p.angle) * p.wobbleAmp;

          const glowRadius = p.radius * 2.8;
          const grad = this.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius);
          grad.addColorStop(0, `rgba(255, 250, 220, ${p.alpha})`);
          grad.addColorStop(0.4, `rgba(255, 235, 175, ${p.alpha * 0.45})`);
          grad.addColorStop(1, 'rgba(255, 220, 140, 0)');

          this.ctx.fillStyle = grad;
          this.ctx.beginPath();
          this.ctx.arc(p.x, p.y, glowRadius, 0, Math.PI * 2);
          this.ctx.fill();

          p.x += p.speedX + driftX;
          p.y += p.speedY;

          if (p.y < 0) {
            p.y = this.height;
            p.x = Math.random() * this.width;
          }
        }
      } else if (this.currentType === 'dawn_sparkle') {
        // 晨曦朝露微芒
        for (const p of this.particles) {
          p.alpha += p.pulseSpeed * p.pulseDir;
          if (p.alpha > 0.75) {
            p.alpha = 0.75;
            p.pulseDir = -1;
          } else if (p.alpha < 0.18) {
            p.alpha = 0.18;
            p.pulseDir = 1;
          }

          const glowRadius = p.radius * 3;
          const grad = this.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius);
          grad.addColorStop(0, `rgba(255, 245, 225, ${p.alpha})`);
          grad.addColorStop(0.4, `rgba(255, 215, 180, ${p.alpha * 0.5})`);
          grad.addColorStop(1, 'rgba(255, 195, 160, 0)');

          this.ctx.fillStyle = grad;
          this.ctx.beginPath();
          this.ctx.arc(p.x, p.y, glowRadius, 0, Math.PI * 2);
          this.ctx.fill();

          if (p.sparkle && p.alpha > 0.5) {
            // 四芒晨星闪烁
            this.ctx.strokeStyle = `rgba(255, 255, 255, ${(p.alpha - 0.4) * 1.5})`;
            this.ctx.lineWidth = 0.8;
            const arm = p.radius * 2.2;
            this.ctx.beginPath();
            this.ctx.moveTo(p.x - arm, p.y);
            this.ctx.lineTo(p.x + arm, p.y);
            this.ctx.moveTo(p.x, p.y - arm);
            this.ctx.lineTo(p.x, p.y + arm);
            this.ctx.stroke();
          }

          p.x += p.speedX;
          p.y += p.speedY;

          if (p.y < 0) p.y = this.height;
          if (p.x > this.width) p.x = 0;
        }
      } else if (this.currentType === 'sunset_ember') {
        // 落日熔金余火
        for (const p of this.particles) {
          p.angle += 0.02;
          const sway = Math.sin(p.angle) * 0.35;

          const glowRadius = p.radius * 3.2;
          const grad = this.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius);
          grad.addColorStop(0, `rgba(255, 230, 160, ${p.alpha})`);
          grad.addColorStop(0.4, `rgba(255, 140, 70, ${p.alpha * 0.5})`);
          grad.addColorStop(1, 'rgba(230, 70, 30, 0)');

          this.ctx.fillStyle = grad;
          this.ctx.beginPath();
          this.ctx.arc(p.x, p.y, glowRadius, 0, Math.PI * 2);
          this.ctx.fill();

          p.x += p.speedX + sway;
          p.y += p.speedY;

          if (p.y < 0) {
            p.y = this.height;
            p.x = Math.random() * this.width;
          }
        }
      } else if (this.currentType === 'mist') {
        for (const p of this.particles) {
          const grad = this.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
          grad.addColorStop(0, `rgba(240, 245, 250, ${p.alpha})`);
          grad.addColorStop(1, 'rgba(240, 245, 250, 0)');

          this.ctx.fillStyle = grad;
          this.ctx.beginPath();
          this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          this.ctx.fill();

          p.x += p.speedX;
          p.y += p.speedY;
          if (p.x < -p.radius) p.x = this.width + p.radius;
          if (p.x > this.width + p.radius) p.x = -p.radius;
        }
      }
    }
  }

  // ===== 4. 现实天气与时间感知算法 =====
  function detectRealTimeSlot() {
    const now = new Date();
    const decimalHours = now.getHours() + now.getMinutes() / 60;

    if (decimalHours >= 6.0 && decimalHours < 10.0) {
      return 'dawn';
    } else if (decimalHours >= 10.0 && decimalHours < 16.5) {
      return 'noon';
    } else if (decimalHours >= 16.5 && decimalHours < 19.5) {
      return 'sunset';
    } else {
      return 'night';
    }
  }

  function detectRealWeatherCondition() {
    try {
      const raw = localStorage.getItem('start_weather_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.data) {
          state.realCity = parsed.data.cityName || '当前位置';
          state.realTemp = parsed.data.tempC || 20;
          state.realWeatherDesc = parsed.data.descText || '晴好';
          state.realWeatherIcon = parsed.data.icon || '☀️';

          const desc = (parsed.data.descText || '').toLowerCase();
          if (desc.includes('雨') || desc.includes('rain') || desc.includes('storm')) {
            return 'rain';
          }
          if (desc.includes('雾') || desc.includes('fog') || desc.includes('mist') || desc.includes('霾')) {
            return 'mist';
          }
          if (desc.includes('云') || desc.includes('阴') || desc.includes('cloud') || desc.includes('overcast')) {
            return 'cloudy';
          }
          return 'clear';
        }
      }
    } catch (e) {
      console.warn('[Ambience] 读取天气缓存失败:', e);
    }
    return 'clear';
  }

  // ===== 5. UI 应用与渲染管道 =====
  let particleEngine = null;

  function applyAmbience(time, weather, isDisabled = false, isUserTriggered = false) {
    const root = document.documentElement;

    if (isDisabled) {
      root.setAttribute('data-ambience-disabled', 'true');
      root.removeAttribute('data-ambience-time');
      root.removeAttribute('data-ambience-weather');
      if (particleEngine) particleEngine.stop();
      updateTopbarUI();
      updatePanelUI();
      return;
    }

    root.removeAttribute('data-ambience-disabled');
    root.setAttribute('data-ambience-time', time);
    root.setAttribute('data-ambience-weather', weather);

    // 动态同步全站桌面卡片基色（夜间深邃墨蓝，白昼晶莹晨露白，保证所有卡片色调100%完全一致）
    if (typeof window.applyStartSettings === 'function') {
      window.applyStartSettings();
    } else {
      const isNight = time === 'night';
      const rawOpacity = root.style.getPropertyValue('--card-opacity') || '0.45';
      const op = parseFloat(rawOpacity) || 0.45;
      root.style.setProperty('--card-bg', isNight ? `rgba(16, 24, 36, ${Math.max(0.78, op)})` : `rgba(255, 255, 255, ${op})`);
    }

    if (particleEngine) {
      particleEngine.setType(weather, time);
    }

    updateTopbarUI();
    updatePanelUI();

    // 触发角色桌宠陪伴联动
    broadcastToCompanion(time, weather, isUserTriggered);
  }

  function updateTopbarUI() {
    const iconEl = document.getElementById('ambienceTopbarIcon');
    const textEl = document.getElementById('ambienceTopbarText');
    const dotEl = document.getElementById('ambienceStatusDot');

    if (!iconEl || !textEl) return;

    if (state.disabled) {
      iconEl.textContent = '🌿';
      textEl.textContent = '纯净';
      if (dotEl) dotEl.className = 'ambience-status-dot disabled';
      return;
    }

    const tMeta = TIME_PRESETS[state.time] || TIME_PRESETS.noon;
    const wMeta = WEATHER_PRESETS[state.weather] || WEATHER_PRESETS.clear;

    iconEl.textContent = state.time === 'night' ? tMeta.icon : wMeta.icon;
    textEl.textContent = `${tMeta.name}`;

    if (dotEl) {
      dotEl.className = `ambience-status-dot ${state.mode === 'manual' ? 'manual' : ''}`;
    }
  }

  function updatePanelUI() {
    // 同步卡片
    const syncCityEl = document.getElementById('ambienceSyncCity');
    const syncDetailsEl = document.getElementById('ambienceSyncDetails');
    const syncBtn = document.getElementById('ambienceSyncBtn');
    const rememberCheckbox = document.getElementById('ambienceRememberPref');
    const disabledToggle = document.getElementById('ambienceDisabledToggle');

    if (syncCityEl) {
      syncCityEl.textContent = `${state.realCity} · ${state.realTemp}°C`;
    }
    if (syncDetailsEl) {
      const isAuto = state.mode === 'auto' && !state.disabled;
      syncDetailsEl.textContent = isAuto
        ? `现实同步中 · ${state.realWeatherDesc}`
        : (state.disabled ? '光影系统已停用' : '当前处于手动自定义模式');
    }
    if (syncBtn) {
      if (state.mode === 'auto' && !state.disabled) {
        syncBtn.textContent = '✓ 正在同步现实';
        syncBtn.classList.add('synced');
      } else {
        syncBtn.textContent = '📍 恢复现实同步';
        syncBtn.classList.remove('synced');
      }
    }

    if (rememberCheckbox) {
      rememberCheckbox.checked = !!state.remember;
    }
    if (disabledToggle) {
      disabledToggle.checked = !state.disabled;
    }

    // 氛围包激活态
    document.querySelectorAll('.ambience-preset-card').forEach(card => {
      const pTime = card.getAttribute('data-time');
      const pWeather = card.getAttribute('data-weather');
      const isActive = !state.disabled && state.time === pTime && state.weather === pWeather;
      card.classList.toggle('active', isActive);
    });

    // 矩阵按钮激活态
    document.querySelectorAll('.ambience-matrix-btn[data-type="time"]').forEach(btn => {
      const val = btn.getAttribute('data-val');
      btn.classList.toggle('active', !state.disabled && state.time === val);
    });
    document.querySelectorAll('.ambience-matrix-btn[data-type="weather"]').forEach(btn => {
      const val = btn.getAttribute('data-val');
      btn.classList.toggle('active', !state.disabled && state.weather === val);
    });
  }

  // ===== 6. 小松绿桌宠陪伴联动 (Scrapbook Companion Interaction) =====
  let lastQuoteTimer = null;
  function broadcastToCompanion(time, weather, isUserTriggered) {
    const tMeta = TIME_PRESETS[time] || TIME_PRESETS.noon;
    const wMeta = WEATHER_PRESETS[weather] || WEATHER_PRESETS.clear;

    // 自定义专属台词
    let quote = tMeta.quote;
    if (weather === 'rain') {
      quote = wMeta.quote;
    }

    if (isUserTriggered) {
      const foundPack = ATMOSPHERE_PACKS.find(p => p.time === time && p.weather === weather);
      if (foundPack) {
        quote = `哇，现在切换到【${foundPack.name}】的世界啦！✨`;
      }
    }

    // 尝试寻找桌宠伴侣气泡
    const bubbleText = document.getElementById('companionBubbleText');
    const bubble = document.getElementById('companionBubble');
    if (bubbleText && bubble) {
      if (lastQuoteTimer) clearTimeout(lastQuoteTimer);
      // 若是用户主动点击或首次进入，轻盈弹气泡展示
      if (isUserTriggered) {
        bubbleText.textContent = quote;
        bubble.classList.add('show');
        lastQuoteTimer = setTimeout(() => {
          bubble.classList.remove('show');
        }, 5000);
      }
    }

    // 广播原生事件，供其他模块订阅
    window.dispatchEvent(new CustomEvent('xsl-ambience-changed', {
      detail: { time, weather, mode: state.mode, disabled: state.disabled, quote }
    }));
  }

  // ===== 7. 控制面板构建与事件管理 =====
  function buildPopoverDOM() {
    if (document.getElementById('ambiencePopover')) return;

    // 1. 全屏环境遮罩
    if (!document.getElementById('ambienceOverlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'ambience-overlay';
      overlay.id = 'ambienceOverlay';
      document.body.prepend(overlay);
    }

    // 2. 粒子 Canvas
    let canvas = document.getElementById('ambienceCanvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'ambience-canvas';
      canvas.id = 'ambienceCanvas';
      document.body.prepend(canvas);
    }
    particleEngine = new ParticleEngine(canvas);

    // 3. 顶栏按钮注入 (若顶栏 actions 存在)
    const topbarActions = document.querySelector('.topbar-actions');
    if (topbarActions && !document.getElementById('ambienceBtn')) {
      const btn = document.createElement('button');
      btn.className = 'btn-action btn-ambience';
      btn.id = 'ambienceBtn';
      btn.type = 'button';
      btn.title = '时空光影系统 (点击自定义天气与时空氛围)';
      btn.innerHTML = `
        <span class="ambience-badge-icon" id="ambienceTopbarIcon">☀️</span>
        <span id="ambienceTopbarText">光影</span>
        <span class="ambience-status-dot" id="ambienceStatusDot"></span>
      `;
      topbarActions.insertBefore(btn, topbarActions.firstChild);
    }

    // 4. Popover 蒙层与弹窗 DOM
    const overlay = document.createElement('div');
    overlay.className = 'ambience-popover-overlay';
    overlay.id = 'ambiencePopoverOverlay';

    const popover = document.createElement('div');
    popover.className = 'ambience-popover';
    popover.id = 'ambiencePopover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', '时空光影控制中枢');

    // 构造预设包 HTML
    const presetsHtml = ATMOSPHERE_PACKS.map(pack => `
      <button type="button" class="ambience-preset-card" data-time="${pack.time}" data-weather="${pack.weather}">
        <div class="ambience-preset-icon">${pack.icon}</div>
        <div class="ambience-preset-text">
          <span class="ambience-preset-name">${pack.name}</span>
          <span class="ambience-preset-desc">${pack.desc}</span>
        </div>
      </button>
    `).join('');

    popover.innerHTML = `
      <div class="ambience-panel-header">
        <div class="ambience-panel-title-wrap">
          <span class="ambience-panel-title">🌿 时空光影中枢</span>
          <span class="ambience-panel-badge">首页专享</span>
        </div>
        <button type="button" class="ambience-panel-close" id="ambiencePanelClose" title="关闭面板">✕</button>
      </div>

      <!-- 现实天气同步卡片 -->
      <div class="ambience-sync-card">
        <div class="ambience-sync-info">
          <div class="ambience-sync-city-wrap">
            <span>📍</span>
            <span id="ambienceSyncCity">正在获取现实天气…</span>
          </div>
          <div class="ambience-sync-details" id="ambienceSyncDetails">读取中…</div>
        </div>
        <button type="button" class="ambience-sync-action-btn" id="ambienceSyncBtn">📍 恢复现实同步</button>
      </div>

      <!-- 6组精选情境氛围包 -->
      <div class="ambience-section-label">
        <span>✨ 精选情境氛围包</span>
        <span style="font-size: 11px; font-weight: normal;">一键沉浸</span>
      </div>
      <div class="ambience-presets-grid">
        ${presetsHtml}
      </div>

      <!-- 独立时空矩阵选择 -->
      <div class="ambience-section-label">
        <span>🧭 独立时空细调</span>
      </div>
      <div class="ambience-matrix-row">
        <div class="ambience-matrix-btns">
          <button type="button" class="ambience-matrix-btn" data-type="time" data-val="dawn"><span class="emoji">🌅</span>晨曦</button>
          <button type="button" class="ambience-matrix-btn" data-type="time" data-val="noon"><span class="emoji">☀️</span>午后</button>
          <button type="button" class="ambience-matrix-btn" data-type="time" data-val="sunset"><span class="emoji">🌇</span>暮色</button>
          <button type="button" class="ambience-matrix-btn" data-type="time" data-val="night"><span class="emoji">🌙</span>静夜</button>
        </div>
      </div>
      <div class="ambience-matrix-row">
        <div class="ambience-matrix-btns">
          <button type="button" class="ambience-matrix-btn" data-type="weather" data-val="clear"><span class="emoji">☀️</span>晴朗</button>
          <button type="button" class="ambience-matrix-btn" data-type="weather" data-val="cloudy"><span class="emoji">☁️</span>多云</button>
          <button type="button" class="ambience-matrix-btn" data-type="weather" data-val="rain"><span class="emoji">🌧️</span>细雨</button>
          <button type="button" class="ambience-matrix-btn" data-type="weather" data-val="mist"><span class="emoji">🌫️</span>薄雾</button>
        </div>
      </div>

      <!-- 偏好记忆与节能模式 -->
      <div class="ambience-options-wrap">
        <div class="ambience-switch-item">
          <div class="ambience-switch-label">
            <span>✨ 启用时空光影与粒子</span>
            <span class="ambience-switch-sub">关闭即为纯净节能模式</span>
          </div>
          <label class="ambience-toggle">
            <input type="checkbox" id="ambienceDisabledToggle" checked>
            <span class="ambience-toggle-slider"></span>
          </label>
        </div>
        <div class="ambience-switch-item">
          <div class="ambience-switch-label">
            <span>💾 记住我的偏好选择</span>
            <span class="ambience-switch-sub">下次打开保持自定义氛围</span>
          </div>
          <label class="ambience-toggle">
            <input type="checkbox" id="ambienceRememberPref">
            <span class="ambience-toggle-slider"></span>
          </label>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(popover);

    bindEvents();
  }

  function bindEvents() {
    const btn = document.getElementById('ambienceBtn');
    const overlay = document.getElementById('ambiencePopoverOverlay');
    const popover = document.getElementById('ambiencePopover');
    const closeBtn = document.getElementById('ambiencePanelClose');
    const syncBtn = document.getElementById('ambienceSyncBtn');
    const rememberCheckbox = document.getElementById('ambienceRememberPref');
    const disabledToggle = document.getElementById('ambienceDisabledToggle');

    function openPanel() {
      popover.classList.add('show');
      overlay.classList.add('show');
      if (btn) btn.classList.add('active');
      updatePanelUI();
    }

    function closePanel() {
      popover.classList.remove('show');
      overlay.classList.remove('show');
      if (btn) btn.classList.remove('active');
    }

    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popover.classList.contains('show')) {
          closePanel();
        } else {
          openPanel();
        }
      });
    }

    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    if (overlay) overlay.addEventListener('click', closePanel);

    // ESC 键关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popover.classList.contains('show')) {
        closePanel();
      }
    });

    // 预设包点击
    document.querySelectorAll('.ambience-preset-card').forEach(card => {
      card.addEventListener('click', () => {
        if (state.disabled) return;
        const t = card.getAttribute('data-time');
        const w = card.getAttribute('data-weather');
        setManualAmbience(t, w);
      });
    });

    // 矩阵按钮点击
    document.querySelectorAll('.ambience-matrix-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.disabled) return;
        const type = btn.getAttribute('data-type');
        const val = btn.getAttribute('data-val');
        if (type === 'time') {
          setManualAmbience(val, state.weather);
        } else if (type === 'weather') {
          setManualAmbience(state.time, val);
        }
      });
    });

    // 恢复现实同步
    if (syncBtn) {
      syncBtn.addEventListener('click', () => {
        resetToAuto();
      });
    }

    // 偏好记忆复选框
    if (rememberCheckbox) {
      rememberCheckbox.addEventListener('change', (e) => {
        state.remember = e.target.checked;
        saveState();
      });
    }

    // 节能纯净开关
    if (disabledToggle) {
      disabledToggle.addEventListener('change', (e) => {
        state.disabled = !e.target.checked;
        saveState();
        applyAmbience(state.time, state.weather, state.disabled, true);
      });
    }
  }

  function setManualAmbience(time, weather) {
    state.mode = 'manual';
    state.time = time;
    state.weather = weather;
    saveState();
    applyAmbience(time, weather, state.disabled, true);
  }

  function resetToAuto() {
    state.mode = 'auto';
    state.time = detectRealTimeSlot();
    state.weather = detectRealWeatherCondition();
    saveState();
    applyAmbience(state.time, state.weather, state.disabled, true);
  }

  // ===== 8. 状态持久化 =====
  function loadSavedState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state.remember = !!parsed.remember;
        state.disabled = !!parsed.disabled;

        if (state.remember && parsed.mode === 'manual') {
          state.mode = 'manual';
          state.time = parsed.time || 'noon';
          state.weather = parsed.weather || 'clear';
          return;
        }
      }
    } catch (e) {
      console.warn('[Ambience] 加载本地配置失败:', e);
    }

    // 默认自动现实模式
    state.mode = 'auto';
    state.time = detectRealTimeSlot();
    state.weather = detectRealWeatherCondition();
  }

  function saveState() {
    try {
      const dataToSave = {
        remember: state.remember,
        disabled: state.disabled,
        mode: state.remember ? state.mode : 'auto',
        time: state.time,
        weather: state.weather
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
    } catch (e) {
      console.warn('[Ambience] 保存配置失败:', e);
    }
  }

  // ===== 9. 初始化与定时循环 =====
  function init() {
    loadSavedState();
    buildPopoverDOM();
    applyAmbience(state.time, state.weather, state.disabled, false);

    // 每隔 60 秒检查本地时间和现实天气是否有变动
    setInterval(() => {
      detectRealWeatherCondition();
      if (state.mode === 'auto' && !state.disabled) {
        const nextTime = detectRealTimeSlot();
        const nextWeather = detectRealWeatherCondition();
        if (nextTime !== state.time || nextWeather !== state.weather) {
          state.time = nextTime;
          state.weather = nextWeather;
          applyAmbience(nextTime, nextWeather, false, false);
        }
      }
      updateTopbarUI();
    }, 60000);
  }

  // 挂载公用 API
  window.WeatherAmbience = {
    init,
    getState: () => ({ ...state }),
    setManual: setManualAmbience,
    resetToAuto,
    setDisabled: (val) => {
      state.disabled = !!val;
      saveState();
      applyAmbience(state.time, state.weather, state.disabled, true);
    }
  };

  // 页面就绪后自启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
