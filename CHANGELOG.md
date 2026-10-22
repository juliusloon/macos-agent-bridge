# 更新日志

## 0.3.0 — 2026-10-22

- `system_status` 在 MCP runtime 直接返回本机当前日期时间、IANA 时区、UTC 偏移和毫秒时间戳，无需联网或 Helper。
- Agent 指引要求先用本机时钟处理相对日期，限制网络失败后的重复尝试，禁止使用行情、事件或 uptime 推断当前时间。
- 联网错误保留 DNS、连接、代理、TLS、HTTP 阶段、底层错误码及处理建议；瞬时连接错误在同一总超时内最多尝试三个不同的已验证公网 IP。
- 系统 DNS 失败或答案含非公网地址时，回退到固定 IP 引导、证书校验的 Cloudflare HTTPS DNS；重新校验所有答案并固定公网 IP，可用 `BRIDGE_DNS_FALLBACK=off` 关闭。
- `web_fetch` 和 `network_check` 的 HTTP 结果增加本机获取时间与规范化的服务器 Date；继续保持公网地址、TLS 验证及响应大小限制。

## 0.2.0 — 2026-10-21

首次公开发行 macOS Agent Bridge。

- 63 个结构化 MCP 工具定义，5 个 Tinycast / Raycast 扩展命令。
- 独立 Swift Helper 与 Node.js stdio 服务，原生能力共用执行与审批策略。
- 可配置普通写入自动批准；高风险操作逐次确认；来源绑定、幂等收据和不确定结果保护。
- 公网搜索、网页文本读取、DNS / HTTP 诊断与系统代理支持。
- 中文与英文 README、脱敏公开文档、隔离安装包验证。
- 干净构建的 Apple Silicon 开发包及 SHA-256 校验文件。

预构建 Helper 为 ad-hoc 签名，未完成 Developer ID 公证；原生应用的完整读写验收仍在进行。详见 [覆盖矩阵](docs/CAPABILITY_COVERAGE.md)。
