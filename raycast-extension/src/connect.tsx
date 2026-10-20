import { Action, ActionPanel, Detail, Toast, getPreferenceValues, showToast } from '@raycast/api';
import { call } from './client';
export default function Connect() {
  const { bridgeLauncher } = getPreferenceValues<{ bridgeLauncher: string }>();
  const markdown = `# 连接 Tinycast AI Chat

本扩展提供自动批准设置、系统能力、联网工具、待确认操作与日志。首次使用时，在 Tinycast 的 **MCP Servers** 中连接一次。

1. 打开 **Tinycast → Settings → AI → MCP Servers**。
2. 启用 MCP，选择 **Add MCP Server**。
3. 名称填 **macOS Bridge**，Connection 选 **Command**。
4. Command 填下方路径，Arguments 填 **--serve**。
5. 选择适合自己的 **Trust** 设置，点击 **Test Connection**，确认工具列表后保存。已有连接在更新后重新连接即可。

### Command

\`${bridgeLauncher}\`

### Arguments

\`--serve\`

## 自动批准

打开 **macOS Agent Bridge → 自动批准**，可开启普通写入自动批准。也可以在单个能力中设置始终信任。发送、删除等高风险请求仍显示在 **待确认操作**，审阅具体参数后选择一次 **批准并执行**。

批准设置分别由三个位置管理：

- **Bridge 自动批准**决定本插件是否要求逐次确认写入。
- **Tinycast 的 Trust**决定宿主是否询问 MCP 工具调用；使用宿主提供的信任设置管理。
- **macOS 系统权限**决定日历、通讯录、辅助功能等资源是否可访问；首次需要在系统授权界面完成。

## 开始使用

AI Chat 选择支持工具的 API 模型或已登录的 Codex / Claude，然后发送：

> @macos-bridge 读取系统时区和运行时间。

> @macos-bridge 查询未来七天日程，使用 Asia/Shanghai 时区。

> @macos-bridge 搜索 TypeScript 官方发布说明，并给出来源链接。

> @macos-bridge 读取指定网页，提取正文并总结。

写入调用应保留同一个幂等键。遇到待确认状态，打开返回的审批链接；完成后，AI 可重试相同参数取得结果，或通过 **bridge_get_operation** 查询状态。超时后先核实状态，避免重复创建。

外部 Agent 使用相同 Command 和 Arguments。联网工具直接连接公开网站，无需启动浏览器。`;
  return <Detail markdown={markdown} actions={<ActionPanel><Action.CopyToClipboard title="复制 MCP Command" content={bridgeLauncher} /><Action.CopyToClipboard title="复制 Arguments" content="--serve" /><Action.CopyToClipboard title="复制 MCP 配置" content={JSON.stringify({ mcpServers: { macos_bridge: { command: bridgeLauncher, args: ['--serve'] } } }, null, 2)} /><Action title="检查本地服务" onAction={async () => { try { const data = await call<{ capabilities: unknown[] }>('bridge_list_capabilities'); await showToast({ style: Toast.Style.Success, title: `发现 ${data.capabilities.length} 个工具` }); } catch (error) { await showToast({ style: Toast.Style.Failure, title: '服务不可用', message: error instanceof Error ? error.message : String(error) }); } }} /></ActionPanel>} />;
}
