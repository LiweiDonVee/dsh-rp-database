# Task 1 report: database kernel, revisioned store and retrieval

Implemented on `codex/initial`, based on `bc060c27ca12d0007a58a0cf7ca30c1c7d36bfb5`.
Owned source and tests: `src/core.mjs`, `src/store.mjs`, `src/retrieval.mjs`, `tests/core.test.mjs`, `tests/store.test.mjs`, `tests/retrieval.test.mjs`. The report is included in the same scoped commit; its SHA is returned in the agent handoff.

## Exports and contracts

`core.mjs` exports `DatabaseError(code, message, status=400)`, `validateDatabase(value)`, `importDatabase(rawText, {name}={})`, `applyOperations(entries, operations)`, and `selectEntries(entries, ids)`.

- Database and entry records use exactly the fields in the brief. Validation/import/operations/selection produce detached values. Duplicate IDs fail. Arbitrary nonempty data IDs, including traversal-looking IDs and prototype names, are accepted as data.
- Import supports the plugin JSON entry array and ST worldbook entry map. ST UID `0` remains ID `"0"`; secondary keys become additional keywords; disabled takes priority over constant. Raw text is preserved exactly, SHA-256 includes whitespace, and `source.provenance` contains a detached copy of the complete original parsed JSON, including unknown extension fields. Nothing in provenance is executed.
- An import returns `{database, source:{id,rawText,sha256,format,provenance}, diagnostics:[]}`. Database/source IDs are generated opaque UUIDs. Original imported provenance survives later human versions unchanged.
- Agent patches can change only title/content/keywords/tags/notes. Read-only rejects updates, removals and temporary notes; disabled rejects model mutations; required rejects removal. Additions must be auto, unlocked, version 1. Updates increment entry version. Batches are atomic.
- `selectEntries` keeps requested ID order, deduplicates IDs, and then appends required entries in database order. Unknown or disabled requested IDs reject. `readOnly` and material selection mode remain separate policies. No NPC ACL is implemented.

`store.mjs` exports `createDatabaseStore({directory})` with all methods in the brief. Reads are detached. The store writes one fixed `state.json` with generated temporary files and atomic rename; database/source/session data IDs never become paths. Map keys are SHA-256 hashes. All handles for the same resolved directory share a process-local write queue. Every mutation requires an explicit matching expectedRevision; stale revisions return `REVISION_CONFLICT`/409.

- `snapshot()` returns `{revision,databases:[{id,name,version,entryCount,sourceId}]}`. `database(id,version?)` returns the requested immutable version, latest by default. `source(sourceId)` returns the exact retained source record.
- The approved host-consumer addition `bindings()` returns detached `[{sessionId,databaseId,version}]` using stored original session IDs, with no entries or revision mutation. It supports restoring the host's synchronous session-scoping cache after restart.
- Import returns `{revision,databaseId,version,sourceId,diagnostics}`. Save returns `{revision,databaseId,version,sourceId}`. Existing saves require the latest explicit base database version and produce the next database version. Changed human entry content/policy increments its entry version; untouched entries keep their versions. A manually created database starts at version 1 and has no imported sourceId.
- Binding requires an explicit database version, pins it, and resets prior session changes. Bind/fork return `{revision,databaseId,version,session}`. Session reads return `{revision,databaseId,version,sourceId,entries,notes,changes}`. Changes are `{id,anchor,operations}` with stable generated IDs and raw detached operations.
- Agent mutation returns `{revision,session,entries,changeId}`. Empty/missing anchors reject. The approved interface extension accepts `{expectedRevision,anchor,activeAnchors?,currentAnchor?}` so validation runs on the host's canonical active projection. The returned session includes the newly committed anchor. Reads never change revision.
- Supplying activeAnchors applies exactly those historical anchors, including an empty active set. Without it, all recorded changes are visible for inspection. If an active change depends on an excluded addition, projection fails with `ANCHOR_CONFLICT`/409 instead of reviving the excluded entry. Reserved IDs survive removals and forks, preventing inherited ID shadowing across batches.
- Temporary notes are `{id,text,anchor}` and appear only when currentAnchor matches their anchor; omitted currentAnchor exposes no temporary notes. They do not mutate persistent entry notes.
- Fork captures the effective active entries and their policy as an independent child baseline, with no inherited change replay. It accepts the approved optional currentAnchor extension; only explicitly current temporary notes are copied. Existing/same child IDs reject. Source and parent remain unchanged.

