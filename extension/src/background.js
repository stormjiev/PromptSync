// PromptSync 后台 service worker
// 1) 响应面板里的"打开设置"
// 2) 为用户在设置页新增的自定义站点动态注册内容脚本（无需重新打包扩展）
//    —— 这是"方便配置其它网页 AI"的关键：用户填好域名+选择器，授权后即可生效。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'open-options') {
    chrome.runtime.openOptionsPage();
  }
  return false;
});

// 内置静态匹配（manifest 已注册），自定义站点才需要动态注册
const BUILTIN_HOSTS = [
  'chatgpt.com', 'chat.openai.com', 'gemini.google.com',
  'chat.deepseek.com', 'chat.qwen.ai', 'tongyi.aliyun.com', 'meta.ai',
];

async function syncDynamicScripts() {
  const { dai_config } = await chrome.storage.local.get('dai_config');
  const overrides = (dai_config && dai_config.sites) || {};
  // 找出自定义站点（带 hosts、且不是内置域名）
  const customSites = Object.keys(overrides)
    .map((id) => Object.assign({ id }, overrides[id]))
    .filter((s) => s.enabled !== false && Array.isArray(s.hosts) && s.hosts.length &&
      !s.hosts.some((h) => BUILTIN_HOSTS.some((b) => h.includes(b))));

  // 只为已授权的域名注册，避免无权限报错
  const granted = await chrome.permissions.getAll();
  const grantedOrigins = granted.origins || [];
  function originAllowed(host) {
    return grantedOrigins.some((o) => o === '*://*/*' || o.includes(host));
  }

  const desired = [];
  customSites.forEach((s) => {
    const matches = s.hosts.filter(originAllowed).map((h) => `*://*.${h.replace(/^\*?\.?/, '')}/*`);
    const plain = s.hosts.filter(originAllowed).map((h) => `*://${h.replace(/^\*?\.?/, '')}/*`);
    const all = [...new Set([...matches, ...plain])];
    if (!all.length) return;
    desired.push(
      { id: `dai-main-${s.id}`, matches: all, js: ['src/inject-main.js'], runAt: 'document_start', world: 'MAIN' },
      { id: `dai-iso-${s.id}`, matches: all, js: ['src/adapters.js', 'src/content.js'], runAt: 'document_idle', world: 'ISOLATED' }
    );
  });

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const toRemove = existing.filter((e) => e.id.startsWith('dai-')).map((e) => e.id);
    if (toRemove.length) await chrome.scripting.unregisterContentScripts({ ids: toRemove });
    if (desired.length) await chrome.scripting.registerContentScripts(desired);
  } catch (e) {
    console.warn('[PromptSync] 动态注册自定义站点脚本失败：', e);
  }
}

chrome.runtime.onInstalled.addListener(syncDynamicScripts);
chrome.runtime.onStartup.addListener(syncDynamicScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.dai_config) syncDynamicScripts();
});
