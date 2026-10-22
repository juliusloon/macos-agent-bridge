import { registry } from '../shared/registry.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
// Publish only the checked-in, redacted validation baseline. Raw machine evidence stays local.
const baseline = JSON.parse(await readFile('docs/capability-coverage.json', 'utf8')) as { records: { name: string; status: string; test: string }[] };
const previous = new Map(baseline.records.map(record => [record.name, record]));
const limits: Record<string, string> = {
  network: '公网HTTP(S)；系统代理及可关闭的HTTPS DNS回退；错误含原因/建议；最多3个已验证IP且共用总超时；解压≤2MiB；禁内网与JS；DuckDuckGo或Brave。',
  bridge: 'MCP stdio；Tinycast需单独启用/注册MCP；扩展导入不会自动启用AI工具。',
  calendar: '单次事件；更新/删除只影响API返回的该发生项；未测试重复事件系列、邀请/账户提供方差异。',
  reminders: '基本字段；不含子任务、地理围栏、重复规则；到期时间必须指定时区。',
  contacts: '基础名字/电话/邮箱；limited access仅返回可见联系人；修改替换电话/邮箱集合。',
  finder: '仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。',
  system: 'AppKit公共接口；窗口标题可能需Screen Recording；截图默认第一个显示器；只读纯文本剪贴板，无历史。',
  accessibility: '依赖目标应用AX支持；只支持读取选区/活动窗口和窗口位置尺寸；不提供通用GUI代理。',
  utility: '固定uptime/df/pmset；不接受动态shell字符串或任意代码。',
  shortcuts: '仅已安装名称；执行始终人工确认；工作流副作用由快捷指令本身决定。',
  notes: 'Notes公开JXA；正文为HTML；搜索标题；锁定/共享/账户异常尚需实机验证。',
  mail: '收件箱范围；最多扫描500条；发送仅报告提交Mail，不承诺投递成功；不自动发送可变草稿。',
  safari: 'Safari窗口/标签元数据；无任意JS执行、无跨浏览器控制。',
  music: '本机Music资料库和播放控制；不搜索Apple Music流媒体目录。'
};
const records = registry.map(t => {
  const known = previous.get(t.name);
  const status = known?.status ?? 'partial';
  const test = known?.test ?? '新增工具；尚未完成实机验证';
  const limit = t.name === 'system_status' ? 'Node本机时钟/OS接口；返回本地日期时间、UTC、IANA时区和偏移；离线可用，不依赖Helper；以本机系统时间为准。' : limits[t.adapter];
  return { name: t.name, adapter: t.adapter, status, permissions: t.requiredPermissions, risk: t.riskLevel, test, limit, version: t.version };
});
await mkdir('docs', { recursive: true });
await writeFile('docs/capability-coverage.json', JSON.stringify({ definitions: registry.length, note: '脱敏的开发验证摘要；implemented仅表示在说明边界内有验证，不代表全部宿主与原生读写均已验收。原始本机证据不公开。', records }, null, 2));
const rows = records.map(t => `| \`${t.name}\` | ${t.status} | ${t.adapter} | ${t.permissions.join(', ') || '无额外TCC'} | ${t.risk} | ${t.test} | ${t.limit} |`).join('\n');
await writeFile('docs/CAPABILITY_COVERAGE.md', `# 能力覆盖矩阵\n\n共 ${registry.length} 个工具定义。状态来自脱敏的开发验证摘要与集成测试；仅表示既有验证范围，不保证其他机器已获授权或相同结果。未授权或未实测的能力不计为完成。\n\n| 工具 | 状态 | 公共接口Adapter | 系统权限 | 读写/风险 | 测试证据 | 边界及Raycast差异 |\n|---|---|---|---|---|---|---|\n${rows}\n\n## Raycast 私有能力对照\n\n| 参考能力 | 状态 | 本项目边界 |\n|---|---|---|\n| Clipboard History | unsupported | 仅当前剪贴板；不读取Raycast历史数据库。 |\n| Raycast Notes | unsupported | 连接Apple Notes，不读Raycast Notes私有存储。 |\n| Raycast Snippets | unsupported | 未实现Raycast Snippets访问；Tinycast自带Snippets独立管理。 |\n| Raycast Quicklinks | unsupported | 不读Raycast私有Quicklinks；Tinycast自带Quicklinks独立管理。 |\n| Screen Awareness | partial | 提供PNG截图和窗口信息；未集成OCR/多模态推理。 |\n| Terminal | partial | 仅3种固定只读命令；不提供任意shell。 |\n| File Search | partial | 授权目录内有界文件名搜索；不复用Raycast索引。 |\n| AI Extensions导入Tinycast即自动获得工具 | unsupported | Tinycast0.12.1未接入tools/；使用其公开MCP设置，一次连接。 |\n\n验证方法与限制见 [验证范围](ACCEPTANCE.md)。原始本机证据不公开。\n`);
