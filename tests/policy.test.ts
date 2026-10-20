import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const temp = await realpath(await mkdtemp(join(tmpdir(), 'bridge-policy-')));
process.env.BRIDGE_STATE_DIR = join(temp, 'state');
const { Engine } = await import('../mcp-server/src/engine.js');
const { getConfig, transaction, readSnapshot, stateDir, defaults, digest } = await import('../mcp-server/src/state.js');
const { BridgeError } = await import('../mcp-server/src/types.js');
const exec = promisify(execFile);
const args = (key: string) => ({ text: 'policy test', _idempotencyKey: `policy-${key}` });
const pendingId = (result: { data: unknown }) => (result.data as { approvalId: string }).approvalId;
const cli = async (...argv: string[]) => JSON.parse((await exec(process.execPath, ['--import', 'tsx', resolve('mcp-server/src/cli.ts'), ...argv], { env: { ...process.env, BRIDGE_STATE_DIR: stateDir } })).stdout) as unknown;
beforeEach(async () => { await transaction(state => { Object.assign(state, defaults()); }); });
after(async () => { await rm(temp, { recursive: true, force: true }); });

test('old configuration migrates to manual approval; read snapshots do not rewrite state', async () => {
  const old = defaults(); const { approvalMode: _mode, ...config } = old.config;
  await writeFile(join(stateDir, 'state.json'), JSON.stringify({ ...old, config }));
  const before = (await stat(join(stateDir, 'state.json'))).mtimeMs;
  assert.equal((await getConfig()).approvalMode, 'manual');
  assert.equal((await stat(join(stateDir, 'state.json'))).mtimeMs, before);
  assert.equal((await new Engine('migration', async () => assert.fail('not approved')).call('clipboard_write', args('migration'))).status, 'confirmation_required');
});

test('auto-write executes ordinary writes, still gates high-risk actions and respects disabled tools', async () => {
  await transaction(state => { state.config.approvalMode = 'auto-write'; state.config.trustedWriteTools.push('mail_send'); });
  let count = 0;
  const engine = new Engine('policy', async name => { assert.equal(name, 'clipboard_write'); return { changeCount: ++count }; });
  assert.equal((await engine.call('clipboard_write', args('auto'))).status, 'ok');
  assert.equal((await engine.call('mail_send', { to: 'nobody@example.com', subject: 'test', body: 'test', _idempotencyKey: 'policy-send' })).status, 'confirmation_required');
  await transaction(state => { state.config.disabledTools.push('clipboard_write'); });
  assert.equal((await engine.call('clipboard_write', args('disabled'))).error?.code, 'TOOL_DISABLED');
  assert.equal(count, 1);
});

test('denial remains effective after expiry, automatic mode, and per-tool trust', async () => {
  const engine = new Engine('denial', async () => assert.fail('denied action executed'));
  const id = pendingId(await engine.call('clipboard_write', args('denied')));
  await cli('review', id, 'deny');
  await transaction(state => { state.config.approvalMode = 'auto-write'; state.config.trustedWriteTools.push('clipboard_write'); state.approvals[0].expiresAt = '2000-01-01T00:00:00Z'; });
  assert.equal((await engine.call('clipboard_write', args('denied'))).error?.code, 'ACTION_DENIED');
  assert.deepEqual((await readSnapshot()).approvals[0].args, {});
  const status = await new Engine('denial').call('bridge_get_operation', { tool: 'clipboard_write', idempotencyKey: 'policy-denied' });
  assert.equal(status.status, 'ok');
  assert.equal((status.data as { state: string }).state, 'denied');
});

test('matching human approval resumes with original arguments, no approval ID required', async () => {
  let count = 0; const engine = new Engine('approved', async () => ({ changeCount: ++count }));
  const input = args('approved'); const id = pendingId(await engine.call('clipboard_write', input));
  await cli('review', id, 'approve');
  const result = await engine.call('clipboard_write', input);
  assert.equal(result.status, 'ok'); assert.deepEqual(await engine.call('clipboard_write', input), result); assert.equal(count, 1);
  assert.deepEqual(await cli('approvals'), []);
});

