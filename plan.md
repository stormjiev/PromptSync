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

## 当前进度（v0.5）

- [x] 跨标签文本同步 + 自动发送
- [x] 回车发送 / Shift+Enter 换行
- [x] 粘贴图片同步
- [x] 粘贴/拖拽**多张图片 + 多种文件**（不再只留最后一张）
- [x] 拖拽文件进面板（dragover 高亮 + drop 接收）
- [x] 面板内文件列表展示，可单独删除
- [x] 发送前**等待上传完成**（轮询上传指示器，ChatGPT 与 Gemini 都生效）
- [x] 发送按钮精确定位 + 等待可点
- [x] 面板只在 ChatGPT 显示
- [x] 面板尺寸放大 1.2 倍、底部上移避免遮挡 GPT 发送按钮
- [x] 面板可拖拽
- [x] 新增「新窗口发送」（两边开新对话再发）

## 已知风险 / 待办

- 选择器随网站改版可能失效 → 改 `ADAPTERS` 对应项即可
- 上传完成检测依赖 `uploadingSelectors`（进度条/spinner），网站改版后可能失效 → 调整对应选择器；兜底是 `clickSend` 最多重试 60 次（约 18s）
- 多文件经 base64 跨标签广播，超大文件可能撑爆 `GM_setValue` → 建议单文件控制在数 MB 内
- 开新对话快捷键可能被页面焦点吞掉 → 已用「按钮优先、快捷键兜底」缓解
- 大规模自动化可能触及 OpenAI / Google 服务条款，仅供个人少量使用

## 文件

- `dual-ai-sync.user.js` — Tampermonkey 用户脚本（粘贴进 Tampermonkey 即用）
- `plan.md` — 本文档

---

# 方案2新功能规划：并排对比分屏面板（Split-Panel Compare）

> 立项日期：2026-06-17 ｜ 分支：`feat/split-panel-compare` ｜ 状态：规划中（未动工）
> 灵感来源：竞品 Panelize（MIT，~28★）。
> 本节是新增旗舰功能的设计文档；上文 v0.5 内容为历史记录，已不代表当前实现（现为独立 MV3 扩展，见 `extension/`）。

## 目标

把现在"广播后答案散落在各家标签页、要来回切"升级为：**一个扩展内页面（grid 布局）里并排嵌入多家 AI，输入一次→各 iframe 同时填入并发送→并排看回答**。让 PromptSync 从「同步广播器」进化成「多模型对比工作台」。

## 竞品真相（Panelize 怎么做到的）

- 申请权限：`declarativeNetRequest` + `declarativeNetRequestWithHostAccess`（**没有** `windows`/`tabs`/`system.display`）。
- 机制：一个 `multi-panel` 页面里放 N 个 `<iframe>`，每个加载一家 AI 网站；用 DNR 规则**剥离这些站点响应里的 `X-Frame-Options` 和 `Content-Security-Policy: frame-ancestors`**，使其可被 iframe 嵌入且保留登录态。
- "15 种布局" = 对这组 iframe 的 CSS grid 排列方案。
- content script 注入到每个 iframe 内做文本注入与回车发送（复用既有注入逻辑）。

## 技术方案（落到本项目）

1. **新页面** `extension/panel/panel.html` + `panel.js` + `panel.css`：CSS grid 容器，按所选布局放置 N 个 `<iframe src="各 AI 首页">`。入口：popup 加一个「并排对比」按钮 → `chrome.tabs.create({ url: 'panel/panel.html' })`（或独立窗口）。
2. **DNR 剥头规则** `extension/rules.json`：对支持站点的主框架文档响应，`modifyHeaders` 删除 `X-Frame-Options`、改写 `content-security-policy`（去掉 `frame-ancestors`）。manifest 增 `declarative_net_request.rule_resources`。
3. **content script 进 iframe**：现有 `content_scripts` 默认 `all_frames:false`，需为面板场景允许在子框架运行注入逻辑（评估用 `all_frames:true` 还是仅 panel 来源放行，避免影响普通浏览体验）。
4. **广播链路**：panel.js 收集输入（复用现有浮窗 UI 组件）→ 发消息给 `background` → background 用 `chrome.scripting`/`tabs.sendMessage` 向各 iframe 的 frame 下发 `{seq,text,files,send,newChat}` → 各 frame 内复用既有 `adapters.js`/`content.js` 的填字+等上传+点发送+去重逻辑。
5. **复用看家逻辑**：等上传完成 / 流式中不误点 / 单任务只发一次 / `uploadScope` 防误判——全部沿用，只是运行在 iframe 内。

