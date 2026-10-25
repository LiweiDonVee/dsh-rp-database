import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDatabaseStore} from '../src/store.mjs'
import {extractText} from '../src/documents.mjs'

async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'rp-db-content-'));t.after(()=>rm(directory,{recursive:true,force:true}));return{store:createDatabaseStore({directory}),reopen:()=>createDatabaseStore({directory})}}
test('content packs create fresh database IDs and preserve exact inert source and human policies',async t=>{
  const from=await fixture(t),to=await fixture(t),rawText='\uFEFF{"name":"Same name","entries":[{"id":"0","content":"original","readOnly":true,"mode":"required"}],"script":"never execute"}\r\n'
  const imported=await from.store.importSource(rawText,{expectedRevision:0}),database=await from.store.database(imported.databaseId)
  database.entries[0].content='owner revised';await from.store.saveDatabase(database,{expectedRevision:1})
  assert.equal(typeof from.store.exportContent,'function','content provider exists')
  const payload=await from.store.exportContent({databaseId:imported.databaseId,version:2})
  assert.equal(payload.source.rawText,rawText);assert.equal(payload.database.entries[0].content,'owner revised')
  const result=await to.store.importContent({...payload,requestId:'pack-row',expectedRevision:0})
  assert.notEqual(result.databaseId,imported.databaseId);assert.equal(result.version,1)
  assert.deepEqual((await to.store.database(result.databaseId)).entries,payload.database.entries)
  const source=await to.store.source(result.sourceId)
  assert.equal(source.rawText,rawText);assert.deepEqual(source.provenance,payload.source.provenance);assert.equal(source.sha256,payload.source.sha256)
  assert.deepEqual(await to.reopen().importContent({...payload,requestId:'pack-row',expectedRevision:0}),result)
  assert.equal((await to.store.snapshot()).revision,1)
  await assert.rejects(to.store.importContent({...payload,database:{...payload.database,name:'conflict'},requestId:'pack-row',expectedRevision:1}),{code:'REQUEST_ID_CONFLICT'})
  assert.equal((await to.store.snapshot()).revision,1)
})
test('corrupt source hashes and revision conflicts never partially import or overwrite same-name libraries',async t=>{
  const {store}=await fixture(t),database={id:'foreign',name:'Same name',version:4,entries:[{id:'0',content:'content'}]}
  assert.equal(typeof store.importContent,'function','validated content import exists')
  const a=await store.importContent({database,requestId:'a',expectedRevision:0})
  const b=await store.importContent({database,requestId:'b',expectedRevision:1})
  assert.notEqual(a.databaseId,b.databaseId)
  await assert.rejects(store.importContent({database,source:{format:'raw',rawText:'data',sha256:'0'.repeat(64)},requestId:'bad',expectedRevision:2}),{code:'INVALID_CONTENT'})
  await assert.rejects(store.importContent({database,requestId:'stale',expectedRevision:0}),{code:'REVISION_CONFLICT'})
  assert.equal((await store.snapshot()).databases.length,2);assert.equal((await store.snapshot()).revision,2)
})
test('document content maps fresh document IDs, preserves source audit bytes, and rejects dangling chunks before writing',async t=>{
  const from=await fixture(t),to=await fixture(t),input={name:'notes.txt',mimeType:'text/plain',text:'Original chunk',requestId:'doc-source',expectedRevision:0}
  const imported=await from.store.importDocument(input,await extractText(input)),database=await from.store.database(imported.databaseId)
  database.entries[0].content='Edited working content';await from.store.saveDatabase(database,{expectedRevision:1})
  const payload=await from.store.exportContent({databaseId:database.id,version:2})
  await assert.rejects(to.store.importContent({...payload,documents:[],requestId:'missing-doc',expectedRevision:0}),{code:'INVALID_CONTENT'})
  const corrupt=structuredClone(payload);corrupt.documents[0].extraction.chunks[0].sha256='0'.repeat(64)
  await assert.rejects(to.store.importContent({...corrupt,requestId:'corrupt-doc',expectedRevision:0}),{code:'INVALID_CONTENT'})
  assert.equal((await to.store.snapshot()).revision,0)
  const result=await to.store.importContent({...payload,requestId:'doc-pack',expectedRevision:0}),mapping=result.documentMappings[JSON.stringify([imported.documentId,1])],restored=await to.store.document({documentId:mapping.documentId})
  assert.notEqual(mapping.documentId,imported.documentId);assert.equal(mapping.version,1)
  assert.equal(restored.document.databaseId,result.databaseId);assert.equal(restored.document.dataBase64,payload.documents[0].document.dataBase64)
  assert.equal(restored.extraction.chunks[0].ref.documentId,mapping.documentId);assert.equal(restored.extraction.chunks[0].text,'Original chunk')
  const entry=(await to.store.database(result.databaseId)).entries[0]
  assert.equal(entry.content,'Edited working content');assert.equal(entry.provenance.documentId,mapping.documentId)
  assert.deepEqual((await to.store.source(result.sourceId)).provenance,payload.source.provenance)
  assert.deepEqual(await to.reopen().importContent({...payload,requestId:'doc-pack',expectedRevision:0}),result)
})