test('automatic policy consumes stale pending request when the identical operation executes', async () => {
  const engine = new Engine('pending-auto', async () => ({ changeCount: 1 }));
  const input = args('pending-auto'); await engine.call('clipboard_write', input);
  await cli('set-approval-mode', 'auto-write');
  assert.equal((await engine.call('clipboard_write', input)).status, 'ok');
  assert.deepEqual(await cli('approvals'), []);
});

test('healthy concurrent retries share one execution, including separate Engine instances', async () => {
  await transaction(state => { state.config.approvalMode = 'auto-write'; });
  let count = 0;
  const first = new Engine('concurrent', async () => { await new Promise(resolve => setTimeout(resolve, 100)); return { changeCount: ++count }; });
  const second = new Engine('concurrent', async () => assert.fail('duplicate execution'));
  const results = await Promise.all([first.call('clipboard_write', args('concurrent')), second.call('clipboard_write', args('concurrent'))]);
  assert.equal(count, 1); assert.equal(results[0].status, 'ok'); assert.deepEqual(results[0], results[1]);
});

test('cross-process retry waits for a live receipt without executing a second write', async () => {
  await transaction(state => { state.config.approvalMode = 'auto-write'; });
  const input = args('cross-process');
  const code = `import { Engine } from ${JSON.stringify(resolve('mcp-server/src/engine.ts'))}; const result = await new Engine('cross-process', async () => { await new Promise(resolve => setTimeout(resolve, 600)); return {changeCount: 42}; }).call('clipboard_write', ${JSON.stringify(input)}); process.stdout.write(JSON.stringify(result));`;
  const child = exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: { ...process.env, BRIDGE_STATE_DIR: stateDir } });
  const deadline = Date.now() + 10000;
  while (!(await readSnapshot()).receipts['clipboard_write:policy-cross-process']) {
    assert.ok(Date.now() < deadline, 'child did not reserve its operation');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const result = await new Engine('cross-process', async () => assert.fail('duplicate write')).call('clipboard_write', input);
  assert.equal(result.status, 'ok'); assert.deepEqual(result, JSON.parse((await child).stdout));
});

test('native uncertainty is durable and operation polling never re-executes', async () => {
  await transaction(state => { state.config.approvalMode = 'auto-write'; });
  let count = 0; const engine = new Engine('uncertain', async () => { count++; throw new BridgeError('NATIVE_TIMEOUT', 'timeout'); });
  const input = args('uncertain');
  assert.equal((await engine.call('clipboard_write', input)).error?.code, 'NATIVE_TIMEOUT');
  assert.equal((await engine.call('clipboard_write', input)).error?.code, 'ACTION_INDETERMINATE');
  const status = await new Engine('uncertain').call('bridge_get_operation', { tool: 'clipboard_write', idempotencyKey: input._idempotencyKey });
  assert.deepEqual(status.data, { tool: 'clipboard_write', idempotencyKey: input._idempotencyKey, state: 'indeterminate' }); assert.equal(count, 1);
});

test('source-scoped receipts do not expose another client result or collide', async () => {
  await transaction(state => { state.config.approvalMode = 'auto-write'; });
  const input = args('source');
  const a = await new Engine('client-a', async () => ({ changeCount: 1 })).call('clipboard_write', input);
  const hidden = await new Engine('client-b').call('bridge_get_operation', { tool: 'clipboard_write', idempotencyKey: input._idempotencyKey });
  assert.equal((hidden.data as { state: string }).state, 'not_found');
  const b = await new Engine('client-b', async () => ({ changeCount: 2 })).call('clipboard_write', input);
  assert.notDeepEqual(a.data, b.data);
  assert.deepEqual(await new Engine('client-a', async () => assert.fail()).call('clipboard_write', input), a);
  assert.deepEqual(await new Engine('client-b', async () => assert.fail()).call('clipboard_write', input), b);
});

