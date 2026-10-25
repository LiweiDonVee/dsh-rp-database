# 资料、索引与传输 provider

以下均为 rpDatabase 的 owner/plugin-only 服务，没有模型可指定的文件路径、外发地址、stage 或 source anchor。

```ts
importDocument({name,mimeType,dataBase64?,text?,expectedRevision,requestId,signal?})
 -> {revision,documentId,version,databaseId,sourceKeySuggestion,diagnostics,chunkCount}
document({documentId,version?,signal?}) -> {document,extraction,diagnostics}
indexState({signal?}) -> {model?,readyChunks,staleChunks,lastErrorCode?}
rebuildIndex({databaseIds?,signal?}) -> {indexedChunks,skippedChunks,diagnostics}
contentRevision({signal?}) -> {revision}
```

mimeType 支持 text/plain、text/markdown、application/pdf。text 与 dataBase64 二选一，PDF 只收 bytes。TXT/MD 为 UTF-8，解析忽略 BOM、统一提取换行，原 bytes 保持。PDF 在打包的 Node 运行时内使用固定 pdf2json4.1.0 解析，不要求外置 CLI，不执行 OCR；NO_TEXT_LAYER 保留原件、返回零正文片段。当前新文件使用新 documentId/version1，同名不覆盖；同 requestId/同内容返回原结果，异内容 REQUEST_ID_CONFLICT。

```ts
Document = {id,version,name,mimeType,sha256,dataBase64,databaseId,
 extractionVersion,chunkingVersion}
ChunkRef = {documentId,documentVersion,chunkId,page?,paragraph?}
Extraction = {text,chunks:[{ref:ChunkRef,text,sha256}]}
Entry.provenance? = ChunkRef & {kind:'document-chunk',extractionVersion,
 chunkingVersion,textSha256}
```

ID 非空、版本为正整数、hash 为小写 SHA-256；Document.sha256 对原 bytes，chunk 与 provenance hash 对精确 UTF-8 原始片段。page/paragraph 从1开始。分块按页边界与段落、每片段最多1200 Unicode 字符，ID 由位置和文本哈希确定；PDF 不把跨页文本标成单页。provenance 是来源 metadata，模型不可改；允许的工作正文编辑保留原来源引用，owner 预览会标出与原片段不同。导入不自动绑定故事。

indexState 统计当前源库最新启用条目的 ready/stale；故事 overlay 在查询时按实际 active refs 投影。缓存键含有效检索文本哈希、提取/分块/检索策略、明确提供方 URL/model 与维度，不含 API key；正文输入不含故事 sourceKey。每次 query 先生成 query vector，按其维度复用或补充缺失正文 vectors；维度变化不混用。disabled/rewound 内容在 cache/provider 输入前排除。缓存是派生数据，写入同一 state.json 队列但不增加 content revision，失败明确降级。

```ts
DatabaseContent = {database,source?:SourcePayload,documents?:DocumentContent[]}
DocumentContent = {document:Document,extraction:Extraction}
exportContent({databaseId,version,signal?}) -> DatabaseContent
importContent({database,source?,documents?,requestId,expectedRevision,signal?})
 -> {revision,databaseId,version,sourceId?,documentMappings?}
```

导出只包含库版本关联的不可变文档版本；缺失 chunk/doc/hash 不会成为成功的悬空引用。内容 import 创建新 databaseId/version1、新 documentId/version1，documentMappings 用 JSON.stringify([oldDocumentId,oldVersion]) 映射为 {documentId,version}；Entry.provenance、Extraction refs 和 Document.databaseId 一起重映。原 source/provenance 保持审计原样；工作正文可不同于原始 chunk，不能用 provenance hash 冒充有效内容 hash。重放 requestId 返回同 mapping，异 payload 为 REQUEST_ID_CONFLICT。

```ts
exportState({sessionIds,signal?}) -> {schemaVersion:1,revision,payload}
preflightRestore({sessionIds,state,signal?}) -> {supported,conflicts:[{code,id}],requirements}
restoreState({restoreId,sessionIds,state,expectedRevision,signal?})
 -> {revision,restoredSessionIds}
```

payload.storeSchemaVersion=2，含 databases[{id,versions}]、sources[]、documents[{id,versions}]、sessions[]，只收 Database 自有数据。必要祖先必须包含在 sessionIds；冷 child 导出先完成本插件的因果继承。payload 包含 source/version/doc 依赖、原 baseline/qualified changes/事实 receipts/初始化 metadata，排除 vectors、索引时间和传输请求 journal。receipt 存储保留原 creator session/source/turnKey。

T2 预检不要求目标 Session 存在，只检查 schema、内容/ID冲突与依赖。协调者先通过公共宿主 persistence 创建精确 headers/events、flush/close、cold validation；restoreState 再通过认证 owner reader 读取真实目标完整历史，核验实际 assistant anchors、真实 GM tool block/call/turn/start、祖先关系、因果政策和 stateRefs，最后在一个 Database 队列事务写入。原事实回执不能凭 JSON 声称为 canonical；不追加自定义事件或伪造 accepted history。

同 restoreId/同 payload 与 Session 集合返回原结果，异 payload/集合 RESTORE_ID_CONFLICT。其他 restore job 不能覆盖已有故事；同 ID/version 内容仅在结构完全一致时复用，不同为 RESTORE_CONTENT_CONFLICT。格式错误 RESTORE_PAYLOAD_INVALID，缺失 canonical/content dependency 为 RESTORE_REQUIREMENT_MISSING；所有拒绝均不提交局部状态。既有无关库/故事/缓存保留。包导入的新 ID 与 SavedStory 的精确 ID 恢复是两种不同操作。

T9 顺序：先检查最小可 JSON 序列化 envelope、restoreId、distinct Session set 与非负 expectedRevision；随后先查询 journal 的身份 fingerprint，复用 ID 的异 payload/集合在深入 schema 或 canonical lookup 前拒绝。匹配已完成重放可使用旧但格式正确的 revision；新操作做完整 schema/依赖/冲突与 revision 校验后才查 canonical，最后仍在同一队列重复身份/CAS检查并合并。无本插件绑定的已包含祖先 Session 也保留 journal 命名空间归属。

owner HTTP 仅暴露 importDocument/document/indexState/rebuildIndex/contentRevision 的精确 DTO；最大 text 8,000,000 字符、Base64 32,000,000 字符。内容/state provider 供 StoryKit 的受信 server 服务调用，不是任意 browser RPC。资料面板在隐藏、切换和卸载时释放请求/文件读取；revision 冲突保留 bytes/requestId，显式更新修订后才重试。

`pnpm smoke:documents` 只证明 Database 在真实 rc.3、独立临时 homes 的工程接口与合法 Session 传输；不等于 StoryKit 已恢复 GM/LastStep/Context/Loop 全套内容，也不证明付费模型的故事质量。
