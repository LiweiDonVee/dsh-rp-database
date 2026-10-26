import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createDatabaseHost} from '../src/host.mjs'
import {hostFixture,stateSeeds,factRefs,turnEvents} from './fixtures/database-host.mjs'

const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value
const hash=value=>createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex')
const scene={schemaVersion:1,title:'Harbor',location:'Pier',presentActorIds:[]}
const facts=label=>({schemaVersion:1,items:label?[{id:label,text:`Fact ${label}`}]:[]})
const capture={playerInput:{seq:2,messageId:'user-1',text:'Synthetic action'},story:{title:'Fixture story',character:{name:'Guide'},persona:{name:'Player'},examples:'Fixed example'},observations:[]}
const payload=label=>({scene,facts:facts(label),summary:`Outcome ${label}`,packet:{playerAction:'Synthetic action',resolvedChanges:[`Fact ${label}`]}})
function input(revision=2,{label='A',operations=[]}={}){
  return{turnKey:'["story",1]',source:{assistantMessageId:'assistant-A',callId:'reused-call',callSeq:4,turnStartSeq:1},expectedRevision:revision,operations:[{op:'update',ref:factRefs[1],patch:{content:JSON.stringify(facts(label))}},...operations],summary:`Outcome ${label}`,packet:payload(label).packet,kind:'turn',capture:structuredClone(capture)}
}
async function fixture(t,{proposal=true,seedPolicy}={}){
  const directory=await mkdtemp(join(tmpdir(),'rp-db-review-')),events=turnEvents(),f=hostFixture(events)
  if(proposal)for(const event of events){if(event.type==='assistant/message')event.data.message.content[0].name='rp_propose_turn';if(event.type==='tool/call')event.data.name='rp_propose_turn'}
  const service=await createDatabaseHost(f.ctx,{directory})
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true})})
  await service.bindSources({sessionId:'story',sources:[],expectedRevision:0})
  await service.initializeStoryState({sessionId:'story',entries:[...stateSeeds(seedPolicy),{id:'work',content:'fixed work'}],factEntryRefs:factRefs,launchId:'review-launch',expectedRevision:1})
  const access=await service.factAccess({sessionId:'story',agent:f.agent})
  return{...f,service,access,directory}
}
const world=async access=>(await access.snapshot()).entries.map(({ref,content,version})=>({ref,content,version}))
function command(events,operationId,requestHash,{name='rp-gm-fact-decision',commandId=`command-${events.length}`,sessionId='story',done}={}){
  const runSeq=Math.max(0,...events.map(event=>event.seq))+1
  events.push({seq:runSeq,type:'command/run',data:{commandId,name,args:`  ${operationId} ${requestHash}`,source:{kind:'user'}}})
  const source={sessionId,commandId,runSeq,requestHash}
  if(done){events.push({seq:runSeq+1,type:'command/done',data:{commandId,kind:done,text:JSON.stringify({schemaVersion:1,operationId,requestHash})}});source.doneSeq=runSeq+1}
  return source
}
function decision(round,{operationId='decision-A',action='approve',custom,revision,source}={}){
  const candidateId=round.pendingCandidateId??round.candidates.at(-1).id,candidate=round.candidates.find(candidate=>candidate.id===candidateId)
  const request={sessionId:'story',roundId:round.roundId,candidateId,action,...custom?{custom:structuredClone(custom)}:{}}
  const requestHash=hash({...request,candidatePayloadHash:candidate.payloadHash})
  return{requestHash,input:{...request,operationId,expectedRoundVersion:round.version,expectedDatabaseRevision:revision,source}}
}
async function reserve(f,round,options={}){
  const value=decision(round,{...options,revision:(await f.service.state()).revision}),source=command(f.events,value.input.operationId,value.requestHash,options)
  const result=await f.service.recordFactDecision({...value.input,source})
  return{...value,source,result}
}
function finish(events,source,kind='success',settlement){
  const doneSeq=Math.max(...events.map(event=>event.seq))+1
  const operationId=events.find(event=>event.seq===source.runSeq).data.args.trim().split(/\s+/)[0]
  events.push({seq:doneSeq,type:'command/done',data:{commandId:source.commandId,kind,text:JSON.stringify(settlement??{schemaVersion:1,operationId,requestHash:source.requestHash})}})
  return{...source,doneSeq}
}
async function generate(f,round,label,{operationId=`generation-${label}`,approvalRequired=true}={}){
  const generationRequest={schemaVersion:1,sessionId:'story',roundId:round.roundId,operationId,expectedRoundVersion:round.version,instruction:'',approvalRequired},source=command(f.events,operationId,hash(generationRequest),{name:'rp-gm-fact-regenerate'}),args={sessionId:'story',roundId:round.roundId,payload:payload(label),operationId,expectedRoundVersion:round.version,approvalRequired,generationRequest,source}
  const staged=await f.service.stageFactCandidate(args),completion=finish(f.events,source,'success',{schemaVersion:1,operationId,candidateId:staged.candidateId,payloadHash:hash(payload(label))})
  return f.service.stageFactCandidate({...args,completion})
}

