// PromptSync 站点适配预设（数据驱动）
// ------------------------------------------------------------------
// 每个站点的全部"易随改版失效"的特征都集中在这里，并且全部可在设置页
// 可视化编辑/新增。content.js 不再硬编码任何站点细节，只消费这份数据。
//
// 字段说明（值均为 CSS 选择器，多个用英文逗号分隔，按先后顺序取第一个命中）：
//   id            站点唯一标识
//   name          展示名
//   hosts         命中该站点的 location.hostname 关键字（数组，含其一即命中）
//   editor        输入框（contenteditable 或 textarea）
//   send          发送按钮
//   userMsg       已发出的"用户消息"气泡（用于判定发送成功，最强信号）
//   uploading     上传中指示器（进度条/spinner，附带文件时等它消失）
//   uploadScope   圈定包含附件预览区的 composer 容器（缩小上传检测范围，防误判）
//   stop          流式生成时出现的"停止"按钮（生成中不点发送，避免截断回答）
//   newChat       "新建对话"按钮
//   newChatKey    新对话快捷键（兜底），如 "meta+shift+o"
// ------------------------------------------------------------------

window.DAI_PRESETS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    editor: '#prompt-textarea, div[contenteditable="true"].ProseMirror',
    send: 'button[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send" i]',
    userMsg: '[data-message-author-role="user"]',
    uploading: 'div[role="progressbar"], [data-testid="composer-attachment-loading"], .animate-spin',
    uploadScope: 'form',
    stop: 'button[data-testid="stop-button"], #composer-submit-button[aria-label*="stop" i], button[aria-label*="stop streaming" i]',
    newChat: '[data-testid="create-new-chat-button"], a[aria-label*="New chat" i]',
    newChatKey: 'meta+shift+o',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    hosts: ['gemini.google.com'],
    editor: 'rich-textarea .ql-editor[contenteditable="true"], .ql-editor[contenteditable="true"], div[contenteditable="true"]',
    send: 'button.send-button, button[aria-label*="Send" i], button[aria-label*="发送"]',
    userMsg: 'user-query, [class*="user-query"]',
    uploading: 'mat-progress-bar, [role="progressbar"], .mat-mdc-progress-bar, mat-spinner, mat-progress-spinner, .mat-mdc-progress-spinner, .uploading, .upload-progress',
    // Gemini 没有 <form>，必须显式圈定 composer 容器，否则上传进度条永远检测不到
    uploadScope: 'input-area-v2, input-area, .input-area-container, .input-area',
    stop: 'button.send-button.stop, button[aria-label*="stop response" i], button[aria-label*="停止回答"], button[aria-label*="停止生成"]',
    newChat: '[data-test-id="new-chat-button"], button[aria-label*="New chat" i], button[aria-label*="新对话"]',
    newChatKey: 'meta+shift+o',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hosts: ['chat.deepseek.com'],
    // 实测：输入框 textarea#chat-input
    editor: '#chat-input, textarea[id*="chat"], textarea',
    // 实测：发送键为 div[role="button"].ds-button--primary（点击即发送）
    send: 'div[role="button"].ds-button--primary, div[role="button"][aria-label*="send" i], button[type="submit"]',
    // 实测：消息容器 .ds-message（助手回复内含 .ds-markdown，用户气泡不含）
    userMsg: '.ds-message',
    uploading: '[role="progressbar"], [class*="uploading"]',
    uploadScope: '',
    stop: '.ds-button--primary[aria-label*="stop" i], div[class*="stop"], button[aria-label*="停止"]',
    // 实测：侧栏顶部图标按钮 div._5a8ac7a（内含 .ds-icon._1c42ad7）点击即开新对话。
    // DeepSeek 类名是哈希、改版会变 → 失效时在设置页 F12 重指此选择器。
    // 故意留空 newChatKey：DeepSeek 的 Cmd+J 与本机快捷键冲突，只点按钮、不发快捷键。
    newChat: '._5a8ac7a, .ds-icon._1c42ad7',
    newChatText: '开启新对话|新建对话|新对话|new chat',
    newChatKey: '',
  },
  {
    id: 'qwen',
    name: 'Qwen（通义千问）',
    hosts: ['chat.qwen.ai', 'tongyi.aliyun.com'],
    // 实测 chat.qwen.ai：输入框 textarea.message-input-textarea
    editor: 'textarea.message-input-textarea, textarea#chat-input, textarea[placeholder], textarea',
    // 登录后真实发送键待用户回填（见 README/对话）；先列多候选 + 仅点可见元素，
    // 避开未登录欢迎页遗留的隐藏 button.send-button（之前“填了点不动”的元凶）
    send: 'button.send-button, .message-input-right-button-send button, .message-input-right-button-send, button[class*="send"], button[aria-label*="发送"], button[aria-label*="send" i], .chat-prompt-send-button',
    userMsg: 'div[class*="user"], div[class*="question"], [class*="human"]',
    uploading: '[role="progressbar"], [class*="uploading"], .ant-spin',
    uploadScope: '',
    stop: 'button[aria-label*="stop" i], button[aria-label*="停止"], .icon-stop',
    newChat: '.new-chat, button[class*="new"]',
    newChatText: '新建对话|新对话|new chat',
    newChatKey: '',
  },
];

// 合并预设 + 用户覆盖（覆盖项为空字符串时回退到预设值，避免误删整列功能）
window.DAI_mergeSite = function (preset, override) {
  const out = Object.assign({}, preset);
  if (!override) return out;
  ['name', 'editor', 'send', 'userMsg', 'uploading', 'uploadScope', 'stop', 'newChat', 'newChatKey'].forEach((k) => {
    if (typeof override[k] === 'string' && override[k] !== '') out[k] = override[k];
  });
  if (Array.isArray(override.hosts) && override.hosts.length) out.hosts = override.hosts;
  if (typeof override.enabled === 'boolean') out.enabled = override.enabled;
  return out;
};

// 根据当前页 hostname 找到匹配的站点配置（已合并用户覆盖）
window.DAI_matchSite = function (sites, hostname) {
  return sites.find((s) => s.enabled !== false && (s.hosts || []).some((h) => hostname.includes(h))) || null;
};
