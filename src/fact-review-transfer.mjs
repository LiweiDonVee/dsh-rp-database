import {DatabaseError} from './core.mjs'
import {activeFactSource,canonicalSource,factCommit,fingerprint} from './facts.mjs'
import {applyScopedOperations,entryKey,entryRef} from './references.mjs'
import {projectSession} from './session.mjs'
import {candidatePayload,changeVisible,decisionRequest,deterministicRefusals,exact,factCapture,generationConfirmed,generationRequest,initialCandidate,modelConfig,ownerRun,preconditions,worldState} from './fact-review.mjs'

const invalid=message=>{throw new DatabaseError('RESTORE_PAYLOAD_INVALID',message)}
const id=value=>typeof value==='string'&&value.trim().length>0
const positive=value=>Number.isSafeInteger(value)&&value>0
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const same=(left,right)=>fingerprint(left)===fingerprint(right)
function unique(values){if(values.some(value=>!id(value))||new Set(values).size!==values.length)invalid('Duplicate fact review identity')}
function runRef(value,{done=false}={}){
  exact(value,['sessionId','commandId','runSeq','requestHash',...done?['doneSeq']:[]])
  if(!id(value.sessionId)||!id(value.commandId)||!Number.isSafeInteger(value.runSeq)||value.runSeq<0||!digest(value.requestHash)||done&&(!Number.isSafeInteger(value.doneSeq)||value.doneSeq<=value.runSeq))invalid('Invalid owner command reference')
}
function conditions(value){
  if(!Array.isArray(value))invalid('Missing captured write preconditions')
  unique(value.map(item=>{exact(item,['ref','fingerprint']);if(item.fingerprint!==null&&!digest(item.fingerprint))invalid('Invalid write precondition');return entryKey(entryRef(item.ref))}))
}

