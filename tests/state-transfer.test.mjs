import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createDatabaseHost} from '../src/host.mjs'
import {hostFixture,stateSeeds,factRefs,turnEvents} from './fixtures/database-host.mjs'
import {factCommit,fingerprint} from '../src/facts.mjs'
import {validateCanonicalState} from '../src/state-transfer.mjs'

async function fixture(t,{embedding=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'rp-db-restore-')),f=hostFixture(),views=new Map(),stats={canonicalReads:0}
  f.ctx.typertGateway.stream=async input=>({async *[Symbol.asyncIterator](){stats.canonicalReads++;const id=input.args.request.address.sessionId,value=views.get(id);if(!value)throw Error('Canonical destination missing');yield{type:'snapshot',header:value.header,cursor:100,hasMore:false,records:value.events.map(event=>({type:'event',event}))}}})
  const service=await createDatabaseHost(f.ctx,{directory,...embedding?{embedding:{baseURL:'http://127.0.0.1:1/v1',model:'fixture',apiKey:'never-export'},providers:{embed:async texts=>texts.map(()=>[1,0])}}:{}})
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true})})
  const add=(id,parentSession)=>{const agent=id==='story'?f.agent:f.addAgent(id,parentSession);agent.session.header={id,...parentSession?{parentSession}:{}};agent.session.snapshotEvents=()=>views.get(id)?.events??[];return agent}
  return{service,views,add,stats,directory}
}
const input=(revision,start,anchor,value)=>({turnKey:JSON.stringify(['story',start]),source:{assistantMessageId:anchor,callId:'reused-call',callSeq:start+3,turnStartSeq:start},expectedRevision:revision,operations:[{op:'update',ref:factRefs[1],patch:{content:JSON.stringify({schemaVersion:1,items:[{id:value,text:value}]})}}],summary:value,packet:{playerAction:value},kind:'turn'})
async function source(t,{note=false}={}){
  const f=await fixture(t,{embedding:true}),A=turnEvents(),B=turnEvents({start:10,turn:2,anchor:'assistant-B'})
  f.views.set('story',{header:{id:'story'},events:A});const agent=f.add('story')
  const doc=await f.service.importDocument({name:'source.txt',mimeType:'text/plain',text:'Required original source',requestId:'source-doc',expectedRevision:0})
  await f.service.bindSources({sessionId:'story',sources:[{key:'world',databaseId:doc.databaseId,version:1}],expectedRevision:1,resetOverlay:false})
  await f.service.initializeStoryState({sessionId:'story',entries:stateSeeds(),factEntryRefs:factRefs,launchId:'launch',expectedRevision:2})
  const access=await f.service.factAccess({sessionId:'story',agent}),first=input(3,1,'assistant-A','A')
  if(note){const entry=(await f.service.database({databaseId:doc.databaseId})).database.entries[0];first.operations.push({op:'note',ref:{sourceKey:'world',entryId:entry.id},text:'temporary factual turn guidance'})}
  const receiptA=await access.commit(first)
  f.views.get('story').events=[...A,...B];await access.commit(input(4,10,'assistant-B','B'))
  f.views.set('child',{header:{id:'child',parentSession:'story'},events:A});f.add('child','story')
  assert.equal(typeof f.service.exportState,'function','exact-ID state seam exists')
  const exported=await f.service.exportState({sessionIds:['story','child']})
  await f.service.searchV2({sessionId:'story',agent,query:'source'})
  return{...f,exported,receiptA,doc}
}
test('T2 preflight permits missing canonical sessions; restore then validates real refs and preserves causal state with exact IDs',async t=>{
  const from=await source(t),to=await fixture(t)
  assert.ok(!Object.hasOwn(from.exported.payload,'vectorIndex'));assert.ok(!JSON.stringify(from.exported).includes('never-export'))
  const unrelated=await to.service.create({name:'Unrelated destination',expectedRevision:0})
  const request={sessionIds:['story','child'],state:from.exported}
  assert.deepEqual(await to.service.preflightRestore(request),{supported:true,conflicts:[],requirements:[]})
  await assert.rejects(to.service.restoreState({...request,restoreId:'restore-A',expectedRevision:1}),{code:'RESTORE_REQUIREMENT_MISSING'})
  assert.equal((await to.service.contentRevision()).revision,1)
  for(const[id,value]of from.views)to.views.set(id,structuredClone(value))
  const result=await to.service.restoreState({...request,restoreId:'restore-A',expectedRevision:1})
  assert.deepEqual(result.restoredSessionIds,['story','child']);assert.equal(result.revision,2)
  assert.deepEqual(await to.service.restoreState({...request,restoreId:'restore-A',expectedRevision:1}),result)
  assert.equal((await to.service.database({databaseId:unrelated.databaseId})).database.name,'Unrelated destination')
  assert.equal((await to.service.document({documentId:from.doc.documentId})).document.id,from.doc.documentId)
  const parent=await to.service.factAccess({sessionId:'story',agent:to.add('story')}),child=await to.service.factAccess({sessionId:'child',agent:to.add('child','story')})
  assert.equal(JSON.parse((await parent.snapshot()).entries.find(entry=>entry.id==='gm.facts').content).items[0].text,'B')
  assert.equal(JSON.parse((await child.snapshot()).entries.find(entry=>entry.id==='gm.facts').content).items[0].text,'A')
  assert.equal((await child.getReceipt(from.receiptA.id)).originSessionId,'story')
  to.views.get('child').events.push({seq:20,type:'assistant/message',surfaceOp:{op:'replace',startSeq:3,endSeq:3},data:{turn:1,step:2,message:{id:'rewound',content:[]}}})
  assert.deepEqual(JSON.parse((await child.snapshot()).entries.find(entry=>entry.id==='gm.facts').content).items,[])
  await assert.rejects(child.getReceipt(from.receiptA.id),{code:'INACTIVE_SOURCE'})
  await assert.rejects(to.service.restoreState({...request,restoreId:'restore-A',sessionIds:['story'],expectedRevision:2}),{code:'RESTORE_ID_CONFLICT'})
  await assert.rejects(to.service.restoreState({...request,restoreId:'another-job',expectedRevision:2}),{code:'RESTORE_ID_CONFLICT'})
  assert.equal((await to.service.contentRevision()).revision,2)
})
test('state restore rejects content collisions and forged native receipt sources without partial writes',async t=>{
  const from=await source(t),to=await fixture(t),request={sessionIds:['story','child'],state:from.exported}
  for(const[id,value]of from.views)to.views.set(id,structuredClone(value))
  to.views.get('story').events=to.views.get('story').events.filter(event=>event.type!=='tool/call')
  await assert.rejects(to.service.restoreState({...request,restoreId:'invalid-native',expectedRevision:0}),{code:'RESTORE_PAYLOAD_INVALID'})
  assert.equal((await to.service.contentRevision()).revision,0);assert.equal((await to.service.state()).databases.length,0)
  await to.service.save({database:{id:from.doc.databaseId,name:'Existing conflict',version:1,entries:[{id:'0',content:'different'}]},expectedRevision:0})
  const preflight=await to.service.preflightRestore(request)
  assert.equal(preflight.supported,false);assert.ok(preflight.conflicts.some(item=>item.code==='RESTORE_CONTENT_CONFLICT'))
  assert.equal((await to.service.contentRevision()).revision,1)
})

