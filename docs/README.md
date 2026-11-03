# 📚 DeskLLMPet 文档

所有说明文档都在 `docs/` 下。新手建议按顺序阅读：先装起来，再配置 API，最后按需看插件和开发。

## 使用

| 文档 | 内容 |
|---|---|
| [安装、升级与卸载](guide/install.md) | 下载哪个包、怎么覆盖升级、怎么清理数据 |
| [API 与桌宠配置](guide/configure.md) | DeepSeek API Key、余额气泡、动画池、宠物外观、双击语句 |
| [自定义图标与动画](guide/customize.md) | 换图标、放入 `.webm` 动画、素材格式要求 |
| [常见问题](guide/faq.md) | 改了代码没生效、单实例、DevTools、平台差异 |

## 插件

| 文档 | 内容 |
|---|---|
| [安装与管理插件](plugins/installing.md) | 设置页选包/拖拽安装、插件目录、启用禁用、卸载、安全提示 |
| [打包插件](plugins/packaging.md) | `npm run pack:plugin`、`.dlmpet` 包结构、发布到 GitHub Release |
| [插件开发指南](plugins/development.md) | 清单字段、`activate(ctx)`、菜单/设置/IPC/窗口/存储接口 |

## 开发与发布

| 文档 | 内容 |
|---|---|
| [技术架构](dev/architecture.md) | 进程/窗口划分、目录结构、插件加载与 IPC 设计 |
| [本地开发与发布](dev/development.md) | 环境、运行、自检、打包、版本与 Release 流程 |

## 其它

- [更新日志](../CHANGELOG.md)
- [贡献指南](../CONTRIBUTING.md)
- [返回项目主页](../README.md)
