import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import agentGuidance from '../shared/agent-instructions.json' with { type: 'json' };
import packageManifest from '../package.json' with { type: 'json' };
const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'bridge-package-'));
const archive = resolve(process.argv[2] || `release/macos-agent-bridge-macos-${process.arch}.zip`);
try {
  const listing = await exec('/usr/bin/unzip', ['-Z1', archive]);
  assert.ok(!listing.stdout.split('\n').some(name => name.includes('__MACOSX/') || /(?:^|\/)\._/.test(name)), 'Archive contains resource-fork metadata');
  await exec('/usr/bin/ditto', ['-x', '-k', archive, temp]);
  const base = join(temp, 'MacOS Agent Bridge');
  await exec(process.execPath, ['scripts/scan-release.cjs', base]);
  const helper = join(base, 'Native/MacOS Agent Bridge Helper.app');
  await exec('/usr/bin/codesign', ['--verify', '--strict', helper]);
  const signature = await exec('/usr/bin/codesign', ['-d', '--verbose=2', helper]);
  assert.match(signature.stderr, /Signature=adhoc/);
  assert.doesNotMatch(signature.stderr, /^Authority=/m);
  await exec('/bin/bash', ['-n', join(base, 'Install.command')]);
  for (const document of ['README.md', 'README-EN.md', 'LICENSE', 'docs/licenses/Node-LICENSE.txt']) await access(join(base, document));
  const node = join(base, 'Runtime/bin/node');
  const server = join(base, 'Runtime/dist/mcp-server/src/server.js');
  // Every MCP process uses temporary state and an absent helper path. No installed
  // helper or user content is accessed, and no pending approval is executed.
  const env = { BRIDGE_STATE_DIR: join(temp, 'isolated-state'), BRIDGE_HELPER_APP: join(temp, 'absent-helper.app') };
  const client = new Client({ name: 'tinycast', version: 'offline-package-verifier' });
  try {
    await client.connect(new StdioClientTransport({ command: node, args: [server], env, stderr: 'pipe' }));
    assert.equal(client.getServerVersion()?.version, packageManifest.version);
    assert.equal(client.getInstructions(), agentGuidance.instructions);
    assert.equal((await client.listTools()).tools.length, 63);
    const pending = await client.callTool({ name: 'clipboard_write', arguments: { text: 'package approval verification; never executed', _idempotencyKey: 'offline-approval-verification' } });
    assert.equal(pending.isError, false);
    const result = pending.structuredContent as { status: string; data: { reviewUrl: string } };
    assert.equal(result.status, 'confirmation_required');
    assert.equal(result.data.reviewUrl, 'tinycast://extensions/cano/macos-agent-bridge/approvals');
  } finally { await client.close(); }
  const folder = join(base, 'Extension');
  type Manifest = { commands: { name: string }[]; preferences: { default?: string }[]; ai: { mcp?: { command: string }; instructions: string } };
  const manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as Manifest;
  assert.equal(manifest.ai.instructions, agentGuidance.instructions);
  assert.equal(manifest.preferences[0].default, undefined);
  assert.equal(manifest.ai.mcp, undefined);
  assert.equal(manifest.commands.length, 5);
  for (const command of manifest.commands) await access(join(folder, `${command.name}.js`));
  const relocatedLauncher = join(temp, 'example user/Library/Application Support/MacOSAgentBridge/bridge');
  await exec(node, [join(base, 'configure.cjs'), folder, relocatedLauncher]);
  const relocated = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as Manifest;
  assert.equal(relocated.preferences[0].default, relocatedLauncher);
  assert.equal(relocated.ai.mcp?.command, relocatedLauncher);
  assert.equal(relocated.ai.instructions, agentGuidance.instructions);
  const mcp = JSON.parse(await readFile(join(folder, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['macos-agent-bridge'].command, relocatedLauncher);
  process.stdout.write(`Offline ${packageManifest.version} package verified: privacy scan, ad-hoc signature, installer syntax, bundled Node/MCP, 63 tools, 5 commands, path relocation and pending approval. No installed helper or personal data accessed.\n`);
} finally { await rm(temp, { recursive: true, force: true }); }
