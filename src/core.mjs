import { createHash, randomUUID } from 'node:crypto';
import { parseWorldbook } from './worldbook.mjs';

export class DatabaseError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status) => { throw new DatabaseError(code, message, status); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, field, nonempty = false) => {
  if (typeof value !== 'string' || (nonempty && !value.trim())) fail('INVALID_DATA', `${field} must be ${nonempty ? 'a nonempty string' : 'a string'}`);
  return value;
};
const strings = (value, field) => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail('INVALID_DATA', `${field} must be an array of strings`);
  return [...value];
};

function normalizeEntry(value) {
  if (!record(value)) fail('INVALID_DATA', 'Entry must be an object');
  const { readOnly = false, mode = 'auto', version = 1 } = value;
  if (typeof readOnly !== 'boolean' || !['auto', 'required', 'disabled'].includes(mode) || !Number.isSafeInteger(version) || version < 1) fail('INVALID_DATA', 'Invalid entry policy or version');
  return {
    id: string(value.id, 'Entry ID', true),
    title: string(value.title ?? '', 'Entry title'),
    content: string(value.content ?? '', 'Entry content'),
    keywords: strings(value.keywords ?? [], 'Keywords'),
    tags: strings(value.tags ?? [], 'Tags'),
    notes: string(value.notes ?? '', 'Notes'),
    readOnly, mode, version,
  };
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) fail('INVALID_DATA', 'Entries must be an array');
  const result = entries.map(normalizeEntry);
  const seen = new Set();
  for (const entry of result) {
    if (seen.has(entry.id)) fail('DUPLICATE_ID', `Duplicate entry ID: ${entry.id}`);
    seen.add(entry.id);
  }
  return result;
}

export function validateDatabase(value) {
  if (!record(value)) fail('INVALID_DATA', 'Database must be an object');
  if (!Number.isSafeInteger(value.version) || value.version < 1) fail('INVALID_DATA', 'Database version must be a positive integer');
  return { id: string(value.id, 'Database ID', true), name: string(value.name, 'Database name', true), version: value.version, entries: normalizeEntries(value.entries) };
}

export function importDatabase(rawText, { name } = {}) {
  string(rawText, 'Source');
  let parsed;
  try { parsed = JSON.parse(rawText.replace(/^\uFEFF/u,'')); } catch { fail('INVALID_JSON', 'Source must contain valid JSON'); }
  if (!record(parsed)) fail('INVALID_DATA', 'Source must contain an object');
  const imported=parseWorldbook(parsed,fail);
  if(!imported&&!Array.isArray(parsed.entries))fail('INVALID_DATA','Source must contain database or SillyTavern worldbook entries');
  const entries=imported?.entries??parsed.entries,format=imported?.format??'rp-database',diagnostics=imported?.diagnostics??[];
  const database = validateDatabase({ id: randomUUID(), name: name ?? imported?.name ?? parsed.name ?? 'Imported database', version: 1, entries });
  const importReport={format,entryCount:entries.length,entryRefs:imported?.entryRefs??entries.map((entry,index)=>({id:entry.id,path:`entries.${index}`,index})),diagnostics:structuredClone(diagnostics)};
  const source = { id: randomUUID(), rawText, sha256: createHash('sha256').update(rawText, 'utf8').digest('hex'), format, provenance: structuredClone(parsed),importReport };
  return { database, source, diagnostics };
}

export function applyOperations(entries, operations) {
  const result = normalizeEntries(entries);
  if (!Array.isArray(operations)) fail('INVALID_OPERATION', 'Operations must be an array');
  const reserved = new Set(result.map(entry => entry.id));
  const notes = [];
  for (const operation of operations) {
    if (!record(operation)) fail('INVALID_OPERATION', 'Operation must be an object');
    if (operation.op === 'add') {
      const added = normalizeEntry(operation.entry);
      if (reserved.has(added.id)) fail('DUPLICATE_ID', `Entry ID is already inherited or used: ${added.id}`);
      if (added.readOnly || added.mode !== 'auto' || added.version !== 1) fail('INVALID_OPERATION', 'Agent additions must be unlocked, auto entries at version 1');
      reserved.add(added.id);
      result.push(added);
      continue;
    }
    if (!['update', 'remove', 'note'].includes(operation.op)) fail('INVALID_OPERATION', 'Unknown operation');
    const id = string(operation.id, 'Operation ID', true);
    const index = result.findIndex(entry => entry.id === id);
    if (index < 0) fail('NOT_FOUND', `Entry not found: ${id}`, 404);
    const target = result[index];
    if (target.readOnly) fail('READ_ONLY', `Entry is read-only: ${id}`, 403);
    if (target.mode === 'disabled') fail('DISABLED', `Entry is disabled: ${id}`, 403);
    if (operation.op === 'remove') {
      if (target.mode === 'required') fail('REQUIRED', `Required entry cannot be removed: ${id}`, 403);
      result.splice(index, 1);
    } else if (operation.op === 'note') {
      notes.push({ id, text: string(operation.text, 'Temporary note', true) });
    } else {
      if (!record(operation.patch) || Object.keys(operation.patch).some(key => !['title', 'content', 'keywords', 'tags', 'notes'].includes(key))) fail('INVALID_OPERATION', 'Agent patches may only change entry content fields');
      result[index] = normalizeEntry({ ...target, ...operation.patch, version: target.version + 1 });
    }
  }
  return { entries: result, notes };
}

export function selectEntries(entries, ids) {
  const normalized = normalizeEntries(entries);
  const requested = strings(ids, 'Selected IDs');
  const byId = new Map(normalized.map(entry => [entry.id, entry]));
  const selected = new Set();
  for (const id of requested) {
    const entry = byId.get(id);
    if (!entry) fail('NOT_FOUND', `Entry not found: ${id}`, 404);
    if (entry.mode === 'disabled') fail('DISABLED', `Entry is disabled: ${id}`, 403);
    selected.add(id);
  }
  for (const entry of normalized) if (entry.mode === 'required') selected.add(entry.id);
  return [...selected].map(id => byId.get(id));
}
