import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { BridgeError, type Params } from '../types.js';
import { getSystemProxy, type SystemProxyProvider } from './system-proxy.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'MacOSAgentBridge/0.2 (+public-web-reader)';
const TRANSIENT_CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EPIPE']);
interface Address { address: string; family: number }
type DnsSource = 'system' | 'public-doh';
interface Resolution { addresses: Address[]; dnsSource: DnsSource }
interface Response { statusCode: number; headers: Record<string, string | undefined>; body: Buffer }
interface RequestOptions { url: URL; address: Address; method: 'GET' | 'HEAD'; signal: AbortSignal; headers: Record<string, string> }
export interface NetworkDependencies {
  resolve?: (hostname: string) => Promise<Address[]>;
  transport?: (options: RequestOptions) => Promise<Response>;
  environment?: Record<string, string | undefined>;
  systemProxy?: SystemProxyProvider;
  publicResolve?: (hostname: string, signal: AbortSignal) => Promise<Address[]>;
}

/** Only routable public addresses are accepted, including addresses returned by DNS. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 0 && (c === 0 || c === 2) || b === 168 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6 || address.includes('.')) return false;
  const [left, right = ''] = address.toLowerCase().split('::');
  const first = left ? left.split(':') : []; const last = right ? right.split(':') : [];
  const parts = [...first, ...Array(8 - first.length - last.length).fill('0'), ...last].map(x => parseInt(x, 16));
  // Reject local, multicast, translation, documentation and transition ranges.
  return parts[0] >= 0x2000 && parts[0] <= 0x3fff &&
    !(parts[0] === 0x2001 && (parts[1] <= 0x01ff || parts[1] === 0x0db8)) && parts[0] !== 0x2002 &&
    !(parts[0] === 0x3fff && parts[1] <= 0x0fff);
}

function parseUrl(raw: unknown): URL {
  let url: URL;
  try { url = new URL(String(raw)); } catch { throw new BridgeError('INVALID_URL', 'Provide an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BridgeError('URL_SCHEME_FORBIDDEN', 'Only HTTP(S) URLs without embedded credentials are accepted.');
  if (url.port && !['80', '443'].includes(url.port)) throw new BridgeError('NETWORK_PORT_FORBIDDEN', 'Public web tools allow ports 80 and 443 only.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) throw new BridgeError('NETWORK_ADDRESS_FORBIDDEN', 'Local-network destinations are not allowed.');
  url.hash = ''; return url;
}
function abortError(): BridgeError {
  return new BridgeError('NETWORK_TIMEOUT', 'Network request exceeded its total timeout.', {
    phase: 'request', retryable: true, hint: 'The total deadline includes queueing, DNS, connections and redirects. Retry once or use network_check; do not keep changing URLs to obtain the current date, use system_status.',
  });
}
function connectionFailure(error: unknown, hostname: string, phase: 'dns' | 'connect' | 'proxy'): BridgeError {
  if (error instanceof BridgeError) return error;
  // Keep only a machine error code, never raw messages that may contain proxy credentials or query strings.
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const causeCode = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode) ? rawCode : undefined;
  const tls = phase !== 'dns' && /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_|SELF_SIGNED_|UNABLE_TO_)/.test(causeCode || '');
  const retryable = phase === 'dns' ? causeCode === 'EAI_AGAIN' : TRANSIENT_CONNECTION_CODES.has(causeCode || '');
  const hint = phase === 'dns' ? 'Verify the hostname and local DNS configuration. ENOTFOUND is a DNS failure, not an HTTP error. Use system_status for the current date.'
    : tls ? 'TLS certificate or protocol validation failed. Check the destination and proxy configuration; do not disable certificate verification.'
    : phase === 'proxy' ? 'The configured proxy could not establish a tunnel. Check the local HTTP(S) proxy and its authentication, then retry once.'
    : 'The connection failed before a complete HTTP response. Use network_check for this host; check the proxy/network or try one alternative source. Use system_status for the current date.';
  const code = phase === 'dns' ? 'NETWORK_DNS_FAILED' : phase === 'proxy' ? 'NETWORK_PROXY_ERROR' : tls ? 'NETWORK_TLS_FAILED' : 'NETWORK_REQUEST_FAILED';
  return new BridgeError(code, `${phase === 'dns' ? 'DNS resolution' : phase === 'proxy' ? 'Proxy connection' : 'Connection'} failed for ${hostname}${causeCode ? ` (${causeCode})` : ''}.`, {
    hostname, phase: tls ? 'tls' : phase, ...(causeCode ? { causeCode } : {}), retryable, hint,
  });
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortError()); signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function bypassProxy(url: URL, bypass: string): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return bypass.split(',').some(value => {
    const entry = value.trim().toLowerCase(); if (!entry) return false; if (entry === '*') return true;
    if (entry === '<local>') return !hostname.includes('.') && !hostname.includes(':');
    const pattern = entry.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!pattern || pattern[2] && pattern[2] !== port) return false;
    const host = pattern[1].replace(/^\[|\]$/g, '').replace(/^\*?\./, '');
    if (host.includes('*')) {
      const escaped = host.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return new RegExp(`^${escaped}$`).test(hostname);
    }
    return hostname === host || hostname.endsWith(`.${host}`);
  });
}
export async function selectNetworkProxy(url: URL, environment: Record<string, string | undefined>, systemProxy?: SystemProxyProvider): Promise<URL | undefined> {
  const bypass = environment.NO_PROXY ?? environment.no_proxy;
  if (bypass !== undefined && bypassProxy(url, bypass)) return;
  let raw = url.protocol === 'https:' ? environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy : environment.HTTP_PROXY || environment.http_proxy;
  if (!raw && systemProxy) {
    const system = await systemProxy();
    if (bypass === undefined && bypassProxy(url, system.exceptions.join(','))) return;
    raw = url.protocol === 'https:' ? system.https : system.http;
    if (!raw && system.unsupported) throw new BridgeError('NETWORK_PROXY_UNSUPPORTED', `The system uses ${system.unsupported.toUpperCase()} proxy configuration. Set an HTTP(S) proxy in HTTPS_PROXY or HTTP_PROXY for Bridge.`);
  }
  if (!raw) return;
  let proxy: URL; try { proxy = new URL(raw); } catch { throw new BridgeError('NETWORK_PROXY_INVALID', 'Configured HTTP proxy URL is invalid.'); }
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new BridgeError('NETWORK_PROXY_UNSUPPORTED', 'HTTP_PROXY and HTTPS_PROXY must use an HTTP(S) proxy.');
  return proxy;
}
async function proxyTunnel(proxy: URL, options: RequestOptions): Promise<Socket> {
  const { address, url, signal } = options;
  const authority = `${address.family === 6 ? `[${address.address}]` : address.address}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
  const headers: Record<string, string> = { host: authority };
  if (proxy.username || proxy.password) headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    // Proxy location is trusted local configuration. The remote CONNECT target remains a validated, pinned public IP.
    const request = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({ protocol: proxy.protocol, hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: authority, headers, signal, agent: false });
    request.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new BridgeError('NETWORK_PROXY_ERROR', `Configured proxy returned HTTP ${response.statusCode || 0}.`, { hostname: url.hostname, phase: 'proxy', statusCode: response.statusCode || 0, retryable: false, hint: 'Check proxy authentication and CONNECT support. Changing the destination URL will not fix proxy configuration.' })); return; }
      if (signal.aborted) { socket.destroy(); reject(abortError()); return; }
      if (head.length) socket.unshift(head);
      resolve(socket as Socket);
    });
    request.on('response', response => { response.destroy(); reject(new BridgeError('NETWORK_PROXY_ERROR', 'Configured proxy refused the connection tunnel.', { hostname: url.hostname, phase: 'proxy', retryable: false, hint: 'Check the configured HTTP(S) proxy and CONNECT support.' })); });
    request.on('error', reject); request.end();
  });
}
/** Low-level transport is exported for isolated local-proxy regression tests, never registered as a tool. */
export async function networkTransport(options: RequestOptions, environment: Record<string, string | undefined> = process.env, systemProxy?: SystemProxyProvider): Promise<Response> {
  const proxy = await abortable(selectNetworkProxy(options.url, environment, systemProxy), options.signal);
  let tunnel: Socket | undefined;
  try { tunnel = proxy ? await proxyTunnel(proxy, options) : undefined; }
  catch (error) { if (options.signal.aborted) throw abortError(); throw connectionFailure(error, options.url.hostname, 'proxy'); }
  const { url, address, method, signal, headers } = options;
  let agent: HttpAgent | HttpsAgent | false = false;
  if (tunnel) {
    if (url.protocol === 'https:') {
      const secureAgent = new HttpsAgent();
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      secureAgent.createConnection = () => tlsConnect({ socket: tunnel, host: hostname, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true });
      agent = secureAgent;
    } else { const plainAgent = new HttpAgent(); plainAgent.createConnection = () => tunnel; agent = plainAgent; }
  }
  return new Promise<Response>((resolve, reject) => {
    // Keep original host/SNI and pin the already validated DNS address for the socket.
    const pinnedLookup: LookupFunction = (_host, opts, callback) => {
      if (opts.all) callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, signal, headers, agent, lookup: pinnedLookup }, response => {
      const statusCode = response.statusCode || 0;
      const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]));
      if (method === 'HEAD' || statusCode >= 300 && statusCode < 400) { response.destroy(); resolve({ statusCode, headers: responseHeaders, body: Buffer.alloc(0) }); return; }
      if (Number(response.headers['content-length']) > MAX_BYTES) { response.destroy(); reject(new BridgeError('NETWORK_RESPONSE_TOO_LARGE', 'Response exceeds the 2 MiB limit.')); return; }
      const encoding = response.headers['content-encoding']?.toLowerCase();
      let stream: Readable = response;
      if (encoding && encoding !== 'identity') {
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : undefined;
        if (!decoder) { response.destroy(); reject(new BridgeError('NETWORK_ENCODING_UNSUPPORTED', 'Unsupported content encoding.')); return; }
        stream = response.pipe(decoder); response.on('error', error => decoder.destroy(error));
      }
      let bytes = 0; const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BYTES) { stream.destroy(); response.destroy(); reject(new BridgeError('NETWORK_RESPONSE_TOO_LARGE', 'Decoded response exceeds the 2 MiB limit.')); } else chunks.push(chunk); });
      stream.on('end', () => resolve({ statusCode, headers: responseHeaders, body: Buffer.concat(chunks) }));
      stream.on('error', reject);
      response.on('aborted', () => { stream.destroy(); reject(new BridgeError('NETWORK_DISCONNECTED', 'Server disconnected before the response completed.')); });
    });
    request.on('error', reject); request.end();
  }).finally(() => { if (agent) agent.destroy(); tunnel?.destroy(); });
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] ?? match;
    const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '�';
  });
}
function readable(html: string): string {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/[\t \f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function attribute(tag: string, name: string): string | undefined {
  const found = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return found ? decodeEntities(found[1] ?? found[2] ?? found[3]) : undefined;
}
function publicLink(raw: string | undefined, base: URL): string | undefined {
  if (!raw) return;
  try { const url = new URL(raw, base); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* malformed links are omitted */ }
}
function htmlLinks(html: string, base: URL): { title: string; url: string }[] {
  const links: { title: string; url: string }[] = []; const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const url = publicLink(attribute(match[1], 'href'), base); const title = readable(match[2]).slice(0, 500);
    if (url && title && !seen.has(url)) { links.push({ title, url }); seen.add(url); if (links.length === 30) break; }
  }
  return links;
}
function decodeBody(response: Response): string {
  const charset = response.headers['content-type']?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(response.body); } catch { return response.body.toString('utf8'); }
}
function requireSuccess(response: Response & { url: URL; dnsSource?: DnsSource }): void {
  const statusCode = response.statusCode;
  if (statusCode < 200 || statusCode >= 300) throw new BridgeError('NETWORK_HTTP_ERROR', `Remote server returned HTTP ${statusCode}.`, {
    hostname: response.url.hostname, phase: 'http', statusCode, ...(response.dnsSource ? { dnsSource: response.dnsSource } : {}), retryable: statusCode === 408 || statusCode === 429 || statusCode >= 500,
    hint: [401, 403].includes(statusCode) ? 'The server is reachable but refuses this anonymous request (authentication, access policy or anti-bot protection). Use another accessible source; repeated identical fetches will not help.'
      : statusCode === 404 ? 'The server is reachable but this URL does not exist. Verify the documented endpoint instead of guessing paths.'
      : statusCode === 429 ? 'The server rate-limited this request. Wait before retrying.' : 'Inspect the HTTP status; retry a transient server error once or use another source.',
  });
}
function responseMetadata(response: Response & { dnsSource: DnsSource }) {
  const serverDate = response.headers.date;
  return { fetchedAt: new Date().toISOString(), serverDate: serverDate && Number.isFinite(Date.parse(serverDate)) ? new Date(serverDate).toISOString() : null, dnsSource: response.dnsSource };
}
function validateAddresses(addresses: Address[], hostname: string): Address[] {
  if (!addresses.length) throw new BridgeError('NETWORK_DNS_FAILED', 'DNS returned no addresses.', { hostname, phase: 'dns', retryable: false, hint: 'Check the hostname and DNS configuration.' });
  const forbiddenAddresses = addresses.filter(item => !isPublicAddress(item.address)).map(item => item.address);
  if (forbiddenAddresses.length) throw new BridgeError('NETWORK_ADDRESS_FORBIDDEN', 'Destination resolves to a private, reserved or local-network address.', {
    hostname, phase: 'dns', addresses: addresses.map(item => item.address), forbiddenAddresses, retryable: false,
    hint: 'Check DNS/proxy DNS rewriting (including synthetic, reserved or transition addresses). Mixed public and non-public answers from the selected resolver are rejected; do not bypass the public-address restriction.',
  });
  return addresses;
}

