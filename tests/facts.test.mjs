import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDatabaseHost} from '../src/host.mjs'
import {hostFixture,stateSeeds,factRefs,turnEvents} from './fixtures/database-host.mjs'

const facts=items=>JSON.stringify({schemaVersion:1,items})
async function fixture(t,{seedPolicy,events,beforeSeed,initialize=true,emptySources=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'rp-db-facts-')),f=hostFixture(events),service=await createDatabaseHost(f.ctx,{directory})
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true})})
  if(emptySources)await service.bindSources({sessionId:'story',sources:[],expectedRevision:0,resetOverlay:false})
  else{
    const imported=await service.import({rawText:JSON.stringify({name:'Fixture',entries:[{id:'work',content:'working material'}]}),expectedRevision:0})
    await service.bind({sessionId:'story',databaseId:imported.databaseId,version:1,expectedRevision:imported.revision})
  }
  assert.equal(typeof service.initializeStoryState,'function','fact initialization is available')
  await beforeSeed?.(service,f.agent)
  const initialized=initialize?await service.initializeStoryState({sessionId:'story',entries:stateSeeds(seedPolicy),factEntryRefs:factRefs,launchId:'launch-A',expectedRevision:(await service.state()).revision}):null
  return{...f,service,directory,initialized}
}
function commitInput({revision=3,start=1,anchor='assistant-A',content='A',kind='turn'}={}){
  return{turnKey:JSON.stringify(['story',start]),source:{assistantMessageId:anchor,callId:'reused-call',callSeq:start+3,turnStartSeq:start},expectedRevision:revision,operations:[{op:'update',ref:factRefs[1],patch:{content:facts([{id:content,text:`Fact ${content}`}])}}],summary:`Committed ${content}`,packet:{playerAction:'Synthetic action',resolvedChanges:[`Fact ${content}`],variables:{weather:'clear'}},kind,...kind==='opening'?{openingText:'Exact selected opening.'}:{}}
}
test('GM seed initialization preserves ordinary overlay and is idempotent without overwriting state',async t=>{
  const {service,initialized}=await fixture(t)
  const same=await service.initializeStoryState({sessionId:'story',entries:stateSeeds(),factEntryRefs:factRefs,launchId:'launch-A',expectedRevision:2})
  assert.deepEqual(same,initialized);assert.equal((await service.state()).revision,3)
  await assert.rejects(service.initializeStoryState({sessionId:'story',entries:stateSeeds({title:'changed'}),factEntryRefs:factRefs,launchId:'launch-A',expectedRevision:3}),{code:'LAUNCH_CONFLICT'})
  await assert.rejects(service.initializeStoryState({sessionId:'story',entries:stateSeeds(),factEntryRefs:factRefs,launchId:'launch-B',expectedRevision:3}),{code:'STORY_ALREADY_INITIALIZED'})
})
test('generic and material staging cannot mutate facts or commit a harmless sibling operation',async t=>{
  const {service,agent}=await fixture(t),input={sessionId:'story',agent}
  const stage=await service.materialAccess(input),snapshot=await stage.snapshot()
  assert.equal(stage.version,2,'the Context facade explicitly identifies its qualified DTO version')
  const plan=[{op:'note',id:'["legacy","work"]',text:'must not persist'},{op:'update',id:'["@session","gm.facts"]',patch:{content:facts([{id:'bad',text:'illegal'}])}}]
  assert.throws(()=>stage.apply(snapshot.entries,plan),{code:'FACT_OWNER_REQUIRED'})
  const operations=[{op:'note',ref:{sourceKey:'legacy',entryId:'work'},text:'must not persist'},{op:'update',ref:factRefs[1],patch:{content:facts([{id:'bad',text:'illegal'}])}}]
  await assert.rejects(stage.commit({operations:plan,expectedRevision:snapshot.revision}),{code:'FACT_OWNER_REQUIRED'})
  await assert.rejects(service.patchV2({...input,operations,expectedRevision:snapshot.revision}),{code:'FACT_OWNER_REQUIRED'})
  assert.equal((await service.state()).revision,snapshot.revision)
  assert.deepEqual((await stage.snapshot()).notes,[])
  const changed=stage.apply(snapshot.entries,[{op:'note',id:'["legacy","work"]',text:'allowed'}])
  assert.deepEqual(changed.notes,[{ref:{sourceKey:'legacy',entryId:'work'},text:'allowed'}])
  assert.deepEqual(stage.select(snapshot.entries,['["legacy","work"]']).map(value=>value.id),['work'])
  await stage.commit({operations:[plan[0]],expectedRevision:snapshot.revision})
  assert.equal((await stage.snapshot()).notes[0].text,'must not persist')
})
test('a material facade acquired before initialization protects newly registered facts during staging and commit',async t=>{
  const {service,agent}=await fixture(t,{emptySources:true,initialize:false}),stage=await service.materialAccess({sessionId:'story',agent})
  assert.deepEqual((await stage.snapshot()).binding.factEntryRefs,[])
  await service.initializeStoryState({sessionId:'story',entries:[...stateSeeds(),{id:'work',content:'ordinary material'}],factEntryRefs:factRefs,launchId:'after-material-access',expectedRevision:1})
  const snapshot=await stage.snapshot(),operations=[{op:'note',id:'["@session","work"]',text:'must not stage or persist'},{op:'update',id:'["@session","gm.facts"]',patch:{content:facts([{id:'illegal',text:'material cannot settle facts'}])}}]
  assert.deepEqual(snapshot.binding.factEntryRefs,factRefs)
  assert.throws(()=>stage.apply(snapshot.entries,operations),{code:'FACT_OWNER_REQUIRED'})
  await assert.rejects(stage.commit({operations,expectedRevision:snapshot.revision}),{code:'FACT_OWNER_REQUIRED'})
  const current=await stage.snapshot()
  assert.equal(current.revision,snapshot.revision);assert.deepEqual(current.notes,[])
  assert.deepEqual(JSON.parse(current.entries.find(entry=>entry.id==='gm.facts').content).items,[])
  assert.deepEqual(JSON.parse(snapshot.entries.find(entry=>entry.id==='gm.facts').content).items,[])
  assert.deepEqual(stage.apply(snapshot.entries,[operations[0]]).notes,[{ref:{sourceKey:'@session',entryId:'work'},text:'must not stage or persist'}])
})
test('one active fact turn persists receipt and operations atomically and replays despite a stale revision',async t=>{
  const {service,agent,directory}=await fixture(t),access=await service.factAccess({sessionId:'story',agent}),input=commitInput()
  const receipt=await access.commit(input)
  assert.equal(receipt.schemaVersion,1);assert.equal(receipt.databaseRevision,4);assert.ok(receipt.changeId)
  assert.deepEqual(receipt.stateRefs,[{...factRefs[0],version:1},{...factRefs[1],version:2}])
  const replay=await access.commit(input)
  assert.deepEqual(replay,receipt)
  assert.deepEqual(await access.getReceipt(receipt.id),receipt)
  assert.deepEqual(await access.currentReceipt(input.turnKey),receipt)
  assert.equal((await service.state()).revision,4)
  const persisted=JSON.parse(await readFile(join(directory,'state.json'),'utf8')),record=Object.values(persisted.sessions)[0]
  assert.equal(record.changes.length,1);assert.equal(record.receipts.length,1)
  await assert.rejects(access.commit({...input,summary:'conflict'}),error=>error.code==='TURN_ALREADY_COMMITTED'&&error.receiptId===receipt.id)
  assert.equal((await service.state()).revision,4)
  receipt.packet.variables.weather='outside mutation';assert.equal((await access.getReceipt(receipt.id)).packet.variables.weather,'clear')
})
test('receipt recovery survives host restart and a later writer failure without repeating state changes',async t=>{
  const {service,ctx,agent,directory}=await fixture(t),access=await service.factAccess({sessionId:'story',agent}),receipt=await access.commit(commitInput())
  await service.close()
  const reopened=await createDatabaseHost(ctx,{directory});t.after(()=>reopened.close())
  const recovered=await reopened.factAccess({sessionId:'story',agent})
  assert.equal((await recovered.currentReceipt('["story",1]')).id,receipt.id)
  assert.equal((await recovered.commit(commitInput())).id,receipt.id)
  assert.equal((await recovered.snapshot()).entries.find(value=>value.id==='gm.facts').version,2)
})
test('registered fact ownership does not bypass a human readonly policy',async t=>{
  const {service,agent}=await fixture(t,{seedPolicy:{readOnly:true}}),access=await service.factAccess({sessionId:'story',agent})
  await assert.rejects(access.commit(commitInput()),{code:'READ_ONLY'})
  assert.equal(await access.currentReceipt('["story",1]'),null)
  assert.equal((await service.state()).revision,3)
})
test('native facade rejects invented or inactive canonical calls before any fact transaction',async t=>{
  const {service,agent,events}=await fixture(t),access=await service.factAccess({sessionId:'story',agent}),valid=commitInput()
  for(const input of [{...valid,turnKey:'reused-call'},{...valid,source:{...valid.source,callSeq:99}},{...valid,source:{...valid.source,turnStartSeq:2},turnKey:'["story",2]'},{...valid,source:{...valid.source,assistantMessageId:'invented'}},{...valid,source:{...valid.source,stage:'fact'}}])await assert.rejects(access.commit(input))
  events.push({seq:8,type:'assistant/message',surfaceOp:{op:'replace',startSeq:3,endSeq:3},data:{turn:1,step:2,message:{id:'replacement',content:[]}}})
  await assert.rejects(access.commit(valid),{code:'INACTIVE_SOURCE'})
  assert.equal((await service.state()).revision,3)
})
test('packet whitelist and GM state JSON validation reject the whole transaction',async t=>{
  const {service,agent}=await fixture(t),access=await service.factAccess({sessionId:'story',agent}),valid=commitInput()
  for(const input of [{...valid,packet:{...valid.packet,factReceiptId:'smuggled'}},{...valid,packet:{playerAction:'action',variables:{hidden:42}}},{...valid,operations:[{op:'update',ref:factRefs[1],patch:{content:'not JSON'}}]},{...valid,kind:'opening'}])await assert.rejects(access.commit(input))
  assert.equal((await service.state()).revision,3)
})
test('receipt and facts follow the same inherited A prefix and both disappear before A',async t=>{
  const {service,agent,addAgent,events}=await fixture(t),access=await service.factAccess({sessionId:'story',agent})
  const receiptA=await access.commit(commitInput())
  events.push(...turnEvents({start:10,turn:2,anchor:'assistant-B'}))
  await access.commit(commitInput({revision:4,start:10,anchor:'assistant-B',content:'B'}))
  events.splice(4)
  const child=addAgent('child','story'),childAccess=await service.factAccess({sessionId:'child',agent:child})
  const inherited=await childAccess.getReceipt(receiptA.id)
  assert.equal(inherited.sessionId,'child');assert.equal(inherited.originSessionId,'story');assert.deepEqual(inherited.source,receiptA.source);assert.equal(inherited.turnKey,receiptA.turnKey)
  assert.deepEqual(JSON.parse((await childAccess.snapshot()).entries.find(value=>value.id==='gm.facts').content).items,[{id:'A',text:'Fact A'}])
  events.push({seq:20,type:'assistant/message',surfaceOp:{op:'replace',startSeq:3,endSeq:3},data:{turn:1,step:2,message:{id:'rewound',content:[]}}})
  await assert.rejects(childAccess.getReceipt(receiptA.id),{code:'INACTIVE_SOURCE'})
  await assert.rejects(childAccess.currentReceipt(receiptA.turnKey),{code:'INACTIVE_SOURCE'})
  assert.deepEqual(JSON.parse((await childAccess.snapshot()).entries.find(value=>value.id==='gm.facts').content).items,[])
})

