# 后续验证

以下项目保留为公开版本的已知限制，逐工具状态见 [能力覆盖矩阵](CAPABILITY_COVERAGE.md)。

- Calendar / Reminders：真实创建、读取、修改、删除往返；重复事件、跨时区和账户提供方差异。
- Contacts：授权后的查询、创建、修改，以及 limited access 边界。
- Notes / Mail / Safari / Music：各应用 Automation 授权及固定 JXA 的兼容性；邮件发送需明确指定收件人和内容。
- Accessibility / Screen Recording：选区、窗口位置与尺寸、截图和多显示器行为。
- 宿主兼容性：更多 Tinycast / Raycast 版本、Raycast Pro AI Chat、不同工具调用模型。
- 分发：Intel 实机验证、Developer ID 签名、公证及 Gatekeeper 验证。

已有工具定义与编译通过不能代替以上实机验收。这个项目不承诺覆盖 Raycast 私有数据库或全部内置能力。
