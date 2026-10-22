import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkClient, isPublicAddress, publicDnsLookup, type NetworkDependencies } from '../mcp-server/src/adapters/network.js';
import { networkDefinitions, networkDataContract } from '../shared/network.js';
import { BridgeError } from '../mcp-server/src/types.js';
import AjvModule from 'ajv';

const Ajv = AjvModule.default;
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (body: string, contentType = 'text/html', statusCode = 200) => ({ statusCode, headers: { 'content-type': contentType }, body: Buffer.from(body) });
const errorCode = (code: string) => (error: unknown) => error instanceof BridgeError && error.code === code;
const client = (transport: NonNullable<NetworkDependencies['transport']>, extra: NetworkDependencies = {}) => new NetworkClient({ resolve: publicDns, transport, environment: {}, ...extra });

test('network definitions compile and public address filter blocks local, encoded and transition destinations', async () => {
  const ajv = new Ajv({ strict: false });
  for (const definition of networkDefinitions) { ajv.compile({ type: 'object', properties: definition.properties, required: definition.required }); assert.ok(networkDataContract(definition.name)); }
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '100.64.1.1', '172.31.0.1', '169.254.169.254', '192.168.0.1', '198.19.1.1', '192.0.2.1', '203.0.113.1', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1', '3fff::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
  const c = client(async () => assert.fail('Must not connect'));
  for (const url of ['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://localhost/', 'http://computer.local/', 'http://example.org:9000/', 'file:///etc/passwd', 'https://secret@example.com/']) await assert.rejects(c.call('web_fetch', { url }), (error: unknown) => error instanceof BridgeError);
});

test('DNS validation rejects mixed public/private answers and passes the exact validated address to transport', async () => {
  const denied = client(async () => assert.fail('Must not connect'), { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(denied.call('web_fetch', { url: 'https://example.org/' }), errorCode('NETWORK_ADDRESS_FORBIDDEN'));
  let connections = 0;
  const pinned = client(async options => { connections++; assert.deepEqual(options.address, { address: '93.184.216.34', family: 4 }); assert.equal(options.url.hostname, 'example.org'); return response('ok', 'text/plain'); });
  await pinned.call('web_fetch', { url: 'https://example.org/' }); assert.equal(connections, 1);
});

test('public DNS fallback recovers contaminated system answers while pinning only revalidated public addresses', async () => {
  let fallbacks = 0; const used: string[] = [];
  const c = client(async options => { used.push(options.address.address); return response('recovered', 'text/plain'); }, {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '2001::1', family: 6 }],
    publicResolve: async (hostname, signal) => { fallbacks++; assert.equal(hostname, 'example.org'); assert.equal(signal.aborted, false); return [{ address: '1.1.1.1', family: 4 }]; },
  });
  const result = await c.call('web_fetch', { url: 'https://example.org/' }) as { content: string; dnsSource: string };
  assert.equal(result.content, 'recovered'); assert.equal(result.dnsSource, 'public-doh'); assert.deepEqual(used, ['1.1.1.1']); assert.equal(fallbacks, 1);
  const failedLocal = client(async () => assert.fail('DNS-only check must not reach destination'), {
    resolve: async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); },
    publicResolve: async () => [{ address: '1.1.1.1', family: 4 }],
  });
  const checked = await failedLocal.call('network_check', { url: 'https://example.org/', http: false }) as { dnsSource: string; addresses: string[] };
  assert.equal(checked.dnsSource, 'public-doh'); assert.deepEqual(checked.addresses, ['1.1.1.1']);
});

test('public DNS fallback never accepts private answers, follows local URLs or overrides an explicit opt-out', async () => {
  for (const fallback of [async () => [{ address: '127.0.0.1', family: 4 }], async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }], async (): Promise<never> => { throw new Error('resolver unavailable'); }]) {
    const c = client(async () => assert.fail('Must not connect'), { resolve: async () => [{ address: '198.18.0.1', family: 4 }], publicResolve: fallback });
    await assert.rejects(c.call('web_fetch', { url: 'https://example.org/' }), (error: unknown) => {
      assert.ok(error instanceof BridgeError); assert.equal(error.code, 'NETWORK_ADDRESS_FORBIDDEN'); assert.ok((error.details as { publicDnsFallback: unknown }).publicDnsFallback); return true;
    });
  }
  const neverFallback = async (): Promise<never> => assert.fail('Must not consult public DNS');
  const c = client(async () => assert.fail('Must not connect'), { publicResolve: neverFallback });
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://device.local/', 'http://10.0.0.1/']) await assert.rejects(c.call('web_fetch', { url }), errorCode('NETWORK_ADDRESS_FORBIDDEN'));
  const off = client(async () => assert.fail('Must not connect'), { resolve: async () => [{ address: '198.18.0.1', family: 4 }], publicResolve: neverFallback, environment: { BRIDGE_DNS_FALLBACK: 'off' } });
  await assert.rejects(off.call('web_fetch', { url: 'https://example.org/' }), errorCode('NETWORK_ADDRESS_FORBIDDEN'));
});

