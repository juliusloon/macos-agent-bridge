import { Action, ActionPanel, Color, Detail, Icon, List, Toast, showToast } from '@raycast/api';
import { useEffect, useState } from 'react';
import { admin } from './client';
interface Entry { at: string; source: string; tool: string; status: string; errorCode?: string; durationMs: number }
export default function Activity() {
  const [entries, setEntries] = useState<Entry[]>([]); const [loading, setLoading] = useState(true);
  async function refresh() { try { setEntries(await admin<Entry[]>('activity')); } catch (e) { await showToast({ style: Toast.Style.Failure, title: '无法读取执行日志', message: String(e) }); } finally { setLoading(false); } }
  useEffect(() => { void refresh(); }, []);
  return <List isLoading={loading} navigationTitle="Agent 操作记录"><List.EmptyView title="暂无操作记录" icon={Icon.Clock} />{entries.map((entry, i) => <List.Item key={`${entry.at}-${i}`} title={entry.tool} subtitle={`${entry.source} · ${new Date(entry.at).toLocaleString()}`} icon={{ source: entry.status === 'ok' ? Icon.CheckCircle : Icon.ExclamationMark, tintColor: entry.status === 'ok' ? Color.Green : Color.Orange }} accessories={[{ text: entry.errorCode || entry.status }]} actions={<ActionPanel><Action.Push title="查看记录" target={<Detail markdown={`# ${entry.tool}\n\n\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\`\n\n审计日志不保存请求正文、令牌或原生返回内容。`} />} /><Action title="刷新" onAction={refresh} /></ActionPanel>} />)}</List>;
}
