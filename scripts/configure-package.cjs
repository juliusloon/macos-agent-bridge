const fs = require('node:fs'); const path = require('node:path');
const folder = process.argv[2], launcher = process.argv[3];
if (!folder || !launcher || !path.isAbsolute(launcher)) throw new Error('Extension directory and absolute launcher path required');
const file = path.join(folder, 'package.json'); const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.preferences.find(p => p.name === 'bridgeLauncher').default = launcher;
manifest.ai = { ...manifest.ai, mcp: { type: 'stdio', command: launcher, args: ['--serve'] } };
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { 'macos-agent-bridge': { command: launcher, args: ['--serve'] } } }, null, 2) + '\n');
