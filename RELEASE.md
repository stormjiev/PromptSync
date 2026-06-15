# 打包与发布流程（PromptSync Chrome 扩展）

本文记录把 `extension/` 打成 zip 并发布到 GitHub Releases 的标准步骤。

- 仓库：`git@github.com:stormjiev/PromptSync.git`（gh 账号 `stormjiev`）
- 产物命名：`promptsync-extension-vX.Y.Z.zip`
- zip 是 `.gitignore` 忽略的构建产物，**不入库**，只作为 release 资产上传。

---

## 1. 改版本号

编辑 `extension/manifest.json` 的 `"version"`（如 `0.2.11`）。

## 2. 提交并推送源码

源码里**保留**「导出诊断日志 / 清空日志」两个调试按钮，只在打包时剥离。

```bash
git add extension/...
git commit -m "feat(extension): vX.Y.Z — ..."
git push origin main
```

## 3. 打包 zip（剥离调试按钮）

把 `extension/` 复制到临时目录，再从 `src/content.js` 删除两处调试按钮，最后从临时目录**内部**打包（文件位于 zip 根，不带 `extension/` 前缀）。

要删除的两处：
- **HTML**：以 `<div style="display:flex;gap:0;margin-top:2px;">` 开头、内含 `#dai-log`/`#dai-clearlog` 的整个 `<div>` 块（4 行）。
- **JS**：`panel.querySelector('#dai-log').onclick` 与 `#dai-clearlog` 两个 onclick 处理器。

```bash
VER=0.2.11
rm -rf /tmp/ps_build && mkdir -p /tmp/ps_build
cp -R extension/ /tmp/ps_build/

python3 - <<'PY'
p = '/tmp/ps_build/src/content.js'
lines = open(p, encoding='utf-8').read().split('\n')
# 1) 删 HTML 调试按钮 <div> 块（4 行）
for i, l in enumerate(lines):
    if l.strip().startswith('<div style="display:flex;gap:0;margin-top:2px;">'):
        assert 'dai-log' in lines[i+1] and 'dai-clearlog' in lines[i+2]
        del lines[i:i+4]; break
else: raise SystemExit("未找到调试按钮 div")
# 2) 删两个 onclick 处理器（从 #dai-log 起，吃掉两个 '};'）
for j, l in enumerate(lines):
    if "querySelector('#dai-log')" in l:
        k = j; c = 0
        while k < len(lines):
            if lines[k].strip() == '};':
                c += 1
                if c == 2: break
            k += 1
        assert "querySelector('#dai-clearlog')" in '\n'.join(lines[j:k+1])
        del lines[j:k+1]; break
else: raise SystemExit("未找到 dai-log 处理器")
open(p, 'w', encoding='utf-8').write('\n'.join(lines))
print("剥离后 dai-log 残留 =", '\n'.join(lines).count('dai-log'))
PY

node --check /tmp/ps_build/src/content.js          # 校验语法

cd /tmp/ps_build
rm -f "$OLDPWD/promptsync-extension-v$VER.zip"
zip -rq "$OLDPWD/promptsync-extension-v$VER.zip" . -x '.*'
cd "$OLDPWD"
```

打包后校验：

```bash
unzip -p promptsync-extension-v$VER.zip src/content.js | grep -c 'dai-log'   # 必须为 0
unzip -p promptsync-extension-v$VER.zip manifest.json | grep '"version"'      # 必须为新版本
```

## 4. 创建 GitHub Release

```bash
gh release create v$VER \
  --title "PromptSync v$VER" \
  --target main \
  --notes "..." \
  promptsync-extension-v$VER.zip
```

> 偶发 `TLS handshake timeout`：先 `gh release view v$VER` 确认没被部分创建，再原样重试即可。

## 安装方式（写进 release notes 给用户）

下载 `promptsync-extension-vX.Y.Z.zip` 解压 → Chrome `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」选解压目录。