/** Fixed HTTPS resolver bootstrap avoids asking contaminated local DNS for the resolver itself. Never follows redirects. */
export async function publicDnsLookup(hostname: string, signal: AbortSignal, environment: Record<string, string | undefined>, systemProxy?: SystemProxyProvider, transport = networkTransport): Promise<Address[]> {
  const url = new URL('https://cloudflare-dns.com/dns-query'); url.searchParams.set('name', hostname); url.searchParams.set('type', 'A');
  const response = await abortable(transport({ url, address: { address: '1.1.1.1', family: 4 }, method: 'GET', signal, headers: { accept: 'application/dns-json', 'user-agent': USER_AGENT, 'accept-encoding': 'gzip, deflate, br' } }, environment, systemProxy), signal);
  const invalid = () => new BridgeError('NETWORK_DNS_FAILED', 'Public HTTPS DNS lookup failed.', { hostname, phase: 'dns', dnsSource: 'public-doh', retryable: false, hint: 'Check the public DNS resolver connection or set BRIDGE_DNS_FALLBACK=off to use only system DNS.' });
  if (response.statusCode !== 200 || response.body.length > 65536) throw invalid();
  let data: { Status?: number; TC?: boolean; Answer?: { type?: number; data?: string }[] };
  try { data = JSON.parse(response.body.toString('utf8')) as typeof data; } catch { throw invalid(); }
  if (!data || data.Status !== 0 || data.TC === true || !Array.isArray(data.Answer)) throw invalid();
  const answers = data.Answer.filter(item => item && item.type === 1);
  if (answers.some(item => typeof item.data !== 'string' || isIP(item.data) !== 4)) throw invalid();
  return validateAddresses(answers.map(item => ({ address: item.data!, family: 4 })), hostname);
}

