import { Action, ActionPanel, Detail, Icon, List, Toast, showToast } from '@raycast/api';
import { useEffect, useState } from 'react';
import { call } from './client';
interface Event { id: string; title: string; start: string; end: string; calendarId: string; timezone: string | null; allDay: boolean }
export default function Calendar() {
  const [events, setEvents] = useState<Event[]>([]); const [error, setError] = useState<string>(); const [loading, setLoading] = useState(true);
  async function refresh() { setLoading(true); try { const start = new Date(); const end = new Date(start.getTime() + 7 * 86400000); const data = await call<{ events: Event[] }>('calendar_list_events', { start: start.toISOString(), end: end.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, limit: 200 }); setEvents(data.events); setError(undefined); } catch (e) { setError(String(e)); await showToast({ style: Toast.Style.Failure, title: '无法读取日历', message: String(e) }); } finally { setLoading(false); } }
  useEffect(() => { void refresh(); }, []);
  if (error) return <Detail markdown={`# 日历尚不可用\n\n${error}\n\n在 macOS Agent Bridge 命令中查看并请求日历权限。`} actions={<ActionPanel><Action title="重新读取" onAction={refresh} /></ActionPanel>} />;
  return <List isLoading={loading} navigationTitle="未来七天日程"><List.EmptyView title="未来七天没有可见日程" icon={Icon.Calendar} />{events.map((event, i) => <List.Item key={`${event.id}-${i}`} title={event.title || '无标题'} subtitle={`${new Date(event.start).toLocaleString()} → ${new Date(event.end).toLocaleString()}`} icon={Icon.Calendar} actions={<ActionPanel><Action.Push title="查看日程" target={<Detail markdown={`# ${event.title}\n\n开始：${new Date(event.start).toLocaleString()}\n\n结束：${new Date(event.end).toLocaleString()}\n\n时区：${event.timezone || '系统默认'}\n\n事件 ID：\`${event.id}\``} />} /><Action title="刷新" onAction={refresh} /></ActionPanel>} />)}</List>;
}
