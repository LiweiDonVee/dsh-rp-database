# 数据库、主动上下文与最后一步组合验收

## 0.2.0 DB-A 基础检查点

2026-10-25，实际官方 DSH **0.2.1-rc.3**、Node24.15.0、pnpm11.9.0，Windows 独立临时 DSH_HOME。`pnpm check`：79 项运行时、18 项界面测试、lint 与 build 通过。新增功能执行了真实 RED→GREEN：资格引用/迁移、多来源服务、阶段事实保护/幂等回执、精确 owner 路由/来源组合 UI；同 turn 来源替换的当前回执选择与 legacy 来源顺序/原件标识也有先失败的回归。

`pnpm package` 生成 `artifacts/dsh-rp-database-0.2.0.tgz`，SHA256 `ca7ad0b9bf64effcac27198bf9d293abaf714a8ed9c34f0781622cd3c2029c91`。包内宿主范围为 `>=0.2.1-rc.3 <0.3.0-0`，没有运行时 workspace 依赖。未发布。

`pnpm smoke` 使用当前官方安装，16 项原生断言通过：旧 ST/V3 导入、策略/会话隔离/原件不变；world/0 与 actor/0 独立；真实 native 合成 rp_commit_turn 的 source 通过校验；同输入重复一次、冲突带既有 receiptId、材料混合非法事实操作原子拒绝、tool 返回后可取回回执；owner UI 重新排序保留 gm.facts v2。侧栏/全屏/520px/关闭重开通过，浏览器 pageErrors=[]，窄屏 documentWidth=520。`docs/images/workspace.png` 为本轮原生多来源界面。

首次 smoke 因 Playwright 1248 浏览器未缓存停在 browser 阶段；随后通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=C:/Users/Owner/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe` 使用已安装 Chromium 1217，通过完整 smoke。`scripts/pack.mjs`/smoke 的既有 Windows shell spawn 产生 Node DEP0190 提示，不影响退出状态。证据位于 `.runtime/native-evidence/acceptance.json` 与同目录截图，临时 home 为 `.runtime/dsh-rp-database-smoke-1792929974291`；真实 `.dsh` 未变更。

这是 Database 独立包的确定性合成工具验收，没有实际 GM/Context/Last Step 包的组合调用或付费模型。分叉 A→B 选 A、再回退到 A 前、v1 迁移、同回执原子写和插件重建恢复由运行时测试验证；本轮没有做原生进程冷重启/完整链分叉验收。文档提取、持久增量索引和 transfer/restore 为待 DB-B 实现范围。

## 历史 0.1.1 / 0.1.0 记录

0.1.1 导入兼容补修：51 项运行时＋15 项界面测试、lint 和构建通过。该版本原生单包验收实际导入 ST 世界书映射和 V3 JSON 内嵌世界书，验证启停/必开、不可执行原件、持久报告、模型补丁与会话隔离、侧栏/全屏/520px/关闭重开；无浏览器运行错误。导入行为与边界见 [字段说明](sillytavern-import.md)。下文保留 0.1.0 完整链的历史验证范围。

2026-10-25，官方 DSH 0.2.1-rc.2，Node24、pnpm11.9，独立临时 DSH home。提供方、embedding、rerank、GM、摘要与 writer 全部是明确标识的本地确定性 fixture，没有真实付费推理或用户角色卡。

## 覆盖

- 各新插件可只安装自己的 tgz，原生入口、侧栏、全屏、520px、关闭重开均通过；独立上下文验收不要求数据库或最后一步包。
- 组合安装数据库、上下文、最后一步0.2和 Loop0.1。主 Agent 调用事实工具，GM 用不同模型准备材料，文风组装和 writer 使用独立实际路由。
- 初始20个候选没有目标条目，GM 主动搜索完整启用库并读取候选外目标。真实本地 HTTP embedding/rerank 接口收到请求，禁用哨兵不在其输入中。
- GM 试图改写只读必开条目被拒绝，之后合法修改、新建和临时备注进入会话覆盖。源数据库的 BOM、CRLF 和原始文本保持不变。
- 正文默认窗口设为1：早期正文生成实际事实摘要，GM 按规范来源展开原文，并在后续改为索引。未决事项独立保留。
- 四轮成功叙事后，第五轮 writer 人为失败。数据库的已提交变化保持，失败稿不进入正式历史；仅重试 writer 后累计5次事实工具、6次 writer，GM/组装不重复执行。
- 在第二轮结束事件处分叉，子会话只继承第2次数据库变化和2条叙事，父会话的后续变化不进入子分支。随后用宿主合法 surface replacement 回退第五轮和重试，打开的数据库视图自动恢复到第4次变化，旧失败来源不再可重试。宿主重启后资料与4条有效叙事恢复。
- 完整来源关联包含 assistant message ID、sourceEventSeqs 与工具事件序号；提供方复用工具调用 ID 不串回合。
- Astra 最终审查发现的失效来源重试、成功重试重复和数据库视图失效通知已修复，并通过定向回归与复核。

单元测试合计229项：数据库43运行时＋14界面，上下文36运行时＋17界面，最后一步98运行时＋21界面。三个项目的 lint 和生产构建通过。

## 复验

每个仓库执行 pnpm check、pnpm package、pnpm smoke。组合在最后一步仓库运行：

```powershell
$env:DSH_DATABASE_TGZ = (Resolve-Path ../downloads/dsh-rp-database-0.1.0.tgz).Path
$env:DSH_CONTEXT_TGZ = (Resolve-Path ../downloads/dsh-rp-context-0.1.0.tgz).Path
$env:DSH_LOOP_TGZ = (Resolve-Path ../downloads/dsh-loop-studio-0.1.0.tgz).Path
node scripts/fullstack-smoke.mjs
```

改为实际下载路径。需要官方启动器与 Playwright Chromium，可用 DSH_BIN 和 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定。结果 .runtime/fullstack-evidence/acceptance.json 保存受测安装包哈希，截图在同目录。Release 附 SHA256SUMS 对应正式安装包。

## 范围

上下文窗口作用于中间 GM 与最终正文，不篡改宿主主循环的冻结请求；主循环全局压缩仍由 DSH／经过对应版本验证的 ACP 管理。没有执行历史 DV fork 或上游脚本，也没有把它们当作依赖。

这是工程调用与生命周期验收，不能代替20—30轮真实模型的文学质量、角色一致性或大库检索效果评测。当前表示以正式叙事回合为单位，未宣称实现无限层级章节压缩。embedding 在检索时按有效内容计算，未验证持久向量索引性能。人物知情依靠叙事备注与 GM 判断，不是程序保密证明。
