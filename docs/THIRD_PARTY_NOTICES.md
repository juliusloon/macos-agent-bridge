# 第三方组件

离线开发包包含官方 Node.js 22 运行时；打包脚本固定版本并核对官方 SHA-256。安装包内的 `docs/licenses/Node-LICENSE.txt` 来自同一 Node 分发物，包含 Node 及其内含组件的许可证。源码仓库同时保留 Node 许可证供查阅。

MCP 服务使用 `@modelcontextprotocol/sdk`（MIT）与 `ajv`（MIT），及其生产依赖。生产安装由根 `package-lock.json` 派生的独立锁文件约束；每项依赖的许可证随安装包 `Runtime/node_modules` 原样保留。

扩展开发使用 Raycast 公开 SDK 和 React；构建产物通过宿主的 React / Raycast API 运行。项目没有复制 Tinycast 源码，也不修改 Tinycast.app。扩展图标与 README 静态示意图为本项目资源。
