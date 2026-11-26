# design-agent

空间设计智能体桌面工作台：面向建筑、室内、景观设计师的 Windows 桌面应用。智能体运行在独立进程中，通过 MCP 连接本机的 SketchUp、Blender、3ds Max、Rhino、AutoCAD 等设计软件，并内置 CAD 图纸解析、规范检索、出图提示词改写、汇报文档（PPT / Word / Excel / PDF）等技能。

> 本项目为**个人自用**，不对外分发。代码评审报告、修复记录与当前状态见 [`docs/review.md`](docs/review.md)。

## 功能概览

- **设计软件连接器**：SketchUp、Blender、3ds Max、Rhino、Photoshop、multicad（AutoCAD / 中望 / 浩辰 / BricsCAD）、computer-use，默认关闭、按需启用。
- **技能**：`resources/skills/` 下每个子目录一个技能（`SKILL.md` + 脚本），智能体按需读取。
- **确定性预设**：`resources/presets/`，如客厅 SketchUp 参数化工程包、CAD 户型种子图包。
- **长任务机制**：断点续跑、审批挂起（可跨重启）、上下文自动压缩、超长输出转存、子智能体。
- **工作台**：CAD、三维模型、PDF、Office 文件预览，PPT 修改提案，改图前后对比。

## 目录结构

```
src/
  main/       主进程：窗口、IPC（含路径授权校验）、本地存储、MCP 管理、预览转换
  preload/    contextBridge 暴露的 window.designAgent 接口
  runtime/    智能体进程：主循环、工具、断点与压缩、子智能体、MCP 桥接
  renderer/   界面（React 19 + Zustand + Tailwind 4）
  shared/     IPC 协议类型、路径安全工具、PPT 解析等
resources/
  skills/     技能
  presets/    预设工程包
  mcp/        各连接器的配置与依赖
  regulations/ 示例规范库
  runtime/    内置运行时（Python、reg-indexer.exe、design_native.dll 等，未纳入 Git）
scripts/      verify-runtime.ts（端到端测试）、check-resources.mjs、mock-mcp-server.mjs
tools/        RegIndexerCs（C# 规范索引器）、native-core（C++ 原生库）
```

## 环境要求

- Windows 10 / 11 x64
- Node.js 22 及以上、npm
- 可选：Python 3.10+（未放置内置 Python 时，CAD 解析等技能会使用系统 Python）
- 可选：LibreOffice（部分文档技能用于格式转换与渲染）
- 可选：.NET SDK 10 与 MinGW（g++），从源码编译 `reg-indexer.exe` / `design_native.dll` 时需要
- 使用对应连接器时，需要本机已安装相应设计软件及其插件（见下文）

## 快速开始

```bash
npm install
npm run fetch:resources   # 首次或换机器时：拉取内置运行资源（见「运行资源」）
npm run check:resources   # 检查内置运行资源是否齐全（缺失时会列出受影响的功能）
npm run dev               # 开发模式
```

首次启动后，在左下角「设置 → 模型与 API」中添加模型配置（支持 OpenAI 兼容与 Anthropic 协议）。也可以通过环境变量预置：`DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY`、`OPENAI_API_KEY`（配合 `OPENAI_BASE_URL`）、`ANTHROPIC_API_KEY`（配合 `ANTHROPIC_BASE_URL`），生图渠道可用 `IMAGE_GEN_API_KEY`。

API Key 保存在用户数据目录的 `model-settings.json` 中，系统支持时使用 Electron `safeStorage` 加密；界面只拿到脱敏后的值。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式启动 |
| `npm run build` | 构建到 `out/` |
| `npm run typecheck` | 主进程与界面两套 TypeScript 类型检查 |
| `npm run test:runtime` | 端到端测试（需先 `npm run build`，测试会启动 `out/main/runtime.js`） |
| `npm run check:resources` | 检查 `resources/` 下的内置运行资源 |
| `npm run pack:resources` | 把内置运行资源打成 `dist-resources/*.tar.gz` |
| `npm run fetch:resources` | 从 `resources-bundle.json` 配置的地址下载并解压运行资源 |
| `npm run build:runtime` | 从源码编译 `reg-indexer.exe` 与 `design_native.dll`（需要 .NET SDK 10 与 g++） |
| `npm run dist:win` | 构建并打包 Windows 安装包（输出到 `dist/`） |

## 运行资源（未纳入 Git）

以下二进制与第三方依赖体积较大，已在 `.gitignore` 中排除，需要单独放置到对应目录。缺少时应用仍能启动，但相关功能不可用：

| 路径 | 用途 | 缺少时的影响 |
|---|---|---|
| `resources/runtime/python/python.exe` | 内置 Python（技能脚本与 Python 类 MCP 连接器） | 回退到系统 `python`；连接器依赖可能不全 |
| `resources/runtime/node/node.exe` | 内置 Node（Photoshop 连接器） | 回退到 Electron 自带的 Node |
| `resources/runtime/reg-indexer.exe`、`design_native.dll` | 规范库 SQLite 全文索引 | 回退到较慢的逐文件扫描 |
| `resources/skills/cad/vendor/win64/` | dwg2dxf / LibreDWG，DWG 转 DXF | 无法解析 DWG（DXF 不受影响） |
| `resources/mcp/sketchup/lib/` | `sketchup_mcp` Python 包 | SketchUp 连接器不可用 |
| `resources/mcp/blender/lib/` | `blender_mcp` Python 包 | Blender 连接器不可用 |
| `resources/mcp/3dsmax/lib/` | `maxmcp` Python 包与 3ds Max 插件 bundle | 3ds Max 连接器不可用 |
| `resources/mcp/multicad/lib/` | multicad 连接器（`server.py`） | CAD 编辑连接器不可用 |
| `resources/mcp/photoshop/node_modules/` | `@alisaitteke/photoshop-mcp`（可在该目录执行 `npm install` 获取） | Photoshop 连接器不可用 |
| `resources/mcp/computer-use/cua-driver.exe` | 电脑操控驱动 | computer-use 连接器不可用 |

