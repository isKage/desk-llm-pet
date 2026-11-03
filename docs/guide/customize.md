# 自定义图标与动画

## 1. 更换应用图标

图标分两套：

| 目录 | 用途 | 文件 |
|---|---|---|
| `build/` | electron-builder 打包用 | `icon-source.png`、`icon.icns`、`icon.ico` |
| `assets/` | 运行时 Dock / 托盘 | `icon.png`、`tray-icon.png` |

### 步骤

1. 准备一张 **1024×1024** 的 PNG（建议透明背景），放到 `build/icon-source.png`。
2. 生成 `build/icon.png` 和 `build/tray-icon.png`：

   ```bash
   node scripts/generate-icons.js
   ```

3. 把 `build/icon.png` 复制为 `assets/icon.png`，把 `build/tray-icon.png` 复制为 `assets/tray-icon.png`（运行时读取的是 `assets/`）。
4. 用在线工具或设计软件生成：
   - PNG → ICNS：<https://cloudconvert.com/png-to-icns> → `build/icon.icns`
   - PNG → ICO：<https://cloudconvert.com/png-to-ico>（256×256）→ `build/icon.ico`
5. 重新打包。

> `scripts/generate-icons.js` 只负责生成 PNG；`.icns` / `.ico` 需要自行转换。

## 2. 添加动画素材

把 `.webm` 文件放到：

```text
assets/animations/idle/    # 闲置动画
assets/animations/click/   # 点击反应动画
```

应用启动和打开设置页时会扫描这些目录。也可以在设置 → 动画素材里勾选启用哪些文件。

### 格式要求

- 格式：WebM（VP8 / VP9 编码）；
- 建议启用透明通道（Alpha），使用 `yuva420p`；
- 分辨率建议 512×512 以内；
- 单个文件建议 < 5MB。

### 用 FFmpeg 转换

```bash
ffmpeg -i input.mov -c:v vp9 -pix_fmt yuva420p output.webm
```

或使用 Adobe After Effects、Blender 等工具导出带透明通道的 WebM。

> 动画素材体积较大，仓库默认只保留示例；素材来源见 README 致谢。

## 3. 动画池与点击判定

- 闲置动画池：桌宠空闲时随机播放。
- 点击反应动画池：单击桌宠时随机播放。
- 双击才弹气泡；文件名里带「点击回应 / 被吓 / 被鼠标 / 拖拽 / 炸毛 / 害羞 / 生气 / 开心跃动 / 傲娇」等关键词的动画会被自动归到点击反应池（`assets/thumb/` 扫描规则同理）。

## 4. 相关文档

- [API 与桌宠配置](configure.md)
- [插件开发指南](../plugins/development.md)
