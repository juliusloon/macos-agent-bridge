const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8'));
const dependencies = Object.fromEntries(Object.keys(source.dependencies).map(name => {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry?.version) throw new Error(`Missing locked dependency: ${name}`);
  return [name, entry.version];
}));
const manifest = { name: 'macos-agent-bridge-runtime', version: source.version, private: true, type: 'module', dependencies, engines: source.engines };
lock.name = manifest.name;
lock.version = manifest.version;
lock.packages[''] = { name: manifest.name, version: manifest.version, dependencies, engines: manifest.engines };
for (const [name, entry] of Object.entries(lock.packages)) {
  if (name && (!name.startsWith('node_modules/') || entry.link || entry.dev)) delete lock.packages[name];
}
const destination = process.argv[2];
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(destination, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
