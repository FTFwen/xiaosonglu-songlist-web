// 全站直播状态组件：读取代理接口，并同步更新所有 [data-live-status] 节点。
(() => {
  'use strict';

  const ENDPOINT = 'https://viridis.love/api/live-status';
  const REFRESH_INTERVAL = 60 * 1000;
  let lastUpdatedAt = 0;

  function render(state, title) {
    const widgets = document.querySelectorAll('[data-live-status]');
    widgets.forEach(widget => {
      const label = widget.querySelector('[data-live-label]');
      const titleEl = widget.querySelector('[data-live-title]');
      const safeTitle = title || (state === 'live' ? '小松绿正在直播' : '暂时没有直播标题');

      widget.classList.remove('is-loading', 'is-live', 'is-offline', 'is-error');
      widget.classList.add(`is-${state}`);

      if (label) {
        label.textContent = state === 'live'
          ? '直播中'
          : state === 'offline'
            ? '未开播'
            : '状态暂不可用';
      }
      if (titleEl) {
        titleEl.textContent = safeTitle;
        titleEl.title = safeTitle;
      }
    });
  }

  async function refreshLiveStatus() {
    if (!document.querySelector('[data-live-status]')) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(`${ENDPOINT}?t=${Math.floor(Date.now() / 30000)}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload || payload.ok !== true || !payload.status || typeof payload.status.live !== 'boolean') {
        throw new Error('直播状态数据格式无效');
      }

      lastUpdatedAt = Date.now();
      render(payload.status.live ? 'live' : 'offline', payload.status.title);
    } catch (error) {
      console.warn('[直播状态] 获取失败：', error);
      render('error', '稍后会自动重试');
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function init() {
    if (!document.querySelector('[data-live-status]')) return;
    refreshLiveStatus();
    window.setInterval(refreshLiveStatus, REFRESH_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - lastUpdatedAt > 45000) refreshLiveStatus();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