/** Injectable only in-process for deterministic tests; no tool argument can override transport or DNS. */
export class NetworkClient {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly resolve: NonNullable<NetworkDependencies['resolve']>;
  private readonly transport: NonNullable<NetworkDependencies['transport']>;
  private readonly environment: Record<string, string | undefined>;
  private readonly publicResolve?: NetworkDependencies['publicResolve'];
  constructor(dependencies: NetworkDependencies = {}) {
    this.resolve = dependencies.resolve || (hostname => lookup(hostname, { all: true, verbatim: true }));
    this.environment = dependencies.environment || process.env;
    const systemProxy = dependencies.systemProxy || (dependencies.environment === undefined ? getSystemProxy : undefined);
    this.transport = dependencies.transport || (options => networkTransport(options, this.environment, systemProxy));
    // Injected DNS stays isolated in tests. Production fallback is disableable without changing global DNS settings.
    this.publicResolve = this.environment.BRIDGE_DNS_FALLBACK === 'off' ? undefined : dependencies.publicResolve || (dependencies.resolve === undefined ? (hostname, signal) => publicDnsLookup(hostname, signal, this.environment, systemProxy) : undefined);
  }
  private async addresses(url: URL, signal: AbortSignal): Promise<Resolution> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const literalFamily = isIP(hostname);
    try {
      const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await abortable(this.resolve(hostname), signal);
      return { addresses: validateAddresses(addresses, hostname), dnsSource: 'system' };
    } catch (error) {
      const localFailure = connectionFailure(error, hostname, 'dns');
      if (signal.aborted || literalFamily || !this.publicResolve || !['NETWORK_DNS_FAILED', 'NETWORK_ADDRESS_FORBIDDEN'].includes(localFailure.code)) throw localFailure;
      try { return { addresses: validateAddresses(await abortable(this.publicResolve(hostname, signal), signal), hostname), dnsSource: 'public-doh' }; }
      catch (fallbackError) {
        if (signal.aborted) throw abortError();
        const failure = connectionFailure(fallbackError, hostname, 'dns');
        throw new BridgeError(localFailure.code, localFailure.message, { ...(localFailure.details as object), publicDnsFallback: { code: failure.code, details: failure.details } });
      }
    }
  }
  private async fetch(raw: string | URL, signal: AbortSignal, method: 'GET' | 'HEAD' = 'GET', headers: Record<string, string> = {}): Promise<Response & { url: URL; dnsSource: DnsSource }> {
    let url = parseUrl(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { addresses, dnsSource } = await this.addresses(url, signal);
      // Try up to three distinct validated addresses on transient connection failures, within the same total deadline.
      const candidates = [...new Map(addresses.map(item => [item.address, item])).values()].sort((a, b) => a.family - b.family).slice(0, 3);
      let response: Response | undefined;
      for (const [index, address] of candidates.entries()) {
        try { response = await abortable(this.transport({ url, address, method, signal, headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.1', 'accept-encoding': 'gzip, deflate, br', ...headers } }), signal); break; }
        catch (error) {
          if (signal.aborted) throw abortError();
          const failure = connectionFailure(error, url.hostname, 'connect');
          const details = failure.details as { phase?: string; causeCode?: string } | undefined;
          if (details?.phase !== 'connect' || !TRANSIENT_CONNECTION_CODES.has(details.causeCode || '') || index === candidates.length - 1) throw failure;
        }
      }
      if (!response) throw new BridgeError('NETWORK_REQUEST_FAILED', 'No destination address available.');
      if (response.body.length > MAX_BYTES) throw new BridgeError('NETWORK_RESPONSE_TOO_LARGE', 'Response exceeds the 2 MiB limit.');
      if (![301, 302, 303, 307, 308].includes(response.statusCode)) return { ...response, url, dnsSource };
      if (!response.headers.location) throw new BridgeError('NETWORK_INVALID_REDIRECT', 'Redirect response has no destination.');
      if (hop === MAX_REDIRECTS) throw new BridgeError('NETWORK_REDIRECT_LIMIT', 'Too many redirects.');
      let next: URL;
      try { next = parseUrl(new URL(response.headers.location, url)); }
      catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('NETWORK_INVALID_REDIRECT', 'Redirect destination is not a valid URL.'); }
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new BridgeError('NETWORK_INSECURE_REDIRECT', 'HTTPS redirects to insecure HTTP are not allowed.');
      // Provider credentials must never follow a redirect to another origin.
      if (next.origin !== url.origin) headers = {};
      url = next;
    }
    throw new BridgeError('NETWORK_REDIRECT_LIMIT', 'Too many redirects.');
  }
  async call(name: string, args: Params): Promise<unknown> {
    if (!['web_fetch', 'web_search', 'network_check'].includes(name)) throw new BridgeError('UNKNOWN_TOOL', 'Unknown network tool.');
    const timeoutMs = Number(args.timeoutMs ?? 15000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new BridgeError('INVALID_ARGUMENTS', 'timeoutMs must be between 1000 and 30000.');
    if (this.waiting.length >= 32) throw new BridgeError('NETWORK_BUSY', 'Too many queued network requests; retry later.');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    let acquired = false; let wake: (() => void) | undefined;
    try {
      if (this.active >= 4) await abortable(new Promise<void>(resolve => { wake = () => { this.active++; acquired = true; resolve(); }; this.waiting.push(wake); }), controller.signal);
      else { this.active++; acquired = true; }
      return await this.execute(name, args, controller.signal);
    } finally {
      clearTimeout(timer);
      if (wake) { const index = this.waiting.indexOf(wake); if (index >= 0) this.waiting.splice(index, 1); }
      if (acquired) { this.active--; this.waiting.shift()?.(); }
    }
  }
  private async execute(name: string, args: Params, signal: AbortSignal): Promise<unknown> {
    if (name === 'network_check') {
      const url = parseUrl(args.url); const started = performance.now(); const { addresses, dnsSource } = await this.addresses(url, signal);
      const dnsMs = Math.round((performance.now() - started) * 100) / 100;
      let http = null;
      if (args.http !== false) {
        const begin = performance.now(); let response = await this.fetch(url, signal, 'HEAD');
        if ([405, 501].includes(response.statusCode)) response = await this.fetch(url, signal, 'GET');
        http = { url: response.url.href, statusCode: response.statusCode, elapsedMs: Math.round((performance.now() - begin) * 100) / 100, reachable: response.statusCode >= 200 && response.statusCode < 400, ...responseMetadata(response) };
      }
      return { hostname: url.hostname, addresses: addresses.map(item => item.address), dnsSource, dnsMs, http };
    }
    if (name === 'web_fetch') {
      const response = await this.fetch(String(args.url), signal); requireSuccess(response);
      const contentType = response.headers['content-type'] || 'text/plain';
      if (!/^(?:text\/[\w.+-]+|application\/(?:[\w.+-]*json|[\w.+-]*xml|xhtml\+xml|javascript))(?:[;\s]|$)/i.test(contentType)) throw new BridgeError('NETWORK_CONTENT_UNSUPPORTED', 'Use a text, HTML, XML or JSON URL; binary downloads are not supported.');
      const raw = decodeBody(response); const html = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
      const content = html ? readable(raw) : raw;
      const maxChars = Number(args.maxChars ?? 20000);
      if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 100000) throw new BridgeError('INVALID_ARGUMENTS', 'maxChars must be between 100 and 100000.');
      return { url: response.url.href, statusCode: response.statusCode, contentType, title: html ? readable(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '').slice(0, 500) : '', content: content.slice(0, maxChars), links: html ? htmlLinks(raw, response.url) : [], bytes: response.body.length, truncated: content.length > maxChars, untrustedContent: true, ...responseMetadata(response) };
    }
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query || query.length > 1000) throw new BridgeError('INVALID_ARGUMENTS', 'Provide a search query of 1–1000 characters.');
    const limit = Number(args.limit ?? 5);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new BridgeError('INVALID_ARGUMENTS', 'limit must be between 1 and 10.');
    const provider = args.provider && args.provider !== 'auto' ? String(args.provider) : this.environment.BRIDGE_BRAVE_API_KEY ? 'brave' : 'duckduckgo';
    if (!['brave', 'duckduckgo'].includes(provider)) throw new BridgeError('INVALID_ARGUMENTS', 'Unsupported search provider.');
    if (provider === 'brave') {
      const key = this.environment.BRIDGE_BRAVE_API_KEY;
      if (!key) throw new BridgeError('SEARCH_KEY_REQUIRED', 'Set BRIDGE_BRAVE_API_KEY in the MCP server environment, or select duckduckgo.');
      const url = new URL('https://api.search.brave.com/res/v1/web/search'); url.searchParams.set('q', query); url.searchParams.set('count', String(limit));
      const response = await this.fetch(url, signal, 'GET', { 'X-Subscription-Token': key }); requireSuccess(response);
      let parsed: { web?: { results?: { title?: unknown; url?: unknown; description?: unknown }[] } };
      try { parsed = JSON.parse(decodeBody(response)) as typeof parsed; } catch { throw new BridgeError('SEARCH_INVALID_RESPONSE', 'Search provider returned invalid JSON.'); }
      if (!parsed || typeof parsed !== 'object' || parsed.web?.results !== undefined && !Array.isArray(parsed.web.results)) throw new BridgeError('SEARCH_INVALID_RESPONSE', 'Search provider returned an unexpected response.');
      const results = (parsed.web?.results || []).flatMap(item => { const url = publicLink(typeof item.url === 'string' ? item.url : undefined, response.url); return url ? [{ title: readable(String(item.title || '')).slice(0, 500), url, snippet: readable(String(item.description || '')).slice(0, 2000) }] : []; }).slice(0, limit);
      return { query, provider, results, untrustedContent: true };
    }
    const url = new URL('https://html.duckduckgo.com/html/'); url.searchParams.set('q', query);
    const response = await this.fetch(url, signal); requireSuccess(response); const html = decodeBody(response);
    const results: { title: string; url: string; snippet: string }[] = [];
    const matches = [...html.matchAll(/<a\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a\s*>/gi)];
    for (let index = 0; index < matches.length && results.length < limit; index++) {
      const match = matches[index]; const href = publicLink(attribute(match[1], 'href'), response.url); if (!href) continue;
      const redirect = new URL(href); const destination = redirect.hostname.endsWith('duckduckgo.com') && redirect.searchParams.has('uddg') ? publicLink(redirect.searchParams.get('uddg') || undefined, response.url) : href;
      if (!destination) continue;
      const fragment = html.slice((match.index || 0) + match[0].length, matches[index + 1]?.index);
      const snippet = fragment.match(/<(?:a|div|span)\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)\s*>/i)?.[1] || '';
      results.push({ title: readable(match[2]).slice(0, 500), url: destination, snippet: readable(snippet).slice(0, 2000) });
    }
    if (!results.length && !/no results found|class=["'][^"']*no-results/i.test(html)) throw new BridgeError('SEARCH_PROVIDER_UNAVAILABLE', 'DuckDuckGo returned a challenge or unsupported response. Retry later, or configure BRIDGE_BRAVE_API_KEY.');
    return { query, provider, results, untrustedContent: true };
  }
}
const client = new NetworkClient();
export function networkAction(name: string, args: Params): Promise<unknown> { return client.call(name, args); }
