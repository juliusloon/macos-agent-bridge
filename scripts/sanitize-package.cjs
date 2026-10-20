const fs = require('node:fs');
const path = require('node:path');
const folder = process.argv[2];
const file = path.join(folder, 'package.json');
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const preference of manifest.preferences || []) {
  if (preference.name === 'bridgeLauncher') delete preference.default;
}
if (manifest.ai) delete manifest.ai.mcp;
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
function clean(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, item.name);
    if (item.isDirectory()) clean(name);
    else if (item.name.endsWith('.map') || item.name === '.mcp.json' || item.name === '.DS_Store' || item.name.startsWith('._')) fs.rmSync(name);
  }
}
clean(folder);