各设计软件还需要安装宿主侧插件：SketchUp 扩展、Blender 插件 `blender_mcp.py`、3ds Max 插件包、Rhino 的 Rhino-MCP-Platform（可在设置中一键安装的会有提示）。

### 用资源包在多台机器间同步

这些资源不在 Git 里，换机器时用资源包还原：

```bash
# 1. 在一台已备齐资源的机器上打包，输出 dist-resources/design-agent-resources-v*.tar.gz
npm run pack:resources

# 2. 把压缩包上传到 GitHub Release（私有仓库的 Release 同样可用），
#    将下载地址与 sha256 填进仓库根目录的 resources-bundle.json

# 3. 在新机器 clone 之后（私有仓库需先在仓库根目录放好 gh-token.txt，见下文）
npm run fetch:resources
npm run check:resources   # 应显示 11 项全部就绪
```

`resources-bundle.json` 默认指向私有仓库 `xiaohai1314-sys/design-agent-resources` 的 Release 资产。私有仓库不能直接用 `releases/download/` 直链（带令牌也会 404），脚本走的是 API 资产端点 `https://api.github.com/repos/{owner}/{repo}/releases/assets/{id}`，需要令牌：在 <https://github.com/settings/personal-access-tokens/new> 新建 Fine-grained token，只授权 `design-agent-resources` 一个仓库、Repository permissions → Contents 选 **Read-only**，然后把令牌写进仓库根目录的 `gh-token.txt`（只有一行，已被 `.gitignore` 忽略），或用 `GH_TOKEN` 环境变量。重新上传资源包后资产 ID 会变，需要同步更新 `resources-bundle.json` 里的 `url`。

也可以临时指定地址，不写配置文件：

```bash
RESOURCES_BUNDLE_URL=<地址> npm run fetch:resources
```

`RESOURCES_BUNDLE_URL` 支持 `http(s)://` 地址，也支持本地路径（U 盘、局域网共享或离线校验时用）：

```bash
RESOURCES_BUNDLE_URL=dist-resources/design-agent-resources-v1.0.0.tar.gz npm run fetch:resources
```

网盘（115、百度网盘等）的分享链接不能直接填 —— 那类页面需要登录，`fetch` 拿到的是 HTML 而不是文件。用法是先在浏览器里把资源包下载到本地，再按上面的本地路径方式指定。

### 从源码编译

`npm run dist:win` 会先编译 C# 与 C++ 原生组件，再打包安装包。需要以下工具：

| 工具 | winget 包 | 用途 |
|---|---|---|
| Node.js | `OpenJS.NodeJS.LTS` | 构建前端与主进程 |
| .NET SDK 10 | `Microsoft.DotNet.SDK.10` | 编译 C# 的 `reg-indexer.exe` |
| MinGW（WinLibs） | `BrechtSanders.WinLibs.POSIX.UCRT` | 编译 C++ 的 `design_native.dll` |

.NET 要看的是 `dotnet --list-sdks` 里有没有 10.x，只装 .NET Runtime 时 `dotnet` 命令也在，但编译 `reg-indexer` 会失败。C# 工程目标框架是 `net10.0-windows10.0.19041.0`，Windows 相关引用包由 NuGet 还原，不需要 Visual Studio 或 Windows SDK。

打包时 electron-builder 要下载 Electron 与签名工具，直连 GitHub 经常中断，可以改用镜像：

```cmd
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist:win
```

中途失败直接重跑，已下载的部分有缓存。

`resources/runtime/reg-indexer.exe` 与 `design_native.dll` 可以从源码重建（`npm run build:runtime`，需要 .NET SDK 10 与 g++）；其余资源（Python/Node 运行时、连接器依赖、LibreDWG、cua-driver）只能从资源包获取。

## 安全相关的默认行为

| 项目 | 当前行为 | 调整位置 |
|---|---|---|
| API Key | 用 `safeStorage` 加密保存；界面只拿到脱敏值，从 CC Switch / Claude / Codex 导入的 Key 只留在主进程 | `src/main/store.ts`、`src/main/index.ts` |
| 写文件、执行命令、生图、MCP 工具 | 默认逐次审批；可切到“自动”模式，或在审批时选“本轮全部允许”（只对当前这一轮生效） | 界面右下角权限模式 |
| 写项目记忆（`remember`） | 自用版本不审批 | `src/runtime/index.ts` 的 `gatedToolNames` |
| 打开文件 | 可执行文件与脚本（`.exe`、`.bat`、`.ps1` 等）不直接运行，改为在资源管理器中定位 | `src/main/index.ts` 的 `BLOCKED_OPEN_EXTS` |
| 外链 | 只允许 `http`、`https`、`mailto`，主窗口不会被导航到其他页面 | `src/main/index.ts` |
| 渲染进程 | 开启 `sandbox`；打包版注入 CSP，允许从 `https:` 加载脚本、样式、字体和图片，`fetch` / XHR 只能访问本地 | `electron.vite.config.ts` |

## 打包

```bash
npm run dist:win
```

`electron-builder.yml` 会把 `resources/skills`、`presets`、`regulations`、`mcp`、`runtime` 作为 extraResources 打进安装包。安装包只供自己的机器使用；如果打算给别人，请先阅读 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)：部分内置技能与依赖的许可证限制再分发。

## 许可证

本项目为个人自用，未声明许可证。第三方组件的许可情况见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
