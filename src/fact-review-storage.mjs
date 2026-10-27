import {randomUUID} from 'node:crypto'
import {factCommit,fingerprint} from './facts.mjs'
import {entryKey} from './references.mjs'
import {candidatePayload,checkPreconditions,decisionApplied,decisionRequest,deterministicRefusals,exact,generationConfirmed,generationRequest,modelConfig,ownerRun,preconditions,reviewError,stateOperations} from './fact-review.mjs'

/** Fact-review mutations share the Database writer queue and authoritative causal overlay. */
export function createFactReviewStorage({read,write,sessionRecord,project,applyChange,review,projectedReceipt,liveAttempts}){
  const selected=(record,sessionId,options)=>review(record,sessionId,options)
  function roundFor(record,roundId){
    const round=record.factRounds?.find(round=>round.roundId===roundId)
    if(!round){
      if(record.receipts?.some(item=>!item.receipt.factRoundId&&(item.receipt.id===roundId||item.receipt.turnKey===roundId)))reviewError('LEGACY_BASELINE_UNAVAILABLE','The legacy fact receipt has no reliable captured baseline')
      reviewError('NOT_FOUND','The fact round is unavailable',404)
    }
    return round
  }
  function latest(record,round,sessionId,options){
    const state=selected(record,sessionId,options),view=state.rounds.find(value=>value.roundId===round.roundId)
    if(!view?.latest)reviewError('FACT_ROUND_NOT_LATEST','Only the latest active or pending fact round may be revised')
    return view
  }
  function version(round,expected){if(round.version!==expected)reviewError('REVISION_CONFLICT','The fact round changed; reload before saving')}
  function reserved(record,roundId,options,operationId){
    const decision=selected(record,record.id,options).decisions.find(decision=>decision.roundId===roundId&&decision.status!=='applied'&&decision.operationId!==operationId&&record.factDecisions.find(stored=>stored.operationId===decision.operationId)?.status!=='failed')
    if(decision)reviewError('FACT_REVIEW_PENDING','An owner decision reserves this fact round')
  }
  function currentBase(record,round,view,options){
    const entries=project(record,options).entries
    const conditions=view.activeReceiptId?round.receiptPreconditions?.[view.activeReceiptId]:round.writePreconditions
    if(!conditions)reviewError('LEGACY_BASELINE_UNAVAILABLE','The selected receipt lacks write preconditions')
    checkPreconditions(entries,conditions);return entries
  }
  function generation(input){
    exact(input,['sessionId','roundId','payload','model','operationId','expectedRoundVersion','source','completion','approvalRequired','generationRequest','signal'],'INVALID_FACT_GENERATION')
    const request=generationRequest(input.generationRequest)
    for(const field of ['sessionId','roundId','operationId','expectedRoundVersion','approvalRequired'])if(request[field]!==input[field])reviewError('DECISION_SOURCE_INVALID','The generation source and complete request must describe the same attempt')
    return{request,requestHash:fingerprint(request),payload:candidatePayload(input.payload),model:modelConfig(input.model)}
  }
  return{
    stage(input,options){
      const normalized=generation(input)
      ownerRun(options.view,input.source,input.operationId,normalized.requestHash,'rp-gm-fact-regenerate',{sessionId:input.sessionId})
      return write(input.sessionId,(record)=>{
        const round=roundFor(record,input.roundId),existing=(record.factRounds??[]).flatMap(value=>value.generations??[]).find(value=>value.request.operationId===input.operationId)
        if(existing){
          if(existing.requestHash!==normalized.requestHash||fingerprint(normalized.payload)!==existing.payloadHash||fingerprint(normalized.model??null)!==fingerprint(existing.model??null))reviewError('OPERATION_ID_CONFLICT','This generation operation already binds another request or candidate')
          const view=latest(record,round,input.sessionId,options)
          const candidate=round.candidates.find(candidate=>candidate.id===existing.candidateId),confirmed=candidate&&generationConfirmed(round,candidate,options.view)
          if(!candidate||confirmed&&view.pendingCandidateId!==existing.candidateId||!confirmed&&round.version!==existing.stagedRoundVersion)reviewError('FACT_VERSION_SUPERSEDED','This staged candidate has been superseded by another mutation')
          reserved(record,round.roundId,options)
          let changed=false
          if(!existing.attempts.some(source=>fingerprint(source)===fingerprint(input.source))){
            if(input.source.runSeq<=existing.attempts.at(-1).runSeq)reviewError('DECISION_SOURCE_INVALID','A replacement generation attempt must be a later real command')
            existing.attempts.push(structuredClone(input.source));changed=true
          }
          if(input.completion){
            const completion=ownerRun(options.view,input.completion,input.operationId,normalized.requestHash,'rp-gm-fact-regenerate',{sessionId:input.sessionId,done:true,settlement:{schemaVersion:1,operationId:input.operationId,candidateId:candidate.id,payloadHash:candidate.payloadHash}}),{doneSeq:_done,...run}=completion
            if(fingerprint(run)!==fingerprint(input.source))reviewError('DECISION_SOURCE_INVALID','Generation confirmation must settle its exact staged attempt')
            if(!existing.confirmations.some(source=>fingerprint(source)===fingerprint(completion))){
              existing.confirmations.push(completion);candidate.generationConfirmed=true;changed=true
              if(!confirmed){round.pendingCandidateId=candidate.id;round.approvalRequired=existing.request.approvalRequired;round.version++;(round.reviewEvents??=[]).push({type:'candidate',candidateId:candidate.id})}
            }
          }
          return{value:{round:selected(record,input.sessionId,options).rounds.find(value=>value.roundId===round.roundId),candidateId:existing.candidateId},changed}
        }
        if(input.completion)reviewError('DECISION_SOURCE_INVALID','A generation must be staged before its completion can be confirmed')
        const view=latest(record,round,input.sessionId,options)
        reserved(record,round.roundId,options);version(round,input.expectedRoundVersion);currentBase(record,round,view,options)
        if(view.pendingCandidateId&&round.approvalRequired!==input.approvalRequired)reviewError('FACT_APPROVAL_REQUIRED','A pending review retains its captured approval policy')
        const candidate={id:randomUUID(),roundId:round.roundId,createdAt:new Date().toISOString(),origin:'regenerated',payload:normalized.payload,payloadHash:fingerprint(normalized.payload),operationId:input.operationId,generationConfirmed:false,...normalized.model?{model:normalized.model}:{}}
        round.candidates.push(candidate);round.version++
        ;(round.candidateCauses??={})[candidate.id]={operationId:input.operationId,name:'rp-gm-fact-regenerate',source:structuredClone(input.source)}
        ;(round.generations??=[]).push({request:normalized.request,requestHash:normalized.requestHash,...normalized.model?{model:normalized.model}:{},candidateId:candidate.id,payloadHash:candidate.payloadHash,attempts:[structuredClone(input.source)],confirmations:[],stagedRoundVersion:round.version})
        return{value:{round:selected(record,input.sessionId,options).rounds.find(value=>value.roundId===round.roundId),candidateId:candidate.id}}
      })
    },
    record(input,options){
      exact(input,['sessionId','roundId','candidateId','action','custom','operationId','expectedRoundVersion','expectedDatabaseRevision','source','signal'],'INVALID_FACT_DECISION')
      if(typeof input.operationId!=='string'||!input.operationId.trim())reviewError('INVALID_FACT_DECISION','A decision operation ID is required',400)
      return write(input.sessionId,(record,state)=>{
        const round=roundFor(record,input.roundId),candidate=round.candidates.find(candidate=>candidate.id===input.candidateId)
        if(!candidate)reviewError('FACT_VERSION_SUPERSEDED','The displayed candidate is unavailable')
        const previous=record.factDecisions?.find(value=>value.operationId===input.operationId)
        if(previous&&previous.request.sessionId!==input.sessionId)reviewError('DECISION_SOURCE_INVALID','A parent decision request cannot execute as a child operation')
        const request=decisionRequest({...input,sessionId:previous?.request.sessionId??input.sessionId},candidate),requestHash=fingerprint(request)
        if(previous&&previous.requestHash!==requestHash)reviewError('OPERATION_ID_CONFLICT','This decision operation binds a different immutable request')
        const source=ownerRun(options.view,input.source,input.operationId,requestHash,'rp-gm-fact-decision',{sessionId:input.sessionId})
        if(previous){
          if(previous.requestHash!==requestHash)reviewError('OPERATION_ID_CONFLICT','This decision operation binds a different immutable request')
          if(decisionApplied(record,previous,options.view))return{value:{operationId:input.operationId,status:'applied',...previous.factReceiptId?{factReceiptId:previous.factReceiptId}:{}},changed:false}
          if(previous.status==='failed')reviewError(previous.errorCode,previous.errorMessage,previous.errorStatus)
          latest(record,round,input.sessionId,options)
          if(previous.attempts.some(attempt=>fingerprint(attempt)===fingerprint(source)))return{value:{operationId:input.operationId,status:'recorded'},changed:false}
          if(source.runSeq<=previous.source.runSeq)reviewError('DECISION_SOURCE_INVALID','Only a later real command may fence the current attempt')
          previous.attempts.push(source);previous.source=source;liveAttempts.add(source.commandId)
          return{value:{operationId:input.operationId,status:'recorded'}}
        }
        const view=input.action==='cancel'?selected(record,input.sessionId,options).rounds.find(value=>value.roundId===round.roundId):latest(record,round,input.sessionId,options)
        reserved(record,round.roundId,options);version(round,input.expectedRoundVersion)
        if(state.revision!==input.expectedDatabaseRevision)reviewError('REVISION_CONFLICT','Database content changed; reload before deciding')
        if(view.pendingCandidateId!==input.candidateId)reviewError('FACT_VERSION_SUPERSEDED','This candidate is no longer awaiting a decision')
        if(input.action!=='cancel')currentBase(record,round,view,options)
        let selectedCandidate=candidate
        if(input.action==='custom'){
          selectedCandidate={id:randomUUID(),roundId:round.roundId,createdAt:new Date().toISOString(),origin:'owner',payload:request.custom,payloadHash:fingerprint(request.custom),operationId:input.operationId}
          round.candidates.push(selectedCandidate);round.pendingCandidateId=selectedCandidate.id
          ;(round.candidateCauses??={})[selectedCandidate.id]={operationId:input.operationId,name:'rp-gm-fact-decision',source}
          ;(round.reviewEvents??=[]).push({type:'candidate',candidateId:selectedCandidate.id})
        }
        const decision={operationId:input.operationId,roundId:round.roundId,candidateId:input.candidateId,selectedCandidateId:selectedCandidate.id,action:input.action,requestHash,request,source,attempts:[source]}
        ;(record.factDecisions??=[]).push(decision);round.version++;liveAttempts.add(source.commandId)
        return{value:{operationId:input.operationId,status:'recorded'}}
      })
    },
    async finalize(input,options){
      exact(input,['sessionId','operationId','source','signal'],'INVALID_FACT_DECISION')
      const outcome=await write(input.sessionId,(record,state)=>{
        const decision=record.factDecisions?.find(value=>value.operationId===input.operationId)
        if(!decision)reviewError('DECISION_NOT_CONFIRMED','No matching recorded decision intent exists')
        if(decision.request.sessionId!==input.sessionId)reviewError('DECISION_SOURCE_INVALID','A parent decision cannot be finalized again in a child')
        const source=ownerRun(options.view,input.source,input.operationId,decision.requestHash,'rp-gm-fact-decision',{sessionId:input.sessionId,done:true})
        const{doneSeq:_done,...run}=source
        const round=roundFor(record,decision.roundId)
        if(decisionApplied(record,decision,options.view)){
          const receipt=record.receipts.find(item=>item.receipt.id===decision.factReceiptId)?.receipt
          return{value:{operationId:input.operationId,status:decision.action==='cancel'?'cancelled':'approved',round:selected(record,input.sessionId,options).rounds.find(value=>value.roundId===round.roundId),...receipt?{receipt:projectedReceipt(receipt,input.sessionId)}:{}},changed:false}
        }
        if(fingerprint(run)!==fingerprint(decision.source))reviewError('DECISION_SOURCE_INVALID','Only the current recorded command attempt may finalize this decision')
        if(decision.status==='failed')reviewError(decision.errorCode,decision.errorMessage,decision.errorStatus)
        try{
        const view=decision.action==='cancel'?selected(record,input.sessionId,options).rounds.find(value=>value.roundId===round.roundId):latest(record,round,input.sessionId,options)
        if(view.pendingCandidateId!==decision.selectedCandidateId)reviewError('FACT_VERSION_SUPERSEDED','The reserved candidate is no longer pending')
        let receipt
        if(decision.action!=='cancel'){
          const entries=currentBase(record,round,view,options)
          const candidate=round.candidates.find(candidate=>candidate.id===decision.selectedCandidateId)
          if(!candidate||candidate.payloadHash!==fingerprint(candidate.payload))reviewError('INVALID_FACT_CANDIDATE','The immutable selected candidate is invalid',400)
          const operations=stateOperations(record,candidate.payload).filter(operation=>fingerprint(JSON.parse(entries.find(entry=>entryKey(entry.ref)===entryKey(operation.ref)).content))!==fingerprint(JSON.parse(operation.patch.content)))
          if(!view.activeReceiptId)operations.push(...round.fixedOperations)
          const applied=operations.length?applyChange(record,operations,{...options,anchor:round.source.assistantMessageId,allowFacts:true}):{session:project(record,options),changeId:null}
          receipt={schemaVersion:1,id:randomUUID(),sessionId:round.sessionId,turnKey:round.turnKey,source:round.source,kind:'turn',databaseRevision:state.revision+1,changeId:applied.changeId,stateRefs:record.binding.factEntryRefs.map(ref=>({...ref,version:applied.session.entries.find(entry=>entryKey(entry.ref)===entryKey(ref)).version})),summary:candidate.payload.summary,packet:candidate.payload.packet,createdAt:new Date().toISOString(),factRoundId:round.roundId,factRevision:(record.receipts.find(item=>item.receipt.id===view.activeReceiptId)?.receipt.factRevision??0)+1,candidateId:candidate.id,...view.activeReceiptId?{supersedesFactReceiptId:view.activeReceiptId}:{},decisionSource:source}
          if(applied.changeId){const change=record.changes.find(change=>change.id===applied.changeId);change.decisionOperationId=decision.operationId;change.decisionSource=source}
          const normalized=factCommit({turnKey:round.turnKey,source:round.source,expectedRevision:0,operations,summary:receipt.summary,packet:receipt.packet,kind:'turn',capture:round.capture},round.sessionId),{expectedRevision:_revision,...content}=normalized
          ;(record.receipts??=[]).push({receipt,fingerprint:fingerprint(content)})
          ;(round.receiptPreconditions??={})[receipt.id]=preconditions(applied.session.entries,record.binding.factEntryRefs)
          decision.factReceiptId=receipt.id
        }
        decision.completion=source;decision.finalized=true;round.pendingCandidateId=null;round.version++
        ;(round.reviewEvents??=[]).push({type:'settled',operationId:decision.operationId})
        return{value:{operationId:input.operationId,status:decision.action==='cancel'?'cancelled':'approved',round:selected(record,input.sessionId,options).rounds.find(value=>value.roundId===round.roundId),...receipt?{receipt:projectedReceipt(receipt,input.sessionId)}:{}}}
        }catch(error){
          if(!deterministicRefusals.has(error.code))throw error
          decision.status='failed';decision.errorCode=error.code;decision.errorMessage=error.message;decision.errorStatus=error.status;decision.completion=source;round.version++
          return{value:{refusal:{code:error.code,message:error.message,status:error.status}}}
        }
      })
      if(outcome.refusal)reviewError(outcome.refusal.code,outcome.refusal.message,outcome.refusal.status)
      return outcome
    },
    decision(sessionId,operationId,options){return read(state=>selected(sessionRecord(state,sessionId),sessionId,options).decisions.find(value=>value.operationId===operationId)??null)},
  }
}