## 文件结构（计划新增）

- `extension/panel/panel.html|panel.js|panel.css` — 分屏面板页
- `extension/rules.json` — DNR 剥头规则
- `extension/manifest.json` — 增 `declarativeNetRequest` 权限 + `declarative_net_request` 段；content_scripts 框架策略调整

## 分阶段（先验证再铺开）

- [ ] **阶段 0 验证**：仅 ChatGPT + Gemini，验证四件事——剥头生效 / iframe 内嵌不被拒 / 登录态保留 / 注入发送成功。Gemini 是最大不确定项，优先实测。
- [ ] **阶段 1 MVP**：2 家跑通广播 + 1×2 布局 + 入口按钮。
- [ ] **阶段 2 扩展**：接入 DeepSeek/Qwen，加多种 grid 布局（1×2、2×2、1×3…）。
- [ ] **阶段 3 打磨**：布局记忆、单格刷新/新对话、同步滚动（可选）、Prompt 库变量替换。
- [ ] **阶段 4 决策**：评估稳定性与商店合规后，决定是否合回 `main`。

## 风险 / 权衡（重要）

- **安全**：剥离 X-Frame-Options/CSP 会削弱这些站点的点击劫持防护；与 README「无侵入、稳」调性需权衡，面板内应提示用户该模式的性质。
- **商店合规**：Chrome 审核对「剥 CSP + 嵌第三方登录页」较敏感，可能影响上架 → 这也是先放分支、不进 main 的原因。
- **登录态**：Google/Gemini 等可能检测 iframe 嵌入而拒绝渲染 → 阶段 0 必须实测，不成立则该家退回「真实标签页广播」老路。
- **维护成本**：选择器 + 剥头规则 + 每家改版，维护面翻倍。
- **回退**：分屏作为「可选模式」存在，不替换现有标签页广播；两套并存，互不影响。

## 决策记录

- 采用 **feature 分支** `feat/split-panel-compare`（非单独文件夹）：涉及新权限与剥 CSP 等敏感、可能不稳的改动，分支隔离、不污染可发布的 `main`。
- 代码物理上仍放在 `extension/panel/` 子目录内，便于打包时整体纳入或剔除。



# 核心区别(两种形态)

|        | 原版 `extension/`(main)                | `compare-panel`(本分支)                   |
| ------ | -------------------------------------- | ----------------------------------------- |
| 思路   | **注入派**:留在各家真实标签页,浮窗广播 | **内嵌派**:一个窗口 iframe 并排,剥 CSP 头 |
| 体验   | 答案散在多标签,要切                    | **并排对比,一眼看全**(明显更好)           |
| 成熟度 | 发了十几版、打磨过                     | 刚 fork 移植、还在修 bug                  |

## 优缺点

**compare-panel 优点**:并排对比体验碾压;功能多(布局/Prompt库等现成)。
**compare-panel 缺点**:① 靠**剥离 X-Frame-Options/CSP** 才能嵌入——Chrome 商店审核对此敏感,**很可能拒上架**;② iframe 内嵌脆弱,Gemini 等随时可能封堵被嵌入;③ 数千行维护成本高。

**原版优点**:在真实标签页运行,**稳、合规、能上架**,你完全掌握代码。缺点:对比要切标签。

## 风险点(compare-panel)

