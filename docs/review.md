# design-agent 代码评审报告

> **项目**：空间设计智能体桌面工作台（design-agent-desktop 1.0.0）
> **代码位置**：`F:\design-agengt`（克隆自 github.com/xiaohai1314-sys/design-agent）
> **评审日期**：2026-11-26
> **评审方式**：静态阅读源码，关键正则在本机实测；未构建、未运行，未执行测试与 npm audit。标注“需实测”的条目为根据代码推断。

## 当前状态（2026-11-27）

> 项目定位为**自用**，不对外分发。下文第 1–7 节是 2026-11-26 的原始评审，保留原样作为记录；其中的文件名与前缀是改名前的写法，现已统一替换：`ZNZMO.md` → `DESIGN-AGENT.md`，`.zmo/` → `.design-agent/`，`window.zmo` → `window.designAgent`，`ZMO_*` 环境变量 → `DESIGN_AGENT_*`，`zmo_native.dll` → `design_native.dll`。

### 问题处理进度

| 类别 | 已解决 | 未解决 |
|---|---|---|
| 🔴 高（15） | 14 | C2 许可证与来源（自用可不处理） |
| 🟠 中（21） | 21 | — |
| 🟡 低（4） | 4 | — |

各条的具体改法见文末「修复记录」「复查」「自用调整」三节。

### 当前评分

| 维度 | 评审时 | 现在 |
|---|---|---|
| 想法与行业契合度 | 5 | 5 |
| 架构设计 | 4 | 4.5 |
| 代码质量 | 3.5 | 4 |
| 稳定性 | 2.5 | 4 |
| 性能与成本 | 2.5 | 4 |
| 安全 | 3 | 4 |
| 文档与可复现性 | 1.5 | 3.5 |

评分是根据代码阅读给出的。**`npm run typecheck`、`npm run build`、`npm run test:runtime` 已于 2026-11-27 跑通，`npm run dist:win` 也能正常产出安装包**；端到端脚本覆盖了 MCP 握手、工作区越界与软链防护、断点重启、上下文压缩、PPT 工作台、异步子智能体、中途中断恢复、用量统计、规范检索等 11 组断言，全部通过。界面本身还没有在 Electron 45 中逐项手动操作过，所以「现在」一列是「代码判断 + 自动化验证」的结果，交互层面仍以实际使用为准。

### 仍然存在的限制

- **测试**：只有 `scripts/verify-runtime.ts` 一个端到端脚本，没有单元测试和 CI。
- **MCP 连接**：每一轮重新连接（已改为并行握手），没有做跨轮长连接。
- **后台子任务**：只在当前这一轮有效，本轮结束即取消。
- **`execute`**：能执行任意命令，安全依赖审批；切到“自动”模式或点了“全部允许”后，本轮不再拦截。
- **代码来源**：源码中仍有 19 处“对齐原版”注释（自用不受影响）。

---

## 目录

1. 摘要
2. 项目概览
3. Runtime 核心逻辑评审
4. Prompt 与 Presets 评审
5. 主进程、界面层与性能
6. 安全、合规与可复现性
7. 修复路线图
8. 附录：评审范围与方法

---

## 1. 摘要

### 1.1 总体评价

这是一个完成度很高的垂直领域智能体：用 Electron 做桌面外壳，用独立进程运行 LangChain 智能体，通过 MCP 连接 SketchUp、Blender、3ds Max、Rhino、AutoCAD 等设计软件，再配上 CAD 解析、规范检索、出图提示词、汇报文档等技能。断点续跑、审批挂起、上下文压缩、大段输出转存、子智能体等长任务机制都已具备；主进程对 IPC 入参普遍做了路径和符号链接校验，这一点比同类项目扎实。

主要问题集中在四类：

1. **并发与异常处理不足**：多处缺陷会让任务卡死或进程退出。
2. **“设计正确、接线错误”**：技能文档读不到、预设指令调用方式不对、子智能体白名单写错工具名，核心机制会悄悄失效。
3. **性能**：主进程按 token 粒度同步读写磁盘，长对话明显劣化。
4. **安全与合规**：密钥明文、可一键打开可执行文件、代码来源与许可证待确认，需在对外发布前解决。

### 1.2 最关键的 6 个问题

| 编号 | 问题 | 严重度 | 影响 |
|---|---|---|---|
| P1 | 技能文档和预设文件很可能读不到（读取白名单不含技能目录） | 🔴 高 | “按需加载技能”这一核心机制失效 |
| M1 | 每个 token 主进程同步读写整份对话记录 | 🔴 高 | 长对话越用越卡，拖慢整个应用 |
| R1 / R2 | 并发审批互相覆盖；工具调用 ID 依赖全局变量 | 🔴 高 | 任务卡死，卡片和断点串号 |
| R4 / R5 | Promise 未捕获导致 runtime 退出，且界面收不到通知 | 🔴 高 | 所有进行中的任务永远停在运行状态 |
| S1 / S2 | API Key 明文存储；可一键打开工作区内的可执行文件 | 🔴 高 | 密钥泄露；绕过命令审批 |
| C1 / C2 | 仓库缺运行资源；代码来源与许可证待确认 | 🔴 高 | 无法复现；商用存在法律风险 |

### 1.3 评分一览

| 维度 | 评分 | 说明 |
|---|---|---|
| 想法与行业契合度 | 5 / 5 | 贴近设计师真实流程：读图、建模、出图、汇报 |
| 架构设计 | 4 / 5 | 主进程、智能体进程、界面三层分离，IPC 接口收敛 |
| 代码质量 | 3.5 / 5 | 严格模式 TypeScript，any 很少；但大文件多，几处接线错误 |
| 稳定性 | 2.5 / 5 | 并发审批、异常兜底、进程崩溃恢复都有缺口 |
| 性能与成本 | 2.5 / 5 | 逐 token 写盘；压缩过激；缓存失效；MCP 每轮重连 |
| 安全与合规 | 3 / 5 | 路径校验扎实；密钥、沙箱、外链、许可证需补 |
| 文档与可复现性 | 1.5 / 5 | README 只有标题，运行资源不在仓库里 |

> **建议修复顺序**
> - **第一阶段（约 2–3 天）**：P1、P2、P4、R1–R5、M1、M2，先保证核心机制可用、不卡死、不丢数据。
> - **第二阶段（约 2 天）**：S1–S4、R10、R16，补齐安全基线。
> - **第三阶段（约 3–5 天）**：R6、R7、R13、P3、P5、P6、M3，降低 Token 成本，提升长任务效果。
> - **并行进行**：C1、C2，补 README 与资源拉取脚本，确认来源与许可证。

---

## 2. 项目概览

### 2.1 技术栈与规模

| 项目 | 内容 |
|---|---|
| 桌面框架 | Electron 35.7.5，electron-vite 构建，electron-builder 打包 Windows NSIS 安装包 |
| 界面 | React 19、Zustand、Tailwind 4；three.js 模型预览，pdf.js、mammoth、xlsx 文档预览，Mermaid、KaTeX 渲染 |
| 智能体 | LangChain（@langchain/openai、@langchain/anthropic），支持 OpenAI / Anthropic 兼容的自定义 API |
| 外部软件 | @modelcontextprotocol/sdk，经 stdio 连接 SketchUp、Blender、3ds Max、Rhino、Photoshop、multicad、computer-use |
| 辅助工具 | Python 技能脚本（CAD 解析约 3000 行）、C# 规范索引器 reg-indexer、C++ 原生库 design_native（分词与几何简化） |
| 规模 | 66 个 TS/TSX 文件，连同 Python 脚本共约 5.5 万行；端到端测试 `scripts/verify-runtime.ts` 约 2500 行 |

### 2.2 架构分层

```
┌──────────────────── renderer（界面）────────────────────┐
│ 对话 / 工作台（CAD、模型、PDF、Office、PPT）/ 设置 / 素材库 │
└──────────────▲──────────────────────────────────────────┘
               │ window.designAgent（preload，contextBridge 固定接口）
┌──────────────┴───────────── main（主进程）──────────────┐
│ IPC + 路径校验 / 本地存储 / MCP 管理 / 预览转换 / PPT 回写 │
└──────────────▲──────────────────────────────────────────┘
               │ utilityProcess 消息
┌──────────────┴─────────── runtime（智能体进程）─────────┐
│ 主循环 / 工具 / 审批挂起 / 断点 / 压缩 / 子智能体 / MCP   │
└──────────────┬──────────────────────────────────────────┘
               │ stdio（MCP）
     SketchUp / Blender / 3ds Max / Rhino / AutoCAD …
```

- **main**：窗口、IPC、本地存储（任务、项目、模型配置、对话记录）、MCP 连接器管理与插件安装、CAD 和三维模型预览转换、PPT 修改回写。
- **runtime**：通过 `utilityProcess` 独立运行，负责主循环、工具、审批挂起、断点、压缩、子智能体、MCP 桥接，崩溃不会带垮界面。
- **preload**：通过 contextBridge 暴露 `window.designAgent`，接口固定、按功能分组，没有暴露通用的 ipcRenderer。
- **renderer**：对话、工作台、设置、本地素材库。
- **shared**：IPC 通道与协议类型、路径安全工具（含符号链接检查）、PPT 解析、文件快照。

### 2.3 核心能力

- **设计软件连接器**：7 个 MCP 连接器默认关闭、按需连接；工具超过 15 个时启用延迟加载。
- **技能体系**：CAD、SketchUp、Blender、设计领域分析、规范咨询、13 套出图提示词模板，以及 docx、pptx、xlsx、pdf 文档技能。
- **确定性预设**：客厅 SketchUp Ruby 工程包、CAD 户型种子图包，带校验基线与保护规则。
- **长任务机制**：断点续跑、审批挂起可跨重启、上下文压缩、超长输出转存、同步与后台子智能体、项目记忆提炼、下一步建议。
- **交互**：反问澄清卡片、审批卡片、图片局部标注、PPT 修改提案、交付卡片、Token 用量统计。

---

## 3. Runtime 核心逻辑评审

### 3.1 执行流程

