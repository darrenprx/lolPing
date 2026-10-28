# Windows 启动诊断和自动恢复

程序入口在加载业务模块前写入日志。启动初始化失败时显示错误与日志位置；页面、预加载、渲染进程和输入助手故障也会留下技术事件。

## 沙箱读取安装目录失败

Windows 安装目录可能继承特定 AppContainer 包 SID 的权限，却缺少 ALL APPLICATION PACKAGES 的读取许可。Electron 检查沙箱 token 能否读取 icudtl.dat，失败会以 0x80000003 退出。参见 [Electron 对应检查](https://github.com/electron/electron/blob/v44.5.1/shell/browser/win/install_dir_access.cc)。

程序在创建窗口前调用已有 context-helper 的专用启动模式，检查并补齐当前安装目录的继承式读取/执行许可，然后继续启动。无需独立修复脚本，安装器也不修改权限。

该模式从 helper 自身位置确定安装目录，不接受外部目标路径；不初始化 COM、截屏或输入服务。健康目录保持原样。修复保留拥有者和其他 ACL，不关闭沙箱、不添加写入权限。重解析点和显式读取拒绝会阻止自动修复。系统拒绝修改 ACL 时，记录 Win32 错误并显示启动错误，可尝试以管理员身份启动一次。

## 收集诊断报告

1. 从托盘退出已有 lolPing。
2. 运行安装目录中的 Diagnostic-Start.cmd，等待约 12 秒。
3. 脚本打开报告目录并输出 ZIP 路径。主程序进入 JavaScript 前退出时，仍有外层启动记录。
4. GPU 对比可在退出程序后运行 Diagnostic-Start-NoGPU.cmd。它只对本次启动传入 --disable-gpu。

无需安装 Node.js、Visual Studio 或以管理员身份运行诊断脚本。

## 位置、内容与保留

- 启动日志：%LOCALAPPDATA%\lolPing\logs，不可写时尝试 %TEMP%\lolPing\logs。最近 10 次启动，每次最多两段，单段约 2 MiB。
- 诊断 ZIP：%LOCALAPPDATA%\lolPing\diagnostics，不可写时尝试 %TEMP%\lolPing\diagnostics。报告留在本机，不自动发送。
- 结构化日志记录启动阶段、版本、资源存在性、安装权限检查、窗口和页面加载、渲染/GPU 退出、助手启动/退出及异常。
- 外层启动器额外记录安装文件哈希、已有进程、退出码、相关 Windows Application 错误，以及 stdout、stderr 和 Chromium 日志快照。
- 不复制设置文件、房间码、聊天、剪贴板、桌面截图或 AI 历史。应用结构化日志对常见凭据和 URL 路径做脱敏；系统与 Chromium 日志可能含本机路径。

Chromium 会持有日志文件。启动器使用允许并发读写的文件流，截取每份日志末尾最多 4 MiB，压缩已关闭的快照。ZIP 只包含 report，原始流保留在同次诊断目录的 live 下。

## 判断事件

| 事件 | 含义 |
| --- | --- |
| launcher-error | 路径、权限或系统启动失败，查看消息和 HRESULT |
| 无 bootstrap 且非零退出 | 进入 JavaScript 前退出，结合系统错误和文件清单 |
| install-access | 自动目录读取权限检查，结果为 unchanged、repaired 或 failed |
| bootstrap-failed / startup-failed | 模块加载或主进程初始化异常 |
| second-instance-exit | 已有实例，新进程退出并请求打开已有实例的设置 |
| preload-failed / page-failed / renderer-gone | 页面、预加载或渲染进程失败 |
| input-helper-error / input-helper-exit | 助手缺失或启动、运行失败 |

startup-complete 只表示主进程初始化完成；页面显示和助手就绪有各自事件。日志不可读或缺少系统事件不会阻止报告生成。

## 回归工具与边界

- `node tools/diagnostics-smoke/run.mjs`：隐藏原生窗口中的页面/预加载失败、渲染崩溃与恢复、助手缺失、启动异常和 ready 前模块缺失。
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/diagnostics-smoke/permissions.ps1`：合成安装目录中的原生权限修复、继承、重复启动和链接保护。
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/diagnostics-smoke/installed-startup.ps1 -AppDirectory <unpacked-install-directory>`：已停止的测试安装目录。临时加入合成包权限，验证真实打包启动并移除测试权限；不要对正在使用的安装运行此验收工具。

日志写入失败不影响输入路径。离线夹具、隐藏原生窗口、真实打包进程及另一台设备的结果需要分别记录。
