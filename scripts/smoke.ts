import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
const command = join(homedir(), 'Library/Application Support/MacOSAgentBridge/bridge');
const client = new Client({ name: 'independent-smoke-client', version: '1.0.0' });
const transport = new StdioClientTransport({ command, args: ['--serve'], stderr: 'pipe' });
const results: Record<string, unknown> = {};
try {
  await client.connect(transport); const list = await client.listTools(); results.toolCount = list.tools.length;
  for (const [name, args] of [
    ['bridge_diagnostics', {}], ['system_status', {}], ['system_get_frontmost_app', {}], ['system_list_apps', {}], ['system_list_windows', {}],
    ['finder_list_files', { path: join(homedir(), 'Documents/Agent Bridge Workspace') }], ['shortcuts_list', {}], ['calendar_list_calendars', {}],
    ['calendar_list_events', { start: '2080-01-01T00:00:00+08:00', end: '2080-01-01T02:00:00+08:00', timezone: 'Asia/Shanghai' }],
    ['calendar_find_free_slots', { start: '2080-01-01T00:00:00+08:00', end: '2080-01-01T02:00:00+08:00', timezone: 'Asia/Shanghai', durationMinutes: 30 }],
    ['reminders_list_lists', {}], ['reminders_list_tasks', { limit: 1 }],
    ['system_run_command', { command: 'uptime' }], ['system_run_command', { command: 'disk_usage' }], ['system_run_command', { command: 'battery' }]
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    const structured = result.structuredContent as { status: string; data: unknown; error: unknown };
    // Persist status and diagnostics only; avoid saving personal application data.
    results[name] = name === 'bridge_diagnostics' ? structured : { status: structured?.status, error: structured?.error };
    process.stdout.write(`${name}: ${structured?.status}\n`);
  }
  const tool = list.tools.find(t => t.name === 'calendar_list_events'); if (!tool) throw Error('Calendar tool missing');
  results.schema = { calendarInput: tool.inputSchema, calendarOutput: tool.outputSchema };
  const second = new Client({ name: 'independent-comparison-client', version: '1.0.0' });
  try {
    await second.connect(new StdioClientTransport({ command, args: ['--serve'], stderr: 'pipe' }));
    const firstResult = await client.callTool({ name: 'calendar_list_calendars', arguments: {} });
    const secondResult = await second.callTool({ name: 'calendar_list_calendars', arguments: {} });
    results.crossClientCalendarConsistent = JSON.stringify(firstResult.structuredContent) === JSON.stringify(secondResult.structuredContent);
    if (!results.crossClientCalendarConsistent) throw Error('Calendar contract differs between clients');
  } finally { await second.close(); }
} finally { await client.close(); }
await mkdir('docs/evidence', { recursive: true });
await writeFile('docs/evidence/smoke.json', JSON.stringify({ verifiedAt: new Date().toISOString(), ...results }, null, 2));