test('restore rejects a schema-invalid factual prefix even when a later fact batch is valid, without changing data or revision',async t=>{
  const from=await source(t),to=await fixture(t),state=structuredClone(from.exported)
  for(const[id,value]of from.views)to.views.set(id,structuredClone(value))
  for(const record of state.payload.sessions){
    record.changes[0].operations[0].patch.content=JSON.stringify({items:[{id:'invalid',text:'Missing schemaVersion'}]})
    const item=record.receipts[0],r=item.receipt
    const commit=factCommit({turnKey:r.turnKey,source:r.source,expectedRevision:0,operations:record.changes[0].operations,summary:r.summary,packet:r.packet,kind:r.kind},r.sessionId)
    const {expectedRevision:_revision,...identity}=commit;item.fingerprint=fingerprint(identity)
  }
  await to.service.create({name:'Unrelated destination',expectedRevision:0})
  const before=await readFile(join(to.directory,'state.json'),'utf8'),request={sessionIds:['story','child'],state}
  assert.deepEqual(await to.service.preflightRestore(request),{supported:false,conflicts:[{code:'RESTORE_PAYLOAD_INVALID',id:'payload'}],requirements:[]})
  assert.throws(()=>validateCanonicalState(state,to.views),{code:'RESTORE_PAYLOAD_INVALID'})
  await assert.rejects(to.service.restoreState({...request,restoreId:'invalid-fact-schema',expectedRevision:1}),{code:'RESTORE_PAYLOAD_INVALID'})
  assert.equal(to.stats.canonicalReads,0,'Preflight structural validation does not need destination logs')
  assert.equal(await readFile(join(to.directory,'state.json'),'utf8'),before)
  assert.equal((await to.service.contentRevision()).revision,1)
})

