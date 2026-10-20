import { Action, ActionPanel, Detail, Icon, List, Toast, showToast } from '@raycast/api';
import { useEffect, useRef, useState } from 'react';
import { admin, type Approval, type Result } from './client';

export default function Approvals() {
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<{ response: Result; item: Approval }>();
  const [error, setError] = useState('');
  const busy = useRef(false);
  const refreshing = useRef(false);
  const active = useRef(true);
  const generation = useRef(0);

  async function refresh(interactive = false) {
    if (refreshing.current || busy.current) return;
    refreshing.current = true;
    const version = generation.current;
    if (interactive) setLoading(true);
    try {
      const requests = await admin<Approval[]>('approvals');
      if (active.current && version === generation.current) { setItems(requests); setError(''); }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (active.current) {
        setError(message);
        if (interactive) await showToast({ style: Toast.Style.Failure, title: '无法读取待确认请求', message });
      }
    } finally { refreshing.current = false; if (active.current) setLoading(false); }
  }

  useEffect(() => {
    active.current = true;
    if (!result) void refresh(true);
    const timer = result ? undefined : setInterval(() => void refresh(), 5000);
    return () => { active.current = false; if (timer) clearInterval(timer); };
  }, [result]);

  async function approve(item: Approval) {
    if (busy.current) return;
    busy.current = true; generation.current++; setExecuting(true);
    try {
      const response = await admin<Result>('approve-execute', item.id);
      if (!active.current) return;
      setResult({ response, item });
      if (response.status === 'ok') setItems(current => current.filter(request => request.id !== item.id));
      await showToast({ style: response.status === 'ok' ? Toast.Style.Success : Toast.Style.Failure, title: response.status === 'ok' ? '操作已完成' : '操作未完成', message: response.error?.message });
    } catch (failure) {
      if (active.current) await showToast({ style: Toast.Style.Failure, title: '执行未完成，请检查操作状态', message: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      busy.current = false;
      if (active.current) { setExecuting(false); void refresh(); }
    }
  }

  async function deny(item: Approval) {
    if (busy.current) return;
    busy.current = true; generation.current++; setExecuting(true);
    try {
      await admin('review', item.id, 'deny');
      if (active.current) { setItems(current => current.filter(request => request.id !== item.id)); setError(''); }
    } catch (failure) {
      if (active.current) await showToast({ style: Toast.Style.Failure, title: '拒绝操作失败', message: failure instanceof Error ? failure.message : String(failure) });
    } finally { busy.current = false; if (active.current) { setExecuting(false); void refresh(); } }
  }

  if (result) {
    const { response, item } = result;
    const success = response.status === 'ok';
    const lookup = { tool: item.tool, idempotencyKey: item.args._idempotencyKey };
    return <Detail markdown={`# ${success ? '操作已完成' : '操作未完成'}\n\n${success ? '原 AI Chat 可使用相同参数和幂等键取得保存的结果，也可查询操作状态。' : '请先查询操作状态并检查实际结果。保留原幂等键，避免重复执行。'}\n\n\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``} actions={<ActionPanel><Action title="返回待确认请求" onAction={() => setResult(undefined)} /><Action.CopyToClipboard title="复制执行结果" content={JSON.stringify(response, null, 2)} /><Action.CopyToClipboard title="复制状态查询参数" content={JSON.stringify(lookup)} /></ActionPanel>} />;
  }
  return <List isLoading={loading || executing} isShowingDetail navigationTitle="待确认操作" actions={<ActionPanel><Action title="刷新请求" icon={Icon.ArrowClockwise} onAction={() => refresh(true)} /></ActionPanel>}>
    <List.EmptyView title={error ? '无法读取待确认操作' : '暂无待确认操作'} description={error || '需要确认的请求会显示在这里。已开启自动批准的普通写入将直接执行。'} icon={error ? Icon.ExclamationMark : Icon.CheckCircle} />
    {error && items.length > 0 && <List.Item title="请求刷新失败" subtitle={error} icon={Icon.ExclamationMark} actions={<ActionPanel><Action title="重新刷新" onAction={() => refresh(true)} /></ActionPanel>} />}
    {items.map(item => <List.Item key={item.id} title={typeof item.args.title === 'string' ? item.args.title : item.tool} subtitle={item.tool} icon={Icon.ExclamationMark} accessories={[{ text: item.status === 'pending' ? '待确认' : '已批准，待执行' }]} detail={<List.Item.Detail markdown={`# ${item.tool}\n\n来源：${item.source}\n\n请求：${item.id}\n\n有效至：${new Date(item.expiresAt).toLocaleString()}\n\n## 将执行的确切参数\n\n\`\`\`json\n${JSON.stringify(item.args, null, 2)}\n\`\`\`\n\n审阅上述参数后，选择“批准并执行”将立即执行此操作。相同幂等键只执行一次。`} />} actions={<ActionPanel><Action title="批准并执行" onAction={() => approve(item)} />{item.status === 'pending' && <Action title="拒绝操作" style={Action.Style.Destructive} onAction={() => deny(item)} />}<Action title="刷新" onAction={() => refresh(true)} /></ActionPanel>} />)}
  </List>;
}