test('initialization appends seeds without changing existing overlay and colliding session IDs are rejected',async t=>{
  const {service}=await fixture(t,{beforeSeed:(service,agent)=>service.patchV2({sessionId:'story',agent,expectedRevision:2,operations:[{op:'update',ref:{sourceKey:'legacy',entryId:'work'},patch:{content:'existing overlay'}}]})})
  const view=await service.effectiveV2({sessionId:'story'})
  assert.equal(view.revision,4);assert.equal(view.entries[0].content,'existing overlay');assert.equal(view.changes.length,1)
  const second=await fixture(t,{initialize:false})
  await second.service.patchV2({sessionId:'story',agent:second.agent,expectedRevision:2,operations:[{op:'add',entry:{id:'gm.facts',content:'pre-existing local entry'}}]})
  await assert.rejects(second.service.initializeStoryState({sessionId:'story',entries:stateSeeds(),factEntryRefs:factRefs,launchId:'collision',expectedRevision:3}),{code:'SEED_CONFLICT'})
  assert.equal((await second.service.state()).revision,3)
  assert.equal((await second.service.effectiveV2({sessionId:'story'})).entries.find(value=>value.id==='gm.facts').content,'pre-existing local entry')
})

test('an empty sources binding supports session GM seeds and a canonical opening receipt',async t=>{
  const {service,agent}=await fixture(t,{emptySources:true,events:turnEvents({kind:'opening'})})
  assert.equal(service.hasBinding('story'),true)
  const access=await service.factAccess({sessionId:'story',agent}),input={...commitInput({revision:2,kind:'opening'}),operations:[]}
  const receipt=await access.commit(input)
  assert.equal(receipt.changeId,null);assert.equal(receipt.openingText,'Exact selected opening.');assert.equal(receipt.databaseRevision,3)
  assert.deepEqual((await access.snapshot()).binding.sources,[])
  assert.equal((await access.commit(input)).id,receipt.id)
})

