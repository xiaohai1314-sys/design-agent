# design-agent 与 znzmo 底层对照及落地建议

> 对象：`D:\design-agent`（自研） vs `D:\Program Files\znzmo`（参考产品 1.1.86）
> 方法：解包 `app.asar`（5,872 个文件 / 122MB）与 `@zmo/agent-runtime`（9.3MB 打包产物），静态阅读
> 日期：2026-11-25

---

## 一、结论

**引擎已经追平，差距在资产。**

design-agent 目前 19,227 行，24 个工具，5 个 MCP 连接器，续跑 / 压缩 / offload / prompt cache / 生图能力门禁 / 子智能体 / PPT 提案 / 规范检索——znzmo 的骨架全部具备。

znzmo 的专业感不来自"模型更强"或"代码更多"，而来自**把每个环节的不确定性提前消掉**：

| 环节 | znzmo 如何消掉不确定性 |
|---|---|
| 出图 | 固定的云端生图后端，与聊天模型解耦 |
| 建模 | 预置建模脚本，模型只负责 load 和执行 |
| 汇报 | 元素级 PPT 编辑器 + 草稿保护 |
| 规范 | 16,209 本固定语料 |
| 任务 | 43 类固定目录 + 表单 |

模型只在岔路口做选择。**这五样资产才是护城河，而不是编排代码。**

---

## 二、逐项对照

| 维度 | znzmo | design-agent | 状态 |
|---|---|---|---|
| Agent 循环 | deepagents + LangGraph | 自写 `runAgentLoop`（80 轮上限） | 已平 |
| 工具集 | 18 个 + MCP 延迟加载 | 24 个 + `mcp_tools` / `tool_search` | 已平 |
| 断点续跑 | LangGraph checkpointer | 自写 JSON checkpoint + `sanitizeHistoryForResume` | 已平 |
| 上下文压缩 | SummarizationMiddleware | 72% 触发 + 15s LLM 摘要 | 已平 |
| Prompt 缓存 | AnthropicHistoryCache | `enablePromptCache` | 已平 |
| 生图 | 云端工具 + ArtifactDownload | `generate_image` + 能力门禁 + 快速拒绝 | 缺后端 |
| 建模 | 4 套预置脚本 + 4 连接器 | 连接器齐，脚本靠模型现写 | 缺资产 |
| PPT | 元素级编辑 + 撤销 + 草稿保护（1MB Worker） | 210 行工具 + 提案 | 深度不足 |
| 规范 | 16,209 本 / 31 地区 | 本地文件 + 2/3-gram 打分 | 规模与精度 |
| **任务目录** | **43 类 + 表单** | **6~8 个手写预设** | **最大缺口** |
| 素材检索 | `search_inspiration` 三通道 | 只有 `web_search` | 缺失 |
| 模型来源 | 服务端白名单，无 BYOK | cc-switch 多源 | **你更强** |

---

## 三、四个真正的差距

### 3.1 43 任务目录 + 表单（最高性价比，几乎纯配置）

**znzmo 的做法**

`featureCatalog.json` 共 43 条，分 8 类：

| 类别 | 数量 | 代表 |
|---|---|---|
| 深化建模 | 12 | 图转CAD、三维模型深化、参数化建模 |
| 概念方案 | 8 | 平面布局、创意快速渲染、毛坯设计 |
| 生图 | 8 | 概念意象图、精准渲染、效果图美化、图片编辑、更换视角、更换氛围、平立剖填彩 |
| 汇报 | 5 | 汇报框架、文档编排、讲稿编写 |
| 策划 | 4 | 需求解读、现状分析、项目定位 |
| 施工 | 2 | 施工图深化、后期服务 |
| 评审 | 2 | 设计评审、专项技术评审 |
| 检索 | 2 | 搜索、查规范 |

单条结构：

```json
{
  "featureCode": "B4.3",
  "title": "精准渲染",
  "category": "生图",
  "description": "基于较完整的二维图片，设置渲染参数生成忠实空间设计效果图。",
  "cover": { "kind": "compare", "input": "...jpg", "generated": "...jpg" },
  "order": 27,
  "searchAlias": ["精模渲染", "模型截图渲染", "白模截图渲染", "保持构图渲染"],
  "todayRecommend": "周五",
  "recommendTab": true
}
```

配套 `featureForms.json` 定义每个任务的表单字段（`file` / `text` / `textFile` / `select`），提交时由 `composeFeatureSubmission` 拼成结构化文本：

