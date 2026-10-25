import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDatabaseHost} from '../src/host.mjs'
import {hostFixture} from './fixtures/database-host.mjs'

const ref=(sourceKey,entryId)=>({sourceKey,entryId})
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'rp-db-host-v2-')),f=hostFixture(),service=await createDatabaseHost(f.ctx,{directory});t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true})});return{...f,service}}
async function bind(service){
  const world=await service.import({rawText:JSON.stringify({name:'World',entries:[{id:'0',title:'world',content:'harbor law',mode:'required',readOnly:true}]}),expectedRevision:0})
  const actor=await service.import({rawText:JSON.stringify({name:'Actor',entries:[{id:'0',title:'actor',content:'harbor actor'},{id:'off',content:'DISABLED_CANARY',mode:'disabled'}]}),expectedRevision:world.revision})
  assert.equal(service.apiVersion,2,'qualified host API is available')
  await service.bindSources({sessionId:'story',sources:[{key:'world',databaseId:world.databaseId,version:1},{key:'actor',databaseId:actor.databaseId,version:1}],expectedRevision:actor.revision,resetOverlay:false})
}
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