test('crafted idempotency keys cannot collide with another client receipt namespace', async () => {
  await transaction(state => { state.config.approvalMode = 'auto-write'; });
  const key = 'collision-key'; const crafted = `${key}:source:${digest('collision-b', {})}`;
  assert.ok(crafted.length <= 128);
  const clientA = new Engine('collision-a', async () => ({ changeCount: 7 }));
  await clientA.call('clipboard_write', { text: 'first', _idempotencyKey: key });
  await clientA.call('clipboard_write', { text: 'second private operation', _idempotencyKey: crafted });
  const lookup = await new Engine('collision-b').call('bridge_get_operation', { tool: 'clipboard_write', idempotencyKey: key });
  assert.deepEqual(lookup.data, { tool: 'clipboard_write', idempotencyKey: key, state: 'not_found' });
  const result = await new Engine('collision-b', async () => ({ changeCount: 8 })).call('clipboard_write', { text: 'own operation', _idempotencyKey: key });
  assert.equal(result.status, 'ok'); assert.deepEqual(result.data, { changeCount: 8 });
});

test('completed outcomes survive a receipt write failure within the live process', async () => {
  await transaction(state => { state.config.approvalMode = 'auto-write'; });
  const statePath = join(stateDir, 'state.json'); const backup = join(temp, 'receipt-backup.json'); let count = 0;
  const engine = new Engine('receipt-failure', async () => {
    count++; await rename(statePath, backup); await mkdir(statePath);
    return { changeCount: count };
  });
  const input = args('receipt-failure');
  const result = await engine.call('clipboard_write', input); assert.equal(result.status, 'ok');
  await rm(statePath, { recursive: true }); await rename(backup, statePath);
  const lookup = await new Engine('receipt-failure').call('bridge_get_operation', { tool: 'clipboard_write', idempotencyKey: input._idempotencyKey });
  assert.deepEqual((lookup.data as { result: unknown }).result, result);
  assert.deepEqual(await engine.call('clipboard_write', input), result); assert.equal(count, 1);
  assert.equal((await readSnapshot()).receipts[`clipboard_write:${input._idempotencyKey}`].status, 'done');
});

test('invalid output after a write preserves indeterminate state and cannot auto-repeat', async () => {
  await transaction(state => { state.config.approvalMode = 'auto-write'; });
  let count = 0; const engine = new Engine('invalid-output', async () => { count++; return { unexpected: true }; });
  const input = args('invalid-output');
  assert.equal((await engine.call('clipboard_write', input)).error?.code, 'OUTPUT_SCHEMA_VIOLATION');
  assert.equal((await engine.call('clipboard_write', input)).error?.code, 'ACTION_INDETERMINATE');
  assert.equal(count, 1);
});

test('key-only polling does not expose the contents of legacy receipts without source metadata', async () => {
  await transaction(state => { state.receipts['clipboard_write:legacy-operation'] = { digest: 'legacy', status: 'done', createdAt: new Date().toISOString(), result: { status: 'ok', tool: 'clipboard_write', version: '1.0.0', data: { changeCount: 42 }, error: null } }; });
  const status = await new Engine('another-client').call('bridge_get_operation', { tool: 'clipboard_write', idempotencyKey: 'legacy-operation' });
  assert.deepEqual(status.data, { tool: 'clipboard_write', idempotencyKey: 'legacy-operation', state: 'indeterminate' });
});