test('restore validates the final state of each atomic fact batch and keeps its original operations',async t=>{
  const from=await fixture(t),to=await fixture(t),events=turnEvents()
  from.views.set('story',{header:{id:'story'},events});const agent=from.add('story')
  await from.service.bindSources({sessionId:'story',sources:[],expectedRevision:0,resetOverlay:false})
  await from.service.initializeStoryState({sessionId:'story',entries:stateSeeds(),factEntryRefs:factRefs,launchId:'atomic-schema',expectedRevision:1})
  const commit=input(2,1,'assistant-A','Final valid facts')
  commit.operations.unshift({op:'update',ref:factRefs[1],patch:{content:'A temporary value replaced within the same atomic batch'}})
  await(await from.service.factAccess({sessionId:'story',agent})).commit(commit)
  const state=await from.service.exportState({sessionIds:['story']}),request={sessionIds:['story'],state}
  assert.equal((await to.service.preflightRestore(request)).supported,true)
  to.views.set('story',structuredClone(from.views.get('story')))
  await to.service.restoreState({...request,restoreId:'atomic-valid-schema',expectedRevision:0})
  assert.deepEqual((await to.service.exportState({sessionIds:['story']})).payload.sessions,state.payload.sessions)
})

test('T12 exports unused exact pinned libraries and their source/document closure without changing an empty runtime binding',async t=>{
  const from=await fixture(t),to=await fixture(t)
  from.views.set('story',{header:{id:'story'},events:[]});from.add('story')
  const original=await from.service.importDocument({name:'World seed.txt',mimeType:'text/plain',text:'World V1 original text',requestId:'world-original',expectedRevision:0})
  const content=await from.service.exportContent({databaseId:original.databaseId,version:1})
  content.source.provenance={...content.source.provenance,databaseRefs:[{databaseId:'inert-audit-only',version:999}],url:'https://example.invalid/inert-audit'}
  const world=await from.service.importContent({...content,requestId:'world-library',expectedRevision:1}),v1=await from.service.exportContent({databaseId:world.databaseId,version:1})
  await from.service.save({database:{...v1.database,entries:v1.database.entries.map(entry=>({...entry,content:'World V2 later working text'}))},expectedRevision:2})
  await from.service.bindSources({sessionId:'story',sources:[],expectedRevision:3,resetOverlay:false})
  await from.service.initializeStoryState({sessionId:'story',entries:stateSeeds(),factEntryRefs:factRefs,launchId:'empty-runtime-defaults',expectedRevision:4})
  const before=await readFile(join(from.directory,'state.json'),'utf8'),ordinary=await from.service.exportState({sessionIds:['story']})
  assert.deepEqual(await from.service.exportState({sessionIds:['story'],additionalDatabaseRefs:[]}),ordinary)
  const state=await from.service.exportState({sessionIds:['story'],additionalDatabaseRefs:[{databaseId:world.databaseId,version:1},{databaseId:world.databaseId,version:1}]})
  assert.deepEqual(ordinary.payload.databases,[]);assert.deepEqual(state.payload.sessions,ordinary.payload.sessions)
  assert.deepEqual(state.payload.databases.map(record=>({id:record.id,versions:record.versions.map(item=>item.database.version)})),[{id:world.databaseId,versions:[1]}])
  assert.equal(state.payload.documents.length,1);assert.equal(state.payload.sources.length,1)
  assert.equal(await readFile(join(from.directory,'state.json'),'utf8'),before)
  const request={sessionIds:['story'],state};assert.equal((await to.service.preflightRestore(request)).supported,true)
  to.views.set('story',structuredClone(from.views.get('story')));to.add('story')
  await to.service.restoreState({...request,restoreId:'retained-unused-defaults',expectedRevision:0})
  assert.deepEqual(await to.service.exportContent({databaseId:world.databaseId,version:1}),v1)
  await assert.rejects(to.service.database({databaseId:world.databaseId,version:2}),{code:'NOT_FOUND'})
  await assert.rejects(to.service.database({databaseId:original.databaseId,version:1}),{code:'NOT_FOUND'})
  const effective=await to.service.effectiveV2({sessionId:'story'})
  assert.deepEqual(effective.binding.sources,[]);assert.deepEqual(effective.entries.map(entry=>entry.id),['gm.scene','gm.facts'])
  assert.deepEqual(JSON.parse(effective.entries.find(entry=>entry.id==='gm.facts').content),{schemaVersion:1,items:[]})
})

