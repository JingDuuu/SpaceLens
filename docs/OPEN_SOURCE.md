# 架构与维护

`src/main.cjs` 提供隔离的 Electron IPC 和系统入口；`service.cjs` 统一桌面、CLI 与 MCP 查询；`scanner/` 是只读 Win32 扫描器。`store-worker.cjs` 逐记录解析 JSON 并建立 SQLite 索引；`store-query-worker.cjs` 将宽范围筛选移出主线程。

`cleanup.cjs` 是固定规则的预览 / 复核 / 执行流程：生成 15 分钟有效的计划，执行前核对文件身份、大小和修改时间，不跟随链接，不递归删除目录。桌面通过原生确认执行清理；CLI/MCP 只提供预览。扩展规则需要路径、链接、文件变化和取消测试。

`usage-probe.ps1` 只读取安装登记、UserAssist 和可见进程。应用卸载使用固定 `ms-settings:appsfeatures` 入口，不执行注册表内任意卸载字符串。系统深度清理使用 `ms-settings:storagesense`。

文件夹透视只查询选中目录一层，最多缓存 24 个预览，按剩余大小保留“其余项目”区域；异步结果必须匹配当前快照与选择。预览不改变外层面积比例。小色块无法容纳子块时，可以双击或点“进入”。

## 发布

1. 修改代码，运行 `npm test` 和 `node tests/scanner-contract.cjs`。
2. 构建并检查正式桌面启动；发布截图使用合成数据。
3. 更新 `package.json`，提交 main，推送 `vX.Y.Z` tag。
4. GitHub Actions 生成便携目录、ZIP、SHA-256 并发布 Release。

本仓库采用文件允许列表。不要强制提交本机快照或复制其他项目的凭据。更新可正常 commit/push；不会创建未经请求的后台定时推送。

依据：[Windows Settings URI](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings)、[Node.js SQLite](https://nodejs.org/api/sqlite.html)、[Electron security](https://www.electronjs.org/docs/latest/tutorial/security)。
