import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseError, importDatabase, validateDatabase } from './core.mjs';
import {applyScopedOperations,entryKey,legacySnapshot,sourceBindings} from './references.mjs';
import {factCommit,fingerprint,storySeed,validateFactState} from './facts.mjs';

// One writer queue per absolute directory, shared by every handle in this process.
const queues = new Map();
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const error = (code, message, status = 400) => { throw new DatabaseError(code, message, status); };
function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim()) error('INVALID_DATA', `${label} must be a nonempty string`);
  return value;
}
function anchorSet(activeAnchors) {
  if (activeAnchors === undefined) return undefined;
  if (!Array.isArray(activeAnchors) || activeAnchors.some(anchor => typeof anchor !== 'string' || !anchor.trim())) error('INVALID_ANCHOR', 'Active anchors must be an array of nonempty strings');
  return new Set(activeAnchors);
}

function migrateV1(state) {
  for (const record of Object.values(state.sessions)) {
    const qualify = id => ({sourceKey:'legacy',entryId:id});
    record.binding = {schemaVersion:2,sources:[{key:'legacy',databaseId:record.databaseId,version:record.version}],factEntryRefs:[]};
    record.baseline = record.baseline.map(entry => ({...entry,ref:qualify(entry.id),sourceVersion:record.version}));
    record.baselineNotes = (record.baselineNotes ?? []).map(({id,...note}) => ({...note,ref:qualify(id)}));
    record.reservedKeys = record.reservedIds.map(id => entryKey(qualify(id)));
    record.changes = record.changes.map(change => ({...change,additionSourceKey:'legacy',operations:change.operations.map(operation => {
      if (operation.op === 'add') return operation;
      const {id,...rest} = operation;return {...rest,ref:qualify(id)};
    })}));
    delete record.databaseId;delete record.version;delete record.reservedIds;
  }
  state.schemaVersion = 2;
  return state;
}