1. 主进程收到 `chat` 或 `resume_suspended_turn` 后转发给 runtime，进入 `executeTurn()`。
2. 若内存中没有该会话，从 `runtime-history.json` 恢复上下文（含挂起状态）。
3. 连接已启用的 MCP；有连接器未就绪时，先弹出“重试连接 / 跳过”的选择卡片。
4. 匹配建模预设，拼装用户消息（附件、标注、历史对话引用、PPT 选区、场景参数）。
5. 组装工具：文件与命令、ask_user、生图、规范、灵感、联网、PPT 工作台、deliver、同步子智能体 task、后台子智能体、MCP（按需加载）。
6. `runAgentLoop()`：每轮最多 80 步。每一步先按需压缩上下文，再流式调用模型，逐个执行工具，超长输出转存为文件。
7. `finally`：清理没返回结果的工具调用、保存断点、取消后台任务、关闭 MCP。

### 3.2 设计亮点

- **审批挂起能撑过重启**：`requireApproval`、`waitForUserAnswer`、`waitForImageEdit` 挂起前都会先保存断点。
- **修补没返回结果的工具调用**：`sanitizeHistoryForResume` 在中断后补齐缺失的工具结果，避免续跑时接口报 400。
- **压缩不拆散工具调用**：`findSafeSplitIndex` 保证工具调用和它的结果不会被切开。
- **兜底周到**：参数 JSON 解析失败、工具名不存在都会转成错误消息让模型自行修正；上下文超限时强制压缩后重试一次。
- **子智能体按角色裁剪工具**：research 只读，modeler 只给 MCP（但白名单有误，见 R11）。

### 3.3 问题清单

#### R1 🔴 高｜并发审批只有一个挂起位，会互相覆盖导致整轮卡死

- **位置**：`src/runtime/index.ts` 963 行（`turnState.pendingApproval`）
- **现象**：审批和追问各自只有一个挂起位置。后台子智能体与主循环并发运行且共用同一个 `requireApproval`，两边同时请求审批时，后到者覆盖先到者，先到者的 Promise 永远不会结束，本轮挂死。`pendingClarification` 同理。
- **建议**：改为 `Map<toolCallId, Pending>`，界面回传审批结果时带上 `toolCallId`，按 ID 精确 resolve。

#### R2 🔴 高｜工具调用 ID 依赖全局变量，并发时串号；各工具读取 ID 的位置大概率是错的

- **位置**：`index.ts` 905–931 行；`workspaceTools.ts` 274/310/350 行；`mcpBridge.ts` 142 行；`webSearchTool.ts` 127 行
- **现象**：整轮只有一个 `currentActiveToolCallId`，`recordToolData`、`requireApproval`、断点都依赖它。各工具自己取 ID 的写法也不一致：文件工具读 `runManager.toolCallId`，MCP 和联网工具读 `runManager.configurable.toolCallId`，这两个位置在 LangChain 里通常都拿不到值，于是全部回退到 `wf_时间戳` 之类的假 ID，只能靠全局变量兜底。子智能体和后台任务里的调用会被记到父级 `task` 卡片上，断点里的挂起调用 ID 也可能对不上。
- **建议**：统一从工具 func 的第三个参数 `config.toolCall.id` 获取（以所用 @langchain/core 版本实测为准），彻底去掉全局变量。

#### R3 🔴 高｜部分初始化在 try 之外，抛错后会话被永久锁住

- **位置**：`index.ts` 871–1066 行
- **现象**：`activeTurns.set(threadId)` 之后、`try` 之前还有 `loadRuntimeCheckpoint`、`discoverModelingPresets` 等调用，一旦抛错 `finally` 不执行，该会话之后一直提示“当前会话已有任务正在执行”。
- **建议**：把 `activeTurns.set` 之后的全部代码移入 `try`。

#### R4 🔴 高｜异步调用缺少 catch，可能直接让 runtime 进程退出

- **位置**：`index.ts` 1616、1621 行（`mcp_check`、`distill_project`）
- **现象**：`.then` 后没有 `.catch`。Node 默认遇到未处理的 Promise 拒绝会退出进程；即使不退，界面也永远等不到 `distill_done`。
- **建议**：补 `.catch` 并回传失败事件；同时在 runtime 入口注册 `unhandledRejection` 兜底日志。

#### R5 🔴 高｜runtime 进程崩溃后，界面里的任务会一直显示“运行中”

- **位置**：`src/main/runtimeHost.ts` exit 处理；`main/index.ts` 1083 行 `liveRuntimeThreads`
- **现象**：子进程退出时只打一条 warn，不向界面补发 `error`/`aborted`，`liveRuntimeThreads` 也不清理。结合 R4，一次未捕获异常就会让所有进行中的任务永远停在运行状态，挂起的审批卡片也无法再提交。
- **建议**：exit 时对所有 live 线程补发 `error` 事件（kind=runtime-crashed）并清空集合；重启后提示用户可“从中断处继续”。

#### R6 🟠 中｜上下文压缩过于激进，一个长任务会反复压缩

- **位置**：`src/runtime/checkpoint.ts` 331–343 行
- **现象**：只要超过 24000 Token 或超过 24 条消息就触发，每次只保留最后 6 条。约 9 次工具调用就会再压一次，80 步的任务可能压缩七八次，每次多一次模型调用；摘要会层层套娃，尺寸、标高等关键约束容易丢失；即使模型上下文有 200k，也被卡死在 24000。
- **建议**：只按 Token 触发，阈值取上下文窗口的 60%–70%；至少保留最近 2–3 轮完整对话；把已确认的约束放进不参与压缩的固定块。

#### R7 🟠 中｜压缩后历史中出现第二条系统消息，可能与 Anthropic 不兼容

- **位置**：`checkpoint.ts` 384–388 行
- **现象**：摘要以 SystemMessage 放在历史开头，发送前又在最前面加主系统提示词，列表中间出现系统消息；保留段也可能以 AI 消息开头。LangChain 的 Anthropic 适配对此可能报错（需实测）。
- **建议**：把摘要并入主系统提示词，或包装为 HumanMessage。

#### R8 🟠 中｜“后台”子智能体并不能跨轮存在

- **位置**：`index.ts` 1565 行；`asyncSubagents.ts`
- **现象**：本轮结束时 `finally` 调用 `cancelAsyncJobs()`，`jobs` 也只在本轮有效；下一轮 `check_async_task` 会返回“未找到”，与工具描述“不阻塞当前主对话”相矛盾。
- **建议**：要么把任务表提升到会话级并在完成时通知界面，要么把描述改成“仅本轮有效”。

#### R9 🟠 中｜同步子智能体把整段过程文字返回给主上下文

- **位置**：`index.ts` 1337 行
- **现象**：`subFinalText += delta` 累加了子智能体每一步的说明文字，主上下文被塞进大量中间过程。
- **建议**：只取子智能体最后一条 AI 消息的文本作为返回值。

#### R10 🟠 中｜“全部允许”是进程级全局开关

- **位置**：`index.ts` 120、858、970 行
- **现象**：`globalPermissionMode` 是模块变量，任何会话点了“全部允许”，所有会话都改为自动执行直到进程重启。存在可执行任意 PowerShell 的 `execute` 工具，风险不小。
- **建议**：按会话保存权限模式，“全部允许”只对当前轮生效。

#### R11 🟠 中｜子智能体工具白名单写错了规范检索工具名

- **位置**：`src/runtime/tools/asyncSubagents.ts` 31–32 行
- **现象**：research 与 cad-analyzer 角色的白名单写的是 `search_regulations`，实际工具名是 `retrieve_regulation_chunks`，这两个角色实际上拿不到规范检索工具。测试只校验了 read_file，没有覆盖到。
- **建议**：改成真实工具名，并在测试里断言每个白名单条目都对应一个已注册的工具。

#### R12 🟠 中｜断点只保存文本，开启 thinking 后重启续跑可能报错

- **位置**：`checkpoint.ts` 45–59 行（`serializeContent`）
- **现象**：AI 消息的 content 只保留 text 部分，Anthropic 扩展思考的 thinking 块和图片都会丢失。Anthropic 要求带工具调用的轮次保留 thinking 块，重启续跑时可能返回 400（需实测）；用户发的参考图重启后也没了。
- **建议**：按原始 content 数组序列化，图片可转存为文件引用。

#### R13 🟠 中｜MCP 每轮重新拉起所有连接器，串行握手，失败时残留进程

- **位置**：`src/runtime/tools/mcpBridge.ts` 113–191 行
- **现象**：每一轮都重新 spawn 所有已启用的连接器并串行握手（每个最长 12 秒），结束时全部关闭；握手超时的 transport 不在 `clients` 列表里，不会被关闭，子进程会残留。
- **建议**：连接器做成会话级长连接（或进程级连接池），并行握手；失败分支显式 `transport.close()`。

#### R14 🟠 中｜MCP 返回的图片被转成 base64 文本塞进上下文

- **位置**：`mcpBridge.ts` 150–156 行
- **现象**：非文本内容一律 `JSON.stringify`。Blender、SketchUp 的视口截图会变成大段 base64 文本：模型看不到图，还白白消耗 Token（超长时才被转存）。
- **建议**：`type=image` 的内容转成多模态 image 块或落盘后返回路径。

#### R15 🟠 中｜规范检索同步阻塞 runtime 最长 60 秒

- **位置**：`src/runtime/tools/regulationTool.ts` 63、148 行
- **现象**：`execFileSync` 会冻结整个 runtime 事件循环：期间所有会话的流式输出停住，停止按钮也无法生效。
- **建议**：改用异步 `execFile` 并接入 AbortSignal。

#### R16 🟠 中｜remember 工具无需审批，且内容会进入后续所有会话的系统提示词

- **位置**：`workspaceTools.ts` 446–461 行
- **现象**：模型读到一份带恶意指令的文档后，可以直接调用 `remember` 把指令写进项目记忆，此后每轮都以系统级权限生效，形成持久化的提示词注入。
- **建议**：`remember` 纳入审批，或在界面上醒目展示新增记忆并允许撤销；记忆注入时标注为“项目资料”。

#### R17 🟡 低｜其他 runtime 细节

