import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPreferenceValues } from '@raycast/api';
const exec = promisify(execFile);
export interface Result { status: string; tool: string; version: string; data: unknown; error: null | { code: string; message: string } }
export interface Capability { name: string; description: string; riskLevel: string; adapter: string; requiredPermissions: string[]; enabled: boolean; version: string; inputSchema: unknown }
export interface Approval { id: string; tool: string; args: Record<string, unknown>; source: string; status: string; expiresAt: string }
export interface Config { roots: string[]; disabledTools: string[]; trustedWriteTools: string[]; approvalMode: 'manual' | 'auto-write' }
export interface Overview { capabilities: Capability[]; config: Config; approvals: Approval[] }
export interface Diagnostics { version: string; config: Config; helper: { status?: string; message?: string; bundleId?: string; permissions?: Record<string, unknown> } }
const pendingReads = new Map<string, Promise<unknown>>();
export async function admin<T>(...args: string[]): Promise<T> {
  const { bridgeLauncher } = getPreferenceValues<{ bridgeLauncher: string }>();
  const readOnly = ['overview', 'config', 'approvals', 'activity'].includes(args[0]);
  const key = JSON.stringify([bridgeLauncher, ...args]);
  const existing = readOnly ? pendingReads.get(key) : undefined;
  if (existing) return existing as Promise<T>;
  const request = (async () => {
    try {
      const { stdout } = await exec(bridgeLauncher, args, { timeout: args[0] === 'permissions-request' ? 130000 : 65000, maxBuffer: 4_000_000 });
      try { return JSON.parse(stdout) as T; } catch { throw new Error('Bridge 返回了无法解析的响应，请检查本地服务版本。'); }
    } catch (error) {
      const failure = error as Error & { code?: string; stderr?: string; killed?: boolean };
      if (failure.code === 'ENOENT') throw new Error('未找到 Bridge 启动器，请检查扩展设置中的路径并安装本地服务。');
      if (failure.killed) throw new Error(['approve-execute', 'execute-approved'].includes(args[0]) ? 'Bridge 响应超时。写入可能已执行，请先查询操作状态，保留原幂等键。' : 'Bridge 响应超时，请检查本地服务后重试。');
      throw new Error(failure.stderr?.trim() || failure.message || 'Bridge 调用失败。');
    }
  })();
  if (readOnly) pendingReads.set(key, request);
  try { return await request; } finally { if (readOnly && pendingReads.get(key) === request) pendingReads.delete(key); }
}
export async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await admin<Result>('call', tool, JSON.stringify(args));
  if (result.status !== 'ok') throw new Error(result.error?.message || result.status); return result.data as T;
}
