// PromptSync 网络层上传跟踪（MAIN 世界）
// ------------------------------------------------------------------
// DOM 进度条选择器随站点改版极易失配，所以直接挂钩页面真实的 fetch/XHR，
// 凡是发往上传类端点的 POST/PUT 都计数：active>0 即上传未完成。
// 本脚本运行在页面主世界（能改到页面自己用的 window.fetch），通过 DOM
// CustomEvent 把上传状态传给隔离世界的 content.js（两个世界不能直接共享变量）。
// ------------------------------------------------------------------
(function () {
  'use strict';
  if (window.__DAI_NET_HOOKED__) return;
  window.__DAI_NET_HOOKED__ = true;

  const state = { active: 0, started: 0, lastChangeAt: 0 };
  // ChatGPT：/backend-api/files + Azure blob / oaiusercontent；Gemini：*/upload/*；
  // 其余站点常见上传端点关键字一并覆盖
  const UPLOAD_URL_RE = /upload|backend-api\/files|oaiusercontent|blob\.core\.windows|content-push|\/files\b|attachment|media/i;

  function emit() {
    document.dispatchEvent(new CustomEvent('dai-upload-state', {
      detail: { active: state.active, started: state.started, lastChangeAt: state.lastChangeAt },
    }));
  }
  function start(url, method) {
    if (!/^(post|put)$/i.test(method || '')) return false;
    if (!UPLOAD_URL_RE.test(url || '')) return false;
    state.active++; state.started++; state.lastChangeAt = Date.now();
    emit();
    return true;
  }
  function end() {
    state.active = Math.max(0, state.active - 1);
    state.lastChangeAt = Date.now();
    emit();
  }

  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      let url = '', method = 'GET';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        method = (init && init.method) || (input && input.method) || 'GET';
      } catch (e) { /* ignore */ }
      const tracked = start(url, method);
      const p = origFetch.apply(this, arguments);
      if (tracked && p && p.then) p.then(end, end);
      return p;
    };

    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__daiReq = { method, url: String(url) };
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      const m = this.__daiReq || {};
      if (start(m.url, m.method)) {
        this.addEventListener('loadend', end, { once: true });
      }
      return origSend.apply(this, arguments);
    };
  } catch (e) {
    // 失败时 content.js 仅靠 DOM 指示器兜底
  }

  // content.js 启动后会请求一次当前状态（它可能比本脚本晚加载）
  document.addEventListener('dai-upload-query', emit);
})();