test('fixed HTTPS DNS bootstrap pins the resolver IP, validates payloads and refuses redirects', async () => {
  const signal = AbortSignal.timeout(1000);
  const answer = JSON.stringify({ Status: 0, Answer: [{ type: 5, data: 'alias.example.org.' }, { type: 1, data: '8.8.8.8' }] });
  const result = await publicDnsLookup('example.org', signal, {}, undefined, async options => {
    assert.equal(options.url.origin, 'https://cloudflare-dns.com'); assert.equal(options.url.pathname, '/dns-query');
    assert.equal(options.url.searchParams.get('name'), 'example.org'); assert.equal(options.url.searchParams.get('type'), 'A');
    assert.deepEqual(options.address, { address: '1.1.1.1', family: 4 }); assert.equal(options.headers.accept, 'application/dns-json');
    assert.equal(options.signal, signal); return response(answer, 'application/dns-json');
  });
  assert.deepEqual(result, [{ address: '8.8.8.8', family: 4 }]);
  for (const body of ['null', '{invalid', JSON.stringify({ Status: 3 }), JSON.stringify({ Status: 0, TC: true, Answer: [] }), JSON.stringify({ Status: 0, Answer: [{ type: 1, data: 'not an IP' }] })]) {
    await assert.rejects(publicDnsLookup('example.org', signal, {}, undefined, async () => response(body, 'application/dns-json')), errorCode('NETWORK_DNS_FAILED'));
  }
  await assert.rejects(publicDnsLookup('example.org', signal, {}, undefined, async () => response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] }), 'application/dns-json')), errorCode('NETWORK_ADDRESS_FORBIDDEN'));
  let requests = 0;
  await assert.rejects(publicDnsLookup('example.org', signal, {}, undefined, async () => { requests++; return { statusCode: 302, headers: { location: 'http://127.0.0.1/' }, body: Buffer.alloc(0) }; }), errorCode('NETWORK_DNS_FAILED'));
  assert.equal(requests, 1);
});

test('public DNS fallback is revalidated on redirects and remains inside the original deadline', async () => {
  let resolutions = 0; let requests = 0;
  const c = client(async () => { requests++; return { statusCode: 302, headers: { location: '/again' }, body: Buffer.alloc(0) }; }, {
    resolve: async () => [{ address: '198.18.0.1', family: 4 }],
    publicResolve: async () => [{ address: ++resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }],
  });
  await assert.rejects(c.call('web_fetch', { url: 'https://example.org/' }), errorCode('NETWORK_ADDRESS_FORBIDDEN'));
  assert.equal(requests, 1); assert.equal(resolutions, 2);
  let signal: AbortSignal | undefined;
  const stalled = client(async () => assert.fail('Must not connect'), {
    resolve: async () => [{ address: '198.18.0.1', family: 4 }],
    publicResolve: async (_hostname, parentSignal) => { signal = parentSignal; return new Promise(() => {}); },
  });
  await assert.rejects(stalled.call('web_fetch', { url: 'https://example.org/', timeoutMs: 1000 }), errorCode('NETWORK_TIMEOUT'));
  assert.equal(signal?.aborted, true);
});

test('fetch extracts title, readable text and resolved links, removes active content and bounds output', async () => {
  const c = client(async () => response('<html><head><title>A &amp; B</title><style>secret style</style><script>secret script</script></head><body><h1>Hello</h1><p>世界 &#128512;</p><a href="/source?a=1&amp;b=2">Source</a><a href="javascript:alert(1)">Bad</a><p>' + 'x'.repeat(300) + '</p></body></html>'));
  const result = await c.call('web_fetch', { url: 'https://example.org', maxChars: 100 }) as { content: string; title: string; truncated: boolean; links: { url: string }[] };
  assert.equal(result.title, 'A & B'); assert.match(result.content, /世界 😀/); assert.doesNotMatch(result.content, /secret (script|style)/); assert.equal(result.content.length, 100); assert.equal(result.truncated, true); assert.deepEqual(result.links, [{ title: 'Source', url: 'https://example.org/source?a=1&b=2' }]);
  const validate = new Ajv({ strict: false }).compile(networkDataContract('web_fetch')!); assert.ok(validate(result), JSON.stringify(validate.errors));
});

