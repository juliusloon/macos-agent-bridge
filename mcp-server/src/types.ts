export type Params = Record<string, unknown>;
export interface ToolResult { [key: string]: unknown; status: 'ok' | 'error' | 'confirmation_required'; tool: string; version: string; data: unknown; error: null | { code: string; message: string; details?: unknown } }
export class BridgeError extends Error { constructor(public code: string, message: string, public details?: unknown) { super(message); } }
export function failure(tool: string, error: unknown): ToolResult {
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode) ? rawCode : 'EXECUTION_FAILED';
  const e = error instanceof BridgeError ? error : new BridgeError(code, error instanceof Error ? error.message : 'Unknown error');
  return { status: 'error', tool, version: '1.0.0', data: null, error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } };
}