- **合规**:剥 CSP 是上架红线,也削弱了那些站点的点击劫持防护。
- **脆弱**:任一家改版/封 iframe,整个并排就废;补点/上传判定还需多轮实测。
- **代码所有权**:基于 Panelize(MIT,需署名),非自研。

## 能否替代发布?

**不建议直接替代。** 原版是你能上架、稳定、可维护的主线;compare-panel 的核心能力建立在"剥 CSP + iframe 嵌登录页"上,合规和稳定性都压不住,拿它当正式版替代风险太大。

**建议**:把 compare-panel 当作**独立的实验性形态/Pro 版**并行孵化(仅"开发者模式加载"分发,不进商店),主线发布继续用原版。等它实测足够稳、并想清楚合规路径,再决定是否合并成"两种模式"。现在它在独立分支、独立目录,正好不影响主线——保持这个隔离就对了。







# 方案2 风险和分析

## 怎么登录

**推荐流程：先在真实 Chrome 标签页登录，再打开方案二 iframe 面板。**

1. 打开 `chatgpt.com`，正常登录。
2. 打开 `gemini.google.com`，正常登录。
3. 确认刷新后仍是登录状态。
4. 再打开你的并排 iframe 面板。

**不要把 iframe 当主要登录入口。**
iframe 里“可能”能登录，但更容易遇到 Google 登录失败、验证码、第三方 cookie 被拦、页面拒绝加载等问题。

------

## 登录态会不会共用

**通常会共用。**

因为方案二还是运行在同一个 Chrome 用户环境里，不是新浏览器，也不是隐身窗口。
所以 iframe 里的 ChatGPT / Gemini 会尝试复用原本 Chrome 里的 cookie 和登录状态。

但注意：

**真实标签页登录 = 稳。**
**iframe 复用登录态 = 可能成功，但不保证。**

------

## 会不会影响原本 Chrome 的登录和刷新

**正常不会。**

方案二一般不会让你原本的 ChatGPT / Gemini 掉登录，也不会影响你在真实标签页刷新。

但有风险：

- 如果 CSP / X-Frame-Options 剥离规则写得太宽，可能影响普通浏览安全。
- 如果站点检测到 iframe 环境，可能要求重新登录或拒绝显示。
- 第三方 cookie 被 Chrome、用户设置或企业策略限制时，iframe 可能拿不到登录态。

------

## 核心原理

很多网站默认不允许被别人 iframe 嵌入，靠这两个响应头保护：

```http
X-Frame-Options
Content-Security-Policy: frame-ancestors
```

方案二的做法是：

```text
扩展页面里放 iframe
→ iframe 加载 ChatGPT / Gemini
→ Chrome 扩展用 DNR 规则删除或改写 X-Frame-Options / CSP
→ 浏览器不再阻止嵌入
→ content script 注入 iframe
→ 自动填字、上传、点击发送
```

简单说：

**它不是破解账号，而是改浏览器看到的响应头，让原本不能嵌入的网站可以被 iframe 打开。**

------

## 主要风险

**1. 稳定性风险**
ChatGPT / Gemini 改版、加强 iframe 限制、改登录策略，面板就可能失效。

**2. 登录风险**
iframe 属于第三方环境，cookie、OAuth、Google 登录、验证码更容易失败。

**3. 安全风险**
剥掉 X-Frame-Options / CSP，会削弱网站原本的点击劫持防护。

**4. Chrome 商店审核风险**
“剥 CSP + 嵌第三方登录页”比较敏感，正式上架可能被拒。

**5. 维护成本高**
既要维护 iframe 嵌入规则，又要维护每家 AI 网站的输入框、发送按钮、上传状态选择器。

------

## 最终建议

**主线版本继续用真实标签页广播。**
**方案二只作为实验性并排模式。**

最佳设计是：

```text
真实标签页：负责登录
iframe 面板：只负责复用登录态、并排展示、同步发送
```

不要依赖用户在 iframe 里完成首次登录。