test('proposal durably captures one normalized candidate without facts, fixed operations or receipt writes',async t=>{
  const {service,access,directory}=await fixture(t),before=await world(access)
  assert.equal(typeof access.propose,'function','trusted fact access must persist pending proposals')
  const request=input(2,{operations:[{op:'update',ref:{sourceKey:'@session',entryId:'work'},patch:{content:'accepted once'}}]})
  const proposed=await access.propose(request)
  assert.deepEqual(await world(access),before)
  assert.equal(await access.currentReceipt(request.turnKey),null)
  assert.equal(await access.latestReceipt(),null)
  assert.deepEqual(proposed.round.base,{scene,facts:facts()})
  assert.deepEqual(proposed.round.capture,capture)
  assert.deepEqual(proposed.round.candidates[0].payload,payload('A'))
  assert.equal(proposed.round.pendingCandidateId,proposed.candidateId)
  assert.equal(proposed.round.approvalRequired,true)
  assert.equal(proposed.round.candidates[0].payloadHash,hash(payload('A')))
  const same=await access.propose({...request,expectedRevision:0})
  assert.equal(same.candidateId,proposed.candidateId)
  assert.equal((await service.state()).revision,3)
  const record=Object.values(JSON.parse(await readFile(join(directory,'state.json'),'utf8')).sessions)[0]
  assert.equal(record.changes.length,0);assert.equal(record.receipts.length,0)
  assert.equal((await service.factReviewState({sessionId:'story'})).projection.latestRoundId,proposed.round.roundId)
})

test('ordinary commit with capture atomically retains the exact before-state and one accepted candidate',async t=>{
  const {service,access}=await fixture(t,{proposal:false}),request=input(),receipt=await access.commit(request)
  const state=await service.factReviewState({sessionId:'story'}),round=state.rounds[0]
  assert.equal(receipt.factRoundId,round.roundId)
  assert.equal(receipt.factRevision,1);assert.equal(receipt.candidateId,round.candidates[0].id)
  assert.deepEqual(round.base,{scene,facts:facts()});assert.deepEqual(round.capture,capture)
  assert.equal(round.pendingCandidateId,null);assert.equal(round.activeReceiptId,receipt.id)
  assert.equal((await access.latestReceipt()).id,receipt.id)
  assert.equal((await access.commit({...request,expectedRevision:0})).id,receipt.id)
  assert.equal((await access.snapshot()).entries.find(entry=>entry.id==='gm.facts').version,2)
})

test('intent and run-only cannot write facts; exact successful done atomically accepts fixed operations once',async t=>{
  const f=await fixture(t),before=await world(f.access),proposal=await f.access.propose(input(2,{operations:[{op:'update',ref:{sourceKey:'@session',entryId:'work'},patch:{content:'accepted once'}}]}))
  assert.equal(typeof f.service.recordFactDecision,'function','owner decisions must persist an intent before finalization')
  const reserved=await reserve(f,proposal.round)
  assert.equal(reserved.result.status,'recorded');assert.deepEqual(await world(f.access),before)
  await assert.rejects(f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:{...reserved.source,doneSeq:99}}),{code:'DECISION_NOT_CONFIRMED'})
  assert.deepEqual(await world(f.access),before);assert.equal(await f.access.latestReceipt(),null)
  const source=finish(f.events,reserved.source),confirmedIntent=await f.service.factDecision({sessionId:'story',operationId:'decision-A'})
  assert.equal(confirmedIntent.status,'recorded');assert.deepEqual(confirmedIntent.completion,source)
  assert.deepEqual(await world(f.access),before);assert.equal(await f.access.latestReceipt(),null)
  const result=await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source})
  assert.equal(result.status,'approved');assert.equal(result.receipt.factRevision,1)
  assert.deepEqual(result.receipt.decisionSource,source)
  assert.equal(result.round.pendingCandidateId,null);assert.equal(result.round.activeReceiptId,result.receipt.id)
  const entries=(await f.access.snapshot()).entries
  assert.deepEqual(JSON.parse(entries.find(entry=>entry.id==='gm.facts').content),facts('A'))
  assert.equal(entries.find(entry=>entry.id==='work').content,'accepted once');assert.equal(entries.find(entry=>entry.id==='work').version,2)
  const revision=(await f.service.state()).revision
  assert.deepEqual(await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source}),result)
  assert.equal((await f.service.state()).revision,revision)
  assert.equal((await f.service.factDecision({sessionId:'story',operationId:'decision-A'})).status,'applied')
})

test('generation requires its exact full request/native command and revises latest facts without replaying fixed work',async t=>{
  const f=await fixture(t,{proposal:false}),receipt=await f.access.commit(input(2,{operations:[{op:'update',ref:{sourceKey:'@session',entryId:'work'},patch:{content:'accepted once'}}]})),round=(await f.service.factReviewState({sessionId:'story'})).rounds[0],before=await world(f.access)
  assert.equal(typeof f.service.stageFactCandidate,'function','owner generation must stage a non-authoritative candidate')
  const generationRequest={schemaVersion:1,sessionId:'story',roundId:round.roundId,operationId:'generation-B',expectedRoundVersion:round.version,instruction:'Alternative B',approvalRequired:false},requestHash=hash(generationRequest)
  const wrong=command(f.events,'generation-B',requestHash)
  const args={sessionId:'story',roundId:round.roundId,payload:payload('B'),model:{provider:'fixture',model:'facts-only'},operationId:'generation-B',expectedRoundVersion:round.version,approvalRequired:false,generationRequest}
  await assert.rejects(f.service.stageFactCandidate({...args,source:wrong}),{code:'DECISION_SOURCE_INVALID'})
  const source=command(f.events,'generation-B',requestHash,{name:'rp-gm-fact-regenerate'})
  const staged=await f.service.stageFactCandidate({...args,source})
  assert.deepEqual(await world(f.access),before);assert.equal((await f.access.currentReceipt(receipt.turnKey)).id,receipt.id)
  assert.equal(staged.round.candidates.length,2);assert.equal(staged.round.candidates[1].operationId,'generation-B')
  assert.equal(staged.round.pendingCandidateId,null,'a generated body is provisional until its exact done is confirmed')
  assert.equal(staged.round.candidates[1].generationConfirmed,false)
  assert.equal((await f.service.stageFactCandidate({...args,source})).candidateId,staged.candidateId)
  await assert.rejects(f.service.stageFactCandidate({...args,generationRequest:{...generationRequest,expectedRoundVersion:round.version+1},expectedRoundVersion:round.version+1,source:command(f.events,'generation-B',hash({...generationRequest,expectedRoundVersion:round.version+1}),{name:'rp-gm-fact-regenerate'})}),{code:'OPERATION_ID_CONFLICT'})
  const completion=finish(f.events,source,'success',{schemaVersion:1,operationId:'generation-B',candidateId:staged.candidateId,payloadHash:hash(payload('B'))})
  const confirmed=await f.service.stageFactCandidate({...args,source,completion})
  assert.equal(confirmed.round.pendingCandidateId,staged.candidateId);assert.equal(confirmed.round.candidates[1].generationConfirmed,true)
  const reserved=await reserve(f,confirmed.round,{operationId:'decision-B'}),result=await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-B',source:finish(f.events,reserved.source)})
  assert.equal(result.receipt.factRevision,2);assert.equal(result.receipt.supersedesFactReceiptId,receipt.id)
  assert.equal((await f.access.currentReceipt(receipt.turnKey)).id,result.receipt.id);assert.equal((await f.access.latestReceipt()).id,result.receipt.id)
  assert.equal((await f.access.getReceipt(receipt.id)).id,receipt.id)
  const entries=(await f.access.snapshot()).entries
  assert.deepEqual(JSON.parse(entries.find(entry=>entry.id==='gm.facts').content),facts('B'))
  assert.equal(entries.find(entry=>entry.id==='gm.facts').version,3);assert.equal(entries.find(entry=>entry.id==='work').version,2)
})

