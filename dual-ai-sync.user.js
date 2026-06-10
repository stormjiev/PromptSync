// ==UserScript==
// @name         ChatGPT + Gemini 双网页同步输入
// @namespace    dual-ai-sync
// @version      0.5
// @description  浮动小框输入/粘贴/拖拽多图多文件 → 回车 → ChatGPT 与 Gemini 两个网页自动填入，等上传完成后发送
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
    },
  };

  const adapter = ADAPTERS[SITE];

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
  function pressEnter() {
    const editor = adapter.findEditor();
    if (!editor) return;
    editor.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent('keydown', opts));
    editor.dispatchEvent(new KeyboardEvent('keypress', opts));
    editor.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ---------- 点击发送（等按钮可点 + 有文件时等上传完成） ----------
  function clickSend(hasFiles, retries = 60) {
    const btn = adapter.findSend();
    const ready = btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
    // 只有真正附带文件时才等待上传；纯文本不受上传指示器影响
    if (ready && (!hasFiles || !isUploading())) {
      btn.click();
      return;
    }
    if (retries > 0) {
      setTimeout(() => clickSend(hasFiles, retries - 1), 300);
    } else {
      console.warn('[dual-ai] 发送按钮不可用，改用回车兜底发送');
      pressEnter();
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
        // 文件逐个粘贴（每个间隔 250ms），等全部注入后再点；
        // clickSend 内部还会轮询等上传完成（仅在有文件时）
        const delay = files.length ? 600 + files.length * 250 : 300;
        const hasFiles = files.length > 0;
        setTimeout(() => clickSend(hasFiles), delay);
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
      zIndex: '999999', background: '#fff', border: '1px solid #ccc',
      borderRadius: '12px', padding: '12px', fontSize: '14px',
      boxShadow: '0 4px 18px rgba(0,0,0,0.2)', color: '#111',
    });
    panel.innerHTML = `
      <div id="dai-head" style="font-weight:bold;margin-bottom:2px;cursor:move;user-select:none;">
        ⠿ 同步输入
      </div>
      <textarea id="dai-text" placeholder="输入问题，回车=两边发送 / Shift+Enter 换行；可粘贴或拖拽多张图片/文件"
        style="width:100%;height:108px;box-sizing:border-box;"></textarea>
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
