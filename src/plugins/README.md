# 🧩 插件目录

完整开发文档已移到 **[docs/plugins/development.md](../../docs/plugins/development.md)**。

本目录包含：

| 文件/目录 | 说明 |
|---|---|
| `plugin-manager.js` | 插件宿主：发现、校验、激活、卸载、菜单、设置、IPC |
| `manifest.js` | 清单规范化与校验（纯函数，可脱离 Electron 测试） |
| `plugin-installer.js` | `.dlmpet` 插件包校验、解压、安装、卸载 |
| `llm-chat/` | 内置插件：AI 对话 |

相关文档：

- 安装/管理插件：`docs/plugins/installing.md`
- 打包插件：`docs/plugins/packaging.md`
- 插件开发：`docs/plugins/development.md`

> 用户安装的插件不在本目录，而在 Electron 的 `userData/plugins/` 下；设置 → 🧩 插件 里可查看实际路径。