test('disabled GM entries are owner-visible but absent from agent and facade snapshots and remain unwritable',async t=>{
  const {service,agent}=await fixture(t,{seedPolicy:{mode:'disabled'}}),input={sessionId:'story',agent},access=await service.factAccess(input),material=await service.materialAccess(input)
  assert.equal((await service.effectiveV2({sessionId:'story'})).entries.length,3)
  for(const value of [await service.effectiveV2(input),await access.snapshot(),await material.snapshot()])assert.deepEqual(value.entries.map(entry=>entry.id),['work'])
  await assert.rejects(access.commit(commitInput()),{code:'DISABLED'})
  await assert.rejects(service.readV2({...input,refs:[factRefs[1]]}),{code:'ENTRY_DISABLED'})
  assert.equal((await service.state()).revision,3)
})

test('initialized GM state and receipts survive forbidden owner resets and compatible source additions',async t=>{
  const {service,agent}=await fixture(t,{beforeSeed:(service,agent)=>service.patchV2({sessionId:'story',agent,expectedRevision:2,operations:[{op:'note',ref:{sourceKey:'legacy',entryId:'work'},text:'dependent'}]})})
  const access=await service.factAccess({sessionId:'story',agent}),receipt=await access.commit(commitInput({revision:4}))
  for(const resetOverlay of [false,true])await assert.rejects(service.bindSources({sessionId:'story',sources:[],expectedRevision:5,resetOverlay}),{code:'STORY_RESTART_REQUIRED'})
  const pinned=(await service.effectiveV2({sessionId:'story'})).binding.sources[0]
  await assert.rejects(service.bind({sessionId:'story',databaseId:pinned.databaseId,version:1,expectedRevision:5}),{code:'STORY_RESTART_REQUIRED'})
  const added=await service.create({name:'New compatible source',expectedRevision:5})
  await service.bindSources({sessionId:'story',sources:[pinned,{key:'extra',databaseId:added.databaseId,version:1}],expectedRevision:6,resetOverlay:false})
  assert.equal((await access.getReceipt(receipt.id)).id,receipt.id)
  assert.equal((await access.snapshot()).entries.find(value=>value.id==='gm.facts').version,2)
})

