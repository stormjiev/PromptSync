// PromptSync 设置页逻辑
const PRESETS = window.DAI_PRESETS;
const PRESET_IDS = new Set(PRESETS.map((p) => p.id));
const FIELDS = ['name', 'editor', 'send', 'userMsg', 'uploading', 'uploadScope', 'stop', 'newChat', 'newChatKey'];

const sitesEl = document.getElementById('sites');
const statusEl = document.getElementById('status');

function setStatus(msg) {
  statusEl.textContent = msg;
  if (msg) setTimeout(() => { statusEl.textContent = ''; }, 2500);
}

// 把"预设 + 用户覆盖"合并成用于渲染的完整站点列表
function buildRows(config) {
  const overrides = (config && config.sites) || {};
  const rows = [];
  PRESETS.forEach((p) => {
    const o = overrides[p.id] || {};
    rows.push({
      id: p.id, preset: true,
      enabled: o.enabled !== false,
      showPanel: o.showPanel !== false,
      minimized: o.minimized === true,
      hosts: (Array.isArray(o.hosts) && o.hosts.length ? o.hosts : p.hosts).join(', '),
      // 预设站点：输入框显示覆盖值（空＝用默认，placeholder 提示默认）
      values: FIELDS.reduce((m, f) => { m[f] = o[f] || ''; return m; }, {}),
      defaults: FIELDS.reduce((m, f) => { m[f] = p[f] || ''; return m; }, {}),
    });
  });
  // 自定义站点
  Object.keys(overrides).forEach((id) => {
    if (PRESET_IDS.has(id)) return;
    const o = overrides[id];
    rows.push({
      id, preset: false,
      enabled: o.enabled !== false,
      showPanel: o.showPanel !== false,
      minimized: o.minimized === true,
      hosts: (o.hosts || []).join(', '),
      values: FIELDS.reduce((m, f) => { m[f] = o[f] || ''; return m; }, {}),
      defaults: FIELDS.reduce((m, f) => { m[f] = ''; return m; }, {}),
    });
  });
  return rows;
}

function renderRow(row) {
  const node = document.getElementById('site-tpl').content.cloneNode(true);
  const el = node.querySelector('.site');
  el.dataset.id = row.id;
  el.dataset.preset = row.preset ? '1' : '0';
  el.querySelector('.f-enabled').checked = row.enabled;
  el.querySelector('.f-showPanel').checked = row.showPanel;
  el.querySelector('.f-minimized').checked = row.minimized;
  el.querySelector('.badge').textContent = row.preset ? '内置' : '自定义';
  el.querySelector('.f-hosts').value = row.hosts;
  FIELDS.forEach((f) => {
    const input = el.querySelector('.f-' + f);
    input.value = row.values[f];
    if (row.preset && row.defaults[f]) input.placeholder = row.defaults[f];
  });
  el.querySelector('.del').onclick = () => {
    if (row.preset) {
      // 内置站点不真正删除，只是取消勾选（停用）
      el.querySelector('.f-enabled').checked = false;
      setStatus('内置站点已停用（不会被删除）');
    } else {
      el.remove();
    }
  };
  sitesEl.appendChild(node);
}

function collectConfig() {
  const sites = {};
  sitesEl.querySelectorAll('.site').forEach((el) => {
    const id = el.dataset.id;
    const preset = el.dataset.preset === '1';
    const entry = {
      enabled: el.querySelector('.f-enabled').checked,
      showPanel: el.querySelector('.f-showPanel').checked,
      minimized: el.querySelector('.f-minimized').checked,
    };
    const hosts = el.querySelector('.f-hosts').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (hosts.length) entry.hosts = hosts;
    FIELDS.forEach((f) => {
      const v = el.querySelector('.f-' + f).value.trim();
      if (v) entry[f] = v;
    });
    // 自定义站点必须有名称和域名才有意义
    if (!preset && (!entry.name || !entry.hosts)) return;
    sites[id] = entry;
  });
  return { version: 1, sites };
}

// 自定义站点保存后，请求其域名的访问权限（动态注册内容脚本需要）
async function requestCustomPermissions(config) {
  const origins = [];
  Object.keys(config.sites).forEach((id) => {
    if (PRESET_IDS.has(id)) return;
    (config.sites[id].hosts || []).forEach((h) => {
      const host = h.replace(/^\*?\.?/, '');
      origins.push(`*://${host}/*`, `*://*.${host}/*`);
    });
  });
  if (!origins.length) return true;
  try {
    return await chrome.permissions.request({ origins: [...new Set(origins)] });
  } catch (e) {
    return false;
  }
}

document.getElementById('save').onclick = async () => {
  const config = collectConfig();
  const ok = await requestCustomPermissions(config);
  chrome.storage.local.set({ dai_config: config }, () => {
    setStatus(ok ? '已保存 ✓（设置即时生效，已打开的页面可能需刷新）' : '已保存，但自定义站点未获授权，将不会在该域名生效');
  });
};

document.getElementById('add').onclick = () => {
  renderRow({
    id: 'custom-' + Date.now().toString(36),
    preset: false, enabled: true, showPanel: true, minimized: false, hosts: '',
    values: { name: '', editor: 'div[contenteditable="true"], textarea', send: 'button[type="submit"], button[aria-label*="Send" i]', userMsg: '', uploading: '[role="progressbar"], [class*="loading"]', uploadScope: '', stop: '[class*="stop"]', newChat: '', newChatKey: '' },
    defaults: FIELDS.reduce((m, f) => { m[f] = ''; return m; }, {}),
  });
  window.scrollTo(0, document.body.scrollHeight);
};

document.getElementById('reset').onclick = () => {
  if (!confirm('恢复默认会清除所有自定义站点与选择器修改，确定？')) return;
  chrome.storage.local.set({ dai_config: { version: 1, sites: {} } }, () => {
    sitesEl.innerHTML = '';
    buildRows(null).forEach(renderRow);
    setStatus('已恢复默认');
  });
};

chrome.storage.local.get('dai_config', (o) => {
  buildRows(o.dai_config).forEach(renderRow);
});