export function createDatabaseStore({ directory }) {
  identifier(directory, 'Store directory');
  const root = resolve(directory);
  const queueKey = process.platform === 'win32' ? root.toLowerCase() : root;
  const statePath = join(root, 'state.json');
  async function readState() {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (![1,2].includes(state.schemaVersion) || !Number.isSafeInteger(state.revision) || !state.databases || !state.sessions || !state.sources) error('STORE_CORRUPT', 'Unsupported or invalid database state', 500);
      if (state.schemaVersion === 1) {migrateV1(state);await writeState(state);}
      return state;
    } catch (cause) {
      if (cause.code === 'ENOENT') return { schemaVersion: 2, revision: 0, databases: {}, sources: {}, sessions: {} };
      if (cause instanceof SyntaxError) error('STORE_CORRUPT', 'Invalid database state JSON', 500);
      throw cause;
    }
  }
  async function writeState(state) {
    await mkdir(root, { recursive: true });
    const temporary = join(root, `.state-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, statePath);
    } catch (cause) {
      await rm(temporary, { force: true });
      throw cause;
    }
  }
  function serial(action) {
    const previous = queues.get(queueKey) ?? Promise.resolve();
    const result = previous.then(action);
    const settled = result.then(() => {}, () => {});
    queues.set(queueKey, settled);
    void settled.then(() => { if (queues.get(queueKey) === settled) queues.delete(queueKey); });
    return result;
  }
  const read = action => serial(async () => structuredClone(action(await readState())));
  const mutate = (expectedRevision, action, recover) => serial(async () => {
    const state = await readState();
    const recovered = recover?.(state);
    if (recovered !== undefined) return structuredClone(recovered);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) error('INVALID_REVISION', 'An expectedRevision is required');
    if (expectedRevision !== state.revision) error('REVISION_CONFLICT', 'Database state changed; reload before saving', 409);
    const result = action(state);
    state.revision++;
    await writeState(state);
    return structuredClone({ ...result, revision: state.revision });
  });
  function versions(state, id) {
    const value = state.databases[hash(identifier(id, 'Database ID'))];
    if (!value) error('NOT_FOUND', 'Database not found', 404);
    return value.versions;
  }
  function sourceVersion(state, id, version) {
    const list = versions(state, id);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) error('INVALID_DATA', 'Version must be a positive integer');
    const found = version === undefined ? list.at(-1) : list.find(item => item.database.version === version);
    if (!found) error('NOT_FOUND', 'Database version not found', 404);
    return found;
  }
  function sessionRecord(state, id) {
    const record = state.sessions[hash(identifier(id, 'Session ID'))];
    if (!record) error('NOT_FOUND', 'Session database is not bound', 404);
    return record;
  }
  function project(record, { activeAnchors, currentAnchor } = {}) {
    const active = anchorSet(activeAnchors);
    if (currentAnchor !== undefined) identifier(currentAnchor, 'Current anchor');
    let entries = structuredClone(record.baseline);
    const changes = record.changes.filter(change => active === undefined || active.has(change.anchor));
    const notes = (record.baselineNotes ?? []).filter(note => note.anchor === currentAnchor && (active === undefined || active.has(note.anchor)));
    for (const change of changes) {
      let applied;
      try { applied = applyScopedOperations(entries, change.operations,{allowFacts:true,additionSourceKey:change.additionSourceKey ?? '@session'}); } catch {
        error('ANCHOR_CONFLICT', 'Active database changes depend on excluded or incompatible changes', 409);
      }
      entries = applied.entries;
      if (change.anchor === currentAnchor) notes.push(...applied.notes.map(note => ({ ...note, anchor: change.anchor })));
    }
    const order=new Map([...record.binding.sources.map((source,index)=>[source.key,index]),['@session',record.binding.sources.length]]);
    entries.sort((left,right)=>(order.get(left.ref.sourceKey) ?? order.size)-(order.get(right.ref.sourceKey) ?? order.size));
    return {binding:structuredClone(record.binding),entries,notes,changes};
  }
  function applyChange(record, operations, {anchor,activeAnchors,currentAnchor,additionSourceKey='@session',allowFacts=false}) {
    if (typeof anchor !== 'string' || !anchor.trim()) error('INVALID_ANCHOR', 'Agent mutations require an explicit canonical anchor');
    const effective = project(record,{activeAnchors,currentAnchor});
    if (!Array.isArray(operations)) error('INVALID_OPERATION', 'Operations must be an array');
    const reserved = new Set(record.reservedKeys);
    for (const operation of operations) if (operation?.op === 'add' && reserved.has(entryKey({sourceKey:additionSourceKey,entryId:operation.entry?.id}))) error('DUPLICATE_ID','Entry ID is already inherited or used');
    const applied = applyScopedOperations(effective.entries,operations,{additionSourceKey,allowFacts,factEntryRefs:record.binding.factEntryRefs});
    if (allowFacts) validateFactState(applied.entries,record.binding.factEntryRefs);
    const change = {id:randomUUID(),anchor,operations:structuredClone(operations),additionSourceKey};
    record.changes.push(change);
    for (const operation of operations) if (operation.op === 'add') reserved.add(entryKey({sourceKey:additionSourceKey,entryId:operation.entry.id}));
    record.reservedKeys = [...reserved];
    const nextActive = activeAnchors === undefined ? undefined : [...new Set([...activeAnchors,anchor])];
    return {session:project(record,{activeAnchors:nextActive,currentAnchor:currentAnchor ?? anchor}),entries:applied.entries,changeId:change.id};
  }
  function projectedReceipt(receipt,sessionId) {
    return {...receipt,...receipt.sessionId === sessionId ? {} : {sessionId,originSessionId:receipt.sessionId}};
  }
  function activeReceipt(item,activeAnchors) {
    const active=anchorSet(activeAnchors);
    return !active || active.has(item.receipt.source.assistantMessageId);
  }
  return {
    bindings() {
      return read(state => Object.values(state.sessions).map(record => ({sessionId:record.id,databaseId:record.binding.sources[0]?.databaseId,version:record.binding.sources[0]?.version})));
    },
    bindingsV2() {return read(state => Object.values(state.sessions).map(record => ({sessionId:record.id,binding:record.binding})));},
    snapshot() {
      return read(state => ({ revision: state.revision, databases: Object.values(state.databases).map(record => {
        const latest = record.versions.at(-1);
        return { id: latest.database.id, name: latest.database.name, version: latest.database.version, entryCount: latest.database.entries.length, sourceId: latest.sourceId };
      }) }));
    },
    database(id, version) { return read(state => sourceVersion(state, id, version).database); },
    source(sourceId) {
      return read(state => {
        const source = state.sources[hash(identifier(sourceId, 'Source ID'))];
        if (!source) error('NOT_FOUND', 'Source not found', 404);
        return source;
      });
    },
    importSource(rawText, { name, expectedRevision } = {}) {
      return mutate(expectedRevision, state => {
        const { database, source, diagnostics } = importDatabase(rawText, { name });
        state.databases[hash(database.id)] = { versions: [{ database, sourceId: source.id }] };
        state.sources[hash(source.id)] = source;
        return { databaseId: database.id, version: database.version, sourceId: source.id, diagnostics };
      });
    },
    saveDatabase(value, { expectedRevision } = {}) {
      return mutate(expectedRevision, state => {
        const database = validateDatabase(value);
        const record = state.databases[hash(database.id)];
        let sourceId;
        if (record) {
          const latest = record.versions.at(-1);
          if (database.version !== latest.database.version) error('VERSION_CONFLICT', 'Save requires the latest explicit database base version', 409);
          sourceId = latest.sourceId;
          const prior = new Map(latest.database.entries.map(entry => [entry.id, entry]));
          database.entries = database.entries.map(entry => {
            const old = prior.get(entry.id);
            if (!old) return { ...entry, version: 1 };
            const changed = JSON.stringify({ ...old, version: 0 }) !== JSON.stringify({ ...entry, version: 0 });
            return { ...entry, version: old.version + Number(changed) };
          });
          database.version++;
          record.versions.push({ database, sourceId });
        } else {
          if (database.version !== 1) error('VERSION_CONFLICT', 'A new database must start at version 1', 409);
          state.databases[hash(database.id)] = { versions: [{ database }] };
        }
        return { databaseId: database.id, version: database.version, sourceId };
      });
    },
    bindSession(sessionId, { databaseId, version, expectedRevision } = {}) {
      return mutate(expectedRevision, state => {
        identifier(sessionId, 'Session ID');
        if (state.sessions[hash(sessionId)]?.initialization) error('STORY_RESTART_REQUIRED','An initialized GM story cannot reset its facts or receipts; create a new story',409);
        if (!Number.isSafeInteger(version) || version < 1) error('INVALID_DATA', 'Binding requires an explicit source version');
        const source = sourceVersion(state, databaseId, version);
        const baseline = source.database.entries.map(entry => ({...entry,ref:{sourceKey:'legacy',entryId:entry.id},sourceVersion:version}));
        const record = {id:sessionId,binding:{schemaVersion:2,sources:[{key:'legacy',databaseId,version}],factEntryRefs:[]},sourceId:source.sourceId,baseline,baselineNotes:[],reservedKeys:baseline.map(entry => entryKey(entry.ref)),changes:[]};
        state.sessions[hash(sessionId)] = record;
        const session = legacySnapshot({...project(record),sourceId:record.sourceId});delete session.revision;
        return {session,databaseId,version};
      });
    },
    bindSources(sessionId,{sources,expectedRevision,resetOverlay=false}={}) {
      return mutate(expectedRevision,state => {
        identifier(sessionId,'Session ID');
        if (typeof resetOverlay !== 'boolean') error('INVALID_BINDING','resetOverlay must be boolean');
        const normalized = sourceBindings(sources),prior = state.sessions[hash(sessionId)];
        if (prior?.initialization && resetOverlay) error('STORY_RESTART_REQUIRED','An initialized GM story cannot reset its facts or receipts; create a new story',409);
        const retained = new Set(normalized.filter(source => prior?.binding.sources.some(old => old.key === source.key && old.databaseId === source.databaseId && old.version === source.version)).map(source => source.key));
        const affected = new Set((prior?.binding.sources ?? []).filter(source => !retained.has(source.key)).map(source => source.key));
        const dependent = prior && (prior.changes.some(change => change.operations.some(operation => operation.op === 'add' ? affected.has(change.additionSourceKey) : affected.has(operation.ref.sourceKey))) || prior.binding.factEntryRefs.some(ref => affected.has(ref.sourceKey)));
        if (dependent && prior.initialization) error('STORY_RESTART_REQUIRED','Changing these sources would discard initialized story state; create a new story',409);
        if (dependent && !resetOverlay) error('BINDING_CHANGE_REQUIRES_RESET','The changed source slots have story changes; review and explicitly reset the overlay',409);
        const baseline = normalized.flatMap(source => {
          const pinned = sourceVersion(state,source.databaseId,source.version);
          return prior && retained.has(source.key) && !resetOverlay ? prior.baseline.filter(entry => entry.ref.sourceKey === source.key) : pinned.database.entries.map(entry => ({...entry,ref:{sourceKey:source.key,entryId:entry.id},sourceVersion:source.version}));
        });
        if (prior && !resetOverlay) baseline.push(...prior.baseline.filter(entry => entry.ref.sourceKey === '@session'));
        const record = prior && !resetOverlay ? {...prior,baseline,binding:{...prior.binding,sources:normalized}} : {id:sessionId,binding:{schemaVersion:2,sources:normalized,factEntryRefs:[]},baseline,baselineNotes:[],reservedKeys:[],changes:[]};
        if(normalized.length===1)record.sourceId=sourceVersion(state,normalized[0].databaseId,normalized[0].version).sourceId;
        else delete record.sourceId;
        record.reservedKeys = [...new Set([...record.reservedKeys,...baseline.map(entry => entryKey(entry.ref))])];
        state.sessions[hash(sessionId)] = record;
        return {binding:record.binding};
      });
    },
    session(sessionId, options) {
      return read(state => {const record=sessionRecord(state,sessionId);return legacySnapshot({...project(record,options),sourceId:record.sourceId,revision:state.revision});});
    },
    sessionV2(sessionId,options) {return read(state => ({...project(sessionRecord(state,sessionId),options),revision:state.revision}));},
    applyOperations(sessionId, operations, { expectedRevision, anchor, activeAnchors, currentAnchor } = {}) {
      return mutate(expectedRevision, state => {
        const record = sessionRecord(state, sessionId);
        const effective = project(record,{activeAnchors,currentAnchor});legacySnapshot(effective);
        if (!Array.isArray(operations)) error('INVALID_OPERATION','Operations must be an array');
        const qualified = operations.map(operation => {
          if (operation?.op === 'add') return operation;
          const {id,...rest}=operation ?? {};
          const entry = effective.entries.find(entry => entry.id === id);
          if (!entry) error('NOT_FOUND',`Entry not found: ${id}`,404);
          return {...rest,ref:entry.ref};
        });
        const result=applyChange(record,qualified,{anchor,activeAnchors,currentAnchor,additionSourceKey:record.binding.sources[0]?.key ?? '@session'});
        const session=legacySnapshot({...result.session,sourceId:record.sourceId});delete session.revision;
        return {...result,session,entries:session.entries};
      });
    },
    applyOperationsV2(sessionId,operations,{expectedRevision,...options}={}) {return mutate(expectedRevision,state => applyChange(sessionRecord(state,sessionId),operations,options));},
    initializeStoryState(sessionId,input) {
      const seed=storySeed(input),digest=fingerprint({entries:seed.entries,factEntryRefs:seed.factEntryRefs});
      return mutate(input.expectedRevision,state => {
        const record=sessionRecord(state,sessionId),reserved=new Set(record.reservedKeys);
        if (seed.entries.some(entry => reserved.has(entryKey(entry.ref)))) error('SEED_CONFLICT','A story seed cannot overwrite an existing session entry',409);
        record.baseline.push(...seed.entries);
        record.reservedKeys.push(...seed.entries.map(entry => entryKey(entry.ref)));
        record.binding.factEntryRefs=seed.factEntryRefs;
        const result={revision:state.revision+1,factEntryRefs:seed.factEntryRefs};
        record.initialization={launchId:seed.launchId,fingerprint:digest,result};
        record.receipts=[];
        return result;
      },state => {
        const initialized=sessionRecord(state,sessionId).initialization;
        if (!initialized) return undefined;
        if (initialized.launchId !== seed.launchId) error('STORY_ALREADY_INITIALIZED','This story already has a GM seed',409);
        if (initialized.fingerprint !== digest) error('LAUNCH_CONFLICT','This launch ID was already used with a different seed',409);
        return initialized.result;
      });
    },
    async commitFacts(sessionId,input,{activeAnchors,currentAnchor}={}) {
      const normalized=factCommit(input,sessionId),{expectedRevision,...content}=normalized,digest=fingerprint(content);
      const result=await mutate(expectedRevision,state => {
        const record=sessionRecord(state,sessionId);
        if (!record.initialization) error('STORY_NOT_INITIALIZED','Initialize the GM story state before committing facts',409);
        const anchor=normalized.source.assistantMessageId;
        const applied=normalized.operations.length ? applyChange(record,normalized.operations,{anchor,activeAnchors,currentAnchor,allowFacts:true}) : {session:project(record,{activeAnchors,currentAnchor}),changeId:null};
        const stateRefs=record.binding.factEntryRefs.map(ref => ({...ref,version:applied.session.entries.find(entry => entryKey(entry.ref) === entryKey(ref)).version}));
        const receipt={schemaVersion:1,id:randomUUID(),sessionId,turnKey:normalized.turnKey,source:normalized.source,kind:normalized.kind,databaseRevision:state.revision+1,changeId:applied.changeId,stateRefs,summary:normalized.summary,packet:normalized.packet,...normalized.kind === 'opening' ? {openingText:normalized.openingText} : {},createdAt:new Date().toISOString()};
        (record.receipts ??= []).push({receipt,fingerprint:digest});
        return {receipt};
      },state => {
        const record=sessionRecord(state,sessionId),item=(record.receipts ?? []).find(item => item.receipt.source.turnStartSeq === normalized.source.turnStartSeq && activeReceipt(item,activeAnchors));
        if (!item) return undefined;
        if (item.fingerprint !== digest) {
          const conflict=new DatabaseError('TURN_ALREADY_COMMITTED','This active turn already has a fact receipt',409);conflict.receiptId=item.receipt.id;throw conflict;
        }
        return {receipt:projectedReceipt(item.receipt,sessionId)};
      });
      return result.receipt;
    },
    receipt(sessionId,{id,turnKey},{activeAnchors}={}) {
      return read(state => {
        const record=sessionRecord(state,sessionId);
        let seq;try{const parts=JSON.parse(turnKey);if(Array.isArray(parts)&&parts[0]===sessionId&&Number.isSafeInteger(parts[1]))seq=parts[1];}catch{/* Receipt IDs do not require a turn selector. */}
        const matches=(record.receipts ?? []).filter(item => id ? item.receipt.id === id : item.receipt.turnKey === turnKey || seq !== undefined && item.receipt.source.turnStartSeq === seq);
        const item=matches.find(item=>activeReceipt(item,activeAnchors)) ?? matches[0];
        if (!item) {if(id)error('RECEIPT_NOT_FOUND','The receipt is unavailable in this story',404);return null;}
        if (!activeReceipt(item,activeAnchors)) error('INACTIVE_SOURCE','The receipt source is no longer active',409);
        return projectedReceipt(item.receipt,sessionId);
      });
    },
    forkSession(fromId, toId, { activeAnchors, currentAnchor, expectedRevision } = {}) {
      return mutate(expectedRevision, state => {
        identifier(toId, 'Child session ID');
        if (fromId === toId || state.sessions[hash(toId)]) error('SESSION_EXISTS', 'Fork requires a distinct unbound child session', 409);
        const parent = sessionRecord(state, fromId);
        const effective = project(parent, { activeAnchors, currentAnchor });
        // Retain inherited causal changes so a child rollback into its seed can
        // exclude them. Flattening to effective.entries would make them permanent.
        const inherited = effective.changes.map(change => ({ ...change, operations: change.operations.filter(operation => operation.op !== 'note' || change.anchor === currentAnchor) }));
        const baselineNotes = (parent.baselineNotes ?? []).filter(note => note.anchor === currentAnchor);
        const child = {...structuredClone(parent),id:toId,baselineNotes,changes:inherited};
        child.receipts=(parent.receipts ?? []).filter(item => activeReceipt(item,activeAnchors));
        state.sessions[hash(toId)] = child;
        return {session:project(child,{currentAnchor}),binding:child.binding};
      });
    },
  };
}
