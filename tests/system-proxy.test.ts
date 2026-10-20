import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemProxyReader, parseSystemProxy } from '../mcp-server/src/adapters/system-proxy.js';
import { selectNetworkProxy } from '../mcp-server/src/adapters/network.js';
import { BridgeError } from '../mcp-server/src/types.js';

const fixture = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : *.example.org
  }
  ExcludeSimpleHostnames : 1
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7897
  HTTPSEnable : 1
  HTTPSProxy : proxy.example.net
  HTTPSPort : 8080
  ProxyAutoConfigEnable : 0
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 1
      HTTPProxy : ignored.example.net
      HTTPPort : 9999
    }
  }
}`;

test('system proxy parser reads only enabled top-level HTTP proxies and exceptions', () => {
  assert.deepEqual(parseSystemProxy(fixture), { http: 'http://127.0.0.1:7897/', https: 'http://proxy.example.net:8080/', exceptions: ['*.local', '169.254/16', '*.example.org', '<local>'] });
  assert.deepEqual(parseSystemProxy('not proxy configuration'), { exceptions: [] });
  assert.equal(parseSystemProxy(fixture.replace('HTTPEnable : 1', 'HTTPEnable : 0')).http, undefined);
  assert.equal(parseSystemProxy(fixture.replace('HTTPProxy : 127.0.0.1', 'HTTPProxy : user:password@example.org')).http, undefined);
  assert.equal(parseSystemProxy(fixture.replace('HTTPPort : 7897', 'HTTPPort : 70000')).http, undefined);
  assert.equal(parseSystemProxy(fixture.replace('HTTPProxy : 127.0.0.1', 'HTTPProxy : ::1')).http, 'http://[::1]:7897/');
});

test('system proxy reader coalesces concurrent reads, caches for 30 seconds and refreshes', async () => {
  let reads = 0; let now = 1000;
  const read = createSystemProxyReader({ platform: 'darwin', now: () => now, read: async () => { reads++; await Promise.resolve(); return fixture; } });
  const results = await Promise.all(Array.from({ length: 12 }, read)); assert.equal(reads, 1); assert.ok(results.every(result => result.http === 'http://127.0.0.1:7897/'));
  now += 29999; await read(); assert.equal(reads, 1);
  now += 2; await Promise.all([read(), read()]); assert.equal(reads, 2);
});

test('non-macOS test readers never spawn commands and failed reads have a bounded cache', async () => {
  const nonMac = createSystemProxyReader({ platform: 'linux', read: async () => assert.fail('Must not read macOS state') }); assert.deepEqual(await nonMac(), { exceptions: [] });
  let reads = 0; let now = 0;
  const failure = createSystemProxyReader({ platform: 'darwin', now: () => now, read: async () => { reads++; throw new Error('scutil unavailable'); } });
  assert.deepEqual(await failure(), { exceptions: [] }); await failure(); assert.equal(reads, 1);
  now = 30001; await failure(); assert.equal(reads, 2);
});

test('explicit proxy environment wins; NO_PROXY bypasses without reading system state', async () => {
  const unavailable = async (): Promise<never> => assert.fail('Explicit environment should not read system proxy');
  assert.equal((await selectNetworkProxy(new URL('https://outside.example/'), { HTTPS_PROXY: 'http://env.example:8080' }, unavailable))?.hostname, 'env.example');
  assert.equal(await selectNetworkProxy(new URL('https://docs.example.org/'), { HTTPS_PROXY: 'http://env.example:8080', NO_PROXY: '.example.org' }, unavailable), undefined);
  assert.equal(await selectNetworkProxy(new URL('https://outside.example/'), { NO_PROXY: '*' }, unavailable), undefined);
  assert.equal(await selectNetworkProxy(new URL('https://outside.example/'), {}), undefined, 'An omitted provider keeps isolated tests deterministic');
});

test('system fallback respects scheme, exception patterns and explicit NO_PROXY overrides', async () => {
  const system = async () => parseSystemProxy(fixture);
  assert.equal((await selectNetworkProxy(new URL('http://outside.example/'), {}, system))?.hostname, '127.0.0.1');
  assert.equal((await selectNetworkProxy(new URL('https://outside.example/'), {}, system))?.hostname, 'proxy.example.net');
  assert.equal(await selectNetworkProxy(new URL('https://docs.example.org/'), {}, system), undefined);
  assert.equal((await selectNetworkProxy(new URL('https://docs.example.org/'), { NO_PROXY: '' }, system))?.hostname, 'proxy.example.net');
  assert.equal(await selectNetworkProxy(new URL('https://outside.example/'), { NO_PROXY: 'outside.example:443' }, system), undefined);
  assert.ok(await selectNetworkProxy(new URL('https://outside.example/'), { NO_PROXY: 'outside.example:80' }, system));
  assert.equal(await selectNetworkProxy(new URL('https://outside.example/'), {}, async () => ({ http: 'http://localhost:9999', exceptions: [] })), undefined, 'HTTP-only system proxy does not silently override HTTPS');
  assert.equal(await selectNetworkProxy(new URL('https://docs.example.org/'), {}, async () => ({ https: 'http://localhost:9999', exceptions: ['docs.*.org'] })), undefined);
});

test('PAC-only and SOCKS-only settings report a useful unsupported configuration error', async () => {
  for (const [key, expected] of [['ProxyAutoConfigEnable', 'pac'], ['ProxyAutoDiscoveryEnable', 'pac'], ['SOCKSEnable', 'socks']] as const) {
    const parsed = parseSystemProxy(`<dictionary> {\n  ${key} : 1\n}`); assert.equal(parsed.unsupported, expected);
    await assert.rejects(selectNetworkProxy(new URL('https://outside.example/'), {}, async () => parsed), (error: unknown) => error instanceof BridgeError && error.code === 'NETWORK_PROXY_UNSUPPORTED');
  }
});
