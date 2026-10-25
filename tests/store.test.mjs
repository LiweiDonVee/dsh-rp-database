import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t) {
  const { createDatabaseStore } = await import('../src/store.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'rp-database-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { store: createDatabaseStore({ directory }), directory, reopen: () => createDatabaseStore({ directory }) };
}
const raw = ' {"name":"World","entries":[{"id":"hero","title":"英雄","content":"原始","notes":"传闻","readOnly":false,"mode":"auto"},{"id":"required","content":"must","mode":"required"},{"id":"disabled","content":"hidden","mode":"disabled"}]}\n';
async function bind(store, sessionId = 'story') {
  const imported = await store.importSource(raw, { expectedRevision: 0 });
  await store.bindSession(sessionId, { databaseId: imported.databaseId, version: 1, expectedRevision: 1 });
  return imported;
}

test('source exact text and immutable pinned versions survive restart and unsafe IDs', async t => {
  const { store, directory, reopen } = await fixture(t);
  const imported = await bind(store, '../../story');
  assert.equal(imported.revision, 1);
  const saved = await store.database(imported.databaseId);
  saved.name = 'Next'; saved.entries[0].readOnly = true; saved.entries[0].mode = 'required';
  const changed = await store.saveDatabase(saved, { expectedRevision: 2 });
  assert.equal(changed.version, 2);
  const fresh = reopen();
  assert.equal((await fresh.database(imported.databaseId)).entries[0].readOnly, true);
  assert.equal((await fresh.session('../../story')).entries[0].readOnly, false);
  assert.equal((await fresh.session('../../story')).version, 1);
  assert.equal((await fresh.source(imported.sourceId)).rawText, raw);
  assert.equal((await fresh.database(imported.databaseId, 1)).name, 'World');
  assert.deepEqual(await readdir(directory), ['state.json']);
  const source = await fresh.source(imported.sourceId); source.rawText = 'bad';
  assert.equal((await fresh.source(imported.sourceId)).rawText, raw);
  const text = await readFile(join(directory, 'state.json'), 'utf8');
  assert.ok(text.includes('sha256'));
});

test('latest-base and revision checks reject stale human saves', async t => {
  const { store } = await fixture(t);
  const imported = await store.importSource(raw, { expectedRevision: 0 });
  const database = await store.database(imported.databaseId);
  await store.saveDatabase(database, { expectedRevision: 1 });
  await assert.rejects(store.saveDatabase(database, { expectedRevision: 2 }), { code: 'VERSION_CONFLICT', status: 409 });
  const latest = await store.database(imported.databaseId); delete latest.version;
  await assert.rejects(store.saveDatabase(latest, { expectedRevision: 2 }));
  assert.equal((await store.snapshot()).revision, 2);
});

test('two independent handles serialize same-revision races', async t => {
  const { store, reopen } = await fixture(t);
  const results = await Promise.allSettled([store.importSource(raw, { expectedRevision: 0 }), reopen().importSource(raw, { expectedRevision: 0 })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal((await reopen().snapshot()).revision, 1);
});

test('two stories isolate changes and failed operation batches leave revision unchanged', async t => {
  const { store } = await fixture(t);
  const imported = await bind(store, 'one');
  await store.bindSession('two', { databaseId: imported.databaseId, version: 1, expectedRevision: 2 });
  const result = await store.applyOperations('one', [{ op: 'update', id: 'hero', patch: { content: 'changed' } }], { expectedRevision: 3, anchor: 'assistant:1' });
  assert.equal(result.entries[0].content, 'changed');
  assert.ok(result.changeId);
  assert.equal((await store.session('two')).entries[0].content, '原始');
  assert.equal((await store.database(imported.databaseId)).entries[0].content, '原始');
  await assert.rejects(store.applyOperations('one', [{ op: 'update', id: 'hero', patch: { content: 'partial' } }, { op: 'remove', id: 'required' }], { expectedRevision: 4, anchor: 'assistant:2' }), { code: 'REQUIRED' });
  assert.equal((await store.snapshot()).revision, 4);
  assert.equal((await store.session('one')).entries[0].content, 'changed');
});

test('rollback excludes inactive anchors and temporary notes last only their current anchor', async t => {
  const { store, reopen } = await fixture(t);
  await bind(store);
  await store.applyOperations('story', [{ op: 'update', id: 'hero', patch: { content: 'first' } }, { op: 'note', id: 'hero', text: 'first note' }], { expectedRevision: 2, anchor: 'assistant:1' });
  await store.applyOperations('story', [{ op: 'update', id: 'hero', patch: { content: 'abandoned' } }, { op: 'note', id: 'hero', text: 'abandoned note' }], { expectedRevision: 3, anchor: 'assistant:2' });
  const rolled = await reopen().session('story', { activeAnchors: ['assistant:1'], currentAnchor: 'assistant:1' });
  assert.equal(rolled.entries[0].content, 'first');
  assert.deepEqual(rolled.notes, [{ id: 'hero', text: 'first note', anchor: 'assistant:1' }]);
  assert.equal(rolled.changes.length, 1);
  assert.equal(rolled.changes[0].anchor, 'assistant:1');
  assert.deepEqual(rolled.changes[0].operations[0], { op: 'update', id: 'hero', patch: { content: 'first' } });
  assert.deepEqual((await store.session('story', { activeAnchors: ['assistant:1'], currentAnchor: 'assistant:3' })).notes, []);
  assert.deepEqual((await store.session('story')).notes, []);
  await store.applyOperations('story', [{ op: 'update', id: 'hero', patch: { notes: 'new branch' } }], { expectedRevision: 4, anchor: 'assistant:3', activeAnchors: ['assistant:1'] });
  const branched = await store.session('story', { activeAnchors: ['assistant:1', 'assistant:3'] });
  assert.equal(branched.entries[0].content, 'first');
  assert.equal(branched.entries[0].notes, 'new branch');
  assert.equal(branched.entries[0].version, 3);
});

test('fork snapshots active state and policy into an independent child baseline', async t => {
  const { store } = await fixture(t);
  const imported = await bind(store);
  await store.applyOperations('story', [{ op: 'update', id: 'hero', patch: { content: 'fork point' } }], { expectedRevision: 2, anchor: 'a1' });
  await store.applyOperations('story', [{ op: 'update', id: 'hero', patch: { content: 'future' } }], { expectedRevision: 3, anchor: 'a2' });
  await store.forkSession('story', '__proto__', { activeAnchors: ['a1'], expectedRevision: 4 });
  assert.equal((await store.session('__proto__', { activeAnchors: [] })).entries[0].content, 'fork point');
  assert.equal((await store.session('__proto__')).entries[1].mode, 'required');
  await store.applyOperations('__proto__', [{ op: 'update', id: 'hero', patch: { content: 'child' } }], { expectedRevision: 5, anchor: 'child1' });
  assert.equal((await store.session('story')).entries[0].content, 'future');
  assert.equal((await store.database(imported.databaseId)).entries[0].content, '原始');
  await assert.rejects(store.forkSession('story', 'story', { activeAnchors: [], expectedRevision: 6 }));
});

test('agent mutations require anchors, inherited deleted IDs remain reserved, bind resets changes', async t => {
  const { store } = await fixture(t);
  const imported = await bind(store);
  for (const anchor of [undefined, '', ' ']) await assert.rejects(store.applyOperations('story', [], { expectedRevision: 2, anchor }), { code: 'INVALID_ANCHOR' });
  await store.applyOperations('story', [{ op: 'remove', id: 'hero' }], { expectedRevision: 2, anchor: 'a1' });
  await assert.rejects(store.applyOperations('story', [{ op: 'add', entry: { id: 'hero', content: 'shadow' } }], { expectedRevision: 3, anchor: 'a2' }), { code: 'DUPLICATE_ID' });
  await store.bindSession('story', { databaseId: imported.databaseId, version: 1, expectedRevision: 3 });
  assert.equal((await store.session('story')).entries[0].content, '原始');
  assert.deepEqual((await store.session('story')).changes, []);
});

test('active operations depending on excluded additions fail instead of reviving excluded state', async t => {
  const { store } = await fixture(t);
  await bind(store);
  await store.applyOperations('story', [{ op: 'add', entry: { id: 'new', content: 'introduced' } }], { expectedRevision: 2, anchor: 'a1' });
  await store.applyOperations('story', [{ op: 'update', id: 'new', patch: { content: 'later' } }], { expectedRevision: 3, anchor: 'a2' });
  await assert.rejects(store.session('story', { activeAnchors: ['a2'] }), { code: 'ANCHOR_CONFLICT', status: 409 });
  assert.deepEqual((await store.session('story', { activeAnchors: [] })).entries.map(entry => entry.id), ['hero', 'required', 'disabled']);
  assert.equal((await store.snapshot()).revision, 4);
});

test('fork temporary notes require an explicit matching current anchor', async t => {
  const { store } = await fixture(t);
  await bind(store);
  await store.applyOperations('story', [{ op: 'note', id: 'hero', text: 'this turn only' }], { expectedRevision: 2, anchor: 'a1' });
  await store.forkSession('story', 'no-notes', { activeAnchors: ['a1'], expectedRevision: 3 });
  assert.deepEqual((await store.session('no-notes', { currentAnchor: 'a1' })).notes, []);
  await store.forkSession('story', 'with-notes', { activeAnchors: ['a1'], currentAnchor: 'a1', expectedRevision: 4 });
  assert.deepEqual((await store.session('with-notes', { currentAnchor: 'a1' })).notes, [{ id: 'hero', text: 'this turn only', anchor: 'a1' }]);
  assert.deepEqual((await store.session('with-notes', { currentAnchor: 'a2' })).notes, []);
});

test('human databases preserve arbitrary data IDs while locked policy persists in a pinned story', async t => {
  const { store } = await fixture(t);
  const result = await store.saveDatabase({ id: '../../db', name: 'Owner data', version: 1, entries: [{ id: '__proto__', content: 'locked', readOnly: true, mode: 'required' }] }, { expectedRevision: 0 });
  assert.equal(result.version, 1);
  await store.bindSession('constructor', { databaseId: '../../db', version: 1, expectedRevision: 1 });
  await assert.rejects(store.applyOperations('constructor', [{ op: 'note', id: '__proto__', text: 'denied' }], { expectedRevision: 2, anchor: 'a1' }), { code: 'READ_ONLY' });
  const session = await store.session('constructor');
  session.entries[0].mode = 'auto';
  assert.equal((await store.session('constructor')).entries[0].mode, 'required');
});

test('startup binding metadata survives restart and returns detached session identifiers', async t => {
  const { store, reopen } = await fixture(t);
  const imported = await bind(store, '../../story');
  await store.forkSession('../../story', '__proto__', { activeAnchors: [], expectedRevision: 2 });
  const bindings = await reopen().bindings();
  assert.deepEqual(bindings, [
    { sessionId: '../../story', databaseId: imported.databaseId, version: 1 },
    { sessionId: '__proto__', databaseId: imported.databaseId, version: 1 },
  ]);
  bindings[0].sessionId = 'mutated';
  assert.equal((await store.bindings())[0].sessionId, '../../story');
  assert.equal((await store.snapshot()).revision, 3);
});
