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
  snapshot(), commit(FactCommitInput), getReceipt(id), currentReceipt(turnKey)
}
CanonicalSource = {assistantMessageId,callId,callSeq?,turnStartSeq}
FactCommitInput = {turnKey,source:CanonicalSource,expectedRevision,
  operations:ScopedOperation[],summary,packet,kind:'turn'|'opening',openingText?}
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

## 持久化与 HTTP

单 state.json，schemaVersion 2、全局 revision、同进程目录写队列与原子 rename。v1 首次读取时原子迁移且不增加 revision，原件、基线、固定版本、带 anchor 的变化和 legacy 新增保持；新 v2 新增使用 @session。所有快照 detached。

owner POST api/rp-database/request 原有动作保留，新增 bindSources、effectiveV2、catalogV2、readV2、searchV2 精确 DTO；不暴露 patchV2、初始化或阶段 facade。SSE 只发 sessionId/type 的失效元数据。主体始终由授权请求读取，隐藏/卸载释放订阅和未完成请求。

DB-B 资料、持久增量索引与 content/SavedStory provider 见 [资料与传输接口](documents-transfer.md)。这些 owner 服务不暴露为模型工具。