test('fetch handles text and JSON and rejects binary, oversized and unsuccessful responses', async () => {
  for (const type of ['text/plain; charset=utf-8', 'application/json', 'application/problem+json']) { const result = await client(async () => response('{"key":true}', type)).call('web_fetch', { url: 'https://example.org/' }) as { content: string }; assert.equal(result.content, '{"key":true}'); }
  await assert.rejects(client(async () => response('binary', 'image/png')).call('web_fetch', { url: 'https://example.org/' }), errorCode('NETWORK_CONTENT_UNSUPPORTED'));
  await assert.rejects(client(async () => response('x'.repeat(2 * 1024 * 1024 + 1), 'text/plain')).call('web_fetch', { url: 'https://example.org/' }), errorCode('NETWORK_RESPONSE_TOO_LARGE'));
  await assert.rejects(client(async () => response('blocked', 'text/plain', 403)).call('web_fetch', { url: 'https://example.org/' }), errorCode('NETWORK_HTTP_ERROR'));
});

test('redirects revalidate DNS, enforce hop limits and prevent insecure downgrade', async () => {
  const redirected = client(async () => ({ statusCode: 302, headers: { location: 'http://127.0.0.1/secret' }, body: Buffer.alloc(0) }));
  await assert.rejects(redirected.call('web_fetch', { url: 'http://example.org/' }), errorCode('NETWORK_ADDRESS_FORBIDDEN'));
  const downgrade = client(async () => ({ statusCode: 302, headers: { location: 'http://example.org/plain' }, body: Buffer.alloc(0) }));
  await assert.rejects(downgrade.call('web_fetch', { url: 'https://example.org/' }), errorCode('NETWORK_INSECURE_REDIRECT'));
  let hops = 0; const cycle = client(async () => { hops++; return { statusCode: 302, headers: { location: '/again' }, body: Buffer.alloc(0) }; });
  await assert.rejects(cycle.call('web_fetch', { url: 'https://example.org/' }), errorCode('NETWORK_REDIRECT_LIMIT')); assert.equal(hops, 6);
  let resolutions = 0; const rebound = client(async () => ({ statusCode: 302, headers: { location: '/again' }, body: Buffer.alloc(0) }), { resolve: async () => ++resolutions === 1 ? publicDns() : [{ address: '169.254.169.254', family: 4 }] });
  await assert.rejects(rebound.call('web_fetch', { url: 'https://example.org/' }), errorCode('NETWORK_ADDRESS_FORBIDDEN')); assert.equal(resolutions, 2);
});

test('DNS-only check does not connect, and HTTP check falls back when HEAD is unsupported', async () => {
  const dns = await client(async () => assert.fail('DNS-only check must not connect')).call('network_check', { url: 'https://example.org/', http: false }) as { http: unknown; addresses: string[]; dnsMs: number };
  assert.equal(dns.http, null); assert.deepEqual(dns.addresses, ['93.184.216.34']); assert.ok(dns.dnsMs >= 0);
  const methods: string[] = []; const c = client(async options => { methods.push(options.method); return response('', 'text/plain', options.method === 'HEAD' ? 405 : 503); });
  const checked = await c.call('network_check', { url: 'https://example.org/' }) as { http: { statusCode: number; reachable: boolean } };
  assert.deepEqual(methods, ['HEAD', 'GET']); assert.equal(checked.http.statusCode, 503); assert.equal(checked.http.reachable, false);
  assert.ok(new Ajv({ strict: false }).compile(networkDataContract('network_check')!)(checked));
});

test('DuckDuckGo search returns canonical URLs and snippets, reports challenge pages explicitly', async () => {
  const c = client(async options => { assert.equal(options.url.hostname, 'html.duckduckgo.com'); assert.equal(options.url.searchParams.get('q'), 'MCP search'); return response('<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fsource">Example &amp; source</a><a class="result__snippet">A <b>real</b> result.</a>'); });
  const result = await c.call('web_search', { query: 'MCP search' }) as { results: unknown[]; provider: string };
  assert.equal(result.provider, 'duckduckgo'); assert.deepEqual(result.results, [{ title: 'Example & source', url: 'https://example.org/source', snippet: 'A real result.' }]); assert.ok(new Ajv({ strict: false }).compile(networkDataContract('web_search')!)(result));
  await assert.rejects(client(async () => response('<form>Verify you are human</form>')).call('web_search', { query: 'query' }), errorCode('SEARCH_PROVIDER_UNAVAILABLE'));
  const empty = await client(async () => response('<div class="no-results">No results found</div>')).call('web_search', { query: 'query' }) as { results: unknown[] }; assert.deepEqual(empty.results, []);
});

