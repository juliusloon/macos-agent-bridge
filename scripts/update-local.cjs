// Update only the JS runtime and extension. The signed helper and user state stay in place.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const support = path.join(os.homedir(), 'Library/Application Support/MacOSAgentBridge');
const runtime = path.join(support, 'runtime');
const extension = path.join(os.homedir(), 'Library/Application Support/com.tinycast.app/extensions/macos-agent-bridge');
for (const file of ['dist/mcp-server/src/server.js', 'dist/shared/version.js', 'raycast-extension/dist/package.json']) {
  if (!fs.existsSync(path.join(project, file))) throw new Error('Build the runtime and extension before updating: npm run build && npm run build:extension');
}
if (!fs.existsSync(path.join(runtime, 'bin/node'))) throw new Error('No installed runtime found. Run npm run install:local first.');
execFileSync(process.execPath, [path.join(project, 'scripts/configure-package.cjs'), path.join(project, 'raycast-extension/dist'), path.join(support, 'bridge')]);
const version = require('../package.json').version;
const backup = path.join(support, 'backups', `${version}-${Date.now()}-${randomUUID().slice(0, 8)}`);
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
const applied = [];
function replaceDirectory(source, destination, name) {
  const stage = `${destination}.update-${randomUUID()}`;
  const previous = path.join(backup, name);
  fs.cpSync(source, stage, { recursive: true });
  try {
    fs.renameSync(destination, previous);
    try { fs.renameSync(stage, destination); }
    catch (error) { fs.renameSync(previous, destination); throw error; }
    applied.push({ destination, previous });
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
try {
  // Compiled tests/scripts are not installed as runtime code.
  const stagedDist = path.join(backup, 'new-dist');
  fs.mkdirSync(stagedDist);
  for (const item of ['mcp-server', 'shared']) fs.cpSync(path.join(project, 'dist', item), path.join(stagedDist, item), { recursive: true });
  replaceDirectory(stagedDist, path.join(runtime, 'dist'), 'runtime-dist');
  fs.rmSync(stagedDist, { recursive: true, force: true });
  if (fs.existsSync(extension)) replaceDirectory(path.join(project, 'raycast-extension/dist'), extension, 'tinycast-extension');
  const manifestPath = path.join(runtime, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.copyFileSync(manifestPath, path.join(backup, 'runtime-package.json'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ version, runtimeUpdated: true, extensionUpdated: applied.some(item => item.destination === extension), backup, reconnectRequired: true }) + '\n');
} catch (error) {
  for (const { destination, previous } of applied.reverse()) {
    fs.rmSync(destination, { recursive: true, force: true }); fs.renameSync(previous, destination);
  }
  const oldManifest = path.join(backup, 'runtime-package.json');
  if (fs.existsSync(oldManifest)) fs.copyFileSync(oldManifest, path.join(runtime, 'package.json'));
  throw error;
}
