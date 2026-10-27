import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDatabaseHost} from '../src/host.mjs'
import {createDatabaseStore} from '../src/store.mjs'
import {hostFixture,stateSeeds,factRefs} from './fixtures/database-host.mjs'

const ref=(sourceKey,entryId)=>({sourceKey,entryId})
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'rp-db-host-v2-')),f=hostFixture(),store=createDatabaseStore({directory}),service=await createDatabaseHost(f.ctx,{store});t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true})});return{...f,service,store}}
async function bind(service){
  const world=await service.import({rawText:JSON.stringify({name:'World',entries:[{id:'0',title:'world',content:'harbor law',mode:'required',readOnly:true}]}),expectedRevision:0})
  const actor=await service.import({rawText:JSON.stringify({name:'Actor',entries:[{id:'0',title:'actor',content:'harbor actor'},{id:'off',content:'DISABLED_CANARY',mode:'disabled'}]}),expectedRevision:world.revision})
  assert.equal(service.apiVersion,2,'qualified host API is available')
  await service.bindSources({sessionId:'story',sources:[{key:'world',databaseId:world.databaseId,version:1},{key:'actor',databaseId:actor.databaseId,version:1}],expectedRevision:actor.revision,resetOverlay:false})
}
async function refreshFixture(t){
  const f=await fixture(t),{service,agent}=f,input={sessionId:'story'};await bind(service)
  const initialized=await service.initializeStoryState({...input,entries:stateSeeds(),factEntryRefs:factRefs,launchId:'refresh-launch',expectedRevision:(await service.state()).revision})
  const patched=await service.patchV2({...input,agent,expectedRevision:initialized.revision,operations:[{op:'update',ref:ref('actor','0'),patch:{content:'story-local actor'}},{op:'note',ref:ref('actor','0'),text:'story-local note'}]})
  const access=await service.factAccess({...input,agent})
  await access.commit({turnKey:'["story",1]',source:{assistantMessageId:'assistant-A',callId:'reused-call',callSeq:4,turnStartSeq:1},expectedRevision:patched.revision,operations:[{op:'update',ref:factRefs[1],patch:{content:JSON.stringify({schemaVersion:1,items:[{id:'arrival',text:'The actor arrived'}]})}}],summary:'Actor arrived',packet:{playerAction:'Synthetic action',resolvedChanges:['The actor arrived']},kind:'turn',capture:{playerInput:{seq:2,messageId:'user-1',text:'Synthetic action'},story:{title:'Fixture story',character:{name:'Guide'},persona:{name:'Player'},examples:'Fixed example'},observations:[]}})
  const before=await service.effectiveV2(input),projection=await service.factReviewProjection(input)
  assert.equal(before.notes.length,1);assert.equal(before.changes.length,2);assert.equal(projection.groups.length,1)
  return{...f,input,before,projection}
}

test('binding refresh keeps established public reads available until the real store result is delivered',async t=>{
  const {service,store,input,before,projection}=await refreshFixture(t)
  const bindingsV2=store.bindingsV2,held=Promise.withResolvers(),delivery=Promise.withResolvers()
  store.bindingsV2=async()=>{
    store.bindingsV2=bindingsV2
    const rows=await bindingsV2()
    held.resolve();await delivery.promise
    return rows
  }
  const refresh=service.bindSources({sessionId:'another',sources:before.binding.sources,expectedRevision:before.revision,resetOverlay:false})
  try{
    await held.promise
    const during=await Promise.allSettled([service.effectiveV2(input),service.factReviewProjection(input)])
    assert.deepEqual(during.map(({status,reason})=>({status,...reason?{code:reason.code,httpStatus:reason.status,message:reason.message}:{}})),[{status:'fulfilled'},{status:'fulfilled'}])
    assert.deepEqual(during[0].value,{...before,revision:before.revision+1})
    assert.deepEqual(during[1].value,projection)
  }finally{
    delivery.resolve()
    const bound=await refresh
    assert.equal(bound.revision,before.revision+1)
    assert.deepEqual(await service.effectiveV2(input),{...before,revision:bound.revision})
    assert.deepEqual(await service.factReviewProjection(input),projection)
    assert.equal(service.hasBinding('another'),true)
    assert.deepEqual((await service.effectiveV2({sessionId:'another'})).binding.sources,before.binding.sources)
  }
})