test('custom decision preserves its exact immutable human candidate and successful replay',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),before=await world(f.access),custom=payload('Human')
  const reserved=await reserve(f,proposal.round,{action:'custom',custom})
  custom.facts.items[0].text='outside mutation'
  assert.deepEqual(await world(f.access),before)
  const saved=(await f.service.factReviewState({sessionId:'story'})).rounds[0]
  assert.equal(saved.candidates.at(-1).origin,'owner');assert.deepEqual(saved.candidates.at(-1).payload,payload('Human'))
  const result=await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:finish(f.events,reserved.source)})
  assert.deepEqual(JSON.parse((await f.access.snapshot()).entries.find(entry=>entry.id==='gm.facts').content),facts('Human'))
  assert.equal(result.receipt.candidateId,saved.candidates.at(-1).id)
  const replaySource=command(f.events,'decision-A',reserved.requestHash)
  assert.equal((await f.service.recordFactDecision({...reserved.input,source:replaySource,expectedDatabaseRevision:0,expectedRoundVersion:0})).factReceiptId,result.receipt.id)
})

test('wrong/failed/missing decision evidence and a forged public status cannot manufacture a fact revision',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),value=decision(proposal.round,{revision:3}),before=await world(f.access)
  const source=command(f.events,'decision-A',value.requestHash,{name:'other-command'})
  await assert.rejects(f.service.recordFactDecision({...value.input,source}),{code:'DECISION_SOURCE_INVALID'})
  const failed=await reserve(f,proposal.round,{commandId:'failed-decision'})
  const bad=finish(f.events,failed.source,'error')
  await assert.rejects(f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:bad}),{code:'DECISION_NOT_CONFIRMED'})
  const unmatched=command(f.events,'unrecorded',value.requestHash,{done:'success'})
  await assert.rejects(f.service.finalizeFactDecision({sessionId:'story',operationId:'unrecorded',source:unmatched}),{code:'DECISION_NOT_CONFIRMED'})
  for(const altered of [{...failed.source,commandId:'invented'},{...failed.source,sessionId:'other'},{...failed.source,requestHash:'f'.repeat(64)},{...failed.source,runSeq:0}])await assert.rejects(f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:{...altered,doneSeq:bad.doneSeq}}))
  await assert.rejects(f.service.recordFactDecision({...failed.input,source:failed.source,status:'applied'}))
  assert.deepEqual(await world(f.access),before);assert.equal(await f.access.latestReceipt(),null)
})

test('a pending reservation blocks competing mutations, stale targeted work changes reject despite unrelated revisions',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input(2,{operations:[{op:'update',ref:{sourceKey:'@session',entryId:'work'},patch:{content:'candidate work'}}]}))
  const reserved=await reserve(f,proposal.round)
  const competing=decision((await f.service.factReviewState({sessionId:'story'})).rounds[0],{operationId:'competing',revision:(await f.service.state()).revision})
  await assert.rejects(f.service.recordFactDecision({...competing.input,source:command(f.events,'competing',competing.requestHash)}),{code:'FACT_REVIEW_PENDING'})
  const before=await world(f.access)
  await f.service.patchV2({sessionId:'story',agent:f.agent,expectedRevision:(await f.service.state()).revision,operations:[{op:'update',ref:{sourceKey:'@session',entryId:'work'},patch:{content:'external work'}}]})
  await assert.rejects(f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:finish(f.events,reserved.source)}),{code:'FACT_BASE_CHANGED'})
  assert.deepEqual((await world(f.access)).filter(value=>value.ref.entryId!=='work'),before.filter(value=>value.ref.entryId!=='work'))
  assert.equal(await f.access.latestReceipt(),null)
})

