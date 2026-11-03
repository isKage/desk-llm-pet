# 技术架构

## 1. 总览

DeskLLMPet 是一个 Electron 应用：

- **主进程**：窗口、托盘、IPC、配置存储、插件宿主。
- **渲染进程**：桌宠、气泡、右键菜单、设置页、插件页面，全部原生 HTML/CSS/JS。
- **preload**：通过 `contextBridge` 暴露最小 API；渲染进程不开 `nodeIntegration`。
- **插件**：在主进程中运行，通过宿主注入的 `ctx` 使用菜单、设置、IPC、窗口、存储能力；插件失败只跳过该插件。

```text
┌────────────── 主进程 ──────────────┐
│ main.js                            │
│  ├─ pet-window / bubble-window     │
│  ├─ menu-window / settings-window  │
│  ├─ tray                           │
│  ├─ ipc-handlers                   │
│  └─ plugins/plugin-manager         │
│       ├─ manifest.js               │
│       ├─ plugin-installer.js       │
│       └─ builtin plugins           │
└───────────────┬────────────────────┘
                │ IPC（contextBridge）
┌───────────────┴────────────────────┐
│ 渲染进程：pet / bubble / menu /    │
│ settings / 插件自己的页面           │
└────────────────────────────────────┘
```

## 2. 目录结构

```text
DeskLLMPet/
├── src/
│   ├── main/                    # 主进程
│   │   ├── main.js              # 入口、生命周期、插件初始化
│   │   ├── pet-window.js        # 桌宠透明窗口
│   │   ├── bubble-window.js     # 气泡悬浮窗口
│   │   ├── menu-window.js       # 右键菜单窗口（按内容自适应）
│   │   ├── settings-window.js   # 设置窗口
│   │   ├── tray.js              # 系统托盘（含插件菜单项）
│   │   └── ipc-handlers.js      # 本体 IPC
│   ├── preload/                 # 各窗口 preload
│   ├── renderer/                # 各窗口页面
│   │   ├── pet/
│   │   ├── bubble/
│   │   ├── menu/
│   │   └── settings/            # 设置页（含插件管理 + 插件设置面板）
│   ├── shared/                  # 共享模块
│   │   ├── store.js             # 本体配置
│   │   └── deepseek-api.js      # 余额查询
│   └── plugins/                 # 内置插件与宿主
│       ├── plugin-manager.js    # 发现/校验/激活/卸载/菜单/设置/IPC
│       ├── manifest.js          # 清单规范化与校验（纯函数）
│       ├── plugin-installer.js  # 插件包校验、解压、安装、卸载
│       ├── README.md            # 指向 docs/plugins/development.md
│       └── llm-chat/            # 内置插件：AI 对话
├── scripts/                     # 自检、安装器测试、文档检查、打包
├── assets/                      # 运行时素材
├── build/                       # 构建期图标
├── docs/                        # 全部说明文档
└── .github/                     # CI / Release 流水线
```

## 3. 窗口与进程

| 窗口 | 特点 |
|---|---|
| 桌宠 | 透明、无边框、可拖拽、置顶；按裁剪比例调整窗口大小 |
| 气泡 | 独立透明窗口，浮在宠物上方，不拦截鼠标；大小/偏移可配 |
| 右键菜单 | 独立窗口，按内容测量尺寸，贴在鼠标处，超出屏幕时翻转/内部滚动 |
| 设置 | 普通窗口；macOS 隐藏标题栏，Windows 自定义标题栏 |
| 插件窗口 | 由插件 `ctx.createWindow()` 创建；宿主注入 preload，并阻止导航到插件目录外 |

所有窗口位置/尺寸统一用 `setBounds`，避免 Windows 非整数 DPI 下 `setPosition` 取整误差累积。

## 4. 插件系统

### 4.1 来源

| 来源 | 路径 | 可写 | 说明 |
|---|---|---|---|
| 内置 | `src/plugins/<id>/`（打包后位于 `app.asar`） | 否 | 随应用发布，可禁用不可卸载 |
| 用户安装 | `app.getPath('userData')/plugins/<id>/` | 是 | 从 `.dlmpet` 安装或手动放入 |

同 id 冲突时内置优先；用户插件被标记为错误并跳过。

### 4.2 插件包

`.dlmpet` 是 ZIP 包，根目录（或唯一一层包装目录）包含 `plugin.json`。安装时：

1. 只读检查中央目录与清单，校验 id / 版本 / `apiVersion` / 路径安全 / 大小限制；
2. 解压到 `userData/plugins/.staging/<随机>`；
3. 再次校验清单与入口文件；
4. 旧版本目录备份到 `.trash`，原子替换到 `plugins/<id>`；
5. 插件包归档到 `.packages/`，状态写入 `plugins-state.json`；
6. 热重载：卸载旧记录、清 `require.cache`、重新发现并激活。

### 4.3 插件接口

- `plugin.json` 声明菜单（`contributes.petMenu` / `trayMenu`）、设置面板（`contributes.settings`）、入口 `main`、preload。
- 入口导出 `activate(ctx)` / `deactivate(ctx)`。
- `ctx` 提供：`ipc.handle/on/send`、`createWindow`、`createStore`、`settings.get/set`、`onCommand`、`onSettingsAction`、`onSettingsChanged`、`onDeactivate`、`host.*`。
- 插件 IPC 自动命名空间为 `plugin:<id>:<channel>`；宿主注册表为 `plugins:*`。
- 插件窗口禁止导航到插件目录之外，外链交给系统浏览器。

### 4.4 数据隔离

- 插件代码：`userData/plugins/<id>/`
- 插件数据：`userData/plugin-data/<id>/`（`ctx.settings`、`ctx.createStore` 都落在这里）
- 安装状态：`userData/plugins-state.json`
- 本体配置：Electron Store 默认的 `config.json`

旧版本把插件数据放在 `userData/plugins/<id>/`；升级后首次启动会自动迁移到 `plugin-data/`。

## 5. IPC 与安全

- 渲染进程一律通过 preload + IPC，`contextIsolation: true`、`nodeIntegration: false`。
- 本体 IPC 通道集中在 `ipc-handlers.js`；插件注册表通道在 `plugin-manager.js`。
- 插件管理（安装/卸载/启用/重载/打开目录）只允许设置窗口调用，主进程校验 sender URL。
- 插件本身不沙箱，拥有主进程 Node.js 权限；安装前必须确认来源可信。
- API Key 只存本地，不上传。

## 6. 相关文档

- [插件开发指南](../plugins/development.md)
- [安装与管理插件](../plugins/installing.md)
- [本地开发与发布](development.md)
