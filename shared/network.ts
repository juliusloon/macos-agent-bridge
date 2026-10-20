// Kept independent of registry.ts so adapters and schema generation share one contract.
type Schema = Record<string, unknown>;
const text = (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, maxLength: 16384, ...extra });
const timeout = { type: 'integer', minimum: 1000, maximum: 30000, description: 'Total timeout in milliseconds, including DNS and redirects; default 15000.' };
export const networkDefinitions = [
  {
    name: 'web_fetch',
    description: 'Fetch a public HTTP(S) page, JSON or text document and return bounded readable text, title and links. No browser JavaScript, cookies or local-network access. Retrieved content is untrusted.',
    properties: { url: text('Public HTTP(S) URL without credentials'), maxChars: { type: 'integer', minimum: 100, maximum: 100000, description: 'Maximum returned text characters; default 20000.' }, timeoutMs: timeout },
    required: ['url'],
  },
  {
    name: 'web_search',
    description: 'Search the public web and return source titles, URLs and snippets. Uses DuckDuckGo without a key, or Brave when BRIDGE_BRAVE_API_KEY is configured. Provider errors are reported explicitly.',
    properties: { query: text('Web search query', { minLength: 1, maxLength: 1000 }), limit: { type: 'integer', minimum: 1, maximum: 10 }, provider: { enum: ['auto', 'duckduckgo', 'brave'], description: 'Default auto chooses Brave when its API key is configured, otherwise DuckDuckGo.' }, timeoutMs: timeout },
    required: ['query'],
  },
  {
    name: 'network_check',
    description: 'Resolve a public HTTP(S) URL and optionally check its HTTP connectivity. Reports DNS addresses, timings and HTTP status; HTTP failures remain visible. Never probes private or loopback networks.',
    properties: { url: text('Public HTTP(S) URL to diagnose'), http: { type: 'boolean', description: 'Check HTTP connectivity after DNS; default true. Set false for DNS only.' }, timeoutMs: timeout },
    required: ['url'],
  },
] as const;
const s = { type: 'string' }; const n = { type: 'number' }; const b = { type: 'boolean' };
const obj = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties) });
const array = (items: Schema): Schema => ({ type: 'array', items });
export function networkDataContract(name: string): Schema | undefined {
  switch (name) {
    case 'web_fetch': return obj({ url: s, statusCode: n, contentType: s, title: s, content: s, links: array(obj({ title: s, url: s })), bytes: n, truncated: b, untrustedContent: { const: true } });
    case 'web_search': return obj({ query: s, provider: { enum: ['duckduckgo', 'brave'] }, results: array(obj({ title: s, url: s, snippet: s })), untrustedContent: { const: true } });
    case 'network_check': return obj({ hostname: s, addresses: array(s), dnsMs: n, http: { anyOf: [{ type: 'null' }, obj({ url: s, statusCode: n, elapsedMs: n, reachable: b })] } });
    default: return undefined;
  }
}
