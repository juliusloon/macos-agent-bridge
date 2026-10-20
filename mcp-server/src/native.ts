import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { stateDir } from './state.js';
import { BridgeError, type Params } from './types.js';

const exec = promisify(execFile);
const appPath = process.env.BRIDGE_HELPER_APP || join(homedir(), 'Applications/MacOS Agent Bridge Helper.app');
let starting: Promise<void> | undefined;
const unavailable = (error: unknown) => ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '');

async function startHelper(): Promise<void> {
  if (!existsSync(appPath)) throw new BridgeError('HELPER_MISSING', 'Run npm run install:local to install the native helper.');
  const deadline = Date.now() + 8000;
  await exec('/usr/bin/open', ['-g', appPath], { timeout: 8000 });
  while (Date.now() < deadline) {
    try { await send('diagnostics', {}, Math.max(1, deadline - Date.now())); return; }
    catch (error) {
      if ((error as BridgeError).code === 'NATIVE_TIMEOUT') break;
      if (!unavailable(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new BridgeError('HELPER_START_FAILED', 'Helper did not create its local IPC socket.');
}

export async function nativeCall(tool: string, args: Params = {}, start = true): Promise<unknown> {
  try { return await send(tool, args); }
  catch (error) {
    // Only retry failures before dispatch; disconnected writes may have executed.
    if (!start || !unavailable(error)) throw error;
    starting ??= startHelper().finally(() => { starting = undefined; });
    await starting;
    return send(tool, args);
  }
}

function send(tool: string, args: Params, timeoutMs = tool === 'permissions_request' ? 120000 : 45000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(stateDir, 'helper.sock'));
    const decoder = new StringDecoder('utf8');
    let buffer = ''; let bytes = 0; let settled = false; let dispatched = false;
    const finish = (error?: unknown, data?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(data);
    };
    // Absolute deadline also bounds a helper that trickles partial output.
    const timer = setTimeout(() => finish(new BridgeError('NATIVE_TIMEOUT', 'Native operation timed out; inspect before retrying a write.')), timeoutMs);
    timer.unref();
    socket.on('error', error => finish(dispatched ? new BridgeError('NATIVE_DISCONNECTED', 'Helper connection failed after dispatch; inspect before retrying a write.') : error));
    socket.on('connect', () => { dispatched = true; socket.write(JSON.stringify({ tool, args }) + '\n'); });
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4_000_000) return finish(new BridgeError('NATIVE_DISCONNECTED', 'Native response exceeded 4 MB; the operation outcome is uncertain.'));
      buffer += decoder.write(chunk);
      const end = buffer.indexOf('\n'); if (end < 0) return;
      try {
        const result: unknown = JSON.parse(buffer.slice(0, end));
        if (!result || typeof result !== 'object' || !('ok' in result) || typeof result.ok !== 'boolean') throw new Error('Invalid helper envelope');
        const response = result as { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
        if (response.ok) finish(undefined, response.data);
        else finish(new BridgeError(response.error?.code || 'NATIVE_ERROR', response.error?.message || 'Native error'));
      } catch {
        finish(new BridgeError('NATIVE_DISCONNECTED', 'Helper returned an invalid response; the operation outcome is uncertain.'));
      }
    });
    socket.on('close', () => { if (!settled) finish(new BridgeError('NATIVE_DISCONNECTED', 'Helper disconnected without a complete result.')); });
  });
}
