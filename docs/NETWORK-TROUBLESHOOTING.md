# 日期与联网故障排查

## 2026-10-22 问题分析

Agent 要处理“今天晚上”的日程，但旧版 `system_status` 只返回运行时长和时区，没有当前日期时间。Agent 随后反复查询外部授时网站、猜测 API 路径，并尝试从行情时间戳推算当前时间。行情时间只是最近一次交易时间，不能作为当前时间；把提醒要求写进日程备注也不会创建原生提醒。

本机脱敏审计统计：该次任务在 16:21–16:23（Asia/Shanghai）共调用 `web_fetch` 14 次，成功 3 次，失败 11 次：

| 失败类型 | 次数 | 含义 |
| --- | --- | --- |
| `NETWORK_REQUEST_FAILED` | 6 | 未取得完整 HTTP 响应；旧版丢弃了底层错误码 |
| `NETWORK_HTTP_ERROR` | 2 | 网站已响应，但 HTTP 状态不是成功 |
| `NETWORK_DNS_FAILED` | 1 | 本机无法解析域名 |
| `NETWORK_ADDRESS_FORBIDDEN` | 2 | DNS 答案含私网、保留或过渡地址，触发公网地址限制 |

审计不保存 URL 或参数，因此不能逐条还原历史请求。修复前在同一台机器做独立复现时，`worldtimeapi.org` 在 TLS 建立前返回 `ECONNRESET`，使用本机代理的 `curl` 也失败；`timeanddate.com` 返回 403；`date.jsontest.com` 无法解析；部分域名的 DNS 答案混入 `2001::/32` 过渡地址，被拒绝。安装验证时，DuckDuckGo 搜索域名也出现了这类异常答案。`timeapi.io`、示例网页与 Yahoo 接口在独立复现时成功，说明不能把所有失败都归因于 Bridge 或宣称这些网站一直不可用。

新增公共 HTTPS DNS 回退后，同机实测 Coinbase 时间接口恢复 HTTP 200，DuckDuckGo 搜索返回真实结果。仍然无法保证外站的可用性或访问策略。

## 修复后的调用方法

```json
{"name":"system_status","arguments":{}}
```

时间字段示例（不是实时结果）：

```json
{
  "currentTime": "2026-10-22T08:21:10.459Z",
  "localTime": "2026-10-22T16:21:10.459+08:00",
  "localDate": "2026-10-22",
  "timezone": "Asia/Shanghai",
  "utcOffsetMinutes": 480,
  "unixTimeMs": 1792657270459
}
```

这些字段来自同一个本机时刻。格式化考虑对应时区当时的夏令时与非整点偏移，不要求模型手算 Unix 时间戳。该工具在 Node runtime 内完成，不访问网络、执行 shell 或连接原生 Helper，因此可以直接用于“今天”“今晚”“明天”和省略年份的日期。它反映本机时钟；若系统时间被手工设错，需先修正系统时钟。

MCP 初始化指引和工具描述均明确要求先读取本机时间，不再用日历事件、新闻、行情或 uptime 猜日期。短暂网络故障最多重试一次；两个来源失败后说明限制，只有用户明确要求深入调查时才继续排查。这是给 Agent 的指引，不能强制所有宿主和模型遵守。

## 网络诊断

失败结果中的 `error.details` 提供 `hostname`、`phase`、可用时的 `causeCode` 或 `statusCode`、`retryable` 和 `hint`。不返回可能含凭据的底层错误消息，也不暴露所有响应头或 Cookie。