test('Brave uses optional environment credential and strips it across origin redirects', async () => {
  const noKey = client(async () => assert.fail('Must not connect'));
  await assert.rejects(noKey.call('web_search', { query: 'query', provider: 'brave' }), errorCode('SEARCH_KEY_REQUIRED'));
  let requests = 0;
  const brave = client(async options => {
    if (++requests === 1) { assert.equal(options.headers['X-Subscription-Token'], 'private-key'); return { statusCode: 302, headers: { location: 'https://results.example.org/' }, body: Buffer.alloc(0) }; }
    assert.equal(options.headers['X-Subscription-Token'], undefined); return response(JSON.stringify({ web: { results: [{ title: 'Result', url: 'https://example.org/', description: '<b>Snippet</b>' }] } }), 'application/json');
  }, { environment: { BRIDGE_BRAVE_API_KEY: 'private-key' } });
  const result = await brave.call('web_search', { query: 'query' }); assert.doesNotMatch(JSON.stringify(result), /private-key/); assert.equal(requests, 2);
});

test('total deadline includes stalled DNS and stalled response, with clear timeout errors', async () => {
  const stalledDns = client(async () => assert.fail(), { resolve: () => new Promise(() => {}) });
  const stalledResponse = client(() => new Promise(() => {}));
  await Promise.all([assert.rejects(stalledDns.call('web_fetch', { url: 'https://example.org/', timeoutMs: 1000 }), errorCode('NETWORK_TIMEOUT')), assert.rejects(stalledResponse.call('web_fetch', { url: 'https://example.org/', timeoutMs: 1000 }), errorCode('NETWORK_TIMEOUT'))]);
});

test('concurrent calls use at most four active requests and release slots after errors', async () => {
  let active = 0; let maximum = 0; let count = 0;
  const c = client(async () => { active++; maximum = Math.max(maximum, active); const index = ++count; await new Promise(resolve => setTimeout(resolve, 20)); active--; if (index === 2) throw new Error('disconnect'); return response('ok', 'text/plain'); });
  const results = await Promise.allSettled(Array.from({ length: 15 }, () => c.call('web_fetch', { url: 'https://example.org/' })));
  assert.equal(maximum, 4); assert.equal(count, 15); assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.ok(await c.call('web_fetch', { url: 'https://example.org/' }));
});

test('transient connection errors try distinct validated addresses, bounded to three attempts', async () => {
  const addresses = ['8.8.8.8', '1.1.1.1', '9.9.9.9', '208.67.222.222']; const tried: string[] = [];
  const resolve = async () => [...addresses, addresses[0]].map(address => ({ address, family: 4 }));
  const c = client(async options => {
    tried.push(options.address.address);
    if (tried.length === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    return response('recovered', 'text/plain');
  }, { resolve });
  assert.equal((await c.call('web_fetch', { url: 'https://example.org/' }) as { content: string }).content, 'recovered');
  assert.deepEqual(tried, addresses.slice(0, 2));
  let attempts = 0;
  const failed = client(async () => { attempts++; throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); }, { resolve });
  await assert.rejects(failed.call('web_fetch', { url: 'https://example.org/' }), (error: unknown) => {
    assert.ok(error instanceof BridgeError); assert.equal(error.code, 'NETWORK_REQUEST_FAILED');
    assert.equal((error.details as { causeCode: string }).causeCode, 'ECONNREFUSED'); return true;
  });
  assert.equal(attempts, 3);
});

test('HTTP refusals, certificate failures and proxy failures never retry another destination address', async () => {
  const resolve = async () => [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }];
  for (const [failure, code, phase] of [
    [() => response('forbidden', 'text/plain', 403), 'NETWORK_HTTP_ERROR', 'http'],
    [() => { throw Object.assign(new Error('secret certificate message'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }); }, 'NETWORK_TLS_FAILED', 'tls'],
    [() => { throw new BridgeError('NETWORK_PROXY_ERROR', 'Proxy refused', { phase: 'proxy', causeCode: 'ECONNREFUSED' }); }, 'NETWORK_PROXY_ERROR', 'proxy'],
  ] as const) {
    let attempts = 0;
    const c = client(async () => { attempts++; return failure(); }, { resolve });
    await assert.rejects(c.call('web_fetch', { url: 'https://example.org/' }), (error: unknown) => {
      assert.ok(error instanceof BridgeError); assert.equal(error.code, code);
      assert.equal((error.details as { phase: string }).phase, phase); return true;
    });
    assert.equal(attempts, 1);
  }
});