```
【设计底图】
附件[1] 客厅.png

【领域】
室内

【材质参考】
附件[2] 木饰面参考.jpg
```

标题自动生成：`${feature.title}：${首个必填文本前20字}`。

**目录还支持远程覆盖**：`configEnvironment.ts` 里写死 `https://api.znzmo.cn`，启动拉一次配置，本地 JSON 只作兜底——不发版就能换卡片。

**design-agent 现状**

`SceneToolboxBar.tsx` 里手写 `TOOLBOX_PRESETS`，6~8 个，参数是固定 `name / options / defaultValue`。没有表单，没有分类网格，没有搜索别名。

**怎么补**（只动渲染层，不碰引擎）

1. 把 `TOOLBOX_PRESETS` 换成两份 JSON 配置：`featureCatalog.json` + `featureForms.json`
2. 加 5 种字段控件：`text` / `textarea` / `file` / `textFile`（文字或附件二选一）/ `select`
3. 实现 `composeFeatureSubmission`：按 `order` 排序 → 跳过空的非必填项 → 附件统一编号 `附件[n]`
4. 首页：分类 tab + 卡片网格 + `searchAlias` 搜索 + 今日推荐
5. 场景参数注入格式对齐：当前是 `<scene title="...">`，znzmo 是 `<scene tool="...">`

**成本**：1~2 天（全是配置和 UI）
**收益**：从"一个聊天框"变成"专业工作台"，第一眼可感知

---

### 3.2 素材检索链路（设计流程刚需）

**znzmo 的做法**

`search_inspiration` 一个工具三个通道：

| 通道 | 作用 |
|---|---|
| `text_search` | 站内关键词检索 |
| `img_search` | 以图搜图（纯图，不带文字） |
| `text_to_image` | 先生成一张目标画面，再用它检索相似商品（生成图不返回） |

返回卡片，前端渲染成瀑布流。

**design-agent 现状**

只有 `web_search`（通用联网搜索）。找参考图、找案例、找材质这条链路是断的。

**三条路，按合规排序**

| 方案 | 说明 | 风险 |
|---|---|---|
| A 自有素材源 | 本地图库 + 索引，最可控 | 需要先有图 |
| B 公开图库 API | Pexels / Unsplash / Pixabay，有商用授权 | 需申请 key，风格偏通用 |
| C 爬知末 | 客户端 AES key 硬编码（`Alkx89HzyuBI0456` / IV `NIZnz95GUY86Gfgh`），技术上能扒 | 盗用他人数据，不建议 |

**建议**：先做 B 兜底，但把 `search_inspiration` 做成**统一接口**（输入 query / imageUrl，输出 `{items:[{url,title,source}]}`），后端随时可换。以后接自有素材源或第三方都不用改工具定义。

**成本**：1 天接 API + 1 天做瀑布流卡片

---

### 3.3 预置资产：建模脚本（最容易被忽略，效果最猛）

**znzmo 的做法**

`build/campaigns/` 里是完整工程，不是提示词：

```
living-room-modeling-v1/
  scripts/  run.rb + architecture.rb + furniture.rb + kitchen.rb
            + decor.rb + finish.rb + refine.rb
  textures/ 14 张 oak / walnut / velvet / plaster

max-modeling-v1/  scripts/run.ms
cad-modeling-v1/  scripts/run.json + plan.dwg + plan.dxf
rhino-modeling-v1/ scripts/run.py
```

运行时拼出的提示词写死：

> 本轮参考图对应的客厅建模 Ruby 已准备好，**无需重新生成建模代码**，也无需读取或修改各子脚本。
> 请按 SketchUp 技能正常检查连接器并启动宿主…
> 通过原始 `sketchup__eval_ruby` 执行以下代码：
> ```ruby
> load 'D:\...\scripts\run.rb'
> LivingRoomDemo.build('D:\...')
> ```

**模型只负责编排和兜底，不负责从零写建模代码。** 这是"看起来很神"的根本原因——确定性工作做成了确定性资产。

**design-agent 现状**

MCP 连接器齐全（sketchup / 3dsmax / multicad / rhino / blender），`mcpManager` 有 tri-state 状态（plugin-missing / host-not-running / ready），但建模完全靠模型现写脚本——不确定性高、token 消耗大、失败率高。

**怎么补**

