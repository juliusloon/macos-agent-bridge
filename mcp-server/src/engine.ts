import AjvModule from 'ajv';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { registry, byName } from '../../shared/registry.js';
import { BridgeError, failure, type Params, type ToolResult } from './types.js';
import { audit, digest, getConfig, transaction, stateDir, readSnapshot, receiptKeyFor, type Config, type Receipt } from './state.js';
import { nativeCall } from './native.js';
import { fileAction, scopedPath } from './adapters/files.js';
import { approvalGuidance } from '../../shared/approval.js';
import { bridgeVersion } from '../../shared/version.js';
import { networkAction } from './adapters/network.js';
import { systemStatus } from './adapters/system.js';
const Ajv = AjvModule.default;
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(registry.map(t => [t.name, ajv.compile(t.inputSchema)]));
const outputValidators = new Map(registry.map(t => [t.name, ajv.compile(t.outputSchema)]));
const exec = promisify(execFile);
export type Executor = (name: string, args: Params) => Promise<unknown>;
const inFlight = new Map<string, { hash: string; promise: Promise<ToolResult> }>();
// Only used when a completed result could not be persisted; bounded and source-checked.
const retainedReceipts = new Map<string, Receipt>();
function retainReceipt(key: string, receipt: Receipt) {
  for (const [storedKey, stored] of retainedReceipts) if (Date.parse(stored.createdAt) < Date.now() - 86400000) retainedReceipts.delete(storedKey);
  retainedReceipts.set(key, receipt);
  while (retainedReceipts.size > 64) retainedReceipts.delete(retainedReceipts.keys().next().value!);
}
const uncertainCodes = new Set(['NATIVE_TIMEOUT', 'NATIVE_DISCONNECTED', 'EPIPE', 'ECONNRESET', 'OUTPUT_LIMIT', 'OUTPUT_SCHEMA_VIOLATION']);
function receiptResult(receipt: Receipt): ToolResult {
  if (!receipt.result || Date.parse(receipt.createdAt) < Date.now() - 86400000) throw new BridgeError('IDEMPOTENCY_RESULT_EXPIRED', 'A matching action was already executed; cached result has expired. Inspect native state, do not repeat blindly.');
  return receipt.result;
}
function runningState(receipt: Receipt): 'running' | 'indeterminate' {
  if (receipt.status === 'indeterminate' || !receipt.ownerPid) return 'indeterminate';
  try { process.kill(receipt.ownerPid, 0); return 'running'; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'indeterminate' : 'running'; }
}
export class Engine {
  constructor(private source: string, private executor?: Executor) {}
  async call(name: string, args: Params): Promise<ToolResult> {
    const started = Date.now(); let result: ToolResult;
    try {
      const tool = byName.get(name);
      const key = args && typeof args._idempotencyKey === 'string' ? args._idempotencyKey : undefined;
      const flightKey = tool && tool.riskLevel !== 'read' && key ? JSON.stringify([stateDir, this.source, name, key]) : undefined;
      const semantic = { ...args }; delete semantic._approvalId;
      const hash = flightKey ? digest(name, semantic) : '';
      const existing = flightKey ? inFlight.get(flightKey) : undefined;
      if (existing && existing.hash === hash) result = await existing.promise;
      else {
        const promise = this.run(name, args);
        if (flightKey && !existing) inFlight.set(flightKey, { hash, promise });
        try { result = await promise; } finally { if (flightKey && inFlight.get(flightKey)?.promise === promise) inFlight.delete(flightKey); }
      }
    } catch (error) { result = failure(name, error); }
    // Audit/storage diagnostics must never turn a completed side effect into a retryable failure.
    try { await audit(this.source, name, result, Date.now() - started); }
    catch { process.stderr.write('macOS Agent Bridge: audit could not be saved; the returned operation result remains authoritative.\n'); }
    return result;
  }
  private async waitForReceipt(receiptKey: string): Promise<ToolResult> {
    const deadline = Date.now() + 5000;
    while (true) {
      const receipt = retainedReceipts.get(receiptKey) || (await readSnapshot()).receipts[receiptKey];
      if (receipt?.source && receipt.source !== this.source) throw new BridgeError('IDEMPOTENCY_SOURCE_MISMATCH', 'This operation belongs to a different client.');
      if (!receipt || runningState(receipt) === 'indeterminate' && receipt.status !== 'done') throw new BridgeError('ACTION_INDETERMINATE', 'The previous action has an uncertain outcome. Inspect native state before submitting a new key.');
      if (receipt.status === 'done') return receiptResult(receipt);
      if (Date.now() >= deadline) throw new BridgeError('ACTION_IN_PROGRESS', 'The matching action is still running. Poll bridge_get_operation or retry the identical arguments and key; do not create another operation.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  private async run(name: string, input: Params): Promise<ToolResult> {
    const tool = byName.get(name); if (!tool) throw new BridgeError('UNKNOWN_TOOL', 'Unknown tool');
    const validate = validators.get(name)!; if (!validate(input)) throw new BridgeError('INVALID_ARGUMENTS', 'Arguments failed JSON Schema validation.', validate.errors?.map(e => ({ path: e.instancePath, message: e.message })));
    const args = { ...input }; const approvalId = args._approvalId; delete args._approvalId;
    const key = args._idempotencyKey as string | undefined;
    const semantic: Params = { ...args }; delete semantic._idempotencyKey;
    this.validateSemantics(semantic);
    const hash = digest(name, args); let receiptKey = ''; let config: Config;
    if (tool.riskLevel === 'read') {
      config = await getConfig();
      if (config.disabledTools.includes(name)) throw new BridgeError('TOOL_DISABLED', 'This capability has been disabled in macOS Agent Bridge.');
    } else {
      const policy = await transaction(state => {
        const config = state.config;
        if (config.disabledTools.includes(name)) throw new BridgeError('TOOL_DISABLED', 'This capability has been disabled in macOS Agent Bridge.');
        receiptKey = receiptKeyFor(state, name, key!, this.source);
        const receipt = retainedReceipts.get(receiptKey) || state.receipts[receiptKey];
        if (receipt) {
          if (receipt.source && receipt.source !== this.source) throw new BridgeError('IDEMPOTENCY_SOURCE_MISMATCH', 'This operation belongs to a different client.');
          if (receipt.digest !== hash) throw new BridgeError('IDEMPOTENCY_CONFLICT', 'The idempotency key was used with different arguments.');
          if (receipt.status === 'done') return { cached: receiptResult(receipt), config };
          return { waiting: true as const, config };
        }
        const matching = state.approvals.filter(a => a.digest === hash && a.tool === name && a.source === this.source);
        if (matching.some(a => a.status === 'denied')) throw new BridgeError('ACTION_DENIED', 'The user denied this exact action. Do not resubmit it automatically.');
        const approved = matching.find(a => a.status === 'approved' && (approvalId === undefined || a.id === approvalId) && Date.parse(a.expiresAt) > Date.now());
        const automatic = tool.riskLevel === 'write' && (config.approvalMode === 'auto-write' || config.trustedWriteTools.includes(name));
        if (!approved && !automatic) {
          let request = matching.find(a => a.status === 'pending' && Date.parse(a.expiresAt) > Date.now());
          if (!request) {
            if (state.approvals.filter(a => a.status === 'pending' || a.status === 'approved').length >= 100) throw new BridgeError('APPROVAL_QUEUE_FULL', 'Review pending requests before adding more actions.');
            request = { id: randomUUID(), tool: name, args, digest: hash, source: this.source, status: 'pending', idempotencyKey: key, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
            state.approvals.push(request);
          }
          return { pending: request.id, expiresAt: request.expiresAt, config };
        }
        for (const request of matching) if (request.status === 'pending' || request.status === 'approved') { request.status = 'consumed'; request.idempotencyKey = key; request.args = {}; }
        state.receipts[receiptKey] = { digest: hash, status: 'running', source: this.source, ownerPid: process.pid, createdAt: new Date().toISOString() };
        return { config };
      });
      config = policy.config;
      if ('cached' in policy) {
        const retained = retainedReceipts.get(receiptKey);
        if (retained) {
          try { await transaction(state => { state.receipts[receiptKey] = retained; }); retainedReceipts.delete(receiptKey); }
          catch { /* retain the completed outcome until storage recovers */ }
        }
        return policy.cached!;
      }
      if ('waiting' in policy) return this.waitForReceipt(receiptKey);
      if ('pending' in policy) return { status: 'confirmation_required', tool: name, version: tool.version, data: { approvalId: policy.pending, expiresAt: policy.expiresAt, ...approvalGuidance(this.source) }, error: null };
    }
    let result: ToolResult;
    try {
      const data = await (this.executor ? this.executor(name, semantic) : this.execute(name, semantic, config));
      result = { status: 'ok', tool: name, version: tool.version, data, error: null };
      const outputValid = outputValidators.get(name)!;
      if (!outputValid(result)) throw new BridgeError('OUTPUT_SCHEMA_VIOLATION', 'Native adapter returned data inconsistent with its versioned output contract.', outputValid.errors?.map(e => ({ path: e.instancePath, message: e.message })));
    } catch (error) { result = failure(name, error); }
    if (receiptKey) {
      const uncertain = uncertainCodes.has(result.error?.code || '');
      const receipt: Receipt = { digest: hash, source: this.source, ownerPid: process.pid, status: uncertain ? 'indeterminate' : 'done', ...(uncertain ? {} : { result }), createdAt: new Date().toISOString() };
      try { await transaction(state => { state.receipts[receiptKey] = receipt; }); retainedReceipts.delete(receiptKey); }
      catch {
        retainReceipt(receiptKey, receipt);
        process.stderr.write('macOS Agent Bridge: result receipt could not be saved; this process retained the outcome. Inspect actual state if the process restarts.\n');
      }
    }
    return result;
  }
  private validateSemantics(args: Params) {
    for (const field of ['text', 'content']) if (typeof args[field] === 'string' && Buffer.byteLength(args[field]) > 1048576) throw new BridgeError('TEXT_LIMIT', 'Text payload must be at most 1 MiB in UTF-8.');
    if (args.timezone !== undefined) { try { new Intl.DateTimeFormat('en-US', { timeZone: String(args.timezone) }); } catch { throw new BridgeError('INVALID_TIMEZONE', 'Use a valid IANA time zone.'); } }
    for (const field of ['start', 'end', 'due']) if (args[field] !== undefined) {
      const raw = String(args[field]); const parsed = Date.parse(raw); const offset = raw.match(/([+-])(\d{2}):(\d{2})$/);
      const offsetMinutes = offset ? (offset[1] === '+' ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
      if (!Number.isFinite(parsed) || new Date(parsed + offsetMinutes * 60000).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new BridgeError('INVALID_DATE', `Invalid ${field} date.`);
    }
    if (args.start && args.end) { const duration = Date.parse(String(args.end)) - Date.parse(String(args.start)); if (duration <= 0 || duration > 366 * 86400000) throw new BridgeError('INVALID_RANGE', 'end must be after start and within 366 days.'); }
    if ((args.due || args.start || args.end) && !args.timezone) throw new BridgeError('TIMEZONE_REQUIRED', 'Time mutations and ranges require an explicit IANA timezone.');
    if (args.url) { let url: URL; try { url = new URL(String(args.url)); } catch { throw new BridgeError('INVALID_URL', 'Invalid URL.'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BridgeError('URL_SCHEME_FORBIDDEN', 'Only HTTP(S) URLs without embedded credentials are accepted.'); }
  }
  private async execute(name: string, args: Params, config: Config): Promise<unknown> {
    if (name === 'bridge_list_capabilities') return { capabilities: registry.filter(t => !args.adapter || t.adapter === args.adapter).map(t => { const { inputSchema, outputSchema, ...meta } = t; return { ...meta, ...(args.includeSchemas ? { inputSchema, outputSchema } : {}), enabled: !config.disabledTools.includes(t.name) }; }) };
    if (name === 'bridge_diagnostics') { let helper; try { helper = await nativeCall('diagnostics'); } catch (e) { helper = { status: 'error', message: e instanceof Error ? e.message : String(e) }; } return { version: bridgeVersion, protocol: 'stdio', source: this.source, stateDir, config, helper }; }
    if (name === 'bridge_get_operation') {
      const tool = String(args.tool); const key = String(args.idempotencyKey);
      if (!byName.has(tool) || byName.get(tool)!.riskLevel === 'read') throw new BridgeError('INVALID_OPERATION_TOOL', 'Operation lookup requires the name of a write tool.');
      const snapshot = await readSnapshot();
      const operationKey = receiptKeyFor(snapshot, tool, key, this.source);
      const receipt = retainedReceipts.get(operationKey) || snapshot.receipts[operationKey];
      const base = { tool, idempotencyKey: key };
      if (receipt) {
        if (receipt.source && receipt.source !== this.source) return { ...base, state: 'not_found' };
        // Legacy receipts lack an owner; polling by key alone must not reveal their contents.
        if (!receipt.source) return { ...base, state: 'indeterminate' };
        if (receipt.status === 'done') return { ...base, state: !receipt.result || Date.parse(receipt.createdAt) < Date.now() - 86400000 ? 'expired' : 'done', ...(receipt.result && Date.parse(receipt.createdAt) >= Date.now() - 86400000 ? { result: receipt.result } : {}) };
        return { ...base, state: runningState(receipt) };
      }
      const request = [...snapshot.approvals].reverse().find(a => a.tool === tool && a.source === this.source && (a.idempotencyKey || a.args._idempotencyKey) === key && a.status !== 'consumed');
      return request ? { ...base, state: request.status === 'denied' ? 'denied' : Date.parse(request.expiresAt) <= Date.now() ? 'expired' : request.status, approvalId: request.id, expiresAt: request.expiresAt } : { ...base, state: 'not_found' };
    }
    if (name.startsWith('web_') || name.startsWith('network_')) return networkAction(name, args);
    if (name === 'system_status') return systemStatus();
    if (name.startsWith('finder_')) return fileAction(name, args, config.roots);
    if (name === 'system_capture_screen') { args.outputPath = await scopedPath(args.outputPath, config.roots, true); if (!String(args.outputPath).toLowerCase().endsWith('.png')) throw new BridgeError('PNG_REQUIRED', 'outputPath must end in .png'); }
    if (name === 'system_run_command') { const commands: Record<string, [string, string[]]> = { disk_usage: ['/bin/df', ['-h']], battery: ['/usr/bin/pmset', ['-g', 'batt']], uptime: ['/usr/bin/uptime', []] }; const [file, argv] = commands[String(args.command)]; const { stdout } = await exec(file, argv, { timeout: 10000, maxBuffer: 65536 }); return { command: args.command, stdout: stdout.trim() }; }
    return nativeCall(name, args);
  }
}
