// Scan every byte of the assembled public package, including compiled executables.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(process.argv[2]);
const project = path.resolve(__dirname, '..');
const privatePrefixes = [os.homedir(), project, process.env.TMPDIR].filter(value => value && value !== '/tmp' && value !== '/');
const patterns = [
  { name: 'private path', test: bytes => privatePrefixes.some(prefix => bytes.includes(Buffer.from(prefix))) },
  { name: 'private key', test: bytes => /-----BEGIN ((?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY)-----[\r\n]+[A-Za-z0-9+/=\r\n]{64,}-----END \1-----/.test(bytes.toString('utf8')) },
  { name: 'GitHub credential', test: bytes => /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/.test(bytes.toString('utf8')) },
];
let files = 0;
const failures = [];
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file);
    if (entry.isSymbolicLink()) {
      if (!path.resolve(path.dirname(file), fs.readlinkSync(file)).startsWith(root + path.sep)) failures.push({ file: relative, issue: 'symlink escapes package' });
    } else if (entry.isDirectory()) {
      if (['.git', '__MACOSX', 'evidence', 'backups'].includes(entry.name)) failures.push({ file: relative, issue: 'private or metadata directory' });
      scan(file);
    } else if (entry.isFile()) {
      files++;
      if (['state.json', 'audit.jsonl', '.DS_Store', '.mcp.json', 'mcp-client.json', '.env', '.npmrc'].includes(entry.name) || entry.name.startsWith('._')) failures.push({ file: relative, issue: 'machine state or metadata' });
      const bytes = fs.readFileSync(file);
      for (const pattern of patterns) if (pattern.test(bytes)) failures.push({ file: relative, issue: pattern.name });
    }
  }
}
scan(root);
if (failures.length) {
  // Do not echo matched private values.
  process.stderr.write(JSON.stringify({ status: 'failed', files, failures }, null, 2) + '\n');
  process.exit(1);
}
process.stdout.write(`Release privacy scan passed: ${files} files; no local paths, keys, credentials, state or filesystem metadata found.\n`);
