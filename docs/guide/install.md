# 安装、升级与卸载

## 1. 下载安装包（推荐）

从 [Releases](https://github.com/isKage/desk-llm-pet/releases/latest) 页面下载对应平台的安装包。文件名会带当前版本号：

| 平台 | 文件 |
|---|---|
| 🍎 macOS（Apple Silicon / M1–M4） | `DeskLLMPet-<version>-arm64.dmg` |
| 🍎 macOS（Intel） | `DeskLLMPet-<version>.dmg` |
| 🪟 Windows x64 | `DeskLLMPet Setup <version>.exe` |

> 本地打包产物文件名里是空格，上传到 GitHub 后通常显示成点（`DeskLLMPet.Setup.<version>.exe`），是同一个文件。

### macOS

1. 下载 `.dmg`，双击挂载。
2. 把 `DeskLLMPet.app` 拖进「应用程序」。
3. 首次打开如果提示「无法验证开发者」，到 **系统设置 → 隐私与安全性** 点 **仍要打开**。
4. 启动后桌面上会出现桌宠。

### Windows

1. 下载 `.exe`，双击运行。
2. 选择安装路径，按向导完成。
3. 安装完成后会自动创建桌面和开始菜单快捷方式。

> 安装包未做代码签名 / 公证：macOS 可能需要右键 → 打开，Windows 可能弹 SmartScreen（更多信息 → 仍要运行）。

## 2. 从源码运行

要求 Node.js 18+（CI 使用 Node 20）。

```bash
git clone https://github.com/isKage/desk-llm-pet.git
cd DeskLLMPet
npm install
npm run dev
```

打包：

```bash
npm run build:mac   # macOS：x64 + arm64
npm run build:win   # Windows：NSIS x64
npm run build:all   # 两个平台
```

产物在 `dist/`，文件名取自 `package.json` 的 `version`。发布前用 `npm run release:prepare -- <version>` 统一更新版本号与 `CHANGELOG.md`。

> macOS 包必须在 macOS 上打；Windows 安装包可以在 macOS 交叉打包。默认不签名，用户首次打开会看到系统提示。

## 3. 升级（覆盖安装即可）

已安装旧版本时不需要先卸载，配置与插件数据都会保留：

- **Windows**：直接双击新版 `.exe`，安装程序会识别旧版本并原地覆盖升级。桌宠正在运行时先退出应用。
- **macOS**：双击新 `.dmg` → 把 `DeskLLMPet.app` 拖进「应用程序」→ 提示已存在时选 **替换**。

应用是单实例：升级前先在托盘菜单点「退出」，否则新实例会被单实例锁拦截。

配置与用户插件位于 Electron 的 `userData` 目录：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/DeskLLMPet`（具体以设置页显示的路径为准） |
| Windows | `%APPDATA%\DeskLLMPet`（具体以设置页显示的路径为准） |

> 不同版本 / 不同安装方式下应用名可能是 `DeskLLMPet` 或 `deskllmpet`；设置 → 插件 里会显示实际路径。

> 目前没有内置自动更新，需要到 Releases 页面手动下载覆盖安装。

## 4. 卸载与清理

### macOS

```bash
# 1. 托盘菜单 → 退出
# 2. 删除应用
rm -rf /Applications/DeskLLMPet.app
# 3. 清理配置、插件与插件数据（可选）
rm -rf ~/Library/Application\ Support/DeskLLMPet
```

### Windows

1. **控制面板 → 程序和功能**（或 **设置 → 应用**）找到 `DeskLLMPet` → 卸载。
2. 手动清理残留数据（可选）：删除 `%APPDATA%\DeskLLMPet`。

> 删除 `userData` 会同时删除 API Key、设置、已安装插件和插件数据（如 AI 对话记录）。只想重置设置时，先备份该目录。

## 5. 相关文档

- [API 与桌宠配置](configure.md)
- [安装与管理插件](../plugins/installing.md)
- [常见问题](faq.md)
