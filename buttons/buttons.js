// buttons.js - 小松绿按钮墙
// 数据：分类/按钮元数据存 localStorage；上传的音频字节存 IndexedDB
// 管理员登录后可编辑分类、上传音频、拖拽按钮改分类
(() => {
  'use strict';

  // ===== 存储 =====
  const LS_KEY = 'xsl:buttons:data';
  const IDB_NAME = 'xsl:buttons:audio';
  const IDB_STORE = 'audio';

  // 管理员账号（用户设定：文 / 0212）
  const DEFAULT_ADMIN = { user: '文', pass: '0212' };

  // 默认"其他"分类（删分类时的归入目标）
  const OTHER_CAT_ID = 'other';

  const DEFAULT_DATA = {
    cats: [
      { id: 'mdichang', name: '名场面' },
      { id: 'bdong', name: 'b动静' },
      { id: 'nangyang', name: '娘养' },
      { id: OTHER_CAT_ID, name: '其他' }
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

  // ===== IndexedDB 音频存储 =====
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbPut(id, blob) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ id, blob });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(id);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDel(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ===== 状态 =====
  let data = loadData();
  let isAdmin = sessionStorage.getItem('xsl:buttons:authed') === '1';

  // ===== DOM =====
  const el = id => document.getElementById(id);
  const wall = el('wall');
  const adminPanel = el('adminPanel');
  const loginForm = el('loginForm');
  const adminBody = el('adminBody');
  const audioPlayer = el('audioPlayer');

  // ===== 渲染：垂直分组列表 =====
  function renderWall() {
    wall.innerHTML = '';
    data.cats.forEach((cat, ci) => {
      const list = data.buttons.filter(b => b.cat === cat.id);
      const section = document.createElement('section');
      section.className = 'cat-section';

      const head = document.createElement('div');
      head.className = 'cat-head';
      head.innerHTML = `
        <div class="cat-badge">${ci + 1}</div>
        <div class="cat-title">${esc(cat.name)}</div>
        <div class="cat-count">${list.length} 条</div>
      `;
      section.appendChild(head);

      const listWrap = document.createElement('div');
      listWrap.className = 'btn-list';
      if (list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-hint';
        empty.textContent = '这个分类还没有按钮～';
        listWrap.appendChild(empty);
      } else {
        list.forEach((btn, bi) => {
          const card = document.createElement('button');
          card.className = 'sound-btn';
          card.innerHTML = `
            <div class="sb-main"><div class="sb-name">${esc(btn.name)}</div></div>
            <div class="sb-dur">${fmtDur(btn.duration)}</div>
          `;
          card.addEventListener('click', () => playSound(btn, card));
          listWrap.appendChild(card);
        });
      }
      section.appendChild(listWrap);
      wall.appendChild(section);
    });
  }

  // ===== 播放音效 + 顶部播放条 =====
  let currentBtn = null; // 当前播放的按钮
  let playMode = 'sequence'; // sequence | single
  const playerBar = el('playerBar');
  const pbName = el('pbName');
  const pbPlay = el('pbPlayBtn');
  const pbStop = el('pbStopBtn');
  const pbMode = el('pbModeBtn');
  const pbProgress = el('pbProgress');
  const pbTime = el('pbTime');
  const pbClose = el('pbCloseBtn');
  const pbVolume = el('pbVolume');

  function fmtSec(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    return s.toFixed(1);
  }

  // 按钮时长显示：如 "1.0s"，无时长则空白
  function fmtDur(d) {
    if (d == null || !Number.isFinite(d) || d <= 0) return '';
    return `${d.toFixed(1)}s`;
  }

  function updatePlayerUI() {
    const playing = !audioPlayer.paused && !audioPlayer.ended;
    pbPlay.textContent = playing ? '⏸' : '▶';
    const dur = audioPlayer.duration || 0;
    const cur = audioPlayer.currentTime || 0;
    pbProgress.style.width = dur > 0 ? `${(cur / dur) * 100}%` : '0%';
    pbTime.textContent = `${fmtSec(cur)} / ${fmtSec(dur)}s`;
  }

  function showPlayer(btn) {
    currentBtn = btn;
    pbName.textContent = btn.name; // 只显示标题（按键+时长的风格）
    renderModeBtn();
    updatePlayerUI();
    // 控制条目高亮
    document.querySelectorAll('.sound-btn.playing').forEach(c => c.classList.remove('playing'));
    const activeCard = [...document.querySelectorAll('.sound-btn')].find(c => c.querySelector('.sb-name') && c.querySelector('.sb-name').textContent === btn.name);
    if (activeCard) activeCard.classList.add('playing');
  }

  function hidePlayer() {
    currentBtn = null;
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();
    document.querySelectorAll('.sound-btn.playing').forEach(c => c.classList.remove('playing'));
  }

  function renderModeBtn() {
    pbMode.textContent = playMode === 'single' ? '🔂' : '🔁';
    pbMode.classList.toggle('single', playMode === 'single');
    pbMode.title = playMode === 'single' ? '播放模式：单曲循环，点击切换为顺序播放' : '播放模式：顺序播放，点击切换为单曲循环';
  }

  function playSound(btn, card) {
    const src = btn.audio;
    const resume = () => {
      audioPlayer.currentTime = 0;
      audioPlayer.play().then(() => {
        showPlayer(btn);
      }).catch(err => {
        console.warn('[按钮墙] 播放失败:', err);
        toast('音频播放失败');
      });
    };
    if (btn.idb) {
      idbGet(btn.id).then(blob => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          audioPlayer.src = url;
          resume();
        } else {
          toast('音频文件丢失，请重新上传');
        }
      }).catch(() => toast('读取音频失败'));
      return;
    }
    if (!src) {
      toast(`「${btn.name}」还没有音频`);
      return;
    }
    audioPlayer.src = src;
    resume();
  }

  // 播放条事件
  pbPlay.addEventListener('click', () => {
    if (audioPlayer.paused) audioPlayer.play().catch(() => {});
    else audioPlayer.pause();
  });
  pbStop.addEventListener('click', () => {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    updatePlayerUI();
  });
  pbMode.addEventListener('click', () => {
    playMode = playMode === 'single' ? 'sequence' : 'single';
    renderModeBtn();
    toast(playMode === 'single' ? '已切换：单曲循环' : '已切换：顺序播放');
  });
  pbVolume.addEventListener('input', () => {
    audioPlayer.volume = Number(pbVolume.value) / 100;
  });
  pbClose.addEventListener('click', hidePlayer);
  audioPlayer.addEventListener('timeupdate', updatePlayerUI);
  audioPlayer.addEventListener('loadedmetadata', () => {
    updatePlayerUI();
    // 记录当前按钮时长，更新列表里"按键+时长"的显示
    const dur = audioPlayer.duration;
    if (currentBtn && Number.isFinite(dur) && dur > 0) {
      if (currentBtn.duration !== dur) {
        currentBtn.duration = Math.round(dur * 10) / 10;
        saveData(data);
        renderWall();
      }
    }
  });
  audioPlayer.addEventListener('play', updatePlayerUI);
  audioPlayer.addEventListener('pause', updatePlayerUI);
  audioPlayer.addEventListener('ended', () => {
    updatePlayerUI();
    document.querySelectorAll('.sound-btn.playing').forEach(c => c.classList.remove('playing'));
    // 单曲循环时重播当前
    if (playMode === 'single' && currentBtn) {
      audioPlayer.currentTime = 0;
      audioPlayer.play().catch(() => {});
    }
  });
  audioPlayer.volume = 1; // 默认音量

  // ===== 轻提示 =====
  let toastTimer = null;
  function toast(msg) {
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
  function getAdmin() { return DEFAULT_ADMIN; }

  function openAdmin() {
    adminPanel.classList.add('show');
    if (isAdmin) enterAdminMode();
    else showLogin();
  }
  function closeAdmin() { adminPanel.classList.remove('show'); }
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
    initDragZones();
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
      const isOther = cat.id === OTHER_CAT_ID;
      const item = document.createElement('div');
      item.className = 'admin-item';
      item.innerHTML = `
        <span class="nm">${esc(cat.name)}</span>
        <span class="grow"></span>
        ${isOther ? '<span class="ds">默认</span>' : `<button class="btn-x danger" data-del-cat="${cat.id}">删除</button>`}
      `;
      const delBtn = item.querySelector('[data-del-cat]');
      if (delBtn) delBtn.addEventListener('click', () => {
        // 删除分类后，其按钮自动归入"其他"
        let moved = 0;
        data.buttons.forEach(b => { if (b.cat === cat.id) { b.cat = OTHER_CAT_ID; moved++; } });
        data.cats = data.cats.filter(c => c.id !== cat.id);
        // 确保"其他"存在
        if (!data.cats.some(c => c.id === OTHER_CAT_ID)) data.cats.push({ id: OTHER_CAT_ID, name: '其他' });
        saveData(data);
        const msg = moved ? `分类已删除，${moved} 个按钮归入「其他」` : '分类已删除';
        renderWall(); renderCatAdmin(); renderBtnAdmin(); fillCatSelect();
        toast(msg);
      });
      list.appendChild(item);
    });
  }

  // ===== 按钮管理（含上传 + 拖拽改分类）=====
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

  // 按钮管理列表：主/副标题可点击编辑，右侧操作（删除）
  function renderBtnAdmin() {
    const list = el('btnAdminList');
    list.innerHTML = '';
    data.buttons.forEach(btn => {
      const cat = data.cats.find(c => c.id === btn.cat);
      const item = document.createElement('div');
      item.className = 'admin-item btn-admin-item';
      item.draggable = true;
      item.dataset.btnId = btn.id;
      item.innerHTML = `
        <div class="grow">
          <div class="nm" data-edit-name="${btn.id}" title="点击编辑主标题">${esc(btn.name)}</div>
          <div class="ds" data-edit-desc="${btn.id}" title="点击编辑副标题">${btn.desc ? esc(btn.desc) : '＿ 点击编辑副标题'}</div>
        </div>
        <span class="ds">${cat ? cat.name : '?'}</span>
        <span class="ds" data-btn-audio-state="${btn.id}">${btn.idb ? '✓ 已上传' : (btn.audio ? '外部音频' : '未上传')}</span>
        <button class="btn-x danger" data-del-btn="${btn.id}">删除</button>
      `;
      // 点击主标题 → 编辑
      item.querySelector('[data-edit-name]').addEventListener('click', () => {
        const elm = item.querySelector('[data-edit-name]');
        const cur = btn.name;
        const val = prompt('编辑主标题：', cur);
        if (val == null) return;
        const t = val.trim();
        if (!t) { toast('主标题不能为空'); return; }
        btn.name = t;
        saveData(data);
        elm.textContent = t;
        renderWall();
        toast('主标题已更新');
      });
      // 点击副标题 → 编辑
      item.querySelector('[data-edit-desc]').addEventListener('click', () => {
        const elm = item.querySelector('[data-edit-desc]');
        const cur = btn.desc || '';
        const val = prompt('编辑副标题（留空则删除）：', cur);
        if (val == null) return;
        btn.desc = val.trim();
        saveData(data);
        elm.textContent = btn.desc || '＿ 点击编辑副标题';
        renderWall();
        toast('副标题已更新');
      });
      item.querySelector('[data-del-btn]').addEventListener('click', () => {
        if (!confirm(`删除按钮「${btn.name}」？`)) return;
        data.buttons = data.buttons.filter(b => b.id !== btn.id);
        saveData(data);
        idbDel(btn.id);
        renderWall(); renderBtnAdmin(); initDragZones();
      });
      list.appendChild(item);
    });
  }

  // 添加上传音频按钮：点击 → 弹文件选择 → 自动命名主标题 → 加入所选分类
  function uploadBtnAdd() {
    const cat = el('newBtnCat').value;
    if (!cat) { toast('请先选分类'); return; }
    el('newBtnFileInput').click();
  }
  function handleFileToAdd(e) {
    const file = e.target.files[0];
    if (!file) return;
    const isAudio = /audio\//.test(file.type) || /\.(mp3|m4a|wav|ogg|oga|flac|aac|opus)$/i.test(file.name);
    if (!isAudio) { toast('请选择 MP3 等音频文件'); e.target.value = ''; return; }
    const cat = el('newBtnCat').value;
    if (!cat) { toast('请先选分类'); return; }
    // 按文件名自动命名主标题（去掉扩展名）
    const name = file.name.replace(/\.(mp3|m4a|wav|ogg|oga|flac|aac|opus)$/i, '').trim() || '未命名';
    const id = 'btn_' + Date.now();
    const btn = { id, name, desc: '', audio: '', cat, idb: true };
    data.buttons.push(btn);
    idbPut(id, file).then(() => {
      saveData(data);
      renderWall(); renderBtnAdmin(); initDragZones();
      toast(`已添加「${name}」`);
    }).catch(err => {
      console.error('[按钮墙] 上传失败', err);
      // 失败了就回滚
      data.buttons = data.buttons.filter(b => b.id !== id);
      toast('音频上传失败');
    });
    e.target.value = '';
  }

  // ===== 拖拽改分类（拖到分类桶）=====
  // 初始化分类桶 + 绑定按钮列表拖拽事件（每次进入后台调用，可重复，用 once 避免重复监听）
  function initDragZones() {
    const zoneWrap = el('btnCatZones');
    const adminList = el('btnAdminList');
    if (!zoneWrap || !adminList) return;
    zoneWrap.innerHTML = '';
    let dragId = null;

    const renderZones = () => {
      zoneWrap.innerHTML = '';
      data.cats.forEach(cat => {
        const zone = document.createElement('div');
        zone.className = 'cat-zone';
        zone.dataset.cat = cat.id;
        const cnt = data.buttons.filter(b => b.cat === cat.id).length;
        zone.innerHTML = `<span class="zone-name">${esc(cat.name)}</span><span class="zone-count">${cnt ? cnt : ''}</span>`;
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('over'));
        zone.addEventListener('drop', e => {
          e.preventDefault();
          zone.classList.remove('over');
          if (!dragId) return;
          const btn = data.buttons.find(b => b.id === dragId);
          if (btn) {
            btn.cat = cat.id;
            saveData(data);
            renderWall(); renderBtnAdmin(); renderZones();
            toast(`「${btn.name}」已移到「${cat.name}」`);
          }
          dragId = null;
        });
        zoneWrap.appendChild(zone);
      });
    };

    // 用 once 绑定，避免重复进后台叠加监听
    adminList.ondragstart = e => {
      const item = e.target.closest('.btn-admin-item');
      if (!item) return;
      dragId = item.dataset.btnId;
      item.classList.add('dragging');
    };
    adminList.ondragend = () => {
      document.querySelectorAll('.btn-admin-item.dragging').forEach(i => i.classList.remove('dragging'));
      zoneWrap.querySelectorAll('.cat-zone').forEach(z => z.classList.remove('over'));
      dragId = null;
    };

    renderZones();
  }

  // 保存：把当前 data 持久化（分类/按钮/拖拽结果已即时保存，这里做完整保存提示）
  function saveAll() {
    saveData(data);
    initDragZones();
    renderWall();
    toast('已保存');
  }

  // ===== 事件绑定 =====
  el('adminLoginBtn').addEventListener('click', openAdmin);
  el('loginBtn').addEventListener('click', doLogin);
  el('cancelLoginBtn').addEventListener('click', showLogin);
  el('logoutBtn').addEventListener('click', logout);
  el('closeAdminBtn').addEventListener('click', closeAdmin);
  el('addCatBtn').addEventListener('click', addCat);
  el('uploadBtnBtn').addEventListener('click', uploadBtnAdd);
  el('newBtnFileInput').addEventListener('change', handleFileToAdd);
  el('saveAdminBtn').addEventListener('click', saveAll);
  adminPanel.addEventListener('click', e => {
    if (e.target === adminPanel) closeAdmin();
  });
  el('loginUser').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  el('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  function addCat() {
    const name = el('newCatName').value.trim();
    if (!name) { toast('请输入分类名'); return; }
    const id = 'cat_' + Date.now();
    data.cats.push({ id, name });
    saveData(data);
    el('newCatName').value = '';
    renderWall(); renderCatAdmin(); fillCatSelect();
    initDragZones();
    toast('分类已添加');
  }

  // ===== 初始化 =====
  renderWall();
})();
