# RP Database Implementation Plan

> Use superpowers:subagent-driven-development for isolated tasks and independent review. User has approved implementation; no further design approval is required.

**Goal:** A standalone DSH native database plugin with immutable reusable sources and permission-controlled session changes, searchable by keywords and configured semantic services.
**Architecture:** Pure data/store/retrieval kernel; native host owns Session authorization and active source references; React UI consumes exact owner routes. No NPC ACL or per-card runtime generation.
**Tech Stack:** Node24, Node test, esbuild, React18 host, Vitest, pnpm11.
**Spec:** E:/WorkSpace/repos/dsh-rp-last-step/docs/context-database-design.md.

## Global Constraints

- DSH0.2.1-rc.2, no runtime dependency on RP Studio, Loop, or Last Step packages.
- Source uploads never executed or written back. Native knowledge notes are plain text.
- Agent operations cannot mutate human readOnly/mode or source identities.
- Disabled entries never reach model read/search results; required entries cannot be removed or dropped from selection. No NPC knowledge ACL.
- Follow exact task interfaces. Each owner changes only assigned files and commits only owned paths. No nested subagents.

## Task 1: Pure database, revisioned store and retrieval

Own `src/core.mjs`, `src/store.mjs`, `src/retrieval.mjs`, `tests/core.test.mjs`, `tests/store.test.mjs`, `tests/retrieval.test.mjs`. Parent owns host/routes/client/build/docs.

- [ ] First write/run a failing behavioral test for locked modification, source preservation or excluded anchor rollback; implement only after RED.
- [ ] Export `DatabaseError(code,message,status=400)`, `validateDatabase(value)`, `importDatabase(rawText,{name?}={}) -> {database,source,diagnostics}`, `applyOperations(entries,operations) -> {entries,notes}`, `selectEntries(entries,ids) -> Entry[]` from core.mjs. Database is `{id,name,version,entries}`; Entry is `{id,title,content,keywords:[],tags:[],notes:'',readOnly:false,mode:'auto'|'required'|'disabled',version:1}`. Immutable detached outputs. IDs are data, not path segments. Import own JSON `{name,entries:[]}` and ST worldbook `{entries:{key:{uid,comment,content,key,disable,constant,...}}}`; preserve exact rawText/sha256 and inert extension provenance. Duplicate IDs fail.
- [ ] Agent ops: `{op:'update',id,patch:{title?,content?,keywords?,tags?,notes?}}`; `{op:'add',entry}`; `{op:'remove',id}`; `{op:'note',id,text}` for temporary notes. No readOnly/mode/version changes. readOnly rejects all modifications including notes/removal; disabled rejects all model operations; required rejects removal. New entries must be auto/unlocked and cannot shadow any inherited ID. Updates increment entry version. Atomic failed batches. Required selection union, disabled selection rejection, deterministic order.
- [ ] Export `createDatabaseStore({directory})`. Methods async: `snapshot()->{revision,databases:summaries}`, `database(id,version?)`, `source(sourceId)`, `importSource(rawText,{name?,expectedRevision})`, `saveDatabase(database,{expectedRevision})`, `bindSession(sessionId,{databaseId,version,expectedRevision})`, `session(sessionId,{activeAnchors?,currentAnchor?}={})`, `applyOperations(sessionId,operations,{expectedRevision,anchor})`, `forkSession(fromId,toId,{activeAnchors,expectedRevision})`. Mutations return revision plus relevant databaseId/version or session/entries/changeId. Existing database saves require explicit latest base version. Session reads return `{databaseId,version,entries,notes,changes}`; changes carry anchor string, raw operations and stable change ID. Apply only changes whose anchor is in activeAnchors when supplied; currentAnchor limits temporary notes. Empty/missing anchor is rejected on agent mutation. Bind pins immutable source version and resets prior session changes. Fork copies the effective active state and policy into a distinct child baseline; source stays unchanged. Whole JSON state atomic rename, process-local cross-handle serialization, revision conflict 409, safe hashed/session map keys. Reads detached.
- [ ] Export `createRetriever({embed,rerank}={})` with async `search({entries,query,limit=12,signal}) -> {candidates:[{id,score,reasons}],required:[id],degraded:[]}`. Exact/title/keyword/tags + multilingual lexical scoring, optional cosine vectors and rank fusion, optional reranking; disabled filtered before any provider call. Configured embed function receives string[] and signal, returns number[][]; rerank receives `{query,documents,signal}` and returns `[{index,score}]`. Validate lengths, finite scores, dimensions and indices. Return explicit unconfigured/failed degradation rather than fake semantic success. Required IDs separate from truncated ranked candidates. No network calls when providers absent.
- [ ] Export `createHttpRetrieval({embedding?,reranking?,fetch?}) -> {embed?,rerank?}`. Explicit human config `{baseURL,model,apiKey?}`, HTTP(S) only, OpenAI-compatible `/embeddings` request `{model,input}`, `/rerank` request `{model,query,documents,top_n}`. Accept conventional data embeddings/results relevance_score, validate responses, forward abort; errors never expose key/provider payload. Endpoints never inferred from model text. Do not write settings or read DSH credentials.
- [ ] Tests cover source exact restart, pinned versions, user flags, two independent stories, atomic ops, same-revision races, rollback anchor filtering, fork isolation, temporary notes lifetime, required/disabled selection, Chinese/ID keyword retrieval, actual fake embed/rerank calls and malformed/failure/abort paths. Run `node --test tests/*.test.mjs` and focused oxlint. Commit only owned files and return report path, SHA and counts.

## Task 2: Native host, owner API and model tools

- [ ] Parent implements `src/host.mjs`, `routes.mjs`, `agent.mjs`, `session.mjs`, matching host/route tests. Provide optional service `rpDatabase`; authorize owner Remote session reads, resolve active canonical message/call source anchors, register bound native tools, mask unbound descendants. No reentrant Session append. Exact owner actions state/database/source/import/save/bind/preview/search, revision writes and bounded SSE lifecycle.
- [ ] Source references follow current visible canonical history; use direct Session messages/owner projection for rollback/fork instead of provider callId alone. Cold and active reads have matching session entry state.
- [ ] Configure embedding/rerank through plugin config with redacted state metadata. Optional Loop trace and no implicit provider fallback. No global model writes.

## Task 3: Native editor, package and integration

- [ ] Parent implements native library/entry editor, human flags, raw source viewer, pinned-session inheritance, effective overlay, changes/notes and search inspector. Dirty drafts retain base revisions, conflicts require explicit reload. Side tab/hero/header registration and disposal follow established packages.
- [ ] Build/pack/docs/CI and native mock-host smoke from this repo. Verify actual search, override, session isolation, source retention and UI. Independent review, fixes, complete package validation then publish per standing user authorization.
