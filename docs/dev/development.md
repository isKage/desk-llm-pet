# 本地开发与发布

## 1. 环境

- Node.js 18+（CI 使用 20，见 `.nvmrc`）
- Windows / macOS

```bash
npm install       # 安装依赖并生成占位素材目录
npm start         # 启动
npm run dev       # 开发模式
npm run dev:tools # 开发模式 + DevTools
```

> 应用是单实例。改了代码后先在托盘「退出」旧实例，再重新启动，否则跑的还是旧代码。

## 2. 常用命令

| 命令 | 作用 |
|---|---|
| `npm run check` | 静态自检：语法、菜单锚点、插件安装器、文档链接、插件宿主与结构一致性 |
| `npm run check:renderer` | 真实 Electron 冒烟测试：桌宠/菜单/设置/对话页面 + IPC 往返 |
| `npm run check:docs` | 只检查 Markdown/HTML 相对链接 |
| `npm run check:installer` | 只跑插件安装器测试（不需要 GUI） |
| `npm run clean` | 清理 `dist/`、`.smoke-userdata/`、`.DS_Store` 等本地生成物 |
| `npm run pack:plugin -- <插件目录>` | 打包 `.dlmpet` 插件包 |
| `npm run release:prepare -- <版本>` | 更新版本号 + 插入 CHANGELOG 占位 |
| `npm run release:notes -- v<版本>` | 从 CHANGELOG 提取 GitHub Release 正文 |

受限环境（容器 / 无 GUI 沙箱）跑冒烟测试可加 `--no-sandbox`：

```bash
npx electron scripts/smoke-renderer.js --no-sandbox
```

## 3. 代码约定

- 渲染进程不开 `nodeIntegration`，一律走 preload + IPC。
- 窗口位置/尺寸统一用 `setBounds`，不要复用系统取整后的实际尺寸。
- 插件只通过宿主 `ctx` 使用本体能力；本体核心文件不 import 具体插件。
- 新增插件安装相关逻辑时，必须同时更新安装器测试与 self-check。
- 新增依赖、修改 `postinstall` 或打包配置，需在 PR 说明中单独列出。

## 4. 版本与发布

### 4.1 单一来源

- **版本号**：只改 `package.json` 的 `version`（由脚本同步 `package-lock.json`）。
- **发布历史**：只维护 `CHANGELOG.md`。
- `README.md`、`settings.html` 不再写死当前版本；设置页版本号由主进程动态注入。
- GitHub Release 正文由 `.github/workflows/release.yml` 调用 `scripts/release-notes.js` 从 CHANGELOG 提取。

### 4.2 发布步骤

1. 更新版本号并插入 CHANGELOG 段落：

   ```bash
   npm run release:prepare -- 1.2.0
   ```

2. 补全 `CHANGELOG.md` 中 `## [1.2.0]` 的内容（新增/修复/变更/下载）。
3. 跑通：

   ```bash
   npm run check
   npm run check:renderer
   ```

4. 提交并推送 `main`。
5. 打 tag 并推送：

   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```

6. tag 触发 `release` workflow：构建 macOS / Windows 安装包，从 CHANGELOG 提取正文，发布 GitHub Release。

> 维护者只有一个人，发布前请确认 README / CHANGELOG / Release 页面信息一致。

## 5. 发布检查清单

- [ ] `package.json` 版本已更新，`package-lock.json` 同步
- [ ] `CHANGELOG.md` 有当前版本段落，内容完整
- [ ] `npm run check` 全绿
- [ ] `npm run check:renderer` 全绿（本机有 GUI 时）
- [ ] 至少一次打包验证：`npm run build:mac` 或 `npm run build:win`
- [ ] 安装包能启动，设置页版本号正确
- [ ] 内置插件（AI 对话）能打开，用户插件安装/卸载正常
- [ ] tag 推送后 Release 正文来自 CHANGELOG

## 6. 相关文档

- [技术架构](architecture.md)
- [插件开发指南](../plugins/development.md)
- [插件打包](../plugins/packaging.md)
- [贡献指南](../../CONTRIBUTING.md)
