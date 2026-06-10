// ==UserScript==
// @name         ChatGPT + Gemini 双网页同步输入
// @namespace    dual-ai-sync
// @version      0.4
// @description  浮动小框输入/粘贴图片 → 回车 → ChatGPT 与 Gemini 两个网页自动填入并发送
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

  // ---------- 注入图片（重建 paste 事件） ----------
  function pasteImage(dataUrl) {
    const editor = adapter.findEditor();
    if (!editor) return;
    editor.focus();

    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:(.*?);/) || [])[1] || 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'pasted.png', { type: mime });

    const dt = new DataTransfer();
    dt.items.add(file);
    editor.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: dt,
    }));
  }

  // ---------- 点击发送（等按钮可点） ----------
  function clickSend(retries = 12) {
    const btn = adapter.findSend();
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
      return;
    }
    if (retries > 0) setTimeout(() => clickSend(retries - 1), 200);
    else console.warn('[dual-ai] 发送按钮不可用，请手动发送');
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

  // ---------- 应用一条广播 ----------
  function applyPayload(p) {
    if (!p || p.seq === lastSeq) return;
    lastSeq = p.seq;

    const run = () => {
      if (p.image) pasteImage(p.image);
      if (p.text) setText(p.text);
      if (p.send) {
        // 图片需要时间上传，多等一会
        setTimeout(clickSend, p.image ? 1500 : 500);
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

  function send(text, image, doSend, newChat) {
    broadcast({ seq: Date.now(), text, image: image || null, send: doSend, newChat: !!newChat });
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
      <textarea id="dai-text" placeholder="输入问题，回车=两边发送 / Shift+Enter 换行，可直接粘贴图片"
        style="width:100%;height:108px;box-sizing:border-box;"></textarea>
      <div id="dai-img" style="font-size:12px;color:#0a0;margin-top:4px;"></div>
      <div style="display:flex;gap:0px;margin-top:2px;">
        <button id="dai-fill" style="flex:1;padding:2px 0;">同步填入</button>
        <button id="dai-send" style="flex:1;padding:2px 0;">同步发送</button>
        <button id="dai-new" style="flex:1;padding:2px 0;">新窗口发送</button>
      </div>`;
    document.body.appendChild(panel);

    const ta = panel.querySelector('#dai-text');
    const imgLabel = panel.querySelector('#dai-img');
    let pendingImage = null;
    const clear = () => { ta.value = ''; pendingImage = null; imgLabel.textContent = ''; };

    ta.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => { pendingImage = reader.result; imgLabel.textContent = '✓ 已附带图片'; };
      reader.readAsDataURL(item.getAsFile());
    });

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(ta.value, pendingImage, true, false);
        clear();
      }
    });

    panel.querySelector('#dai-fill').onclick = () => send(ta.value, pendingImage, false, false);
    panel.querySelector('#dai-send').onclick = () => { send(ta.value, pendingImage, true, false); clear(); };
    panel.querySelector('#dai-new').onclick  = () => { send(ta.value, pendingImage, true, true);  clear(); };

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
