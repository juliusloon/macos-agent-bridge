# 权限、确认和本地数据

工具提供三层控制：macOS TCC；Bridge 能力开关与文件授权目录；具体动作审批。TCC 的允许按钮由用户确认，不修改TCC数据库，不绕过系统授权。

- 所有写入默认要求审批。用户可在扩展内开启 auto-write，或明确允许某一中风险工具免逐次确认。已拒绝的请求不因模式切换而复活。
- 删除、邮件发送、联系人修改、关闭标签页、运行Shortcut等高风险工具始终单次确认；可信工具列表不能覆盖该规则。
- Agent只能发起请求。MCP不暴露批准、修改策略或请求TCC权限的方法。
- 审批绑定工具名、参数规范化摘要、来源客户端和幂等键，有效期10分钟。确认界面展示完整参数；批准并执行走相同Engine。
- Agent重试必须保持相同`_idempotencyKey`。结果成功保存后重复调用返回同一结果；并发请求不会重复执行。超时/断线可能存在实际副作用，保留`indeterminate`收据并返回`ACTION_INDETERMINATE`，不能自动重做。
- 如果相同幂等键换参数，返回`IDEMPOTENCY_CONFLICT`。结果正文保存24小时，之后保留摘要墓碑，返回`IDEMPOTENCY_RESULT_EXPIRED`而不重复写入。

## 文件与执行范围

文件路径必须绝对且在用户授权目录内；比较规范化真实路径，拒绝`..`和符号链接逃逸。创建检查真实父目录；不覆盖已有目标。读取限制1MiB；搜索最多10000项。复制/移动/重命名仅支持普通文件。移动采用独占创建再移除源文件，跨卷或权限异常可能需要人工检查两个位置；不是文件系统沙盒，不能防御同用户恶意进程并发替换路径。

默认根目录是安装器创建的空白 `~/Documents/Agent Bridge Workspace`。不默认授予整个Home或磁盘。系统`open_url`只接受无嵌入凭据的HTTP(S)；不接受自定义执行scheme。

命令使用`execFile`或Foundation `Process`的argv；静态JXA从JSON参数取值。没有动态脚本拼接、eval或通用shell入口。Shortcuts本身可有强副作用，因此始终人工审批。

## 本地保存

`~/Library/Application Support/MacOSAgentBridge/` 使用0700；状态、日志和socket使用0600。Socket校验同用户peer uid。该隔离保护其他本机用户，不把同用户恶意软件隔离成沙盒；具有该账号文件读写权的程序仍可篡改本地策略。

- `state.json`：能力配置、有效期内待批准的具体参数、幂等摘要和短期结果。已消费审批移除参数；过期审批在下一次状态访问时移除。
- `audit.jsonl`：时间、来源、工具、状态、错误码和耗时；不记录正文、参数、token或原生返回内容。5MB轮换一次。
- `runtime/`：独立Node运行时、生产依赖和编译产物。
- `helper.sock` / `helper.lock`：本机IPC和单实例锁。

不要将上述状态目录整体上传到issue或共享仓库。诊断文件仍可能包含本机路径、权限状态等隐私；`docs/evidence/`、生成的 MCP 配置、备份及本地工作记录均不随公开仓库发行。

读取结果中的网页、邮件和Notes内容属于不可信数据，不能当成新的Agent指令。Tinycast的Ask Each Chat控制服务级调用，本工程逐动作审批控制具体写入，两者分别生效。

## 发行

公开开发包的 Helper 使用 ad-hoc 签名，不携带维护者的个人开发证书，未完成 Developer ID 公证。Gatekeeper 可能阻止下载的二进制；源码安装会在用户机器上重新构建。正式可信分发仍需 Developer ID Application 签名、公证与 Gatekeeper 验证。`codesign` 校验通过仅证明签名完整性。不要关闭 Gatekeeper。

## 公网访问

`web_search`、`web_fetch`、`network_check` 的公网地址、DNS 固定、重定向和响应边界见 [0.2.0 更新说明](OPTIMIZATION-0.2.0.md)。请求不带浏览器 Cookie；Brave 密钥仅从进程环境读取，跨域重定向不转发凭据。新收据绑定来源；升级前没有 source 字段的旧收据继续兼容原幂等结果。

2026-10-22 起，系统 DNS 失败或答案含非公网地址时，默认回退到 Cloudflare HTTPS DNS 的 IPv4 查询，仅发送目标域名。解析器固定 IP 引导，验证 TLS、禁止重定向；所有回退答案重新验证公网属性并固定到连接，私有地址字面量和本地域名不回退。不会修改全局 DNS；`BRIDGE_DNS_FALLBACK=off` 可关闭。失败细节和数据边界见[日期与联网故障排查](NETWORK-TROUBLESHOOTING.md)。