test('human readonly and disabled policies remain authoritative at finalization',async t=>{
  for(const seedPolicy of [{readOnly:true},{mode:'disabled'}]){
    const f=await fixture(t,{seedPolicy}),request=input();request.operations=[]
    const proposal=await f.access.propose(request),reserved=await reserve(f,proposal.round,{action:'custom',custom:payload('Forbidden')})
    await assert.rejects(f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:finish(f.events,reserved.source)}),{code:seedPolicy.readOnly?'READ_ONLY':'DISABLED'})
    assert.equal(await f.access.latestReceipt(),null)
    const state=await f.service.effectiveV2({sessionId:'story'})
    assert.deepEqual(JSON.parse(state.entries.find(entry=>entry.id==='gm.facts').content),facts());assert.equal(state.entries.find(entry=>entry.id==='gm.facts').version,1)
  }
})

test('canceling an initial proposal makes it audit-only and does not hide an earlier effective round',async t=>{
  const f=await fixture(t,{proposal:false}),receipt=await f.access.commit(input())
  const events=turnEvents({start:20,turn:2,anchor:'assistant-B'})
  for(const event of events){if(event.type==='assistant/message')event.data.message.content[0].name='rp_propose_turn';if(event.type==='tool/call')event.data.name='rp_propose_turn'}
  f.events.push(...events)
  const next={...input((await f.service.state()).revision),turnKey:'["story",20]',source:{assistantMessageId:'assistant-B',callId:'reused-call',callSeq:23,turnStartSeq:20},capture:{...capture,playerInput:{seq:21,messageId:'user-2',text:'Synthetic action'}}}
  const proposal=await f.access.propose(next),reserved=await reserve(f,proposal.round,{action:'cancel'})
  const before=await world(f.access),result=await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:finish(f.events,reserved.source)})
  assert.equal(result.status,'cancelled');assert.equal(result.receipt,undefined);assert.deepEqual(await world(f.access),before)
  const state=await f.service.factReviewState({sessionId:'story'})
  assert.equal(state.projection.latestRoundId,receipt.factRoundId);assert.equal(state.rounds.find(round=>round.roundId===proposal.round.roundId).canRegenerate,false)
})

test('newer legacy receipt blocks old captured revisions and rejects missing legacy baselines explicitly',async t=>{
  const f=await fixture(t,{proposal:false}),receipt=await f.access.commit(input()),old=(await f.service.factReviewState({sessionId:'story'})).rounds[0]
  f.events.push(...turnEvents({start:20,turn:2,anchor:'assistant-B'}))
  const next={...input((await f.service.state()).revision),turnKey:'["story",20]',source:{assistantMessageId:'assistant-B',callId:'reused-call',callSeq:23,turnStartSeq:20}}
  delete next.capture
  const legacy=await f.access.commit(next),state=await f.service.factReviewState({sessionId:'story'})
  assert.equal(state.rounds.find(round=>round.roundId===receipt.factRoundId).canRegenerate,false)
  const generationRequest={schemaVersion:1,sessionId:'story',roundId:old.roundId,operationId:'old-generation',expectedRoundVersion:old.version,instruction:'',approvalRequired:false}
  const args={sessionId:'story',roundId:old.roundId,payload:payload('old'),operationId:'old-generation',expectedRoundVersion:old.version,approvalRequired:false,generationRequest,source:command(f.events,'old-generation',hash(generationRequest),{name:'rp-gm-fact-regenerate'})}
  await assert.rejects(f.service.stageFactCandidate(args),{code:'FACT_ROUND_NOT_LATEST'})
  const missing={...generationRequest,roundId:legacy.id,operationId:'legacy-generation'}
  await assert.rejects(f.service.stageFactCandidate({...args,roundId:legacy.id,operationId:'legacy-generation',generationRequest:missing,source:command(f.events,'legacy-generation',hash(missing),{name:'rp-gm-fact-regenerate'})}),{code:'LEGACY_BASELINE_UNAVAILABLE'})
})

test('fork prefixes and cold intents select only actually finalized canonical decisions with independent future state',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),baseEvents=structuredClone(f.events)
  const makeChild=async(id,events)=>{const agent=f.addAgent(id,'story');agent.session.snapshotEvents=()=>events;return{agent,access:await f.service.factAccess({sessionId:id,agent})}}
  const before=await makeChild('before-run',baseEvents),reserved=await reserve(f,proposal.round),runEvents=structuredClone(f.events),run=await makeChild('run-only',runEvents)
  const source=finish(f.events,reserved.source),doneEvents=structuredClone(f.events),done=await makeChild('done-unapplied',doneEvents)
  const result=await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source})
  const applied=await makeChild('done-applied',structuredClone(f.events))
  for(const child of [before,run,done])assert.equal(await child.access.latestReceipt(),null)
  assert.equal((await applied.access.latestReceipt()).id,result.receipt.id)
  assert.deepEqual(JSON.parse((await applied.access.snapshot()).entries.find(entry=>entry.id==='gm.facts').content),facts('A'))
  assert.deepEqual(JSON.parse((await done.access.snapshot()).entries.find(entry=>entry.id==='gm.facts').content),facts())
  const coldEvents=runEvents,cold=await createDatabaseHost(f.ctx,{directory:f.directory});t.after(()=>cold.close())
  const state=await cold.factReviewState({sessionId:'run-only',agent:run.agent})
  assert.equal(state.decisions.length,0,'a parent unfinished intent is audit, not a child reservation');assert.equal(state.rounds[0].pendingCandidateId,proposal.candidateId)
  assert.deepEqual(coldEvents,runEvents);assert.equal((await f.access.latestReceipt()).id,result.receipt.id)
})