/** Additive owner fields; old readers reject their unsupported exact schema rather than discard them. */
export function validateReviewStructure(record,ids){
  if(record.factReviewVersion===undefined){
    if(record.factRounds!==undefined||record.factDecisions!==undefined||record.receipts.some(item=>item.receipt.factRoundId!==undefined))invalid('Fact review data has no supported capability version')
    return
  }
  if(record.factReviewVersion!==1||!Array.isArray(record.factRounds)||record.factDecisions!==undefined&&!Array.isArray(record.factDecisions))invalid('Unsupported fact review capability version')
  record.factDecisions??=[]
  unique(record.factRounds.map(round=>round.roundId));unique(record.factDecisions.map(decision=>decision.operationId))
  unique(record.factRounds.flatMap(round=>round.candidates?.map(candidate=>candidate.id)??[]))
  unique(record.factRounds.flatMap(round=>round.generations?.map(generation=>generation.request?.operationId)??[]))
  for(const round of record.factRounds){
    exact(round,['roundId','version','sessionId','turnKey','source','base','baseChangeIds','capture','candidates','pendingCandidateId','approvalRequired','initialApprovalRequired','fixedOperations','writePreconditions','initialFingerprint','initialRequest','initialAcceptedReceiptId','candidateCauses','reviewEvents','generations','receiptPreconditions'])
    if(!positive(round.version)||!ids.includes(round.sessionId)||typeof round.approvalRequired!=='boolean'||typeof round.initialApprovalRequired!=='boolean'||!Array.isArray(round.candidates)||!round.candidates.length||!Array.isArray(round.fixedOperations))invalid('Invalid captured fact round')
    canonicalSource(round.source);exact(round.base,['scene','facts']);candidatePayload({...round.base,summary:'',packet:{playerAction:'baseline'}});factCapture(round.capture);conditions(round.writePreconditions)
    if(!Array.isArray(round.baseChangeIds))invalid('Missing captured causal baseline boundary');unique(round.baseChangeIds)
    const original=factCommit(round.initialRequest,round.sessionId),{expectedRevision:_revision,...content}=original
    if(original.kind!=='turn'||!original.capture||round.initialFingerprint!==fingerprint(content)||!same(original.source,round.source)||original.turnKey!==round.turnKey||!same(original.capture,round.capture))invalid('Captured origin request differs from its immutable round')
    const protectedKeys=new Set(record.binding.factEntryRefs.map(entryKey)),fixed=original.operations.filter(operation=>operation.op==='add'||!protectedKeys.has(entryKey(operation.ref)))
    if(!same(fixed,round.fixedOperations))invalid('Fixed operations differ from the original request')
    for(const candidate of round.candidates){
      exact(candidate,['id','roundId','createdAt','origin','payload','payloadHash','operationId','model','generationConfirmed'])
      if(candidate.roundId!==round.roundId||!Number.isFinite(Date.parse(candidate.createdAt))||!['main-gm','regenerated','owner'].includes(candidate.origin)||!digest(candidate.payloadHash)||candidate.payloadHash!==fingerprint(candidatePayload(candidate.payload)))invalid('Invalid immutable fact candidate')
      if(candidate.origin==='main-gm'&&(candidate!==round.candidates[0]||candidate.operationId!==undefined||candidate.generationConfirmed!==undefined)||candidate.origin!=='main-gm'&&!id(candidate.operationId)||candidate.origin==='regenerated'&&typeof candidate.generationConfirmed!=='boolean'||candidate.origin!=='regenerated'&&candidate.generationConfirmed!==undefined)invalid('Invalid candidate origin metadata')
      modelConfig(candidate.model)
    }
    if(round.candidates[0].origin!=='main-gm'||round.pendingCandidateId!==null&&!round.candidates.some(candidate=>candidate.id===round.pendingCandidateId))invalid('Invalid pending fact candidate')
    const causes=round.candidateCauses??={};exact(causes,round.candidates.map(candidate=>candidate.id))
    for(const candidate of round.candidates.slice(1)){
      const cause=causes[candidate.id];exact(cause,['operationId','name','source']);runRef(cause.source)
      if(cause.operationId!==candidate.operationId||cause.name!==(candidate.origin==='regenerated'?'rp-gm-fact-regenerate':'rp-gm-fact-decision'))invalid('Candidate cause differs from its owner operation')
    }
    round.generations??=[];if(!Array.isArray(round.generations))invalid('Invalid generation audit')
    for(const generation of round.generations){
      exact(generation,['request','requestHash','model','candidateId','payloadHash','attempts','confirmations','stagedRoundVersion'])
      const request=generationRequest(generation.request),candidate=round.candidates.find(candidate=>candidate.id===generation.candidateId)
      if(!candidate||candidate.origin!=='regenerated'||request.roundId!==round.roundId||candidate.operationId!==request.operationId||generation.requestHash!==fingerprint(request)||generation.payloadHash!==candidate.payloadHash||!positive(generation.stagedRoundVersion)||!Array.isArray(generation.attempts)||!generation.attempts.length||!Array.isArray(generation.confirmations)||!same(generation.model??null,candidate.model??null))invalid('Invalid generation request/candidate binding')
      modelConfig(generation.model);unique(generation.attempts.map(source=>source.commandId))
      for(const source of generation.attempts){runRef(source);if(source.requestHash!==generation.requestHash||!ids.includes(source.sessionId))invalid('Invalid generation attempt hash')}
      for(const completion of generation.confirmations){runRef(completion,{done:true});const{doneSeq:_done,...source}=completion;if(!generation.attempts.some(attempt=>same(attempt,source)))invalid('Generation confirmation has no matching staged attempt')}
      if(candidate.generationConfirmed!==!!generation.confirmations.length||!same(causes[candidate.id].source,generation.attempts[0]))invalid('Generation status is missing immutable cause/confirmation metadata')
    }
    for(const candidate of round.candidates.filter(candidate=>candidate.origin==='regenerated'))if(!round.generations.some(generation=>generation.candidateId===candidate.id))invalid('Generated candidate has no request audit')
    round.reviewEvents??=[];if(!Array.isArray(round.reviewEvents))invalid('Invalid review event audit')
    for(const event of round.reviewEvents){
      exact(event,event.type==='candidate'?['type','candidateId']:['type','operationId'])
      if(event.type==='candidate'?!round.candidates.some(candidate=>candidate.id===event.candidateId):event.type!=='settled'||!record.factDecisions.some(decision=>decision.operationId===event.operationId&&decision.roundId===round.roundId&&decision.finalized))invalid('Invalid review event linkage')
      const candidate=event.type==='candidate'&&round.candidates.find(candidate=>candidate.id===event.candidateId)
      if(candidate?.origin==='regenerated'&&!candidate.generationConfirmed)invalid('A provisional generation cannot publish pending selection')
    }
    for(const candidate of round.candidates.filter(candidate=>candidate.origin==='owner')){
      const decision=record.factDecisions.find(decision=>decision.operationId===candidate.operationId&&decision.selectedCandidateId===candidate.id&&decision.action==='custom'),cause=causes[candidate.id]
      if(!decision||!same(candidate.payload,decision.request.custom)||!decision.attempts.some(source=>same(source,cause.source))||cause.source.requestHash!==decision.requestHash)invalid('An owner candidate lacks its exact custom decision intent')
    }
    const accepted=round.initialAcceptedReceiptId&&record.receipts.find(item=>item.receipt.id===round.initialAcceptedReceiptId)?.receipt
    if(round.initialAcceptedReceiptId&&(!accepted||accepted.factRoundId!==round.roundId||accepted.candidateId!==round.candidates[0].id||accepted.decisionSource)||round.initialApprovalRequired&&round.initialAcceptedReceiptId)invalid('Invalid original acceptance linkage')
    exact(round.receiptPreconditions??={},record.receipts.filter(item=>item.receipt.factRoundId===round.roundId).map(item=>item.receipt.id))
    for(const item of record.receipts.filter(item=>item.receipt.factRoundId===round.roundId))conditions(round.receiptPreconditions[item.receipt.id])
  }
  for(const decision of record.factDecisions){
    exact(decision,['operationId','roundId','candidateId','selectedCandidateId','action','requestHash','request','source','attempts','completion','factReceiptId','finalized','status','errorCode','errorMessage','errorStatus'])
    const round=record.factRounds.find(round=>round.roundId===decision.roundId),candidate=round?.candidates.find(candidate=>candidate.id===decision.candidateId),selected=round?.candidates.find(candidate=>candidate.id===decision.selectedCandidateId)
    if(!candidate||!selected||!Array.isArray(decision.attempts)||!decision.attempts.length)invalid('Decision has no immutable candidate or attempt')
    const normalized=decisionRequest({sessionId:decision.request?.sessionId,roundId:decision.roundId,candidateId:decision.candidateId,action:decision.action,...decision.action==='custom'?{custom:decision.request?.custom}:{}},candidate)
    if(!ids.includes(normalized.sessionId)||!same(normalized,decision.request)||fingerprint(normalized)!==decision.requestHash||(decision.action==='custom'?(!same(selected.payload,decision.request.custom)||selected.origin!=='owner'||selected.operationId!==decision.operationId):selected.id!==candidate.id))invalid('Decision request/candidate hash differs')
    unique(decision.attempts.map(source=>source.commandId))
    for(const source of decision.attempts){runRef(source);if(source.requestHash!==decision.requestHash||!ids.includes(source.sessionId))invalid('Decision attempt hash differs')}
    if(!same(decision.source,decision.attempts.at(-1))||decision.attempts.some((source,index)=>index>0&&source.runSeq<=decision.attempts[index-1].runSeq))invalid('Decision current-attempt fence differs')
    if(decision.completion){
      runRef(decision.completion,{done:true});const{doneSeq:_done,...source}=decision.completion
      if(!same(source,decision.source))invalid('Finalized decision does not settle its current attempt')
      if(decision.status==='failed'){
        if(!deterministicRefusals.has(decision.errorCode)||!id(decision.errorMessage)||!Number.isSafeInteger(decision.errorStatus)||decision.errorStatus<400||decision.errorStatus>599||decision.finalized!==undefined||decision.factReceiptId!==undefined)invalid('Invalid deterministic finalization refusal')
        continue
      }
      if(decision.finalized!==true)invalid('A successful owner receipt is missing its finalization marker')
      const receipt=record.receipts.find(item=>item.receipt.id===decision.factReceiptId)?.receipt
      if(decision.action==='cancel'?decision.factReceiptId!==undefined:!receipt||receipt.candidateId!==selected.id||receipt.factRoundId!==round.roundId||!same(receipt.decisionSource,decision.completion))invalid('Finalized decision has no matching atomic owner receipt')
    }else if(decision.finalized!==undefined||decision.factReceiptId!==undefined)invalid('Decision status without successful completion')
    if(['status','errorCode','errorMessage','errorStatus'].some(field=>decision[field]!==undefined))invalid('Failure metadata has no verified deterministic refusal')
  }
}

