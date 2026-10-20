const fs = require('node:fs'); const path = require('node:path');
const { instructions } = require('../shared/agent-instructions.json');
const launcher = process.argv[2]; if (!path.isAbsolute(launcher)) throw Error('Absolute launcher path required');
const manifestPath = 'raycast-extension/dist/package.json'; const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.preferences[0].default = launcher;
manifest.ai = { mcp: { type: 'stdio', command: launcher, args: ['--serve'] }, instructions };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync('docs/mcp-client.json', JSON.stringify({ mcpServers: { 'macos-agent-bridge': { command: launcher, args: ['--serve'] } } }, null, 2) + '\n');
