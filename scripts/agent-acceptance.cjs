// Runs the independent local Agent acceptance requested by the project specification.
// It uses the user's existing CLI settings, makes read-only calls and changes no global config.
const { spawn } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const launcher = path.join(os.homedir(), 'Library/Application Support/MacOSAgentBridge/bridge');
fs.mkdirSync('docs/evidence', { recursive: true });
const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--output-last-message', 'docs/evidence/agent-result.txt', '-c', `mcp_servers.macos_agent_bridge.command=${JSON.stringify(launcher)}`, '-c', 'mcp_servers.macos_agent_bridge.args=["--serve"]', '这是本地 macOS Agent Bridge 的只读验收。请只使用 macos_agent_bridge MCP 工具，不调用 shell、不使用其他 MCP。通过工具发现，读取系统运行时间和系统时区，发现可用日历接口并调用 calendar_list_calendars。不要请求权限、不要读日程内容、不要修改任何数据。用简体中文报告工具实际返回的结果；权限缺失必须明确说明，不能声称已成功读取日历。'];
const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
const log = fs.createWriteStream('docs/evidence/agent-acceptance.jsonl', { mode: 0o600 });
child.stdout.on('data', d => { log.write(d); process.stdout.write(d); }); child.stderr.on('data', d => process.stderr.write(d));
child.on('exit', code => { log.end(); process.exitCode = code ?? 1; });
