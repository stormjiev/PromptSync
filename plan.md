# 双 AI 同步输入（ChatGPT + Gemini）

## 目标

在一个浮动小框里输入问题（或粘贴图片），回车后 **ChatGPT 和 Gemini 两个网页自动填入并发送**，实现"问一次，两边同时答"。

## 使用前提

- 浏览器：**Chrome**（Safari 的 Tampermonkey 对 `GM_*` 跨标签通信支持差，不用）
- 扩展：**Tampermonkey**，且在 `chrome://extensions` 里：
  - 开启「开发者模式」
  - 在 Tampermonkey 详情页开启「**允许用户脚本 / Allow user scripts**」（MV3 必须，否则脚本不注入）
- 两个网页都保持登录：`chatgpt.com`、`gemini.google.com`
- 两个标签必须在**同一浏览器、同一 Tampermonkey** 下才会联动

## 交互设计

- 浮动面板**只在 ChatGPT 页面显示**；Gemini 页面不显示框，但**后台照常接收并执行**
- 输入框：**回车 = 两边发送**，**Shift+Enter = 换行**
- 支持**粘贴图片**：图片转 base64 跨标签广播，在每个页面重建 `paste` 事件注入
- 三个按钮：
  - **两边填入**：只填入不发送（先确认再手动发）
  - **两边发送**：在**当前对话**里继续问
  - **新窗口发送**：先在两边各开一个**新对话**，再填入并发送
- 面板可**拖拽**（拖动标题栏移动）

## 技术方案

- 跨标签通信：`GM_setValue` + `GM_addValueChangeListener`，广播 payload `{seq, text, image, send, newChat}`，`seq` 去重
- 站点适配（隔离在 `ADAPTERS`，改版只需改这里）：
  - ChatGPT 编辑器 `#prompt-textarea`（ProseMirror）；发送按钮 `button[data-testid="send-button"]`
  - Gemini 编辑器 `.ql-editor[contenteditable]`（Quill）；发送按钮 `button.send-button`
- 写文本：contenteditable 用 `execCommand('insertText')`；textarea 用原生 value setter + `input` 事件
- 发送按钮：等其 enabled 再点（重试，图片多等一拍等上传）
- 开新对话：**优先点页面「新建对话」按钮，兜底发 `Cmd+Shift+O`**，等 1.2s 界面就绪再填字

## 当前进度（v0.4）

- [x] 跨标签文本同步 + 自动发送
- [x] 回车发送 / Shift+Enter 换行
- [x] 粘贴图片同步
- [x] 发送按钮精确定位 + 等待可点
- [x] 面板只在 ChatGPT 显示
- [x] 面板尺寸放大 1.2 倍、底部上移避免遮挡 GPT 发送按钮
- [x] 面板可拖拽
- [x] 新增「新窗口发送」（两边开新对话再发）

## 已知风险 / 待办

- 选择器随网站改版可能失效 → 改 `ADAPTERS` 对应项即可
- 图片自动发送默认等 1.5s 上传，网慢可能未传完就点发送 → 调大 `pasteImage` 后的延时
- 开新对话快捷键可能被页面焦点吞掉 → 已用「按钮优先、快捷键兜底」缓解
- 大规模自动化可能触及 OpenAI / Google 服务条款，仅供个人少量使用

## 文件

- `dual-ai-sync.user.js` — Tampermonkey 用户脚本（粘贴进 Tampermonkey 即用）
- `plan.md` — 本文档
