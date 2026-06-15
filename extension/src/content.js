// PromptSync 内容脚本（隔离世界）
// ------------------------------------------------------------------
// 由用户脚本 dual-ai-sync.user.js 移植：保留"等上传完成、单任务只点一次
// 发送键、绝不自动重试/重复发送"的核心逻辑，仅把：
//   GM_setValue/GM_getValue/GM_addValueChangeListener → chrome.storage.local + onChanged
//   unsafeWindow 网络钩子 → MAIN 世界 inject-main.js + CustomEvent
//   硬编码 ADAPTERS → 数据驱动 adapters.js（可在设置页可视化编辑）
// 并升级为"多目标"：可同步发往任意已启用站点（不止两家）。
// ------------------------------------------------------------------
(function () {
  'use strict';

  console.log('[PromptSync] content script loaded @', location.hostname,
    'presets=', (window.DAI_PRESETS || []).length);

  // 先读配置，确定本页对应哪个站点适配器，再决定是否启动
  // dai_targets：浮框里"同步发往哪些站点"的勾选状态（跨刷新/跨标签持久化）
  chrome.storage.local.get(['dai_config', 'dai_targets'], (o) => init(o.dai_config, o.dai_targets));

  function buildSites(config) {
    const overrides = (config && config.sites) || {};
    const byId = {};
    window.DAI_PRESETS.forEach((p) => {
      const merged = window.DAI_mergeSite(p, overrides[p.id]);
      if (merged.enabled === undefined) merged.enabled = true;
      byId[p.id] = merged;
    });
    // 用户在设置页新增的自定义站点（不在预设里）
    Object.keys(overrides).forEach((id) => {
      if (byId[id] || !overrides[id]) return;
      byId[id] = Object.assign({ id, enabled: true }, overrides[id]);
    });
    return Object.values(byId);
  }

  function init(config, savedTargets) {
    let cfg = config || { version: 1, sites: {} };
    // 目标勾选状态：{ siteId: bool }。缺省（不在表里）= 勾选。
    let targetState = (savedTargets && typeof savedTargets === 'object') ? savedTargets : {};
    let sites = buildSites(cfg);
    let adapter = window.DAI_matchSite(sites, location.hostname);
    console.log('[PromptSync] init: adapter =', adapter && adapter.id, '| sites =', sites.map((s) => s.id + (s.enabled === false ? '(off)' : '')).join(','));
    if (!adapter) return; // 本页不是已启用的 AI 站点

    const SITE = adapter.id;
    let lastSeq = 0;
    const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; } })();
    // 扩展被「重新加载」后，已注入页面里的旧脚本会失联（Extension context invalidated），
    // 此时一切 chrome.* 调用都会抛错 → 面板看着在、实则假死。用它判断并提示用户刷新。
    function extAlive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }

    // ---------- 选择器工具（按逗号顺序逐个尝试，保留优先级） ----------
    function qsFirst(selList, root) {
      root = root || document;
      if (!selList) return null;
      for (const s of selList.split(',')) {
        const t = s.trim();
        if (!t) continue;
        try { const el = root.querySelector(t); if (el) return el; } catch (e) { /* 无效选择器跳过 */ }
      }
      return null;
    }
    function qsAll(selList, root) {
      root = root || document;
      const out = [];
      if (!selList) return out;
      for (const s of selList.split(',')) {
        const t = s.trim();
        if (!t) continue;
        try { root.querySelectorAll(t).forEach((e) => out.push(e)); } catch (e) { /* skip */ }
      }
      return out;
    }
    // 发送键：优先返回“可见”的匹配，跳过登录前欢迎页遗留的隐藏同名按钮
    // （Qwen 实测就栽在这：未登录页的 button.send-button 残留在 DOM 里被点了空）
    function qsFirstVisible(selList) {
      if (!selList) return null;
      let firstAny = null;
      for (const s of selList.split(',')) {
        const t = s.trim();
        if (!t) continue;
        let els;
        try { els = document.querySelectorAll(t); } catch (e) { continue; }
        for (const el of els) {
          if (!firstAny) firstAny = el;
          if (isVisible(el)) return el;
        }
      }
      return firstAny;
    }
    const findEditor = () => qsFirst(adapter.editor);
    const findSend = () => qsFirstVisible(adapter.send);

    // ---------- 诊断日志（写入 chrome.storage，跨标签共享，可一键导出） ----------
    const LOG_KEY = 'dai_logs_' + SITE;
    let logBuf = [];
    chrome.storage.local.get(LOG_KEY, (o) => { logBuf = o[LOG_KEY] || []; });
    let logFlushTimer = null;
    function dlog(msg) {
      const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 23)}][${SITE}] ${msg}`;
      console.log('[PromptSync] ' + msg);
      logBuf.push(line);
      if (logBuf.length > 400) logBuf = logBuf.slice(-400);
      // 限频写入存储，避免 300ms 轮询把存储写爆
      if (!logFlushTimer) {
        logFlushTimer = setTimeout(() => {
          logFlushTimer = null;
          try { chrome.storage.local.set({ [LOG_KEY]: logBuf }); } catch (e) { /* 上下文失联则忽略 */ }
        }, 800);
      }
    }

    // ---------- 跨标签页/跨实例发送锁（同步读，用内存镜像 + 写穿透） ----------
    // chrome.storage 是异步的，但 clickSend 热路径需要同步判断"这条是否已被
    // 别的标签页发过"。用内存镜像保存最新值，onChanged 与本地写入都更新它。
    const SENT_SEQ_KEY = 'dai_last_sent_seq_' + SITE;
    let sentSeqMirror = 0;
    chrome.storage.local.get(SENT_SEQ_KEY, (o) => { sentSeqMirror = o[SENT_SEQ_KEY] || 0; });
    function seqAlreadySent(seq) { return sentSeqMirror >= seq; }
    function markSeqSent(seq) {
      if (seq > sentSeqMirror) sentSeqMirror = seq;
      chrome.storage.local.set({ [SENT_SEQ_KEY]: sentSeqMirror });
    }

    // ---------- 网络层上传状态（来自 MAIN 世界 inject-main.js） ----------
    const uploadNet = { active: 0, started: 0, lastChangeAt: 0 };
    document.addEventListener('dai-upload-state', (e) => {
      if (e.detail) Object.assign(uploadNet, e.detail);
    });
    document.dispatchEvent(new CustomEvent('dai-upload-query')); // 主动同步一次当前值

    // ---------- 配置/广播变更监听（onChanged 天然跨标签） ----------
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[SENT_SEQ_KEY]) {
        const v = changes[SENT_SEQ_KEY].newValue || 0;
        if (v > sentSeqMirror) sentSeqMirror = v;
      }
      if (changes.dual_ai_prompt) {
        applyPayload(changes.dual_ai_prompt.newValue);
      }
      if (changes.dai_targets) {
        // 另一个标签页改了目标勾选：同步到本页浮框
        targetState = changes.dai_targets.newValue || {};
        syncTargets();
      }
      if (changes.dai_config) {
        // 站点选择器/显隐被实时编辑：重建适配器即时生效（无需刷新页面）
        cfg = changes.dai_config.newValue || { version: 1, sites: {} };
        sites = buildSites(cfg);
        const next = window.DAI_matchSite(sites, location.hostname);
        if (next) {
          adapter = next;
          rebuildTargets();
          ensurePanel();
          applyMinimize();
        } else if (panelEl) {
          // 本站被整体停用：连浮框一起撤掉
          panelEl.remove(); panelEl = null;
          rebuildTargets = () => {}; syncTargets = () => {}; applyMinimize = () => {};
        }
      }
    });

    // 写回单个站点的开关到 dai_config（显隐 / 启停）
    function setSiteFlag(id, key, val) {
      if (!cfg.sites) cfg.sites = {};
      cfg.sites[id] = Object.assign({}, cfg.sites[id], { [key]: val });
      try { chrome.storage.local.set({ dai_config: cfg }); } catch (e) { /* 上下文失联 */ }
    }

    // ---------- 元素是否真实可见 ----------
    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    }

    // ---------- 按钮当前是否处于"停止"态 ----------
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
      const icon = btn.querySelector('mat-icon');
      if (icon && /stop/i.test(icon.getAttribute('data-mat-icon-name') || icon.textContent || '')) return true;
      return false;
    }

    // ---------- 是否正在生成回复 ----------
    function isGenerating() {
      if (qsAll(adapter.stop).some(isVisible)) return true;
      const btn = findSend();
      return !!(btn && isVisible(btn) && isStopButton(btn));
    }

    // ---------- 区分用户手动发送 vs 脚本自动发送 ----------
    document.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      if (isGenerating()) return;
      const btn = findSend();
      if (btn && (e.target === btn || (e.target.closest && e.target.closest('button') === btn))) {
        cancelPendingSends('用户手动点击了站点的发送按钮');
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      if (isGenerating()) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        const editor = findEditor();
        if (editor && (e.target === editor || (e.target.closest && editor.contains(e.target)))) {
          cancelPendingSends('用户在站点输入框中按回车手动发送');
        }
      }
    }, true);

    // ---------- 读取/比对编辑器文本 ----------
    function getEditorText() {
      const editor = findEditor();
      if (!editor) return '';
      return (editor.isContentEditable ? editor.innerText : editor.value) || '';
    }
    function normText(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
    function contentMatches(expected) {
      return normText(getEditorText()) === normText(expected);
    }

    // ---------- 对话中包含指定文本的"用户消息"条数（发送成功的最强信号） ----------
    function countSentMessages(text) {
      const needle = normText(text).slice(0, 80);
      if (!needle) return 0;
      return qsAll(adapter.userMsg).filter((el) => normText(el.innerText).includes(needle)).length;
    }

    // ---------- 写入文本 ----------
    function setText(text) {
      const editor = findEditor();
      if (!editor) { console.warn('[PromptSync] 未找到输入框'); return false; }
      editor.focus();
      if (editor.isContentEditable) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(editor);
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      } else {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(editor, text);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return true;
    }

    // ---------- 注入图片/文件（逐个重建 paste 事件） ----------
    // Gemini 在忙于处理上一张图片时会吞掉紧随其后的 paste（固定 250ms 间隔太短，
    // 导致第二张图根本没触发上传）。因此下一张必须等到上一张的上传被网络层确认
    // 开始（uploadNet.started 自增）或超时后再粘贴，确保站点已就绪。
    function pasteFiles(files, i) {
      i = i || 0;
      const editor = findEditor();
      if (!editor || i >= files.length) return;
      editor.focus();
      const startedBefore = uploadNet.started;
      const dt = new DataTransfer();
      dt.items.add(files[i]);
      editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      dlog(`注入文件 ${i + 1}/${files.length}：${files[i].name || 'file'}`);
      if (i + 1 >= files.length) return;

      const next = () => pasteFiles(files, i + 1);
      const deadline = Date.now() + 4000; // 网络层未观测到上传时的兜底放行
      const waitThenNext = () => {
        const seen = uploadNet.started > startedBefore;
        if (seen || Date.now() > deadline) {
          if (!seen) dlog(`注入文件：未观测到第 ${i + 1} 张上传，超时后继续下一张`);
          setTimeout(next, 300); // 上传已起飞，留点缓冲再粘下一张
          return;
        }
        setTimeout(waitThenNext, 150);
      };
      setTimeout(waitThenNext, 250);
    }

    // ---------- 上传检测范围与指示器 ----------
    function uploadScope() {
      let el = qsFirst(adapter.uploadScope);
      if (el) return el;
      el = findSend() && findSend().closest('form');
      if (el) return el;
      const editor = findEditor();
      if (editor) {
        const f = editor.closest('form');
        if (f) return f;
        // 站点无 <form>：从编辑器向上爬几层圈住附件预览区
        let cur = editor;
        for (let i = 0; cur.parentElement && i < 4; i++) cur = cur.parentElement;
        return cur;
      }
      return document;
    }
    function uploadIndicator() {
      const scope = uploadScope();
      return qsAll(adapter.uploading, scope)[0] ? (adapter.uploading.split(',')[0] || 'indicator') : null;
    }
    function isUploading() { return qsAll(adapter.uploading, uploadScope()).length > 0; }

    // ---------- 附带文件时，上传是否已确认完成（三道闸 + 8s 超时放行） ----------
    function uploadsSettled(token, seq) {
      if (uploadNet.active > 0) return false;
      if (isUploading()) return false;
      const seen = uploadNet.started - (tokenUpBase.get(token) || 0);
      // 2.5s 静默确认：分片/收尾请求之间有间隙，且部分站点网络完成后还要处理缩略图
      if (seen > 0) return Date.now() - uploadNet.lastChangeAt > 2500;
      if (Date.now() - (tokenStartAt.get(token) || 0) > 8000) {
        if (!graceWarned.has(token)) {
          graceWarned.add(token);
          dlog(`警告(seq=${seq})：附带文件但 8 秒内未观测到任何上传活动，超时放行发送`);
        }
        return true;
      }
      return false;
    }

    // ---------- 发送任务状态 ----------
    let sendToken = 0;
    let sentTokens = new Set();
    const tokenBaselines = new Map();
    const waitLogAt = new Map();
    const tokenStartAt = new Map();
    const tokenUpBase = new Map();
    const graceWarned = new Set();
    // 已做过"安全重试"的 token（每任务最多重试一次，防无限重试）
    const retriedTokens = new Set();

    function cancelPendingSends(reason) {
      sendToken++;
      dlog('取消排队中的自动发送任务：' + (reason || '未注明原因'));
    }

    // ---------- 兜底：直接在编辑器上按回车发送 ----------
    function pressEnter(expectedText, seq) {
      const editor = findEditor();
      if (!editor) { dlog(`回车兜底失败(seq=${seq})：未找到输入框`); return; }
      if (isGenerating()) { dlog(`回车兜底放弃(seq=${seq})：正在生成回复`); return; }
      if (!contentMatches(expectedText)) { dlog(`回车兜底放弃(seq=${seq})：输入框内容已变化`); return; }
      if (seqAlreadySent(seq)) { dlog(`回车兜底放弃(seq=${seq})：该条消息已被其他实例发送（防重锁）`); return; }
      markSeqSent(seq);
      dlog(`执行回车兜底发送(seq=${seq})`);
      editor.focus();
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      editor.dispatchEvent(new KeyboardEvent('keydown', opts));
      editor.dispatchEvent(new KeyboardEvent('keypress', opts));
      editor.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    // ---------- 点击发送（核心防重逻辑，原样移植） ----------
    function clickSend(hasFiles, expectedText, token, seq, retries, genDeadline, calm) {
      if (retries === undefined) retries = 60;
      if (genDeadline === undefined) genDeadline = Date.now() + 10 * 60 * 1000;
      if (calm === undefined) calm = 0;
      if (sentTokens.has(token)) return;
      if (token !== sendToken) { dlog(`放弃发送(seq=${seq})：已有更新的同步任务取代了它`); return; }
      if (!tokenBaselines.has(token)) {
        tokenBaselines.set(token, countSentMessages(expectedText));
        if (!tokenStartAt.has(token)) tokenStartAt.set(token, Date.now());
        if (hasFiles) {
          const scope = uploadScope();
          const scopeDesc = scope === document ? 'document'
            : `<${(scope.tagName || '?').toLowerCase()}${scope.className ? ' class="' + String(scope.className).slice(0, 60) + '"' : ''}>`;
          dlog(`上传检测环境(seq=${seq})：范围=${scopeDesc} DOM指示器=${uploadIndicator() || '无'} ` +
            `网络上传(进行中=${uploadNet.active} 本任务已见=${uploadNet.started - (tokenUpBase.get(token) || 0)})`);
        }
      }
      if (countSentMessages(expectedText) > tokenBaselines.get(token)) {
        sentTokens.add(token); markSeqSent(seq);
        dlog(`确认发送成功(seq=${seq})：消息已出现在对话中，不再点击`);
        return;
      }
      if (!contentMatches(expectedText)) {
        dlog(`放弃发送(seq=${seq})：输入框内容与同步文本不一致。` +
          `期望="${normText(expectedText).slice(0, 40)}" 实际="${normText(getEditorText()).slice(0, 40)}"`);
        return;
      }
      if (seqAlreadySent(seq)) {
        sentTokens.add(token);
        dlog(`放弃发送(seq=${seq})：该条消息已被本站点其他页面实例发送（防重锁）`);
        return;
      }
      const btn = findSend();
      const ready = btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
      const generating = isGenerating();
      if (ready && !generating && !isStopButton(btn) && (!hasFiles || uploadsSettled(token, seq))) {
        if (calm < 1) {
          setTimeout(() => clickSend(hasFiles, expectedText, token, seq, retries, genDeadline, calm + 1), 250);
          return;
        }
        sentTokens.add(token); markSeqSent(seq);
        dlog(`点击发送按钮(seq=${seq})，文本="${normText(expectedText).slice(0, 40)}"`);
        btn.click();
        if (sentTokens.size > 10) {
          const old = [...sentTokens].sort((a, b) => a - b)[0];
          sentTokens.delete(old); tokenBaselines.delete(old); waitLogAt.delete(old);
          tokenStartAt.delete(old); tokenUpBase.delete(old); graceWarned.delete(old); retriedTokens.delete(old);
        }
        if ((expectedText || '').trim()) {
          // 带文件时验证窗口延长到 12s：图片上传/服务端处理可能慢，给安全重试留足时间
          const verifyUntil = Date.now() + (hasFiles ? 12000 : 5000);
          const verify = () => {
            if (token !== sendToken) return;
            if (countSentMessages(expectedText) > tokenBaselines.get(token)) { dlog(`发送成功(seq=${seq})：对话中已出现该消息`); return; }
            if (!contentMatches(expectedText)) { dlog(`发送成功(seq=${seq})：输入框已清空/内容已变化`); return; }
            if (isGenerating()) { dlog(`发送成功(seq=${seq})：已检测到正在生成回复`); return; }
            if (Date.now() < verifyUntil) { setTimeout(verify, 250); return; }
            // 到这里：迟迟没有任何"已发出"迹象。前面的 contentMatches 检查保证了
            // 输入框里仍是我们写的那段原文 → 铁证根本没发出去，再点一次绝不会重复。
            // 仅当：没在生成回复、发送键可点且非停止态、（带文件时）上传已确认完成。
            const btn2 = findSend();
            const canRetry = !retriedTokens.has(token) && !isGenerating() &&
              btn2 && !btn2.disabled && btn2.getAttribute('aria-disabled') !== 'true' &&
              !isStopButton(btn2) && (!hasFiles || uploadsSettled(token, seq));
            if (canRetry) {
              retriedTokens.add(token);
              dlog(`安全重试发送(seq=${seq})：输入框文本仍在=确未发出，再点一次（每任务仅一次）`);
              btn2.click();
              const t2 = Date.now() + 6000;
              const verify2 = () => {
                if (token !== sendToken) return;
                if (countSentMessages(expectedText) > tokenBaselines.get(token)) { dlog(`重试后发送成功(seq=${seq})：对话中已出现该消息`); return; }
                if (!contentMatches(expectedText)) { dlog(`重试后发送成功(seq=${seq})：输入框已清空`); return; }
                if (isGenerating()) { dlog(`重试后发送成功(seq=${seq})：正在生成回复`); return; }
                if (Date.now() < t2) { setTimeout(verify2, 300); return; }
                dlog(`警告(seq=${seq})：重试后仍未检测到发送成功，请手动点击发送`);
              };
              setTimeout(verify2, 400);
              return;
            }
            dlog(`警告(seq=${seq})：点击后未检测到任何发送成功信号；为避免重复发送不会自动重试，若未发出请手动点击发送`);
          };
          setTimeout(verify, 250);
        }
        return;
      }
      if (Date.now() - (waitLogAt.get(token) || 0) > 3000) {
        waitLogAt.set(token, Date.now());
        let upDesc = '无文件';
        if (hasFiles) {
          const ind = uploadIndicator();
          const seen = uploadNet.started - (tokenUpBase.get(token) || 0);
          upDesc = `${!!ind || uploadNet.active > 0}[DOM指示=${ind || '无'} 网络进行中=${uploadNet.active} ` +
            `本任务已见=${seen} 距上次活动=${uploadNet.lastChangeAt ? Date.now() - uploadNet.lastChangeAt + 'ms' : '从未'}]`;
        }
        dlog(`等待发送条件(seq=${seq})：按钮就绪=${!!ready} 生成中=${generating} 停止态按钮=${isStopButton(btn)} 上传中=${upDesc} 剩余重试=${retries}`);
      }
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

    // ---------- 开启新对话 ----------
    // 元素描述（日志用）
    function descEl(el) {
      if (!el) return '(null)';
      return `<${el.tagName.toLowerCase()} class="${(typeof el.className === 'string' ? el.className : '').slice(0, 50)}" aria="${el.getAttribute('aria-label') || ''}" text="${(el.textContent || '').trim().slice(0, 16)}">`;
    }
    // 真实点击：很多 div 按钮只认 mousedown/up（pointer）序列，单纯 .click() 无效
    function realClick(el) {
      const o = { bubbles: true, cancelable: true, view: window };
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) { /* 老内核降级 */ }
      el.dispatchEvent(new MouseEvent('mousedown', o));
      try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) { /* ignore */ }
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.dispatchEvent(new MouseEvent('click', o));
      if (typeof el.click === 'function') el.click();
    }

    function openNewChat() {
      let btn = qsFirst(adapter.newChat);
      let how = btn ? `CSS命中(${adapter.newChat})` : `CSS未命中(${adapter.newChat || '空'})`;
      // 兜底：按可见文字找“新建对话”按钮。比哈希 class 稳得多——
      // DeepSeek「开启新对话」、Qwen「新建对话」改版后类名会变，文字基本不变。
      if (!btn && adapter.newChatText) {
        try {
          const re = new RegExp(adapter.newChatText, 'i');
          // 注意要含 div/span/li：Qwen 的「新建对话」是 <div> 不是 button/a，只扫 button/a 会漏。
          const all = [...document.querySelectorAll('a, button, [role="button"], [class*="new" i], div, span, li')]
            .filter((el) => isVisible(el))
            .map((el) => ({ el, t: ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim() }))
            .filter((o) => re.test(o.t) && o.t.length < 24);   // 限长，避开命中长文本块
          // 关键：剔除"包含了另一个候选"的外层容器（如 Qwen 的 sidebar-entry-fixed-list），
          // 只留最内层真按钮——之前点中外层容器没 handler，所以不开新对话。
          const inner = all.filter((o) => !all.some((o2) => o2.el !== o.el && o.el.contains(o2.el)));
          const pool = (inner.length ? inner : all).sort((a, b) => a.t.length - b.t.length);
          how += ` | 文字候选=${all.length}/最内层=${inner.length}` + (pool.length ? ` 取="${pool[0].t}"` : '');
          if (pool.length) btn = pool[0].el;
        } catch (e) { how += ' | 文字匹配异常:' + e.message; }
      }
      if (btn) {
        dlog(`openNewChat: ${how} → 点击 ${descEl(btn)}`);
        realClick(btn);
        return;
      }
      const key = (adapter.newChatKey || '').toLowerCase();
      dlog(`openNewChat: ${how} | 未找到按钮，快捷键=${key || '无'}` + (key ? '（改用快捷键）' : '（直接在当前对话发送）'));
      if (!key) return;
      const parts = key.split('+').map((s) => s.trim());
      const main = parts[parts.length - 1];
      const opts = {
        key: main.toUpperCase(), code: 'Key' + main.toUpperCase(),
        keyCode: main.toUpperCase().charCodeAt(0), which: main.toUpperCase().charCodeAt(0),
        metaKey: parts.includes('meta') || parts.includes('cmd'),
        ctrlKey: parts.includes('ctrl'),
        shiftKey: parts.includes('shift'),
        altKey: parts.includes('alt'),
        bubbles: true, cancelable: true,
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
      // 多目标过滤：targets 非空且不含本站则忽略（但已更新 lastSeq 去重）
      if (Array.isArray(p.targets) && p.targets.length && !p.targets.includes(SITE)) return;
      dlog(`收到广播 seq=${p.seq} 发送=${!!p.send} 新对话=${!!p.newChat} 文件=${(p.files || []).length} 文本="${normText(p.text).slice(0, 40)}"`);

      const run = () => {
        const files = (p.files || []).map((f) => dataUrlToFile(f.data, f.name));
        const upBase = uploadNet.started;
        if (files.length) pasteFiles(files);
        if (p.text) {
          const ok = setText(p.text);
          dlog(ok ? '已写入文本到输入框' : '写入文本失败：未找到输入框');
        }
        if (p.send) {
          if (!(p.text || '').trim() && !files.length) { dlog(`忽略空内容的发送广播 seq=${p.seq}`); return; }
          const token = ++sendToken;
          tokenStartAt.set(token, Date.now());
          tokenUpBase.set(token, upBase);
          const delay = files.length ? 600 + files.length * 250 : 300;
          setTimeout(() => clickSend(files.length > 0, p.text || '', token, p.seq), delay);
        }
      };

      if (p.newChat) { openNewChat(); setTimeout(run, 1200); } else { run(); }
    }

    // ---------- 广播 ----------
    function broadcast(payload) {
      if (!extAlive()) { alert('PromptSync 已重新加载，请刷新本页面后再使用'); return; }
      chrome.storage.local.set({ dual_ai_prompt: payload });
      applyPayload(payload); // 本页也执行
    }
    function send(text, files, doSend, newChat, targets) {
      broadcast({ seq: Date.now(), text, files: files || [], send: doSend, newChat: !!newChat, targets: targets || [] });
    }

    // ---------- 浮动面板（可按站点单独显隐；隐藏后本页仍参与同步） ----------
    let rebuildTargets = () => {};
    let syncTargets = () => {};
    let applyMinimize = () => {};
    let panelEl = null;
    ensurePanel();

    // 按 adapter.showPanel 决定建/拆浮框（默认显示）
    function ensurePanel() {
      const show = adapter.showPanel !== false;
      if (show && !panelEl) {
        createPanel();
      } else if (!show && panelEl) {
        panelEl.remove(); panelEl = null;
        rebuildTargets = () => {}; syncTargets = () => {}; applyMinimize = () => {};
      }
    }

    function createPanel() {
      const panel = document.createElement('div');
      Object.assign(panel.style, {
        position: 'fixed', right: '24px', bottom: '110px', width: '384px',
        zIndex: '2147483647', background: 'rgba(255,255,255,0.12)',
        border: '1px solid rgba(200,200,200,0.6)', borderRadius: '12px',
        padding: '12px', fontSize: '14px', boxShadow: '0 4px 18px rgba(0,0,0,0.2)',
        color: '#111', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
      });
      panel.innerHTML = `
        <div id="dai-head" style="font-weight:bold;margin-bottom:4px;cursor:move;user-select:none;display:flex;justify-content:space-between;align-items:center;">
          <span>⠿ PromptSync v${VERSION} · ${adapter.name}</span>
          <span style="display:flex;gap:8px;">
            <span id="dai-cfg" title="设置" style="cursor:pointer;">⚙</span>
            <span id="dai-min" title="收起" style="cursor:pointer;">—</span>
            <span id="dai-hide" title="在本页隐藏浮框（可在扩展弹窗里重新打开）" style="cursor:pointer;">✕</span>
          </span>
        </div>
        <div id="dai-body">
          <div id="dai-targets" style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px;margin-bottom:6px;"></div>
          <textarea id="dai-text" placeholder="输入问题，回车=同步发送 / Shift+Enter 换行；可粘贴或拖拽多张图片/文件"
            style="width:100%;height:96px;box-sizing:border-box;background:rgba(255,255,255,0.15);"></textarea>
          <div id="dai-files" style="font-size:12px;color:#0a0;margin-top:4px;display:flex;flex-direction:column;gap:2px;"></div>
          <div style="display:flex;gap:0;margin-top:4px;">
            <button id="dai-fill" style="flex:1;padding:3px 0;">同步填入</button>
            <button id="dai-send" style="flex:1;padding:3px 0;">同步发送</button>
            <button id="dai-new" style="flex:1;padding:3px 0;">新窗口发送</button>
          </div>
          <div style="display:flex;gap:0;margin-top:2px;">
            <button id="dai-log" style="flex:2;padding:2px 0;font-size:12px;">导出诊断日志</button>
            <button id="dai-clearlog" style="flex:1;padding:2px 0;font-size:12px;">清空日志</button>
          </div>
        </div>`;
      document.body.appendChild(panel);
      panelEl = panel;

      const ta = panel.querySelector('#dai-text');
      const fileList = panel.querySelector('#dai-files');
      const targetsBox = panel.querySelector('#dai-targets');
      const body = panel.querySelector('#dai-body');
      let pendingFiles = [];

      // 勾选某站点为目标（缺省视为勾选）
      const isTargetOn = (id) => !(id in targetState) || targetState[id] !== false;
      // 目标站点勾选框：列出所有已启用站点，勾选状态来自持久化的 targetState
      rebuildTargets = () => {
        const enabled = sites.filter((s) => s.enabled !== false);
        targetsBox.innerHTML = '';
        enabled.forEach((s) => {
          const lbl = document.createElement('label');
          lbl.style.cssText = 'display:flex;align-items:center;gap:3px;cursor:pointer;';
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.value = s.id;
          cb.checked = isTargetOn(s.id);
          cb.onchange = () => {
            targetState[s.id] = cb.checked;
            try { chrome.storage.local.set({ dai_targets: targetState }); } catch (e) { /* 上下文失联 */ }
          };
          lbl.appendChild(cb);
          lbl.appendChild(document.createTextNode(s.name));
          targetsBox.appendChild(lbl);
        });
      };
      // 仅同步勾选态（别的标签页改了 targetState 时调用，不重建 DOM）
      syncTargets = () => {
        targetsBox.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = isTargetOn(c.value); });
      };
      rebuildTargets();
      const getTargets = () => [...targetsBox.querySelectorAll('input:checked')].map((c) => c.value);

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
          row.appendChild(label); row.appendChild(del);
          fileList.appendChild(row);
        });
      };
      const clear = () => { ta.value = ''; pendingFiles = []; renderFiles(); };
      const addFiles = (files) => {
        [...files].forEach((file) => {
          const reader = new FileReader();
          reader.onload = () => { pendingFiles.push({ name: file.name || 'file', type: file.type, data: reader.result }); renderFiles(); };
          reader.readAsDataURL(file);
        });
      };

      ta.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
        if (!files.length) return;
        e.preventDefault();
        addFiles(files);
      });

      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      ['dragenter', 'dragover'].forEach((ev) => panel.addEventListener(ev, (e) => { stop(e); panel.style.outline = '2px dashed #0a0'; }));
      ['dragleave', 'drop'].forEach((ev) => panel.addEventListener(ev, (e) => { stop(e); panel.style.outline = ''; }));
      panel.addEventListener('drop', (e) => { const files = [...(e.dataTransfer?.files || [])]; if (files.length) addFiles(files); });

      ta.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (e.repeat) return;
          if (!ta.value.trim() && !pendingFiles.length) return;
          send(ta.value, pendingFiles, true, false, getTargets());
          clear();
        }
      });

      panel.querySelector('#dai-fill').onclick = () => send(ta.value, pendingFiles, false, false, getTargets());
      panel.querySelector('#dai-send').onclick = () => {
        if (!ta.value.trim() && !pendingFiles.length) return;
        send(ta.value, pendingFiles, true, false, getTargets()); clear();
      };
      panel.querySelector('#dai-new').onclick = () => {
        if (!ta.value.trim() && !pendingFiles.length) return;
        send(ta.value, pendingFiles, true, true, getTargets()); clear();
      };
      panel.querySelector('#dai-cfg').onclick = () => chrome.runtime.sendMessage({ type: 'open-options' });
      // 折叠/展开同步到持久化的 minimized（设置页与 — 按钮共用同一状态）
      applyMinimize = () => {
        const collapsed = adapter.minimized === true;
        body.style.display = collapsed ? 'none' : '';
        panel.querySelector('#dai-min').textContent = collapsed ? '＋' : '—';
      };
      applyMinimize(); // 按持久化的默认折叠态初始化
      panel.querySelector('#dai-min').onclick = () => {
        const collapse = body.style.display !== 'none'; // 当前展开 → 这次要折叠
        body.style.display = collapse ? 'none' : '';
        panel.querySelector('#dai-min').textContent = collapse ? '＋' : '—';
        setSiteFlag(SITE, 'minimized', collapse);
      };
      panel.querySelector('#dai-hide').onclick = () => {
        // 写入 showPanel=false → onChanged 触发 ensurePanel 拆掉本页浮框
        setSiteFlag(SITE, 'showPanel', false);
      };

      panel.querySelector('#dai-log').onclick = () => {
        if (!extAlive()) { alert('PromptSync 已重新加载，请刷新本页面后再使用'); return; }
        chrome.storage.local.get(null, (all) => {
          let lines = [];
          Object.keys(all).forEach((k) => { if (k.startsWith('dai_logs_')) lines = lines.concat(all[k] || []); });
          const text = lines.sort().join('\n') || '(暂无日志)';
          console.log('===== PromptSync 诊断日志 =====\n' + text);
          const done = () => alert(`已导出 ${lines.length} 条日志：已复制到剪贴板，并打印到控制台(F12)`);
          const fail = () => alert('日志已打印到控制台(F12 查看)，剪贴板复制失败');
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
          else fail();
        });
      };
      panel.querySelector('#dai-clearlog').onclick = () => {
        if (!extAlive()) { alert('PromptSync 已重新加载，请刷新本页面后再使用'); return; }
        chrome.storage.local.get(null, (all) => {
          const clearKeys = {};
          Object.keys(all).forEach((k) => { if (k.startsWith('dai_logs_')) clearKeys[k] = []; });
          chrome.storage.local.set(clearKeys);
          logBuf = [];
          alert('日志已清空');
        });
      };

      // 拖拽移动面板
      const head = panel.querySelector('#dai-head');
      let drag = null;
      head.addEventListener('mousedown', (e) => {
        if (e.target.id === 'dai-cfg' || e.target.id === 'dai-min' || e.target.id === 'dai-hide') return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
        panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        panel.style.left = (e.clientX - drag.dx) + 'px';
        panel.style.top = (e.clientY - drag.dy) + 'px';
      });
      document.addEventListener('mouseup', () => { drag = null; });

      // 上下文失联自检：扩展被「重新加载」后旧脚本会失联，面板会假死。
      // 这里把标题自动变红提示「请刷新本页」，省得用户对着没反应的面板猜。
      const titleSpan = panel.querySelector('#dai-head').firstElementChild;
      setInterval(() => {
        if (!extAlive() && titleSpan && !titleSpan.dataset.dead) {
          titleSpan.dataset.dead = '1';
          titleSpan.textContent = '⚠ PromptSync 已更新 · 请刷新本页';
          titleSpan.style.color = '#c00';
        }
      }, 2000);
    }
  }
})();