- **位置**：多处
- **现象**：`execute` 超时只杀 powershell，不杀子进程树；stdout 用 `toString(utf8)` 拼接，中文跨块会乱码；`edit_file` 只替换第一处且不校验唯一；`grep` 直接执行用户正则，存在 ReDoS 风险；`read_file` 返回的图片块在 OpenAI 兼容协议的 tool 消息中通常不被支持（需实测）；MCP 子进程继承全部环境变量；断点每次全量 pretty-print 写入；`AsyncLoopRunner` 类型手写重复。
- **建议**：分别改用 `taskkill /T /F`、`StringDecoder`、唯一性校验、正则超时或改用字面匹配、环境变量白名单、节流写入、`typeof runAgentLoop`。

---

## 4. Prompt 与 Presets 评审

### 4.1 组装结构

系统提示词由 `buildSupervisorSystemPrompt` 按以下顺序拼接：

1. 生图能力提示（仅在没有生图能力时出现，位于最前）
2. 角色定义与 6 条执行纪律：只用已读到的事实、何时追问、何时列计划、正式成品必须 deliver、效果图与三维建模的边界、合并工具调用
3. 文件系统规范
4. 技能目录（只列名称、路径、描述，用到时再读 SKILL.md）
5. 预设目录、AI 方案模式说明
6. 项目宪章 `DESIGN-AGENT.md`、项目档案、`memory.md`、`project_decisions.md`
7. 运行时追加的 MCP 摘要

用户消息由 `formatUserMessageWithContext` 生成：原文之后依次附上 `<scene>`、`<modeling-preset>`、`<mcp>`、MCP 状态、`<conversations>`、`<annotations>`、`<ppt-workbench>`、`<files>`。

### 4.2 设计亮点

- **技能按需加载**：目录里只放描述，命中再读全文，省 Token、易扩展（但见 P1）。
- **纪律规则针对真实失败场景**：如“写入磁盘不等于交付”“没有生图能力时不准用 Python 渲染脚本冒充效果图”。
- **可信与不可信信息分开**：用户提供的上下文都放在带标签的块里，标注内容转义了尖括号。
- **确定性预设代替现写代码**：客厅建模直接调用 Ruby 工程包，结果稳定可复现；CAD 预设带校验基线和“种子图只读、只改副本”的保护规则。

### 4.3 生图意图误判实测

| 用户输入 | 实际判定 | 应当 |
|---|---|---|
| 帮我画个效果图 | 拦截 | 拦截 |
| 接下来帮我分析一下这张图片里的户型动线 | ❌ 拦截（误判） | 不拦截 |
| 读出这张照片上的尺寸标注 | ❌ 拦截（误判） | 不拦截 |
| 把这几张照片的文件名改成日期 | 不拦截 | 不拦截 |

### 4.4 问题清单

#### P1 🔴 高｜技能文档和预设文件很可能根本读不到

- **位置**：`workspaceTools.ts` 11–27 行（`resolveTarget`）；`index.ts` 1192–1201 行（`allowedReadPaths`）
- **现象**：系统提示词要求模型“必须先 read_file 阅读 SKILL.md”，但 `read_file`、`ls`、`glob`、`grep` 只放行工作区和本轮附件。技能目录在安装目录的 `resources/skills` 下，不在工作区内，`allowedReadPaths` 也没有加入它，读取会抛出“路径超出当前工作区范围”。CAD 预设要求读取的 `run.json`、`dimension-audit.md` 同理。结果是“技能按需加载”这一核心机制失效，模型只能改用需要审批的 `execute` 去读，或者干脆凭记忆操作。测试只验证了越界被拦截，没有验证技能能被读到。
- **建议**：把 skillsRoot、presetsRoot 作为只读根加入读取白名单（写工具仍只限工作区），并补一条“能读到 SKILL.md”的测试。建议优先实测确认。

#### P2 🔴 高｜生图意图判断误判，正常的看图请求会被直接挡回

- **位置**：`index.ts` 519–533 行（`isDirectImageGenerationIntent`）
- **现象**：判定为生图意图且未配置生图能力时，本轮不调用模型，直接返回“当前模型不能生图”。实测“接下来帮我分析一下这张图片里的户型动线”“读出这张照片上的尺寸标注”都会被误拦截：正则里的“来”“出”过宽，排除词只有“只分析”“先分析”。
- **建议**：去掉“来”和单独的“出”，排除词加入“分析、识别、读取、看、标注、尺寸”；更稳妥的做法是取消本地拦截，交给系统提示词里已有的规则。

#### P3 🔴 高｜CAD 预设匹配过宽，用户自己的图纸可能被引去处理示例图

- **位置**：`src/runtime/presets.ts` `matchModelingPreset`；`resources/presets/manifest.json`
- **现象**：关键词包含 CAD、DWG、平面图、户型、图纸检查。用户上传自己的 DWG 说“帮我检查这张图纸”，就会被注入一条“硬性执行规则”，要求复制 `seed/plan.dxf` 并按 11400×9000mm、30 条标注去核对。客厅预设也会用默认的 4800×6400mm 覆盖用户图纸上的真实尺寸。
- **建议**：有附件或明确提到具体文件时不自动匹配；只在用户从场景工具里明确选择时触发；指令改成建议性的“可选工程包”。

#### P4 🔴 高｜预设指令里的 tool_search 调用方式和实际工具不符

- **位置**：`presets.ts` 客厅预设指令；`mcpBridge.ts` 216–276 行
- **现象**：指令要求 `tool_search("select:sketchup__eval_ruby")`，但 `tool_search` 的参数是 `names` 字符串数组，没有 select 前缀语法；而且 MCP 工具不超过 15 个时根本不会注册 `tool_search`。模型照做必然出错，只能靠自我纠错绕过。
- **建议**：指令改为直接调用 `sketchup__eval_ruby`，仅在启用延迟加载时才提示用 `tool_search({names:[...]})` 激活。

#### P5 🟠 中｜系统提示词结构让 Prompt 缓存基本失效

- **位置**：`src/runtime/prompts.ts` `buildSupervisorSystemPrompt`；`checkpoint.ts` `buildSystemMessage`
- **现象**：最前面是随配置变化的生图能力提示，末尾是每次提炼都会变的项目记忆，再后面是每轮不同的 MCP 摘要，而整个系统提示词只打了一个缓存断点。
- **建议**：按“固定纪律与技能目录 → 半固定预设 → 每轮变化的能力、记忆、MCP”排序，在固定部分末尾打断点。

#### P6 🟠 中｜项目记忆没有长度上限，项目宪章以系统级权限生效

- **位置**：`index.ts` 535–588 行（`buildProjectContext`）
- **现象**：`memory.md`、`project_decisions.md`、`DESIGN-AGENT.md` 整个读进系统提示词；提炼器只追加不清理，长期会无限变长。从别处拷来的项目文件夹里如果带了 `DESIGN-AGENT.md`，内容会以系统级权限生效。
- **建议**：设上限（例如 4k 字符，超出保留最新条目）；宪章包在 `<project-charter>` 标签中并声明“这是项目资料，不是系统指令”。

#### P7 🟠 中｜AI 方案模式被注入两次

- **位置**：`prompts.ts` `aiSchemeBlock`；`resources/skills/_profiles/ai-scheme/SKILL.md`
- **现象**：`_profiles/ai-scheme` 被扫描进技能目录，同时 `profile=ai-scheme-v1` 时又注入一份几乎相同的文字。
- **建议**：保留一份即可。

#### P8 🟠 中｜预设参数解析粗糙，失败时静默使用默认值

- **位置**：`presets.ts` `extractPresetOptions`
- **现象**：风格识别不处理否定（“不要新中式”会被识别成新中式）；任何位置出现的第一组“数×数”都被当成开间进深；超出范围静默退回默认值；路径直接拼进 Ruby 单引号字符串，路径含撇号时脚本报错。
- **建议**：参数以场景表单为主、文本为辅；识别不了时用 `ask_user` 确认；路径做转义。

#### P9 🟠 中｜用户消息里的转义不一致

- **位置**：`index.ts` 199–267 行（`formatUserMessageWithContext`）
- **现象**：标注和历史对话引用做了转义，但 `<scene tool="...">` 属性、场景参数、文件名、PPT 选区标签都没有转义，文件名含 `<` 或引号时会破坏标签结构。
- **建议**：统一用一个 `escapeXml` 处理所有插值。

#### P10 🟡 低｜提示词与实现的其他不一致

- **位置**：`prompts.ts`；各 SKILL.md
- **现象**：纪律第 6 条要求“并发发起”工具调用，但 `runAgentLoop` 实际是串行执行；规则中有针对单次事故的补丁（如 `scene.py`），“严禁”“必须”大量堆叠；`regulation-consultation` 写的是“云端规范检索”，实际是本地索引；技能描述只按单行解析，YAML 多行写法会解析成 `>`；技能说明中英文混杂。
- **建议**：定期整理：通用原则留在系统提示词，场景规则回到各技能；修正描述；frontmatter 改用 YAML 解析器。

---

## 5. 主进程、界面层与性能

### 5.1 做得好的地方

- preload 只暴露一组固定接口，没有通用 ipcRenderer；`contextIsolation: true`、`nodeIntegration: false`。
- 几乎所有带路径的 IPC 都经过 `assertAuthorizedReadPath`、`assertWorkspaceRoot`、`assertWritableWorkspacePath` 校验；`resolvePathWithinRoot` 同时检查字面越界和符号链接逃逸，测试中有专门用例。
- 交付物加入最近文件前会再次校验是否位于任务工作区内；历史对话引用只接受已登记任务的 transcript。
- Mermaid 使用 `securityLevel: strict`；HTML 预览放在 `sandbox="allow-scripts"` 的 iframe 中，未授予 same-origin。
- PPT 回写对文本做了 XML 转义；模型设置里的目录必须来自系统选择器。

### 5.2 问题清单

#### M1 🔴 高｜每收到一个 token，主进程都同步读写整份对话记录

