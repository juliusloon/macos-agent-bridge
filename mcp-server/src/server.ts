import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registry } from '../../shared/registry.js';
import { Engine } from './engine.js';
import { getConfig, stateDir, initState } from './state.js';
import { watch } from 'node:fs';
import { bridgeVersion } from '../../shared/version.js';
import agentGuidance from '../../shared/agent-instructions.json' with { type: 'json' };
const server = new Server({ name: 'macos-agent-bridge', version: bridgeVersion }, { capabilities: { tools: { listChanged: true } }, instructions: agentGuidance.instructions });
let engine: Engine | undefined;
let initialized = false;
let listSignature = '';
let changeTimer: NodeJS.Timeout | undefined;
server.oninitialized = () => { initialized = true; };
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const config = await getConfig();
  listSignature = [...config.disabledTools].sort().join('\n');
  return { tools: registry.filter(t => !config.disabledTools.includes(t.name)).map(t => ({ name: t.name, description: `${t.description} [v${t.version}; permissions: ${t.requiredPermissions.join(', ') || 'none'}]`, inputSchema: t.inputSchema as { type: 'object' }, outputSchema: t.outputSchema as { type: 'object' }, annotations: { readOnlyHint: t.riskLevel === 'read', destructiveHint: t.riskLevel === 'high', idempotentHint: true, openWorldHint: !['finder', 'utility', 'bridge'].includes(t.adapter) } })) };
});
server.setRequestHandler(CallToolRequestSchema, async request => {
  const client = server.getClientVersion()?.name?.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 80) || 'unknown';
  engine ??= new Engine(`mcp:${client}`);
  const result = await engine.call(request.params.name, request.params.arguments || {});
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.status === 'error' };
});
await initState();
// Watch the directory because state.json is atomically replaced on changes.
const watcher = watch(stateDir, { persistent: false }, (_event, filename) => {
  if (String(filename) !== 'state.json' || !initialized) return;
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    void getConfig().then(async config => {
      const next = [...config.disabledTools].sort().join('\n');
      if (next !== listSignature) { listSignature = next; await server.sendToolListChanged(); }
    }).catch(() => { /* tools/list still reports current state on reconnect. */ });
  }, 100);
  changeTimer.unref();
});
watcher.on('error', () => watcher.close());
server.onclose = () => { watcher.close(); if (changeTimer) clearTimeout(changeTimer); };
await server.connect(new StdioServerTransport());
