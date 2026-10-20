import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Engine } from './engine.js';
import { stateDir, transaction, getConfig, readSnapshot, receiptKeyFor, type Approval, type ApprovalMode } from './state.js';
import { nativeCall } from './native.js';
import { registry, byName } from '../../shared/registry.js';
import { BridgeError } from './types.js';
const [command, ...argv] = process.argv.slice(2);
function arity(min: number, max = min) { if (argv.length < min || argv.length > max) throw new Error(`Invalid arguments for ${command}`); }
function boolean(value: string): boolean { if (value !== 'true' && value !== 'false') throw new Error('Expected true or false'); return value === 'true'; }
const visibleApprovals = (items: Approval[]) => items.filter(a => ['pending', 'approved'].includes(a.status) && Date.parse(a.expiresAt) > Date.now());
async function executeApproved(id: string, approvePending: boolean): Promise<unknown> {
  const item = await transaction(state => {
    const request = state.approvals.find(a => a.id === id);
    if (!request || request.status === 'denied') throw new Error('Approved action not found');
    if (request.status === 'pending') { if (!approvePending) throw new Error('Action has not been approved'); request.status = 'approved'; }
    return request;
  });
  if (item.status === 'consumed') {
    const key = item.idempotencyKey;
    const snapshot = await readSnapshot();
    const receipt = key ? snapshot.receipts[receiptKeyFor(snapshot, item.tool, key, item.source)] : undefined;
    if (receipt?.source && receipt.source !== item.source) throw new BridgeError('IDEMPOTENCY_SOURCE_MISMATCH', 'This operation belongs to a different client.');
    if (receipt?.status === 'done' && receipt.result && Date.parse(receipt.createdAt) >= Date.now() - 86400000) return receipt.result;
    throw new BridgeError('ACTION_INDETERMINATE', 'This approved request has already started; inspect its operation status instead of approving it again.');
  }
  return new Engine(item.source).call(item.tool, { ...item.args, _approvalId: item.id });
}
let output: unknown;
try {
  switch (command) {
    case 'call': arity(1, 3); output = await new Engine(argv[2] || 'raycast').call(argv[0], JSON.parse(argv[1] || '{}')); break;
    // Policy administration is deliberately absent from MCP's tool registry.
    case 'config': arity(0); output = await getConfig(); break;
    case 'overview': {
      arity(0); const state = await readSnapshot();
      output = { capabilities: registry.map(tool => ({ ...tool, enabled: !state.config.disabledTools.includes(tool.name) })), config: state.config, approvals: visibleApprovals(state.approvals) }; break;
    }
    case 'approvals': arity(0); output = visibleApprovals((await readSnapshot()).approvals); break;
    case 'review': {
      arity(2); if (!['approve', 'deny'].includes(argv[1])) throw new Error('Expected approve or deny');
      output = await transaction(state => {
        const item = state.approvals.find(a => a.id === argv[0]);
        if (!item || item.status !== 'pending' || Date.parse(item.expiresAt) <= Date.now()) throw new Error('Request expired or already reviewed');
        item.status = argv[1] === 'approve' ? 'approved' : 'denied';
        if (item.status === 'denied') { item.idempotencyKey = item.args._idempotencyKey as string | undefined; item.args = {}; }
        return item;
      }); break;
    }
    case 'approve-execute': arity(1); output = await executeApproved(argv[0], true); break;
    case 'execute-approved': arity(1); output = await executeApproved(argv[0], false); break;
    case 'set-approval-mode': {
      arity(1); if (!['manual', 'auto-write'].includes(argv[0])) throw new Error('Expected manual or auto-write');
      output = await transaction(state => { state.config.approvalMode = argv[0] as ApprovalMode; return state.config; }); break;
    }
    case 'set-enabled': {
      arity(2); const enabled = boolean(argv[1]);
      output = await transaction(state => { if (!byName.has(argv[0])) throw new Error('Unknown tool'); state.config.disabledTools = state.config.disabledTools.filter(x => x !== argv[0]); if (!enabled) state.config.disabledTools.push(argv[0]); return state.config; }); break;
    }
    case 'set-trusted': {
      arity(2); const trusted = boolean(argv[1]);
      output = await transaction(state => { const tool = byName.get(argv[0]); if (!tool || tool.riskLevel !== 'write') throw new Error('Only medium-risk writes can be trusted'); state.config.trustedWriteTools = state.config.trustedWriteTools.filter(x => x !== argv[0]); if (trusted) state.config.trustedWriteTools.push(argv[0]); return state.config; }); break;
    }
    case 'add-root': {
      arity(1); const root = await realpath(argv[0]); const home = await realpath(homedir());
      if (root === '/' || root === home || !(await stat(root)).isDirectory()) throw new Error('Select a narrower existing folder');
      output = await transaction(state => { if (!state.config.roots.includes(root)) state.config.roots.push(root); return state.config; }); break;
    }
    case 'remove-root': arity(1); output = await transaction(state => { state.config.roots = state.config.roots.filter(root => root !== argv[0]); return state.config; }); break;
    case 'permissions-request': {
      arity(1); if (!['calendar', 'reminders', 'contacts', 'accessibility', 'screenRecording'].includes(argv[0])) throw new Error('Unknown system permission');
      output = await nativeCall('permissions_request', { permission: argv[0] }); break;
    }
    case 'activity': {
      arity(0);
      try { output = (await readFile(join(stateDir, 'audit.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).slice(-100).map(line => JSON.parse(line)).reverse(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; output = []; } break;
    }
    default: throw new Error('Usage: bridge call TOOL JSON [SOURCE] | overview | config | set-approval-mode manual/auto-write | approvals | approve-execute ID | review ID approve/deny | activity | permissions-request NAME');
  }
  process.stdout.write(JSON.stringify(output) + '\n');
} catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
