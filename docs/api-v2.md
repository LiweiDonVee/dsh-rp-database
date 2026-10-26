# Qualified Database API v2

`ctx.get('rpDatabase').apiVersion === 2`。以下为 plugin 服务；没有模型可指定的 stage、owner、anchor 或重新绑定参数。

```ts
EntryRef = {sourceKey:string, entryId:string}
EntryVersionRef = EntryRef & {version:number}
SourceBinding = {key:string, databaseId:string, version:number}
BindingV2 = {schemaVersion:2, sources:SourceBinding[], factEntryRefs:EntryRef[]}
EntryView = ExistingEntry & {ref:EntryRef, sourceVersion?:number}
entryKey(ref) = JSON.stringify([ref.sourceKey, ref.entryId])
```

sourceKey 是故事来源槽位，不是上传原件 UUID。`world/0`、`actor/0`、`@session/0` 是三个条目。来源顺序只决定迭代顺序；@session 保留给故事新增和 GM 状态，人类绑定不得使用该 key。`examples/qualified-binding.json` 是公开合成 DTO 示例，不是世界书导入文件。

## 来源与数据

```ts
bindSources({sessionId,sources,expectedRevision,resetOverlay:false,signal?})
  -> {revision,binding}
effectiveV2({sessionId,agent?,signal?})
  -> {revision,binding,entries,notes,changes}
catalogV2({sessionId,agent?,signal?})
  -> {revision,binding,entries:metadataWithRef[],notes}
readV2({sessionId,agent?,refs:EntryRef[],signal?}) -> {revision,entries}
searchV2({sessionId,agent?,query,limit?,signal?})
  -> {revision,candidates:[{ref,score,reasons}],required:EntryRef[],degraded:string[]}
patchV2({sessionId,agent?,expectedRevision,operations:ScopedOperation[],signal?})
  -> {revision,session,entries,changeId}
```

ScopedOperation 的 update/remove/note 用 ref 代替 id；add 是 `{op:'add',entry:ExistingEntry}`，只新增 @session。read/search/catalog 不返回禁用正文；effectiveV2 的 owner 版本可查看禁用项，agent 版本只给启用正文。required 选择按 ref 自动并入，不受 Top-K 截断影响。

bindSources 为 owner 操作，sources:[] 也创建合法绑定。相同映射或保留相同槽位/数据库/版本会保留变化。移除/更改带依赖变化的来源需要明确 owner resetOverlay:true，非 GM 才可重置；已初始化 GM 返回 STORY_RESTART_REQUIRED。旧 bind 保持替换并重置的兼容语义，同样不能清除已初始化 GM 状态。模型工具不提供绑定/重置操作。

旧 catalog/read/search/patch/effective 仍支持无歧义单来源。多来源调用返回 QUALIFIED_REFERENCE_REQUIRED。rp_db_* 名称与 entryIds/operations[].id 字段保留；目录 metadata、搜索 candidates 增加程序 key/ref，搜索 required 为 `{key,ref}[]`。模型只复制程序 key；只有 legacy 单来源模式可使用无歧义裸 ID。typed v2 不接受 entryKey 代替 refs。

## 材料阶段

```ts
materialAccess({sessionId,agent?,signal?}) -> {
  version:2,
  snapshot(), // enabled v2 effective shape
  search({query,limit?,signal?}),
  apply(entries,ops), // planner id=entryKey -> {entries,notes}
  select(entries,keys), // entryKeys -> EntryView[]; unions required
  commit({operations,expectedRevision,signal?})
}
```

apply 与 commit 均消费相同 planner 操作：update/remove/note 的 id 是 entryKey，add 不变。search 返回 `{revision,candidates:[{key,ref,score,reasons}],required:[{key,ref}],degraded}`。操作触及 registered factEntryRefs 时 FACT_OWNER_REQUIRED；包含合法兄弟操作的批次也不提交。普通允许的工作资料仍可写；新建条目无法自行注册事实。commit 重新按完整存储、策略和 revision 校验，暂存结果不是写入授权。

## GM seed 与事实阶段

```ts
initializeStoryState({sessionId,entries:ExistingEntry[],factEntryRefs:EntryRef[],
  launchId,expectedRevision,signal?}) -> {revision,factEntryRefs}
factAccess({sessionId,agent,signal?}) -> {
  snapshot(), commit(FactCommitInput), propose(FactCommitInput),
  getReceipt(id), currentReceipt(turnKey), latestReceipt()
}
CanonicalSource = {assistantMessageId,callId,callSeq?,turnStartSeq}
FactCommitInput = {turnKey,source:CanonicalSource,expectedRevision,
  operations:ScopedOperation[],summary,packet,kind:'turn'|'opening',openingText?,capture?}
FactReceipt = {schemaVersion:1,id,sessionId,turnKey,source,kind,databaseRevision,
  changeId:string|null,stateRefs:EntryVersionRef[],summary,packet,openingText?,createdAt,
  originSessionId?}
```

