# DSH RP Database

原生 DSH 故事数据库插件，用可复用、可编辑的条目替代依附 Agent preset 的世界书。新故事固定一个来源版本，之后 Agent 只维护自己的会话覆盖，不写回来源，也不影响其他故事。

![DSH 原生工作区](docs/images/workspace.png)

## 安装

已验证目标 DSH 0.2.1-rc.2。下载 Release 的 `dsh-rp-database-0.1.0.tgz`，完全退出 DSH 后执行，再重启：

```powershell
dsh plugin --profile desktop add ./dsh-rp-database-0.1.0.tgz
```

Web 模式将 desktop 改为 web。点击会话顶部 **数据库** 或右侧新增页签中的 **故事数据库**。Windows 找不到 dsh 时可使用默认官方启动器：

```powershell
$dshCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
& $dshCli plugin --profile desktop add ./dsh-rp-database-0.1.0.tgz
```

## 使用

1. 导入 SillyTavern 世界书 JSON，或新建空白数据库并添加条目。原始导入文本独立保存，宏、脚本和未知扩展不执行。
2. 编辑正文、关键词、标签与叙事备注；设置 **Agent 只读** 及 **自动／必开／禁用**。
3. 保存新版本，再明确应用到当前故事。保存不会自动替换已固定版本，重新应用会重置该故事的覆盖。
4. Agent 用目录、读取、搜索和补丁工具维护当前故事。界面可查看有效内容、变更与临时备注。

只读与选材相互独立：只读条目仍可按需选择，必开条目不能从材料中移除，禁用条目不能经模型直接读取或搜索绕过。人类可以编辑锁定条目的源版本；Agent 不能改这些策略。

人物知情、误解、传闻和揭示条件写在自由文本 **叙事备注**，由中间 GM 判断；插件不建立 NPC 权限表。资料、提案和已确认事实的区别也应在备注中说明，普通条目编辑不替代已有规则工具的结算。

分叉继承有效来源变化，回退后不再使用失效分支的覆盖；原始文本和变化记录仍保留供回溯。临时备注属于其创建的准备步骤，不自动变成永久世界事实。

## 检索与模型

关键词检索可以独立运行，支持 ID、标题、关键词、标签、中文分词与正文。可配置 OpenAI-compatible embedding 和 rerank 服务：

```yaml
- id: rp-database
  config:
    embedding:
      baseURL: http://127.0.0.1:8080/v1
      model: your-embedding-model
    reranking:
      baseURL: http://127.0.0.1:8081/v1
      model: your-rerank-model
```

将示例 URL/model 改成自己实际服务，通过 DSH 插件配置应用。远程服务可增加 apiKey，密钥不进入模型选材结果或浏览器状态。两个接口分别为 `/embeddings` 与 `/rerank`，不是聊天补全接口。未配置或失败时明确标记降级，不伪装成已经完成语义检索；模型不会自行指定外发地址。

检索产生候选而不替 GM 决定。配合 [RP Context](https://github.com/LiweiDonVee/dsh-rp-context)，中间模型能重新搜索整个启用库、读原候选之外的条目、修改允许的会话资料并排序选材。配合 [RP 最后一步](https://github.com/LiweiDonVee/dsh-rp-last-step)，正式正文消费冻结快照。

## 工具与服务

绑定会话获得 `rp_db_catalog`、`rp_db_read`、`rp_db_search`、`rp_db_patch`，工具只处理调用会话。修改要求当前 revision；一个批次全部通过才提交。来源数据库 ID 和版本不由 Agent 改动。

可选服务 `ctx.get('rpDatabase')` 提供 catalog/read/search/patch/effective，以及权限检查的 applyToSnapshot/selectFromSnapshot，供上下文插件处理隔离工作副本。宿主授权和当前有效来源由服务统一处理。实现字段见 src/core.mjs、src/host.mjs 和 docs/implementation-plan.md。

## 数据与开发

本地事务文件位于 `$DSH_HOME/app-data/rp-database/state.json`；未设置 DSH_HOME 时使用 `~/.dsh`。备份前退出 DSH。文件包含原始资料和会话变化，不应当作公开调试附件。

开发需要 Node24、pnpm11.9：

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm package
```

产物与 SHA256SUMS 在 artifacts。`pnpm smoke` 可单独安装本包在隔离 home 验收；组合验收由配套完整链 smoke 验证；不以模拟模型结果声称真实语义质量。MIT 许可证。

[架构说明](docs/architecture.md) · [验收记录](docs/acceptance.md) · [更新记录](CHANGELOG.md)
