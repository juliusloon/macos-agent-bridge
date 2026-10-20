import { Action, ActionPanel, Color, Detail, Form, Icon, List, Toast, showToast } from '@raycast/api';
import { useEffect, useRef, useState } from 'react';
import { admin, call, type Approval, type Capability, type Config, type Diagnostics, type Overview } from './client';
import Approvals from './approvals';

async function reportError(title: string, error: unknown) {
  await showToast({ style: Toast.Style.Failure, title, message: error instanceof Error ? error.message : String(error) });
}

function Roots({ roots, changed }: { roots: string[]; changed: (config: Config) => void }) {
  const [folders, setFolders] = useState(roots);
  const busy = useRef(false);
  async function update(command: 'add-root' | 'remove-root', path: string) {
    if (busy.current) return;
    busy.current = true;
    try {
      const config = await admin<Config>(command, path);
      setFolders(config.roots); changed(config);
      await showToast({ style: Toast.Style.Success, title: command === 'add-root' ? '已授权文件夹' : '已移除授权' });
    } catch (error) { await reportError('无法更新文件夹授权', error); }
    finally { busy.current = false; }
  }
  return <List navigationTitle="授权文件夹">
    {folders.map(root => <List.Item key={root} title={root} icon={Icon.Folder} actions={<ActionPanel><Action title="移除文件夹授权" style={Action.Style.Destructive} onAction={() => update('remove-root', root)} /></ActionPanel>} />)}
    <List.Item title="添加授权文件夹" icon={Icon.Plus} actions={<ActionPanel><Action.Push title="选择文件夹" target={<Form actions={<ActionPanel><Action.SubmitForm title="授权文件夹" onSubmit={async (values: { folders: string[] }) => { if (values.folders[0]) await update('add-root', values.folders[0]); }} /></ActionPanel>}><Form.FilePicker id="folders" title="允许 Agent 访问的文件夹" canChooseFiles={false} canChooseDirectories allowMultipleSelection={false} /></Form>} /></ActionPanel>} />
  </List>;
}

function CapabilityDetail({ tool, config: initialConfig, changed }: { tool: Capability; config: Config; changed: (config: Config) => void }) {
  const [config, setConfig] = useState(initialConfig);
  const busy = useRef(false);
  const enabled = !config.disabledTools.includes(tool.name);
  const trusted = config.trustedWriteTools.includes(tool.name);
  const approval = tool.riskLevel === 'read' ? '直接执行' : tool.riskLevel === 'high' ? '逐次确认具体请求' : config.approvalMode === 'auto-write' || trusted ? '自动批准并执行' : '逐次确认具体请求';
  async function update(command: string, value: boolean) {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await admin<Config>(command, tool.name, String(value));
      setConfig(next); changed(next);
      await showToast({ style: Toast.Style.Success, title: '设置已更新' });
    } catch (error) { await reportError('设置更新失败', error); }
    finally { busy.current = false; }
  }
  const markdown = `# ${tool.name}\n\n${tool.description}\n\n- 能力分类：${tool.adapter}\n- 状态：${enabled ? '已启用' : '已停用'}\n- 当前批准方式：${approval}\n- 系统权限：${tool.requiredPermissions.join(', ') || '无需额外授权'}\n- 版本：${tool.version}\n\n## 输入参数\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\`\n\n普通写入遵循自动批准模式或单独信任设置。发送、删除等高风险操作需要确认具体请求。实际可用性取决于系统权限、应用和账户状态。`;
  return <Detail markdown={markdown} actions={<ActionPanel>
    <Action title={enabled ? '停用能力' : '启用能力'} onAction={() => update('set-enabled', !enabled)} />
    {tool.riskLevel === 'write' && <Action title={trusted ? '移除此能力的单独信任' : '始终信任此普通写入能力'} onAction={() => update('set-trusted', !trusted)} />}
  </ActionPanel>} />;
}

