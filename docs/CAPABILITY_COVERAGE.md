# 能力覆盖矩阵

共 63 个工具定义。状态来自脱敏的开发验证摘要与集成测试；仅表示既有验证范围，不保证其他机器已获授权或相同结果。未授权或未实测的能力不计为完成。

| 工具 | 状态 | 公共接口Adapter | 系统权限 | 读写/风险 | 测试证据 | 边界及Raycast差异 |
|---|---|---|---|---|---|---|
| `bridge_diagnostics` | implemented | bridge | 无额外TCC | read | 独立MCP实机通过 | MCP stdio；Tinycast需单独启用/注册MCP；扩展导入不会自动启用AI工具。 |
| `bridge_list_capabilities` | implemented | bridge | 无额外TCC | read | 独立Agent/协议实机通过 | MCP stdio；Tinycast需单独启用/注册MCP；扩展导入不会自动启用AI工具。 |
| `bridge_get_operation` | implemented | bridge | 无额外TCC | read | 独立MCP实机通过 | MCP stdio；Tinycast需单独启用/注册MCP；扩展导入不会自动启用AI工具。 |
| `web_fetch` | implemented | network | 无额外TCC | read | 独立MCP实机通过 | 公网HTTP(S)；系统代理及可关闭的HTTPS DNS回退；错误含原因/建议；最多3个已验证IP且共用总超时；解压≤2MiB；禁内网与JS；DuckDuckGo或Brave。 |
| `web_search` | implemented | network | 无额外TCC | read | 独立MCP实机通过 | 公网HTTP(S)；系统代理及可关闭的HTTPS DNS回退；错误含原因/建议；最多3个已验证IP且共用总超时；解压≤2MiB；禁内网与JS；DuckDuckGo或Brave。 |
| `network_check` | implemented | network | 无额外TCC | read | 独立MCP实机通过 | 公网HTTP(S)；系统代理及可关闭的HTTPS DNS回退；错误含原因/建议；最多3个已验证IP且共用总超时；解压≤2MiB；禁内网与JS；DuckDuckGo或Brave。 |
| `calendar_list_calendars` | implemented | calendar | calendar | read | 独立MCP实机通过 | 单次事件；更新/删除只影响API返回的该发生项；未测试重复事件系列、邀请/账户提供方差异。 |
| `calendar_list_events` | implemented | calendar | calendar | read | 独立MCP实机通过 | 单次事件；更新/删除只影响API返回的该发生项；未测试重复事件系列、邀请/账户提供方差异。 |
| `calendar_find_free_slots` | implemented | calendar | calendar | read | 独立MCP实机通过 | 单次事件；更新/删除只影响API返回的该发生项；未测试重复事件系列、邀请/账户提供方差异。 |
| `calendar_create_event` | blocked | calendar | calendar | write | 源码/编译验证；未完成本机成功调用 | 单次事件；更新/删除只影响API返回的该发生项；未测试重复事件系列、邀请/账户提供方差异。 |
| `calendar_update_event` | blocked | calendar | calendar | write | 源码/编译验证；未完成本机成功调用 | 单次事件；更新/删除只影响API返回的该发生项；未测试重复事件系列、邀请/账户提供方差异。 |
| `calendar_delete_event` | blocked | calendar | calendar | high | 源码/编译验证；未完成本机成功调用 | 单次事件；更新/删除只影响API返回的该发生项；未测试重复事件系列、邀请/账户提供方差异。 |
| `reminders_list_lists` | implemented | reminders | reminders | read | 独立MCP实机通过 | 基本字段；不含子任务、地理围栏、重复规则；到期时间必须指定时区。 |
| `reminders_list_tasks` | implemented | reminders | reminders | read | 独立MCP实机通过 | 基本字段；不含子任务、地理围栏、重复规则；到期时间必须指定时区。 |
| `reminders_create_task` | blocked | reminders | reminders | write | 源码/编译验证；未完成本机成功调用 | 基本字段；不含子任务、地理围栏、重复规则；到期时间必须指定时区。 |
| `reminders_update_task` | blocked | reminders | reminders | write | 源码/编译验证；未完成本机成功调用 | 基本字段；不含子任务、地理围栏、重复规则；到期时间必须指定时区。 |
| `reminders_complete_task` | blocked | reminders | reminders | write | 源码/编译验证；未完成本机成功调用 | 基本字段；不含子任务、地理围栏、重复规则；到期时间必须指定时区。 |
| `reminders_delete_task` | blocked | reminders | reminders | high | 源码/编译验证；未完成本机成功调用 | 基本字段；不含子任务、地理围栏、重复规则；到期时间必须指定时区。 |
| `contacts_search` | blocked | contacts | contacts | read | 源码/编译验证；未完成本机成功调用 | 基础名字/电话/邮箱；limited access仅返回可见联系人；修改替换电话/邮箱集合。 |
| `contacts_get` | blocked | contacts | contacts | read | 源码/编译验证；未完成本机成功调用 | 基础名字/电话/邮箱；limited access仅返回可见联系人；修改替换电话/邮箱集合。 |
| `contacts_create` | blocked | contacts | contacts | write | 源码/编译验证；未完成本机成功调用 | 基础名字/电话/邮箱；limited access仅返回可见联系人；修改替换电话/邮箱集合。 |
| `contacts_update` | blocked | contacts | contacts | high | 源码/编译验证；未完成本机成功调用 | 基础名字/电话/邮箱；limited access仅返回可见联系人；修改替换电话/邮箱集合。 |
| `finder_list_files` | implemented | finder | 无额外TCC | read | 独立MCP实机通过 | 仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。 |
| `finder_search_files` | implemented | finder | 无额外TCC | read | 真实临时文件系统集成测试通过 | 仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。 |
| `finder_read_file` | implemented | finder | 无额外TCC | read | 真实临时文件系统集成测试通过 | 仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。 |
| `finder_write_file` | implemented | finder | 无额外TCC | write | 真实临时文件系统集成测试通过 | 仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。 |
| `finder_create_directory` | implemented | finder | 无额外TCC | write | 真实临时文件系统集成测试通过 | 仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。 |
| `finder_copy_file` | implemented | finder | 无额外TCC | write | 真实临时文件系统集成测试通过 | 仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。 |
| `finder_move_file` | implemented | finder | 无额外TCC | write | 真实临时文件系统集成测试通过 | 仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。 |
| `finder_rename_file` | implemented | finder | 无额外TCC | write | 真实临时文件系统集成测试通过 | 仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。 |
| `finder_trash_file` | partial | finder | 无额外TCC | high | 源码/编译验证；未完成本机成功调用 | 仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。 |
| `finder_open_file` | partial | finder | 无额外TCC | write | 源码/编译验证；未完成本机成功调用 | 仅用户授权根目录；复制/移动/重命名仅普通文件、不覆盖；搜索最多10000项；文本读取≤1MiB。 |
| `clipboard_read` | partial | system | 无额外TCC | read | 源码/编译验证；未完成本机成功调用 | AppKit公共接口；窗口标题可能需Screen Recording；截图默认第一个显示器；只读纯文本剪贴板，无历史。 |
| `clipboard_write` | partial | system | 无额外TCC | write | 源码/编译验证；未完成本机成功调用 | AppKit公共接口；窗口标题可能需Screen Recording；截图默认第一个显示器；只读纯文本剪贴板，无历史。 |
| `system_get_frontmost_app` | implemented | system | 无额外TCC | read | 独立MCP实机通过 | AppKit公共接口；窗口标题可能需Screen Recording；截图默认第一个显示器；只读纯文本剪贴板，无历史。 |
| `system_list_apps` | implemented | system | 无额外TCC | read | 独立MCP实机通过 | AppKit公共接口；窗口标题可能需Screen Recording；截图默认第一个显示器；只读纯文本剪贴板，无历史。 |
| `system_open_app` | partial | system | 无额外TCC | write | 源码/编译验证；未完成本机成功调用 | AppKit公共接口；窗口标题可能需Screen Recording；截图默认第一个显示器；只读纯文本剪贴板，无历史。 |
| `system_activate_app` | partial | system | 无额外TCC | write | 源码/编译验证；未完成本机成功调用 | AppKit公共接口；窗口标题可能需Screen Recording；截图默认第一个显示器；只读纯文本剪贴板，无历史。 |
| `system_open_url` | partial | system | 无额外TCC | write | 源码/编译验证；未完成本机成功调用 | AppKit公共接口；窗口标题可能需Screen Recording；截图默认第一个显示器；只读纯文本剪贴板，无历史。 |
| `system_status` | implemented | system | 无额外TCC | read | 独立MCP实机通过 | Node本机时钟/OS接口；返回本地日期时间、UTC、IANA时区和偏移；离线可用，不依赖Helper；以本机系统时间为准。 |
| `system_run_command` | implemented | utility | 无额外TCC | read | 独立MCP实机通过 | 固定uptime/df/pmset；不接受动态shell字符串或任意代码。 |
| `system_get_selected_text` | blocked | accessibility | accessibility | read | 源码/编译验证；未完成本机成功调用 | 依赖目标应用AX支持；只支持读取选区/活动窗口和窗口位置尺寸；不提供通用GUI代理。 |
| `system_list_windows` | implemented | system | screenRecording | read | 独立MCP实机通过 | AppKit公共接口；窗口标题可能需Screen Recording；截图默认第一个显示器；只读纯文本剪贴板，无历史。 |
| `system_get_active_window` | blocked | accessibility | accessibility | read | 源码/编译验证；未完成本机成功调用 | 依赖目标应用AX支持；只支持读取选区/活动窗口和窗口位置尺寸；不提供通用GUI代理。 |
| `system_set_window_frame` | blocked | accessibility | accessibility | write | 源码/编译验证；未完成本机成功调用 | 依赖目标应用AX支持；只支持读取选区/活动窗口和窗口位置尺寸；不提供通用GUI代理。 |
| `system_capture_screen` | blocked | system | screenRecording | write | 源码/编译验证；未完成本机成功调用 | AppKit公共接口；窗口标题可能需Screen Recording；截图默认第一个显示器；只读纯文本剪贴板，无历史。 |
| `shortcuts_list` | implemented | shortcuts | 无额外TCC | read | 独立MCP实机通过 | 仅已安装名称；执行始终人工确认；工作流副作用由快捷指令本身决定。 |
| `shortcuts_run` | partial | shortcuts | shortcuts | high | 源码/编译验证；未完成本机成功调用 | 仅已安装名称；执行始终人工确认；工作流副作用由快捷指令本身决定。 |
| `notes_search` | partial | notes | automation:Notes | read | 源码/编译验证；未完成本机成功调用 | Notes公开JXA；正文为HTML；搜索标题；锁定/共享/账户异常尚需实机验证。 |
| `notes_get` | partial | notes | automation:Notes | read | 源码/编译验证；未完成本机成功调用 | Notes公开JXA；正文为HTML；搜索标题；锁定/共享/账户异常尚需实机验证。 |
| `notes_create` | partial | notes | automation:Notes | write | 源码/编译验证；未完成本机成功调用 | Notes公开JXA；正文为HTML；搜索标题；锁定/共享/账户异常尚需实机验证。 |
| `notes_append` | partial | notes | automation:Notes | write | 源码/编译验证；未完成本机成功调用 | Notes公开JXA；正文为HTML；搜索标题；锁定/共享/账户异常尚需实机验证。 |
| `mail_search` | partial | mail | automation:Mail | read | 源码/编译验证；未完成本机成功调用 | 收件箱范围；最多扫描500条；发送仅报告提交Mail，不承诺投递成功；不自动发送可变草稿。 |
| `mail_read` | partial | mail | automation:Mail | read | 源码/编译验证；未完成本机成功调用 | 收件箱范围；最多扫描500条；发送仅报告提交Mail，不承诺投递成功；不自动发送可变草稿。 |
| `mail_create_draft` | partial | mail | automation:Mail | write | 源码/编译验证；未完成本机成功调用 | 收件箱范围；最多扫描500条；发送仅报告提交Mail，不承诺投递成功；不自动发送可变草稿。 |
| `mail_send` | partial | mail | automation:Mail | high | 源码/编译验证；未完成本机成功调用 | 收件箱范围；最多扫描500条；发送仅报告提交Mail，不承诺投递成功；不自动发送可变草稿。 |
| `safari_list_tabs` | partial | safari | automation:Safari | read | 源码/编译验证；未完成本机成功调用 | Safari窗口/标签元数据；无任意JS执行、无跨浏览器控制。 |
| `safari_open_tab` | partial | safari | automation:Safari | write | 源码/编译验证；未完成本机成功调用 | Safari窗口/标签元数据；无任意JS执行、无跨浏览器控制。 |
| `safari_close_tab` | partial | safari | automation:Safari | high | 源码/编译验证；未完成本机成功调用 | Safari窗口/标签元数据；无任意JS执行、无跨浏览器控制。 |
| `music_status` | partial | music | automation:Music | read | 源码/编译验证；未完成本机成功调用 | 本机Music资料库和播放控制；不搜索Apple Music流媒体目录。 |
| `music_search` | partial | music | automation:Music | read | 源码/编译验证；未完成本机成功调用 | 本机Music资料库和播放控制；不搜索Apple Music流媒体目录。 |
| `music_play_track` | partial | music | automation:Music | write | 源码/编译验证；未完成本机成功调用 | 本机Music资料库和播放控制；不搜索Apple Music流媒体目录。 |
| `music_control` | partial | music | automation:Music | write | 源码/编译验证；未完成本机成功调用 | 本机Music资料库和播放控制；不搜索Apple Music流媒体目录。 |

## Raycast 私有能力对照

| 参考能力 | 状态 | 本项目边界 |
|---|---|---|
| Clipboard History | unsupported | 仅当前剪贴板；不读取Raycast历史数据库。 |
| Raycast Notes | unsupported | 连接Apple Notes，不读Raycast Notes私有存储。 |
| Raycast Snippets | unsupported | 未实现Raycast Snippets访问；Tinycast自带Snippets独立管理。 |
| Raycast Quicklinks | unsupported | 不读Raycast私有Quicklinks；Tinycast自带Quicklinks独立管理。 |
| Screen Awareness | partial | 提供PNG截图和窗口信息；未集成OCR/多模态推理。 |
| Terminal | partial | 仅3种固定只读命令；不提供任意shell。 |
| File Search | partial | 授权目录内有界文件名搜索；不复用Raycast索引。 |
| AI Extensions导入Tinycast即自动获得工具 | unsupported | Tinycast0.12.1未接入tools/；使用其公开MCP设置，一次连接。 |

验证方法与限制见 [验证范围](ACCEPTANCE.md)。原始本机证据不公开。
