---
name: blender
description: 操作用户本机正在运行的 Blender——读场景与物体、视口截图、执行 bpy 代码建模改模型、导出场景。用户要在 Blender 里实际做事，或 Blender 工具报连接失败/超时/无响应时使用；只解释 Blender 概念、不动场景时不使用。
---

# Blender

## 先判断连接状态

按下面三种情况对照，命中哪条就照做。**不要自己另想办法**——连接问题只有用户能在他的电脑上解决，
你反复试错只会浪费轮次。

### ① `<mcp-servers>` 里没有 `blender`

用户没有打开 Blender 连接器。**立刻停下**，告诉用户：在输入框的连接器配置里打开 Blender，
然后重新发一次消息。

不要去装插件、装 Python 包、改配置文件，也不要换别的方式代替（写脚本让用户手动运行、
在命令行里调 `blender` 等）。

用户回来说开关打不开，或旁边有提示时：

- 提示「未检测到 Blender」→ 没装 Blender，或装了但**从没打开过**（Blender 首次启动才会生成
  配置目录）。让用户先安装或先打开一次 Blender，再回来打开连接器。
- 提示版本过低 → 需要 Blender 3.0 及以上，把提示原话转达给用户。

### ①' 有 `blender`，但用户消息末尾的 `<mcp-status>` 列出了它

连接器是开着的，是这一轮连接组件自己没启动起来（与 Blender 开没开无关），**不要让用户去开连接器**。
把 `error` 里的原因如实转述给用户，用户处理好后发一条新消息即会重新连接。

### ② 有 `blender`，但调用工具时连不上

典型报错：`Could not connect to Blender. Make sure the Blender addon is running.`，或者调用超时。

连接器是开着的，问题在 **Blender 那一侧没有在服务**。注意：Blender 没开的时候，服务照样能
启动、也能列出工具，所以**能取到工具不代表已经连上 Blender**。

**只试一次**，失败就停下，把下面这段转达给用户，等用户处理完再试：

1. **先确认 Blender 已经打开。** 没开就打开它，等主界面出来后再让我继续。
2. **Blender 开着还是连不上**，多半是插件没启用：点 Blender 上方菜单
   **编辑 → 偏好设置 → 插件**，搜索 **MCP for Blender** 并勾选。
3. 回到 3D 视图，按 **N** 打开右侧边栏，切到 **MCP for Blender** 标签：
   - 显示 **Not connected** 和 **Connect to MCP server** → 点这个按钮启动服务；
   - 显示 **Connected on port 9876** → 已经在服务了。
4. 还不行，就**重启一下 Blender**。插件启用后会随 Blender 启动自动开始服务，不用每次手动点。

**端口 9876 被占用时**：Blender 插件绑不上端口，会跳过自动启动，工具的报错也可能不是上面那句，
而是莫名其妙的错误或一直超时。SketchUp 的 MCP 服务已改用 9877，正常不会再和 Blender 冲突；
但**还没重启的旧版 SketchUp 插件**（SketchUp 开着时才更新的）可能仍占着 9876，让用户
**保存后重启 SketchUp**，再重启 Blender。是别的程序占着的，让用户先关掉它再重启 Blender。

排查时可以读 `<技能目录>/../../mcp/mcp.json` 里的 `servers.blender`，看连接器的实际状态
（`hostState` / `hostError`），只读不改。

### ③ 连上了，但提示插件版本不匹配

`get_addon_status` 返回 `up_to_date: false`，或报错里提到协议版本（protocol）不一致。

插件由本应用自动安装。**不要**照工具说明里的提示让用户运行 `uvx blender-mcp install-addon`
或 `pip install`——用户电脑上没有这些命令。让用户在连接器配置里把 Blender **关掉再打开一次**
（会重新安装插件），然后重启 Blender。仍不行就把原始报错转达给用户。

## 不要做的事

- **不要自己启动 Blender**（`open` / `start` / 直接调 `blender` 可执行文件），也不要强杀用户的 Blender。
- **不要反复重试连接。** 同一个连接错误出现一次就停下转达，重试不会让 Blender 自己打开。
- **不要改**端口、环境变量、Blender 的偏好设置或插件文件。
- 遥测已在服务端关闭，插件偏好里「Allow Telemetry」勾没勾都不会上传。不必调用
  `disable_telemetry`，也不必向用户提这件事。

## 开工

- 大部分操作用 `execute_blender_code`（执行 bpy 代码），用
  `tool_search("select:blender__execute_blender_code")` 直接取契约。代码**分小段**执行，每段只做
  一件事，出错时才知道是哪一步。
- 动手前先用 `get_scene_info` 看清当前场景，**别假设是空的**。有内容时默认在其基础上增改，
  **不要删除用户已有的物体**，确需清空先跟用户确认。