test('concurrent identical fact submissions advance revision once and receipts are not transferable to unrelated sessions',async t=>{
  const {service,agent,addAgent}=await fixture(t),access=await service.factAccess({sessionId:'story',agent}),receipts=await Promise.all([access.commit(commitInput()),access.commit(commitInput())])
  assert.equal(receipts[0].id,receipts[1].id);assert.equal((await service.state()).revision,4)
  const unrelated=addAgent('unrelated')
  await service.bindSources({sessionId:'unrelated',sources:[],expectedRevision:4,resetOverlay:false})
  const other=await service.factAccess({sessionId:'unrelated',agent:unrelated})
  await assert.rejects(other.getReceipt(receipts[0].id),{code:'RECEIPT_NOT_FOUND'})
})

test('currentReceipt selects the active replacement within a turn without resurrecting its old receipt',async t=>{
  const {service,agent,events}=await fixture(t),access=await service.factAccess({sessionId:'story',agent})
  const old=await access.commit(commitInput())
  events.push({seq:5,type:'assistant/message',surfaceOp:{op:'replace',startSeq:3,endSeq:3},data:{turn:1,step:2,message:{id:'replacement-A',role:'assistant',content:[{type:'tool-call',id:'reused-call',name:'rp_commit_turn',arguments:'{}'}]}}},{seq:6,type:'tool/call',data:{turn:1,step:2,callId:'reused-call',name:'rp_commit_turn',arguments:'{}'}})
  const input=commitInput({revision:4,anchor:'replacement-A',content:'replacement'});input.source.callSeq=6
  const active=await access.commit(input)
  assert.notEqual(active.id,old.id)
  assert.equal((await access.currentReceipt('["story",1]')).id,active.id)
  await assert.rejects(access.getReceipt(old.id),{code:'INACTIVE_SOURCE'})
  assert.deepEqual(JSON.parse((await access.snapshot()).entries.find(entry=>entry.id==='gm.facts').content).items,[{id:'replacement',text:'Fact replacement'}])
})
