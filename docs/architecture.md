# 数据、权限与原生接口

数据库是可复用来源；会话按稳定槽位固定多个明确版本。人类保存创建新版本，Agent 变更进入当前故事的来源限定因果记录。源库后续修订不会自动改变已开始的故事；source order 不建立真值覆盖关系。

## 条目和 Agent 操作

源条目字段为 id、title、content、keywords、tags、notes、readOnly、mode、version。有效 EntryView 增加 ref:{sourceKey,entryId} 和可选 sourceVersion；同原始 ID 可以出现在不同槽位。mode 只能是 auto、required、disabled；人物知情在 notes 中自然表达，没有 NPC 身份表或强制公开/私密分类。

Agent 可 update 内容/索引/备注，add 自动且未锁的新条目，remove 未锁且非必开条目，或 note 附本次准备的临时备注。typed v2 操作用 ref；模型和 Context planner 在入口将程序 entryKey 转换一次。新 v2 add 只能进入 @session。不能改 readOnly、mode、版本或来源；不能复用同槽位内已继承/删除的 ID。每个批次全部通过后才提交。

注册 factEntryRefs 后，generic/material 的任何修改（包括 note）均返回 FACT_OWNER_REQUIRED，整个批次不提交。factAccess 仍受 readOnly、disabled、required 约束。gm.scene/gm.facts 为 schemaVersion 1 JSON；Database 校验结构，不判断 GM 任意叙述是否为真。factAccess/materialAccess 和 agent effectiveV2 快照只给启用正文；owner 可查看禁用资料。

关键词检索包括标题、ID、标签、正文和中文词项。配置向量服务后计算余弦相似度并与关键词排名融合，再调用配置的重排服务。禁用项在构造提供方请求前就排除。必开 ID 单独返回，不受 Top-K 截断影响。向量当前按检索时的有效条目计算，没有宣称持久向量索引或大库性能已验证。

## 因果来源与回退

每次会话修改记录规范 assistant message ID。宿主使用完整的授权历史、surface 替换关系及 compact-checkpoint 覆盖关系决定当前 active anchors。折叠后的事实仍有效，回退/替换后的事实不再生效。

分叉保留分叉点选中的因果变化，不将最终有效值不可逆地压成 baseline，因此子分支还可以回退到继承前缀内更早的位置。临时备注跟随创建它的准备步骤。所有来源文本和历史变更保留，检索只投影当前有效内容。

事实提交的 canonical source 必须对应 active assistant 中真实 rp_begin_story/rp_commit_turn 块、canonical tool/call 与其 turn/start；turnKey 固定为 JSON.stringify([sessionId,turnStartSeq])，不依赖可复用的 provider callId。回执和操作在一次队列事务中写入，幂等重放不增加 revision；冲突返回 TURN_ALREADY_COMMITTED 与 receiptId。分叉复制因果回执并保留原 source/turnKey；读取投影当前 sessionId，必要时附 originSessionId。回退状态与回执一起失效。

## 原生服务

rpDatabase.apiVersion=2；精确服务见 [API](api-v2.md)。旧单来源 effective/catalog/read/search/patch 保留；歧义多来源返回 QUALIFIED_REFERENCE_REQUIRED。bindSources 只有 owner 可用，包含空 sources 的绑定也有效。兼容保留/新增槽位保留覆盖；需破坏性重置的非 GM 故事须明确 resetOverlay:true，GM 初始化后返回 STORY_RESTART_REQUIRED，不能隐式清除事实和回执。

读会话时使用宿主 owner Remote；Agent 调用必须携带实际 exec.agent，不能指定另一会话。动态工具注册在 Agent 自己的作用域，分叉继承在首次请求前完成，未绑定后代不会继承父作用域能力。

上下文插件检测 apiVersion=2 后使用 materialAccess.version=2：apply/commit 的操作选择器 id 为 entryKey，select 消费 entryKeys；暂存和提交均校验事实所有权，提交再读完整权威状态并检查捕获的 revision。旧 applyToSnapshot/selectFromSnapshot 纯预览仍可供 legacy 使用，最终 patch 同样不能修改注册事实。state 检索状态只含 configured/model，不含密钥。

浏览器 POST api/rp-database/request 只接受精确动作和字段，GET api/rp-database/events 发送元数据失效通知。宿主来源变化、回退和新步骤会使打开的视图重新读取有效状态；隐藏、断线和卸载释放订阅。没有任意 URL/RPC 代理。

持久化为 schemaVersion 2 的单个 state.json，通过同一进程内的目录写队列与原子 rename 更新。v1 原子向前迁移保留 baseline 与原有 anchor，并将其条目和历史新增限定在 legacy；新 v2 新增使用 @session。initializeStoryState 按 launchId/seed 幂等追加新 @session seed，不覆盖已有故事条目。revision 冲突保留源编辑和来源组合各自草稿，不静默重放。跨进程共同编辑同一个 DSH home 不属于当前写入约定。
