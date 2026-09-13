/* 歌曲评分（js/rating.js）
 *
 * 卡片右下角两行只负责“显示”：第一行是全站平均分（附人数），第二行是自己的评分。
 * 打分不在卡片上直接点——那里太小了——而是点「打分 / 改分」弹出一个小面板，在面板里点星星，
 * 点完立即提交到服务器并刷新卡片；随时可以再点开修改，或清除自己的评分。
 *
 * 访客身份由服务端按 CF-Connecting-IP 哈希区分（/api/rating/song），
 * 前端只负责展示与提交，不自己决定分片键。
 * 该文件同时服务 index.html 在线访问与 file:// 离线预览，因此不依赖任何构建步骤。
 */
(function () {
  'use strict';

  const API_BASE = '/api/rating/song';
  const STAR_COUNT = 5;
  const SCORE_PER_STAR = 2;
  const MAX_KEYS_PER_REQUEST = 64;
  const MAX_SUBMIT_RETRIES = 3;
  const OBSERVER_ROOT_MARGIN = '320px';
  const POPOVER_GAP = 6;
  const POPOVER_MARGIN = 10;
  const HINT_IDLE = '我来打分';
  const HINT_UNIDENTIFIED = '这次认不出你，暂时不能打分';
  const HINT_OFFLINE = '离线预览不评分';
  const HINT_SAVING = '保存中…';

  const entryCache = new Map();  // songKey -> { average, count, own, identified, loaded, pending, error }
  const inflight = new Map();    // requestKey -> Promise
  const submitQueue = new Map(); // songKey -> Promise
  const tracked = new WeakSet(); // 已交给 IntersectionObserver 的卡片

  let observer = null;
  let offline = false;
  let flushScheduled = false;
  let popover = null;            // { el, card, songKey, preview, busy, identified, error, lastFocus }

  /* ---------- 哈希：与后端一致，仅用于校验分片 ---------- */

  function hashSongKey(value) {
    const text = String(value == null ? '' : value);
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return hash >>> 0;
  }

  function ratingBucketOf(songKey) {
    return hashSongKey(songKey) % 16;
  }

  /* ---------- 星级图标 ---------- */

  // 自己画的五角星（24×24 视口，外接半径 10.2 / 内径 4.9 —— 圆润饱满，接近常见星级图标的观感）。
  // 半颗星是真正的「半边星」：左右两个半边各自成闭合路径，左半边正好是整颗的 50.0000% 面积。
  // 路径直接内联，不依赖 index.html 的图标 sprite，也不依赖 clip-path / 蒙版 / 叠加裁切。
  const STAR_FULL_PATH = 'M12 2.2L14.88 8.44L21.7 9.25L16.66 13.91L18 20.65L12 17.3L6 20.65L7.34 13.91L2.3 9.25L9.12 8.44Z';
  const STAR_LEFT_PATH = 'M12 2.2L9.12 8.44L2.3 9.25L7.34 13.91L6 20.65L12 17.3L12 12.4Z';
  const STAR_RIGHT_PATH = 'M12 2.2L14.88 8.44L21.7 9.25L16.66 13.91L18 20.65L12 17.3L12 12.4Z';

  function starSvg(body, className) {
    return '<svg class="rating-star-shape' + (className ? ' ' + className : '') + '" viewBox="0 0 24 24" aria-hidden="true">'
      + body + '</svg>';
  }

  // 每颗星按得分取三种状态：0 分空星、满 2 分满星、1 分半星（共用同一套路径，所以一定对得齐）。
  function starIconMarkup(score, starIndex) {
    const got = (Number(score) || 0) - starIndex * SCORE_PER_STAR;
    if (got <= 0) return starSvg('<path d="' + STAR_FULL_PATH + '"></path>', 'is-empty');
    if (got >= SCORE_PER_STAR) return starSvg('<path d="' + STAR_FULL_PATH + '"></path>', 'is-full');
    return starSvg('<path d="' + STAR_LEFT_PATH + '"></path><path d="' + STAR_RIGHT_PATH + '"></path>', 'is-half');
  }

  // 往容器里画满 5 颗星；pickable 时每颗星拆成左（半颗=1 分）右（整颗=2 分）两个判分热区，只用在弹窗里。
  // label 为空就不画标签（弹窗里不需要）；卡片和播放栏都传「均分 / 我的」。
  function paintStars(container, score, pickable, label) {
    if (!container) return;
    let html = label ? '<span class="rating-label">' + label + '</span>' : '';
    for (let i = 0; i < STAR_COUNT; i++) {
      const on = (Number(score) || 0) > i * SCORE_PER_STAR ? ' is-on' : '';
      if (!pickable) {
        html += '<span class="rating-star' + on + '">' + starIconMarkup(score, i) + '</span>';
        continue;
      }
      const halfScore = i * SCORE_PER_STAR + 1;
      const fullScore = (i + 1) * SCORE_PER_STAR;
      html += '<button type="button" class="rating-star is-pick' + on + '"'
        + ' data-rating-half="' + halfScore + '" data-rating-full="' + fullScore + '"'
        + ' aria-label="' + halfScore + ' 分">'
        + '<span class="rating-star-hit half" data-rating-half="' + halfScore + '" aria-hidden="true"></span>'
        + '<span class="rating-star-hit full" data-rating-full="' + fullScore + '" aria-hidden="true"></span>'
        + starIconMarkup(score, i)
        + '</button>';
    }
    container.innerHTML = html;
  }

  /* ---------- 缓存 ---------- */

  function cacheEntry(songKey, patch) {
    const next = Object.assign({
      average: 0,
      count: 0,
      own: 0,
      identified: true,
      loaded: false,
      pending: false,
      error: '',
    }, entryCache.get(songKey) || {}, patch || {});
    entryCache.set(songKey, next);
    if (entryCache.size > 400) {
      const oldest = entryCache.keys().next().value;
      if (oldest !== undefined && oldest !== songKey) entryCache.delete(oldest);
    }
    return next;
  }

  /* ---------- 卡片（只显示 + 一个打开面板的按钮） ---------- */

  function songKeyOfCard(el) {
    return String(el.getAttribute('data-rating-key') || '').replace(/\s+/g, ' ').trim();
  }

  function songNameOfCard(el) {
    return String(el.getAttribute('data-rating-name') || '') || songKeyOfCard(el);
  }

  function cardMarkup() {
    return '<div class="song-rating" data-rating-root>'
      + '<div class="rating-line rating-average" data-rating-average>'
      + '<span class="rating-stars"></span>'
      + '<span class="rating-avg-text">读取中…</span>'
      + '</div>'
      + '<div class="rating-line rating-own">'
      + '<button type="button" class="rating-open" data-rating-open>'
      + '<span class="rating-stars"></span>'
      + '<span class="rating-own-text"></span>'
      + '</button>'
      + '</div>'
      + '</div>';
  }

  // 播放栏空状态：两行空星骨架，不写任何提示文案（「均分 / 我的」标签仍由 renderCard 决定）
  function playerIdleMarkup() {
    return cardMarkup().replace('class="song-rating"', 'class="song-rating is-idle"')
      .replace('<span class="rating-avg-text">读取中…</span>', '<span class="rating-avg-text"></span>');
  }

  // 评分控件的挂载点：卡片是 [data-rating-host] 子元素；播放栏本身就是 data-rating-root。
  function ratingRootOf(el) {
    const child = el.querySelector('[data-rating-host]');
    if (child) {
      if (!child.querySelector('[data-rating-root]')) child.innerHTML = cardMarkup();
      return child.querySelector('[data-rating-root]');
    }
    if (el.hasAttribute('data-rating-root')) return el;
    return null;
  }

  function ensureCard(el) {
    if (!ratingRootOf(el)) return false;
    renderCard(el);
    return true;
  }

  function renderCard(el) {
    if (!el.isConnected) return;
    const songKey = songKeyOfCard(el);
    const entry = entryCache.get(songKey) || cacheEntry(songKey, offline ? { loaded: true, error: HINT_OFFLINE } : {});
    const averageLine = el.querySelector('[data-rating-average]');
    const ownBtn = el.querySelector('[data-rating-open]');
    if (!averageLine || !ownBtn) return;

    // 播放栏比卡片窄得多：只精简文案（没分数/没评分时不写字），标签和星星跟卡片一致
    const compact = el.hasAttribute('data-rating-compact');
    const count = Number(entry.count) || 0;
    const averageScore = count > 0 ? Number(entry.average) || 0 : 0;
    paintStars(averageLine.querySelector('.rating-stars'), averageScore, false, '均分');
    const avgText = averageLine.querySelector('.rating-avg-text');
    if (entry.error) {
      avgText.textContent = compact ? '—' : entry.error;
      avgText.removeAttribute('title');
    } else if (!entry.loaded) {
      avgText.textContent = offline ? '离线预览' : compact ? '' : '读取中…';
      avgText.removeAttribute('title');
    } else if (count <= 0) {
      // 播放栏没分数就只留「均分」和空星，不占文案
      avgText.textContent = compact ? '' : '还没有人打分';
      avgText.removeAttribute('title');
    } else {
      avgText.textContent = compact
        ? averageScore.toFixed(1)
        : averageScore.toFixed(1) + ' 分 · ' + count + ' 人';
      avgText.title = '平均 ' + averageScore.toFixed(2) + ' 分（' + count + ' 人评分）';
    }

    const own = Number(entry.own) || 0;
    const pickable = canRate(entry);
    const ownText = ownBtn.querySelector('.rating-own-text');
    paintStars(ownBtn.querySelector('.rating-stars'), own, false, '我的');
    ownBtn.classList.toggle('is-scored', own > 0);
    ownBtn.classList.toggle('is-busy', !!entry.pending);
    ownBtn.classList.toggle('is-locked', !pickable);
    ownBtn.disabled = !pickable;
    ownBtn.title = pickable
      ? (own > 0 ? '点击修改我的评分' : '点击给小松绿打分')
      : (offline ? HINT_OFFLINE : entry.error ? entry.error : HINT_UNIDENTIFIED);
    // 打分中显示省略号（两处都一样，播放栏更短）
    if (entry.pending) ownText.textContent = '…';
    else if (own > 0) ownText.textContent = own + ' 分';
    else ownText.textContent = compact ? '' : (pickable ? HINT_IDLE : offline ? HINT_OFFLINE : '不能打分');

    if (popover && popover.songKey === songKey) {
      syncPopover();
      positionPopover();
    }
  }

  function canRate(entry) {
    return !offline && !!entry && entry.identified !== false;
  }

  function renderAllForKey(songKey) {
    cardContainersForKey(songKey).forEach(function (el) {
      renderCard(el);
    });
    const playerHost = playerRatingEl();
    if (playerHost && songKeyOfCard(playerHost) === songKey) renderCard(playerHost);
    // 播放器栏上的评分也跟着刷新（它可能正显示这首歌）
    if (popover && popover.songKey === songKey) {
      syncPopover();
      positionPopover();
    }
  }

  // 同一首歌会有多个评分容器：列表里的卡片 + 底部播放栏。
  function cardContainersForKey(songKey) {
    return document.querySelectorAll('.song-item[data-rating-key="' + cssEscape(songKey) + '"]');
  }

  function playerRatingEl() {
    return document.getElementById('playerRatingHost');
  }

  // 弹窗要贴着触发它的那个容器显示（卡片可能已经滚出视口，就用播放栏兜底）。
  function popoverAnchorOf(songKey) {
    const cards = cardContainersForKey(songKey);
    if (cards.length) return cards[0];
    const playerHost = playerRatingEl();
    return playerHost && songKeyOfCard(playerHost) === songKey ? playerHost : null;
  }

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  /* ---------- 数据获取 ---------- */

  function applyPayload(payload) {
    const items = payload && payload.items && typeof payload.items === 'object' ? payload.items : null;
    const identified = payload ? payload.identified !== false : true;
    if (!items) return;
    Object.keys(items).forEach(function (songKey) {
      const item = items[songKey] || {};
      const average = item.average || {};
      cacheEntry(songKey, {
        average: Number(average.average) || 0,
        count: Number(average.count) || 0,
        own: Number(item.own) || 0,
        identified: identified,
        loaded: true,
        pending: false,
        error: '',
      });
      renderAllForKey(songKey);
    });
  }

  // 同一分片的歌曲合并成一次 GET，避免卡片多了以后请求爆炸。
  function fetchKeys(keys) {
    if (!keys.length) return Promise.resolve(null);
    const requestKey = keys.slice().sort().join('\u0000');
    if (inflight.has(requestKey)) return inflight.get(requestKey);
    const url = new URL(API_BASE, location.href);
    keys.forEach(function (key) { url.searchParams.append('key', key); });
    const promise = (async function () {
      const response = await fetch(url.toString(), { cache: 'no-store' });
      if (!response.ok) throw new Error('http ' + response.status);
      const payload = await response.json();
      applyPayload(payload);
      return payload;
    })();
    inflight.set(requestKey, promise);
    promise.catch(function () {}).then(function () { inflight.delete(requestKey); });
    return promise;
  }

  /* ---------- 全量读取（「按评分排序」用） ----------
     卡片是懒加载的，entries 里只有可见歌曲的评分；按评分排序需要先把整份歌单的
     评分批量取回来。按分片分组、每个分片一次 GET（上限 64 个 key），
     分片之间限制并发，避免一瞬间打出十几个请求。 */
  const ALL_BUCKET_CONCURRENCY = 3;
  let allLoadPromise = null;

  function allRatingKeys() {
    const keys = [];
    document.querySelectorAll('.song-item[data-rating-key]').forEach(function (el) {
      const songKey = songKeyOfCard(el);
      if (songKey) keys.push(songKey);
    });
    return keys;
  }

  // force=true 时重新拉取（例如用户改完分想重新按评分排序）。
  // 成功后必须**保住**这个 Promise 的缓存：调用方（按评分排序）会在数据到齐后重排，
  // 重排又会调用 loadAll，如果此时缓存被清空就会「拉取 → 重排 → 又拉取」无限循环。
  function loadAll(force) {
    if (!force && allLoadPromise) return allLoadPromise;
    if (offline) { allLoadPromise = Promise.resolve(0); return allLoadPromise; }

    const keys = allRatingKeys();
    const byBucket = new Map();
    keys.forEach(function (songKey) {
      const bucket = ratingBucketOf(songKey);
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket).push(songKey);
    });

    const tasks = [];
    byBucket.forEach(function (bucketKeys) {
      for (let i = 0; i < bucketKeys.length; i += MAX_KEYS_PER_REQUEST) {
        tasks.push(bucketKeys.slice(i, i + MAX_KEYS_PER_REQUEST));
      }
    });

    const promise = (async function () {
      let index = 0;
      let loaded = 0;
      async function worker() {
        while (index < tasks.length) {
          const chunk = tasks[index];
          index += 1;
          try {
            await fetchKeys(chunk);
            loaded += chunk.length;
          } catch (error) {
            // 单块失败不阻断整体：这一批按 0 分处理，排序会把它放到最后
            chunk.forEach(function (songKey) {
              cacheEntry(songKey, { loaded: true, error: '评分暂时读不到' });
            });
          }
        }
      }
      const workers = [];
      for (let i = 0; i < Math.min(ALL_BUCKET_CONCURRENCY, tasks.length); i += 1) workers.push(worker());
      await Promise.all(workers);
      return loaded;
    })();

    allLoadPromise = promise;
    // 只在失败时放开重试；成功的结果一直留着复用
    promise.catch(function () {
      if (allLoadPromise === promise) allLoadPromise = null;
    });
    return promise;
  }

  // 同步读取某首歌的均分（必须先 await loadAll()，否则可能拿到 0）
  function averageOf(songKey) {
    const entry = entryCache.get(String(songKey || '').trim());
    if (!entry || !entry.loaded || !Number(entry.count)) return 0;
    return Number(entry.average) || 0;
  }

  function countOf(songKey) {
    const entry = entryCache.get(String(songKey || '').trim());
    return entry && entry.loaded ? Number(entry.count) || 0 : 0;
  }

  function flush() {
    const pending = [];
    document.querySelectorAll('.song-item[data-rating-key][data-rating-visible]').forEach(function (el) {
      const songKey = songKeyOfCard(el);
      if (!songKey || el.dataset.ratingLoaded) return;
      el.dataset.ratingLoaded = '1';
      const entry = entryCache.get(songKey);
      if (entry && entry.loaded) { renderCard(el); return; }
      pending.push(songKey);
    });
    if (!pending.length) return;

    const byBucket = new Map();
    pending.forEach(function (songKey) {
      const bucket = ratingBucketOf(songKey);
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket).push(songKey);
    });
    byBucket.forEach(function (keys) {
      for (let i = 0; i < keys.length; i += MAX_KEYS_PER_REQUEST) {
        const chunk = keys.slice(i, i + MAX_KEYS_PER_REQUEST);
        fetchKeys(chunk).catch(function () {
          chunk.forEach(function (songKey) {
            cacheEntry(songKey, { loaded: true, error: '平均分暂时读不到' });
            renderAllForKey(songKey);
          });
        });
      }
    });
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    const run = function () { flushScheduled = false; flush(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /* ---------- 提交评分 ---------- */

  function submitErrorText(status, payload) {
    const code = payload && payload.error ? String(payload.error) : '';
    if (status === 429) return '点得有点快，等一下再打分呀';
    if (code === 'cannot identify client ip') return '这次认不出你，换个网络再试试';
    return '打分没保存上，请再试一次';
  }

  // 服务端的「多人同时打分」冲突是暂时性的，客户端再补两次：
  // 明细已经落盘时重试等价于幂等补偿，不会重复计数。
  function isRetryable(status, payload) {
    if (status !== 409) return true; // 网络类失败也值得重试
    const code = payload && payload.error ? String(payload.error) : '';
    return code.indexOf('busy') >= 0 || code.indexOf('conflict') >= 0;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function putScoreOnce(songKey, score, confirmRemove) {
    let response;
    try {
      response = await fetch(API_BASE, {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: songKey, score: score, confirmRemove: confirmRemove === true }),
      });
    } catch (error) {
      return { ok: false, retryable: true, message: '网络不太好，打分没保存上' };
    }
    let payload = null;
    try { payload = await response.json(); } catch (error) { payload = null; }
    if (!response.ok) {
      return { ok: false, retryable: isRetryable(response.status, payload), message: submitErrorText(response.status, payload) };
    }
    const average = payload && payload.average ? payload.average : {};
    return {
      ok: true,
      average: Number(average.average) || 0,
      count: Number(average.count) || 0,
      own: Number(payload && payload.own) || 0,
    };
  }

  async function putScore(songKey, score, confirmRemove) {
    let result = await putScoreOnce(songKey, score, confirmRemove);
    for (let attempt = 1; attempt <= MAX_SUBMIT_RETRIES && !result.ok && result.retryable; attempt++) {
      await delay(300 * attempt);
      result = await putScoreOnce(songKey, score, confirmRemove);
    }
    return result;
  }

  // 同一首歌的提交串行化：连着点星星时按顺序落库，不会互相覆盖。
  function applyScore(songKey, score, confirmRemove) {
    cacheEntry(songKey, { pending: true, error: '' });
    renderAllForKey(songKey);
    const previous = submitQueue.get(songKey) || Promise.resolve();
    const run = function () { return putScore(songKey, score, confirmRemove); };
    const task = previous.then(run, run);
    submitQueue.set(songKey, task.catch(function () {}));
    return task.then(function (result) {
      if (result.ok) {
        cacheEntry(songKey, {
          average: result.average, count: result.count, own: result.own,
          loaded: true, pending: false, error: '',
        });
      } else {
        cacheEntry(songKey, { pending: false, error: result.message });
      }
      renderAllForKey(songKey);
      return result;
    });
  }

  function showToast(message) {
    if (!message) return;
    let box = document.getElementById('rating-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'rating-toast';
      box.className = 'rating-toast';
      box.setAttribute('role', 'status');
      document.body.appendChild(box);
    }
    box.textContent = message;
    box.classList.add('is-show');
    clearTimeout(box._timer);
    box._timer = setTimeout(function () { box.classList.remove('is-show'); }, 2600);
  }

  /* ---------- 打分面板（弹窗） ---------- */

  function popoverMarkup() {
    return '<div class="rating-pop" role="dialog" aria-label="给这首歌打分">'
      + '<div class="rating-pop-head">'
      + '<span class="rating-pop-name" data-rating-title></span>'
      + '<button type="button" class="rating-pop-close" data-rating-close aria-label="关闭">×</button>'
      + '</div>'
      + '<div class="rating-pop-stars" data-rating-pop-stars></div>'
      + '<div class="rating-pop-row">'
      + '<span class="rating-pop-value" data-rating-pop-value></span>'
      + '<span class="rating-pop-avg" data-rating-pop-avg></span>'
      + '</div>'
      + '<div class="rating-pop-foot">'
      + '<span class="rating-pop-hint" data-rating-pop-hint>点星星打分，随时可改</span>'
      + '<button type="button" class="rating-pop-clear" data-rating-pop-clear>清除评分</button>'
      + '</div>'
      + '</div>';
  }

  function openPopover(anchor) {
    if (!anchor || !anchor.isConnected || offline) return;
    const songKey = songKeyOfCard(anchor);
    const entry = entryCache.get(songKey);
    if (!canRate(entry)) return;

    closePopover(true);
    const el = document.createElement('div');
    el.className = 'rating-pop-layer';
    el.innerHTML = popoverMarkup();
    document.body.appendChild(el);

    popover = {
      el: el,
      anchor: anchor,
      songKey: songKey,
      preview: 0,
      busy: false,
      error: '',
      lastFocus: document.activeElement,
    };
    syncPopover();
    positionPopover();

    const current = Number(entry.own) || 0;
    const stars = el.querySelectorAll('.rating-pop-stars .rating-star.is-pick');
    const target = stars[current > 0 ? Math.floor((current - 1) / SCORE_PER_STAR) : 0];
    if (target && typeof target.focus === 'function') {
      try { target.focus({ preventScroll: true }); } catch (error) { target.focus(); }
    }
  }

  function syncPopover() {
    if (!popover) return;
    const el = popover.el;
    const entry = entryCache.get(popover.songKey) || cacheEntry(popover.songKey, {});
    const own = Number(entry.own) || 0;
    const shown = popover.preview || own;

    const title = el.querySelector('[data-rating-title]');
    if (title) title.textContent = songNameOfCard(popover.anchor) || popover.songKey;

    const starsWrap = el.querySelector('[data-rating-pop-stars]');
    if (!popover.busy) paintStars(starsWrap, shown, true);
    else starsWrap.classList.add('is-busy');
    el.classList.toggle('is-busy', popover.busy);

    const value = el.querySelector('[data-rating-pop-value]');
    if (popover.error) value.textContent = popover.error;
    else if (popover.busy) value.textContent = HINT_SAVING;
    else if (shown > 0) value.textContent = shown + ' 分' + (own > 0 && shown === own ? '（当前）' : '');
    else value.textContent = '还没打分';

    const avg = el.querySelector('[data-rating-pop-avg]');
    const count = Number(entry.count) || 0;
    avg.textContent = count > 0
      ? '全站平均 ' + (Number(entry.average) || 0).toFixed(1) + ' 分 · ' + count + ' 人'
      : '还没有人打分';

    const clearBtn = el.querySelector('[data-rating-pop-clear]');
    if (clearBtn) clearBtn.hidden = own <= 0 || popover.busy;
    const hint = el.querySelector('[data-rating-pop-hint]');
    if (hint) hint.textContent = popover.error ? '再点一次试试' : '点星星打分，随时可改';
  }

  function positionPopover() {
    if (!popover) return;
    const anchor = popover.anchor && popover.anchor.isConnected
      ? popover.anchor
      : popoverAnchorOf(popover.songKey);
    if (!anchor) return;
    popover.anchor = anchor;
    const layer = popover.el;
    const rect = anchor.getBoundingClientRect();
    const box = layer.getBoundingClientRect();
    const width = box.width || 250;
    const height = box.height || 150;

    let left = rect.right - width;
    left = Math.max(POPOVER_MARGIN, Math.min(left, window.innerWidth - width - POPOVER_MARGIN));
    let top = rect.bottom + POPOVER_GAP;
    if (top + height > window.innerHeight - POPOVER_MARGIN && rect.top - height - POPOVER_GAP > POPOVER_MARGIN) {
      top = rect.top - height - POPOVER_GAP;
    }
    top = Math.max(POPOVER_MARGIN, Math.min(top, Math.max(POPOVER_MARGIN, window.innerHeight - height - POPOVER_MARGIN)));

    layer.style.width = width + 'px';
    layer.style.left = Math.round(left) + 'px';
    layer.style.top = Math.round(top) + 'px';
  }

  function closePopover(keepFocus) {
    if (!popover) return;
    const el = popover.el;
    const lastFocus = popover.lastFocus;
    popover = null;
    el.classList.remove('is-open');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 160);
    if (keepFocus && lastFocus && typeof lastFocus.focus === 'function' && lastFocus.isConnected) {
      try { lastFocus.focus({ preventScroll: true }); } catch (error) { /* ignore */ }
    }
  }

  function popoverStarScore(node, event) {
    const rect = node.getBoundingClientRect();
    const onLeftHalf = event && typeof event.clientX === 'number'
      ? (event.clientX - rect.left) < rect.width / 2
      : true;
    return Number(onLeftHalf ? node.getAttribute('data-rating-half') : node.getAttribute('data-rating-full')) || 0;
  }

  function previewPopover(score) {
    if (!popover || popover.busy) return;
    if (popover.preview === score) return;
    popover.preview = score;
    syncPopover();
  }

  function submitFromPopover(score, confirmRemove) {
    if (!popover || popover.busy) return;
    const songKey = popover.songKey;
    popover.busy = true;
    popover.error = '';
    popover.preview = 0;
    syncPopover();
    applyScore(songKey, score, confirmRemove).then(function (result) {
      if (!popover || popover.songKey !== songKey) return;
      popover.busy = false;
      if (result.ok) {
        closePopover(true);
        showToast(score > 0 ? '已记录 ' + score + ' 分' : '已清除评分');
      } else {
        popover.error = result.message;
        syncPopover();
      }
    });
  }

  /* ---------- 交互 ---------- */

  // 找到「打分」按钮所属的评分容器：列表卡片或底部播放栏。
  function ratingContainerOf(node) {
    const root = node.closest('[data-rating-root]');
    if (!root) return null;
    return root.closest('[data-rating-key]');
  }

  function onClick(event) {
    const target = event.target;
    if (!target || !target.closest) return;

    // 1. 面板内部
    if (popover && popover.el.contains(target)) {
      const closeBtn = target.closest('[data-rating-close]');
      if (closeBtn) {
        event.preventDefault();
        event.stopPropagation();
        closePopover(true);
        return;
      }
      const clearBtn = target.closest('[data-rating-pop-clear]');
      if (clearBtn) {
        event.preventDefault();
        event.stopPropagation();
        submitFromPopover(0, true);
        return;
      }
      const star = target.closest('.rating-star.is-pick');
      if (star) {
        event.preventDefault();
        event.stopPropagation();
        const score = popoverStarScore(star, event);
        if (score) submitFromPopover(score, false);
        return;
      }
      if (target.closest('[data-rating-pop-stars]')) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    // 2. 点面板外面 = 关掉
    if (popover && !target.closest('[data-rating-open]')) {
      closePopover(true);
      return;
    }

    // 3. 「打分 / 改分」按钮：卡片上或者播放栏上
    const openBtn = target.closest('[data-rating-open]');
    if (!openBtn) return;
    const container = ratingContainerOf(openBtn);
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();
    // 同一首歌在卡片和播放栏各有一个按钮，点哪个都切换同一个面板
    if (popover && popover.songKey === songKeyOfCard(container)) {
      closePopover(true);
      return;
    }
    openPopover(container);
  }

  // 悬停预览只在面板里用 rAF 合并，鼠标划过一排星星不会连续重排 DOM。
  let hoverFrame = 0;
  let hoverEvent = null;
  function onMouseMove(event) {
    if (!popover || popover.busy) return;
    const target = event.target;
    if (!target || !target.closest) return;
    const star = target.closest('.rating-pop-stars .rating-star.is-pick');
    if (!star) return;
    hoverEvent = { star: star, clientX: event.clientX };
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(function () {
      hoverFrame = 0;
      const pending = hoverEvent;
      hoverEvent = null;
      if (!pending || !popover) return;
      previewPopover(popoverStarScore(pending.star, { clientX: pending.clientX }));
    });
  }

  function onMouseOut(event) {
    if (!popover) return;
    const from = event.target && event.target.closest ? event.target.closest('.rating-pop-stars') : null;
    if (!from) return;
    const to = event.relatedTarget && event.relatedTarget.closest
      ? event.relatedTarget.closest('.rating-pop-stars')
      : null;
    if (from === to) return;
    if (popover.preview) {
      popover.preview = 0;
      syncPopover();
    }
  }

  function onKeyDown(event) {
    if (!popover) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closePopover(true);
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const entry = entryCache.get(popover.songKey) || {};
      const current = popover.preview || Number(entry.own) || 0;
      const next = Math.max(1, Math.min(10, current + (event.key === 'ArrowRight' ? 1 : -1)));
      event.preventDefault();
      previewPopover(next);
    }
  }

  /* ---------- 扫描与初始化 ---------- */

  function observe(el) {
    if (tracked.has(el)) return;
    tracked.add(el);
    if (!('IntersectionObserver' in window)) {
      el.dataset.ratingVisible = '1';
      scheduleFlush();
      return;
    }
    if (!observer) {
      observer = new IntersectionObserver(function (entries) {
        let any = false;
        entries.forEach(function (item) {
          if (!item.isIntersecting) return;
          observer.unobserve(item.target);
          item.target.dataset.ratingVisible = '1';
          any = true;
        });
        if (any) scheduleFlush();
      }, { rootMargin: OBSERVER_ROOT_MARGIN });
    }
    observer.observe(el);
  }

  function scan() {
    document.querySelectorAll('.song-item[data-rating-key]').forEach(function (el) {
      ensureCard(el);
      observe(el);
    });
    syncPlayerRating();
    if (popover) {
      const anchor = popover.anchor && popover.anchor.isConnected
        ? popover.anchor
        : popoverAnchorOf(popover.songKey);
      if (!anchor) closePopover(false);
    }
    if (!offline) scheduleFlush();
  }

  // 播放栏里也放一份评分：数据键跟着当前播放的歌走，容器结构跟卡片完全一样。
  function syncPlayerRating() {
    const host = playerRatingEl();
    if (!host) return;
    const nameEl = document.getElementById('playerSongName');
    const name = nameEl ? String(nameEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const key = name && name !== '未选择歌曲' ? name : '';

    if (songKeyOfCard(host) === key) {
      if (key) ensureCard(host);
      return;
    }

    // 换歌了：收起这一首的面板，避免把评分留到下一首头上
    if (popover && (!key || popover.songKey !== key)) closePopover(false);

    if (key) {
      host.setAttribute('data-rating-key', key);
      host.setAttribute('data-rating-name', name);
      // 播放栏用紧凑排版：不画「均分 / 我的」标签，也不写长提示
      host.setAttribute('data-rating-compact', '');
      // 播放栏只显示当前这一首，不需要等滚动，直接标成已加载
      host.dataset.ratingLoaded = '1';
      // 播放栏本身就是容器（卡片是内部有 [data-rating-host] 子元素），所以这里显式挂载
      if (!ratingRootOf(host)) host.innerHTML = cardMarkup();
      renderCard(host);
      const entry = entryCache.get(key);
      if (!entry) fetchKeys([key]).catch(function () {});
    } else {
      host.removeAttribute('data-rating-key');
      host.removeAttribute('data-rating-name');
      host.removeAttribute('data-rating-compact');
      host.innerHTML = playerIdleMarkup();
    }
  }

  function markOffline() {
    document.querySelectorAll('.song-item[data-rating-key]').forEach(function (el) {
      cacheEntry(songKeyOfCard(el), { loaded: true, pending: false, error: HINT_OFFLINE });
      ensureCard(el);
    });
  }

  function init() {
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);

    if (offline) {
      markOffline();
      return;
    }

    window.addEventListener('online', function () {
      document.querySelectorAll('.song-item[data-rating-loaded]').forEach(function (el) {
        delete el.dataset.ratingLoaded;
        delete el.dataset.ratingVisible;
      });
      scan();
    });

    const wrap = document.getElementById('songListWrap');
    if (wrap && 'MutationObserver' in window) {
      const mutation = new MutationObserver(function () { scan(); });
      mutation.observe(wrap, { childList: true });
    }

    // 播放栏：换歌时 app.js 只改 #playerSongName 的文字，这里跟着同步评分。
    const playerName = document.getElementById('playerSongName');
    if (playerName && 'MutationObserver' in window) {
      const playerObserver = new MutationObserver(function () { syncPlayerRating(); });
      playerObserver.observe(playerName, { childList: true, characterData: true, subtree: true });
    }
    const playerBar = document.getElementById('playerBar');
    if (playerBar && 'MutationObserver' in window) {
      const barObserver = new MutationObserver(function () { syncPlayerRating(); });
      barObserver.observe(playerBar, { attributes: true, attributeFilter: ['style'] });
    }

    scan();

    window.__XSL_RATING = {
      refresh: scan,
      entries: entryCache,
      applyPayload: applyPayload,
      paintStars: paintStars,
      starIconMarkup: starIconMarkup,
      ratingBucketOf: ratingBucketOf,
      syncPlayerRating: syncPlayerRating,
      loadAll: loadAll,
      averageOf: averageOf,
      countOf: countOf,
    };
  }

  // file:// 离线预览时接口不可用，直接退回只读展示，避免一直转圈。
  offline = location.protocol === 'file:';
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