| 结果 | 建议 |
| --- | --- |
| `NETWORK_DNS_FAILED` / `ENOTFOUND` | 核对域名和本机 DNS，避免猜测不存在的接口 |
| `NETWORK_ADDRESS_FORBIDDEN` | 查看 `forbiddenAddresses` 和 `publicDnsFallback`，排查 DNS 改写或代理的合成地址；选用的解析器若返回混合公网与非公网答案，仍全部拒绝 |
| `NETWORK_PROXY_ERROR` | 检查本机 HTTP(S) 代理及认证；407 表示代理认证问题 |
| `NETWORK_TLS_FAILED` | 检查证书、域名、系统时间和代理；保留证书校验 |
| `NETWORK_REQUEST_FAILED` / `ECONNRESET` | 连接被重置；检查当前代理/网络，必要时尝试另一个来源 |
| `NETWORK_HTTP_ERROR` / 401、403 | 对方拒绝匿名访问，可能需要认证或有反爬策略；重复同一请求通常无效 |
| `NETWORK_HTTP_ERROR` / 404 | 服务已响应，但路径不存在；核对正式接口路径 |
| `NETWORK_HTTP_ERROR` / 429、5xx | 限流或服务器故障；等待或有限重试 |
| `NETWORK_TIMEOUT` | 排队、DNS、连接、响应和重定向共用总超时；不会无限等待 |

需要区分 DNS 与 HTTP 时，对同一网址调用一次 `network_check`；`http:false` 只解析 DNS，不连接目标网站，解析回退可能使用 HTTPS。HTTP 返回 403 说明服务已作出响应，即使 `http.reachable` 为 false（该字段表示状态是否为 2xx/3xx）。

系统 DNS 失败或答案含非公网地址时，默认尝试一次 [Cloudflare HTTPS DNS](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/) 的 IPv4 查询。解析器固定为 `cloudflare-dns.com`，以 `1.1.1.1` 引导连接，验证 TLS 证书、使用原代理、禁止重定向，不依赖本机 DNS 再解析它自身。该服务只接收目标域名，不接收网页路径、查询参数、搜索内容或本地文件。可在 MCP 环境变量中设 `BRIDGE_DNS_FALLBACK=off` 关闭；不修改 macOS 全局 DNS 配置。

回退答案要重新通过全部公网地址检查，再将已验证 IP 固定到目标连接。私有 IP 字面量、localhost 和本地域名不触发公共解析回退；重定向仍重新验证。解析器不可达、响应异常或仍返回非公网地址时，返回原始错误并附 `publicDnsFallback`，不会采用不安全答案。回退与目标请求共用总超时。

网络请求先验证所有 DNS 答案，在瞬时连接错误时最多尝试三个不同的已验证公网地址。该尝试共用原始总超时，不会对 HTTP 拒绝、证书错误或代理配置错误轮换 IP。一个连接若耗尽总超时，后续地址也不会继续尝试。重定向仍逐跳重新验证 DNS、禁止 HTTPS 降级，代理 CONNECT 仍固定已验证 IP。

`web_fetch` 与 `network_check.http` 增加：

- `fetchedAt`：本机读取完成时刻，ISO UTC。
- `serverDate`：规范化的 HTTP Date，缺失或无效时为 null。它可能过期或来自代理，属于不可信远端数据。
- `dnsSource`：`system` 或 `public-doh`，说明最终使用的 DNS 来源。`network_check` 的 DNS 结果也返回此字段。

外部服务宕机、访问策略和 DNS 环境不能由 Bridge 保证修复。当前日期已不再依赖这些服务。

## 更新与验证

```sh
npm run check
npm test
npm run update:local
```

更新后在 Tinycast 重新连接 macOS Bridge MCP，并重新打开扩展。已运行的 MCP 进程会继续使用旧模块，只有新连接能获得新的工具描述与初始化指引。Helper 无需重装。

自动回归覆盖 UTC 跨日、夏令时回拨、非整点时区、无 Helper 的真实 MCP 调用、错误诊断与凭据隐藏、多个公网 IP 的有限尝试及总超时、HTTPS DNS 回退与禁用、恶意回退答案和重定向校验，并保留公网地址和代理的既有安全测试。

本次修复验证：69 项回归全部通过，TypeScript 检查、MCP runtime 和五个扩展命令构建通过。更新后的已安装 MCP 在未传入代理环境变量时，取时、网页读取、HTTP 检查及搜索通过；Coinbase 使用 `public-doh` 返回 200。用户配置与原生 Helper 哈希保持一致，安装文件与构建产物一致。原始本机证据保存在不公开的 `docs/evidence/network-fix-installed.json` 与 `network-fix-tests.tap`。
