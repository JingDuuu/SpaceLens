# SpaceLens · 空间透镜

A portable Windows disk explorer with a dark treemap, folder X-ray preview, reviewed temporary-file cleanup, and application removal guidance. 中文界面，CLI / MCP 可供本地 AI 助手调用。

## 下载与使用

从本仓库 **Releases** 下载 Windows x64 便携包，完整解压到可写文件夹，双击 `SpaceLens.exe`。无需另装 Node、Python 或 .NET。支持 Windows 10/11 x64；其他架构未验证。

- **空间地图**：块越大，逻辑文件大小越大。单击文件夹，在原色块内半透明显示内部一层；双击进入，Alt+↑ 返回。
- **直接定位**：地图和列表右键打开资源管理器、进入文件夹、复制路径。
- **常规清理**：检查固定临时目录内至少 7 天未变动的普通文件。查看明细、勾选后确认清理。文件变化、目录链接、硬链接或占用会跳过；不删除下载、个人文档、应用安装目录。删除不进入回收站，执行前有明确确认。
- **应用整理**：按登记大小和 90/180/365 天前的最后可见启动记录筛选。无记录单独归类。复制应用名并打开 Windows 卸载列表，由 Windows 完成卸载。
- **大盘与进度**：原生 Windows 元数据扫描，分阶段进度，Worker 流式索引和 SQLite 后台查询，可打开超过 JavaScript 单字符串上限的大快照。

![Folder X-ray using synthetic demo data](assets/demo/folder-preview.png)

## 清理与计量边界

“最后可见启动记录”来自 Windows UserAssist / 可见进程，可能缺失，**不等于精确最后使用时间**。文件访问或修改时间不用于判断应用闲置。应用大小来自安装登记估算值，未知不会当成 0。

临时文件规则覆盖当前用户和 Windows 临时目录；Windows 更新、回收站、其他账户或受保护区域提供系统清理入口。程序不会静默卸载应用，也不根据“没有记录”自动删除。清理前请查看预览。

地图采用逻辑大小，稀疏/压缩文件和硬链接可能与物理占用不同。权限未覆盖的目录及链接跳过会保留问题明细。尚未实现原始 MFT 扫描，未与 SpaceSniffer 做同盘速度对测。已在本机数百万文件和另一个中文路径验证，尚未在第二台物理电脑验收。

## CLI / MCP

```powershell
.\spacelens.cmd drives
.\spacelens.cmd scan --path 'D:\'
.\spacelens.cmd children --id 0 --limit 50
.\spacelens.cmd top --limit 20
.\spacelens.cmd cleanup
.\spacelens.cmd cleanup-apps --older-days 180 --min-bytes 1000000000
.\spacelens.cmd mcp-config
```

CLI 输出 JSON，进度写入 stderr。`cleanup` 只预览，实际清理在桌面确认；MCP 不提供删除工具。运行 `mcp-config` 获取当前路径的 stdio 配置，迁移后重新生成。

`data/` 保存窗口状态、扫描快照、索引和清理汇总，不进入 Git 或发布包。迁移时可选择保留；在新电脑整理前应重新扫描。应用自身不上传数据；外部 AI 客户端可看到用户请求它读取的结果。

## 开发与构建

需要 Windows x64、Node.js 24.20+、.NET 9 SDK。

```powershell
npm install
npm test
npm run build
npm run start
```

二选一运行 `npm run build` 或 `npm run release`，再次构建前先移走旧的 `dist/SpaceLens`。`build` 输出便携目录 `dist/SpaceLens`；`release` 额外生成 ZIP 和 SHA-256。CI 在 Windows 上运行测试；推送 `v*` tag 自动创建带便携包的 GitHub Release。不要提交或打包用户 `data`、本机报告及截图。

见 [架构与维护](docs/OPEN_SOURCE.md)。本项目 MIT 开源；运行时许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。