- **位置**：`src/main/index.ts` 1083 行；`src/main/store.ts` 756 行（`applyRuntimeEventToTranscript`）
- **现象**：每个 `token`、`reasoning`、子智能体事件都会触发：同步读取整个 transcript JSON → 解析 → 追加 → pretty-print 后写回（因 M2 实际写两遍）。对话越长越慢，复杂度接近 O(n²)，而且全部发生在主进程，会拖慢所有 IPC 和窗口响应，频繁写盘也伤 SSD。
- **建议**：在内存中维护 transcript，按 300–500ms 节流或在 tool-result、done、error 等关键事件时落盘；token 事件只转发给界面。

#### M2 🔴 高｜“原子写入”并不原子

- **位置**：`store.ts` 54–63 行（`writeJsonAtomic`）
- **现象**：先写了临时文件，接着又直接写正式文件，然后删除临时文件，没有 rename。写到一半崩溃或断电，正式文件就是半截 JSON；`readJsonSafe` 读失败会静默返回默认值，相当于丢掉全部任务列表、模型配置或对话记录。
- **建议**：写临时文件后 `renameSync(tmp, filePath)`；读失败时保留损坏文件备份，不要静默覆盖。

#### M3 🟠 中｜界面每个 token 都重建状态并重新解析整段 Markdown

- **位置**：`src/renderer/src/store/useWorkspaceStore.ts` 840–870 行；`MarkdownRenderer.tsx`
- **现象**：每个 token 复制 turns 数组、从后往前查找助手消息，并触发整段 Markdown（含 KaTeX、Mermaid）重新渲染，长回复时界面明显卡顿。
- **建议**：用 requestAnimationFrame 合并 token 批量更新；流式阶段只渲染纯文本或增量渲染，结束后再完整解析。

#### M4 🟡 低｜续跑时使用当前选中的模型，而不是原任务的模型

- **位置**：`main/index.ts` 920–923 行（`dispatchSuspendedResume`）
- **现象**：用户中途切换了模型，再点“从中断处继续”会换成新模型接着跑，和断点里的上下文（如 thinking 设置）可能不一致；`thinking` 也被固定为 true。
- **建议**：任务记录里保存所用 profileId 和 thinking 设置，续跑时沿用。

#### M5 🟡 低｜其他主进程与界面细节

- **位置**：多处
- **现象**：`pptPatcher` 的 `colorHex` 未校验就拼进 XML；CLIP 模型下载没有超时，失败时 `.part` 文件句柄不关闭；3ds Max 插件安装会先递归删除目标目录；联网搜索默认抓取 DuckDuckGo HTML，结构一变就失效，配置 Tavily 但未填 Key 时会静默回退还标注为 tavily；`App.tsx` 约 2200 行、`ModelSettingsModal.tsx` 约 1950 行，建议拆分。
- **建议**：逐项修正；大组件按功能拆分。

---

## 6. 安全、合规与可复现性

#### S1 🔴 高｜API Key 明文存储，并完整发送给渲染进程

- **位置**：`src/main/store.ts`；`main/index.ts` 253 行（`ModelsGetSettings`）
- **现象**：模型和生图渠道的 Key 以明文 JSON 存在用户目录下；`getModelSettings` 把含完整 Key 的配置原样返回给渲染进程。
- **建议**：用 Electron `safeStorage` 加密存储；发往界面的配置只带脱敏后的 Key，测试连接等操作改为传 profileId 由主进程取 Key。

#### S2 🔴 高｜可以一键打开工作区里的任意文件，包括可执行文件

- **位置**：`main/index.ts` 689 行（`ShellOpenPath`）
- **现象**：`shell.openPath` 只校验路径在工作区或已授权列表内，不校验类型。智能体能在工作区写入 `.bat`、`.ps1`、`.exe`、`.lnk`，交付卡片或文件树里点一下“打开”就会直接执行，绕过了 `execute` 的审批。
- **建议**：对可执行类扩展名拒绝或二次确认；默认只允许打开文档、图片、模型等白名单类型。

#### S3 🟠 中｜外链打开不校验协议

- **位置**：`main/index.ts` 240–243 行（`setWindowOpenHandler`）
- **现象**：`shell.openExternal(details.url)` 对任意 URL 放行。模型输出的 Markdown 链接若是 `file:`、`ms-msdt:` 等协议，点击后会交给系统处理。
- **建议**：只允许 http、https、mailto；同时拦截 `will-navigate`。

#### S4 🟠 中｜渲染进程未开沙箱，且没有 CSP

- **位置**：`main/index.ts` 221 行（`sandbox: false`）；`src/renderer/index.html`
- **现象**：preload 只暴露一组固定接口、主进程普遍做了路径校验，这部分做得好。但渲染进程会显示模型输出、Word 转 HTML（`OfficePreviewPanels.tsx` 373 行，未净化直接 innerHTML）、Mermaid SVG 等内容，没有 CSP，一旦出现 XSS，就能调用全部 preload 接口。
- **建议**：开启 `sandbox: true`（preload 只用 contextBridge 和 ipcRenderer，迁移成本低）；加严格 CSP；mammoth 输出用 DOMPurify 净化。

#### S5 🟠 中｜导入外部配置会读取其他工具的密钥并明文保存

- **位置**：`src/main/ccSwitchService.ts`
- **现象**：会扫描 `~/.claude/settings.json`、`~/.codex`、`~/.cc-switch/cc-switch.db` 获取 API Key，导入后按 S1 明文保存。
- **建议**：导入前明确告知会读取哪些文件；导入的 Key 同样加密存储。

#### S6 🟠 中｜依赖版本存在已知风险

- **位置**：`package.json`；`node_modules`
- **现象**：`xlsx` 0.18.5 存在已公开的原型污染（CVE-2023-30533）和 ReDoS（CVE-2024-22363）问题，npm 上的版本已不再更新；`electron` 当前为 35.7.5，按 Electron 只维护最新三个大版本的节奏，35 应已停止安全更新（建议核实）。CLIP 模型下载只校验大小，不校验哈希，随后由原生 onnxruntime 加载。
- **建议**：`xlsx` 改用 SheetJS 官方 CDN 版本或 exceljs；升级 Electron 到受支持版本；模型文件增加 SHA-256 校验。

#### C1 🔴 高｜仓库不完整，克隆后大部分设计软件功能无法运行

- **位置**：`.gitignore`；`resources/runtime`、`resources/mcp/*/lib`、`resources/skills/cad/vendor`
- **现象**：`resources/runtime` 只有 `reg-indexer.exe` 和 `design_native.dll`，没有内置 Python；所有 MCP 连接器的 `lib` 目录、CAD 的 `vendor`（dwg2dxf / LibreDWG）都被 gitignore 且本地不存在，也没有拉取脚本。结果是 DWG 转换、SketchUp、Blender 等连接器在这份代码上跑不起来，Python 技能会退回系统 Python。`out/` 里也只有残缺的旧构建（缺 renderer）。
- **建议**：提供 `scripts/fetch-resources` 一键拉取并校验哈希，在 README 写明；或改用 Git LFS 与发布包。

#### C2 🔴 高｜代码来源与第三方许可证需要确认

- **位置**：全仓库
- **现象**：代码中有 19 处“对齐原版”注释、引用了疑似混淆后的原始函数名（如 `ARr`、`YKs`），`ensure_sketchup.py` 还引用了本仓库不存在的 `windowsUtf8Shell.ts`；ai-scheme 技能曾直接写着某第三方产品的方案入口描述。看起来是参照某款同类桌面智能体复刻的。docx、pptx、xlsx、pdf、frontend-design 等技能自带 LICENSE.txt；CAD 依赖的 LibreDWG 是 GPL 许可。项目本身没有许可证文件。
- **建议**：商用或公开发布前确认原产品授权；逐个核对技能许可证能否再分发；评估 LibreDWG（GPL）的分发影响；补充项目 LICENSE。

---

## 7. 修复路线图

### 7.1 第一阶段：可用与稳定（约 2–3 天）

- [x] **P1**：技能目录、预设目录加入只读白名单，补测试。
- [x] **P2、P4**：修正生图意图正则；预设指令改为直接调用真实工具名。
- [x] **R1、R2**：审批与追问改为按 toolCallId 存储；工具统一从 config 获取调用 ID。
- [x] **R3、R4、R5**：初始化移入 try；补 catch 与 unhandledRejection；runtime 退出时通知界面。
- [x] **M1、M2**：transcript 改为内存维护、节流落盘；写入改为“临时文件 + rename”。

### 7.2 第二阶段：安全基线（约 2 天）

- [x] **S1、S5**：safeStorage 加密 Key，界面只拿脱敏值。
- [x] **S2、S3**：openPath 加类型白名单，openExternal 加协议白名单，拦截 will-navigate。
- [x] **S4**：开启沙箱，加 CSP，mammoth 输出净化。
- [x] **R10、R16**：权限模式按会话；remember 纳入审批或可见可撤销。
- [x] **S6**：升级 Electron，替换 xlsx，模型文件加哈希校验。

### 7.3 第三阶段：成本与效果（约 3–5 天）

- [x] **R6、R7、P5、P6**：重做压缩策略，调整提示词顺序与缓存断点，记忆加上限。
- [x] **R13、R14、R15**：MCP 会话级长连接、并行握手；图片结果转多模态；规范检索改异步。
- [x] **P3、P8**：收紧预设匹配，参数以表单为主。
- [x] **R8、R9、R11、R12**：统一子智能体设计，修正白名单，断点保留完整 content。
- [x] **M3**：界面 token 批量更新、流式阶段轻量渲染。

### 7.4 并行事项

- [x] **C1**：补 README（安装依赖、配置模型、开发、打包），提供运行资源拉取与校验脚本。
- [ ] **C2**：确认原产品授权、技能与 LibreDWG 许可证，补充项目 LICENSE。（自用，暂不处理）
- [ ] 为每个修复补回归用例，特别是并发审批、初始化抛错、技能读取、runtime 崩溃恢复。（已补技能读取与子智能体白名单两项，其余未做）

### 7.5 问题总表

