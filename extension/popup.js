// PromptSync 弹窗：快速开关各站点是否参与同步
const listEl = document.getElementById('list');

function buildSites(config) {
  const overrides = (config && config.sites) || {};
  const rows = window.DAI_PRESETS.map((p) => ({
    id: p.id, name: p.name, enabled: (overrides[p.id] || {}).enabled !== false, preset: true,
  }));
  Object.keys(overrides).forEach((id) => {
    if (rows.some((r) => r.id === id)) return;
    const o = overrides[id];
    if (!o || !o.name) return;
    rows.push({ id, name: o.name, enabled: o.enabled !== false, preset: false });
  });
  return rows;
}

chrome.storage.local.get('dai_config', (o) => {
  const config = o.dai_config || { version: 1, sites: {} };
  buildSites(config).forEach((s) => {
    const row = document.createElement('label');
    row.className = 'site';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = s.enabled;
    cb.onchange = () => {
      const next = config.sites || (config.sites = {});
      next[s.id] = Object.assign({}, next[s.id], { enabled: cb.checked });
      chrome.storage.local.set({ dai_config: config });
    };
    row.appendChild(cb);
    row.appendChild(document.createTextNode(s.name + (s.preset ? '' : '（自定义）')));
    listEl.appendChild(row);
  });
});

document.getElementById('opt').onclick = () => chrome.runtime.openOptionsPage();
