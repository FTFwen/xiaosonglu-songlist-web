// buttons.js - 小松绿按钮墙
// 数据存 localStorage（简单版），管理员登录后可编辑分类/按钮
(() => {
  'use strict';

  // ===== 存储 =====
  const LS_KEY = 'xsl:buttons:data';
  const LS_ADMIN = 'xsl:buttons:admin'; // 管理员账号（登录后存 session 标记在 sessionStorage）

  // 初始管理员账号（用户提供真实账号后替换）
  const DEFAULT_ADMIN = { user: 'admin', pass: 'xsl12345' };

  // 默认数据结构
  const DEFAULT_DATA = {
    cats: [
      { id: 'mdichang', name: '名场面' },
      { id: 'bdong', name: 'b动静' },
      { id: 'nangyang', name: '娘养' }
    ],
    buttons: []
  };

  function loadData() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
  function saveData(data) {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  }

  // ===== 状态 =====
  let data = loadData();
  let activeCat = 'mdichang'; // 默认第一个分类
  let isAdmin = sessionStorage.getItem('xsl:buttons:authed') === '1';

  // ===== DOM =====
  const el = id => document.getElementById(id);
  const catsNav = el('catsNav');
  const btnGrid = el('btnGrid');
  const emptyHint = el('emptyHint');
  const adminPanel = el('adminPanel');
  const loginForm = el('loginForm');
  const adminBody = el('adminBody');
  const audioPlayer = el('audioPlayer');

  // ===== 渲染分类导航 =====
  function renderCats() {
    catsNav.innerHTML = '';
    data.cats.forEach(cat => {
      const tab = document.createElement('button');
      tab.className = 'cat-tab' + (cat.id === activeCat ? ' active' : '');
      tab.textContent = cat.name;
      tab.addEventListener('click', () => {
        activeCat = cat.id;
        renderCats();
        renderButtons();
      });
      catsNav.appendChild(tab);
    });
  }

  // ===== 渲染按钮网格 =====
  function renderButtons() {
    btnGrid.innerHTML = '';
    const list = data.buttons.filter(b => b.cat === activeCat);
    emptyHint.style.display = list.length ? 'none' : 'block';
    list.forEach(btn => {
      const card = document.createElement('button');
      card.className = 'sound-btn';
      card.innerHTML = `
        <div class="icon">▶</div>
        <div class="name">${esc(btn.name)}</div>
        ${btn.desc ? `<div class="desc">${esc(btn.desc)}</div>` : ''}
        <div class="playing-bar"></div>
      `;
      card.addEventListener('click', () => playSound(btn, card));
      btnGrid.appendChild(card);
    });
  }

  // ===== 播放音效 =====
  function playSound(btn, card) {
    const src = btn.audio;
    if (!src) {
      // 没音频，先给个反馈
      toast(`「${btn.name}」还没有音频`);
      return;
    }
    // 停止播放中的
    document.querySelectorAll('.sound-btn.playing').forEach(c => {
      c.classList.remove('playing');
      const bar = c.querySelector('.playing-bar');
      if (bar) bar.style.width = '0%';
    });
    audioPlayer.src = src;
    audioPlayer.currentTime = 0;
    audioPlayer.play().then(() => {
      card.classList.add('playing');
      const bar = card.querySelector('.playing-bar');
      if (bar) bar.style.width = '100%';
      // 播放结束后重置
      audioPlayer.onended = () => {
        card.classList.remove('playing');
        if (bar) bar.style.width = '0%';
      };
    }).catch(err => {
      console.warn('[按钮墙] 播放失败:', err);
      toast('音频播放失败');
    });
  }

  // ===== 轻提示 =====
  let toastTimer = null;
  function toast(msg) {
    const t = el('emptyHint');
    // 简单用 alert 替代，或用 toast 元素；此处用临时方式
    console.log('[按钮墙]', msg);
    // 用一个小提示
    if (!window.__toastEl) {
      const d = document.createElement('div');
      d.id = '__toast';
      d.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(61,70,48,.92);color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;z-index:9999;opacity:0;transition:opacity .25s;pointer-events:none;';
      document.body.appendChild(d);
      window.__toastEl = d;
    }
    const d = window.__toastEl;
    d.textContent = msg;
    d.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { d.style.opacity = '0'; }, 1600);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // ===== 管理员 =====
  function getAdmin() {
    try {
      const raw = localStorage.getItem(LS_ADMIN);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return DEFAULT_ADMIN;
  }

  function openAdmin() {
    adminPanel.classList.add('show');
    if (isAdmin) {
      enterAdminMode();
    } else {
      showLogin();
    }
  }
  function closeAdmin() {
    adminPanel.classList.remove('show');
  }
  function showLogin() {
    loginForm.style.display = 'flex';
    adminBody.style.display = 'none';
    el('adminCardTitle').textContent = '管理员登录';
    el('loginUser').value = '';
    el('loginPass').value = '';
    el('authErr').textContent = '';
  }
  function enterAdminMode() {
    loginForm.style.display = 'none';
    adminBody.style.display = 'block';
    el('adminCardTitle').textContent = '按钮墙管理后台';
    renderCatAdmin();
    renderBtnAdmin();
    fillCatSelect();
  }

  function doLogin() {
    const user = el('loginUser').value.trim();
    const pass = el('loginPass').value;
    const admin = getAdmin();
    if (user === admin.user && pass === admin.pass) {
      isAdmin = true;
      sessionStorage.setItem('xsl:buttons:authed', '1');
      enterAdminMode();
      toast('登录成功');
    } else {
      el('authErr').textContent = '用户名或密码错误';
    }
  }

  function logout() {
    isAdmin = false;
    sessionStorage.removeItem('xsl:buttons:authed');
    showLogin();
    toast('已退出登录');
  }

  // ===== 分类管理 =====
  function renderCatAdmin() {
    const list = el('catAdminList');
    list.innerHTML = '';
    data.cats.forEach(cat => {
      const item = document.createElement('div');
      item.className = 'admin-item';
      item.innerHTML = `
        <span class="nm">${esc(cat.name)}</span>
        <span class="grow"></span>
        <button class="btn-x danger" data-del-cat="${cat.id}">删除</button>
      `;
      item.querySelector('[data-del-cat]').addEventListener('click', () => {
        if (!confirm(`删除分类「${cat.name}」及其所有按钮？`)) return;
        data.cats = data.cats.filter(c => c.id !== cat.id);
        data.buttons = data.buttons.filter(b => b.cat !== cat.id);
        saveData(data);
        if (activeCat === cat.id) activeCat = data.cats[0] && data.cats[0].id;
        renderCats(); renderButtons(); renderCatAdmin(); renderBtnAdmin(); fillCatSelect();
      });
      list.appendChild(item);
    });
  }

  function addCat() {
    const name = el('newCatName').value.trim();
    if (!name) { toast('请输入分类名'); return; }
    const id = 'cat_' + Date.now();
    data.cats.push({ id, name });
    saveData(data);
    el('newCatName').value = '';
    renderCats(); renderCatAdmin(); fillCatSelect();
    toast('分类已添加');
  }

  // ===== 按钮管理 =====
  function fillCatSelect() {
    const sel = el('newBtnCat');
    const cur = sel.value || (data.cats[0] && data.cats[0].id);
    sel.innerHTML = '';
    data.cats.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.name;
      sel.appendChild(opt);
    });
    if (cur && data.cats.some(c => c.id === cur)) sel.value = cur;
  }

  function renderBtnAdmin() {
    const list = el('btnAdminList');
    list.innerHTML = '';
    data.buttons.forEach(btn => {
      const cat = data.cats.find(c => c.id === btn.cat);
      const item = document.createElement('div');
      item.className = 'admin-item';
      item.innerHTML = `
        <span class="nm">${esc(btn.name)}</span>
        <span class="ds">${esc(btn.audio || '无音频')} · ${cat ? cat.name : '?'}</span>
        <span class="grow"></span>
        <button class="btn-x danger" data-del-btn="${btn.id}">删除</button>
      `;
      item.querySelector('[data-del-btn]').addEventListener('click', () => {
        if (!confirm(`删除按钮「${btn.name}」？`)) return;
        data.buttons = data.buttons.filter(b => b.id !== btn.id);
        saveData(data);
        renderButtons(); renderBtnAdmin();
      });
      list.appendChild(item);
    });
  }

  function addBtn() {
    const name = el('newBtnName').value.trim();
    const desc = el('newBtnDesc').value.trim();
    const audio = el('newBtnAudio').value.trim();
    const cat = el('newBtnCat').value;
    if (!name) { toast('请输入按钮标题'); return; }
    if (!cat) { toast('请先选分类'); return; }
    data.buttons.push({ id: 'btn_' + Date.now(), name, desc, audio, cat });
    saveData(data);
    el('newBtnName').value = '';
    el('newBtnDesc').value = '';
    el('newBtnAudio').value = '';
    renderButtons(); renderBtnAdmin();
    toast('按钮已添加');
  }

  // ===== 事件绑定 =====
  el('adminLoginBtn').addEventListener('click', openAdmin);
  el('loginBtn').addEventListener('click', doLogin);
  el('cancelLoginBtn').addEventListener('click', showLogin);
  el('logoutBtn').addEventListener('click', logout);
  el('closeAdminBtn').addEventListener('click', closeAdmin);
  el('addCatBtn').addEventListener('click', addCat);
  el('addBtnBtn').addEventListener('click', addBtn);
  adminPanel.addEventListener('click', e => {
    if (e.target === adminPanel) closeAdmin();
  });
  // 回车登录
  el('loginUser').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  el('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // ===== 初始化 =====
  renderCats();
  renderButtons();
})();
