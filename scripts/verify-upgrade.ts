import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bridgeVersion } from '../shared/version.js';
import { registry } from '../shared/registry.js';
import type { ToolResult } from '../mcp-server/src/types.js';

const command = join(homedir(), 'Library/Application Support/MacOSAgentBridge/bridge');
const client = new Client({ name: 'upgrade-verification', version: bridgeVersion });
// SDK passes only its safe default environment: this also verifies GUI-style system proxy discovery.
const transport = new StdioClientTransport({ command, args: ['--serve'], env: {}, stderr: 'pipe' });
const evidence: Record<string, unknown> = { verifiedAt: new Date().toISOString(), version: bridgeVersion, proxyEnvironmentPassed: false };
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, bridgeVersion);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, registry.length); evidence.toolCount = tools.length;
  const cases: [string, Record<string, unknown>][] = [
    ['bridge_diagnostics', {}],
    ['system_status', {}],
    ['bridge_get_operation', { tool: 'finder_write_file', idempotencyKey: 'verification-never-executed' }],
    ['web_fetch', { url: 'https://example.com', maxChars: 1000, timeoutMs: 30000 }],
    ['network_check', { url: 'https://example.com', timeoutMs: 30000 }],
    ['web_search', { query: 'Model Context Protocol official documentation', limit: 3, timeoutMs: 30000 }],
  ];
  for (const [name, args] of cases) {
    const started = Date.now();
    const response = await client.callTool({ name, arguments: args });
    const result = response.structuredContent as unknown as ToolResult;
    assert.equal(result.status, 'ok', `${name}: ${JSON.stringify(result.error)}`);
    const data = result.data as Record<string, unknown>;
    evidence[name] = { status: result.status, elapsedMs: Date.now() - started,
      ...(name === 'bridge_diagnostics' ? { approvalMode: (data.config as { approvalMode: string }).approvalMode, version: data.version } : {}),
      ...(name === 'web_fetch' ? { statusCode: data.statusCode, title: data.title, bytes: data.bytes } : {}),
      ...(name === 'network_check' ? { http: data.http } : {}),
      ...(name === 'web_search' ? { provider: data.provider, results: data.results } : {}) };
    if (name === 'web_search') assert.ok((data.results as unknown[]).length > 0, 'Live search must return real results');
    if (name === 'network_check') assert.equal((data.http as { reachable: boolean }).reachable, true);
    process.stdout.write(`${name}: ok (${Date.now() - started} ms)\n`);
  }
} finally { await client.close(); }
await mkdir('docs/evidence', { recursive: true });
await writeFile('docs/evidence/upgrade-0.2.0.json', JSON.stringify(evidence, null, 2) + '\n');
