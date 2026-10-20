import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import AjvModule from 'ajv';
import { approvalGuidance, reviewUrls } from '../shared/approval.js';
import agentGuidance from '../shared/agent-instructions.json' with { type: 'json' };
import type { ToolResult } from '../mcp-server/src/types.js';

const exec = promisify(execFile);
const Ajv = AjvModule.default;

test('review links target installed commands and select the requesting host', async () => {
  const manifest = JSON.parse(await readFile('raycast-extension/package.json', 'utf8')) as {
    author: string; name: string; commands: { name: string; keywords?: string[] }[]; ai: { instructions: string };
  };
  for (const [host, url] of Object.entries(reviewUrls)) {
    const route = new URL(url);
    assert.equal(route.protocol, `${host}:`);
    assert.equal(route.hostname, 'extensions');
    assert.equal(route.pathname, `/${manifest.author}/${manifest.name}/approvals`);
  }
  assert.ok(manifest.commands.find(c => c.name === 'approvals')?.keywords?.includes('审批'));
  assert.equal(manifest.ai.instructions, agentGuidance.instructions);
  assert.equal(approvalGuidance('mcp:tinycast').reviewUrl, reviewUrls.tinycast);
  assert.equal(approvalGuidance('mcp:Tinycast 0.12.1').reviewUrl, reviewUrls.tinycast);
  assert.equal(approvalGuidance('mcp:Raycast AI').reviewUrl, reviewUrls.raycast);
  assert.equal(approvalGuidance('raycast').reviewUrl, reviewUrls.raycast);
  assert.equal(approvalGuidance('mcp:unknown').reviewUrl, reviewUrls.tinycast);
  assert.doesNotMatch(approvalGuidance('mcp:tinycast').action, /Raycast/);
  assert.match(approvalGuidance('mcp:tinycast').action, /immediately executes/);
});

test('Tinycast MCP request → extension CLI review/execute → same-key result, without duplicate writes', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'bridge-approval-flow-')));
  const stateDir = join(temp, 'state'); const root = join(temp, 'authorized');
  await mkdir(stateDir); await mkdir(root);
  await writeFile(join(stateDir, 'state.json'), JSON.stringify({ config: { version: 1, roots: [root], disabledTools: [], trustedWriteTools: [] }, approvals: [], receipts: {} }), { mode: 0o600 });
  const client = new Client({ name: 'tinycast', version: 'approval-regression' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('mcp-server/src/server.ts')], env: { BRIDGE_STATE_DIR: stateDir }, stderr: 'pipe' });
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, ['--import', 'tsx', resolve('mcp-server/src/cli.ts'), ...args], { env: { ...process.env, BRIDGE_STATE_DIR: stateDir } })).stdout) as unknown;
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, '0.2.0');
    assert.equal(client.getInstructions(), agentGuidance.instructions);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 63);
    assert.ok(!tools.some(t => /approve|review|execute-approved/.test(t.name)));
    const tool = tools.find(t => t.name === 'finder_create_directory')!;
    const validate = new Ajv({ strict: false }).compile(tool.outputSchema!);
    const args = { path: join(root, 'confirmed-once'), _idempotencyKey: 'tinycast-approval-regression' };
    const request = async () => {
      const response = await client.callTool({ name: tool.name, arguments: args });
      assert.equal(response.isError, false, 'A pending approval is a normal result, not a tool execution error');
      return response.structuredContent as unknown as ToolResult;
    };
    const pending = await request();
    assert.equal(pending.status, 'confirmation_required');
    assert.ok(validate(pending), JSON.stringify(validate.errors));
    const data = pending.data as { approvalId: string; reviewUrl: string; action: string };
    assert.equal(data.reviewUrl, reviewUrls.tinycast);
    assert.doesNotMatch(data.action, /Open Raycast/);
    assert.equal(((await request()).data as typeof data).approvalId, data.approvalId);
    assert.deepEqual(await readdir(root), []);
    const queued = await cli('approvals') as { id: string; source: string; args: unknown }[];
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, 'mcp:tinycast');
    assert.deepEqual(queued[0].args, args);

    // The same two admin commands used by the extension. All writes stay in this temporary test root.
    await cli('review', data.approvalId, 'approve');
    const executed = await cli('execute-approved', data.approvalId) as ToolResult;
    assert.equal(executed.status, 'ok');
    assert.deepEqual(await readdir(root), ['confirmed-once']);
    assert.deepEqual(await request(), executed);
    assert.deepEqual(await request(), executed);
    assert.deepEqual(await cli('approvals'), []);
    const state = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')) as { config: { trustedWriteTools: string[] }; receipts: Record<string, unknown> };
    assert.deepEqual(state.config.trustedWriteTools, []);
    assert.equal(Object.keys(state.receipts).length, 1);
  } finally { await client.close(); await rm(temp, { recursive: true, force: true }); }
});