test('review state transfers with exact audit and rejects tampered candidates or native decision hashes',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),reserved=await reserve(f,proposal.round),source=finish(f.events,reserved.source)
  await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source})
  const exported=await f.service.exportState({sessionIds:['story']})
  const directory=await mkdtemp(join(tmpdir(),'rp-db-review-restore-')),to=await createDatabaseHost(f.ctx,{directory});t.after(async()=>{await to.close();await rm(directory,{recursive:true,force:true})})
  assert.equal((await to.preflightRestore({sessionIds:['story'],state:exported})).supported,true)
  await to.restoreState({restoreId:'review-restore',sessionIds:['story'],state:exported,expectedRevision:0})
  assert.deepEqual((await to.exportState({sessionIds:['story']})).payload.sessions,exported.payload.sessions)
  const tampered=structuredClone(exported);tampered.payload.sessions[0].factRounds[0].candidates[0].payload.summary='forged'
  assert.equal((await to.preflightRestore({sessionIds:['story'],state:tampered})).supported,false)
  const fake=structuredClone(exported),decision=fake.payload.sessions[0].factDecisions[0];decision.source.requestHash='f'.repeat(64);decision.attempts[0].requestHash='f'.repeat(64)
  assert.equal((await to.preflightRestore({sessionIds:['story'],state:fake})).supported,false)
})

test('success done with mismatched structured settlement cannot authorize a decision',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),reserved=await reserve(f,proposal.round)
  const source=finish(f.events,reserved.source,'success',{schemaVersion:1,operationId:'other',requestHash:reserved.requestHash})
  await assert.rejects(f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source}),{code:'DECISION_NOT_CONFIRMED'})
  assert.equal(await f.access.latestReceipt(),null)
})

test('a later exact immutable decision attempt fences an old late completion and applied replay remains idempotent',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),first=await reserve(f,proposal.round),secondSource=command(f.events,'decision-A',first.requestHash,{commandId:'second-attempt'})
  await f.service.recordFactDecision({...first.input,source:secondSource,expectedRoundVersion:0,expectedDatabaseRevision:0})
  const firstDone=finish(f.events,first.source)
  await assert.rejects(f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:firstDone}),{code:'DECISION_SOURCE_INVALID'})
  const result=await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:finish(f.events,secondSource)}),revision=(await f.service.state()).revision
  assert.equal((await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:firstDone})).receipt.id,result.receipt.id)
  assert.equal((await f.service.state()).revision,revision)
  await assert.rejects(f.service.recordFactDecision({...first.input,action:'cancel',source:first.source}),{code:'OPERATION_ID_CONFLICT'})
})

test('provisional generation stays owner-recoverable while a run-only child retains its prior pending choice',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),round=proposal.round
  const generationRequest={schemaVersion:1,sessionId:'story',roundId:round.roundId,operationId:'provisional',expectedRoundVersion:round.version,instruction:'',approvalRequired:true},source=command(f.events,'provisional',hash(generationRequest),{name:'rp-gm-fact-regenerate'}),args={sessionId:'story',roundId:round.roundId,payload:payload('Generated'),operationId:'provisional',expectedRoundVersion:round.version,approvalRequired:true,generationRequest,source}
  const staged=await f.service.stageFactCandidate(args)
  assert.equal(staged.round.pendingCandidateId,proposal.candidateId)
  const child=f.addAgent('generation-run-only','story'),childEvents=structuredClone(f.events);child.session.snapshotEvents=()=>childEvents
  const childAccess=await f.service.factAccess({sessionId:'generation-run-only',agent:child}),childState=await f.service.factReviewState({sessionId:'generation-run-only',agent:child})
  assert.equal(childState.rounds[0].pendingCandidateId,proposal.candidateId);assert.equal(childState.rounds[0].candidates.some(candidate=>candidate.id===staged.candidateId),false)
  const completion=finish(f.events,source,'success',{schemaVersion:1,operationId:'provisional',candidateId:staged.candidateId,payloadHash:hash(payload('Generated'))})
  const confirmed=await f.service.stageFactCandidate({...args,completion})
  assert.equal(confirmed.round.pendingCandidateId,staged.candidateId)
  assert.equal((await f.service.factReviewState({sessionId:'generation-run-only',agent:child})).rounds[0].pendingCandidateId,proposal.candidateId)
  assert.equal(await childAccess.latestReceipt(),null)
  const exported=await f.service.exportState({sessionIds:['story','generation-run-only']})
  assert.ok(!JSON.stringify(exported.payload.sessions.find(record=>record.id==='generation-run-only')).includes(staged.candidateId),'run-only fork excludes future generated body and metadata')
})

test('a fork before the original canonical tool call cannot inherit its captured commit',async t=>{
  const f=await fixture(t,{proposal:false});await f.access.commit(input())
  const child=f.addAgent('before-origin-call','story');child.session.snapshotEvents=()=>f.events.filter(event=>event.seq<4)
  const access=await f.service.factAccess({sessionId:'before-origin-call',agent:child})
  assert.equal(await access.latestReceipt(),null)
  assert.deepEqual(JSON.parse((await access.snapshot()).entries.find(entry=>entry.id==='gm.facts').content),facts())
})

test('transfer rejects a rehashed fact change whose world differs from its command-bound immutable candidate',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),reserved=await reserve(f,proposal.round)
  await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:finish(f.events,reserved.source)})
  const exported=await f.service.exportState({sessionIds:['story']}),forged=structuredClone(exported),record=forged.payload.sessions[0],change=record.changes[0],item=record.receipts[0],round=record.factRounds[0]
  change.operations[0].patch.content=JSON.stringify(facts('Forged'))
  const content={turnKey:item.receipt.turnKey,source:item.receipt.source,operations:change.operations,summary:item.receipt.summary,packet:item.receipt.packet,kind:'turn',capture:round.capture}
  item.fingerprint=hash(content)
  const entry=(await f.service.effectiveV2({sessionId:'story'})).entries.find(entry=>entry.id==='gm.facts');entry.content=change.operations[0].patch.content
  round.receiptPreconditions[item.receipt.id].find(condition=>condition.ref.entryId==='gm.facts').fingerprint=hash(entry)
  const directory=await mkdtemp(join(tmpdir(),'rp-db-forged-')),to=await createDatabaseHost(f.ctx,{directory});t.after(async()=>{await to.close();await rm(directory,{recursive:true,force:true})})
  await assert.rejects(to.restoreState({restoreId:'forged-world',sessionIds:['story'],state:forged,expectedRevision:0}),{code:'RESTORE_PAYLOAD_INVALID'})
  assert.equal((await to.state()).revision,0)
})