先建立 sources 绑定（可以为空），再初始化全新 @session seed；保留已有普通 overlay。factEntryRefs 必须指向此次提供的 @session 条目。MVP gm.scene JSON 为 `{schemaVersion:1,title,location,time?,presentActorIds:string[]}`；gm.facts 为 `{schemaVersion:1,items:[{id,text}]}`。人类 readOnly/mode 保留，事实阶段不越过策略。

同 launchId 和相同规范 seed/refs 返回原结果且不写入，允许重放旧 expectedRevision；同 ID 不同 seed 为 LAUNCH_CONFLICT，不同启动已初始化为 STORY_ALREADY_INITIALIZED，条目冲突为 SEED_CONFLICT。不会覆盖或扁平化已有故事。

GM 插件从实际 native Session 生成 source；Database 核对 active assistant 的 rp_begin_story/rp_commit_turn 块、tool/call 的 callId/name/turn/step 和真正 enclosing turn/start。turnKey 必须等于 `JSON.stringify([sessionId,source.turnStartSeq])`。callId 单独不构成身份，来源不暴露给模型选择。

commit 返回 FactReceipt。操作和回执同事务保存；同一 active turn 的完全相同重放（忽略 expectedRevision、规范化对象键顺序）返回既有回执，不重写状态。冲突为 TURN_ALREADY_COMMITTED，安全错误 DTO 携带 error.receiptId；不能通过解析 message 取 ID。无操作 opening 回执的 changeId 为 null，openingText 必须是精确文本。

PublicDirectionPacket 只允许 playerAction（非空字符串）、sceneInstruction、resolvedChanges、visibleConsequences、openHooks、proseConstraints、publicFactRefs 与 variables（字符串值）。列表字段是 string[]，没有用于夹带 receiptId 的扩展字段。

getReceipt 缺失为 RECEIPT_NOT_FOUND。inactive/rewound 来源或回执为 INACTIVE_SOURCE；currentReceipt 从未提交时返回 null。同 turn 替换后选取当前 active receipt。分叉复制选中因果前缀，保留存储的原 source/turnKey；有效投影将 sessionId 设为当前故事，并在继承时附 originSessionId。其他无关故事不能读取回执。writer 失败不撤销事实，也不允许新事实重提来规避幂等检查。

## 事实审批与版本（factReview=1）

`apiVersion` 仍为 2。服务和 state 的 `capabilities.factReview` 为 1。仅可信 plugin 服务获得以下接口，HTTP/model 工具没有 source、capture、stage 或审批字段。

```ts
FactCapture = {
  playerInput:{seq:number,messageId:string,text:string},
  story:{title:string,character:object,persona:object,examples:string},
  observations:Array<{callSeq:number,resultSeq:number,toolName:string,text:string}>
}
FactCandidatePayload = {scene:WorldScene,facts:WorldFacts,summary:string,packet:PublicDirectionPacket}
OwnerRunRef = {sessionId:string,commandId:string,runSeq:number,requestHash:string}
OwnerDecisionRef = OwnerRunRef & {doneSeq:number}
FactGenerationRequest = {schemaVersion:1,sessionId:string,roundId:string,operationId:string,
  expectedRoundVersion:number,instruction:string,approvalRequired:boolean}

factReviewState({sessionId,signal?}) -> {databaseRevision,rounds,decisions,projection}
factReviewProjection({sessionId,agent?,signal?}) -> {schemaVersion:1,latestRoundId,groups}
stageFactCandidate({sessionId,roundId,payload,model?,operationId,expectedRoundVersion,
  source:OwnerRunRef,completion?:OwnerDecisionRef,approvalRequired,generationRequest,signal?})
  -> {round,candidateId}
recordFactDecision({sessionId,roundId,candidateId,action:'approve'|'custom'|'cancel',custom?,
  operationId,expectedRoundVersion,expectedDatabaseRevision,source:OwnerRunRef,signal?})
  -> {operationId,status:'recorded'|'applied',factReceiptId?}
finalizeFactDecision({sessionId,operationId,source:OwnerDecisionRef,signal?})
  -> {operationId,status:'approved'|'cancelled',round,receipt?}
factDecision({sessionId,operationId,signal?}) -> DecisionView|null
```

带 capture 的普通 commit 同事务保存完整候选、精确前态和首个已接受版本。propose 必须来自真实 `rp_propose_turn`，capture 必填，返回待审候选而不执行事实或工作资料操作；重复规范请求返回同一候选。capture 的玩家文本、完成工具结果及其 seq 都须匹配当前原生回合。省略初始 scene/facts 的部分从冻结前态补全，不能读取后来世界来补。