test('rejected binding refresh preserves established membership without publishing the adapter',async t=>{
  const {ctx,service,store,input,before,projection,agent}=await refreshFixture(t)
  const bindingsV2=store.bindingsV2,failure=new Error('binding refresh failed'),publications=t.mock.method(ctx.agents,'list')
  store.bindingsV2=async()=>{store.bindingsV2=bindingsV2;await bindingsV2();throw failure}
  await assert.rejects(service.bindSources({sessionId:'unpublished',sources:before.binding.sources,expectedRevision:before.revision,resetOverlay:false}),error=>error===failure)
  assert.equal(service.hasBinding('story'),true);assert.equal(service.hasBinding('unpublished'),false)
  assert.equal(publications.mock.callCount(),0)
  assert.deepEqual(await service.effectiveV2(input),{...before,revision:before.revision+1})
  assert.deepEqual(await service.factReviewProjection(input),projection)
  for(const method of ['effectiveV2','factReviewProjection']){
    await assert.rejects(service[method]({sessionId:'unbound'}),{code:'NOT_BOUND',status:409})
    await assert.rejects(service[method]({sessionId:'another',agent}),{code:'AGENT_MISMATCH',status:403})
  }
})

test('v2 host read and search preserve refs while all legacy multi-source selectors fail clearly',async t=>{
  const {service,agent}=await fixture(t);await bind(service)
  const input={sessionId:'story',agent},catalog=await service.catalogV2(input)
  assert.deepEqual(catalog.entries.map(value=>value.ref),[ref('world','0'),ref('actor','0')])
  assert.ok(catalog.entries.every(value=>!Object.hasOwn(value,'content')))
  assert.deepEqual((await service.readV2({...input,refs:[ref('actor','0'),ref('world','0')]})).entries.map(value=>value.title),['actor','world'])
  const found=await service.searchV2({...input,query:'harbor',limit:1})
  assert.deepEqual(found.required,[ref('world','0')]);assert.ok(found.candidates[0].ref)
  for(const method of ['catalog','read','search','patch'])await assert.rejects(service[method]({...input,query:'harbor',entryIds:['0'],expectedRevision:catalog.revision,operations:[]}),{code:'QUALIFIED_REFERENCE_REQUIRED'})
  await assert.rejects(service.readV2({...input,refs:[ref('actor','off')]}),{code:'ENTRY_DISABLED'})
  await assert.rejects(service.readV2({...input,refs:['0']}),{code:'INVALID_REFERENCE'})
})
test('v2 host patches stay atomic and model tools translate catalog keys at their boundary',async t=>{
  const {service,agent,definitions}=await fixture(t);await bind(service)
  const input={sessionId:'story',agent},catalog=await service.catalogV2(input)
  await assert.rejects(service.patchV2({...input,expectedRevision:catalog.revision,operations:[{op:'update',ref:ref('actor','0'),patch:{content:'partial'}},{op:'remove',ref:ref('world','0')}]}),{code:'READ_ONLY'})
  assert.equal((await service.readV2({...input,refs:[ref('actor','0')]})).entries[0].content,'harbor actor')
  const tool=definitions.get('rp_db_catalog'),exec={agent,signal:new AbortController().signal}
  const toolCatalog=await tool.execute({},exec)
  assert.deepEqual(toolCatalog.entries.map(value=>value.key),['["world","0"]','["actor","0"]'])
  const read=definitions.get('rp_db_read')
  assert.equal((await read.execute({entryIds:['["actor","0"]']},exec)).entries[0].content,'harbor actor')
  await assert.rejects(read.execute({entryIds:['0']},exec),{code:'QUALIFIED_REFERENCE_REQUIRED'})
  await assert.rejects(service.bindSources({sessionId:'story',sources:[],expectedRevision:catalog.revision,resetOverlay:true,agent}),{code:'OWNER_REQUIRED'})
  await assert.rejects(definitions.get('rp_db_patch').execute({expectedRevision:catalog.revision,operations:[],stage:'fact'},exec),{code:'INVALID_OPERATION'})
})

test('new single-source tools require qualified keys while the legacy service keeps one-source compatibility',async t=>{
  const {service,agent,definitions}=await fixture(t)
  const imported=await service.import({rawText:JSON.stringify({entries:[{id:'0',content:'one source'}]}),expectedRevision:0})
  await service.bindSources({sessionId:'story',sources:[{key:'world',databaseId:imported.databaseId,version:1}],expectedRevision:1,resetOverlay:false})
  const exec={agent,signal:new AbortController().signal},read=definitions.get('rp_db_read')
  await assert.rejects(read.execute({entryIds:['0']},exec),{code:'QUALIFIED_REFERENCE_REQUIRED'})
  assert.equal((await read.execute({entryIds:['["world","0"]']},exec)).entries[0].content,'one source')
  assert.equal((await service.read({sessionId:'story',agent,entryIds:['0']})).entries[0].content,'one source')
})