test('restored fact revisions remain current when destination content revision starts below the source',async t=>{
  const f=await fixture(t,{proposal:false}),first=await f.access.commit(input()),staged=await generate(f,(await f.service.factReviewState({sessionId:'story'})).rounds[0],'B'),reserved=await reserve(f,staged.round,{operationId:'accept-B'})
  const second=await f.service.finalizeFactDecision({sessionId:'story',operationId:'accept-B',source:finish(f.events,reserved.source)}),state=await f.service.exportState({sessionIds:['story']})
  const directory=await mkdtemp(join(tmpdir(),'rp-db-low-revision-')),to=await createDatabaseHost(f.ctx,{directory});t.after(async()=>{await to.close();await rm(directory,{recursive:true,force:true})})
  await to.restoreState({restoreId:'low-revision',sessionIds:['story'],state,expectedRevision:0})
  const access=await to.factAccess({sessionId:'story',agent:f.agent}),local={...f,service:to,access},next=await generate(local,(await to.factReviewState({sessionId:'story'})).rounds[0],'C'),decision=await reserve(local,next.round,{operationId:'accept-C'}),third=await to.finalizeFactDecision({sessionId:'story',operationId:'accept-C',source:finish(f.events,decision.source)})
  assert.equal(third.receipt.factRevision,3);assert.equal(third.receipt.supersedesFactReceiptId,second.receipt.id)
  assert.equal((await access.latestReceipt()).id,third.receipt.id);assert.equal((await access.currentReceipt(first.turnKey)).id,third.receipt.id)
})

test('an inherited run-only intent remains audit and a new child decision does not change the parent',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),reserved=await reserve(f,proposal.round),childEvents=structuredClone(f.events),child=f.addAgent('independent','story');child.session.snapshotEvents=()=>childEvents
  const childAccess=await f.service.factAccess({sessionId:'independent',agent:child})
  const parent=await f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source:finish(f.events,reserved.source)}),source=command(childEvents,'decision-A',reserved.requestHash,{sessionId:'independent',commandId:'child-forbidden-parent-attempt'})
  await assert.rejects(f.service.recordFactDecision({...reserved.input,sessionId:'independent',source,expectedRoundVersion:0,expectedDatabaseRevision:0}),{code:'DECISION_SOURCE_INVALID'})
  const round=(await f.service.factReviewState({sessionId:'independent',agent:child})).rounds[0],request={sessionId:'independent',roundId:round.roundId,candidateId:proposal.candidateId,action:'approve'},requestHash=hash({...request,candidatePayloadHash:round.candidates[0].payloadHash}),childSource=command(childEvents,'child-decision',requestHash,{sessionId:'independent',commandId:'child-own-attempt'})
  await f.service.recordFactDecision({...request,operationId:'child-decision',expectedRoundVersion:round.version,expectedDatabaseRevision:(await f.service.state()).revision,source:childSource})
  const result=await f.service.finalizeFactDecision({sessionId:'independent',operationId:'child-decision',source:finish(childEvents,childSource)})
  assert.notEqual(result.receipt.id,parent.receipt.id);assert.equal((await f.access.latestReceipt()).id,parent.receipt.id)
  assert.equal((await childAccess.latestReceipt()).id,result.receipt.id)
  const exported=await f.service.exportState({sessionIds:['story','independent']})
  assert.equal(exported.payload.sessions.length,2)
})

test('deterministic finalization failure releases its reservation and a fresh cancel exits without baseline writes',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input(2,{operations:[{op:'update',ref:{sourceKey:'@session',entryId:'work'},patch:{content:'fixed candidate'}}]})),reserved=await reserve(f,proposal.round)
  await f.service.patchV2({sessionId:'story',agent:f.agent,expectedRevision:(await f.service.state()).revision,operations:[{op:'update',ref:{sourceKey:'@session',entryId:'work'},patch:{content:'later work'}}]})
  const before=await world(f.access),source=finish(f.events,reserved.source),revision=(await f.service.state()).revision
  await assert.rejects(f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source}),{code:'FACT_BASE_CHANGED'})
  const failed=await f.service.factDecision({sessionId:'story',operationId:'decision-A'})
  assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'FACT_BASE_CHANGED');assert.deepEqual(await world(f.access),before)
  assert.equal((await f.service.state()).revision,revision+1)
  await assert.rejects(f.service.finalizeFactDecision({sessionId:'story',operationId:'decision-A',source}),{code:'FACT_BASE_CHANGED'})
  assert.equal((await f.service.state()).revision,revision+1)
  const current=(await f.service.factReviewState({sessionId:'story'})).rounds[0],cancel=await reserve(f,current,{operationId:'fresh-cancel',action:'cancel'}),result=await f.service.finalizeFactDecision({sessionId:'story',operationId:'fresh-cancel',source:finish(f.events,cancel.source)})
  assert.equal(result.status,'cancelled');assert.deepEqual(await world(f.access),before);assert.equal(await f.access.latestReceipt(),null)
  await f.service.exportState({sessionIds:['story']})
  f.events.push(...turnEvents({start:100,turn:2,anchor:'after-cancel'}))
  const next={...input((await f.service.state()).revision),turnKey:'["story",100]',source:{assistantMessageId:'after-cancel',callId:'reused-call',callSeq:103,turnStartSeq:100},capture:{...capture,playerInput:{seq:101,messageId:'user-2',text:'Synthetic action'}}}
  assert.ok((await f.access.commit(next)).id,'failed audit must not lock later rounds after cancellation')
})