| 编号 | 严重度 | 问题 | 位置 |
|---|---|---|---|
| R1 | 🔴 高 | 并发审批只有一个挂起位，会互相覆盖导致整轮卡死 | `src/runtime/index.ts` 963 行（`turnState.pendingApproval`） |
| R2 | 🔴 高 | 工具调用 ID 依赖全局变量，并发时串号；各工具读取 ID 的位置大概率是错的 | `index.ts` 905–931 行；`workspaceTools.ts` 274/310/350 行；`mcpBridge.ts` 142 行；`webSearchTool.ts` 127 行 |
| R3 | 🔴 高 | 部分初始化在 try 之外，抛错后会话被永久锁住 | `index.ts` 871–1066 行 |
| R4 | 🔴 高 | 异步调用缺少 catch，可能直接让 runtime 进程退出 | `index.ts` 1616、1621 行（`mcp_check`、`distill_project`） |
| R5 | 🔴 高 | runtime 进程崩溃后，界面里的任务会一直显示“运行中” | `src/main/runtimeHost.ts` exit 处理；`main/index.ts` 1083 行 `liveRuntimeThreads` |
| P1 | 🔴 高 | 技能文档和预设文件很可能根本读不到 | `workspaceTools.ts` 11–27 行（`resolveTarget`）；`index.ts` 1192–1201 行（`allowedReadPaths`） |
| P2 | 🔴 高 | 生图意图判断误判，正常的看图请求会被直接挡回 | `index.ts` 519–533 行（`isDirectImageGenerationIntent`） |
| P3 | 🔴 高 | CAD 预设匹配过宽，用户自己的图纸可能被引去处理示例图 | `src/runtime/presets.ts` `matchModelingPreset`；`resources/presets/manifest.json` |
| P4 | 🔴 高 | 预设指令里的 tool_search 调用方式和实际工具不符 | `presets.ts` 客厅预设指令；`mcpBridge.ts` 216–276 行 |
| M1 | 🔴 高 | 每收到一个 token，主进程都同步读写整份对话记录 | `src/main/index.ts` 1083 行；`src/main/store.ts` 756 行（`applyRuntimeEventToTranscript`） |
| M2 | 🔴 高 | “原子写入”并不原子 | `store.ts` 54–63 行（`writeJsonAtomic`） |
| S1 | 🔴 高 | API Key 明文存储，并完整发送给渲染进程 | `src/main/store.ts`；`main/index.ts` 253 行（`ModelsGetSettings`） |
| S2 | 🔴 高 | 可以一键打开工作区里的任意文件，包括可执行文件 | `main/index.ts` 689 行（`ShellOpenPath`） |
| C1 | 🔴 高 | 仓库不完整，克隆后大部分设计软件功能无法运行 | `.gitignore`；`resources/runtime`、`resources/mcp/*/lib`、`resources/skills/cad/vendor` |
| C2 | 🔴 高 | 代码来源与第三方许可证需要确认 | 全仓库 |
| R6 | 🟠 中 | 上下文压缩过于激进，一个长任务会反复压缩 | `src/runtime/checkpoint.ts` 331–343 行 |
| R7 | 🟠 中 | 压缩后历史中出现第二条系统消息，可能与 Anthropic 不兼容 | `checkpoint.ts` 384–388 行 |
| R8 | 🟠 中 | “后台”子智能体并不能跨轮存在 | `index.ts` 1565 行；`asyncSubagents.ts` |
| R9 | 🟠 中 | 同步子智能体把整段过程文字返回给主上下文 | `index.ts` 1337 行 |
| R10 | 🟠 中 | “全部允许”是进程级全局开关 | `index.ts` 120、858、970 行 |
| R11 | 🟠 中 | 子智能体工具白名单写错了规范检索工具名 | `src/runtime/tools/asyncSubagents.ts` 31–32 行 |
| R12 | 🟠 中 | 断点只保存文本，开启 thinking 后重启续跑可能报错 | `checkpoint.ts` 45–59 行（`serializeContent`） |
| R13 | 🟠 中 | MCP 每轮重新拉起所有连接器，串行握手，失败时残留进程 | `src/runtime/tools/mcpBridge.ts` 113–191 行 |
| R14 | 🟠 中 | MCP 返回的图片被转成 base64 文本塞进上下文 | `mcpBridge.ts` 150–156 行 |
| R15 | 🟠 中 | 规范检索同步阻塞 runtime 最长 60 秒 | `src/runtime/tools/regulationTool.ts` 63、148 行 |
| R16 | 🟠 中 | remember 工具无需审批，且内容会进入后续所有会话的系统提示词 | `workspaceTools.ts` 446–461 行 |
| P5 | 🟠 中 | 系统提示词结构让 Prompt 缓存基本失效 | `src/runtime/prompts.ts` `buildSupervisorSystemPrompt`；`checkpoint.ts` `buildSystemMessage` |
| P6 | 🟠 中 | 项目记忆没有长度上限，项目宪章以系统级权限生效 | `index.ts` 535–588 行（`buildProjectContext`） |
| P7 | 🟠 中 | AI 方案模式被注入两次 | `prompts.ts` `aiSchemeBlock`；`resources/skills/_profiles/ai-scheme/SKILL.md` |
| P8 | 🟠 中 | 预设参数解析粗糙，失败时静默使用默认值 | `presets.ts` `extractPresetOptions` |
| P9 | 🟠 中 | 用户消息里的转义不一致 | `index.ts` 199–267 行（`formatUserMessageWithContext`） |
| M3 | 🟠 中 | 界面每个 token 都重建状态并重新解析整段 Markdown | `src/renderer/src/store/useWorkspaceStore.ts` 840–870 行；`MarkdownRenderer.tsx` |
| S3 | 🟠 中 | 外链打开不校验协议 | `main/index.ts` 240–243 行（`setWindowOpenHandler`） |
| S4 | 🟠 中 | 渲染进程未开沙箱，且没有 CSP | `main/index.ts` 221 行（`sandbox: false`）；`src/renderer/index.html` |
| S5 | 🟠 中 | 导入外部配置会读取其他工具的密钥并明文保存 | `src/main/ccSwitchService.ts` |
| S6 | 🟠 中 | 依赖版本存在已知风险 | `package.json`；`node_modules` |
| R17 | 🟡 低 | 其他 runtime 细节 | 多处 |
| P10 | 🟡 低 | 提示词与实现的其他不一致 | `prompts.ts`；各 SKILL.md |
| M4 | 🟡 低 | 续跑时使用当前选中的模型，而不是原任务的模型 | `main/index.ts` 920–923 行（`dispatchSuspendedResume`） |
| M5 | 🟡 低 | 其他主进程与界面细节 | 多处 |

合计 **40** 条：🔴 高 15 条，🟠 中 21 条，🟡 低 4 条（R17、P10、M5 为多个细节的合并条目）。

---

## 附录：评审范围与方法

### 已阅读的内容

- **runtime**：`index.ts` 全部、`checkpoint.ts`、`prompts.ts`、`presets.ts`、`modelFactory.ts`、`distiller.ts`，以及 `tools/` 下文件与命令、MCP 桥接、子智能体、联网搜索、规范检索、生图渠道等工具的关键路径。
- **主进程**：`index.ts` 中全部 IPC 处理与窗口配置、`runtimeHost.ts`、`store.ts` 的读写与对话记录逻辑、`mcpManager.ts` 插件安装、`ccSwitchService.ts`、`inspirationModelService.ts`、`pptPatcher.ts`；`preload/index.ts` 全部；`shared/workspacePaths.ts` 全部。
- **界面**：`useWorkspaceStore.ts` 事件处理与流式更新、XSS 相关位置（innerHTML、iframe、Mermaid）；`App.tsx` 等大组件只做了结构扫描。
- **其他**：预设清单与全部 SKILL.md、CAD 与 SketchUp 的 Python 脚本（安全与结构扫描）、C# 规范索引器与 design_native 源码、`verify-runtime.ts` 的测试结构、依赖版本、`.gitignore` 与资源目录。

### 未覆盖的内容

- 没有构建、运行应用，也没有执行类型检查、测试或 npm audit；标注“需实测”的条目是根据代码推断的。
- 界面各组件的交互细节、CAD 解析算法的正确性、出图提示词模板的效果，没有逐行审查。
- 由于缺少运行资源（见 C1），无法验证 MCP 连接器和 DWG 转换的实际行为。


---

## 修复记录（2026-11-26）

按 高 → 中 → 低 的顺序修改。所有被改动的原始文件都备份在 `.fix-backup/`（已加入 `.gitignore`），确认无误后可删除。

> **状态说明**：修改完成后只做了词法级检查（括号、字符串、模板、正则配对，所有改动文件均通过）。**尚未执行 `npm run typecheck`、`npm run build`、`npm run test:runtime`，也未在 Electron 中实际运行**，请先跑这三条命令确认。（截至 2026-11-27 仍未看到运行结果）

### 🔴 高

| 编号 | 状态 | 改动 |
|---|---|---|
| R1 | ✅ | 审批 / 追问 / 图片标注在同一轮内串行排队（`runExclusive`），并发子任务不再互相覆盖挂起位 |
| R2 | ✅ | 新增 `runtime/tools/callId.ts`，所有工具统一从 `config.configurable.toolCallId` 取调用 ID；只有主循环发起的调用才写入可恢复的挂起断点 |
| R3 | ✅ | `activeTurns.set` 移到 `try` 之前紧挨处，`finally` 中清理失败也一定解锁；`executeTurn` 启动前抛错会回传 error 事件 |
| R4 | ✅ | `mcp_check`、`distill_project` 补 `.catch`；runtime 注册 `unhandledRejection` / `uncaughtException` 兜底 |
| R5 | ✅ | runtime 意外退出时主进程对所有运行中会话补发 `runtime-crashed` 错误事件 |
| P1 | ✅ | 技能目录、预设目录作为只读根加入读取类工具（写入类工具不受影响），新增回归测试 |
| P2 | ✅ | 重写生图意图正则，实测“分析图片”“读出照片尺寸”不再误拦截 |
| P3 | ✅ | 带附件时不自动匹配预设；CAD 种子图包只在场景工具明确选择时匹配；指令改为“适用前提 + 执行规则” |
| P4 | ✅ | 预设指令改为直接调用真实工具名，延迟加载时才用 `tool_search({ names: [...] })` |
| M1 | ✅ | 对话记录内存缓存；token / reasoning / usage 事件 400ms 节流落盘，关键事件立即落盘，退出前 flush |
| M2 | ✅ | `writeJsonAtomic` 改为临时文件 + rename；读取损坏时先备份为 `.corrupt-时间戳` |
| S1 | ✅ | `apiKey` 用 `safeStorage` 加密落盘（旧明文自动迁移）；界面只拿脱敏值，保存和测试连接时由主进程还原 |
| S2 | ✅ | `openPath` 遇到可执行文件和脚本时改为在资源管理器中定位，不直接运行 |
| C1 | ✅ | 补写 README；新增 `npm run check:resources` 检查运行资源 |
| C2 | ⚠️ 已记录 | 新增 `THIRD_PARTY_NOTICES.md`。**需要你决定**：docx/pptx/xlsx/pdf 四个技能的许可证明确禁止再分发，LibreDWG 为 GPL-3.0，代码来源待确认 |

