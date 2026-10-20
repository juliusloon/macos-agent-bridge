# 0.2.0 自动执行与联网更新

## 自动批准

在 **macOS Agent Bridge → 自动批准普通写入** 切换模式。`auto-write` 允许已启用的普通写入能力直接执行，包括创建日历事件、提醒事项、文件、笔记和剪贴板操作。`manual` 恢复逐次确认；已单独信任的能力继续按原配置工作。停用能力、文件授权范围和已拒绝的请求始终有效。

删除、邮件发送、运行快捷指令等 `high` 风险工具继续通过 **待确认操作 → 批准并执行** 明确批准。现在该按钮一步完成审批与执行，不再二次弹框。审批页面始终展示完整参数。MCP 工具自身没有修改审批策略的入口。

Tinycast 的服务级批准独立于 Bridge。需要免去每次聊天的首次确认时，在 **Settings → AI → MCP Servers → macOS Bridge → Trust** 选择 **Always Allow**。macOS 首次访问日历、联系人、辅助功能等系统授权仍由系统管理。

新安装和旧配置迁移的默认模式为 `manual`。用户可以在管理界面启用 `auto-write`；切换模式不会自动执行此前积压的请求。

## 联网工具

| 工具 | 输入示例 | 返回 |
|---|---|---|
| `web_search` | `{"query":"Node.js HTTP documentation","limit":5}` | 标题、来源 URL、摘要 |
| `web_fetch` | `{"url":"https://example.com","maxChars":20000}` | 可读正文、标题、链接、截断信息 |
| `network_check` | `{"url":"https://example.com","http":true}` | DNS 地址、解析耗时、HTTP 状态与耗时 |

默认搜索使用 DuckDuckGo；可在 MCP Environment 配置 `BRIDGE_BRAVE_API_KEY`，自动选择 Brave Search API。没有密钥时不要求申请第三方账户。搜索提供方不可达或要求验证码时返回明确错误，不伪造结果。

联网优先使用 `HTTPS_PROXY` / `HTTP_PROXY` 和 `NO_PROXY`；GUI 进程没有这些环境变量时，自动读取 macOS 系统 HTTP/HTTPS 代理与例外列表（30 秒缓存）。纯 PAC 或 SOCKS 配置会明确提示配置 HTTP(S) 代理。

只支持公共 HTTP(S) 80/443 端口。每次 DNS 解析、每个重定向目标均校验公网地址，并固定已验证 IP。禁止内网、localhost、云元数据地址、URL 内嵌凭据和 HTTPS 降级重定向。单次请求总超时默认 15 秒，最多 30 秒；解压后响应最多 2 MiB，正文默认 20,000 字符；每个服务进程最多 4 个并发联网请求和 32 个等待请求。

不会执行网页 JavaScript、读取浏览器 Cookie 或模拟登录。网页内容带 `untrustedContent: true`。搜索与读取结果只作为资料，不能授权本地动作。

## 调用流程

- 管理页通过一次 `overview` 获取配置、工具和待处理请求，原生 Helper 诊断按需进行。
- 已批准请求使用原参数和原幂等键即可继续，无需手工传回 `_approvalId`。
- `bridge_get_operation` 通过 `{tool,idempotencyKey}` 获取状态与已保存结果，不重新执行动作。
- 同进程重复请求合并；跨进程重复请求短暂等待原结果。仍在执行时返回 `ACTION_IN_PROGRESS`；断线、超时或未知结果返回 `ACTION_INDETERMINATE`，保留原收据。
- 修改能力开关后发出 MCP `notifications/tools/list_changed`，支持该通知的客户端可刷新工具列表。
- Helper 启动合并、UTF-8 分包解码、绝对超时和异常响应处理提高原生调用稳定性。
- 审计故障不会把已经成功的动作伪装成失败；详情记录在进程 stderr，stdout 保持 MCP 协议格式。

## 更新

```sh
npm run check
npm test
npm run update:local
```

`update:local` 更新已安装 JavaScript runtime 和已导入的 Tinycast 扩展，自动备份旧代码，并保留原生 Helper 的签名、系统权限和用户状态。无需退出 Helper。若更新失败会恢复已替换目录。

更新后重连 Tinycast 的 macOS Bridge MCP 服务，并重新打开扩展页面。已运行的 Node 进程不会自行加载新代码。新连接应显示 **0.2.0 / 63 tools**。