`retrieval.mjs` exports `createRetriever({embed?,rerank?}={})` and `createHttpRetrieval({embedding?,reranking?,fetch?}={})`.

- `search({entries,query,limit=12,signal})` returns `{candidates:[{id,score,reasons}],required:[id],degraded:[]}`. Required IDs are separate from truncation. Disabled entries are removed before any provider input is constructed. Read-only entries can be selected normally when enabled.
- Lexical matching includes exact ID, title, keywords, tags and multilingual word/content matching, with Chinese bigrams to handle changing word boundaries. Semantic retrieval computes normalized cosine similarities and reciprocal-rank fusion with lexical ranking. Ties follow database order. Reranking receives all enabled documents, so it can surface documents outside lexical matches; partial returned ranks are followed by the prior ranked candidates. Final reranked scores use reciprocal rank.
- The embedding callback is `embed(stringArray, signal) -> number[][]`; the query is the first string, followed by enabled documents. Reranking is `rerank({query,documents,signal}) -> [{index,score}]`. Counts, dimensions, numeric finiteness, index bounds and duplicate indices are validated. No provider is called for an all-disabled database.
- Degradation strings are `embedding_unconfigured`, `reranking_unconfigured`, `embedding_failed`, and `reranking_failed`. Failures do not report semantic success or expose provider exception text. Abort rejects with sanitized `AbortError` (`Retrieval aborted`).
- HTTP configuration requires an explicit `{baseURL,model,apiKey?}`. Only HTTP(S) URLs are accepted, without URL credentials/query/fragment. Endpoints append `/embeddings` or `/rerank` to the base path; no endpoint is inferred from model names. Requests use the brief's OpenAI-compatible JSON and optional Bearer header. Embedding indices can arrive out of order. Reranking accepts conventional results/relevance_score or data/score. Transport, JSON and response errors become sanitized `RETRIEVAL_PROVIDER_ERROR`/502. Signals reach fetch. No DSH settings or credentials are read or written.

## Verification evidence

- RED was observed before implementation: the locked-entry behavioral test failed with `AssertionError: Missing expected exception` against the minimal implementation, before adding permission enforcement. Initial test suites were also run while their modules were absent.
- Latest full command: `node --test tests/*.test.mjs` — **33 passed, 0 failed**, exit 0. This includes 31 owned tests (7 core, 11 store, 13 retrieval) and the parent's two canonical-session tests.
- Latest scoped lint: `node_modules/.bin/oxlint.cmd src/core.mjs src/store.mjs src/retrieval.mjs tests/core.test.mjs tests/store.test.mjs tests/retrieval.test.mjs --deny-warnings` — exit 0, no warnings/errors.
- Covered exact source restart, pinned versions, persisted human flags, two isolated stories, atomic failed operations, same-revision races across handles, rollback filtering, dependency conflict, fork isolation, temporary note lifetime and fork transfer, reserved inherited IDs, required/disabled selection, Chinese/ID/keyword retrieval, real provider-function calls, cosine ordering, malformed vectors/ranks, failure degradation, sanitized errors and abort paths.
- HTTP tests include both intercepted fetch assertions and an actual loopback-only HTTP server receiving embedding and reranking requests through native fetch. No paid endpoint or real credential was used.

## Integration boundaries

The host must supply its canonical active anchor set to agent reads/mutations/forks, and currentAnchor whenever temporary notes should be visible. The store intentionally does not infer canonical ancestry from provider call IDs. Cross-process writer locking is outside this brief's process-local serialization contract. Native host/routes/UI/build/packaging remain parent-owned and are not claimed verified by this report.
