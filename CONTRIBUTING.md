# 参与贡献

欢迎提交错误报告、文档修正和经过验证的能力改进。提交前请阅读 [架构](docs/ARCHITECTURE.md)、[权限与数据](docs/SECURITY.md) 和 [验证范围](docs/ACCEPTANCE.md)。

```sh
npm ci
npm run check
npm test
npm run build
npm run build:extension
```

原生改动还需要 `BRIDGE_SIGN_IDENTITY=- npm run build:native`。新增能力须同步 Registry、Schema、权限、风险等级、针对性测试与覆盖矩阵；不要把工具定义数量当作真实应用验收数量。

请用临时目录和模拟数据验证写入。日志、生成的 MCP 配置、个人状态目录、原始验收记录和签名证书不应进入提交。涉及漏洞请使用 [私密报告](SECURITY.md)。