export function validateReviewReceipt(record,r,change,originChange=change){
  const round=record.factRounds?.find(round=>round.roundId===r.factRoundId),candidate=round?.candidates.find(candidate=>candidate.id===r.candidateId)
  if(!round||!candidate||!positive(r.factRevision)||r.kind!=='turn'||r.sessionId!==round.sessionId||r.turnKey!==round.turnKey||!same(r.source,round.source)||r.summary!==candidate.payload.summary||!same(r.packet,candidate.payload.packet))invalid('Fact revision is not bound to its logical round and immutable candidate')
  const prior=record.receipts.filter(item=>item.receipt.factRoundId===round.roundId&&item.receipt.factRevision<r.factRevision).at(-1)?.receipt
  if(r.factRevision!==(prior?.factRevision??0)+1||(r.supersedesFactReceiptId??null)!==(prior?.id??null))invalid('Fact revision predecessor differs')
  if(r.decisionSource){
    runRef(r.decisionSource,{done:true});const decision=record.factDecisions.find(value=>value.factReceiptId===r.id)
    if(!decision?.completion||!same(r.decisionSource,decision.completion)||change&&(!same(change.decisionSource,r.decisionSource)||change.decisionOperationId!==decision.operationId))invalid('Revision change has no matching successful decision intent')
  }else if(round.initialAcceptedReceiptId!==r.id||r.factRevision!==1)invalid('Only the original captured commit can omit an owner decision')
  const protectedKeys=new Set(record.binding.factEntryRefs.map(entryKey))
  if(r.factRevision===1&&!same((originChange?.operations??[]).filter(operation=>operation.op==='add'||!protectedKeys.has(entryKey(operation.ref))),round.fixedOperations))invalid('Initial acceptance changed its fixed work operations')
  if(r.factRevision>1&&change?.operations.some(operation=>operation.op==='add'||!protectedKeys.has(entryKey(operation.ref))))invalid('A fact revision replays fixed non-state operations')
  return round
}