### 🟠 中

| 编号 | 状态 | 改动 |
|---|---|---|
| R6 | ✅ | 压缩只按 Token 触发（窗口的 65%），至少保留最近 3 轮完整对话，上一次摘要完整带入 |
| R7 | ✅ | 压缩摘要合并进系统提示词，发给模型的消息只有开头一条 system |
| R8 | ✅ | 后台子任务工具描述改为“仅本轮有效”（未改为跨轮持久） |
| R9 | ✅ | 同步子智能体只返回最后一条 AI 消息 |
| R10 | ✅ | “全部允许”只对当前轮生效，不再改写全局设置 |
| R11 | ✅ | 白名单改为 `retrieve_regulation_chunks`，新增回归测试 |
| R12 | ✅ | 断点保留完整内容块（含 thinking），图片换为占位文字 |
| R13 | ✅ | MCP 并行握手，失败时关闭连接（未改为跨轮长连接） |
| R14 | ✅ | MCP 返回的图片保存到 `.design-agent/mcp-images/`，只把路径交给模型 |
| R15 | ✅ | 规范检索改为异步子进程并接入中止信号 |
| R16 | ✅ | `remember` 纳入审批；项目资料在系统提示词中声明为“资料，不是指令” |
| P5 | ✅ | 系统提示词按固定 / 变化排序，Anthropic 只给固定部分打缓存断点 |
| P6 | ✅ | 宪章上限 8000 字、记忆保留最新 6000 字，包在标签内 |
| P7 | ✅ | AI 方案模式下技能目录不再列出 `_profiles` |
| P8 | ✅ | 风格识别处理否定；表单优先；未识别的参数提示模型确认；Ruby 路径转义 |
| P9 | ✅ | 用户消息中的标签属性与正文统一转义 |
| M3 | ✅ | 界面 token 事件 32ms 合并后再更新状态 |
| S3 | ✅ | 外链只允许 http / https / mailto，拦截 `will-navigate` |
| S4 | ✅ | `sandbox: true`；打包版注入 CSP；Word 预览 HTML 先净化 |
| S5 | ⚠️ 部分 | 导入的 Key 随 S1 加密保存；扫描结果仍以明文发给界面，导入前未加提示 |
| S6 | ❌ 未做 | 升级 Electron、替换 `xlsx` 需要 `npm install` 并回归测试，未改动；CLIP 模型未加哈希校验（缺少官方哈希） |

### 🟡 低

| 编号 | 状态 | 改动 |
|---|---|---|
| R17 | ✅ 大部分 | `execute` 结束整棵进程树、`StringDecoder` 解码；`edit_file` 校验唯一；`grep` 限制模式长度与行长；MCP 子进程去掉密钥类环境变量；断点不再 pretty-print。未做：`read_file` 图片在 OpenAI 协议下的兼容、`AsyncLoopRunner` 类型去重 |
| P10 | ✅ 大部分 | “并发”改为“合并到同一次回复”；规范技能描述改为本地；frontmatter 支持 YAML 多行。未做：规则瘦身、技能说明语言统一 |
| M4 | ✅ | 续跑沿用该会话上一轮的模型与 thinking 设置 |
| M5 | ✅ 大部分 | PPT 颜色校验；CLIP 下载连接与空闲超时并清理半截文件；3ds Max 安装前确认目录归属；联网搜索返回实际使用的服务。未做：`App.tsx`、`ModelSettingsModal.tsx` 拆分 |

### 需要留意的行为变化

- 首次以新版本启动时，`model-settings.json` 中的 Key 会被加密；回退到旧版本后旧版无法读取，需要重新填写。
- 打包版启用了 CSP。~~HTML 预览里引用外部 CDN 的脚本、样式会被拦截。~~（已在「自用调整」中放开 https 资源）
- ~~智能体写项目记忆（`remember`）现在会弹审批。~~（已在「自用调整」中取消）
- 用户带了附件时，客厅 / CAD 预设不会再自动套用。


### 复查（2026-11-26 晚）

上次未完成的项目已由开发者补做，复查结果：

| 编号 | 状态 | 说明 |
|---|---|---|
| S6 | ✅ | Electron 升级到 45.5.0；`xlsx` 已替换为 `exceljs` 4.4.0（源码与测试中均无残留）；CLIP 模型下载增加 SHA-256 校验 |
| S5 | ✅ | 扫描结果发往界面前清空 Key，只带 `hasKey` 与脱敏值；真实 Key 留在主进程缓存，保存与测活时由主进程补回。导入弹窗已注明会读取的文件 |
| R17 | ✅ | `read_file` 返回的图片在不支持的协议下降级（`degradeToolImageBlocks`）；`AsyncLoopRunner` 改为引用 `runAgentLoop` 的类型 |
| P10 | ✅ | 系统提示词精简（“严禁”3 处，已无 `scene.py` 补丁规则）；技能说明统一为中文 |
| M5 | ✅ | `App.tsx` 2201 → 1007 行，`ModelSettingsModal.tsx` 1949 → 774 行，拆出 `chat/`、`layout/`、`modals/`、`settings/` |
| C1 | ✅ | 新增运行资源打包 / 拉取 / 构建脚本，`gh-token.txt` 已在 `.gitignore` 中且未进入 Git 索引 |
| C2 | ⚠️ 仍待决定 | 见下 |

**C2 仍未解决**：
- docx / pptx / xlsx / pdf 四个技能的 `LICENSE.txt` 仍是 Anthropic 的限制性许可，且这次被翻译成了中文。该许可明确禁止“制作衍生作品”和“分发”，翻译属于衍生作品；`electron-builder.yml` 仍会把它们打进安装包。
- `resources/skills/cad/vendor/win64` 已放入 LibreDWG（GPL-3.0），分发时需履行 GPL 义务。
- `zmo` 前缀与“知末”字样已清除，但源码中仍有 19 处“对齐原版”注释；改名不改变内容来源，授权问题仍需确认。
- 项目仍没有 `LICENSE` 文件。


### 自用调整（2026-11-26）

- `remember` 不再需要审批（`src/runtime/index.ts` 的 `gatedToolNames`，加回 `'remember'` 即可恢复）。
- 打包版 CSP 允许从 `https:` 加载脚本、样式、字体、图片和媒体；`connect-src` 仍只允许本地，页面里的 fetch / XHR 访问外部接口会被拦截。


---

## 功能升级（2026-11-27）

按“先打数据基础、再做闭环”的顺序实现了三项：

### 1. 任意户型平面转模型

| 文件 | 作用 |
|---|---|
| `resources/skills/cad/scripts/plan_core.py` | 纯几何核心（不依赖 ezdxf）：成对平行墙线 → 墙段；同线墙段按门窗 / 交叉墙 / 空缺口合并；门按门弧反求铰点与门宽，窗与推拉门取墙厚内图元；L 形转角补到外皮、T 形补到中心线；房间优先用轮廓线，没有时从房间名向四周找墙内皮推断矩形；输出自检与需确认项 |
| `resources/skills/cad/scripts/plan_extract.py` | 命令行入口：读 DWG / DXF、自动识别图层、单位换算到毫米、写出 plan.json |
| `resources/skills/sketchup/scripts/plan_builder.rb` | 读 plan.json 生成白模：墙按洞口拆成墙段 / 窗台 / 过梁（不依赖布尔运算），门扇、推拉门、窗框玻璃、地面、顶棚，分标记、建场景；可沿用客厅预置包的风格贴图；`measure` 读回实测尺寸 |

在示例图 `seed/plan.dxf` 上测试（用云端最小 DXF 解析器喂给 `plan_core`）：识别出 11 段墙、8 个门（7 平开 + 1 推拉）、7 个窗、8 个房间，面积与图上标注逐一一致，合计 88.53㎡；整张图旋转 30° 后结果不变。另用“外墙画成两条闭合轮廓、窗画在连续墙线上、门开在墙尽端”的合成图测试通过。

### 2. 建模后自动核对

- `resources/skills/cad/scripts/plan_verify.py`：对比 plan.json 与模型实测（墙长 / 厚 / 高 / 体积、洞口宽 / 窗台 / 高、房间面积、外包尺寸），不一致时退出码为 1 并逐条列出。用模拟模型测试：完全一致时 114 项全过；人为改错墙体体积、窗宽、删掉一个房间后，三处差异都被报出。
- 系统提示词要求：按平面建模后必须核对通过再交付；出图后先 `read_file` 自查一次，明显不符时调整提示词重出一次。

### 3. 结构化项目档案

- `src/runtime/projectProfile.ts`：`project.json` 的格式、合并规则（标量覆盖、`null` 删除、房间按名合并、约束取并集、决策去重追加）、从 plan.json 同步房间、生成提示词摘要。
- `src/runtime/tools/projectProfileTool.ts`：新工具 `project_profile`（`get` / `update` / `import_plan`），自用不审批。
- 系统提示词注入 `<project-profile>` 摘要，并规定它是尺寸、风格、主材、约束的唯一来源；记忆提炼器把“已确认 / 否决”同步写入 project.json。
- `scripts/verify-runtime.ts` 新增档案合并规则的测试。

### 验证状态与已知限制

