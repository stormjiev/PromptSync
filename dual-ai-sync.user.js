// ==UserScript==
// @name         ChatGPT + Gemini 双网页同步输入
// @namespace    dual-ai-sync
// @version      1.2
// @description  浮动小框输入/粘贴/拖拽多图多文件 → 回车 → ChatGPT 与 Gemini 两个网页自动填入，等上传完成后发送；单任务只点一次发送键、绝不自动重试，杜绝截断回答和重复发送
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://gemini.google.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SITE = location.hostname.includes('gemini') ? 'gemini' : 'chatgpt';
  let lastSeq = 0;

  // ---------- 诊断日志 ----------
  // 每个站点各存一份（GM 存储跨标签页共享），面板上可一键导出两站合并日志，
  // 用于排查"没发送/重复发送"这类时序问题，不必在两个页面分别开 F12
  const LOG_KEY = 'dual_ai_logs_' + SITE;
  let logBuf;
  try { logBuf = GM_getValue(LOG_KEY, []) || []; } catch (e) { logBuf = []; }
  function dlog(msg) {
    const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 23)}][${SITE}] ${msg}`;
    console.log('[dual-ai] ' + msg);
    logBuf.push(line);
    if (logBuf.length > 400) logBuf = logBuf.slice(-400);
    try { GM_setValue(LOG_KEY, logBuf); } catch (e) { /* 存储失败不影响主流程 */ }
  }

  // ---------- 跨标签页/跨实例发送锁 ----------
  // 单页面内有 sentTokens 防重，但若同一站点开了多个标签页（或脚本被注入
  // 进 iframe），每个实例都会收到广播并各自点一次发送 → 同一条消息发两遍。
  // 用 GM 存储记录"本站点已发送的最新 seq"，任何实例点击前先抢锁。
  const SENT_SEQ_KEY = 'dual_ai_last_sent_seq_' + SITE;
  function seqAlreadySent(seq) {
    try { return GM_getValue(SENT_SEQ_KEY, 0) >= seq; } catch (e) { return false; }
  }
  function markSeqSent(seq) {
    try { GM_setValue(SENT_SEQ_KEY, seq); } catch (e) { /* ignore */ }
  }

  // ---------- 网络层上传跟踪 ----------
  // DOM 进度条选择器随站点改版极易失配（Gemini 已实际翻车：图片没传完就点了
  // 发送），所以直接挂钩页面的 fetch/XHR，凡是发往上传类端点的 POST/PUT 请求
  // 都计数：active>0 即上传未完成。这一信号与 DOM 结构完全解耦。
  const uploadNet = { active: 0, started: 0, lastChangeAt: 0 };
  // ChatGPT：/backend-api/files + Azure blob / oaiusercontent；Gemini：*/upload/*（push.clients6 等）
  const UPLOAD_URL_RE = /upload|backend-api\/files|oaiusercontent|blob\.core\.windows|content-push/i;
  function trackUploadStart(url, method) {
    if (!/^(post|put)$/i.test(method || '')) return false;
    if (!UPLOAD_URL_RE.test(url || '')) return false;
    uploadNet.active++;
    uploadNet.started++;
    uploadNet.lastChangeAt = Date.now();
    // 分片上传会连发多个请求，只在 0→1 时记日志避免刷屏
    if (uploadNet.active === 1) dlog(`检测到上传请求开始：${method} ${String(url).slice(0, 80)}`);
    return true;
  }
  function trackUploadEnd() {
    uploadNet.active = Math.max(0, uploadNet.active - 1);
    uploadNet.lastChangeAt = Date.now();
    if (uploadNet.active === 0) dlog('上传请求全部结束（进入静默确认期）');
  }
  (function hookNetwork() {
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    try {
      const origFetch = W.fetch;
      W.fetch = function (input, init) {
        let url = '', method = 'GET';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
          method = (init && init.method) || (input && input.method) || 'GET';
        } catch (e) { /* ignore */ }
        const tracked = trackUploadStart(url, method);
        const p = origFetch.apply(this, arguments);
        if (tracked && p && p.then) p.then(trackUploadEnd, trackUploadEnd);
        return p;
      };
      const XHR = W.XMLHttpRequest;
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__daiReq = { method, url: String(url) };
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        const m = this.__daiReq || {};
        if (trackUploadStart(m.url, m.method)) {
          this.addEventListener('loadend', trackUploadEnd, { once: true });
        }
        return origSend.apply(this, arguments);
      };
    } catch (e) {
      dlog('网络上传钩子安装失败（仅靠 DOM 检测兜底）：' + e.message);
    }
  })();

  // ---------- 站点适配：编辑器 & 发送按钮 ----------
  const ADAPTERS = {
    chatgpt: {
      findEditor: () =>
        document.querySelector('#prompt-textarea') ||
        document.querySelector('div[contenteditable="true"].ProseMirror') ||
        // 排除脚本自己的浮动面板输入框，避免被当成站点编辑器
        document.querySelector('textarea:not(#dai-text)'),
      findSend: () =>
        document.querySelector('button[data-testid="send-button"]') ||
        document.querySelector('#composer-submit-button') ||
        document.querySelector('button[aria-label*="Send" i]'),
      // 上传中指示器：进度条 / 旋转 spinner（任一存在即视为上传未完成）
      uploadingSelectors: [
        'div[role="progressbar"]',
        '[data-testid="composer-attachment-loading"]',
        '.animate-spin',
      ],
      // 正在生成回复的指示：流式输出时 composer 按钮变成"停止"按钮
      stopSelectors: [
        'button[data-testid="stop-button"]',
        '#composer-submit-button[aria-label*="stop" i]',
        '#composer-submit-button[aria-label*="停止"]',
        'button[aria-label*="stop streaming" i]',
      ],
    },
    gemini: {
      findEditor: () =>
        document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
        document.querySelector('.ql-editor[contenteditable="true"]') ||
        document.querySelector('div[contenteditable="true"]'),
      findSend: () =>
        document.querySelector('button.send-button') ||
        document.querySelector('button[aria-label*="Send" i]') ||
        document.querySelector('button[aria-label*="发送"]'),
      uploadingSelectors: [
        'mat-progress-bar',
        '[role="progressbar"]',
        '.mat-mdc-progress-bar',
        'mat-spinner',
        'mat-progress-spinner',
        '.mat-mdc-progress-spinner',
        '.uploading',
        '.upload-progress',
      ],
      // Gemini 没有 <form>，必须显式圈定包含附件预览区的 composer 容器；
      // 否则上传检测范围回退到编辑器内壳，进度条永远检测不到（图片没传完就发送）
      findUploadScope: () => {
        const direct = document.querySelector(
          'input-area-v2, input-area, .input-area-container, .input-area');
        if (direct) return direct;
        // 兜底：站点改版换了容器名时，从编辑器向上爬几层圈住附件预览区
        let el = document.querySelector('rich-textarea');
        for (let i = 0; el && el.parentElement && i < 4; i++) el = el.parentElement;
        return el;
      },
      // 正在生成回复的指示：发送按钮切换为停止状态
      stopSelectors: [
        'button.send-button.stop',
        'button[aria-label*="stop response" i]',
        'button[aria-label*="停止回答"]',
        'button[aria-label*="停止生成"]',
      ],
    },
  };

  const adapter = ADAPTERS[SITE];

  // 每次 applyPayload 触发发送时自增；旧的延迟发送任务若 token 过期则放弃，
  // 避免上一条同步的兜底任务在用户手动输入后误触发
  let sendToken = 0;
  // 记录已点击过发送的 token。核心防重原则：一个发送任务物理上只点一次
  // 发送键，点过就永不自动再点（即使发送成功检测失败也只提示、不重试），
  // 宁可漏发让用户手动补一下，也绝不重复发送
  let sentTokens = new Set();
  // token → 点击前对话中已存在的"同文本用户消息"条数，作为发送成功判定的基线
  const tokenBaselines = new Map();
  // token → 上次输出"等待发送条件"日志的时间，限频避免 300ms 轮询刷屏
  const waitLogAt = new Map();
  // token → 任务创建时刻 / 创建时已发生过的上传请求总数（用于判断"本任务的
  // 上传是否已经开始过"，区别于页面历史上别的上传）
  const tokenStartAt = new Map();
  const tokenUpBase = new Map();
  // 已为该 token 记过"未观测到上传、超时放行"警告，避免重复刷日志
  const graceWarned = new Set();

  // ---------- 附带文件时，上传是否已确认完成 ----------
  // 三道闸：① 网络层无进行中的上传请求；② DOM 无上传指示器；③ 若观测到过
  // 上传请求，要求结束后再静默 1.2s（分片/收尾请求之间有间隙，避免点在间隙上）。
  // 若 8 秒内完全没观测到上传活动（站点走了挂钩不到的通道），记警告后放行，
  // 避免永远卡住不发。
  function uploadsSettled(token, seq) {
    if (uploadNet.active > 0) return false;
    if (isUploading()) return false;
    const seen = uploadNet.started - (tokenUpBase.get(token) || 0);
    if (seen > 0) return Date.now() - uploadNet.lastChangeAt > 1200;
    if (Date.now() - (tokenStartAt.get(token) || 0) > 8000) {
      if (!graceWarned.has(token)) {
        graceWarned.add(token);
        dlog(`警告(seq=${seq})：附带文件但 8 秒内未观测到任何上传活动` +
          '（网络钩子和 DOM 指示器都没捕获到），超时放行发送');
      }
      return true;
    }
    return false;
  }

  // ---------- 取消所有待执行的自动发送任务 ----------
  // 一旦用户手动发送/手动改写输入，立刻作废脚本排队中的 clickSend 轮询，
  // 防止"用户已经手动发了，几秒后脚本又自动补发一次"
  function cancelPendingSends(reason) {
    sendToken++;
    dlog('取消排队中的自动发送任务：' + (reason || '未注明原因'));
  }

  // ---------- 元素是否真实可见 ----------
  // 站点不在生成回复时也可能把"停止"按钮留在 DOM 里（仅隐藏），
  // 只看存在性会把隐藏按钮误判成"正在生成"，导致永远不自动发送
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  // ---------- 按钮当前是否处于"停止"态 ----------
  // 两站的发送/停止常是同一个按钮，仅切换 aria-label / 类名 / 图标；
  // 站点改版后固定的 stopSelectors 可能失配，所以直接检查按钮本身的特征
  function isStopButton(btn) {
    if (!btn) return false;
    const label = (
      (btn.getAttribute('aria-label') || '') + ' ' +
      (btn.getAttribute('data-testid') || '') + ' ' +
      (btn.getAttribute('title') || '')
    ).toLowerCase();
    if (/\bstop\b|stop[-_ ]?(button|streaming|response)/.test(label)) return true;
    if (label.includes('停止') || label.includes('中止')) return true;
    if (btn.classList.contains('stop')) return true;
    // Gemini：按钮内 material 图标名为 stop
    const icon = btn.querySelector('mat-icon');
    if (icon && /stop/i.test(icon.getAttribute('data-mat-icon-name') || icon.textContent || '')) return true;
    return false;
  }

  // ---------- 是否正在生成回复 ----------
  // 流式输出期间，两站的发送按钮都会变成"停止"按钮（元素本身可能不变），
  // 此时点击只会截断回答而不会发送，必须等生成结束后再点
  function isGenerating() {
    const sels = adapter.stopSelectors || [];
    if (sels.some(s => [...document.querySelectorAll(s)].some(isVisible))) return true;
    // 兜底：stopSelectors 失配时，检查"发送"按钮本身是否其实是停止态
    const btn = adapter.findSend();
    return !!(btn && isVisible(btn) && isStopButton(btn));
  }

  // 真实用户事件 isTrusted=true；脚本合成的 click/键盘事件 isTrusted=false。
  // 用它区分"用户手动发送"与"脚本自动发送"，前者要取消后者排队的任务。
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    // 生成回复期间该按钮是"停止"，点它不是手动发送，不取消排队任务
    if (isGenerating()) return;
    const btn = adapter.findSend();
    if (btn && (e.target === btn || (e.target.closest && e.target.closest('button') === btn))) {
      cancelPendingSends('用户手动点击了站点的发送按钮');
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    // 生成回复期间回车不会触发发送，不视为手动发送
    if (isGenerating()) return;
    // 用户在真实输入框里按回车（非 Shift）发送
    if (e.key === 'Enter' && !e.shiftKey) {
      const editor = adapter.findEditor();
      if (editor && (e.target === editor || (e.target.closest && editor.contains(e.target)))) {
        cancelPendingSends('用户在站点输入框中按回车手动发送');
      }
    }
  }, true);

  // ---------- 读取编辑器当前文本 ----------
  function getEditorText() {
    const editor = adapter.findEditor();
    if (!editor) return '';
    return (editor.isContentEditable ? editor.innerText : editor.value) || '';
  }

  // 仅当编辑器当前内容仍是脚本写入的那段文本时才允许发送，
  // 防止把用户后来手动输入的内容当成同步内容发出去。
  // 必须做空白归一化：多行文本在 ProseMirror/Quill 里按段落渲染，
  // innerText 读回来是 "\n\n"，与原文 "\n" 严格比对必然失配，
  // 曾导致多行消息在两站都被静默放弃发送（填入了却不发）
  function contentMatches(expected) {
    return normText(getEditorText()) === normText(expected);
  }

  // ---------- 对话中包含指定文本的"用户消息"条数 ----------
  // 这是"消息真的发出去了"的最强信号：编辑器残留文本、停止按钮识别失败
  // 都可能误导其他判断，但用户消息气泡一旦出现就说明发送成功。
  // 与点击前记录的基线比较（条数增加才算），不影响用户重复问同一问题。
  function normText(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function countSentMessages(text) {
    // 长消息站点可能折叠显示，只用开头 80 字符做匹配
    const needle = normText(text).slice(0, 80);
    if (!needle) return 0;
    let els;
    if (SITE === 'chatgpt') {
      els = [...document.querySelectorAll('[data-message-author-role="user"]')];
    } else {
      els = [...document.querySelectorAll('user-query')];
      if (!els.length) els = [...document.querySelectorAll('[class*="user-query"]')];
    }
    return els.filter(el => normText(el.innerText).includes(needle)).length;
  }

  // ---------- 写入文本 ----------
  function setText(text) {
    const editor = adapter.findEditor();
    if (!editor) {
      console.warn('[dual-ai] 未找到输入框');
      return false;
    }
    editor.focus();

    if (editor.isContentEditable) {
      // ProseMirror / Quill 都吃 execCommand
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.addRange(range);
      document.execCommand('insertText', false, text);
    } else {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
      ).set;
      setter.call(editor, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return true;
  }

  // ---------- 注入图片/文件（重建 paste 事件） ----------
  // 逐个文件分发：ChatGPT(ProseMirror) 的粘贴处理每次只取首个文件，
  // 一次性塞多个只会进 1 个；Gemini 虽支持多个，但逐个分发同样兼容。
  function pasteFiles(files, i = 0) {
    const editor = adapter.findEditor();
    if (!editor || i >= files.length) return;
    editor.focus();

    const dt = new DataTransfer();
    dt.items.add(files[i]);
    editor.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: dt,
    }));

    if (i + 1 < files.length) {
      setTimeout(() => pasteFiles(files, i + 1), 250);
    }
  }

  // ---------- 是否仍在上传（DOM 指示器） ----------
  // 仅在 composer 范围内检测，避免页面其他位置常驻的 spinner / 进度条造成误判。
  // 范围优先用适配器显式指定的容器（Gemini 没有 form，靠 closest('form')
  // 会缩到编辑器内壳，上传进度条永远检测不到）
  function uploadScope() {
    return (adapter.findUploadScope && adapter.findUploadScope()) ||
      adapter.findSend()?.closest('form') ||
      adapter.findEditor()?.closest('form') ||
      adapter.findEditor()?.parentElement ||
      document;
  }
  // 返回匹配到的指示器选择器（用于日志定位），没有则返回 null
  function uploadIndicator() {
    const sels = adapter.uploadingSelectors || [];
    const scope = uploadScope();
    return sels.find(s => scope.querySelector(s)) || null;
  }
  function isUploading() {
    return !!uploadIndicator();
  }

  // ---------- 兜底：直接在编辑器上按回车发送 ----------
  function pressEnter(expectedText, seq) {
    const editor = adapter.findEditor();
    if (!editor) { dlog(`回车兜底失败(seq=${seq})：未找到输入框`); return; }
    // 回复还在生成中，回车不会发送，避免误触
    if (isGenerating()) { dlog(`回车兜底放弃(seq=${seq})：正在生成回复`); return; }
    // 内容已被用户改写/清空，放弃兜底发送
    if (!contentMatches(expectedText)) { dlog(`回车兜底放弃(seq=${seq})：输入框内容已变化`); return; }
    // 跨实例防重锁：别的标签页/实例已发过这条就不再发
    if (seqAlreadySent(seq)) { dlog(`回车兜底放弃(seq=${seq})：该条消息已被其他实例发送（防重锁）`); return; }
    markSeqSent(seq);
    dlog(`执行回车兜底发送(seq=${seq})`);
    editor.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent('keydown', opts));
    editor.dispatchEvent(new KeyboardEvent('keypress', opts));
    editor.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ---------- 点击发送（等按钮可点 + 回复生成完 + 有文件时等上传完成） ----------
  // token：本次发送任务的标识，若期间又来新同步则作废；seq：广播序号，用于跨实例防重锁；
  // expectedText：脚本写入的文本；genDeadline：等待"上一条回复生成结束"的绝对截止时间，
  // 期间不消耗 retries；calm：发送条件需连续满足的确认次数计数
  function clickSend(hasFiles, expectedText, token, seq, retries = 60, genDeadline = Date.now() + 10 * 60 * 1000, calm = 0) {
    // 已发送过此 token，放弃（避免重复点击）
    if (sentTokens.has(token)) return;
    // 有更新的发送任务产生，放弃本次（旧的兜底定时器不再误触发）
    if (token !== sendToken) { dlog(`放弃发送(seq=${seq})：已有更新的同步任务取代了它`); return; }
    // 首次进入本任务时记录基线：对话里此刻已有多少条同文本的用户消息
    if (!tokenBaselines.has(token)) {
      tokenBaselines.set(token, countSentMessages(expectedText));
      if (!tokenStartAt.has(token)) tokenStartAt.set(token, Date.now());
      // 带文件任务首次进入时记录上传检测环境，便于事后从日志定位
      // "为什么没等上传"是范围不对还是选择器失配
      if (hasFiles) {
        const scope = uploadScope();
        const scopeDesc = scope === document ? 'document'
          : `<${(scope.tagName || '?').toLowerCase()}${scope.className ? ' class="' + String(scope.className).slice(0, 60) + '"' : ''}>`;
        dlog(`上传检测环境(seq=${seq})：范围=${scopeDesc} DOM指示器=${uploadIndicator() || '无'} ` +
          `网络上传(进行中=${uploadNet.active} 本任务已见=${uploadNet.started - (tokenUpBase.get(token) || 0)})`);
      }
    }
    // 最强信号：对话中新出现了这条用户消息 → 已发送成功，
    // 无论编辑器是否残留文本、按钮是什么状态，都绝不再点击
    if (countSentMessages(expectedText) > tokenBaselines.get(token)) {
      sentTokens.add(token);
      markSeqSent(seq);
      dlog(`确认发送成功(seq=${seq})：消息已出现在对话中，不再点击`);
      return;
    }
    // 编辑器内容已不是脚本写入的那段（用户清空或手动改写），放弃发送
    if (!contentMatches(expectedText)) {
      dlog(`放弃发送(seq=${seq})：输入框内容与同步文本不一致。` +
        `期望="${normText(expectedText).slice(0, 40)}" 实际="${normText(getEditorText()).slice(0, 40)}"`);
      return;
    }
    // 跨实例防重锁：同站点的其他标签页/实例已经发过这条消息就绝不再发
    if (seqAlreadySent(seq)) {
      sentTokens.add(token);
      dlog(`放弃发送(seq=${seq})：该条消息已被本站点其他页面实例发送（防重锁）`);
      return;
    }
    const btn = adapter.findSend();
    const ready = btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
    // 连续对话：上一条回复还在流式输出时按钮其实是"停止"，
    // 此时点击会截断回答且不会发送，必须等生成结束
    const generating = isGenerating();
    // 只有真正附带文件时才等待上传；纯文本不受上传指示器影响
    // isStopButton 再查一次按钮本身：即使 stopSelectors 全部失配，
    // 也绝不把已切换成"停止"态的按钮当发送键点（点了会截断回答）
    if (ready && !generating && !isStopButton(btn) && (!hasFiles || uploadsSettled(token, seq))) {
      // 连续两次检测（间隔 250ms）都满足条件才真正点击，避开"生成刚结束/
      // 按钮状态正在切换"的瞬间，防止点在过渡态上产生截断或误发
      if (calm < 1) {
        setTimeout(() => clickSend(hasFiles, expectedText, token, seq, retries, genDeadline, calm + 1), 250);
        return;
      }
      // 核心防重：标记已点击。此标记永不撤销 → 本任务后续任何定时器、
      // 任何校验逻辑都不可能再点第二次。曾经的"校验失败就撤销标记重试"
      // 正是重复发送的病根：消息其实已发出但编辑器残留文字/按钮状态误判，
      // 重试点击轻则截断回答（点中停止键）、重则同一问题问两遍。
      sentTokens.add(token);
      markSeqSent(seq);
      dlog(`点击发送按钮(seq=${seq})，文本="${normText(expectedText).slice(0, 40)}"`);
      btn.click();
      // 清理旧 token（保留最近 10 个，避免内存泄漏）
      if (sentTokens.size > 10) {
        const old = [...sentTokens].sort((a, b) => a - b)[0];
        sentTokens.delete(old);
        tokenBaselines.delete(old);
        waitLogAt.delete(old);
        tokenStartAt.delete(old);
        tokenUpBase.delete(old);
        graceWarned.delete(old);
      }
      // 点击后校验（轮询 5s）只用于提示，绝不自动重试点击。
      // 成功信号任一出现即静默结束：① 对话中新出现这条用户消息；
      // ② 编辑器已清空；③ 检测到正在生成回复。全部落空仅记日志告警，
      // 文字会留在输入框里，由用户自行决定是否手动发送。
      if ((expectedText || '').trim()) {
        const verifyUntil = Date.now() + 5000;
        const verify = () => {
          if (token !== sendToken) return;
          if (countSentMessages(expectedText) > tokenBaselines.get(token)) {
            dlog(`发送成功(seq=${seq})：对话中已出现该消息`); return;
          }
          if (!contentMatches(expectedText)) {
            dlog(`发送成功(seq=${seq})：输入框已清空/内容已变化`); return;
          }
          if (isGenerating()) {
            dlog(`发送成功(seq=${seq})：已检测到正在生成回复`); return;
          }
          if (Date.now() < verifyUntil) { setTimeout(verify, 250); return; }
          dlog(`警告(seq=${seq})：点击后未检测到任何发送成功信号；` +
            '为避免重复发送不会自动重试，若消息未发出请手动点击发送');
        };
        setTimeout(verify, 250);
      }
      return;
    }
    // 等待期间每 3 秒记一条状态日志（300ms 轮询全记会刷屏）
    if (Date.now() - (waitLogAt.get(token) || 0) > 3000) {
      waitLogAt.set(token, Date.now());
      let upDesc = '无文件';
      if (hasFiles) {
        const ind = uploadIndicator();
        const seen = uploadNet.started - (tokenUpBase.get(token) || 0);
        upDesc = `${!!ind || uploadNet.active > 0}[DOM指示=${ind || '无'} ` +
          `网络进行中=${uploadNet.active} 本任务已见=${seen} ` +
          `距上次活动=${uploadNet.lastChangeAt ? Date.now() - uploadNet.lastChangeAt + 'ms' : '从未'}]`;
      }
      dlog(`等待发送条件(seq=${seq})：按钮就绪=${!!ready} 生成中=${generating} ` +
        `停止态按钮=${isStopButton(btn)} 上传中=${upDesc} 剩余重试=${retries}`);
    }
    // 等待生成结束期间不消耗重试次数（回答可能持续数分钟），但有总截止时间兜底；
    // 上传明确进行中时同理：大文件上传可能超过 18s，耗尽重试会触发回车兜底
    // 提前发送，重蹈"图片没传完文字先发出去"的覆辙
    const uploadBusy = hasFiles && (uploadNet.active > 0 || isUploading());
    if ((generating || uploadBusy) && Date.now() < genDeadline) {
      setTimeout(() => clickSend(hasFiles, expectedText, token, seq, retries, genDeadline, 0), 300);
      return;
    }
    if (retries > 0) {
      setTimeout(() => clickSend(hasFiles, expectedText, token, seq, retries - 1, genDeadline, 0), 300);
    } else {
      dlog(`发送按钮持续不可用(seq=${seq})，改用回车兜底发送`);
      pressEnter(expectedText, seq);
    }
  }

  // ---------- 开启新对话（Cmd+Shift+O） ----------
  function openNewChat() {
    // 优先点"新建对话"按钮，找不到再发快捷键
    const sel = SITE === 'chatgpt'
      ? '[data-testid="create-new-chat-button"], a[aria-label*="New chat" i]'
      : '[data-test-id="new-chat-button"], button[aria-label*="New chat" i], button[aria-label*="新对话"]';
    const btn = document.querySelector(sel);
    if (btn) { btn.click(); return; }
    const opts = {
      key: 'O', code: 'KeyO', keyCode: 79, which: 79,
      metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ---------- dataURL -> File ----------
  function dataUrlToFile(dataUrl, name) {
    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:(.*?);/) || [])[1] || 'application/octet-stream';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name || 'file', { type: mime });
  }

  // ---------- 应用一条广播 ----------
  function applyPayload(p) {
    if (!p || p.seq === lastSeq) return;
    lastSeq = p.seq;
    dlog(`收到广播 seq=${p.seq} 发送=${!!p.send} 新对话=${!!p.newChat} ` +
      `文件=${(p.files || []).length} 文本="${normText(p.text).slice(0, 40)}"`);

    const run = () => {
      const files = (p.files || []).map(f => dataUrlToFile(f.data, f.name));
      // 必须在粘贴前取基线：站点的粘贴处理可能同步发起上传请求
      const upBase = uploadNet.started;
      if (files.length) pasteFiles(files);
      if (p.text) {
        const ok = setText(p.text);
        dlog(ok ? '已写入文本到输入框' : '写入文本失败：未找到输入框');
      }
      if (p.send) {
        // 空内容的发送广播直接忽略（通常来自按住回车的连发），注意必须在
        // ++sendToken 之前返回，否则空广播会把前一条正常消息的发送任务作废
        if (!(p.text || '').trim() && !files.length) {
          dlog(`忽略空内容的发送广播 seq=${p.seq}`);
          return;
        }
        // 作废之前可能仍在轮询的发送任务，并为本次分配新 token
        const token = ++sendToken;
        tokenStartAt.set(token, Date.now());
        tokenUpBase.set(token, upBase);
        // 文件逐个粘贴（每个间隔 250ms），等全部注入后再点；
        // clickSend 内部还会轮询等上传完成（仅在有文件时），并校验内容/ token
        const delay = files.length ? 600 + files.length * 250 : 300;
        const hasFiles = files.length > 0;
        setTimeout(() => clickSend(hasFiles, p.text || '', token, p.seq), delay);
      }
    };

    if (p.newChat) {
      openNewChat();
      setTimeout(run, 1200); // 等新对话界面就绪
    } else {
      run();
    }
  }

  GM_addValueChangeListener('dual_ai_prompt', (n, o, v, remote) => {
    if (remote) applyPayload(v);
  });

  // ---------- 广播 ----------
  function broadcast(payload) {
    GM_setValue('dual_ai_prompt', payload);
    applyPayload(payload); // 本页也执行
  }

  function send(text, files, doSend, newChat) {
    broadcast({ seq: Date.now(), text, files: files || [], send: doSend, newChat: !!newChat });
  }

  // ---------- 浮动面板（只在 ChatGPT 显示；Gemini 仅后台接收） ----------
  function createPanel() {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed', right: '24px', bottom: '110px', width: '384px',
      zIndex: '999999', background: 'rgba(255,255,255,0.1)',
      border: '1px solid rgba(200,200,200,0.6)',
      borderRadius: '12px', padding: '12px', fontSize: '14px',
      boxShadow: '0 4px 18px rgba(0,0,0,0.2)', color: '#111',
      backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    });
    panel.innerHTML = `
      <div id="dai-head" style="font-weight:bold;margin-bottom:2px;cursor:move;user-select:none;">
        ⠿ 同步输入 v${(typeof GM_info !== 'undefined' && GM_info.script.version) || '?'}
      </div>
      <textarea id="dai-text" placeholder="输入问题，回车=两边发送 / Shift+Enter 换行；可粘贴或拖拽多张图片/文件"
        style="width:100%;height:108px;box-sizing:border-box;background:rgba(255,255,255,0.1);"></textarea>
      <div id="dai-files" style="font-size:12px;color:#0a0;margin-top:4px;display:flex;flex-direction:column;gap:2px;"></div>
      <div style="display:flex;gap:0px;margin-top:2px;">
        <button id="dai-fill" style="flex:1;padding:2px 0;">同步填入</button>
        <button id="dai-send" style="flex:1;padding:2px 0;">同步发送</button>
        <button id="dai-new" style="flex:1;padding:2px 0;">新窗口发送</button>
      </div>
      <div style="display:flex;gap:0px;margin-top:2px;">
        <button id="dai-log" style="flex:2;padding:2px 0;font-size:12px;">导出诊断日志</button>
        <button id="dai-clearlog" style="flex:1;padding:2px 0;font-size:12px;">清空日志</button>
      </div>`;
    document.body.appendChild(panel);

    const ta = panel.querySelector('#dai-text');
    const fileList = panel.querySelector('#dai-files');
    // 每项 { name, type, data(dataURL) }
    let pendingFiles = [];

    const renderFiles = () => {
      fileList.innerHTML = '';
      pendingFiles.forEach((f, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const isImg = (f.type || '').startsWith('image/');
        const label = document.createElement('span');
        label.textContent = `${isImg ? '🖼' : '📎'} ${f.name}`;
        label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;';
        const del = document.createElement('span');
        del.textContent = '✕';
        del.style.cssText = 'cursor:pointer;color:#c00;flex:none;';
        del.onclick = () => { pendingFiles.splice(i, 1); renderFiles(); };
        row.appendChild(label);
        row.appendChild(del);
        fileList.appendChild(row);
      });
    };

    const clear = () => { ta.value = ''; pendingFiles = []; renderFiles(); };

    // 读取一批 File 对象为 dataURL 并加入待发送列表
    const addFiles = (files) => {
      [...files].forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          pendingFiles.push({ name: file.name || 'file', type: file.type, data: reader.result });
          renderFiles();
        };
        reader.readAsDataURL(file);
      });
    };

    ta.addEventListener('paste', (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const files = items
        .filter(i => i.kind === 'file')
        .map(i => i.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      e.preventDefault();
      addFiles(files);
    });

    // ---------- 拖拽文件进面板 ----------
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover'].forEach(ev => panel.addEventListener(ev, (e) => {
      stop(e);
      panel.style.outline = '2px dashed #0a0';
    }));
    ['dragleave', 'drop'].forEach(ev => panel.addEventListener(ev, (e) => {
      stop(e);
      panel.style.outline = '';
    }));
    panel.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) addFiles(files);
    });

    ta.addEventListener('keydown', (e) => {
      // 输入法组合中按回车是在确认候选词，不是要发送（keyCode 229 = IME 处理中）
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // 按住回车会产生重复 keydown：第一次已清空输入框，后续重复事件
        // 会广播出"空内容但要求发送"的指令，把前一条的发送任务作废掉
        // （表现为两边填入了却不发送），必须整体忽略
        if (e.repeat) return;
        if (!ta.value.trim() && !pendingFiles.length) return;
        send(ta.value, pendingFiles, true, false);
        clear();
      }
    });

    panel.querySelector('#dai-fill').onclick = () => send(ta.value, pendingFiles, false, false);
    panel.querySelector('#dai-send').onclick = () => {
      if (!ta.value.trim() && !pendingFiles.length) return;
      send(ta.value, pendingFiles, true, false); clear();
    };
    panel.querySelector('#dai-new').onclick  = () => {
      if (!ta.value.trim() && !pendingFiles.length) return;
      send(ta.value, pendingFiles, true, true);  clear();
    };

    // ---------- 诊断日志导出 ----------
    // 合并两站日志按时间排序，复制到剪贴板并打印到控制台，
    // 排查"没发送/重复发送"时把这份日志直接贴出来即可
    panel.querySelector('#dai-log').onclick = () => {
      let a = [], b = [];
      try {
        a = GM_getValue('dual_ai_logs_chatgpt', []) || [];
        b = GM_getValue('dual_ai_logs_gemini', []) || [];
      } catch (e) { /* ignore */ }
      const text = [...a, ...b].sort().join('\n') || '(暂无日志)';
      console.log('===== dual-ai 诊断日志 =====\n' + text);
      const done = () => alert(`已导出 ${a.length + b.length} 条日志：已复制到剪贴板，并打印到控制台(F12)`);
      const fail = () => alert('日志已打印到控制台(F12 查看)，剪贴板复制失败');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fail);
      } else { fail(); }
    };
    panel.querySelector('#dai-clearlog').onclick = () => {
      try {
        GM_setValue('dual_ai_logs_chatgpt', []);
        GM_setValue('dual_ai_logs_gemini', []);
      } catch (e) { /* ignore */ }
      logBuf = [];
      alert('日志已清空');
    };

    // ---------- 拖拽 ----------
    const head = panel.querySelector('#dai-head');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = (e.clientX - drag.dx) + 'px';
      panel.style.top  = (e.clientY - drag.dy) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = null; });
  }

  if (SITE === 'chatgpt') createPanel();
})();