/** Actual canonical histories, never imported status flags, prove every owner cause. */
export function validateReviewCanonical(record,view,{projected,views,records}){
  const ancestor=sessionId=>{let current=record.id;const seen=new Set();while(current&&!seen.has(current)){if(current===sessionId)return;seen.add(current);current=views.get(current)?.header?.parentSession}invalid('Review source is not this story or a canonical ancestor')}
  function verifyRun(source,operationId,requestHash,name,options){
    ancestor(source.sessionId);const origin=views.get(source.sessionId)
    if(!origin)invalid('The declared owner command origin is unavailable')
    ownerRun(view,source,operationId,requestHash,name,options);ownerRun(origin,source,operationId,requestHash,name,options)
  }
  for(const round of record.factRounds??[]){
    ancestor(round.sessionId);const origin=views.get(round.sessionId),originRecord=records.get(round.sessionId)
    if(!origin||!originRecord)invalid('The declared fact origin is unavailable')
    activeFactSource({...origin,activeAnchors:origin.events.filter(event=>event.type==='assistant/message').map(event=>event.data?.message?.id)},round.source,'review')
    factCapture(round.capture,projectSession({header:view.header,records:view.events.filter(event=>event.seq<=round.source.callSeq)}),round.source)
    const prefix=projectSession({header:origin.header,records:origin.events.filter(event=>event.seq<=round.source.callSeq)}),captured=new Set(round.baseChangeIds)
    if(round.baseChangeIds.some(id=>!originRecord.changes.some(change=>change.id===id)))invalid('Captured baseline change is missing from its origin audit')
    let entries=structuredClone(originRecord.baseline)
    for(const change of originRecord.changes)if(captured.has(change.id)){
      if(!prefix.activeAnchors.includes(change.anchor)||!changeVisible(originRecord,change,prefix))invalid('Captured baseline has no matching native causal prefix')
      entries=applyScopedOperations(entries,change.operations,{allowFacts:true,additionSourceKey:change.additionSourceKey??'@session'}).entries
    }
    if(!same(worldState(entries,record.binding.factEntryRefs),round.base))invalid('Captured baseline differs from the original native prefix')
    const original=initialCandidate(record,entries,round.initialRequest)
    if(!same(original.payload,round.candidates[0].payload)||!same(original.writePreconditions,round.writePreconditions))invalid('Captured candidate or target preconditions differ from the original turn')
    for(const generation of round.generations??[]){
      for(const source of generation.attempts)verifyRun(source,generation.request.operationId,generation.requestHash,'rp-gm-fact-regenerate')
      const candidate=round.candidates.find(candidate=>candidate.id===generation.candidateId)
      for(const completion of generation.confirmations)verifyRun(completion,generation.request.operationId,generation.requestHash,'rp-gm-fact-regenerate',{done:true,settlement:{schemaVersion:1,operationId:generation.request.operationId,candidateId:candidate.id,payloadHash:candidate.payloadHash}})
      if(candidate.generationConfirmed&&!generationConfirmed(round,candidate,view))invalid('Imported generation status lacks canonical result proof')
    }
    for(const item of record.receipts.filter(item=>item.receipt.factRoundId===round.roundId)){
      const r=item.receipt,after=projected(r.decisionSource?.doneSeq??r.source.callSeq)
      const candidate=round.candidates.find(candidate=>candidate.id===r.candidateId)
      if(!same(worldState(after,record.binding.factEntryRefs),{scene:candidate.payload.scene,facts:candidate.payload.facts}))invalid('The applied world differs from its immutable selected candidate')
      if(!same(preconditions(after,record.binding.factEntryRefs),round.receiptPreconditions[r.id]))invalid('Receipt target preconditions differ from the canonical effective state')
    }
  }
  for(const decision of record.factDecisions??[]){
    for(const source of decision.attempts)verifyRun(source,decision.operationId,decision.requestHash,'rp-gm-fact-decision')
    if(decision.completion)verifyRun(decision.completion,decision.operationId,decision.requestHash,'rp-gm-fact-decision',{done:true})
  }
}
