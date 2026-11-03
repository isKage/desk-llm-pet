# 更新日志

本文件是 DeskLLMPet **唯一的版本与发布记录**。版本号以 [`package.json`](package.json) 的 `version` 为准，发布时由 `npm run release:prepare -- <版本>` 同步更新；GitHub Release 的正文由 `scripts/release-notes.js` 从本文件提取。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（暂无）

## [1.2.0] - 2026-11-03

> [对比 v1.1.1 的完整变更](https://github.com/isKage/desk-llm-pet/compare/v1.1.1...v1.2.0)

这一版的核心是**插件框架**：插件可以像 Minecraft 模组一样打包成 `.dlmpet`，在设置页选择或拖入即可安装，安装后立即生效，不需要改项目代码。同时修复了内置 AI 对话请求偶发 `read ECONNRESET` 的问题。

### 新增

- 🧩 **插件框架**：内置/用户插件双目录发现、启用/禁用、热重载、安装/卸载、旧数据迁移。
- 📦 **一键安装插件**：设置 → 🧩 插件，选择或拖入 `.dlmpet` 插件包；也可以放进插件目录后点「重新扫描」自动安装。
- 🔍 **安装前校验**：预览名称/版本/作者/大小，校验包结构、路径安全、大小限制与来源；卸载时可选择保留插件数据。
- 📚 **插件开发与打包**：新增插件开发/安装/打包文档与 `npm run pack:plugin`，可选插件可以独立打包装进主程序。
- 🐾 **可选示例插件**：多桌宠克隆（`dlp-multi-pets`），支持克隆多个桌宠、共享主程序设置、右键删除克隆体；该插件不随主程序内置，需单独安装。
- 🧹 文档统一收敛到 `docs/`，新增 `npm run clean`、文档链接检查与插件安装器回归测试。

### 修复

- **AI 对话网络请求失败（`read ECONNRESET`）**：对话请求补充 `User-Agent`，避免被 API 边缘节点当作异常流量重置连接；余额查询请求也补上同样标识。
- 聊天窗口的网络错误提示改为「请检查网络连接，或稍后重试」，不再一律提示检查配置。

### 变更

- 版本号只由 `package.json` 决定，发布历史只维护 `CHANGELOG.md`；Release 正文由 `release-notes.js` 从本文件提取。
- 设置页文案精简，去掉文件路径、公式和实现细节；设置页「关于」版本号改为运行时读取。
- 移除打包配置中未使用的 `extraResources`，避免安装包重复携带素材。

### 下载与升级

- 安装包：[GitHub Release v1.2.0](https://github.com/isKage/desk-llm-pet/releases/tag/v1.2.0)
  - macOS（Apple Silicon）：`DeskLLMPet-1.2.0-arm64.dmg`
  - macOS（Intel）：`DeskLLMPet-1.2.0.dmg`
  - Windows x64：`DeskLLMPet.Setup.1.2.0.exe`
- **Windows**：双击新版 `.exe` 原地覆盖升级；**macOS**：双击 `.dmg`，把应用拖进「应用程序」选 **替换**。
- 配置、内置插件数据与已安装插件都会保留；升级前先在托盘「退出」旧版本（应用是单实例）。
- 安装包仍未做代码签名 / 公证：macOS 首次打开需右键 → 打开，Windows 可能弹 SmartScreen。

## [1.1.1] - 2026-11-02

> [对比 v1.1.0 的完整变更](https://github.com/isKage/desk-llm-pet/compare/v1.1.0...v1.1.1)

这一版是两个社区贡献的修复，没有新增功能，建议所有用户升级：Windows 高 DPI 缩放下拖动桌宠会越来越大的问题，以及右键菜单偶尔跳到屏幕左上角的问题。

### 修复

- 🪟 **Windows 非整数 DPI 缩放下拖动桌宠尺寸累积增大**（[#1](https://github.com/isKage/desk-llm-pet/issues/1) / [#2](https://github.com/isKage/desk-llm-pet/pull/2)，感谢 [@fine259](https://github.com/fine259)）
  150% 等缩放下，拖动时复用系统取整后的实际窗口尺寸会产生累积误差，拖几次宠物就明显膨胀。现在每次移动都按 scale/crop 重新计算尺寸，连续 200 次移动后窗口仍保持原尺寸。
- 🖱 **右键菜单跳到屏幕左上角**（[#4](https://github.com/isKage/desk-llm-pet/pull/4)，感谢 [@kudoumakoto6523-design](https://github.com/kudoumakoto6523-design)）
  首次展示后菜单锚点被清空，迟到的尺寸回报或 250ms 兜底定时器会把菜单定位到 (0,0)。现在保留本次打开的锚点，只有尺寸真正变化时才重新贴回鼠标位置。

### 工程化

- 新增 `scripts/check-menu-anchor.js` 回归测试并接入 `npm run check`（反向验证：还原修复后测试会失败）。
- 新增 GitHub Actions：PR 自动执行 `npm run check`；推送 `v*` tag 自动构建 macOS / Windows 安装包并发布 Release。
- 新增 `CONTRIBUTING.md` 与 Issue / PR 模板。

### 下载与升级

- 安装包：[GitHub Release v1.1.1](https://github.com/isKage/desk-llm-pet/releases/tag/v1.1.1)
  - macOS（Apple Silicon）：`DeskLLMPet-1.1.1-arm64.dmg`
  - macOS（Intel）：`DeskLLMPet-1.1.1.dmg`
  - Windows x64：`DeskLLMPet.Setup.1.1.1.exe`
- **Windows**：直接双击新版 `.exe`，安装程序会原地覆盖升级，配置在 `%APPDATA%\deskllmpet` 不会丢。
- **macOS**：双击 `.dmg` 挂载 → 把 `DeskLLMPet.app` 拖进「应用程序」→ 提示已存在时选 **替换**，配置在 `~/Library/Application Support/deskllmpet` 不会丢。
- ⚠️ 仍然**没有内置自动更新**，请到 Release 页面手动下载覆盖安装；升级前先在托盘「退出」旧版本（应用是单实例）。
- ⚠️ 安装包**未做代码签名 / 公证**：macOS 首次打开需「右键 → 打开」或在隐私与安全性里允许，Windows 可能弹 SmartScreen（更多信息 → 仍要运行）。

## [1.1.0] - 2026-09-27

> [对比 v1.0.0 的完整变更](https://github.com/isKage/desk-llm-pet/compare/v1.0.0...v1.1.0)

这一版把桌宠升级成**可插件化扩展**的桌宠：新增 API 余额气泡、双击互动 + 自定义语句、窗口裁剪，重做了右键菜单，AI 对话改造为内置插件。

### 新增

- 🧩 **插件化架构**：菜单 / 托盘 / 设置页 / IPC / 独立窗口 / 独立存储都可被插件扩展；插件出错只跳过它，本体照常运行。
- 💰 **API 余额气泡**：独立气泡窗口，双击桌宠查询并展示 DeepSeek 余额卡片；支持定时展示、气泡大小与位置调节、失败提示。
- 💬 **双击互动 + 自定义语句**：单击只播反应动画，**双击**才弹气泡；关闭余额展示后，双击随机说一句你自己写的语句（设置 → 宠物设置 → 余额气泡，可编辑可预览）。
- ✂️ **窗口裁剪**：窗口只保留动画主体，宠物大小不变，桌面占用更小（支持画面偏移）。

### 下载与升级

- 安装包：[GitHub Release v1.1.0](https://github.com/isKage/desk-llm-pet/releases/tag/v1.1.0)
  - macOS（Apple Silicon）：`DeskLLMPet-1.1.0-arm64.dmg`
  - macOS（Intel）：`DeskLLMPet-1.1.0.dmg`
  - Windows x64：`DeskLLMPet.Setup.1.1.0.exe`
- **Windows**：直接双击新版 `.exe`，安装程序会**原地覆盖升级**（沿用上次的安装目录，不会多出应用条目）；桌宠在运行会提示先关闭。配置在 `%APPDATA%\deskllmpet`，不会丢。
- **macOS**：双击 `.dmg` 挂载 → 把 `DeskLLMPet.app` 拖进「应用程序」→ 提示已存在时选 **替换**。配置在 `~/Library/Application Support/deskllmpet`，不会丢。
- ⚠️ 目前**没有内置自动更新**，请到 Release 页面手动下载覆盖安装；升级前先在托盘「退出」旧版本（应用是单实例）。
- ⚠️ 从 v1.0.0 升级：旧版「AI 对话」的历史记录不会自动迁移；模型 / 温度等参数改到「设置 → AI 对话」，API Key 与动画配置继续沿用。

## [1.0.0] - 2026-08-20

首个公开版本。

### 新增

- 透明桌面宠物窗口、WebM 动画播放、随机闲置动画、点击反应、拖拽移动。
- 右键菜单、系统托盘、可视化设置页。
- DeepSeek API 余额查询与气泡展示。
- 内置 AI 对话（多会话、流式回复、本地保存）。
- Windows / macOS 安装包。

### 已知说明

- 安装包未做代码签名 / 公证；macOS 首次打开需「右键 → 打开」或在隐私与安全性里允许，Windows 可能弹 SmartScreen。
- 需要自备 DeepSeek API Key；系统要求 macOS 10.15+ / Windows 10、11 x64。