FactRoundView 返回 roundId/version/sessionId/turnKey/source/base/capture/candidates/pendingCandidateId/activeReceiptId/approvalRequired/latest/canRegenerate 与可选 blockCode。FactCandidate 保留 origin、完整 payload、payloadHash、时间和可选 operationId/model；重新生成的候选还返回由真实证明导出的 generationConfirmed。projection.groups 只含真实捕获回合的 source、activeReceiptId、factRevision、pendingCandidateId。legacy receipt 不伪造 round/base/capture；较新 legacy 生效时 latestRoundId 为 null。

生成请求的 hash 是完整 FactGenerationRequest 的递归排序键 JSON SHA-256，包含 operationId 和 expectedRoundVersion。真实 `rp-gm-fact-regenerate` 的 raw args 修剪后必须恰为 operationId/hash 两个 token。第一次 stage 只保存 provisional 候选并返回其 ID/hash，原 pending/current 不变；成功 done.text 必须为 `{schemaVersion:1,operationId,candidateId,payloadHash}`，第二次同 stage 带 completion 才发布待审候选。新的原生尝试可复用原候选，不重复模型工作。generationConfirmed 标志本身不构成证明。

决策 hash 绑定 `{sessionId,roundId,candidateId,action,candidatePayloadHash,custom?}`，不包含乐观 revision 字段或 operationId。真实 `rp-gm-fact-decision` 的 args 同样恰为 operationId/hash。record 只保留 intent；custom 在该事务内保存精确人类 payload，不调用模型。真实 success done.text 为 `{schemaVersion:1,operationId,requestHash}` 后 finalize 才原子写事实和回执。相同 operation/hash 返回已有结果；不同 payload 为 OPERATION_ID_CONFLICT。未生效的同一请求可用 later real run 原子 fence 旧 attempt，旧 attempt 不能再结算。

完成证明可在事实尚未应用时出现在 DecisionView.completion，status 仍为 recorded。精确 current 成功 done 后，确定性的基线/目标版本/人类策略拒绝会原子记录 failed/errorCode 并释放 reservation，随后抛回原业务错误；事实、固定操作、成功 receipt 都不写。失败 operation 只能返回原失败，必须用新 operationId 和新版本重新决策。cancel 只核验 owner、pending 候选及 review 版本，不要求旧基线或事实可写，所以可退出被阻止的审批。错误 source、旧 attempt、未成功 done 和瞬时 I/O 不解除合法 reservation。

新 receipt 增加 factRoundId/factRevision/candidateId、可选 supersedesFactReceiptId/decisionSource；source/turnKey 保留原逻辑回合。latestReceipt/currentReceipt 选实际生效版本，旧 receipt 仍可按 ID 审计。首接受才执行原固定工作操作，重生/自定义后续修订只写 scene/facts。仅最近回合可修订，目标条目变化返回 FACT_BASE_CHANGED、较新回合返回 FACT_ROUND_NOT_LATEST，旧回执无基线返回 LEGACY_BASELINE_UNAVAILABLE。只读/禁用策略不因审批而解锁。

SavedStory 在现有 owner payload 内使用 factReviewVersion=1 及显式验证字段；不新增外层格式。恢复核对真实原生来源、hash、run/done 结构化结果、receipt 与所选候选的实际世界；run-only 分支不能凭 status 得到新事实或未来生成正文。冷恢复只暴露待处理状态，不自动生成或写作。

子分支使用新的 child operationId/request hash 审批已确认候选。父分支未完成 intent 仅保留 origin audit，不形成 child reservation，也不能在 child 重绑定或 finalize。已完成继承事实保留原始因果证明；继承的 applied DecisionView 可供写作来源查询，不能当作 child 的可执行审批。原始捕获基线同时保留 Database 因果变化边界，后来的同 anchor 工作资料编辑不会被倒算进原始前态。

## 持久化与 HTTP

单 state.json，schemaVersion 2、全局 revision、同进程目录写队列与原子 rename。v1 首次读取时原子迁移且不增加 revision，原件、基线、固定版本、带 anchor 的变化和 legacy 新增保持；新 v2 新增使用 @session。所有快照 detached。

owner POST api/rp-database/request 原有动作保留，新增 bindSources、effectiveV2、catalogV2、readV2、searchV2 精确 DTO；不暴露 patchV2、初始化或阶段 facade。SSE 只发 sessionId/type 的失效元数据。主体始终由授权请求读取，隐藏/卸载释放订阅和未完成请求。

DB-B 资料、持久增量索引与 content/SavedStory provider 见 [资料与传输接口](documents-transfer.md)。这些 owner 服务不暴露为模型工具。
