# PromptSync 发布记录（releasezip-record）

每次发版后在此追加一条摘要。zip 是构建产物，上传到 GitHub Release 后即删除本地，
不入库；本文件入库（git），作为可回溯的变更汇总。

> 流程：**改版本号 → 提交推送源码 → 打包 zip（剥离调试按钮）→ 上传 GitHub Release →
> 在本文件写摘要 → 删除本地 zip**。打包/发布细节见 `RELEASE.md`。

---

## v0.2.14 — 2026-06-17

- **后台 service worker 防御加固**：`background.js` 所有 `chrome.*` 事件监听改用 `on()`
  守卫包裹。某个 API 在当前 manifest 下不存在（如未声明权限时的 `chrome.commands`）
  时安全跳过，而不是抛 `Uncaught TypeError` 拖崩整个后台 worker。功能不变。
- **澄清 Gemini 控制台 CSP 报错（非本扩展问题）**：`inject-main.js` 补中文注释说明——
  控制台偶发的 `googleadservices.com ... violates Content Security Policy` 报错，是
  **Gemini 页面自带的 Google 广告/转化跟踪脚本触发、被 Gemini 自家 CSP 拦截**，装不装
  本扩展都会发生；我们只因包装 `window.fetch` 跟踪上传而出现在堆栈里，原样透传、不跟踪
  不外发该请求。**无数据泄漏、无功能影响，可安全忽略。**
- Release: https://github.com/stormjiev/PromptSync/releases/tag/v0.2.14

## v0.2.13 — 2026-06-16

- **DeepSeek 带文件发送**：每 2.5s 安全补点，消除首点被吞后的 12s 死等。
- Release: https://github.com/stormjiev/PromptSync/releases/tag/v0.2.13

## v0.2.12 — 2026-06-15

- 扩展新增隐私政策与反馈入口链接。
- Release: https://github.com/stormjiev/PromptSync/releases/tag/v0.2.12