test('diagnostics preserve safe cause codes and hints without leaking raw error messages or URL queries', async () => {
  const secret = 'http://user:private-password@proxy.example:8080/?token=private-token';
  for (const [causeCode, expectedCode, phase] of [
    ['ENOTFOUND', 'NETWORK_DNS_FAILED', 'dns'], ['EAI_AGAIN', 'NETWORK_DNS_FAILED', 'dns'],
    ['ECONNRESET', 'NETWORK_REQUEST_FAILED', 'connect'], ['CERT_HAS_EXPIRED', 'NETWORK_TLS_FAILED', 'tls'],
  ] as const) {
    const fail = async (): Promise<never> => { throw Object.assign(new Error(secret), { code: causeCode }); };
    const c = phase === 'dns' ? client(async () => assert.fail('Must not connect'), { resolve: fail }) : client(fail);
    await assert.rejects(c.call('web_fetch', { url: 'https://example.org/?token=private-token' }), (error: unknown) => {
      assert.ok(error instanceof BridgeError); assert.equal(error.code, expectedCode);
      const details = error.details as { causeCode: string; phase: string; hostname: string; hint: string; retryable: boolean };
      assert.equal(details.causeCode, causeCode); assert.equal(details.phase, phase); assert.equal(details.hostname, 'example.org');
      assert.ok(details.hint); assert.equal(details.retryable, ['EAI_AGAIN', 'ECONNRESET'].includes(causeCode));
      assert.doesNotMatch(JSON.stringify({ message: error.message, details }), /private-password|private-token/); return true;
    });
  }
  const mixed = client(async () => assert.fail('Must not connect'), { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '2001::1', family: 6 }] });
  await assert.rejects(mixed.call('web_fetch', { url: 'https://example.org/' }), (error: unknown) => {
    assert.ok(error instanceof BridgeError); assert.equal(error.code, 'NETWORK_ADDRESS_FORBIDDEN');
    const details = error.details as { forbiddenAddresses: string[]; retryable: boolean; hint: string };
    assert.deepEqual(details.forbiddenAddresses, ['2001::1']); assert.equal(details.retryable, false); assert.match(details.hint, /DNS/); return true;
  });
});

test('HTTP diagnostics distinguish access denials, missing endpoints and rate limits', async () => {
  for (const status of [403, 404, 429, 503]) {
    await assert.rejects(client(async () => response('', 'text/plain', status)).call('web_fetch', { url: 'https://example.org/' }), (error: unknown) => {
      assert.ok(error instanceof BridgeError); const details = error.details as { statusCode: number; phase: string; retryable: boolean; hint: string };
      assert.equal(details.statusCode, status); assert.equal(details.phase, 'http'); assert.equal(details.retryable, status >= 429); assert.ok(details.hint); return true;
    });
  }
});

test('fetch and connectivity metadata expose only canonical server dates and fresh host timestamps', async () => {
  for (const date of ['Thu, 22 Oct 2026 08:21:10 GMT', 'invalid server date', undefined]) {
    const c = client(async () => ({ ...response('body', 'text/plain'), headers: { 'content-type': 'text/plain', date, 'set-cookie': 'private-cookie' } }));
    const before = Date.now();
    const fetched = await c.call('web_fetch', { url: 'https://example.org/' }) as { fetchedAt: string; serverDate: string | null };
    const checked = await c.call('network_check', { url: 'https://example.org/' }) as { http: { fetchedAt: string; serverDate: string | null } };
    for (const result of [fetched, checked.http]) {
      assert.ok(Date.parse(result.fetchedAt) >= before && Date.parse(result.fetchedAt) <= Date.now());
      assert.equal(result.serverDate, date?.startsWith('Thu') ? '2026-10-22T08:21:10.000Z' : null);
      assert.doesNotMatch(JSON.stringify(result), /private-cookie/);
    }
  }
});