test('audit storage failure does not obscure an executed result or permit duplication', async () => {
  await transaction(state => { state.config.approvalMode = 'auto-write'; });
  const auditPath = join(stateDir, 'audit.jsonl'); await rm(auditPath, { force: true }); await mkdir(auditPath);
  try {
    let count = 0; const engine = new Engine('audit', async () => ({ changeCount: ++count })); const input = args('audit');
    const result = await engine.call('clipboard_write', input); assert.equal(result.status, 'ok');
    assert.deepEqual(await engine.call('clipboard_write', input), result); assert.equal(count, 1);
  } finally { await rm(auditPath, { recursive: true, force: true }); }
});

test('admin CLI strictly validates booleans, modes and review decisions', async () => {
  for (const argv of [['set-approval-mode', 'everything'], ['set-enabled', 'clipboard_write', 'yes'], ['set-trusted', 'clipboard_write', 'yes'], ['review', 'missing', 'anything'], ['config', 'unexpected']]) await assert.rejects(cli(...argv));
  assert.equal((await getConfig()).approvalMode, 'manual');
  assert.equal((await cli('config') as { approvalMode: string }).approvalMode, 'manual');
  const overview = await cli('overview') as { capabilities: { inputSchema?: unknown }[]; config: { approvalMode: string }; approvals: unknown[] };
  assert.ok(overview.capabilities.length > 59); assert.ok(overview.capabilities[0].inputSchema); assert.deepEqual(overview.approvals, []);
});

test('single approve-execute executes exactly once and supports receipt lookup', async () => {
  const root = join(temp, 'root'); await mkdir(root, { recursive: true });
  await transaction(state => { state.config.roots = [root]; });
  const input = { path: join(root, 'once'), _idempotencyKey: 'policy-approve-execute' };
  const id = pendingId(await new Engine('cli-flow').call('finder_create_directory', input));
  const result = await cli('approve-execute', id) as { status: string };
  assert.equal(result.status, 'ok'); assert.deepEqual(await cli('approve-execute', id), result);
  const status = await new Engine('cli-flow').call('bridge_get_operation', { tool: 'finder_create_directory', idempotencyKey: input._idempotencyKey });
  assert.equal((status.data as { state: string }).state, 'done');
  assert.deepEqual((status.data as { result: unknown }).result, result);
  const log = await readFile(join(stateDir, 'audit.jsonl'), 'utf8'); assert.ok(!log.includes(input.path));
});


test('concurrent dead-lock recovery preserves mutual exclusion and every committed update', async () => {
  const critical = join(temp, 'critical-section');
  await writeFile(join(stateDir, 'state.lock'), '999999999');
  const children = Array.from({ length: 12 }, (_, index) => {
    const code = `import { transaction } from ${JSON.stringify(resolve('mcp-server/src/state.ts'))};
      import { open, rm } from 'node:fs/promises';
      const start = new Promise(resolve => process.stdin.once('data', resolve));
      process.stdout.write('ready\\n'); await start;
      await transaction(async state => {
        const sentinel = await open(${JSON.stringify(critical)}, 'wx');
        try { await new Promise(resolve => setTimeout(resolve, 40)); state.config.trustedWriteTools.push('worker-${index}'); }
        finally { await sentinel.close(); await rm(${JSON.stringify(critical)}); }
      }); process.stdin.destroy();`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: { ...process.env, BRIDGE_STATE_DIR: stateDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      child.stdout.once('data', () => resolveReady()); child.once('error', rejectReady);
      child.once('exit', () => rejectReady(new Error(stderr || 'worker exited before readiness')));
    });
    const done = new Promise<{ code: number | null; stderr: string }>(resolveDone => child.once('exit', code => resolveDone({ code, stderr })));
    return { child, ready, done };
  });
  try {
    await Promise.all(children.map(item => item.ready));
    for (const item of children) item.child.stdin.end('go');
    const results = await Promise.all(children.map(item => item.done));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const config = await getConfig(); assert.equal(config.trustedWriteTools.length, 12); assert.equal(new Set(config.trustedWriteTools).size, 12);
  } finally { for (const item of children) if (item.child.exitCode === null) item.child.kill(); }
});