- Python 几何核心已在云端用示例图和合成图测试；`plan_extract.py`（依赖 ezdxf）、`plan_builder.rb`（依赖 SketchUp）、TypeScript 改动**都还没有在本机实际运行过**。请依次验证：
  1. `npm run typecheck`、`npm run build`、`npm run test:runtime`
  2. `resources\runtime\python\python.exe resources\skills\cad\scripts\plan_extract.py resources\presets\cad-plan-modeling-v1\seed\plan.dxf`，应得到 11 墙 / 8 门 / 7 窗 / 8 房间
  3. 打开 SketchUp，让智能体按示例图建模并核对
- 只处理单层、直线墙；弧形墙、斜屋顶、多层与楼梯不识别。天正图纸需先导出 T3。
- 房间推断矩形只适用于正交户型；有房间轮廓线的图最准确。
- project.json 目前只能通过对话修改，界面上还没有编辑入口；规范自动审图、工程量报价、多方案对比还没做。


### 第二批（2026-11-27）：工程量报价、规范初查、方案汇报包、效果图审查

| 文件 | 作用 |
|---|---|
| `resources/skills/cad/scripts/plan_geom.py` | 共用几何：洞口两侧各是哪个房间、外墙判定、房间分类与湿区识别、平面示意图绘制 |
| `resources/skills/cad/scripts/plan_quantity.py` | 工程量（地面 / 墙面扣洞口 / 顶棚 / 踢脚线 / 防水 / 门窗表 / 墙体体积）与报价，Excel 三张表、金额为公式 |
| `resources/presets/price-table.sample.json` | 示例单价表（数值仅作演示，不是市场价） |
| `resources/skills/cad/scripts/plan_codecheck.py` + `plan_rules.residential.json` | 规范初查：房间面积、门洞宽高（户门 / 卧室 / 厨房 / 卫生间 / 阳台门）、层高净高、窗台防护、直接采光，输出问题清单与红圈标注图 |
| `resources/skills/report-pack/SKILL.md` + `scripts/build_deck.py` | 七步带检查点的方案汇报流程；按清单组装 16:9 汇报 PPT（封面、概况、空间清单、平面、分析、意向、效果图、规范、造价、下一步） |
| `src/runtime/tools/imageReviewTool.ts` | `review_image` 工具：视觉模型对照要求与项目档案审图，返回 pass / issues / prompt_fix；模型不能看图时如实返回，改由 `read_file` 人工判断 |

云端测试（用示例图的 plan.json）：
- **工程量**：干区地面 60.88㎡、湿区 27.65㎡（合计 88.53㎡，与房间面积一致），平开门 7 樘、推拉门 1 樘、窗 7 樘；15 个洞口两侧房间的归属全部正确；Excel 报价单公式正确（示例单价下合计 114,674.70 元，仅演示）。
- **规范初查**：29 项。示例图本身的户门 D1 洞口 900mm，按户门 ≥1000mm 判为不满足；人为把卫生间门改成 650mm、窗台改成 500mm、净高设为 2350mm 后，三处都被报出，标注图编号与清单对应。
- **汇报 PPT**：按测试清单生成 8 页，缺失的效果图被跳过并提示，版式检查无溢出。

注意：
- 规则限值按 GB 50096-2011 整理，**没有联网核对是否有新版或地方标准**，规则文件和报告里都写明了“只作初查、以现行条文为准”。
- `review_image`、`build_deck.py`（在本机 python-pptx 下）、`plan_codecheck.py` 的中文字体渲染都还没在本机跑过；TypeScript 改动同样需要 `npm run typecheck` 验证。


## 实测图纸第一轮（2026-11-27）

测试图：社区图书馆 6 张平面 + 五层教学楼（天正 T3 导出，8 个图框）。

| 问题 | 原因 | 处理 |
|---|---|---|
| 教学楼门全部为 0，柱位被当成 20 个过道 | 门窗同在 WINDOW 图层；墙线到柱边就断开 | 窗图层里带门弧 / 门块名的组按门；柱（COLUMN / 柱 图层）补成墙段；两头都是柱的空缺口不算过道 |
| 双开门被拆成两樘单扇门 | 两扇门铰点分别落在墙段和柱段上 | 按墙中心线归并相接门扇 |
| 14 扇窗"没落在墙上" | 窗框比柱边缩进，相接容差太小 | 相接容差放宽到墙厚 |
| 房间名混入 M1821 / 上 / ±0.000，544㎡ 的假房间重复计面积 | 门窗编号、楼梯上下、标高被当成房间名 | 过滤门窗编号、标高、方位、图名、轴号及门窗/标注图层文字；同一矩形去重 |
| 门窗高度全是默认值 | 没读门窗编号 | 解析 M1021 / C1815 编号，按距离 + 宽度匹配，取高度并写入 code |
| 图书馆"立面墙线"图层被当成墙 | 图层名含"墙" | 立面 / 剖面 / 填充 / 文字 / 标注类图层不参与自动识别 |

教学楼结果：首层～五层每层 门 17–21、窗 22–25，与图上门窗编号数一致（四、五层各差 1 扇窗）；房间 7–10 个，无假房间；过道 0；结构校验全部通过。
图书馆：天正自定义对象（墙 66–87、门窗 65–78、柱 48）未导出，读图时全部丢失，需在天正里「图形导出」T3 后再测。
新增回归测试 test_extract_columns_and_codes（29 项）。

## 实测图纸第二轮：结果可信度（2026-11-27）

第一轮跑通了流程，但有几处「看着成功其实不对」，这一轮专门修这类问题。

| 问题 | 原因 | 处理 |
|---|---|---|
| 18 个门宽比图上编号小 2.5%，规范初查报 6 条「门洞宽度不满足」 | 门宽取的是墙上实际缺口，门窗块比洞口画小一圈 | 编号解析已拿到名义宽度，实测与编号差 5% 以内时改用名义值、洞口中心不动；差 5%–10% 的按实测算并提示核对编号；编号匹配窗口从 15% 收到 10% |
| 教学楼被按住宅规范判「户门 ≥1000」，29 项里 6 条误报 | 规则库只有 GB 50096（住宅），没有声明适用范围 | 规则文件加 `building_types`；`plan_codecheck.py` 按房间名识别建筑类型（可用 `--building-type` 指定），不在范围内时不做判定，只出说明报告、退出码 2 |
| 门厅 106.55㎡ 等推断房间和教室混在一起，看不出哪个不能信 | 从房间名推断的矩形不检查四面是否真被墙围住 | 推断矩形记录每条边的支撑墙段，算「支撑率」；结合图上标注面积得出 `confidence`（高/中/低），低置信度的房间在 plan.json、stdout、Excel 房间明细和标注图（红色虚线框）里都标出来；规范初查对低置信度房间不判「不满足」 |

教学楼首层复测：门宽全部为 900 / 1800，房间 10 个（9 高 1 中，门厅支撑率 0.88 → 中），结构校验 42 项全过；规范初查因「教育（学校）」不在住宅库范围内退出码 2，强制 `--building-type residential` 时剩下的 6 条全部是「户门 ≥1000」这一条住宅规则，不是几何问题。
新增回归测试 test_opening_width_from_code / test_room_confidence / test_building_type / test_codecheck_uncovered（27 项，总计 123 项）。

## 实测图纸第三轮：住宅施工图（2026-11-27）

测试图：峻峰苑项目 01住宅 / 02配套 / 规划总平面（标称 T3 导出）。

| 问题 | 原因 | 处理 |
|---|---|---|
| 一份施工图 28732 个图元，只识别出 1 个图框，整张当一个平面提取，房间全乱 | 天正把几十个图幅平铺在同一张图纸边框里，按包含关系它们全是「嵌套图框」，被 25% 面积门槛当内边框丢掉 | 图框先找「带图名的闭合矩形」（一层平面图 / 南立面图…）；包住两个以上带图名框的（图纸边框）先排除，其余按阅读顺序编号。01住宅 由 1 个图框变成 43 个 |
| 房间名贴着墙写时，房间被推断成一条 500mm 宽的缝 | 用文字左下角插入点判断房间归属，贴墙时落在墙的另一侧 | 改用文字包围盒中心定位（`plan_extract` 传 `point`，`plan_core.text_point` 统一取用） |
| 推断矩形只圈住半间房，置信度还是「高」 | 置信度只看「四面有没有墙」，看不出这片空间是不是真是一个房间 | 加泛洪验证：把墙当障碍做一次栅格连通标记，房间名所在连通区域与推断矩形面积差 25% 以上、或区域碰到图框边界，判低 |
| 房间合计只占外包面积 24%，仍照常算量 | 没有全局校验 | 房间合计不到外包面积一半时 `plan_extract` 报警；`plan_codecheck` 直接退出码 2 不判定 |
| 02配套 判不出建筑类型 | 房间名就叫「商业」，识别规则只认「营业厅 / 商铺」 | 商业类型加上「商业 / 营业 / 店面」 |
| 改进后旧缓存不失效，同一张图还拿到旧图框 | 遍历结果按内容寻址缓存，不含代码版本 | 缓存文件名加 `TRAVERSAL_CACHE_VERSION`，判定逻辑改了就加一 |

实测结果：
- 01住宅：43 个图幅（负一层 / 一层 / 标准层 / 机房层 / 屋顶层平面图，另有立面、剖面）；提取「一层平面图」得 63.4×11.3m、107 段墙、65 门、54 窗。房间数据不可信（合计 172.88㎡，只占外包 716㎡ 的 24%），已按上面两条报警并拒绝初查 —— 该图的墙体在 T3 转换里丢了 2637 个天正墙体对象，只剩代理显示线。
- 02配套：13 个图幅；提取一层平面得 60.4×12.0m、14 段墙、10 门、7 个房间合计 541.38㎡（占 75%），房间名合理（社区服务用房、商业、微型消防站）。
- 规划总平面：没有成对的平行墙线，按非平面图报错，符合预期。

新增回归测试 test_frames_tiled_sheet / test_text_point / test_room_regions / test_codecheck_low_coverage（16 项，总计 139 项）。

## 房间提取改为泛洪取轮廓（2026-11-27）

