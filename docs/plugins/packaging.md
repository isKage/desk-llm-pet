# 打包插件

插件包是一个 ZIP 文件，推荐使用 `.dlmpet` 扩展名。应用会校验包结构、清单、路径安全和大小限制。

## 1. 目录结构

```text
my-plugin/
├── plugin.json          # 必需
├── main.js              # 主进程入口（默认）
├── preload.js           # 可选
├── renderer/            # 可选，插件自己的页面
│   ├── index.html
│   ├── index.js
│   └── index.css
└── LICENSE / README.md  # 可选
```

`plugin.json` 必须在包根目录，或位于唯一一层包装目录中；不要出现两个 `plugin.json`，也不要根目录与包装目录混放。

## 2. 清单示例

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
    "petMenu": [{ "command": "open", "label": "打开我的插件", "icon": "🧩", "order": 10 }],
    "trayMenu": [{ "command": "open", "label": "打开我的插件", "icon": "🧩" }],
    "settings": {
      "title": "我的插件",
      "icon": "🧩",
      "description": "面板说明",
      "fields": [
        { "key": "apiKey", "label": "API Key", "type": "password", "default": "" }
      ],
      "actions": [{ "id": "test", "label": "🔗 测试连接", "style": "secondary" }]
    }
  }
}
```

字段说明见 [插件开发指南](development.md)。

## 3. 使用打包脚本

```bash
# 默认输出到 dist-plugins/
npm run pack:plugin -- path/to/my-plugin

# 指定输出目录
node scripts/pack-plugin.js path/to/my-plugin --out ./release-plugins
```

输出文件名：`<id>-<version>.dlmpet`。

脚本会：

1. 读取并校验 `plugin.json`；
2. 排除 `node_modules/`、`.git/`、`.DS_Store`、日志等无关文件；
3. 生成 ZIP；
4. 立即调用安装器的 `inspectPackage()` 做一次自校验；
5. 校验失败则删除产物并以非 0 退出。

> `dist-plugins/` 已在 `.gitignore` 中。不要把插件包提交进主仓库；发布时作为 GitHub Release 的附件上传。

## 4. 本地测试安装

1. 设置 → 🧩 插件 → 选择刚生成的 `.dlmpet`；
2. 预览并安装；
3. 测试菜单、设置面板、窗口、IPC；
4. 卸载后重新安装，确认数据保留/清理符合预期；
5. 在 Windows 和 macOS 各测一次（路径大小写、文件占用）。

也可以直接把包放进插件目录，重启或点「重新扫描」测试自动安装。

## 5. 发布到 GitHub Release

1. 在插件自己的仓库/Release 中上传 `<id>-<version>.dlmpet`；
2. 在说明里写清：支持的 DeskLLMPet 版本（`apiVersion`）、安装方法、权限/网络访问说明；
3. 用户下载后在设置页安装即可。

## 6. 包大小与安全限制

| 项 | 限制 |
|---|---|
| 包大小 | ≤ 20MB |
| 解压总量 | ≤ 100MB |
| 条目数 | ≤ 2000 |
| 单文件 | ≤ 32MB |
| 路径 | 禁止绝对路径、`..`、反斜杠、symlink、加密条目 |
| 名称 | 禁止 Windows 保留名、尾随点/空格、重复路径（大小写不敏感） |

插件包不携带签名；安装页只显示 SHA-256 前 12 位。请从可信渠道分发。

## 7. 相关文档

- [安装与管理插件](installing.md)
- [插件开发指南](development.md)
