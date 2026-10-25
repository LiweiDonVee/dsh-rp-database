import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseError, applyOperations as applyEntryOperations, importDatabase, validateDatabase } from './core.mjs';

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

export function createDatabaseStore({ directory }) {
  identifier(directory, 'Store directory');
  const root = resolve(directory);
  const queueKey = process.platform === 'win32' ? root.toLowerCase() : root;
  const statePath = join(root, 'state.json');
  async function readState() {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || !state.databases || !state.sessions || !state.sources) error('STORE_CORRUPT', 'Unsupported or invalid database state', 500);
      return state;
    } catch (cause) {
      if (cause.code === 'ENOENT') return { schemaVersion: 1, revision: 0, databases: {}, sources: {}, sessions: {} };
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
  const mutate = (expectedRevision, action) => serial(async () => {
    const state = await readState();
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
      try { applied = applyEntryOperations(entries, change.operations); } catch {
        error('ANCHOR_CONFLICT', 'Active database changes depend on excluded or incompatible changes', 409);
      }
      entries = applied.entries;
      if (change.anchor === currentAnchor) notes.push(...applied.notes.map(note => ({ ...note, anchor: change.anchor })));
    }
    return { databaseId: record.databaseId, version: record.version, sourceId: record.sourceId, entries, notes, changes };
  }
  return {
    bindings() {
      return read(state => Object.values(state.sessions).map(record => ({ sessionId: record.id, databaseId: record.databaseId, version: record.version })));
    },
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
        if (!Number.isSafeInteger(version) || version < 1) error('INVALID_DATA', 'Binding requires an explicit source version');
        const source = sourceVersion(state, databaseId, version);
        const record = { id: sessionId, databaseId, version, sourceId: source.sourceId, baseline: structuredClone(source.database.entries), baselineNotes: [], reservedIds: source.database.entries.map(entry => entry.id), changes: [] };
        state.sessions[hash(sessionId)] = record;
        return { session: project(record), databaseId, version };
      });
    },
    session(sessionId, options) {
      return read(state => ({ ...project(sessionRecord(state, sessionId), options), revision: state.revision }));
    },
    applyOperations(sessionId, operations, { expectedRevision, anchor, activeAnchors, currentAnchor } = {}) {
      return mutate(expectedRevision, state => {
        if (typeof anchor !== 'string' || !anchor.trim()) error('INVALID_ANCHOR', 'Agent mutations require an explicit canonical anchor');
        const record = sessionRecord(state, sessionId);
        const effective = project(record, { activeAnchors, currentAnchor });
        if (!Array.isArray(operations)) error('INVALID_OPERATION', 'Operations must be an array');
        const reserved = new Set(record.reservedIds);
        for (const operation of operations) if (operation?.op === 'add' && reserved.has(operation.entry?.id)) error('DUPLICATE_ID', 'Entry ID is already inherited or used');
        const applied = applyEntryOperations(effective.entries, operations);
        const change = { id: randomUUID(), anchor, operations: structuredClone(operations) };
        record.changes.push(change);
        for (const operation of operations) if (operation.op === 'add') reserved.add(operation.entry.id);
        record.reservedIds = [...reserved];
        const nextActive = activeAnchors === undefined ? undefined : [...new Set([...activeAnchors, anchor])];
        return { session: project(record, { activeAnchors: nextActive, currentAnchor: currentAnchor ?? anchor }), entries: applied.entries, changeId: change.id };
      });
    },
    forkSession(fromId, toId, { activeAnchors, currentAnchor, expectedRevision } = {}) {
      return mutate(expectedRevision, state => {
        identifier(toId, 'Child session ID');
        if (fromId === toId || state.sessions[hash(toId)]) error('SESSION_EXISTS', 'Fork requires a distinct unbound child session', 409);
        const parent = sessionRecord(state, fromId);
        const effective = project(parent, { activeAnchors, currentAnchor });
        const child = { id: toId, databaseId: parent.databaseId, version: parent.version, sourceId: parent.sourceId, baseline: effective.entries, baselineNotes: effective.notes, reservedIds: [...parent.reservedIds], changes: [] };
        state.sessions[hash(toId)] = child;
        return { session: project(child, { currentAnchor }), databaseId: child.databaseId, version: child.version };
      });
    },
  };
}
