# 第三方组件与许可说明

本文件列出仓库中随附或打包分发的第三方内容，以及**发布前需要确认**的许可事项。以下内容是根据仓库文件整理的事实记录，不构成法律意见；是否可以分发请以各许可证原文和你方的法律判断为准。

## ⚠️ 发布前必须处理

### 1. Anthropic 文档技能（docx / pptx / xlsx / pdf）

`resources/skills/docx`、`pptx`、`xlsx`、`pdf` 各自附带的 `LICENSE.txt` 写明：版权归 Anthropic, PBC 所有，使用受与 Anthropic 的服务协议约束，并且**明确禁止**在其服务之外提取或保留副本、复制、制作衍生作品、向第三方分发或再许可。

`electron-builder.yml` 当前会把整个 `resources/skills` 打进安装包，也就是会分发这些文件。在获得授权之前，建议：

- 不要对外发布包含这四个技能的安装包；或
- 用自己编写、可再分发的实现替换它们，并相应修改 `SKILL.md` 引用。

### 2. LibreDWG（DWG 转换）

CAD 技能会调用 `resources/skills/cad/vendor/win64/` 下的 dwg2dxf / LibreDWG。LibreDWG 以 **GPL-3.0** 发布。随应用分发其二进制时，需要遵守 GPL 的条款（提供对应源码或获取方式、附带许可证文本等），并评估对整体分发方式的影响。

### 3. 代码与内容来源

代码注释中多处出现“对齐原版”及原始函数名（如 `ARr`、`YKs`、`U1s`、`QAr`、`npt`），`resources/skills/_profiles/ai-scheme/SKILL.md` 曾出现某第三方产品的方案入口描述，`ensure_sketchup.py` 引用了本仓库中不存在的 `windowsUtf8Shell.ts`。这些迹象表明部分实现、提示词、技能或预设内容可能参照或来源于其他产品。商用或公开发布前，请确认相关内容的授权。

## 其他随附组件

| 组件 | 位置 | 许可证 |
|---|---|---|
| frontend-design 技能 | `resources/skills/frontend-design` | Apache-2.0（见目录内 `LICENSE.txt`） |
| pdf.js 字符映射表与标准字体 | `src/renderer/public/pdfjs/` | 见目录内 `LICENSE`、`LICENSE_FOXIT`、`LICENSE_LIBERATION` |
| npm 依赖 | `package.json` | 各依赖自身的许可证（可用 `npx license-checker --production` 汇总） |
| MCP 连接器依赖 | `resources/mcp/*/lib`、`node_modules` | 各包自身的许可证，放置时请一并保留 |

## 本项目

本项目尚未声明许可证（仓库中没有 `LICENSE` 文件）。在补充之前，他人默认不获得使用、修改或分发本项目代码的授权。
