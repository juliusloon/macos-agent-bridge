import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';

const temp = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
process.env.BRIDGE_STATE_DIR = temp;
const { nativeCall } = await import('../mcp-server/src/native.js');
after(async () => { await rm(temp, { recursive: true, force: true }); });

async function helper(reply: (socket: Socket) => void, check: () => Promise<void>) {
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => reply(socket));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(temp, 'helper.sock'), resolve); });
  try { await check(); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('native IPC preserves Chinese and emoji split across byte boundaries', async () => {
  await helper(socket => {
    const result = Buffer.from(JSON.stringify({ ok: true, data: { text: '中文🌿' } }) + '\n');
    const split = result.indexOf(Buffer.from('中')) + 1;
    socket.write(result.subarray(0, split));
    setTimeout(() => socket.end(result.subarray(split)), 10);
  }, async () => { assert.deepEqual(await nativeCall('clipboard_read', {}, false), { text: '中文🌿' }); });
});

test('native IPC disconnect and malformed envelopes report uncertain outcomes', async () => {
  for (const reply of [(socket: Socket) => socket.end(), (socket: Socket) => socket.end('{invalid}\n'), (socket: Socket) => socket.end('{"value":true}\n')]) {
    await helper(reply, async () => { await assert.rejects(nativeCall('clipboard_write', {}, false), { code: 'NATIVE_DISCONNECTED' }); });
  }
});

test('native IPC keeps concrete helper permission failures', async () => {
  await helper(socket => socket.end(JSON.stringify({ ok: false, error: { code: 'PERMISSION_REQUIRED', message: 'Calendar access required' } }) + '\n'), async () => {
    await assert.rejects(nativeCall('calendar_list_calendars', {}, false), { code: 'PERMISSION_REQUIRED', message: 'Calendar access required' });
  });
});