test('capture excludes noncanonical player text and observations from a different native turn',async t=>{
  const f=await fixture(t),request=input()
  await assert.rejects(f.access.propose({...request,capture:{...capture,playerInput:{...capture.playerInput,text:'model supplied text'}}}),{code:'INVALID_FACT_CAPTURE'})
  f.events[2].seq=6;f.events[3].seq=7
  f.events.splice(2,0,{seq:3,type:'assistant/message',surfaceOp:'append',data:{turn:99,step:1,message:{id:'wrong-turn-tools',role:'assistant',content:[{type:'tool-call',id:'evidence',name:'observe_world',arguments:'{}'}]}}},{seq:4,type:'tool/call',data:{turn:99,step:1,name:'observe_world',callId:'evidence'}},{seq:5,type:'tool/result',surfaceOp:'append',sourceEventSeqs:[4],data:{turn:99,step:1,message:{role:'tool',source:{kind:'tool',callId:'evidence'},toolCallId:'evidence',content:[{type:'text',text:'wrong turn evidence'}]}}})
  const native={...request,source:{...request.source,callSeq:7},capture:{...capture,observations:[{callSeq:4,resultSeq:5,toolName:'observe_world',text:'wrong turn evidence'}]}}
  await assert.rejects(f.access.propose(native),{code:'INVALID_FACT_CAPTURE'})
  assert.equal((await f.service.state()).revision,2)
})

test('public regeneration eligibility reports a reserved intent and clears when its initial origin is replaced',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input());await reserve(f,proposal.round)
  const reservedState=await f.service.factReviewState({sessionId:'story'})
  assert.equal(reservedState.rounds[0].canRegenerate,false);assert.equal(reservedState.rounds[0].blockCode,'FACT_REVIEW_PENDING')
  f.events.push({seq:20,type:'assistant/message',surfaceOp:{op:'replace',startSeq:3,endSeq:3},data:{turn:1,step:2,message:{id:'replacement',role:'assistant',content:[{type:'tool-call',id:'new-call',name:'rp_commit_turn',arguments:'{}'}]}}},{seq:21,type:'tool/call',data:{turn:1,step:2,name:'rp_commit_turn',callId:'new-call'}})
  const request={...input((await f.service.state()).revision),source:{assistantMessageId:'replacement',callId:'new-call',callSeq:21,turnStartSeq:1}}
  const receipt=await f.access.commit(request)
  assert.ok(receipt.id);assert.equal((await f.service.factReviewState({sessionId:'story'})).decisions.length,0)
})

test('canceling a revision cycle retains the active receipt and later custom outcomes never replay changed fixed work',async t=>{
  const f=await fixture(t,{proposal:false}),first=await f.access.commit(input(2,{operations:[{op:'update',ref:{sourceKey:'@session',entryId:'work'},patch:{content:'first-only'}}]})),round=(await f.service.factReviewState({sessionId:'story'})).rounds[0],staged=await generate(f,round,'B'),cancel=await reserve(f,staged.round,{operationId:'cancel-B',action:'cancel'})
  await f.service.finalizeFactDecision({sessionId:'story',operationId:'cancel-B',source:finish(f.events,cancel.source)})
  assert.equal((await f.access.latestReceipt()).id,first.id)
  await f.service.patchV2({sessionId:'story',agent:f.agent,expectedRevision:(await f.service.state()).revision,operations:[{op:'update',ref:{sourceKey:'@session',entryId:'work'},patch:{content:'later independent edit'}}]})
  const next=await generate(f,(await f.service.factReviewState({sessionId:'story'})).rounds[0],'C'),custom=await reserve(f,next.round,{operationId:'custom-C',action:'custom',custom:payload('Human-C')})
  await f.service.finalizeFactDecision({sessionId:'story',operationId:'custom-C',source:finish(f.events,custom.source)})
  const work=(await f.access.snapshot()).entries.find(entry=>entry.id==='work')
  assert.equal(work.content,'later independent edit');assert.equal(work.version,3)
})

test('strict transfer fields reject unsupported review owner versions rather than discarding review state',async t=>{
  const f=await fixture(t);await f.access.propose(input())
  const state=await f.service.exportState({sessionIds:['story']});state.payload.sessions[0].factReviewVersion=2
  assert.ok((await f.service.preflightRestore({sessionIds:['story'],state})).conflicts.some(conflict=>conflict.code==='RESTORE_PAYLOAD_INVALID'))
})

