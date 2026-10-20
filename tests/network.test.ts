import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkClient, isPublicAddress, type NetworkDependencies } from '../mcp-server/src/adapters/network.js';
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
