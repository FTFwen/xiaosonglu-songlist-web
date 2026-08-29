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
            <div class="sb-idx">${bi + 1}</div>
            <div class="sb-main">
              <div class="sb-name">${esc(btn.name)}</div>
              ${btn.desc ? `<div class="sb-desc">${esc(btn.desc)}</div>` : ''}
            </div>
            <div class="sb-play">▶</div>
            <div class="bar"></div>
          `;
          card.addEventListener('click', () => playSound(btn, card));
          listWrap.appendChild(card);
        });
      }
      section.appendChild(listWrap);
      wall.appendChild(section);
    });
  }

  // ===== 播放音效 =====
  function playSound(btn, card) {
    const src = btn.audio;
    const resume = () => {
      audioPlayer.currentTime = 0;
      audioPlayer.play().then(() => {
        card.classList.add('playing');
        const bar = card.querySelector('.bar');
        if (bar) bar.style.width = '100%';
        audioPlayer.onended = () => {
          card.classList.remove('playing');
          if (bar) bar.style.width = '0%';
        };
      }).catch(err => {
        console.warn('[按钮墙] 播放失败:', err);
        toast('音频播放失败');
      });
    };
    // 优先播放 IndexedDB 里上传的音频
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

  // 新增按钮的上传入口：绑定到 addBtn 区域的文件选择
  function attachUpload(input, id) {
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      if (!/audio\/(mpeg|mp3|wav|ogg|flac|x-m4a)/.test(file.type) && !/\.(mp3|m4a|wav|ogg|flac)$/i.test(file.name)) {
        toast('请选择 MP3/音频文件');
        return;
      }
      try {
        await idbPut(id, file);
        toast('音频已上传');
        input.value = '';
        // 更新按钮状态标记（如有对应编辑项）
        paintBtnAudioState(id, true);
      } catch (e) {
        console.error('[按钮墙] 上传失败', e);
        toast('音频上传失败');
      }
    });
  }

  function paintBtnAudioState(id, has) {
    document.querySelectorAll(`[data-btn-audio-state="${id}"]`).forEach(elm => {
      elm.textContent = has ? '✓ 已上传' : '未上传';
      elm.classList.toggle('has', !!has);
    });
  }

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
        <span class="nm">${esc(btn.name)}</span>
        <span class="ds">${cat ? cat.name : '?'}</span>
        <span class="grow"></span>
        <span class="ds" data-btn-audio-state="${btn.id}">${btn.idb ? '✓ 已上传' : (btn.audio ? '外部音频' : '未上传')}</span>
        <input type="file" accept="audio/*,.mp3" class="btn-x audio-upload" data-audio-upload="${btn.id}" title="上传/替换音频">
        <button class="btn-x danger" data-del-btn="${btn.id}">删除</button>
      `;
      item.querySelector('[data-del-btn]').addEventListener('click', () => {
        if (!confirm(`删除按钮「${btn.name}」？`)) return;
        data.buttons = data.buttons.filter(b => b.id !== btn.id);
        saveData(data);
        idbDel(btn.id);
        renderWall(); renderBtnAdmin();
      });
      item.querySelector('[data-audio-upload]').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          await idbPut(btn.id, file);
          btn.idb = true;
          saveData(data);
          toast('音频已上传');
          paintBtnAudioState(btn.id, true);
        } catch (err) {
          console.error('[按钮墙] 上传失败', err);
          toast('音频上传失败');
        }
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
    const id = 'btn_' + Date.now();
    data.buttons.push({ id, name, desc, audio, cat, idb: false });
    saveData(data);
    el('newBtnName').value = '';
    el('newBtnDesc').value = '';
    el('newBtnAudio').value = '';
    renderWall(); renderBtnAdmin();
    toast('按钮已添加（可在列表上传音频）');
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
  el('addBtnBtn').addEventListener('click', addBtn);
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
