// PromptSync 弹窗：快速开关各站点「同步参与」与「浮框显隐」
const listEl = document.getElementById('list');

function buildSites(config) {
  const overrides = (config && config.sites) || {};
  const rows = window.DAI_PRESETS.map((p) => ({
    id: p.id, name: p.name,
    enabled: (overrides[p.id] || {}).enabled !== false,
    showPanel: (overrides[p.id] || {}).showPanel !== false,
    preset: true,
  }));
  Object.keys(overrides).forEach((id) => {
    if (rows.some((r) => r.id === id)) return;
    const o = overrides[id];
    if (!o || !o.name) return;
    rows.push({ id, name: o.name, enabled: o.enabled !== false, showPanel: o.showPanel !== false, preset: false });
  });
  return rows;
}

chrome.storage.local.get('dai_config', (o) => {
  const config = o.dai_config || { version: 1, sites: {} };

  const setFlag = (id, key, val) => {
    const next = config.sites || (config.sites = {});
    next[id] = Object.assign({}, next[id], { [key]: val });
    chrome.storage.local.set({ dai_config: config });
  };

  const mkToggle = (id, key, checked) => {
    const wrap = document.createElement('span');
    wrap.className = 'tg';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = checked;
    cb.onchange = () => setFlag(id, key, cb.checked);
    wrap.appendChild(cb);
    return wrap;
  };

  buildSites(config).forEach((s) => {
    const row = document.createElement('div');
    row.className = 'site';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name + (s.preset ? '' : '（自定义）');
    row.appendChild(name);
    row.appendChild(mkToggle(s.id, 'enabled', s.enabled));
    row.appendChild(mkToggle(s.id, 'showPanel', s.showPanel));
    listEl.appendChild(row);
  });
});

document.getElementById('opt').onclick = () => chrome.runtime.openOptionsPage();
