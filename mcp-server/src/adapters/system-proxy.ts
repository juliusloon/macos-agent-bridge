import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

export interface SystemProxyConfig {
  http?: string;
  https?: string;
  exceptions: string[];
  unsupported?: 'pac' | 'socks';
}
export type SystemProxyProvider = () => Promise<SystemProxyConfig>;

/** Parse only top-level SystemConfiguration proxy keys; never execute PAC or infer credentials. */
export function parseSystemProxy(output: string): SystemProxyConfig {
  const values = new Map<string, string>(); const exceptions: string[] = [];
  let depth = 0; let inExceptions = false;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '}') { if (depth === 2) inExceptions = false; depth = Math.max(0, depth - 1); continue; }
    if (depth === 1) {
      const match = trimmed.match(/^([A-Za-z][\w]*)\s*:\s*(.*)$/);
      if (match) {
        if (match[1] === 'ExceptionsList' && match[2].startsWith('<array>')) inExceptions = true;
        else if (!match[2].endsWith('{')) values.set(match[1], match[2]);
      }
    } else if (depth === 2 && inExceptions) {
      const entry = trimmed.match(/^\d+\s*:\s*(.+)$/)?.[1]; if (entry) exceptions.push(entry);
    }
    if (trimmed.endsWith('{')) depth++;
  }
  if (values.get('ExcludeSimpleHostnames') === '1') exceptions.push('<local>');
  const endpoint = (kind: 'HTTP' | 'HTTPS'): string | undefined => {
    if (values.get(`${kind}Enable`) !== '1') return;
    const host = values.get(`${kind}Proxy`) || ''; const port = Number(values.get(`${kind}Port`));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const unwrapped = host.replace(/^\[|\]$/g, '');
    if (!isIP(unwrapped) && !/^[A-Za-z0-9._-]+$/.test(unwrapped)) return;
    try { return new URL(`http://${isIP(unwrapped) === 6 ? `[${unwrapped}]` : unwrapped}:${port}`).href; } catch { return; }
  };
  const http = endpoint('HTTP'); const https = endpoint('HTTPS');
  const unsupported = !http && !https ? values.get('ProxyAutoConfigEnable') === '1' || values.get('ProxyAutoDiscoveryEnable') === '1' ? 'pac' : values.get('SOCKSEnable') === '1' ? 'socks' : undefined : undefined;
  return { ...(http ? { http } : {}), ...(https ? { https } : {}), exceptions, ...(unsupported ? { unsupported } : {}) };
}

interface ReaderOptions { platform?: string; read?: () => Promise<string>; now?: () => number; ttlMs?: number }
/** Read-only fixed command, short timeout, shared in-flight request and bounded cache lifetime. */
export function createSystemProxyReader(options: ReaderOptions = {}): SystemProxyProvider {
  const platform = options.platform || process.platform; const now = options.now || Date.now; const ttlMs = options.ttlMs ?? 30000;
  const read = options.read || (async () => (await promisify(execFile)('/usr/sbin/scutil', ['--proxy'], { timeout: 1500, maxBuffer: 65536, encoding: 'utf8' })).stdout);
  let cached: SystemProxyConfig | undefined; let expires = 0; let pending: Promise<SystemProxyConfig> | undefined;
  return async () => {
    if (platform !== 'darwin') return { exceptions: [] };
    if (cached && now() < expires) return cached;
    if (pending) return pending;
    pending = read().then(parseSystemProxy).catch((): SystemProxyConfig => ({ exceptions: [] })).then(value => { cached = value; expires = now() + ttlMs; return value; }).finally(() => { pending = undefined; });
    return pending;
  };
}
export const getSystemProxy = createSystemProxyReader();