test('address fallback shares the original absolute timeout instead of resetting it', async () => {
  const signals = new Set<AbortSignal>(); let attempts = 0;
  const c = client(async options => {
    signals.add(options.signal);
    if (++attempts === 1) { await new Promise(resolve => setTimeout(resolve, 100)); throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }
    return new Promise(() => {});
  }, { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }] });
  await assert.rejects(c.call('web_fetch', { url: 'https://example.org/', timeoutMs: 1000 }), errorCode('NETWORK_TIMEOUT'));
  assert.equal(attempts, 2); assert.equal(signals.size, 1); assert.equal([...signals][0].aborted, true);
});

test('real proxy authentication errors retain diagnostics, hide credentials and do not retry destination IPs', async () => {
  const { createServer } = await import('node:http');
  const proxy = createServer(); let connections = 0;
  proxy.on('connect', (_request, socket) => { connections++; socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as import('node:net').AddressInfo).port;
  const c = new NetworkClient({ environment: { HTTPS_PROXY: `http://user:private-password@127.0.0.1:${port}` }, resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }] });
  try {
    await assert.rejects(c.call('web_fetch', { url: 'https://example.org/' }), (error: unknown) => {
      assert.ok(error instanceof BridgeError); assert.equal(error.code, 'NETWORK_PROXY_ERROR');
      const details = error.details as { phase: string; statusCode: number; retryable: boolean; hint: string };
      assert.equal(details.phase, 'proxy'); assert.equal(details.statusCode, 407); assert.equal(details.retryable, false);
      assert.match(details.hint, /authentication/); assert.doesNotMatch(JSON.stringify(error), /private-password/); return true;
    });
    assert.equal(connections, 1);
  } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

test('real HTTP proxy pins public destination, closes unfinished redirect bodies, and bounds decompression', async () => {
  const { createServer } = await import('node:http');
  const { connect } = await import('node:net');
  const { gzipSync } = await import('node:zlib');
  const sockets = new Set<import('node:net').Socket>(); const authorities: string[] = [];
  let redirectClosed = false; let headClosed = false;
  const upstream = createServer((request, response) => {
    assert.equal(request.headers.host, 'public.example');
    assert.equal(request.headers['proxy-authorization'], undefined);
    if (request.url === '/redirect') { response.writeHead(302, { location: '/text' }); response.flushHeaders(); response.on('close', () => { redirectClosed = true; }); return; }
    if (request.method === 'HEAD') { response.writeHead(200); response.flushHeaders(); response.on('close', () => { headClosed = true; }); return; }
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
    response.end(gzipSync(request.url === '/large' ? 'x'.repeat(2 * 1024 * 1024 + 1) : 'proxied text'));
  });
  const proxy = createServer();
  for (const server of [upstream, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as import('node:net').AddressInfo).port;
  proxy.on('connect', (request, downstream, head) => {
    authorities.push(request.url || '');
    assert.equal(request.headers['proxy-authorization'], `Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
    const socket = connect(upstreamPort, '127.0.0.1', () => { downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) socket.write(head); downstream.pipe(socket); socket.pipe(downstream); });
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    downstream.on('error', () => socket.destroy()); socket.on('error', () => downstream.destroy());
    downstream.on('close', () => socket.destroy()); socket.on('close', () => downstream.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as import('node:net').AddressInfo).port;
  const c = new NetworkClient({ resolve: publicDns, environment: { HTTP_PROXY: `http://test-user:test-password@127.0.0.1:${proxyPort}` } });
  try {
    const result = await c.call('web_fetch', { url: 'http://public.example/redirect' }) as { content: string }; assert.equal(result.content, 'proxied text');
    const systemFallback = new NetworkClient({ resolve: publicDns, environment: {}, systemProxy: async () => ({ http: `http://test-user:test-password@127.0.0.1:${proxyPort}`, exceptions: [] }) });
    const viaSystem = await systemFallback.call('web_fetch', { url: 'http://public.example/text' }) as { content: string }; assert.equal(viaSystem.content, 'proxied text');
    await c.call('network_check', { url: 'http://public.example/headers' });
    await assert.rejects(c.call('web_fetch', { url: 'http://public.example/large' }), errorCode('NETWORK_RESPONSE_TOO_LARGE'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(redirectClosed, true); assert.equal(headClosed, true);
    assert.ok(authorities.length >= 4); assert.ok(authorities.every(authority => authority === '93.184.216.34:80'));
  } finally {
    const closed = [new Promise<void>(resolve => upstream.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]; for (const socket of sockets) socket.destroy(); await Promise.all(closed);
  }
});
