/**
 * motion.js - 小松绿全站动效交互引擎 · 手账伴侣与微交互
 * 包含：
 * 1. 卡片全向 3D 鼠标跟随浮动与光泽反射 (Interactive 3D Mouse Tilt & Sheen)
 * 2. 指尖星光与松针仙女粉光标拖尾 (Sparkle Cursor Dust Trail)
 * 3. 清晨极光柔光呼吸层 (Ambient Aurora Glow Layer)
 * 4. 非触发式全站自然微生态画布 (Ambient Flora & Melody Breeze Canvas)
 * 5. 正在播放时的旋律音符浮空 (Playing Melody Ambient Notes)
 * 6. 手账盖章星光粒子爆发 (Stamp Sparkles Burst)
 * 7. 浮动播放舱优雅升起与降落动效管理 (Player Bar Motion Deck)
 */

(function () {
  'use strict';

  // 检查减弱动态偏好
  const prefersReducedMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 检查是否具备精细指针（桌面鼠标）
  const isFinePointer = () =>
    window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ==========================================================================
     1. 清晨极光柔光呼吸背景注入 (Ambient Aurora Glow Layer)
     ========================================================================== */
  function initAmbientAurora() {
    if (prefersReducedMotion() || document.getElementById('ambientAuroraBg')) return;
    const auroraWrap = document.createElement('div');
    auroraWrap.id = 'ambientAuroraBg';
    auroraWrap.innerHTML = `
      <div class="aurora-orb aurora-orb-1"></div>
      <div class="aurora-orb aurora-orb-2"></div>
    `;
    document.body.prepend(auroraWrap);
  }

  /* ==========================================================================
     2. 卡片全向 3D 鼠标跟随倾斜与光斑流动 (Interactive 3D Tilt & Light Sheen)
     ========================================================================== */
  function initCard3DTilt() {
    if (!isFinePointer() || prefersReducedMotion()) return;

    let activeCard = null;
    let cardRect = null;
    let rafId = null;
    let mousePos = { x: 0, y: 0 };

    function updateCardTransform() {
      if (!activeCard || !cardRect) return;

      const px = (mousePos.x - cardRect.left) / cardRect.width - 0.5; // -0.5 ~ 0.5
      const py = (mousePos.y - cardRect.top) / cardRect.height - 0.5; // -0.5 ~ 0.5

      // 卡片浮动位移跟随光标方位：
      // 精细微调幅度（原 ±9px 缩减至 ±2.8px），既保持轻盈跟手的磁吸悬浮质感，又杜绝大幅晃动失控
      const tx = (px * 5.6).toFixed(1);
      // 上下微浮动：原 -11px ~ -1px 优化为 -3.8px ~ -1.4px（底数 -2.6px 优雅上浮，上下微动 ±1.2px）
      const ty = (-2.6 + py * 2.4).toFixed(1);

      // 3D 倾斜角度跟随光标方位：从原 8.5 度缩减至克制优雅的 3.5 度
      const maxTilt = 3.5;
      const rx = (-py * maxTilt).toFixed(2);
      const ry = (px * maxTilt).toFixed(2);
      const glareX = ((px + 0.5) * 100).toFixed(1);
      const glareY = ((py + 0.5) * 100).toFixed(1);

      activeCard.style.setProperty('--tx', `${tx}px`);
      activeCard.style.setProperty('--ty', `${ty}px`);
      activeCard.style.setProperty('--tz', '4.5px');
      activeCard.style.setProperty('--rx', `${rx}deg`);
      activeCard.style.setProperty('--ry', `${ry}deg`);
      activeCard.style.setProperty('--sc', '1.012');
      activeCard.style.setProperty('--glare-opacity', '0.85');
      activeCard.style.setProperty('--glare-x', `${glareX}%`);
      activeCard.style.setProperty('--glare-y', `${glareY}%`);

      rafId = null;
    }

    function resetCard(card) {
      if (!card) return;
      card.style.setProperty('--card-trans-dur', '0.38s');
      card.style.setProperty('--card-trans-ease', 'cubic-bezier(0.22, 1, 0.36, 1)');
      card.style.transition = 'transform 0.38s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.35s ease';
      card.style.setProperty('--tx', '0px');
      card.style.setProperty('--ty', '0px');
      card.style.setProperty('--tz', '0px');
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
      card.style.setProperty('--sc', '1');
      card.style.setProperty('--glare-opacity', '0');
    }

    window.addEventListener('scroll', function () {
      if (activeCard) {
        cardRect = activeCard.getBoundingClientRect();
      }
    }, { passive: true });

    document.addEventListener('mousemove', function (e) {
      const card = e.target.closest('.song-item, .sound-btn, .history-item, .favorite-item, .operator-btn, .action-btn');

      if (!card) {
        if (activeCard) {
          resetCard(activeCard);
          activeCard = null;
          cardRect = null;
        }
        return;
      }

      if (activeCard !== card) {
        if (activeCard) resetCard(activeCard);
        activeCard = card;
        cardRect = card.getBoundingClientRect();
        card.style.setProperty('--card-trans-dur', '0.12s');
        card.style.setProperty('--card-trans-ease', 'cubic-bezier(0.2, 0.8, 0.25, 1)');
        card.style.transition = 'transform 0.12s cubic-bezier(0.2, 0.8, 0.25, 1), box-shadow 0.25s ease-out';
      }

      mousePos.x = e.clientX;
      mousePos.y = e.clientY;

      if (!rafId) {
        rafId = requestAnimationFrame(updateCardTransform);
      }
    }, { passive: true });

    document.addEventListener('mouseleave', function () {
      if (activeCard) {
        resetCard(activeCard);
        activeCard = null;
        cardRect = null;
      }
    }, { passive: true });
  }

  /* ==========================================================================
     3. 指尖星光光标拖尾特效 (Sparkle Cursor Dust Trail)
     ========================================================================== */
  function initCursorDust() {
    if (!isFinePointer() || prefersReducedMotion()) return;

    let lastTime = 0;
    let lastX = 0;
    let lastY = 0;

    // 自然温润的林间暖阳与松绿微尘色盘（自带柔和半透明）
    const DUST_PALETTE = [
      'rgba(138, 168, 92, 0.65)',   // 松针清绿
      'rgba(235, 198, 120, 0.68)',  // 晨曦暖金
      'rgba(175, 212, 150, 0.60)',  // 嫩叶浅青
      'rgba(245, 226, 175, 0.70)',  // 柔和光斑米金
      'rgba(196, 170, 130, 0.55)',  // 暖木柔杏
      'rgba(152, 195, 128, 0.62)'   // 晨露草绿
    ];
    // 极小比例点缀的极简微星（无大花朵/大图标）
    const MICRO_SPARKLES = ['✦', '⋆', '·'];

    document.addEventListener('mousemove', function (e) {
      const now = performance.now();
      if (now - lastTime < 32) return; // 约 30fps，保持连贯柔和而不产生视觉堆叠

      // 距离阈值检测：仅当光标移动超过 6px 时才释放微尘，静止或原位微颤时不产生
      const dist = Math.hypot(e.clientX - lastX, e.clientY - lastY);
      if (dist < 6 && lastTime !== 0) return;

      lastTime = now;
      lastX = e.clientX;
      lastY = e.clientY;

      // 如果当前鼠标在输入框上，不发射微尘以免干扰打字
      if (e.target.closest('input, textarea')) return;

      const dust = document.createElement('span');
      dust.className = 'cursor-dust';

      // 85% 为极细微的光晕微粒圆点，15% 为精致纤细的微型十字星辰
      const isSparkle = Math.random() < 0.15;
      const color = DUST_PALETTE[Math.floor(Math.random() * DUST_PALETTE.length)];

      // 自然的微量浮力漂移（左右微拂，上下轻缓沉降或微浮）
      const dx = (Math.random() - 0.5) * 10;
      const dy = (Math.random() - 0.35) * 8;
      const opacity = (Math.random() * 0.2 + 0.5).toFixed(2); // 0.50 ~ 0.70 柔和半透明

      dust.style.setProperty('--dx', `${dx.toFixed(1)}px`);
      dust.style.setProperty('--dy', `${dy.toFixed(1)}px`);
      dust.style.setProperty('--dust-op', opacity);

      if (isSparkle) {
        dust.textContent = MICRO_SPARKLES[Math.floor(Math.random() * MICRO_SPARKLES.length)];
        dust.style.fontSize = `${Math.floor(Math.random() * 3) + 8}px`; // 8px ~ 10px 极简微星
        dust.style.color = color;
        dust.style.lineHeight = '1';
        dust.style.textShadow = `0 0 5px ${color}`;
      } else {
        // 2.5px ~ 4px 极细微林间光斑
        const size = (Math.random() * 1.8 + 2.4).toFixed(1);
        dust.style.width = `${size}px`;
        dust.style.height = `${size}px`;
        dust.style.backgroundColor = color;
        dust.style.boxShadow = `0 0 5px 1px ${color}`;
      }

      // 极轻微初始坐标分散
      const offsetX = (Math.random() - 0.5) * 4;
      const offsetY = (Math.random() - 0.5) * 4;

      dust.style.left = `${e.clientX + offsetX}px`;
      dust.style.top = `${e.clientY + offsetY}px`;
      document.body.appendChild(dust);

      setTimeout(() => dust.remove(), 620);
    }, { passive: true });
  }

  /* ==========================================================================
     4. 非触发式全站自然微生态背景画布 (Ambient Flora & Melody Breeze Canvas)
     ========================================================================== */
  function initAmbientBreezeCanvas() {
    if (prefersReducedMotion()) return;

    let canvas = document.getElementById('ambientBreezeCanvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'ambientBreezeCanvas';
      document.body.prepend(canvas);
    }

    const ctx = canvas.getContext('2d');
    let width = 0;
    let height = 0;
    let isPaused = false;
    let animId = null;

    function resize() {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize, { passive: true });
    resize();

    // 丰富的粒子元素：落叶、松针、音乐符号、萤火虫光斑、晨露气泡
    const MOTIFS = [
      { text: '🍃', color: '#8a9a4e', type: 'text', size: 15 },
      { text: '🌿', color: '#747f54', type: 'text', size: 14 },
      { text: '♪',  color: '#8a9a4e', type: 'text', size: 16 },
      { text: '♫',  color: '#b57d1c', type: 'text', size: 16 },
      { text: '♬',  color: '#6f7d3d', type: 'text', size: 14 },
      { text: '✦',  color: '#f4ce62', type: 'text', size: 12 },
      { text: '✨', color: '#e8b890', type: 'text', size: 12 },
      { color: '#b5d58f', type: 'dewdrop', size: 4 },
      { color: '#f4ce62', type: 'firefly', size: 3.5 }
    ];
    const isMobileDevice = window.innerWidth <= 768;
    const PARTICLE_COUNT = isMobileDevice 
      ? 10 
      : Math.min(30, Math.max(16, Math.floor(window.innerWidth / 50)));
    const particles = [];

    // 全局微风扰动
    let mouseX = -1000, mouseY = -1000;
    window.addEventListener('mousemove', e => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    }, { passive: true });

    class AmbientParticle {
      constructor(isInitial = false) {
        this.reset(isInitial);
      }

      reset(isInitial = false) {
        this.motif = MOTIFS[Math.floor(Math.random() * MOTIFS.length)];
        this.x = Math.random() * width;
        this.y = isInitial ? Math.random() * height : height + 25;
        this.vx = (Math.random() - 0.2) * 0.5;
        this.vy = -(Math.random() * 0.6 + 0.35);
        this.size = this.motif.size * (Math.random() * 0.45 + 0.8);
        this.rot = Math.random() * Math.PI * 2;
        this.rotSpeed = (Math.random() - 0.5) * 0.025;
        this.swaySpeed = Math.random() * 0.02 + 0.012;
        this.swayOffset = Math.random() * Math.PI * 2;
        this.swayWidth = Math.random() * 0.7 + 0.35;
        this.baseOpacity = Math.random() * 0.4 + 0.35;
        this.opacity = 0;
        this.haloPhase = Math.random() * Math.PI * 2;
      }

      update(t) {
        // 微风摇曳
        this.x += this.vx + Math.sin(t * this.swaySpeed + this.swayOffset) * this.swayWidth;
        this.y += this.vy;
        this.rot += this.rotSpeed;
        this.haloPhase += 0.04;

        // 鼠标微风气流推力（靠近光标时光滑避让，生动灵敏）
        const dx = this.x - mouseX;
        const dy = this.y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 90 && dist > 0) {
          const force = (90 - dist) / 90 * 1.5;
          this.x += (dx / dist) * force;
          this.y += (dy / dist) * force;
        }

        // 柔和淡入淡出
        if (this.y > height - 60) {
          this.opacity = Math.min(this.baseOpacity, this.opacity + 0.015);
        } else if (this.y < 80) {
          this.opacity = Math.max(0, this.opacity - 0.012);
        } else {
          this.opacity = this.baseOpacity;
        }

        if (this.y < -35 || this.x < -35 || this.x > width + 35) {
          this.reset(false);
        }
      }

      draw() {
        if (this.opacity <= 0) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate(this.rot);

        if (this.motif.type === 'text') {
          ctx.font = `${this.size}px serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = this.motif.color;
          ctx.fillText(this.motif.text, 0, 0);
        } else if (this.motif.type === 'firefly') {
          const pulse = Math.sin(this.haloPhase) * 0.35 + 0.95;
          const outerR = Math.max(1, this.size * 2.2 * pulse);
          const grad = ctx.createRadialGradient(0, 0, this.size * 0.3, 0, 0, outerR);
          grad.addColorStop(0, '#ffffff');
          grad.addColorStop(0.3, this.motif.color);
          grad.addColorStop(1, 'rgba(244, 206, 98, 0)');
          ctx.beginPath();
          ctx.arc(0, 0, outerR, 0, Math.PI * 2);
          ctx.fillStyle = grad;
          ctx.fill();
        } else if (this.motif.type === 'dewdrop') {
          ctx.beginPath();
          ctx.arc(0, 0, this.size, 0, Math.PI * 2);
          ctx.fillStyle = this.motif.color;
          ctx.fill();
        }

        ctx.restore();
      }
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(new AmbientParticle(true));
    }

    let time = 0;
    function render() {
      if (isPaused) return;
      ctx.clearRect(0, 0, width, height);
      time++;

      for (let i = 0; i < particles.length; i++) {
        particles[i].update(time);
        particles[i].draw();
      }

      animId = requestAnimationFrame(render);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        isPaused = true;
        if (animId) cancelAnimationFrame(animId);
      } else {
        isPaused = false;
        render();
      }
    });

    render();
  }

  /* ==========================================================================
     5. 正在播放时的旋律音符浮空喷涌 (Playing Melody Ambient Notes)
     ========================================================================== */
  function initMelodyNotesEmitter() {
    if (prefersReducedMotion()) return;

    const NOTES = ['♪', '♫', '♬', '♩', '🍃', '✨'];
    const COLORS = ['#8a9a4e', '#6f7d3d', '#e8b890', '#b57d1c', '#f4ce62'];

    setInterval(() => {
      const isPlaying = document.querySelector('.song-item.now-playing, .sound-btn.playing, .song-vinyl-wrap.spinning');
      if (!isPlaying || document.hidden) return;

      const playerBar = document.getElementById('playerBar');
      if (!playerBar || playerBar.style.display === 'none' || playerBar.classList.contains('motion-hidden')) return;

      const rect = playerBar.getBoundingClientRect();
      const note = document.createElement('span');
      note.className = 'ambient-melody-note';
      note.textContent = NOTES[Math.floor(Math.random() * NOTES.length)];
      note.style.color = COLORS[Math.floor(Math.random() * COLORS.length)];

      const spawnX = rect.left + Math.random() * (rect.width - 50) + 25;
      const spawnY = rect.top + 6;

      note.style.left = `${spawnX}px`;
      note.style.top = `${spawnY}px`;
      document.body.appendChild(note);

      setTimeout(() => note.remove(), 3200);
    }, 1800);
  }

  /* ==========================================================================
     6. 手账印章星光粒子喷涌 (Stamp Sparkles Burst)
     ========================================================================== */
  const PASTEL_COLORS = ['#8a9a4e', '#e8b890', '#f4ce62', '#e06c75', '#747f54', '#b5d58f'];
  const SYMBOLS = ['★', '✦', '♥', '🌸', '✨', '🍃'];

  function createStampBurst(x, y, count = 12) {
    if (prefersReducedMotion()) return;

    for (let i = 0; i < count; i++) {
      const particle = document.createElement('span');
      particle.className = 'motion-spark-particle';

      const isText = Math.random() > 0.4;
      if (isText) {
        particle.textContent = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
        particle.style.fontSize = `${Math.floor(Math.random() * 8) + 11}px`;
        particle.style.color = PASTEL_COLORS[Math.floor(Math.random() * PASTEL_COLORS.length)];
      } else {
        const size = Math.floor(Math.random() * 6) + 4;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        particle.style.backgroundColor = PASTEL_COLORS[Math.floor(Math.random() * PASTEL_COLORS.length)];
        particle.style.boxShadow = `0 1px 4px rgba(0,0,0,0.1)`;
      }

      particle.style.left = `${x}px`;
      particle.style.top = `${y}px`;
      document.body.appendChild(particle);

      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const velocity = Math.random() * 60 + 35;
      const targetX = Math.cos(angle) * velocity;
      const targetY = Math.sin(angle) * velocity - 22;
      const rotation = (Math.random() - 0.5) * 480;
      const duration = Math.random() * 250 + 550;

      particle.animate(
        [
          { transform: 'translate(-50%, -50%) scale(0) rotate(0deg)', opacity: 1 },
          { transform: `translate(calc(-50% + ${targetX * 0.5}px), calc(-50% + ${targetY * 0.5}px)) scale(1.35) rotate(${rotation * 0.5}deg)`, opacity: 0.95, offset: 0.35 },
          { transform: `translate(calc(-50% + ${targetX}px), calc(-50% + ${targetY + 25}px)) scale(0) rotate(${rotation}deg)`, opacity: 0 }
        ],
        {
          duration: duration,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          fill: 'forwards'
        }
      ).onfinish = () => particle.remove();
    }
  }

  document.addEventListener('click', function (e) {
    const favBtn = e.target.closest('.favorite-star, [data-favorite-key], #playerFavBtn');
    if (favBtn) {
      const rect = favBtn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      setTimeout(() => createStampBurst(cx, cy, 11), 60);
    }
  }, { passive: true });

  /* ==========================================================================
     7. 安全 View Transitions 封装 (Safe View Transitions)
     ========================================================================== */
  function safeViewTransition(updateCallback) {
    if (prefersReducedMotion() || !document.startViewTransition) {
      updateCallback();
      return;
    }
    try {
      document.startViewTransition(updateCallback);
    } catch (e) {
      updateCallback();
    }
  }

  /* ==========================================================================
     8. 悬浮播放条 (Player Bar) 平滑升起/隐藏助手
     ========================================================================== */
  function setupPlayerBarMotion(playerBarEl) {
    if (!playerBarEl) return;

    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          const isNone = playerBarEl.style.display === 'none';
          if (!isNone) {
            requestAnimationFrame(() => {
              playerBarEl.classList.remove('motion-hidden');
              playerBarEl.classList.add('motion-visible');
            });
          }
        }
      });
    });

    observer.observe(playerBarEl, { attributes: true });

    if (playerBarEl.style.display !== 'none') {
      playerBarEl.classList.add('motion-visible');
    } else {
      playerBarEl.classList.add('motion-hidden');
    }
  }

  // 资源路径自动适配（支持主站与 buttons/、24xsl/、calc/ 子目录）
  function getAssetPath(filename) {
    const isSubdir = window.location.pathname.includes('/buttons/') || 
                     window.location.pathname.includes('/24xsl/') || 
                     window.location.pathname.includes('/calc/');
    return isSubdir ? `../assets/${filename}` : `assets/${filename}`;
  }

  /* ==========================================================================
     9. 灵动手账桌宠伴侣系统 (Scrapbook Companion Pet & Chat Bubble)
     ========================================================================== */
  function initScrapbookCompanion() {
    if (prefersReducedMotion()) return;
    if (document.getElementById('scrapbookCompanion')) return;

    const avatarUrl = getAssetPath('xiaosonglu-bubble.png');

    const companion = document.createElement('div');
    companion.className = 'scrapbook-companion';
    companion.id = 'scrapbookCompanion';

    // 记忆折叠偏好（手机端首次访问默认折叠为贴边萌芽小标，不遮挡按钮与歌单）
    const isMobile = window.innerWidth <= 768;
    const storedFolded = sessionStorage.getItem('xsl_companion_folded');
    const isFolded = storedFolded !== null ? storedFolded === 'true' : isMobile;
    if (isFolded) {
      companion.classList.add('companion-folded');
    }

    companion.innerHTML = `
      <div class="companion-bubble" id="companionBubble">
        <p class="companion-bubble-text" id="companionBubbleText">今天也要像向日葵一样灿烂生长哦！🌻</p>
        <div class="companion-bubble-actions">
          <button class="companion-action-btn primary" id="companionFortuneBtn">🎯 抽今日好运歌签</button>
          <button class="companion-action-btn" id="companionCloseBubbleBtn">知道啦</button>
        </div>
      </div>
      <div class="companion-pet-wrap" id="companionPetWrap">
        <button class="companion-toggle-btn" id="companionToggleBtn" title="${isFolded ? '展开桌宠伴侣' : '收起桌宠伴侣'}">${isFolded ? '▶' : '◀'}</button>
        <div class="companion-pet" id="companionPet" title="戳戳我，抽取今日幸运好歌！">
          <img src="${avatarUrl}" alt="小松绿桌宠">
          <div class="companion-badge">🌱</div>
        </div>
      </div>
    `;

    document.body.appendChild(companion);

    const pet = document.getElementById('companionPet');
    const bubble = document.getElementById('companionBubble');
    const bubbleText = document.getElementById('companionBubbleText');
    const toggleBtn = document.getElementById('companionToggleBtn');
    const fortuneBtn = document.getElementById('companionFortuneBtn');
    const closeBubbleBtn = document.getElementById('companionCloseBubbleBtn');

    const QUOTES = [
      '今天也要像向日葵一样灿烂生长哦！🌻',
      '松针挂满清晨露珠，今天也是元气满满的一天！🌱',
      '听首歌放松一下吧，你今天辛苦啦~ 🍵',
      '悄悄告诉你：主站歌单按【空格键】可以快捷播放/暂停哦！🎵',
      '小松绿今天也在为你加油呢！✨',
      '在森林里深呼吸三次，把烦恼都交给清风吧~ 🍃',
      '不知道听什么？点击下方按钮抽取今日专属歌签吧！🎯',
      '松果落在手心，接住今天的一份小幸运~ 🌰',
      '喜欢这首歌的话，别忘了点亮小红心收藏进手账哦！💖',
      '听着歌写作业或工作，效率会悄悄变高呢！📝',
      '今天的风是抹茶味的，轻轻柔柔~ 🍃',
      '戳我一下，给你变一颗小星星！🌟',
      '你的好心情电量已充满 100%！🔋',
      '在歌声里躲一会儿，世界会变得温柔起来~ 🎶',
      '今天有好好喝水、好好吃饭吗？要照顾好自己呀！🍱',
      '音乐是世界上最好的魔法，能把阴天变成晴空！🌈'
    ];

    let bubbleTimer = null;

    function showBubble(text) {
      if (bubbleTimer) clearTimeout(bubbleTimer);
      bubbleText.textContent = text || QUOTES[Math.floor(Math.random() * QUOTES.length)];
      bubble.classList.add('show');
      bubbleTimer = setTimeout(() => {
        bubble.classList.remove('show');
      }, 7000);
    }

    pet.addEventListener('click', function (e) {
      e.stopPropagation();

      // 若当前处于折叠状态，点击伴侣直接丝滑展开
      if (companion.classList.contains('companion-folded')) {
        companion.classList.remove('companion-folded');
        toggleBtn.textContent = '◀';
        toggleBtn.title = '收起桌宠伴侣';
        sessionStorage.setItem('xsl_companion_folded', 'false');
      }

      // 果冻弹性跳跃
      pet.classList.remove('pet-bouncing');
      void pet.offsetWidth;
      pet.classList.add('pet-bouncing');

      // 伴侣周围爆出微粒
      const rect = pet.getBoundingClientRect();
      createStampBurst(rect.left + rect.width / 2, rect.top + rect.height / 2, 7);

      // 显示随机治愈气泡
      showBubble();
    });

    toggleBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      const willFold = !companion.classList.contains('companion-folded');
      companion.classList.toggle('companion-folded', willFold);
      toggleBtn.textContent = willFold ? '▶' : '◀';
      toggleBtn.title = willFold ? '展开桌宠伴侣' : '收起桌宠伴侣';
      sessionStorage.setItem('xsl_companion_folded', String(willFold));
      if (willFold) {
        bubble.classList.remove('show');
      }
    });

    fortuneBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      bubble.classList.remove('show');
      openFortuneCard();
    });

    closeBubbleBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      bubble.classList.remove('show');
    });

    // 闲置 28 秒提醒（仅在未折叠且气泡未显示时触发）
    let lastUserAction = performance.now();
    ['mousemove', 'keydown', 'scroll', 'click'].forEach(evt => {
      window.addEventListener(evt, () => {
        lastUserAction = performance.now();
      }, { passive: true });
    });

    setInterval(() => {
      if (document.hidden) return;
      if (companion.classList.contains('companion-folded')) return;
      if (bubble.classList.contains('show')) return;
      if (performance.now() - lastUserAction > 28000) {
        lastUserAction = performance.now();
        showBubble('在森林树荫下坐一会儿吧，听首歌放松一下~ 🍃');
      }
    }, 15000);
  }

  /* ==========================================================================
     10. 每日好运歌签 / 听歌盲盒系统 (Daily Lucky Song Fortune Capsule)
     ========================================================================== */
  const FORTUNE_DEFAULT_SONGS = [
    { name: '夏天的风', artist: '温润治愈 · 经典翻唱', quote: '“七月的风懒懒的，连云都变热热的。今日宜放慢脚步，听一曲温柔微风。”', good: '单曲循环 🎧', mood: '治愈放空 🍃' },
    { name: '小城夏天', artist: '元气活力 · 青春民谣', quote: '“橘子汽水碰上青翠松林，今天的小小愿望都会实现。”', good: '散步看云 ⛅', mood: '元气满分 🍊' },
    { name: '起风了', artist: '直抵心扉 · 情感共鸣', quote: '“从前初识这世间，万般流连。愿你在平凡的日子里也能满怀热忱。”', good: '奔赴热爱 🏃', mood: '心潮澎湃 🌟' },
    { name: '晴天', artist: '青春印记 · 校园纯真', quote: '“故事的小黄花，从出生那年就飘着。童年的秋千与微风一直都在。”', good: '翻翻旧手账 📖', mood: '怀念纯真 🌻' },
    { name: '夜空中最亮的星', artist: '温暖坚定 · 破晓之光', quote: '“每当找不到存在的意义，每当迷失在黑夜里，仰望星空，微光常在。”', good: '静心专注 ✍️', mood: '坚定前行 💫' },
    { name: '向云端', artist: '空灵宁静 · 诗意栖居', quote: '“向云端，山那边，海的那边。放过自己，享受微风与当下的每一刻。”', good: '深呼吸 🍵', mood: '松弛自在 ☁️' },
    { name: '光的方向', artist: '热血坚定 · 乘风破浪', quote: '“踏着荆棘，迎向晨曦。你的坚持终将成为照亮前路的光。”', good: '勇敢挑战 💪', mood: '破茧而生 ☀️' },
    { name: '同桌的你', artist: '纯真叙旧 · 经典民谣', quote: '“谁娶了多愁善感的你，谁安慰爱哭的你。时光慢些走，留住记忆的温度。”', good: '联系好友 💌', mood: '温情常伴 🎈' }
  ];

  function openFortuneCard() {
    let modal = document.getElementById('fortuneModalBackdrop');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'fortune-modal-backdrop';
      modal.id = 'fortuneModalBackdrop';
      modal.innerHTML = `
        <div class="fortune-card" id="fortuneCardInner">
          <div class="fortune-tape"></div>
          <div class="fortune-header">
            <span>🍀</span>
            <span>今日歌签 · 运势大吉</span>
            <span>✨</span>
          </div>
          <div class="fortune-song-name" id="fortuneSongName">--</div>
          <div class="fortune-song-artist" id="fortuneSongArtist">--</div>
          <div class="fortune-quote-box" id="fortuneQuoteBox">--</div>
          <div class="fortune-meta-row">
            <div class="fortune-meta-item">今日宜<strong id="fortuneGood">--</strong></div>
            <div class="fortune-meta-item">幸运指数<strong id="fortuneLuck">99% 🌟</strong></div>
            <div class="fortune-meta-item">契合心情<strong id="fortuneMood">--</strong></div>
          </div>
          <div class="fortune-btn-row">
            <button class="fortune-btn cancel" id="fortuneCloseBtn">收下手账签</button>
            <button class="fortune-btn play" id="fortunePlayBtn">▶ 立即播放这首</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.addEventListener('click', function (e) {
        if (e.target === modal || e.target.id === 'fortuneCloseBtn') {
          modal.classList.remove('active');
        }
      });
    }

    // 随机挑选一首好歌（优先从当前页面实际歌曲列表中抽取，确保百分之百能播）
    const songCards = Array.from(document.querySelectorAll('.song-item'));
    let chosenSong = null;
    let chosenName = '';
    let chosenArtist = '';

    if (songCards.length > 0) {
      const card = songCards[Math.floor(Math.random() * songCards.length)];
      chosenSong = card;
      chosenName = card.querySelector('.song-title, .song-name')?.textContent?.trim() || '经典曲目';
      chosenArtist = card.querySelector('.song-artist')?.textContent?.trim() || '小松绿 演唱';
    }

    const template = FORTUNE_DEFAULT_SONGS[Math.floor(Math.random() * FORTUNE_DEFAULT_SONGS.length)];
    const songName = chosenName || template.name;
    const songArtist = chosenArtist || template.artist;

    document.getElementById('fortuneSongName').textContent = songName;
    document.getElementById('fortuneSongArtist').textContent = songArtist;
    document.getElementById('fortuneQuoteBox').textContent = template.quote;
    document.getElementById('fortuneGood').textContent = template.good;
    document.getElementById('fortuneMood').textContent = template.mood;
    document.getElementById('fortuneLuck').textContent = `${Math.floor(Math.random() * 6) + 95}% 🌟`;

    const playBtn = document.getElementById('fortunePlayBtn');
    playBtn.onclick = function () {
      modal.classList.remove('active');
      createStampBurst(window.innerWidth / 2, window.innerHeight / 2, 16);

      // 如果抓取到了当前页面的卡片，直接模拟点击播放
      if (chosenSong) {
        chosenSong.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const playButton = chosenSong.querySelector('.song-play-btn, .song-info, .song-title') || chosenSong;
        setTimeout(() => playButton.click(), 300);
      } else if (window.location.pathname.includes('/buttons/')) {
        // 在按钮墙页面，随机播放一个音频按钮
        const soundBtns = document.querySelectorAll('.sound-btn');
        if (soundBtns.length > 0) {
          const btn = soundBtns[Math.floor(Math.random() * soundBtns.length)];
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          btn.click();
        }
      } else {
        // 跳转到主歌单并搜索
        window.location.href = `../index.html?search=${encodeURIComponent(songName)}`;
      }
    };

    modal.classList.add('active');
    createStampBurst(window.innerWidth / 2, window.innerHeight / 2, 8);
  }

  /* ==========================================================================
     11. 播放器麦浪音频律动频谱 (Fluid Music Spectrum in Player Bar)
     ========================================================================== */
  function initPlayerSpectrum() {
    const playerBar = document.getElementById('playerBar');
    if (!playerBar) return;

    let spectrum = document.getElementById('playerAudioSpectrum');
    if (!spectrum) {
      spectrum = document.createElement('div');
      spectrum.className = 'player-audio-spectrum';
      spectrum.id = 'playerAudioSpectrum';
      spectrum.title = '音乐律动麦浪频谱';
      for (let i = 0; i < 7; i++) {
        const bar = document.createElement('span');
        bar.className = 'spectrum-bar';
        spectrum.appendChild(bar);
      }

      // 插入到 player-info 内或 player-card 的 pc-left
      const playerInfo = playerBar.querySelector('.player-info, .pc-left');
      if (playerInfo) {
        playerInfo.appendChild(spectrum);
      } else {
        playerBar.appendChild(spectrum);
      }
    }

    // 监听播放状态（兼容主站与按钮墙顶部播放器）
    setInterval(() => {
      const isPlaying = !!document.querySelector('.song-item.now-playing, .sound-btn.playing, .song-vinyl-wrap.spinning') ||
                        !!document.querySelector('#playerToggleBtn use[href*="pause"], #pbPlayBtn use[href*="pause"]');
      if (isPlaying) {
        spectrum.classList.add('active');
      } else {
        spectrum.classList.remove('active');
      }
    }, 400);
  }

  /* ==========================================================================
     12. 手账立体和纸胶带装饰 (Washi Tape Accents)
     ========================================================================== */
  function initWashiTapeCorners() {
    const targets = document.querySelectorAll('.header, .tabs, .banner, .player-card');
    targets.forEach(target => {
      if (target.querySelector('.washi-tape')) return;
      target.style.position = target.style.position || 'relative';

      const tapeTR = document.createElement('span');
      tapeTR.className = 'washi-tape washi-tape-top-right';
      target.appendChild(tapeTR);

      const tapeTL = document.createElement('span');
      tapeTL.className = 'washi-tape washi-tape-top-left';
      target.appendChild(tapeTL);
    });
  }

  /* ==========================================================================
     13. 全局触感晨露水波纹 (Zen Water Ripple on Click)
     ========================================================================== */
  function initClickRipple() {
    if (prefersReducedMotion()) return;

    let lastRippleTime = 0;
    document.addEventListener('pointerdown', function (e) {
      const now = performance.now();
      if (now - lastRippleTime < 70) return;
      lastRippleTime = now;

      // 避免在滑块拖动条上触发
      if (e.target.closest('input[type="range"]')) return;

      const ripple = document.createElement('span');
      ripple.className = 'click-water-ripple';
      ripple.style.left = `${e.clientX}px`;
      ripple.style.top = `${e.clientY}px`;
      document.body.appendChild(ripple);

      setTimeout(() => ripple.remove(), 480);
    }, { passive: true });
  }

  /* ==========================================================================
     14. 语音按钮墙极致互动特效系统 (Soundboard Enhanced FX System)
     ========================================================================== */
  function initButtonShockwaves() {
    // 浮动拟声词与弹跳文案
    const POPUP_TEXTS = [
      '+1 🎵', '好耶！✨', '再来一次~ 🌰', '太魔性啦！🔥', 
      '松绿发声！🌱', '🎶 滴！', '元气 +10 💖', '冲！⚡', 
      '绝了！🌟', '哈哈哈哈 🍃', '又听了一遍！✨', '循环播放 🔁'
    ];

    document.addEventListener('click', function (e) {
      // 1. 点击分类徽章盖章下压特效
      const catBadge = e.target.closest('.cat-badge');
      if (catBadge) {
        const rect = catBadge.getBoundingClientRect();
        createStampBurst(rect.left + rect.width / 2, rect.top + rect.height / 2, 8);
        return;
      }

      // 2. 点击语音按钮墙按钮
      const btn = e.target.closest('.sound-btn');
      if (!btn) return;

      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      // 机械下压回弹形变
      btn.classList.remove('btn-punched');
      void btn.offsetWidth;
      btn.classList.add('btn-punched');

      // 双层同心声浪光环扩散
      const wave1 = document.createElement('span');
      wave1.className = 'sound-shockwave-ring';
      btn.appendChild(wave1);
      setTimeout(() => wave1.remove(), 520);

      const wave2 = document.createElement('span');
      wave2.className = 'sound-shockwave-ring second';
      btn.appendChild(wave2);
      setTimeout(() => wave2.remove(), 600);

      // 上浮趣味漫画拟声词泡泡
      const bubble = document.createElement('span');
      bubble.className = 'floating-sound-bubble';
      const text = POPUP_TEXTS[Math.floor(Math.random() * POPUP_TEXTS.length)];
      bubble.textContent = text;
      const driftX = (Math.random() - 0.5) * 36;
      bubble.style.setProperty('--drift-x', `${driftX.toFixed(1)}px`);
      bubble.style.left = `${cx}px`;
      bubble.style.top = `${rect.top}px`;
      document.body.appendChild(bubble);
      setTimeout(() => bubble.remove(), 850);

      // 伴随微量手账微粒炸开
      createStampBurst(cx, cy, 6);
    }, { passive: true });

    // 3. 随机播放老虎机/轮盘快速扫光动效 (Roulette Sweep Animation)
    const randomBtn = document.getElementById('pbRandomBtn');
    if (randomBtn) {
      randomBtn.addEventListener('click', function () {
        const allBtns = Array.from(document.querySelectorAll('.sound-btn'));
        if (allBtns.length < 2) return;

        let sweeps = 0;
        const maxSweeps = 7;
        const interval = setInterval(() => {
          allBtns.forEach(b => b.classList.remove('roulette-sweep'));
          const luckyIdx = Math.floor(Math.random() * allBtns.length);
          const targetBtn = allBtns[luckyIdx];
          if (targetBtn) targetBtn.classList.add('roulette-sweep');
          sweeps++;

          if (sweeps >= maxSweeps) {
            clearInterval(interval);
            setTimeout(() => {
              if (targetBtn) {
                targetBtn.classList.remove('roulette-sweep');
                const rect = targetBtn.getBoundingClientRect();
                createStampBurst(rect.left + rect.width / 2, rect.top + rect.height / 2, 14);
              }
            }, 300);
          }
        }, 60);
      });
    }
  }

  /* ==========================================================================
     15. 斑驳林间树影滤镜层 (Dappled Sunlight Caustics)
     ========================================================================== */
  function initDappledSunlight() {
    if (prefersReducedMotion()) return;
    if (document.getElementById('dappledSunlight')) return;

    const layer = document.createElement('div');
    layer.id = 'dappledSunlight';
    document.body.prepend(layer);
  }

  // 页面加载完成后统一初始化
  function initMotionSystem() {
    initAmbientAurora();
    initDappledSunlight();
    initCard3DTilt();
    initCursorDust();
    initAmbientBreezeCanvas();
    initMelodyNotesEmitter();
    initPlayerSpectrum();
    initWashiTapeCorners();
    initClickRipple();
    initButtonShockwaves();
    initScrapbookCompanion();
    setupPlayerBarMotion(document.getElementById('playerBar'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMotionSystem);
  } else {
    initMotionSystem();
  }

  // 暴露全局 API
  window.XSL_MOTION = {
    createStampBurst,
    safeViewTransition,
    setupPlayerBarMotion,
    openFortuneCard
  };

})();
