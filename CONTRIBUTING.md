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

`npm run check` 会依次运行菜单锚点回归、插件安装器测试、文档链接检查和 `scripts/self-check.js`（静态结构检查），CI 也会执行同一条命令。提 PR 前请确认全绿；本机有 GUI 时再跑一次 `npm run check:renderer`。

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
| `src/plugins/` | 插件宿主、清单校验、插件安装器与内置插件 |
| `docs/` | 使用、插件、开发与发布文档 |
| `scripts/` | 自检、回归、安装器测试、文档检查、打包脚本 |

约定：渲染进程不开 `nodeIntegration`，一律走 preload + IPC；窗口位置/尺寸统一用 `setBounds`，不要复用系统取整后的实际尺寸。

## 发布流程（维护者）

1. 更新版本号并插入 CHANGELOG 段落：`npm run release:prepare -- <版本>`。
2. 补全 `CHANGELOG.md` 对应版本的内容（新增/修复/变更/下载）。
3. 跑通 `npm run check`（有 GUI 时再跑 `npm run check:renderer`）。
4. 提交并推送 `main`，然后打 tag：`git tag v<版本> && git push origin v<版本>`。
5. tag 会触发 `release` workflow：自动构建 macOS / Windows 安装包，并用 `scripts/release-notes.js` 从 `CHANGELOG.md` 提取发布正文。

版本号只以 `package.json` 为准，发布历史只维护 `CHANGELOG.md`；README 和设置页不再写死版本号。详见 [本地开发与发布](docs/dev/development.md)。

## 安全问题

涉及 API Key、任意代码执行、越权 IPC 的问题请不要公开提 Issue，先发邮件到 `iskage@126.com`。