test('T12 missing exact references reject export without fallback or writes and additional refs accept only typed versions',async t=>{
  const from=await fixture(t);from.views.set('story',{header:{id:'story'},events:[]});from.add('story')
  const world=await from.service.create({name:'World V1',expectedRevision:0}),v1=await from.service.database({databaseId:world.databaseId})
  await from.service.save({database:{...v1.database,name:'World V2'},expectedRevision:1})
  await from.service.bindSources({sessionId:'story',sources:[],expectedRevision:2,resetOverlay:false})
  const before=await readFile(join(from.directory,'state.json'),'utf8')
  from.views.set('unmaterialized-child',{header:{id:'unmaterialized-child',parentSession:'story'},events:[]})
  await assert.rejects(from.service.exportState({sessionIds:['unmaterialized-child'],additionalDatabaseRefs:[{databaseId:world.databaseId,version:99}]}),{code:'EXPORT_REQUIREMENT_MISSING'})
  assert.equal(await readFile(join(from.directory,'state.json'),'utf8'),before,'A missing passive dependency must reject before export materializes a cold child')
  for(const ref of [{databaseId:world.databaseId,version:99},{databaseId:'missing-library-safe-ref',version:1}]){
    await assert.rejects(from.service.exportState({sessionIds:['story'],additionalDatabaseRefs:[ref]}),error=>{
      assert.equal(error.code,'EXPORT_REQUIREMENT_MISSING');assert.ok(error.message.includes(ref.databaseId));assert.ok(error.message.includes(String(ref.version)));return true
    })
  }
  for(const refs of [null,[{databaseId:world.databaseId}],[{databaseId:world.databaseId,version:0}],[{databaseId:world.databaseId,version:1,sourceKey:'not-a-binding'}]])await assert.rejects(from.service.exportState({sessionIds:['story'],additionalDatabaseRefs:refs}),{code:'INVALID_DATA'})
  assert.equal(await readFile(join(from.directory,'state.json'),'utf8'),before);assert.equal((await from.service.contentRevision()).revision,3)
})
test('a fork may drop temporary note operations while preserving the original factual receipt fingerprint for restore',async t=>{
  const from=await source(t,{note:true}),to=await fixture(t)
  for(const[id,value]of from.views)to.views.set(id,structuredClone(value))
  await to.service.restoreState({restoreId:'fork-notes',sessionIds:['story','child'],state:from.exported,expectedRevision:0})
  const child=await to.service.factAccess({sessionId:'child',agent:to.add('child','story')})
  assert.equal((await child.getReceipt(from.receiptA.id)).id,from.receiptA.id);assert.deepEqual((await child.snapshot()).notes,[])
})
test('restore journals keep ownership of included unbound ancestor namespaces',async t=>{
  const to=await fixture(t),state={schemaVersion:1,revision:0,payload:{storeSchemaVersion:2,databases:[],sources:[],documents:[],sessions:[]}},request={sessionIds:['empty-native'],state}
  to.views.set('empty-native',{header:{id:'empty-native'},events:[]})
  await to.service.restoreState({...request,restoreId:'owns-empty-ancestor',expectedRevision:0})
  await assert.rejects(to.service.restoreState({...request,restoreId:'unrelated-job',expectedRevision:1}),{code:'RESTORE_ID_CONFLICT'})
  assert.equal((await to.service.contentRevision()).revision,1)
})
test('T9 validates transport before replay and rejects reused identity before deep schema or canonical lookups',async t=>{
  const to=await fixture(t),state={schemaVersion:1,revision:0,payload:{storeSchemaVersion:2,databases:[],sources:[],documents:[],sessions:[]}},request={restoreId:'transport-gate',sessionIds:['empty-native'],state,expectedRevision:0}
  to.views.set('empty-native',{header:{id:'empty-native'},events:[]})
  await to.service.restoreState(request);const before=to.stats.canonicalReads
  await assert.rejects(to.service.restoreState({...request,expectedRevision:undefined}),{code:'RESTORE_PAYLOAD_INVALID'})
  const nonJSON=structuredClone(state);nonJSON.payload.illegal=()=>{}
  await assert.rejects(to.service.restoreState({...request,state:nonJSON}),{code:'RESTORE_PAYLOAD_INVALID'})
  const changed=structuredClone(state);changed.payload.sessions='deeper schema error'
  await assert.rejects(to.service.restoreState({...request,state:changed}),{code:'RESTORE_ID_CONFLICT'})
  await assert.rejects(to.service.restoreState({...request,restoreId:'stale-new-job',sessionIds:['missing-new-session']}),{code:'REVISION_CONFLICT'})
  assert.equal(to.stats.canonicalReads,before);assert.equal((await to.service.contentRevision()).revision,1)
})
