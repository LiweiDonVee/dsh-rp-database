import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDatabaseHost} from '../src/host.mjs'
import {hostFixture} from './fixtures/database-host.mjs'

async function fixture(t){
  const calls=[],control={dimension:2,fail:false},server=createServer(async(request,response)=>{
    let raw='';for await(const part of request)raw+=part;const input=JSON.parse(raw);calls.push({path:request.url,...input});response.setHeader('content-type','application/json')
    if(control.fail){response.statusCode=503;response.end('{"error":"provider-secret"}');return}
    response.end(JSON.stringify(request.url.endsWith('/embeddings')?{data:input.input.map((_text,index)=>({index,embedding:Array.from({length:control.dimension},(_value,at)=>at===0?1:0)}))}:{results:input.documents.map((_text,index)=>({index,relevance_score:1/(index+1)}))}))
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  const directory=await mkdtemp(join(tmpdir(),'rp-db-index-')),f=hostFixture(),config={baseURL:`http://127.0.0.1:${server.address().port}/v1`,model:'model-A',apiKey:'must-not-persist'},services=[]
  const open=async(model='model-A')=>{const service=await createDatabaseHost(f.ctx,{directory,embedding:{...config,model},reranking:config});services.push(service);return service}
  t.after(async()=>{for(const service of services)await service.close();await new Promise(done=>{server.close(done);server.closeAllConnections()});await rm(directory,{recursive:true,force:true})})
  return{...f,directory,calls,control,open,service:await open()}
}
async function seed(service){
  const imported=await service.importDocument({name:'cache.txt',mimeType:'text/plain',text:'Harbor alpha\n\nMountain beta\n\nDISABLED_CANARY',requestId:'cache-doc',expectedRevision:0})
  const database=(await service.database({databaseId:imported.databaseId})).database
  database.entries[0].mode='required';database.entries[2].mode='disabled'
  await service.save({database,expectedRevision:1})
  await service.bindSources({sessionId:'story',sources:[{key:'doc',databaseId:database.id,version:2}],expectedRevision:2,resetOverlay:false})
  return database
}
test('persisted HTTP vectors embed queries each time, reuse unchanged chunks, and do not advance content revision',async t=>{
  const f=await fixture(t),database=await seed(f.service),input={sessionId:'story',agent:f.agent,query:'harbor'}
  assert.equal(typeof f.service.indexState,'function','persistent vector index exists')
  const before=await f.service.contentRevision(),first=await f.service.searchV2(input)
  assert.ok(first.candidates.length);assert.deepEqual(first.degraded,[])
  assert.deepEqual(f.calls.filter(call=>call.path.endsWith('/embeddings')).map(call=>call.input.length),[1,2])
  await f.service.searchV2(input)
  assert.deepEqual(f.calls.filter(call=>call.path.endsWith('/embeddings')).map(call=>call.input.length),[1,2,1])
  assert.deepEqual(await f.service.contentRevision(),before)
  assert.deepEqual(await f.service.indexState(),{model:'model-A',readyChunks:2,staleChunks:0})
  await f.service.close();const reopened=await f.open();await reopened.searchV2(input)
  assert.equal(f.calls.filter(call=>call.path.endsWith('/embeddings')).at(-1).input.length,1)
  const rebuilt=await reopened.rebuildIndex({databaseIds:[database.id]})
  assert.equal(rebuilt.indexedChunks,0);assert.equal(rebuilt.skippedChunks,2)
  assert.ok(!f.calls.some(call=>JSON.stringify(call).includes('DISABLED_CANARY')))
  assert.ok(!(await readFile(join(f.directory,'state.json'),'utf8')).includes('must-not-persist'))
})
test('effective edits invalidate one text hash, model/dimension changes do not mix vectors, and rewound cache is not selected',async t=>{
  const f=await fixture(t),database=await seed(f.service),input={sessionId:'story',agent:f.agent,query:'harbor'}
  assert.equal(typeof f.service.indexState,'function','indexed effective retrieval exists')
  await f.service.searchV2(input)
  await f.service.patchV2({sessionId:'story',agent:f.agent,expectedRevision:3,operations:[{op:'update',ref:{sourceKey:'doc',entryId:database.entries[0].id},patch:{content:'ABANDONED_BRANCH'}}]})
  await f.service.searchV2(input)
  assert.deepEqual(f.calls.filter(call=>call.path.endsWith('/embeddings')).map(call=>call.input.length),[1,2,1,1])
  await f.service.close();const changedModel=await f.open('model-B')
  assert.equal((await changedModel.indexState()).staleChunks,2)
  await changedModel.searchV2(input)
  assert.deepEqual(f.calls.filter(call=>call.path.endsWith('/embeddings')).slice(-2).map(call=>[call.model,call.input.length]),[['model-B',1],['model-B',2]])
  f.control.dimension=3;assert.deepEqual((await changedModel.searchV2(input)).degraded,[])
  assert.deepEqual(f.calls.filter(call=>call.path.endsWith('/embeddings')).slice(-2).map(call=>call.input.length),[1,2])
  f.events.push({seq:8,type:'assistant/message',surfaceOp:{op:'replace',startSeq:3,endSeq:3},data:{turn:1,step:2,message:{id:'rewound',content:[]}}})
  const mark=f.calls.length;await changedModel.searchV2(input)
  assert.ok(f.calls.slice(mark).every(call=>!JSON.stringify(call).includes('ABANDONED_BRANCH')))
  f.control.fail=true;const degraded=await changedModel.searchV2(input)
  assert.ok(degraded.degraded.includes('embedding_failed'));assert.ok(!JSON.stringify(degraded).includes('provider-secret'))
  assert.equal((await changedModel.indexState()).lastErrorCode,'EMBEDDING_FAILED')
})
test('cache identity includes each immutable document extraction/chunking policy across content imports',async t=>{
  const f=await fixture(t),database=await seed(f.service),input={sessionId:'story',agent:f.agent,query:'harbor'}
  await f.service.searchV2(input)
  const content=await f.service.exportContent({databaseId:database.id,version:2})
  content.documents[0].document.extractionVersion+='-different-policy'
  for(const entry of content.database.entries)entry.provenance.extractionVersion=content.documents[0].document.extractionVersion
  const imported=await f.service.importContent({...content,requestId:'different-extraction',expectedRevision:3})
  await f.service.bindSources({sessionId:'story',sources:[{key:'doc',databaseId:imported.databaseId,version:1}],expectedRevision:4,resetOverlay:false})
  assert.equal((await f.service.indexState()).staleChunks,2)
  await f.service.searchV2(input)
  assert.deepEqual(f.calls.filter(call=>call.path.endsWith('/embeddings')).map(call=>call.input.length),[1,2,1,2])
})
