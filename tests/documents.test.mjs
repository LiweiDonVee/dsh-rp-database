import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {syntheticPdf} from './fixtures/synthetic-pdf.mjs'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createDatabaseHost} from '../src/host.mjs'
import {hostFixture} from './fixtures/database-host.mjs'

async function api(){const module=await import('../src/documents.mjs').catch(()=>({}));assert.equal(typeof module.extractText,'function','packaged extraction exists');return module}
test('TXT and Markdown preserve original UTF-8 bytes while extracting deterministic paragraph chunks',async()=>{
  const {extractText,chunkPages}=await api(),raw='\uFEFF# Harbor\r\n\r\n港口规则。\r\n第二行。\r\n'
  for(const mimeType of ['text/plain','text/markdown']){
    const result=await extractText({mimeType,text:raw})
    assert.deepEqual(result.bytes,Buffer.from(raw,'utf8'))
    assert.equal(result.pages[0].page,undefined)
    const chunks=chunkPages(result.pages)
    assert.deepEqual(chunks.map(chunk=>[chunk.paragraph,chunk.text]),[[1,'# Harbor'],[2,'港口规则。\n第二行。']])
    assert.deepEqual(chunkPages(result.pages),chunks)
    assert.equal(chunks[1].sha256,createHash('sha256').update('港口规则。\n第二行。').digest('hex'))
  }
})
test('the packaged Node PDF parser extracts text with actual page references and reports no text layer',async()=>{
  const {extractText,chunkPages}=await api(),bytes=syntheticPdf(),result=await extractText({mimeType:'application/pdf',dataBase64:bytes.toString('base64')})
  assert.deepEqual(result.bytes,bytes)
  assert.deepEqual(chunkPages(result.pages).map(chunk=>[chunk.page,chunk.text]),[[1,'Harbor alpha'],[2,'Mountain beta']])
  const noText=await extractText({mimeType:'application/pdf',dataBase64:syntheticPdf({imageOnly:true}).toString('base64')})
  assert.ok(noText.diagnostics.some(item=>item.code==='NO_TEXT_LAYER'))
  assert.deepEqual(chunkPages(noText.pages),[])
})
test('malformed document inputs fail without treating unknown binary data as text',async()=>{
  const {extractText}=await api()
  for(const input of [{mimeType:'image/png',dataBase64:'AAAA'},{mimeType:'application/pdf',text:'not a PDF'},{mimeType:'text/plain',text:'a',dataBase64:'Yg=='},{mimeType:'text/plain',dataBase64:'invalid!!'}])await assert.rejects(extractText(input),{code:'INVALID_DOCUMENT'})
})
test('document imports keep immutable bytes and chunk provenance, do not auto-bind, and retry by requestId',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rp-db-doc-')),f=hostFixture(),service=await createDatabaseHost(f.ctx,{directory})
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true})})
  assert.equal(typeof service.importDocument,'function','document owner service exists')
  const input={name:'same.md',mimeType:'text/markdown',text:'First paragraph\n\nSecond paragraph',requestId:'document-A',expectedRevision:0}
  const imported=await service.importDocument(input),loaded=await service.document({documentId:imported.documentId})
  assert.equal(loaded.document.dataBase64,Buffer.from(input.text).toString('base64'));assert.equal(imported.chunkCount,2)
  assert.deepEqual(loaded.extraction.chunks.map(chunk=>[chunk.ref.paragraph,chunk.text]),[[1,'First paragraph'],[2,'Second paragraph']])
  assert.equal(service.hasBinding('story'),false)
  assert.deepEqual(await service.importDocument(input),imported)
  const other=await service.importDocument({...input,text:'Different',requestId:'document-B',expectedRevision:1})
  assert.notEqual(other.documentId,imported.documentId);assert.notEqual(other.databaseId,imported.databaseId)
  const database=(await service.database({databaseId:imported.databaseId})).database
  assert.equal(database.entries[0].provenance.kind,'document-chunk');assert.equal(database.entries[0].provenance.documentId,imported.documentId)
  database.entries[0].content='Human working edit';await service.save({database,expectedRevision:2})
  assert.equal((await service.document({documentId:imported.documentId})).extraction.chunks[0].text,'First paragraph')
  const content=await service.exportContent({databaseId:database.id,version:2})
  assert.equal(content.documents.length,1);assert.equal(content.database.entries[0].content,'Human working edit')
  await service.bindSources({sessionId:'story',sources:[{key:'doc',databaseId:database.id,version:2}],expectedRevision:3,resetOverlay:false})
  await assert.rejects(service.patchV2({sessionId:'story',agent:f.agent,expectedRevision:4,operations:[{op:'add',entry:{id:'forged',content:'fake quote',provenance:database.entries[0].provenance}}]}),{code:'INVALID_OPERATION'})
})
