import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDatabaseHost} from '../src/host.mjs'
import {createDatabaseStore} from '../src/store.mjs'
import {hostFixture,stateSeeds,factRefs} from './fixtures/database-host.mjs'

async function fixture(t,{signal}={}){
  const directory=await mkdtemp(join(tmpdir(),'rp-db-receipt-hot-')),f=hostFixture(),raw=createDatabaseStore({directory})
  const counts={projections:0,receipts:0,lineages:0},control={lineage:undefined}
  f.ctx.get=name=>name==='rpGM'?{sessionLineage:async input=>{
    counts.lineages++
    if(control.lineage)return control.lineage(input)
    return{sessionId:input.sessionId,parentSessionId:f.ctx.agents.get(input.sessionId)?.session.header.parentSession??null,inheritedEventCount:input.sessionId==='story'?0:f.events.length}
  }}:undefined
  const store={...raw,sessionV2(...args){counts.projections++;return raw.sessionV2(...args)},receipt(...args){counts.receipts++;return raw.receipt(...args)}}
  const service=await createDatabaseHost(f.ctx,{store})
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true})})
  await service.bindSources({sessionId:'story',sources:[],expectedRevision:0,resetOverlay:false})
  await service.initializeStoryState({sessionId:'story',entries:stateSeeds(),factEntryRefs:factRefs,launchId:'receipt-fixture',expectedRevision:1})
  const access=await service.factAccess({sessionId:'story',agent:f.agent,signal})
  const receipt=await access.commit({turnKey:'["story",1]',source:{assistantMessageId:'assistant-A',callId:'reused-call',callSeq:4,turnStartSeq:1},expectedRevision:2,operations:[],summary:'Legacy receipt without review metadata',packet:{playerAction:'read only'},kind:'turn'})
  Object.assign(counts,{projections:0,receipts:0,lineages:0})
  return{...f,service,store,raw,access,receipt,counts,control}
}

test('120 receipt lookups retain fresh lineage checks while avoiding the effective database projection',async t=>{
  const f=await fixture(t)
  for(let index=0;index<40;index++){
    assert.deepEqual(await f.access.getReceipt(f.receipt.id),f.receipt)
    assert.deepEqual(await f.access.currentReceipt(f.receipt.turnKey),f.receipt)
    assert.deepEqual(await f.access.latestReceipt(),f.receipt)
  }
  assert.deepEqual(f.counts,{projections:0,receipts:120,lineages:120})
  await f.access.snapshot()
  assert.equal(f.counts.projections,1)
})

test('legacy receipt reads still reject inactive canonical calls, missing receipts and a retired Agent',async t=>{
  const f=await fixture(t)
  assert.equal(f.receipt.factRoundId,undefined)
  await assert.rejects(f.access.getReceipt('missing'),{code:'RECEIPT_NOT_FOUND',status:404})
  assert.equal(await f.access.currentReceipt('["story",99]'),null)
  f.events.find(event=>event.type==='tool/call').data.name='unrelated_tool'
  await assert.rejects(f.access.getReceipt(f.receipt.id),{code:'INACTIVE_SOURCE',status:409})
  f.events.find(event=>event.type==='tool/call').data.name='rp_commit_turn'
  f.addAgent('story')
  await assert.rejects(f.access.latestReceipt(),{code:'AGENT_MISMATCH',status:403})
  assert.equal(f.counts.projections,0)
})

test('receipt reads retain inherited binding setup and exclude an unrelated story',async t=>{
  const f=await fixture(t),child=f.addAgent('child','story')
  const access=await f.service.factAccess({sessionId:'child',agent:child})
  assert.equal(f.service.hasBinding('child'),true)
  f.counts.projections=0
  const receipt=await access.getReceipt(f.receipt.id)
  assert.equal(receipt.sessionId,'child')
  assert.equal(receipt.originSessionId,'story')
  assert.deepEqual(receipt.source,f.receipt.source)
  const unrelated=f.addAgent('unrelated')
  await f.service.bindSources({sessionId:'unrelated',sources:[],expectedRevision:4,resetOverlay:false})
  const other=await f.service.factAccess({sessionId:'unrelated',agent:unrelated})
  f.counts.projections=0
  await assert.rejects(other.getReceipt(f.receipt.id),{code:'RECEIPT_NOT_FOUND',status:404})
  assert.equal(f.counts.projections,0)
})

test('receipt reads remain available while a compatible binding refresh is waiting to publish',async t=>{
  const f=await fixture(t),bindings=f.store.bindingsV2
  let release,started
  const waiting=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
  f.store.bindingsV2=async()=>{const rows=await bindings();started();await gate;return rows}
  const binding=f.service.bindSources({sessionId:'story',sources:[],expectedRevision:3,resetOverlay:false})
  await waiting
  assert.deepEqual(await f.access.latestReceipt(),f.receipt)
  release();await binding
  assert.deepEqual(await f.access.latestReceipt(),f.receipt)
  assert.equal(f.counts.projections,0)
})

test('missing canonical dependencies and cancelled lineage reads never fall back to stored receipts',async t=>{
  const abort=new AbortController(),f=await fixture(t,{signal:abort.signal}),snapshot=f.agent.session.snapshotEvents
  f.agent.session.snapshotEvents=undefined
  await assert.rejects(f.access.latestReceipt(),{code:'SESSION_UNAVAILABLE',status:503})
  f.agent.session.snapshotEvents=snapshot
  f.control.lineage=async()=>{throw Object.assign(new Error('Lineage dependency unavailable'),{code:'CAPABILITY_UNAVAILABLE',status:503})}
  await assert.rejects(f.access.latestReceipt(),{code:'CAPABILITY_UNAVAILABLE',status:503})
  let started
  const ready=new Promise(resolve=>{started=resolve})
  f.control.lineage=({signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});started()})
  const reading=f.access.latestReceipt()
  await ready;abort.abort()
  await assert.rejects(reading,{name:'AbortError'})
  assert.equal(f.counts.receipts,0)
  assert.equal(f.counts.projections,0)
})