1. 选 1~2 个高频场景做预置包。建议先做**住宅客厅 SketchUp**（受众最广）和**平面图 CAD**（`cad` 技能已有 dwg2dxf 链路）
2. 每个包 = 一个入口脚本 + 参数化函数（尺寸、风格、家具清单作为入参）
3. 提示词加硬约束："脚本已就绪，直接 load 执行；报错时按错误修环境，不要重写脚本"
4. 场景识别：`<scene tool="照图建模">` 里带 `预置包: living-room-v1` 就加载对应脚本

**成本**：一个场景 2~3 天（写脚本 + 调通 + 贴图）
**收益**：建模成功率从"看运气"变成"接近 100%"

---

### 3.4 规范库规模与精度

**znzmo**

16,209 本 / 31 地区，服务端语料。工具 `retrieve_regulation_chunks(question_type, queries)`，技能 `regulation-consultation` 指导怎么问、怎么引用。

"综合"模式还有个专门中间件 `RegulationComprehensiveScope`，把工具集砍到只剩三个：

```js
new Set(["retrieve_regulation_chunks", "read_file", "ls"])
```

`read_file` 只准读 `regulation-consultation/SKILL.md` 和检索结果返回的 URL，越界直接回："综合首轮仅支持规范查询；其他任务请在通用会话中执行。"

**design-agent 现状**

`regulationTool.ts` 本地文件夹 + 关键词打分（含中文 2-gram / 3-gram 补召回），PDF 靠 python 抽文本。没有语义检索。

**怎么补**（保持本地，不依赖服务端）

1. 语料先收 200~500 本核心国标 / 行标（建筑防火、无障碍、住宅设计、装修施工）
2. 加 embedding：`bge-m3` 或 `text2vec-large-chinese`，本地跑
3. 向量库用 `sqlite-vec` 或 LanceDB，随 app 打包
4. 检索改成**混合**：BM25（现有打分）+ 向量召回 + 重排
5. 返回结构对齐 znzmo：条文 + 来源 + `tables` / `images` 字段（前端引用卡片靠这个渲染）

**成本**：3~5 天（含语料整理）
**收益**：从"能搜到"变成"搜得准"

---

## 四、必修的真 bug

`src/runtime/modelFactory.ts:33`

```ts
return new ChatAnthropic({
  model: modelName,
  anthropicApiKey: apiKey,     // ← 这个会发 x-api-key
  ...
})
```

而 `src/main/ccSwitchService.ts:95` 读的是：

```ts
const apiKey = (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '').trim()
```

`ANTHROPIC_AUTH_TOKEN` 是 **Bearer token**，`ANTHROPIC_API_KEY` 才是 **x-api-key**。两者被合并成同一字段，统一按 x-api-key 发送。

**后果**

`~/.claude/settings.json` 里配的是 `ANTHROPIC_AUTH_TOKEN` + `https://api.vokly.io` 中转。若该中转只认 `Authorization: Bearer`，anthropic 协议配置会直接 401——而 `testModelProfileConnection` 只会报"失败"，不会告诉你是 header 的问题。

**验证方法**

用同一个 key 分别打 `x-api-key` 和 `Authorization: Bearer` 两个 header，看哪个通。

**修法**

`ChatAnthropic` 支持 `createClient` 覆盖默认 headers，按 token 类型二选一注入。或在 profile 里加 `authStyle: 'x-api-key' | 'bearer'` 字段，由 cc-switch 导入时按来源自动判定。

**这是唯一一处会让现有配置直接不通的问题，优先级最高。**

---

## 五、不要做的四件事

| 别做 | 原因 |
|---|---|
| 重写 agent 循环 / 换 deepagents | 已经追平，换框架是负收益 |
| 自己做 PPT 渲染引擎 | znzmo 用了 konva + harfbuzz.wasm + GenOffice，投入产出比极低；现有 `pptxgenjs` 路线够用 |
| 复刻素材库爬虫 | 技术上可行（AES key 都能拿到），但等于盗用数据 |
| 做云渲染农场 | 重资产生意，不是软件功能 |

---

## 六、建议顺序

```
P0  ── 修 Bearer / x-api-key bug            （半天，不通则全盘不通）
P0  ── 接一个真能用的生图后端              （半天，Gemini 或硅基流动）
P1  ── 43 任务目录 + 表单                  （1~2 天，纯配置，感知最强）
P1  ── 预置建模脚本 1 套（住宅客厅 SU）     （2~3 天，成功率质变）
P2  ── 素材检索 search_inspiration          （2 天，补链路）
P2  ── 规范语料 + 向量检索                  （3~5 天，精度）
P3  ── PPT 工作台加深到元素级               （按需）
```