第三轮发现：教学楼、配套这类简单平面房间算得对，住宅平面里房间被推断成 1.5㎡ 的窄缝、34.65㎡ 的大块，而且泛洪校验还说「高」——因为墙确实把那些碎块围住了。

| 改动 | 说明 |
|---|---|
| `RoomRegions` | 把墙当障碍做一次栅格连通标记（单元格 50mm 起，总格数上限 60 万），从房间名位置泛洪得到被墙围住的整片空间 |
| 轮廓 | 沿格子边界描一圈，取最大闭环（区域内独立墙垛会形成洞），Douglas-Peucker 拉直成少量顶点 |
| 取用 | `rooms_from_labels` 先用泛洪轮廓；泛洪漏到图框外（敞开的大厅、隔断没画）才退回矩形，标低置信度 |
| 面积 | 用描出来的多边形算，和工程量、报价、标注图完全一致；L 形房间不再被包围盒放大 |

教学楼首层复测：房间合计从 672.79㎡ 变为 866.28㎡（占外包 88%，原来 68%）。九个房间面积几乎不变（图书资料室 152.54→152.32、消防控制室 28.5→28.48、教室 94.76→94.72…），变化来自门厅：泛洪把与门厅连通的整条走廊算了进来，106.55→299.88㎡。这是连通空间的正确面积，但名字仍叫门厅——敞开空间分不出「门厅」和「走廊」，属于方法本身的边界。

01住宅复测：仍然不可信（23%）。原因是自动识别选中的 `WALL` 图层里放的是散落的剪力墙 L/T 符号，不是平面墙线；这种图要先确认墙图层（`--wall-layer`），或者用天正「图形导出」重出一份真正的 T3。

新增/改写回归测试 test_room_regions（连通两半算一间、整道隔墙分开、漏出去退回矩形、L 形 6 个顶点、内岛取外轮廓），总计 145 项。

## 复查：泛洪取轮廓（2026-11-27）

教学楼首层～五层复测：房间全部高置信度，面积与上一版矩形基本一致（±0.3㎡），每层 0.4s。门厅 299.88㎡ 含连通走廊，属方法边界，可接受。

发现并修复：一片泛洪区域里有两个房间名时（隔墙没画 / 没识别出来），两间被并成一间，面积翻倍、房间数少一，置信度仍是「高」且不报警。实测：四层去掉一道教室隔墙 → 「教室 153.28㎡ 高」。
- 同名重复（两个“教室”）→ 低置信度；不同名（“教室/储藏”，可能是套间）→ 中；
- 都加警告「这片空间里有 N 个房间名，被算成了一间」；
- 顺带更新 room_confidence 的说明（原文还写着已删掉的「与矩形差 25%」判据）。
新增 test_room_region_merged_labels（5 项）。

## 补柱、多层、楼梯洞口与核对闭环（2026-11-27）

之前模型只到「单层、无柱、无楼梯的墙体白模」。这一轮补齐：

| 补什么 | 做法 |
|---|---|
| 柱 | `plan.json` 增加 `columns`（中心、截面宽深、高），`plan_builder.rb` 按它挤出；之前柱只统计了数量，模型里一根都没有 |
| 楼梯间 / 电梯井 | 房间带 `type: "stair"`，建模时按通高洞口处理：不是最底层就不铺地面，各层都不做顶棚。不建踏步 |
| 多层 | 新增 `plan_building.py`：各层平面分别提取后合并成 `building.json`（层号、标高、每层的完整 plan）。`--auto` 按图名认层号，`--level 1=frame-5` 手动指定；同一层号认出多个图幅时报警告并提示用 `--level` 指定 |
| 核对闭环 | `plan_verify.py` 支持 `building.json`，按层号逐层比；新增柱截面核对；楼梯间上层没有地面是预期的，不算不一致 |

实测：
- 教学楼 `--auto` 认出 5 层（首层～五层），标高 0 / 2800 / 5600 / 8400 / 11200，每层墙 16–21、柱 44。
- 用「建得完全正确」的合成实测结果跑核对：5 层共 1839 项全部通过；把某层墙厚或柱截面改掉能立刻报出来。
- 02配套 `--auto` 认出 2 层（一层、二层），层高按 `--storey 4200`。
- 01住宅 `--auto` 认出负一层和一层，但同一层号有 4 个图幅（不同楼栋），已逐个报警告提示改用 `--level`。

已知边界：
- 各层按自己的外包框左下角对齐，各层外轮廓差得多时模型里会错位（报告里写明了）。
- 层高是统一值，不从图上读。
- 楼梯只有洞口，没有踏步；屋面、阳台栏板、梁仍未建模。
- SketchUp 本机没有，`plan_builder.rb` 的改动没实际执行过；核对逻辑用合成数据验证过。

新增测试 test_verify_closed_loop / test_building_levels / test_verify_building / test_columns_and_stairs（28 项，总计 173 项）。

## 建筑类型项目级、轮廓贴墙、plan 工具（2026-11-27）

上一轮复查提的三条都做了。

| 问题 | 处理 |
|---|---|
| 建筑类型逐层按房间名猜，三层有会议室就被判成「办公」，同一栋楼各层结论不一致 | 改成项目级设置：`plan_extract --building-type` 写进 plan.json，`plan_building` 写进每一层；初查按「`--building-type` → plan.json 里记的 → 按房间名猜」的顺序取，报告里注明来源。`project_profile` 的 import_plan 也会把平面里的类型记进项目档案（档案里已有的不覆盖） |
| 房间轮廓沿 50mm 栅格走，离墙面最多差 25mm，SketchUp 里地面和墙内表面差一条缝 | 描完轮廓后把每条边贴到最近的墙面（横边找水平墙、竖边找竖直墙，只在容差 1.5 格内且与墙有实质重叠时贴）。教学楼复测：九个房间面积回到与矩形法完全一致（152.54 / 28.5 / 27.35 / 36.98 / 94.76 / 75.5 / 76.65），说明之前的偏差纯粹来自栅格 |
| 提取 / 初查 / 算量只能靠 execute 拼命令行 | 新增 `src/runtime/tools/planTools.ts`：`plan_extract` / `plan_building` / `plan_check` / `plan_quantity` 四个工具，参数类型化、路径限定在工作区内、直接返回解析后的 JSON 摘要（超过 24KB 只回路径）。子智能体的 cad-analyzer 角色也能用 |

实测（用 tsx 直接调工具，不经 Electron）：
- `plan_extract` 教学楼 frame-1 → 21 墙 / 20 门 / 22 窗 / 44 柱 / 10 房间 866.42㎡；
- `plan_check` 读 plan.json 里的 education → 正确拒绝，退出码 2，报告写明来源是「plan.json 里记的」；
- `plan_quantity` 出 JSON → 地面 866.42㎡、墙面 1159.95㎡、踢脚线 429.77m；
- `plan_building --auto` → 5 层，标高 0/2800/5600/8400/11200。

已知边界不变：各层按外包框左下角对齐；层高是统一值；楼梯只有洞口；SketchUp 仍未实机验证。
新增测试：轮廓贴墙（内墙在 1525 时贴到 1425）。test:plan 175 项全过。


## 复查：柱 / 多层 / 贴墙 / plan 工具（2026-11-27）

整体：上一轮提的三条都落实了，柱、多层、楼梯洞口、按层核对也补上了，方向和质量都好。复查发现 7 处问题，已改：

| 问题 | 影响 | 处理 |
|---|---|---|
| `plan_building --storey` 只用来算标高，没传给提取 | 层高 4200 时每层墙、柱还是 2800 高，楼层之间空出 1400 的缝（02配套就是这么跑的） | `--storey` 同时以 `--height` 传给每层提取；各层层高不一致时报错 |
| `STAIR_ROOM_RE` 含「前室」 | 消防前室 / 合用前室被当成通高洞口，上层不铺地面 | 去掉「前室」 |
| 轮廓贴墙用整个轮廓的形心判断房间在墙哪一侧 | L 形房间凹角那条边、薄墙时可能贴到墙的外皮 | 改为在边中点两侧各探半格，落在轮廓里的一侧才是房间 |
| 先 Douglas-Peucker 拉直再贴墙 | 薄墙（≤ 一格多）围出的凹角先被抹成斜边，斜边贴不上墙；60 厚隔墙的 L 形房间少 0.07㎡、多一条斜边 | 先在原始格子边界上合并共线点、贴墙，再拉直 |
| 栅格封墙时墙端一律外扩半个墙厚 | 墙端已延伸到交接墙外皮，再外扩会在 L 形转角内侧（房间凹角）咬掉 100×100 一块，轮廓多出 5 个顶点 | 墙端顶在另一面墙上时只补到那面墙的远侧外皮；悬空墙端仍外扩半墙厚 |
| `plan_check` 描述说接受 building.json | 实际 `load_plan` 直接报「不是 plan.json」，模型会照描述去调 | 改描述；传 building.json 时直接返回说明，提示逐层调用；`plan_quantity` 同样处理 |
| plan 工具的 `out` 可以是工作区里任意路径 | 工具不弹审批，模型写错 out 就能覆盖设计文件 | `out` 只允许对应的派生扩展名（.plan.json / .building.json / .xlsx / .quote.json）；工程量不接受裸 `.json`，否则 `project.json` 和 `xxx.plan.json` 都能被覆盖，守卫等于失效 |

另：`plan_builder.rb` 里 `(plan['openings'] || {})` 改成 `|| []`。

复测：教学楼首层～五层房间面积与上一版完全一致（门厅 300.02，原 299.86~300.09 之间浮动），全部高置信度，无警告。
新增 test_room_outline_corners（7 项）。

未改、记下：
- 柱补成了墙段（为了不把柱位当过道），SketchUp 里墙体穿过柱位，再叠一根柱子，两个实体重叠；`plan_quantity` 的墙体体积也把柱位算成了墙。出图没问题，体积偏大约 柱截面×层高×柱数。
- `plan_building` 一层提取失败就整栋失败，没有「跳过这层继续」。
- 各层按外包框左下角对齐（已在已知边界里）；更稳的是按轴网（AXIS 图层的 1 / A 轴交点）对齐。
