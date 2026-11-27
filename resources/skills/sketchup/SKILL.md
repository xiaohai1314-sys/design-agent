---
name: sketchup
description: 操作用户本机的 SketchUp（草图大师）——建模、改模型、读当前选择、设材质、导出场景、跑 Ruby。开工前先用一条命令确保 SketchUp 已启动且 MCP 服务就绪，没启动就自动带一张空白页拉起。用户要在 SketchUp 里实际做事，或 SketchUp 工具报连接失败/超时/无响应时使用；只解释概念、不动模型时不使用。
---

# SketchUp

## 前置检查

`<mcp-servers>` 里没有 `sketchup` → 本机没装 SketchUp 连接器，或用户没在输入框的连接器配置里
打开它。**立刻停止任务，让用户去输入框的连接器配置里启用 SketchUp**，不要绕路、不要用别的方式代替。

`<mcp-servers>` 里有 `sketchup`，但用户消息末尾的 `<mcp-status>` 列出了它 → 连接器是开着的，
是这一轮连接组件自己没启动起来，**不要让用户去开连接器，也先不要让用户重启 SketchUp**（连接组件
启动不依赖 SketchUp）。把 `error` 里的原因如实转述给用户；报「连接 超时」且子进程仍在运行时，常见原因是
电脑上的安全软件拦截或扫描了本机连接，可建议用户在安全软件里信任本应用后发一条新消息重试。

列表里有 `sketchup` 但连不上 → 提示用户**手动打开 SketchUp 并选中一个空白页**，然后再试一次连接。

SketchUp 已经开着、模型也打开了，还是连不上 → 多半是插件在 SketchUp 打开之后才装上或更新：
SketchUp 只在启动时加载插件，开着时装上的要重启才生效。让用户**保存当前模型、完全退出 SketchUp
再重新打开**，然后重试。重启后仍连不上，再让用户到**「扩展程序 > 扩展程序管理器」确认
「ZMO MCP Server」已勾选启用**；列表里压根没有它，多半是扩展加载策略拦了未签名扩展，让用户在
扩展程序管理器的「设置」里放开加载策略后重启。

排查时可以读 `<技能目录>/../../mcp/mcp.json` 里的 `servers.sketchup`，看连接器的实际状态
（`hostState` / `hostError`），只读不改。

## 开工前一条命令

```bash
python <技能目录>/scripts/ensure_sketchup.py
```

- `READY …` → 直接干活，别再做额外检查。
- `FAILED …` → 后面是原始错误（连接报错、应答内容、进程退出等）；Windows 上还附 9877 的监听进程
  和各 SketchUp 进程的 PID、运行时长、屏幕窗口。脚本不做归因，据这些事实判断，不要自己另想办法拉起。

开着且服务就绪 = 零动作；没开 = 带一张空白页拉起（约 12–20 秒），SketchUp 会被推到前台。

## 三条纪律

**① 干活只用 `eval_ruby`。**
工具列表里有 `sketchup__eval_ruby` 就直接调用；只有 `mcp_tools` / `tool_search`（启用了延迟加载）时，
用 `tool_search({ names: ['sketchup__eval_ruby'] })` 激活。另外 9 个工具建筑场景用不上。`eval_ruby` 返回**最后一个表达式的 `to_s`**，要看什么就拼成字符串放最后一行。
**不要用 `puts`**——它返回 `nil`，你拿到的是空字符串。

**② 不要自己拼 `open` / `start` 启动 SketchUp**，脚本已经处理好。
进程在但服务不响应时，按 FAILED 提示处理。

**③ `Sketchup.open_file` 之后必须重新校验活动模型。**

```ruby
Sketchup.active_model&.path   # 必须等于你刚打开的那个路径，否则停下来
```

它跟随最前面的窗口，不跟随你刚打开的文档：后台时滞后指向旧文档，关掉一个文档后变 `nil`。
不校验就往下建模，会静默改到用户的另一个文档里。

## Ruby 脚本规范

**每个可能失败的步骤各自 `rescue`，把所有错误一次收集回来再返回**，不要让第一个异常中止整段——
否则 N 个错就要跑 N 轮，每轮还要用户点一次授权。批量设置类 API（`rendering_options`、材质、
图层）尤其要逐项包起来：它们的报错不说是哪一项坏了。

## 开工先探文档

别假设是空的：读 `Sketchup.active_model` 的 `path` / `entities.length` / `layers`。有内容时默认在
其基础上增改，**不要 `entities.clear!`**，确需清空先跟用户确认。

## 按平面图建户型白模：plan_builder.rb

用户给了户型平面图（DWG / DXF）要建模时，**不要现写墙体几何的 Ruby**，按下面的固定流程走：

1. 用 cad 技能的 `plan_extract.py` 把平面图转成 plan.json，把识别结果和「需确认」的默认值告诉用户，确认或修正后再继续。
2. 通过 `eval_ruby` 生成模型（路径用正斜杠）：

```ruby
load '<技能目录>/scripts/plan_builder.rb'
DesignAgentPlanBuilder.build('<工作区>/.design-agent/plans/xxx.plan.json', {
  style: 'modern_minimal',                       # 可选：new_chinese / wabi_wood / light_luxury
  preset_dir: '<技能目录>/../../presets/living-room-modeling-v1',   # 有它时沿用该包的风格贴图
  export_preview_path: '<工作区>/renders/plan_model.png',
  output_skp_path: '<工作区>/plan_model.skp'
})
```

   - 墙按洞口拆成墙段、窗台、过梁，不依赖布尔运算；门扇、推拉门、窗框玻璃，各房间地面与顶棚一并生成，分别放在 `DA_墙体`、`DA_门窗`、`DA_地面`、`DA_顶棚` 标记里，并建好 `DA_轴测`、`DA_俯视` 两个场景。
   - 所有几何都在 `DesignAgentPlan_Root` 组里；重复执行只替换这个组，不动模型里其他内容。可选参数：`include_floors`、`include_ceilings`、`include_doors`、`include_windows`（默认都为 true）、`replace_existing`。
   - 返回 JSON：`status`、墙和洞口数量、各房间地面实测面积、外包尺寸、`warnings`。单个构件建失败只跳过它自己，错误连构件名写进 `warnings`（形如「墙 W3 建模失败：…」），其余照建、`status` 为 `partial_ok`。不要因为有一条警告就整体重来，按构件名定位后改 plan.json 重建。
3. **核对**：执行 `DesignAgentPlanBuilder.measure`，把返回的 JSON 原样写成 `measure.json`，再运行 cad 技能的 `plan_verify.py --plan … --model measure.json`。有不一致时修正后重建、再核对，通过后再导出和 `deliver`。
4. 用户要改尺寸、开间、门窗位置时，改 plan.json 后重新 `build`，不要在模型里手工拉伸墙体（否则下次重建会覆盖，核对也会失效）。

家具、软装仍可沿用客厅预置包的模块，或在 `DesignAgentPlan_Root` 之外另建组。

## 按需读取的二级文档

- 建模依据里有平面参考图（户型图、总平面、楼层平面、CAD 导出图或照片等）时，先读取 [平面参考图读取](references/floor-plan-reading.md)，按其中的方法提取布局、对象、尺寸与方向并交接，再回到本文件的主流程建模。该文档只管读图；本图没有依据的内容仍按用户授权在主流程里处理。

## 已知坑

- 阴影开关在 `model.shadow_info`，不在 `rendering_options`。