const networkHelp = `# 联网能力\n\n在 AI Chat 中可以直接请求：\n\n> 搜索 TypeScript 官方发布说明，给出来源链接。\n\n> 读取这个网页并总结正文。\n\n> 检查 example.com 的 DNS 和 HTTPS 连通性。\n\n- **web_search**：搜索公开网页并返回标题、链接和摘要。\n- **web_fetch**：读取公开 HTTP(S) 页面、文本或 JSON。\n- **network_check**：诊断 DNS 与 HTTP(S) 连接。\n\n这些工具由 Bridge 直接联网，无需启动 Safari。网络超时、站点限制和不支持的响应会明确报告；网页内容不会作为本地执行指令。`;

export default function Bridge() {
  const [tools, setTools] = useState<Capability[]>([]);
  const [config, setConfig] = useState<Config>();
  const [diagnostics, setDiagnostics] = useState<Diagnostics>();
  const [loading, setLoading] = useState(true);
  const [pendingCount, setPendingCount] = useState<number>();
  const [approvalError, setApprovalError] = useState('');
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const active = useRef(true);
  const refreshBusy = useRef(false);
  const approvalsBusy = useRef(false);
  const diagnosticsBusy = useRef(false);
  const policyBusy = useRef(false);

  async function refreshApprovals() {
    if (approvalsBusy.current || refreshBusy.current) return;
    approvalsBusy.current = true;
    try {
      const approvals = await admin<Approval[]>('approvals');
      if (active.current) { setPendingCount(approvals.length); setApprovalError(''); }
    } catch (error) {
      if (active.current) { setPendingCount(undefined); setApprovalError(error instanceof Error ? error.message : String(error)); }
    } finally { approvalsBusy.current = false; }
  }

  async function refreshDiagnostics() {
    if (diagnosticsBusy.current) return;
    diagnosticsBusy.current = true; setDiagnosticLoading(true);
    try {
      const next = await call<Diagnostics>('bridge_diagnostics');
      if (active.current) setDiagnostics(next);
    } catch (error) { if (active.current) await reportError('无法读取系统诊断', error); }
    finally { diagnosticsBusy.current = false; if (active.current) setDiagnosticLoading(false); }
  }

  async function refresh() {
    if (refreshBusy.current) return;
    refreshBusy.current = true; setLoading(true);
    try {
      const overview = await admin<Overview>('overview');
      if (active.current) {
        setTools(overview.capabilities); setConfig(overview.config);
        setPendingCount(overview.approvals.length); setApprovalError('');
      }
    } catch (error) { if (active.current) await reportError('无法连接 Bridge', error); }
    finally { refreshBusy.current = false; if (active.current) setLoading(false); }
  }

  async function changeApprovalMode() {
    if (!config || policyBusy.current) return;
    policyBusy.current = true;
    try {
      const next = await admin<Config>('set-approval-mode', config.approvalMode === 'auto-write' ? 'manual' : 'auto-write');
      if (active.current) setConfig(next);
      await showToast({ style: Toast.Style.Success, title: next.approvalMode === 'auto-write' ? '普通写入已自动批准' : '已切换为按工具确认' });
    } catch (error) { if (active.current) await reportError('批准模式更新失败', error); }
    finally { policyBusy.current = false; }
  }

  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = setInterval(() => void refreshApprovals(), 5000);
    return () => { active.current = false; clearInterval(timer); };
  }, []);

  const automatic = config?.approvalMode === 'auto-write';
  const permissions = diagnostics?.helper.permissions || {};
  const networkTools = tools.filter(tool => tool.adapter === 'network');
  function renderTool(tool: Capability) {
    const enabled = config ? !config.disabledTools.includes(tool.name) : tool.enabled;
    const automaticTool = tool.riskLevel === 'write' && (automatic || config?.trustedWriteTools.includes(tool.name));
    const label = tool.riskLevel === 'read' ? '读取' : tool.riskLevel === 'high' ? '需确认' : automaticTool ? '自动执行' : '需确认';
    return <List.Item key={tool.name} title={tool.name} subtitle={tool.description} icon={{ source: enabled ? Icon.CheckCircle : Icon.MinusCircle, tintColor: enabled ? Color.Green : Color.SecondaryText }} accessories={[{ tag: { value: label, color: tool.riskLevel === 'high' ? Color.Red : automaticTool ? Color.Green : tool.riskLevel === 'write' ? Color.Orange : Color.Blue } }]} actions={<ActionPanel>{config && <Action.Push title="查看能力与授权设置" target={<CapabilityDetail tool={tool} config={config} changed={setConfig} />} />}</ActionPanel>} />;
  }

  return <List isLoading={loading} navigationTitle="macOS Agent Bridge" searchBarPlaceholder="搜索自动批准、联网、待确认操作与系统能力">
    <List.Section title="执行方式">
      <List.Item id="approval-mode" title={automatic ? '自动批准 · 已开启' : '自动批准 · 按工具确认'} subtitle={automatic ? '普通写入直接执行；高风险操作逐次确认' : `可一键开启普通写入自动批准 · ${config?.trustedWriteTools.length || 0} 个单独信任能力`} icon={Icon.CheckCircle} keywords={['自动', '批准', '免确认', 'trust', 'auto']} actions={<ActionPanel><Action title={automatic ? '切换为按工具确认' : '开启普通写入自动批准'} onAction={changeApprovalMode} /><Action title="刷新设置" icon={Icon.ArrowClockwise} onAction={refresh} /></ActionPanel>} />
      <List.Item id="approvals" title="待确认操作" subtitle={approvalError || (pendingCount === undefined ? '正在读取…' : `${pendingCount} 个待处理请求 · 审阅参数后一次批准并执行`)} icon={Icon.ExclamationMark} keywords={['Review Agent Actions', '审批', '审查', '批准']} actions={<ActionPanel><Action.Push title="查看待确认操作" target={<Approvals />} /><Action title="刷新请求" icon={Icon.ArrowClockwise} onAction={refreshApprovals} /></ActionPanel>} />
    </List.Section>
    <List.Section title={`联网 · ${networkTools.length} 个工具`}>
      <List.Item title="联网使用说明" subtitle="搜索网页、读取正文、检查连接" icon={Icon.Globe} keywords={['web', '网络', '搜索', '联网']} actions={<ActionPanel><Action.Push title="查看联网用法" target={<Detail markdown={networkHelp} />} /></ActionPanel>} />
      {networkTools.map(renderTool)}
    </List.Section>
    <List.Section title="运行与权限">
      <List.Item title="Bridge 诊断" subtitle={diagnosticLoading ? '正在检查系统 Helper…' : diagnostics?.helper.bundleId || diagnostics?.helper.message || '按需检查系统 Helper 与权限'} icon={Icon.Heartbeat} actions={<ActionPanel><Action title="检查系统状态" icon={Icon.ArrowClockwise} onAction={refreshDiagnostics} />{diagnostics && <Action.Push title="查看诊断结果" target={<Detail markdown={`# macOS Agent Bridge\n\n\`\`\`json\n${JSON.stringify(diagnostics, null, 2)}\n\`\`\``} />} />}</ActionPanel>} />
      <List.Item title="文件访问范围" subtitle={`${config?.roots.length || 0} 个已授权文件夹`} icon={Icon.Folder} actions={<ActionPanel><Action.Push title="管理文件夹" target={<Roots roots={config?.roots || []} changed={setConfig} />} /></ActionPanel>} />
      {['calendar', 'reminders', 'contacts', 'accessibility', 'screenRecording'].map(permission => <List.Item key={permission} title={`权限 · ${permission}`} subtitle={String(permissions[permission] ?? '待检查')} icon={Icon.Lock} actions={<ActionPanel><Action title="请求系统权限" onAction={async () => { try { await admin('permissions-request', permission); await refreshDiagnostics(); } catch (error) { await reportError('权限请求未完成', error); } }} /><Action title="检查权限状态" onAction={refreshDiagnostics} /></ActionPanel>} />)}
    </List.Section>
    <List.Section title={`本机与管理能力 · ${tools.length - networkTools.length}`} subtitle="系统权限与应用状态可在诊断中查看">
      {tools.filter(tool => tool.adapter !== 'network').map(renderTool)}
    </List.Section>
  </List>;
}
