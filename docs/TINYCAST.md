# Tinycast 0.12.1 接入

项目的兼容性基线为 Tinycast 0.12.1。集成使用其 Raycast 兼容层提供的 React 组件、preferences、`execFile` 与 `util.promisify`；其他版本请独立验证。本扩展不在Tinycast进程内运行Node MCP SDK。

## 导入

1. 安装本项目独立运行组件（源码`npm run install:local`或离线交付包的`Install.command`）。
2. Tinycast → Settings → Extensions → **Add from folder**，选择构建产物`Extension/`或源码`raycast-extension/dist/`。
3. 扩展设置中应看到5个命令和已经自动填好的`Bridge launcher`。

## AI Chat

Tinycast → Settings → AI → MCP Servers：

| 字段 | 值 |
|---|---|
| Name | macOS Bridge |
| Handle | @macos-bridge（由Tinycast生成） |
| Connection | Command |
| Command | 安装器生成的`…/Library/Application Support/MacOSAgentBridge/bridge` |
| Arguments | --serve |
| Environment | 留空 |
| Trust | Always Allow（服务级免重复批准）；也可保留 Ask Each Chat |

Test Connection 应报告63 tools。保持单独的`Command`和`Arguments`字段，不把带空格的路径拆成多个参数。无需凭据、远端URL或Raycast Pro。

支持工具的模型：Tinycast的API连接、Codex、Claude。Apple Intelligence、Grok、OpenCode、Cursor路线按Tinycast官方行为不接收MCP工具。不要误把“模型能聊天”当成“模型能调用工具”。

## 写入与审批

在 **macOS Agent Bridge** 主页面打开第一项 **待确认操作**，或搜索 **审批 / 待确认操作 / Review Agent Actions**。也可点击 [直接打开审批列表](tinycast://extensions/cano/macos-agent-bridge/approvals)。无需打开 Raycast。

普通写入可在 Bridge 主页面开启自动批准；以下流程适用于仍需要逐次确认的动作。

1. AI 提交写入后返回 `confirmation_required`、审批链接和有效期，尚未写入。
2. 在审批列表核对标题、日期、地点和完整参数，选择 **批准并执行**（一步完成，无二次确认框）。
3. 界面显示 **操作已完成** 才表示实际执行成功。回原 AI Chat 告知完成，AI 会使用原请求读取结果。
4. 等待期间不要让 AI 换幂等键反复提交。过期请求需重新申请；拒绝的请求不会自动重提。

0.2.0 加入自动批准普通写入、联网搜索/读取/诊断、操作状态查询和更快的管理页。更新扩展和 Runtime 后，在 Tinycast 的 MCP 设置中关闭再开启 **macOS Bridge**，再开新 AI Chat，以重新加载服务和指引。单独重新导入扩展不会替换已运行的 MCP 进程。

## 宿主限制

Tinycast不将Raycast `tools/` 自动带入Chat；本扩展的标准`ai.mcp`供Raycast使用，Tinycast仍需一次MCP设置。这个限制不能仅通过扩展内的普通TypeScript代码消除。项目不修改Tinycast偏好内部格式，也不修改其应用包。

官方依据：[扩展兼容性](https://tinycast.dev/docs/extensions/compatibility/)、[MCP设置与模型支持](https://tinycast.dev/docs/ai/mcp/)。只查看了其公开源码与应用自带Runtime验证接口行为，未访问Raycast私有数据库。
