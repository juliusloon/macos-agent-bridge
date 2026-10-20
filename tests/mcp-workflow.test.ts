import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../mcp-server/src/types.js';
const exec = promisify(execFile);

test('MCP auto-write, status lookup, live capability updates and network policy work end to end', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'bridge-workflow-')));
  const state = join(temp, 'state'); const root = join(temp, 'root'); await mkdir(state); await mkdir(root);
  await writeFile(join(state, 'state.json'), JSON.stringify({ config: { version: 1, roots: [root], disabledTools: [], trustedWriteTools: [], approvalMode: 'auto-write' }, approvals: [], receipts: {} }));
  const client = new Client({ name: 'workflow-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('mcp-server/src/server.ts')], env: { BRIDGE_STATE_DIR: state }, stderr: 'pipe' });
  let timer: NodeJS.Timeout | undefined;
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 63);
    for (const name of ['web_fetch', 'web_search', 'network_check', 'bridge_get_operation']) assert.ok(tools.some(tool => tool.name === name));
    const args = { path: join(root, 'one-operation'), _idempotencyKey: 'mcp-auto-operation' };
    const calls = await Promise.all([client.callTool({ name: 'finder_create_directory', arguments: args }), client.callTool({ name: 'finder_create_directory', arguments: args })]);
    assert.equal((calls[0].structuredContent as unknown as ToolResult).status, 'ok');
    assert.deepEqual(calls[0].structuredContent, calls[1].structuredContent);
    assert.deepEqual(await readdir(root), ['one-operation']);
    const status = await client.callTool({ name: 'bridge_get_operation', arguments: { tool: 'finder_create_directory', idempotencyKey: args._idempotencyKey } });
    const operation = status.structuredContent as unknown as ToolResult;
    assert.equal((operation.data as { state: string }).state, 'done');
    assert.deepEqual((operation.data as { result: unknown }).result, calls[0].structuredContent);
    const blocked = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } });
    assert.equal((blocked.structuredContent as unknown as ToolResult).error?.code, 'NETWORK_ADDRESS_FORBIDDEN');
    const changed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Missing tools/list_changed notification')), 5000);
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => { clearTimeout(timer); resolve(); });
    });
    await exec(process.execPath, ['--import', 'tsx', resolve('mcp-server/src/cli.ts'), 'set-enabled', 'web_fetch', 'false'], { env: { ...process.env, BRIDGE_STATE_DIR: state } });
    await changed;
    assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'web_fetch'));
    const disabled = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://example.com' } });
    assert.equal((disabled.structuredContent as unknown as ToolResult).error?.code, 'TOOL_DISABLED');
  } finally { clearTimeout(timer); await client.close(); await rm(temp, { recursive: true, force: true }); }
});
