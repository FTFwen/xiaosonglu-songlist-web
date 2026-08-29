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
      section.dataset.cat = cat.id;

      // 编辑模式下：分类区块作为拖拽目标（磁贴拖到这里改分类）
      section.addEventListener('dragover', e => { if (editMode) { e.preventDefault(); section.classList.add('drop-target'); } });
      section.addEventListener('dragleave', () => section.classList.remove('drop-target'));
      section.addEventListener('drop', e => {
        e.preventDefault();
        section.classList.remove('drop-target');
        if (!editMode) return;
        const btnId = e.dataTransfer.getData('text/plain');
        if (!btnId) return;
        const btn = data.buttons.find(b => b.id === btnId);
        if (btn && btn.cat !== cat.id) {
          btn.cat = cat.id;
          saveData(data);
          renderWall();
          toast(`「${btn.name}」已移到「${cat.name}」`);
        }
      });

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
          card.dataset.btnId = btn.id;
          card.innerHTML = `
            <div class="sb-main">
              <div class="sb-name">${esc(btn.name)}</div>
              ${btn.desc ? `<div class="sb-desc">${esc(btn.desc)}</div>` : ''}
              <div class="sb-dur">${fmtDur(btn.duration)}</div>
            </div>
            <span class="sb-del" data-del-item="${btn.id}" title="删除" style="display:none;"><svg class="icon" aria-hidden="true"><use href="#icon-close"></use></svg></span>
          `;
          card.addEventListener('click', e => {
            if (e.target.closest('.sb-del')) return; // 点删除交给删除处理
            if (editMode) {
              openEditPopup(btn.id); // 编辑模式下点击 → 弹窗编辑标题/副标题
            } else {
              playSound(btn, card);
            }
          });
          // 删除按钮
          card.querySelector('[data-del-item]').addEventListener('click', () => {
            if (!editMode) return;
            if (!confirm(`删除「${btn.name}」？`)) return;
            data.buttons = data.buttons.filter(b => b.id !== btn.id);
            idbDel(btn.id);
            saveData(data);
            renderWall();
            toast('已删除');
          });
          // 编辑模式下磁贴可拖拽（改分类）
          card.draggable = editMode;
          card.addEventListener('dragstart', e => {
            if (!editMode) return;
            e.dataTransfer.setData('text/plain', btn.id);
            card.classList.add('drag-src');
          });
          card.addEventListener('dragend', () => card.classList.remove('drag-src'));
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
  let editMode = false;     // 是否编辑模式（管理员）
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

  // 生成 Ant Design 线性图标（与主站一致，跟随 currentColor）
  function ico(id) {
    return `<svg class="icon" aria-hidden="true"><use href="#icon-${id}"></use></svg>`;
  }

  function updatePlayerUI() {
    const playing = !audioPlayer.paused && !audioPlayer.ended;
    pbPlay.innerHTML = playing ? ico('pause') : ico('caret-right');
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
    pbMode.innerHTML = playMode === 'single' ? ico('retweet') : ico('sync');
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
      updateAdminUI();
      toast('登录成功');
    } else {
      el('authErr').textContent = '用户名或密码错误';
    }
  }

  function logout() {
    isAdmin = false;
    sessionStorage.removeItem('xsl:buttons:authed');
    showLogin();
    exitEditMode(false); // 退出编辑模式
    updateAdminUI();
    toast('已退出登录');
  }

  // 登录态 UI：显示右下角编辑模式入口
  function updateAdminUI() {
    const float = el('editFloat');
    if (isAdmin) float.style.display = 'flex';
    else float.style.display = 'none';
    renderEditButtons();
  }

  // ===== 编辑模式（管理员主界面） =====
  function renderEditButtons() {
    if (!isAdmin) return;
    el('editModeBtn').style.display = editMode ? 'none' : '';
    el('editSaveBtn').style.display = editMode ? '' : 'none';
    el('editCancelBtn').style.display = editMode ? '' : 'none';
    el('editModeBtn').textContent = editMode ? '' : '✏️ 编辑模式';
  }

  function enterEditMode() {
    if (!isAdmin) return;
    editMode = true;
    document.body.classList.add('editing');
    closeAdmin();
    renderWall();
    renderEditButtons();
    toast('编辑模式：拖动磁贴改分类，点磁贴改标题/副标题，右上角✕删除');
  }

  function exitEditMode(save) {
    if (save) { saveData(data); toast('已保存'); }
    else { data = loadData(); } // 不保存 → 从存储重载
    editMode = false;
    document.body.classList.remove('editing');
    renderWall();
    renderEditButtons();
  }

  // 编辑弹窗：同时编辑标题 + 副标题
  let editingBtnId = null;
  function openEditPopup(btnId) {
    const btn = data.buttons.find(b => b.id === btnId);
    if (!btn) return;
    editingBtnId = btnId;
    el('editNameInput').value = btn.name || '';
    el('editDescInput').value = btn.desc || '';
    el('editPopup').style.display = 'flex';
    el('editNameInput').focus();
  }

  function closeEditPopup() {
    el('editPopup').style.display = 'none';
    editingBtnId = null;
  }

  function confirmEditPopup() {
    if (!editingBtnId) return;
    const btn = data.buttons.find(b => b.id === editingBtnId);
    if (btn) {
      const name = el('editNameInput').value.trim();
      if (!name) { toast('主标题不能为空'); return; }
      btn.name = name;
      btn.desc = el('editDescInput').value.trim();
      saveData(data);
      renderWall();
    }
    closeEditPopup();
    toast('已更新');
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
        renderWall(); renderCatAdmin();  fillCatSelect();
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
  

  // 添加上传音频按钮：点击 → 弹文件选择 → 自动命名主标题 → 加入所选分类
  function uploadBtnAdd() {
    const cat = el('newBtnCat').value;
    if (!cat) { toast('请先选分类'); return; }
    el('newBtnFileInput').click();
  }

  // 音频扩展名判断（含 zip）
  // 可播放的音/视频扩展名（MP4/MOV 等视频导入后当音频播放，只出声）
  const AUDIO_SFX = /\.(mp3|m4a|wav|ogg|oga|flac|aac|opus|mp4|m4v|mov|webm|mkv)$/i;

  // 读取音频/视频 blob 的时长（用 video 元素，兼容 mp3/mp4 等）
  function readDuration(blob) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      v.preload = 'metadata';
      let done = false;
      const finish = dur => { if (!done) { done = true; URL.revokeObjectURL(url); resolve(dur); } };
      v.onloadedmetadata = () => finish(Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration * 10) / 10 : 0);
      v.onerror = () => finish(0);
      v.src = url;
      setTimeout(() => finish(0), 8000); // 兜底
    });
  }

  // 把单个音频 blob 加为按钮（按文件名自动命名）
  async function addAudioBtn(name, blob, cat) {
    const cleanName = name.replace(AUDIO_SFX, '').trim() || '未命名';
    const id = 'btn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const dur = await readDuration(blob);
    const btn = { id, name: cleanName, desc: '', audio: '', cat, idb: true, duration: dur };
    data.buttons.push(btn);
    await idbPut(id, blob);
    return { id, name: cleanName, duration: dur };
  }

  // 处理选中的文件：普通音频直接加；zip 解压后筛出音频加
  async function handleFileToAdd(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const cat = el('newBtnCat').value;
    if (!cat) { toast('请先选分类'); return; }

    let added = 0;
    let skipped = 0;

    for (const file of files) {
      try {
        const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
        if (isZip) {
          // 解压 zip：遍历所有条目，筛出音频文件
          const zip = await JSZip.loadAsync(file);
          const entries = Object.values(zip.files);
          for (const entry of entries) {
            if (entry.dir) continue;
            const n = entry.name.split('/').pop();
            if (!AUDIO_SFX.test(n)) { skipped++; continue; } // 非音频舍去
            const blob = await entry.async('blob');
            await addAudioBtn(n, blob, cat);
            added++;
          }
        } else if (AUDIO_SFX.test(file.name) || /^audio\//.test(file.type)) {
          await addAudioBtn(file.name, file, cat);
          added++;
        } else {
          skipped++; // 非音频文件舍去
        }
      } catch (err) {
        console.error('[按钮墙] 处理失败:', file.name, err);
        skipped++;
      }
    }

    saveData(data);
    renderWall();  

    if (added) toast(`已添加 ${added} 个按钮${skipped ? `，舍去 ${skipped} 个非音频` : ''}`);
    else toast(`没有可导入的音频（共舍去 ${skipped} 个文件）`);
    e.target.value = '';
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
  adminPanel.addEventListener('click', e => {
    if (e.target === adminPanel) closeAdmin();
  });
  el('loginUser').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  el('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // 编辑模式：右下角按钮
  el('editModeBtn').addEventListener('click', enterEditMode);
  el('editSaveBtn').addEventListener('click', () => exitEditMode(true));
  el('editCancelBtn').addEventListener('click', () => exitEditMode(false));
  // 编辑弹窗
  el('editOkBtn').addEventListener('click', confirmEditPopup);
  el('editCancelPopupBtn').addEventListener('click', closeEditPopup);
  el('editPopup').addEventListener('click', e => { if (e.target === el('editPopup')) closeEditPopup(); });

  function addCat() {
    const name = el('newCatName').value.trim();
    if (!name) { toast('请输入分类名'); return; }
    const id = 'cat_' + Date.now();
    data.cats.push({ id, name });
    saveData(data);
    el('newCatName').value = '';
    renderWall(); renderCatAdmin(); fillCatSelect();
    toast('分类已添加');
  }

  // ===== 初始化 =====
  // 若已登录（会话保持），显示编辑模式入口
  if (isAdmin) updateAdminUI();
  renderWall();
})();
