// ==UserScript==
// @name         ChatGPT + Gemini 双网页同步输入
// @namespace    dual-ai-sync
// @version      0.7
// @description  浮动小框输入/粘贴/拖拽多图多文件 → 回车 → ChatGPT 与 Gemini 两个网页自动填入，等上传完成后发送；连续对话时等上一条回复生成完再发，避免重复发送
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://gemini.google.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SITE = location.hostname.includes('gemini') ? 'gemini' : 'chatgpt';
  let lastSeq = 0;

  // ---------- 站点适配：编辑器 & 发送按钮 ----------
  const ADAPTERS = {
    chatgpt: {
      findEditor: () =>
        document.querySelector('#prompt-textarea') ||
        document.querySelector('div[contenteditable="true"].ProseMirror') ||
        document.querySelector('textarea'),
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
        '.uploading',
      ],
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
  // 记录已成功发送的 token，防止同一任务重复点击
  let sentTokens = new Set();

  // ---------- 取消所有待执行的自动发送任务 ----------
  // 一旦用户手动发送/手动改写输入，立刻作废脚本排队中的 clickSend 轮询，
  // 防止"用户已经手动发了，几秒后脚本又自动补发一次"
  function cancelPendingSends() {
    sendToken++;
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

  // ---------- 是否正在生成回复 ----------
  // 流式输出期间，两站的发送按钮都会变成"停止"按钮（元素本身可能不变），
  // 此时点击只会截断回答而不会发送，必须等生成结束后再点
  function isGenerating() {
    const sels = adapter.stopSelectors || [];
    return sels.some(s => [...document.querySelectorAll(s)].some(isVisible));
  }

  // 真实用户事件 isTrusted=true；脚本合成的 click/键盘事件 isTrusted=false。
  // 用它区分"用户手动发送"与"脚本自动发送"，前者要取消后者排队的任务。
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    // 生成回复期间该按钮是"停止"，点它不是手动发送，不取消排队任务
    if (isGenerating()) return;
    const btn = adapter.findSend();
    if (btn && (e.target === btn || (e.target.closest && e.target.closest('button') === btn))) {
      cancelPendingSends();
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
        cancelPendingSends();
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
  // 防止把用户后来手动输入的内容当成同步内容发出去
  function contentMatches(expected) {
    return getEditorText().trim() === (expected || '').trim();
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

  // ---------- 是否仍在上传 ----------
  // 仅在 composer/form 范围内检测，避免页面其他位置常驻的 spinner / 进度条造成误判
  function isUploading() {
    const sels = adapter.uploadingSelectors || [];
    const scope =
      adapter.findSend()?.closest('form') ||
      adapter.findEditor()?.closest('form') ||
      adapter.findEditor()?.parentElement ||
      document;
    return sels.some(s => scope.querySelector(s));
  }

  // ---------- 兜底：直接在编辑器上按回车发送 ----------
  function pressEnter(expectedText) {
    const editor = adapter.findEditor();
    if (!editor) return;
    // 回复还在生成中，回车不会发送，避免误触
    if (isGenerating()) return;
    // 内容已被用户改写/清空，放弃兜底发送
    if (!contentMatches(expectedText)) return;
    editor.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent('keydown', opts));
    editor.dispatchEvent(new KeyboardEvent('keypress', opts));
    editor.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ---------- 点击发送（等按钮可点 + 回复生成完 + 有文件时等上传完成） ----------
  // token：本次发送任务的标识，若期间又来新同步则作废；expectedText：脚本写入的文本；
  // genDeadline：等待"上一条回复生成结束"的绝对截止时间，期间不消耗 retries
  function clickSend(hasFiles, expectedText, token, retries = 60, genDeadline = Date.now() + 10 * 60 * 1000) {
    // 已发送过此 token，放弃（避免重复点击）
    if (sentTokens.has(token)) return;
    // 有更新的发送任务产生，放弃本次（旧的兜底定时器不再误触发）
    if (token !== sendToken) return;
    // 编辑器内容已不是脚本写入的那段（用户清空或手动改写），放弃发送
    if (!contentMatches(expectedText)) return;
    const btn = adapter.findSend();
    const ready = btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
    // 连续对话：上一条回复还在流式输出时按钮其实是"停止"，
    // 此时点击会截断回答且不会发送，必须等生成结束
    const generating = isGenerating();
    // 只有真正附带文件时才等待上传；纯文本不受上传指示器影响
    if (ready && !generating && (!hasFiles || !isUploading())) {
      sentTokens.add(token); // 标记已发送，防止后续轮询重复点击
      btn.click();
      // 清理旧 token（保留最近 10 个，避免内存泄漏）
      if (sentTokens.size > 10) {
        const old = [...sentTokens].sort((a, b) => a - b)[0];
        sentTokens.delete(old);
      }
      // 点击后校验：成功发送时站点会立刻清空输入框；若 1.5s 后脚本写入的
      // 文本仍原样留在编辑器里，说明刚才那次点击没有真正发出（例如按钮
      // 恰好切换成了停止态），撤销"已发送"标记继续等待重试，
      // 防止"标记已发但实际未发"导致内容滞留后被重复发送。
      // 纯文件无文本时无法用内容校验，维持点击即视为已发，避免误判重发。
      if ((expectedText || '').trim()) {
        setTimeout(() => {
          if (token !== sendToken) return;
          if (contentMatches(expectedText)) {
            sentTokens.delete(token);
            clickSend(hasFiles, expectedText, token, retries, genDeadline);
          }
        }, 1500);
      }
      return;
    }
    // 等待生成结束期间不消耗重试次数（回答可能持续数分钟），但有总截止时间兜底
    if (generating && Date.now() < genDeadline) {
      setTimeout(() => clickSend(hasFiles, expectedText, token, retries, genDeadline), 300);
      return;
    }
    if (retries > 0) {
      setTimeout(() => clickSend(hasFiles, expectedText, token, retries - 1, genDeadline), 300);
    } else {
      console.warn('[dual-ai] 发送按钮不可用，改用回车兜底发送');
      pressEnter(expectedText);
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

    const run = () => {
      const files = (p.files || []).map(f => dataUrlToFile(f.data, f.name));
      if (files.length) pasteFiles(files);
      if (p.text) setText(p.text);
      if (p.send) {
        // 作废之前可能仍在轮询的发送任务，并为本次分配新 token
        const token = ++sendToken;
        // 文件逐个粘贴（每个间隔 250ms），等全部注入后再点；
        // clickSend 内部还会轮询等上传完成（仅在有文件时），并校验内容/ token
        const delay = files.length ? 600 + files.length * 250 : 300;
        const hasFiles = files.length > 0;
        setTimeout(() => clickSend(hasFiles, p.text || '', token), delay);
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
      zIndex: '999999', background: 'rgba(255,255,255,0.55)',
      border: '1px solid rgba(200,200,200,0.6)',
      borderRadius: '12px', padding: '12px', fontSize: '14px',
      boxShadow: '0 4px 18px rgba(0,0,0,0.2)', color: '#111',
      backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    });
    panel.innerHTML = `
      <div id="dai-head" style="font-weight:bold;margin-bottom:2px;cursor:move;user-select:none;">
        ⠿ 同步输入
      </div>
      <textarea id="dai-text" placeholder="输入问题，回车=两边发送 / Shift+Enter 换行；可粘贴或拖拽多张图片/文件"
        style="width:100%;height:108px;box-sizing:border-box;background:rgba(255,255,255,0.6);"></textarea>
      <div id="dai-files" style="font-size:12px;color:#0a0;margin-top:4px;display:flex;flex-direction:column;gap:2px;"></div>
      <div style="display:flex;gap:0px;margin-top:2px;">
        <button id="dai-fill" style="flex:1;padding:2px 0;">同步填入</button>
        <button id="dai-send" style="flex:1;padding:2px 0;">同步发送</button>
        <button id="dai-new" style="flex:1;padding:2px 0;">新窗口发送</button>
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
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(ta.value, pendingFiles, true, false);
        clear();
      }
    });

    panel.querySelector('#dai-fill').onclick = () => send(ta.value, pendingFiles, false, false);
    panel.querySelector('#dai-send').onclick = () => { send(ta.value, pendingFiles, true, false); clear(); };
    panel.querySelector('#dai-new').onclick  = () => { send(ta.value, pendingFiles, true, true);  clear(); };

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
