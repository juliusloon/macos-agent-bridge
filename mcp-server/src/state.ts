import { appendFile, mkdir, readFile, writeFile, rename, rm, stat, open, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError, type Params, type ToolResult } from './types.js';

export const stateDir = process.env.BRIDGE_STATE_DIR || join(homedir(), 'Library/Application Support/MacOSAgentBridge');
export type ApprovalMode = 'manual' | 'auto-write';
export interface Config { version: 1; roots: string[]; disabledTools: string[]; trustedWriteTools: string[]; approvalMode: ApprovalMode }
export interface Approval { id: string; tool: string; args: Params; digest: string; source: string; createdAt: string; expiresAt: string; status: 'pending' | 'approved' | 'denied' | 'consumed'; idempotencyKey?: string }
export interface Receipt { digest: string; status: 'running' | 'indeterminate' | 'done'; result?: ToolResult; createdAt: string; source?: string; ownerPid?: number }
export interface State { config: Config; approvals: Approval[]; receipts: Record<string, Receipt> }
export const defaults = (): State => ({ config: { version: 1, roots: [join(homedir(), 'Documents/Agent Bridge Workspace')], disabledTools: [], trustedWriteTools: [], approvalMode: 'manual' }, approvals: [], receipts: {} });
let initialized: Promise<void> | undefined;
export function initState(): Promise<void> {
  return initialized ??= (async () => { await mkdir(stateDir, { recursive: true, mode: 0o700 }); await chmod(stateDir, 0o700); })().catch(error => { initialized = undefined; throw error; });
}
export function digest(tool: string, args: Params) {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash('sha256').update(JSON.stringify([tool, canonical(args)])).digest('hex');
}
// Atomic rename makes snapshots consistent without serializing independent read-only calls.
export async function readSnapshot(): Promise<State> {
  try {
    const state = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')) as State;
    const config = state?.config;
    if (!config || config.version !== 1 || !['roots', 'disabledTools', 'trustedWriteTools'].every(key => Array.isArray(config[key as keyof Config]) && (config[key as 'roots'] as unknown[]).every(x => typeof x === 'string')) || !Array.isArray(state.approvals) || !state.receipts || typeof state.receipts !== 'object' || Array.isArray(state.receipts)) throw new Error('Invalid state structure');
    if (config.approvalMode === undefined) config.approvalMode = 'manual';
    if (!['manual', 'auto-write'].includes(config.approvalMode)) throw new Error('Invalid approval mode');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    if ((error as NodeJS.ErrnoException).code && !(error instanceof SyntaxError)) throw error;
    throw new BridgeError('STATE_INVALID', 'Bridge policy state is invalid; restore a valid state file before executing tools.');
  }
}
export function receiptKeyFor(state: State, tool: string, key: string, source: string): string {
  const primary = `${tool}:${key}`;
  const receipt = state.receipts[primary];
  return !receipt?.source || receipt.source === source ? primary : `@source:${digest(source, {})}:${primary}`;
}
async function recoverDeadLock(lock: string): Promise<boolean> {
  // Recovery itself must have one owner. Re-read only after taking this claim:
  // another contender may have replaced the stale lock with a live one meanwhile.
  let claim;
  try { claim = await open(join(stateDir, 'state.recovery.lock'), 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  try {
    let pid: number;
    try { pid = Number(await readFile(lock, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
    await rm(lock, { force: true });
    return true;
  } finally {
    await claim.close();
    // A crash while holding a recovery claim fails closed; never recursively
    // remove another process's claim based on a stale observation.
    await rm(join(stateDir, 'state.recovery.lock'), { force: true });
  }
}
export async function transaction<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
  await initState();
  const lock = join(stateDir, 'state.lock'); const deadline = Date.now() + 8000;
  while (true) {
    try { const handle = await open(lock, 'wx', 0o600); try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); } break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await recoverDeadLock(lock)) continue;
      if (Date.now() > deadline) throw new BridgeError('STATE_BUSY', 'Another bridge process is updating policy; retry with the same arguments and key.');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  let temp: string | undefined;
  try {
    const state = await readSnapshot(); const before = JSON.stringify(state);
    // A denial is a durable tombstone. Its parameters are discarded after review.
    state.approvals = state.approvals.filter(a => a.status === 'denied' || Date.parse(a.expiresAt) > Date.now());
    for (const request of state.approvals) if (request.status === 'denied') { request.idempotencyKey ??= request.args._idempotencyKey as string | undefined; request.args = {}; }
    for (const receipt of Object.values(state.receipts)) if (Date.parse(receipt.createdAt) < Date.now() - 86400000) delete receipt.result;
    const result = await fn(state); const after = JSON.stringify(state);
    if (before !== after) { temp = join(stateDir, `state.${randomUUID()}.tmp`); await writeFile(temp, after, { mode: 0o600 }); await rename(temp, join(stateDir, 'state.json')); temp = undefined; }
    return result;
  } finally { if (temp) await rm(temp, { force: true }).catch(() => undefined); await rm(lock, { force: true }); }
}
export async function getConfig(): Promise<Config> { return (await readSnapshot()).config; }
export async function audit(source: string, tool: string, result: ToolResult, durationMs: number) {
  await transaction(async () => {
    const file = join(stateDir, 'audit.jsonl');
    // Bounded local log; never store args, bodies, token values or returned native content.
    try { if ((await stat(file)).size > 5_000_000) await rename(file, join(stateDir, 'audit.previous.jsonl')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await appendFile(file, JSON.stringify({ at: new Date().toISOString(), source, tool, status: result.status, errorCode: result.error?.code, durationMs }) + '\n', { mode: 0o600 });
  });
}
