# 🐾 DeskLLMPet v1.1.1

> 发布日期：2026-11-02 ｜ [对比 v1.1.0 的完整变更](https://github.com/isKage/desk-llm-pet/compare/v1.1.0...v1.1.1)

这一版是两个社区贡献的修复，没有新增功能，建议所有用户升级：Windows 高 DPI 缩放下拖动桌宠会越来越大的问题，以及右键菜单偶尔跳到屏幕左上角的问题。

## 🐛 修复

- 🪟 **Windows 非整数 DPI 缩放下拖动桌宠尺寸累积增大**（[#1](https://github.com/isKage/desk-llm-pet/issues/1) / [#2](https://github.com/isKage/desk-llm-pet/pull/2)，感谢 [@fine259](https://github.com/fine259)）
  150% 等缩放下，拖动时复用系统取整后的实际窗口尺寸会产生累积误差，拖几次宠物就明显膨胀。现在每次移动都按 scale/crop 重新计算尺寸，连续 200 次移动后窗口仍保持原尺寸。
- 🖱 **右键菜单跳到屏幕左上角**（[#4](https://github.com/isKage/desk-llm-pet/pull/4)，感谢 [@kudoumakoto6523-design](https://github.com/kudoumakoto6523-design)）
  首次展示后菜单锚点被清空，迟到的尺寸回报或 250ms 兜底定时器会把菜单定位到 (0,0)。现在保留本次打开的锚点，只有尺寸真正变化时才重新贴回鼠标位置。

## 🧪 工程化

- 新增 `scripts/check-menu-anchor.js` 回归测试并接入 `npm run check`（反向验证：还原修复后测试会失败）。
- 新增 GitHub Actions：PR 自动执行 `npm run check`；推送 `v*` tag 自动构建 macOS / Windows 安装包并发布 Release。
- 新增 `CONTRIBUTING.md` 与 Issue / PR 模板。

## 📦 下载安装包

| 平台 | 文件 |
|---|---|
| 🍎 macOS（Apple Silicon） | `DeskLLMPet-1.1.1-arm64.dmg` |
| 🍎 macOS（Intel） | `DeskLLMPet-1.1.1.dmg` |
| 🪟 Windows x64 | `DeskLLMPet.Setup.1.1.1.exe` |

## 🔄 升级说明（装过旧版本也不用先卸载）

- **Windows**：直接双击新版 `.exe`，安装程序会原地覆盖升级，配置在 `%APPDATA%\deskllmpet` 不会丢。
- **macOS**：双击 `.dmg` 挂载 → 把 `DeskLLMPet.app` 拖进「应用程序」→ 提示已存在时选 **替换**，配置在 `~/Library/Application Support/deskllmpet` 不会丢。
- ⚠️ 仍然**没有内置自动更新**，请到本页面手动下载覆盖安装；升级前先在托盘「退出」旧版本（应用是单实例）。
- ⚠️ 安装包**未做代码签名 / 公证**：macOS 首次打开需「右键 → 打开」或在隐私与安全性里允许，Windows 可能弹 SmartScreen（更多信息 → 仍要运行）。

问题与建议欢迎提 [Issue](https://github.com/isKage/desk-llm-pet/issues)。
