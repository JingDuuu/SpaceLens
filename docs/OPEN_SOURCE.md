# 架构与维护

- `main.cjs`：隔离 Electron IPC，文件打开、缩略图、原生确认、回收站和卸载进程。
- `search.cjs` / `search-native`：独立 Everything 实例、持久 JSONL / QUERY2 IPC、限额分页、过时查询替换、原生响应边界检查。搜索独立于磁盘快照，不因 C 盘快照加载而阻塞首页。
- `service.cjs`：桌面、CLI 和 MCP 服务；空间快照按需加载。
- `scanner`：只读 Win32 元数据扫描。`store-worker` 流式索引，`store-query-worker` 后台查询。
- `cleanup.cjs`：固定目录、7 天静置规则、身份复核、取消；普通垃圾一键执行和明细预览共享规则。
- `reviewed-files.cjs`：大文件选择计划、5 分钟有效期、保护路径、身份复核，只调用回收站适配器，无永久删除降级。
- `usage-probe.ps1`：安装登记与可见启动线索；`Uninstaller.cs` 重新查注册表，支持标准可执行文件 / MSI 卸载，拒绝命令解释器和间接脚本入口。
- `resources.cjs` / `monitor-native`：常驻 JSONL 资源采样，GetSystemTimes / 内存 / 进程身份、PDH GPU 和物理磁盘、GetIfEntry2 网卡计数、DXGI 容量与 NVML。应用网络使用独立、临时、随机命名 ETW 会话；同用户受限命名管道，单独提升只读采集辅助进程。暂停守护进程最长 60 秒，连接断开自动恢复。
- `resource-model.js`：纯计算的物理网卡合计、按可执行文件聚合、显存预算公式；不将虚拟适配器重复加入总量，不把应用事件流量配平为网卡总量。

## 验证

`npm test` 运行跨模块契约测试；`node tests/scanner-contract.cjs` 验证 Windows 扫描器。构建后运行 `tests/search-e2e.cjs` 与 `tests/product-e2e.cjs`（设置 `SPACELENS_TEST_RELEASE` 为测试便携目录）。桌面测试使用合成搜索结果和可丢弃文件；回收站测试仅处理测试文件。不要针对真实应用做卸载测试。

发布前检查界面、大盘索引范围和速度、取消 / 复核、未知记录、大文件默认不选，以及便携 ZIP 不含 `data`。不要把真实搜索结果截图、日志、路径或本机索引提交 Git。截图只用合成内容。

资源回归：`node tests/monitor-contract.cjs` 只控制它自行生成的子进程，检查身份复核、优先级、暂停 / 恢复及关闭恢复。以已提升权限的测试账户设置 `SPACELENS_TEST_ETW=1`，测试真实 TCP 回环字节归属，禁止在自动化里绕过 UAC。`tests/resources-e2e.cjs` 使用合成进程验证原生确认边界、选中进程退出后不切换控制目标、AI 预算和窄窗口。

API 依据：[Windows 接口计数](https://learn.microsoft.com/windows/win32/api/netioapi/ns-netioapi-mib_if_row2)、[GPU 计数口径](https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/)、[TraceEvent](https://github.com/microsoft/perfview)、[NVML](https://docs.nvidia.com/deploy/nvml-api/)。性能 / 权限失败应退化为未知状态，不能伪造样本或静默修复系统计数器。

## 更新

更新 `package.json` / lockfile 版本，运行测试，提交并推送 main，再推送 `vX.Y.Z` 标签。GitHub Actions 自动生成便携 ZIP、SHA-256 和 Release；已发布标签保持不可变。

依据：[Everything IPC](https://www.voidtools.com/support/everything/sdk/ipc/)、[Everything 配置](https://www.voidtools.com/support/everything/ini/)、[Everything 许可证](https://www.voidtools.com/License.txt)、[Electron security](https://www.electronjs.org/docs/latest/tutorial/security)。
