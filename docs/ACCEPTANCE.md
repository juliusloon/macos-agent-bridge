# 验证范围

公开版本把自动化验证与需要本机授权的原生验收分开记录。63 表示工具定义数量，不代表 63 项工具均已完成真实读写验收。逐项状态见 [能力覆盖矩阵](CAPABILITY_COVERAGE.md)。

## 可复现检查

```sh
npm ci
npm run check
npm test
npm run build
BRIDGE_SIGN_IDENTITY=- npm run build:native
npm run build:extension
npm run package:release
npm run verify:package
```

自动化测试使用临时目录与模拟原生 IPC，覆盖参数和输出校验、文件范围与符号链接、精确参数审批、自动批准普通写入、高风险确认、来源绑定、拒绝和过期、并发与幂等、不确定结果、网页访问限制，以及 MCP 与 CLI 的跨进程流程。

安装包检查使用隔离状态完成协议握手、工具发现、5 个扩展命令检查、安装器语法、Helper 签名验证、路径迁移与待确认结果检查。检查不批准真实请求，也不读取个人日历、联系人或剪贴板。

## 需要独立验收的范围

- Calendar / Reminders 的创建、修改和删除，以及重复事件、跨时区、账户提供方差异。
- Contacts 的系统授权及 limited access；Notes、Mail、Safari、Music 的 Automation 授权及应用差异。
- Accessibility 的选区与窗口操作；Screen Recording 的截图及窗口信息。
- 不同 Tinycast / Raycast 版本与模型的 AI 工具调用行为。
- Developer ID 签名、公证、Gatekeeper 和商店发行流程。

`npm run smoke` 是可选的已安装服务检查，会访问本机诊断及已授权接口。其输出保存在忽略的 `docs/evidence/`，可能含本机路径和权限状态，不能直接上传。公开仓库仅保留验证范围、测试源代码和脱敏的能力状态摘要。

## 发行性质

v0.2.0 是开发阶段的公开发行。预构建包仅提供 Apple Silicon，Helper 使用 ad-hoc 签名，未完成 Developer ID 公证。源码安装可重新构建；签名验证通过不等同于跨机器的 Gatekeeper 验收。Intel 构建和所有原生应用写入尚未完成全面验收。
