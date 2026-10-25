import test from 'node:test';
import assert from 'node:assert/strict';

const entry = (extra = {}) => ({ id: 'a', title: 'Alice', content: 'A secret', keywords: [], tags: [], notes: '', readOnly: false, mode: 'auto', version: 1, ...extra });

test('locked entries reject agent updates without changing input', async () => {
  const { applyOperations } = await import('../src/core.mjs');
  const entries = [entry({ readOnly: true })];
  assert.throws(() => applyOperations(entries, [{ op: 'update', id: 'a', patch: { content: 'changed' } }]), { code: 'READ_ONLY' });
  assert.equal(entries[0].content, 'A secret');
});

test('imports preserve exact source and inert unknown extension provenance', async () => {
  const { importDatabase } = await import('../src/core.mjs');
  const rawText = ' {"name":"测试","extension":{"script":"do not execute"},"entries":[{"id":"../a","title":"A","content":"B","custom":7}]}\n';
  const result = importDatabase(rawText);
  assert.equal(result.source.rawText, rawText);
  assert.match(result.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(importDatabase(rawText).source.sha256, result.source.sha256);
  assert.notEqual(importDatabase(rawText.trim()).source.sha256, result.source.sha256);
  assert.equal(result.database.entries[0].id, '../a');
  assert.equal(result.source.provenance.extension.script, 'do not execute');
  assert.equal(result.source.provenance.entries[0].custom, 7);
  assert.deepEqual(result.database.entries[0], entry({ id: '../a', title: 'A', content: 'B' }));
});

test('ST worldbooks map constants and disabled flags without executing extensions', async () => {
  const { importDatabase } = await import('../src/core.mjs');
  const result = importDatabase(JSON.stringify({ entries: { zero: { uid: 0, comment: '城池', content: '古城', key: ['月城'], keysecondary: ['北方'], constant: true, disable: false, custom: 'inert' }, other: { uid: 1, comment: 'X', content: 'Y', disable: true } } }));
  assert.equal(result.database.entries[0].id, '0');
  assert.equal(result.database.entries[0].mode, 'required');
  assert.deepEqual(result.database.entries[0].keywords, ['月城', '北方']);
  assert.equal(result.database.entries[1].mode, 'disabled');
  assert.equal(result.source.provenance.entries.zero.custom, 'inert');
});

test('validation rejects duplicates, malformed fields and detaches valid data', async () => {
  const { validateDatabase, importDatabase } = await import('../src/core.mjs');
  const value = { id: 'db', name: 'Story', version: 1, entries: [entry()] };
  const valid = validateDatabase(value);
  valid.entries[0].content = 'detached';
  assert.equal(value.entries[0].content, 'A secret');
  assert.throws(() => validateDatabase({ ...value, entries: [entry(), entry()] }), { code: 'DUPLICATE_ID' });
  assert.throws(() => validateDatabase({ ...value, entries: [entry({ readOnly: 'yes' })] }));
  assert.throws(() => importDatabase('{broken'));
  assert.throws(() => importDatabase('{"entries":[]} trailing'));
});

test('agent policies reject locked notes, disabled changes, required removal and policy patches', async () => {
  const { applyOperations } = await import('../src/core.mjs');
  for (const op of [{ op: 'note', id: 'a', text: 'x' }, { op: 'remove', id: 'a' }]) {
    assert.throws(() => applyOperations([entry({ readOnly: true })], [op]), { code: 'READ_ONLY' });
  }
  assert.throws(() => applyOperations([entry({ mode: 'disabled' })], [{ op: 'update', id: 'a', patch: { content: 'x' } }]), { code: 'DISABLED' });
  assert.throws(() => applyOperations([entry({ mode: 'required' })], [{ op: 'remove', id: 'a' }]), { code: 'REQUIRED' });
  for (const patch of [{ readOnly: false }, { mode: 'auto' }, { version: 9 }, { id: 'other' }]) assert.throws(() => applyOperations([entry()], [{ op: 'update', id: 'a', patch }]));
  assert.throws(() => applyOperations([entry()], [{ op: 'add', entry: entry({ id: 'b', mode: 'required' }) }]));
  assert.throws(() => applyOperations([entry()], [{ op: 'add', entry: entry({ id: 'b', readOnly: true }) }]));
});

test('operation batches are atomic and cannot reuse inherited IDs after removal', async () => {
  const { applyOperations } = await import('../src/core.mjs');
  const original = [entry(), entry({ id: 'b' })];
  assert.throws(() => applyOperations(original, [{ op: 'update', id: 'a', patch: { content: 'new' } }, { op: 'remove', id: 'missing' }]));
  assert.equal(original[0].version, 1);
  assert.throws(() => applyOperations(original, [{ op: 'remove', id: 'a' }, { op: 'add', entry: entry() }]), { code: 'DUPLICATE_ID' });
  const result = applyOperations(original, [{ op: 'update', id: 'a', patch: { content: 'new' } }, { op: 'note', id: 'a', text: 'Only this turn' }, { op: 'add', entry: entry({ id: 'c' }) }]);
  assert.equal(result.entries[0].version, 2);
  assert.deepEqual(result.notes, [{ id: 'a', text: 'Only this turn' }]);
  result.entries[1].content = 'detached';
  assert.equal(original[1].content, 'A secret');
});

test('selection unions required entries in deterministic requested order and rejects disabled IDs', async () => {
  const { selectEntries } = await import('../src/core.mjs');
  const entries = [entry(), entry({ id: 'b', mode: 'required' }), entry({ id: 'c', mode: 'disabled' }), entry({ id: 'd' })];
  assert.deepEqual(selectEntries(entries, ['d', 'a', 'd']).map(x => x.id), ['d', 'a', 'b']);
  assert.deepEqual(selectEntries(entries, []).map(x => x.id), ['b']);
  assert.throws(() => selectEntries(entries, ['c']), { code: 'DISABLED' });
  assert.throws(() => selectEntries(entries, ['missing']), { code: 'NOT_FOUND' });
});