test('cold provisional generation resumes by its exact immutable operation and confirms without a new candidate',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),round=proposal.round,generationRequest={schemaVersion:1,sessionId:'story',roundId:round.roundId,operationId:'cold-generation',expectedRoundVersion:round.version,instruction:'frozen request',approvalRequired:true},requestHash=hash(generationRequest),source=command(f.events,'cold-generation',requestHash,{name:'rp-gm-fact-regenerate'}),args={sessionId:'story',roundId:round.roundId,payload:payload('Cold'),model:{provider:'fixture',model:'bounded'},operationId:'cold-generation',expectedRoundVersion:round.version,approvalRequired:true,generationRequest,source}
  const staged=await f.service.stageFactCandidate(args),cold=await createDatabaseHost(f.ctx,{directory:f.directory});t.after(()=>cold.close())
  const recovered=(await cold.factReviewState({sessionId:'story'})).rounds[0],candidate=recovered.candidates.find(candidate=>candidate.operationId==='cold-generation')
  assert.equal(candidate.id,staged.candidateId);assert.equal(candidate.generationConfirmed,false);assert.equal(recovered.pendingCandidateId,proposal.candidateId)
  const retry=command(f.events,'cold-generation',requestHash,{name:'rp-gm-fact-regenerate',commandId:'cold-generation-retry'}),replayed=await cold.stageFactCandidate({...args,source:retry})
  assert.equal(replayed.candidateId,staged.candidateId);assert.equal(replayed.round.candidates.length,2)
  const completion=finish(f.events,retry,'success',{schemaVersion:1,operationId:'cold-generation',candidateId:candidate.id,payloadHash:candidate.payloadHash}),confirmed=await cold.stageFactCandidate({...args,source:retry,completion})
  assert.equal(confirmed.round.pendingCandidateId,candidate.id)
  const child=f.addAgent('confirmed-generation','story');child.session.snapshotEvents=()=>structuredClone(f.events)
  const branch=(await cold.factReviewState({sessionId:'confirmed-generation',agent:child})).rounds[0]
  assert.equal(branch.pendingCandidateId,candidate.id);assert.equal(branch.candidates.at(-1).generationConfirmed,true)
  await cold.exportState({sessionIds:['story','confirmed-generation']})
})

test('pending retry keeps its policy and an unrelated newer generation prevents old confirmation',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),round=proposal.round,request={schemaVersion:1,sessionId:'story',roundId:round.roundId,operationId:'first-generation',expectedRoundVersion:round.version,instruction:'',approvalRequired:true}
  const args={sessionId:'story',roundId:round.roundId,payload:payload('First'),operationId:request.operationId,expectedRoundVersion:round.version,approvalRequired:true,generationRequest:request,source:command(f.events,request.operationId,hash(request),{name:'rp-gm-fact-regenerate'})},first=await f.service.stageFactCandidate(args)
  const off={...request,operationId:'policy-bypass',expectedRoundVersion:first.round.version,approvalRequired:false}
  await assert.rejects(f.service.stageFactCandidate({...args,operationId:off.operationId,expectedRoundVersion:off.expectedRoundVersion,approvalRequired:false,generationRequest:off,source:command(f.events,off.operationId,hash(off),{name:'rp-gm-fact-regenerate'})}),{code:'FACT_APPROVAL_REQUIRED'})
  const newer=await generate(f,first.round,'Newer')
  const completion=finish(f.events,args.source,'success',{schemaVersion:1,operationId:request.operationId,candidateId:first.candidateId,payloadHash:hash(payload('First'))})
  await assert.rejects(f.service.stageFactCandidate({...args,completion}),{code:'FACT_VERSION_SUPERSEDED'})
  assert.equal((await f.service.factReviewState({sessionId:'story'})).rounds[0].pendingCandidateId,newer.candidateId)
})

test('transfer cannot promote a provisional generation by forging pending selection or review status metadata',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),round=proposal.round,request={schemaVersion:1,sessionId:'story',roundId:round.roundId,operationId:'unconfirmed',expectedRoundVersion:round.version,instruction:'',approvalRequired:true},source=command(f.events,request.operationId,hash(request),{name:'rp-gm-fact-regenerate'})
  const staged=await f.service.stageFactCandidate({sessionId:'story',roundId:round.roundId,payload:payload('Unconfirmed'),operationId:request.operationId,expectedRoundVersion:round.version,approvalRequired:true,generationRequest:request,source}),state=await f.service.exportState({sessionIds:['story']})
  const forged=state.payload.sessions[0].factRounds[0];forged.pendingCandidateId=staged.candidateId;forged.reviewEvents.push({type:'candidate',candidateId:staged.candidateId})
  assert.ok((await f.service.preflightRestore({sessionIds:['story'],state})).conflicts.some(conflict=>conflict.code==='RESTORE_PAYLOAD_INVALID'))
})

test('transfer cannot rebind a real child decision command to an ancestor session that never recorded it',async t=>{
  const f=await fixture(t),proposal=await f.access.propose(input()),childEvents=structuredClone(f.events),child=f.addAgent('branch','story');child.session.snapshotEvents=()=>childEvents
  const round=(await f.service.factReviewState({sessionId:'branch',agent:child})).rounds[0],candidate=round.candidates[0],request={sessionId:'branch',roundId:round.roundId,candidateId:candidate.id,action:'approve'},operationId='branch-only-decision',requestHash=hash({...request,candidatePayloadHash:candidate.payloadHash}),source=command(childEvents,operationId,requestHash,{sessionId:'branch'})
  await f.service.recordFactDecision({...request,operationId,expectedRoundVersion:round.version,expectedDatabaseRevision:(await f.service.state()).revision,source})
  await f.service.finalizeFactDecision({sessionId:'branch',operationId,source:finish(childEvents,source)})
  const state=await f.service.exportState({sessionIds:['story','branch']}),record=state.payload.sessions.find(record=>record.id==='branch'),decision=record.factDecisions[0]
  decision.source.sessionId='story';decision.attempts[0].sessionId='story';decision.completion.sessionId='story';record.receipts[0].receipt.decisionSource.sessionId='story';record.changes[0].decisionSource.sessionId='story'
  const directory=await mkdtemp(join(tmpdir(),'rp-db-rebound-')),to=await createDatabaseHost(f.ctx,{directory});t.after(async()=>{await to.close();await rm(directory,{recursive:true,force:true})})
  await assert.rejects(to.restoreState({restoreId:'rebound',sessionIds:['story','branch'],state,expectedRevision:0}),{code:'RESTORE_PAYLOAD_INVALID'})
  assert.equal((await to.state()).revision,0);assert.equal(proposal.candidateId,candidate.id)
})