前四项加起来不到一周，做完之后产品形态会有质的变化——**引擎一行不用动**。

---

## 附录 A：znzmo 架构速查

```
znzmo.exe (Electron)
├── out/main/index.js (826KB)          ← 壳：窗口、IPC、MCP 管理、Worker 调度
├── @zmo/agent-runtime (9.3MB)         ← 智能体本体，utilityProcess 单独拉起
├── resources/skills/ (14 个技能)       ← SKILL.md 渐进披露
├── agent-runtime/python/ (嵌入式 3.12) ← 本地工具链
└── agent-runtime/mcp/                 ← 本地 MCP 服务
      sketchup / 3dsmax / multicad / rhino / blender / photoshop / computer-use
```

运行时依赖：

```
deepagents ^1.10.2, langchain ^1.5.10, @langchain/langgraph ^1.4.12,
@langchain/langgraph-checkpoint, @langchain/mcp-adapters,
@langchain/anthropic, @langchain/openai
```

**智能体在本机跑，大脑在云上。**

- 云端：`api.znzmo.cn`（配置 / 模型白名单）、`ai.znzmo.cn`（LLM 代理 / 生图 / 检索 / 规范）、`s0-cdn.znzmostatic.com`（素材）
- 本地：编排循环、文件工具、MCP 连接器、Python 执行

### 工具清单

```
ls / glob / grep / read_file / write_file / edit_file / execute / write_todos
generate_image / ai_search / search_inspiration / retrieve_regulation_chunks
deliver / deliver_example / ask_image_edit / ask_user / remember / task
ppt_workbench / mcp_tools / tool_search
```

### 中间件栈（20+ 层）

```
todoList / Filesystem / subAgent / Summarization / patchToolCalls
Skills / SubagentSkills / SubagentMcpScope
ArtifactDownload / AnthropicHistoryCache / BasePromptStrip
UserInteractionGate / RegulationComprehensiveScope
PptWorkbenchAvailability / PptWorkbenchWriteGuard
ToolErrorRecovery / WindowsPathCompat / modelRetry
```

值得注意的三个：

- `UserInteractionGate`：同一轮里 `ask_user` 和 `ask_image_edit` 只准出现一个，第二个直接报错回喂
- `ArtifactDownload`：本地参考图自动 `POST ${cloud}/geturl` 换成 URL 再调远端工具，失败明确告知"未发送给生图服务"
- `WindowsPathCompat`：自动把 `/D:/xxx` 修成 `D:/xxx`

---

## 附录 B：znzmo 的生图链路

客户端**没有** `/images/generations` 调用。整个生图靠 `ArtifactDownload` 中间件包住远端工具：

```
1. 本地参考图 → POST ${cloudBase}/geturl (multipart) → { url }
2. generate_image({ image_name, image_urls: [url...] })
3. 返回 urls → 下载到本地 renders/
4. 包成 artifact { kind:"image", summary, images:[本地路径] }
```

工具参数只有三个：`image_name`、`image_urls`、提示词。**文生图和图生图是同一个工具**，区别只在于 `image_urls` 空不空。

结论：生图模型、key、算力、鉴权全在服务端，客户端拿到的是成品 URL。**聊天模型选什么都不影响出图。**

---

## 附录 C：znzmo 的模型与计费

```js
fetch("https://api.znzmo.cn/agent/v1/llm/models")   // 账号维度白名单
```

模型列表（GPT-6 / GPT-6.2 Astra / DeepSeek-V4.1-Flash 等）是服务端下发，用户不可填。计费按"知点"，失败码：

```
INSUFFICIENT_BALANCE / SETTLEMENT_PENDING / BALANCE_BELOW_MIN
```

云渲染单独一套"渲币"，与 AI 的"知点"分开。

---

## 附录 D：系统提示词不在客户端

运行时里只有占位符：

```js
var b2 = {
  supervisorHead: "⟦zmo:sys:supervisor.head@1⟧",
  supervisorTail: "⟦zmo:sys:supervisor.tail@1⟧",
  filesystem:    "⟦zmo:sys:filesystem@1⟧",
  metadataSeed:  "⟦zmo:sys:metadata-seed@1⟧",
  regulationComprehensive: "⟦zmo:sys:regulation-comprehensive@1⟧"
};
```

正常模式下服务端展开；只有 `ZMO_LLM_BASE_URL` 直连模式才需要本地 `eval/prompts.cache.json`（当前机器上没有）。

**所以主控提示词看不到**——这是它最有价值的部分之一，也是最难抄的。
