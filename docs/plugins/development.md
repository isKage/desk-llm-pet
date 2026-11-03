# 🧩 DeskLLMPet 插件开发指南

本文档介绍 DeskLLMPet 的**插件宿主**与插件开发接口。所有「可选功能」都以插件形式存在：

- 插件出错 / 缺失 / 被禁用，**本体功能完全不受影响**；
- 本体代码不 import 任何具体插件，插件也只通过宿主提供的 `ctx` 使用本体能力；
- 删除某个插件目录即可彻底下线该功能，不需要改动一行本体代码。

内置插件：

| 插件 | 说明 |
|------|------|
| [`llm-chat`](../../src/plugins/llm-chat) | AI 对话窗口（多会话、流式回复、独立配置） |

> 🛒 更多可选插件与收录信息见 [DeskLLMPet 插件市场](https://github.com/isKage/desk-llm-pet-plugins-market)。

---

## 1. 目录结构

```
src/plugins/                     # 内置插件（只读，随应用打包）
├── plugin-manager.js            # 宿主：发现 / 校验 / 激活 / 卸载 / 菜单 / 设置 / IPC
├── manifest.js                  # 清单规范化与校验（纯函数）
├── plugin-installer.js          # 插件包校验、解压、安装、卸载
├── README.md                    # 指向本文档
└── <builtin-plugin>/            # 一个目录 = 一个插件
    ├── plugin.json              # 清单（必需）
    ├── main.js                  # 主进程入口（必需）
    ├── preload.js               # 渲染进程桥（可选）
    └── renderer/                # 插件页面（可选）

<userData>/plugins/<plugin-id>/   # 用户安装/手动放入的插件
<userData>/plugin-data/<plugin-id>/ # 插件私有数据
```

> 以 `_` 或 `.` 开头的目录会被宿主忽略，可用来放插件共用的工具代码。用户插件从 `.dlmpet` 安装后也使用同一套目录结构。

---

## 2. 清单 `plugin.json`

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一句话说明",
  "author": "you",
  "apiVersion": 1,
  "main": "main.js",
  "preload": "preload.js",
  "enabled": true,
  "contributes": {
    "petMenu":  [{ "command": "open", "label": "打开我的插件", "icon": "🧩", "order": 10 }],
    "trayMenu": [{ "command": "open", "label": "打开我的插件", "icon": "🧩" }],
    "settings": {
      "title": "我的插件",
      "icon": "🧩",
      "description": "面板顶部的说明文字",
      "fields": [
        { "key": "apiKey",     "label": "API Key", "type": "password", "default": "" },
        { "key": "model",      "label": "模型",     "type": "text",     "default": "deepseek-chat" },
        { "key": "temperature","label": "随机性",   "type": "number",   "default": 0.7, "min": 0, "max": 2, "step": 0.1 },
        { "key": "stream",     "label": "流式输出", "type": "boolean",  "default": true },
        { "key": "prompt",     "label": "提示词",   "type": "textarea", "default": "", "rows": 3 },
        { "key": "mode",       "label": "模式",     "type": "select",   "default": "a",
          "options": [{ "value": "a", "label": "模式 A" }, { "value": "b", "label": "模式 B" }] }
      ],
      "actions": [{ "id": "test", "label": "🔗 测试连接", "style": "secondary" }]
    }
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `id` | ✅ | 插件唯一标识，小写，只允许字母数字和 `. _ -`，且必须以字母/数字开头 |
| `name` / `version` / `description` | ✅ | 展示信息；`version` 使用 semver（如 `1.0.0`） |
| `author` | | 作者名，显示在插件管理列表 |
| `apiVersion` | | 宿主 API 版本，缺省为 `1`；大于宿主版本时拒绝加载 |
| `main` | | 主进程入口，默认 `main.js`，必须位于插件目录内 |
| `preload` | | 插件窗口的预加载脚本，由宿主统一注入到 `ctx.createWindow` 创建的窗口 |
| `enabled` | | 显式设为 `false` 可整体禁用该插件（UI 中不可开启） |
| `contributes.petMenu` | | 桌宠右键菜单项，`command` 为命令标识 |
| `contributes.trayMenu` | | 系统托盘菜单项 |
| `contributes.settings` | | 设置页面板（通用表单，本体负责渲染与存取） |

> 任何一项校验失败只会让**该插件**被跳过，终端会打印 `⚠️ 插件加载失败 [id]: 原因`。

---

## 3. 主进程入口 `main.js`

```js
module.exports = {
  /** 激活：注册 IPC、监听命令、准备资源；应尽快返回，不要在这里做网络请求 */
  activate(ctx) {
    ctx.ipc.handle('ping', () => ({ pong: Date.now() }));

    ctx.onCommand((command, payload) => {
      if (command === 'open') openMyWindow(ctx);
    });

    ctx.onSettingsAction(async (actionId, values) => {
      if (actionId !== 'test') return { success: false, error: '未知动作' };
      return { success: true, message: '✅ 连接成功' };
    });

    ctx.onDeactivate(() => { /* 清理定时器 / 取消请求 */ });
  },

  /** 可选：宿主卸载插件时调用 */
  deactivate(ctx) {}
};
```

### `ctx` 能力总览

| 成员 | 说明 |
|------|------|
| `ctx.id / name / version / description / author / apiVersion / origin / dir / manifest` | 基本信息、来源与插件目录 |
| `ctx.log(...) / ctx.warn(...)` | 带插件前缀的日志 |
| `ctx.resolve(...paths)` | 解析插件目录内的绝对路径 |
| `ctx.ipc.handle(channel, handler)` | 注册 `invoke` 处理器，真实通道为 `plugin:<id>:<channel>` |
| `ctx.ipc.on(channel, handler)` | 注册单向消息处理器（同样自动命名空间化） |
| `ctx.ipc.send(channel, payload)` | 向**本插件创建的所有窗口**广播消息 |
| `ctx.dataDir` | 插件私有数据目录 `<userData>/plugin-data/<id>/` |
| `ctx.resolveData(...paths)` | 解析插件数据目录内的绝对路径 |
| `ctx.createStore(name, defaults)` | 插件私有存储，落在 `<userData>/plugin-data/<id>/<name>.json` |
| `ctx.createWindow(options)` | 创建插件窗口，宿主自动注入 `preload`、`contextIsolation: true`、`nodeIntegration: false`，并阻止窗口导航到插件目录之外 |
| `ctx.settings.get()` | 读取本插件设置（已按清单 `fields` 校验/裁剪/类型转换） |
| `ctx.settings.set(values)` | 保存设置并通知 `onSettingsChanged` |
| `ctx.onCommand(fn)` | 菜单项点击：`fn(command, payload)` |
| `ctx.onSettingsAction(fn)` | 设置页动作按钮：`fn(actionId, values)`，可返回 `{ success, message }` |
| `ctx.onSettingsChanged(fn)` | 设置保存后：`fn(values)` |
| `ctx.onDeactivate(fn)` | 卸载回调 |
| `ctx.host.app / BrowserWindow / shell / dialog` | Electron 对象（宿主注入，便于脱离 GUI 自检） |
| `ctx.host.getSharedLLMConfig()` | 只读共享 LLM 配置，可用于缺省回退；拿不到时返回 `null` |
| `ctx.host.openSettings()` | 打开本体设置窗口，返回是否成功（可能为 `null`） |

**约定**

1. `activate` 必须是**幂等且快速**的：只注册处理器，网络请求等重活留到用户真正触发时再做。
2. 通道名不要带 `plugin:` / `plugins:` 前缀，宿主会自动加。
3. 所有外部依赖都要兜底：`ctx.host.*` 的服务可能不存在。
4. 不要在插件里修改本体的配置文件 —— 只读宿主服务已经够用。

---

## 4. 渲染进程

`preload.js` 里的通道名需要与主进程一致：

```js
const { contextBridge, ipcRenderer } = require('electron');
const channel = (name) => `plugin:my-plugin:${name}`;

contextBridge.exposeInMainWorld('myAPI', {
  ping: () => ipcRenderer.invoke(channel('ping')),
  onSomething: (cb) => ipcRenderer.on(channel('something'), (e, data) => cb(data))
});
```

窗口由插件自己在主进程创建：

```js
const path = require('path');
const win = ctx.createWindow({ width: 800, height: 600, show: false });
win.loadFile(path.join(ctx.dir, 'renderer', 'index.html'));
win.once('ready-to-show', () => win.show());
```

---

## 5. 宿主注册表 IPC（本体 ↔ 插件）

本体渲染进程（桌宠 / 设置页）通过这些通道消费插件贡献，插件无需关心：

| 通道 | 用途 |
|------|------|
| `plugins:list` | 已加载的插件列表 |
| `plugins:get-pet-menu` | 桌宠右键菜单项 |
| `plugins:get-tray-menu` | 托盘菜单项 |
| `plugins:run-command` | 触发插件命令 `(pluginId, command, payload)` |
| `plugins:get-settings-sections` | 设置面板定义（标题 / 字段 / 动作） |
| `plugins:get-settings` / `plugins:set-settings` | 读写插件设置 |
| `plugins:run-settings-action` | 触发设置页动作按钮 |
| `plugins:changed`（主→渲染） | 插件加载变化，渲染进程可据此刷新菜单 |

---

## 6. 发布与插件市场

插件开发完成、本地测试通过后：

1. 用 `npm run pack:plugin -- <插件目录>` 生成 `.dlmpet`；
2. 在插件自己的仓库 / GitHub Release 上传插件包；
3. 到 [DeskLLMPet 插件市场](https://github.com/isKage/desk-llm-pet-plugins-market) 提交收录或发布信息；
4. 用户即可在 **设置 → 🧩 插件** 中安装。

发布时建议写清楚：

- 适用版本（`apiVersion` / 最低主程序版本）；
- 插件用途、权限与网络访问说明；
- 安装/卸载后是否需要保留数据；
- 更新日志与问题反馈地址。

> 插件市场目前是 GitHub 仓库形式；提交方式、索引格式与审核规则以市场仓库说明为准。

## 7. 自检

```bash
npm run check           # 静态自检（不需要 GUI，秒级）
npm run check:renderer  # 真实 Electron 渲染进程冒烟测试（会短暂创建隐藏窗口）
```

`npm run check` 会做这些事：

1. 对 `src` 下所有 `.js` 执行 `node --check`（语法检查）；
2. 用假 Electron / 内存存储启动宿主，校验所有 `plugin.json`；
3. 模拟加载插件、拉取菜单与设置面板、派发命令与设置动作，确认扩展点可用；
4. 断言本体核心文件**不引用任何具体插件**（插件化隔离），且回收站功能已彻底移除；
5. 校验 IPC 通道与预加载脚本一一对应、页面元素引用存在；
6. 运行插件安装器测试（包校验、路径安全、安装/卸载、旧数据迁移）；
7. 校验文档相对链接有效。

`npm run check:renderer` 会真正加载桌宠 / 设置 / 对话三个页面，验证
preload 桥、插件菜单注入、设置面板动态渲染与整条 IPC 往返链路。
若所在环境的 Chromium 沙箱不可用（例如容器或受限终端），追加 `--no-sandbox`：

```bash
npx electron scripts/smoke-renderer.js --no-sandbox
```

新增插件后请至少跑一次 `npm run check`，确保不会拖垮宿主。

插件打包与发布见 [打包插件](packaging.md)；用户安装/管理见 [安装与管理插件](installing.md)。
