# 贡献指南

欢迎 Issue 和 PR。这个项目是一个 Electron 桌面宠物，维护者只有一个人，所以下面几条能显著减少来回沟通。

## 开发环境

- Node.js 18+（CI 使用 20）
- `npm install`：安装依赖并生成占位素材目录
- `npm start`：启动应用
- `npm run dev`：开发模式
- `npm run dev:tools`：开发模式并打开 DevTools

## 提交前必须跑通

```bash
npm run check
```

`npm run check` 会依次运行 `scripts/check-*.js` 里的回归脚本和 `scripts/self-check.js`（静态结构检查），CI 也会执行同一条命令。提 PR 前请确认全绿。

### 修 Bug 请带一个会失败的测试

如果修的是逻辑问题，请新增 `scripts/check-<名字>.js` 并接进 `npm run check`。要求：

1. 用假 Electron / `vm` 加载真实源码，不启动 GUI；
2. **在未修复的代码上会失败**，在修复后通过（提交说明里写一句反向验证结果即可）；
3. 不依赖网络和本机配置。

窗口、DPI、托盘这类必须在真机验证的问题，测试之外还要在 PR 里写清楚：系统版本、显示缩放、复现步骤，最好附录屏。

## PR 规范

- 一个 PR 只做一件事，不要夹带无关重构、格式化或版本号改动。
- 说明「改了什么 / 为什么 / 怎么验证」，并关联 Issue（`Fixes #123`）。
- 新增依赖、修改 `postinstall` 或打包配置必须在 PR 里单独说明。
- 代码或测试由 AI 辅助生成时，请在 PR 里注明工具和人工验证方式。
- 界面改动请附截图或 GIF。

## 代码结构

| 目录 | 说明 |
|---|---|
| `src/main/` | 主进程：窗口、托盘、IPC、菜单 |
| `src/preload/` | 各窗口的预加载脚本（仅暴露必要 API） |
| `src/renderer/` | 各窗口页面（原生 HTML/CSS/JS） |
| `src/shared/` | 主进程共享模块：存储、DeepSeek API |
| `src/plugins/` | 插件（插件出错不影响本体） |
| `scripts/` | 自检与回归脚本 |

约定：渲染进程不开 `nodeIntegration`，一律走 preload + IPC；窗口位置/尺寸统一用 `setBounds`，不要复用系统取整后的实际尺寸。

## 发布流程（维护者）

1. 更新 `package.json` 版本号（同时会更新 `package-lock.json`）。
2. 新增 `RELEASE_v<版本>.md`，里面要出现版本号、三个安装包文件名。
3. 同步 `src/renderer/settings/settings.html`「关于」里的版本号，以及 README 的下载表格。`npm run check` 会校验这三处一致。
4. 提交并推送 `main`，然后打 tag：`git tag v<版本> && git push origin v<版本>`。
5. tag 会触发 `release` workflow，自动构建 macOS / Windows 安装包并发布 GitHub Release。

## 安全问题

涉及 API Key、任意代码执行、越权 IPC 的问题请不要公开提 Issue，先发邮件到 `iskage@126.com`。
