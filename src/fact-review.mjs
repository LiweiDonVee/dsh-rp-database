import {DatabaseError} from './core.mjs'
import {directionPacket,fingerprint,validateFactState,activeFactSource} from './facts.mjs'
import {applyScopedOperations,entryKey} from './references.mjs'

export const reviewError=(code,message,status=409)=>{throw new DatabaseError(code,message,status)}
export const deterministicRefusals=new Set(['FACT_BASE_CHANGED','FACT_ROUND_NOT_LATEST','READ_ONLY','DISABLED','REVISION_CONFLICT','VERSION_CONFLICT','DUPLICATE_ID','ENTRY_NOT_FOUND','NOT_FOUND','ANCHOR_CONFLICT'])
export const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const text=value=>typeof value==='string'
const nonempty=value=>text(value)&&value.trim().length>0
const seq=value=>Number.isSafeInteger(value)&&value>=0
export function exact(value,allowed,code='INVALID_FACT_CANDIDATE'){
  if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))reviewError(code,'Unexpected fact review fields',400)
}
const messageText=message=>(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n')
function jsonObject(value){
  if(!object(value))return false
  try{return JSON.stringify(value)!==undefined&&!Object.values(value).some(child=>child===undefined||typeof child==='function')}catch{return false}
}
export function factCapture(value,view,source){
  const code='INVALID_FACT_CAPTURE'
  exact(value,['playerInput','story','observations'],code);exact(value.playerInput,['seq','messageId','text'],code);exact(value.story,['title','character','persona','examples'],code)
  if(!seq(value.playerInput.seq)||!nonempty(value.playerInput.messageId)||!text(value.playerInput.text)||!text(value.story.title)||!jsonObject(value.story.character)||!jsonObject(value.story.persona)||!text(value.story.examples)||!Array.isArray(value.observations))reviewError(code,'A complete frozen turn capture is required',400)
  const seen=new Set()
  for(const item of value.observations){exact(item,['callSeq','resultSeq','toolName','text'],code);if(!seq(item.callSeq)||!seq(item.resultSeq)||item.resultSeq<=item.callSeq||!nonempty(item.toolName)||!text(item.text)||seen.has(item.resultSeq))reviewError(code,'Invalid captured tool observation',400);seen.add(item.resultSeq)}
  if(view){
    const player=view.events.find(event=>event.seq===value.playerInput.seq),assistant=view.events.find(event=>event.type==='assistant/message'&&event.data?.message?.id===source.assistantMessageId)
    const latestPlayer=view.events.filter(event=>event.type==='user/message'&&event.data?.source?.kind==='user'&&event.seq>source.turnStartSeq&&event.seq<assistant?.seq).at(-1)
    if(!player||player!==latestPlayer||player.type!=='user/message'||player.data?.source?.kind!=='user'||player.data.id!==value.playerInput.messageId||messageText(player.data)!==value.playerInput.text||player.seq<=source.turnStartSeq||player.seq>=assistant?.seq)reviewError(code,'The capture must identify the exact current-turn player input',400)
    for(const item of value.observations){
      const call=view.events.find(event=>event.seq===item.callSeq),result=view.events.find(event=>event.seq===item.resultSeq),message=result?.data?.message
      const owner=view.events.filter(event=>event.type==='assistant/message'&&event.seq<call?.seq&&event.data?.turn===call?.data?.turn&&event.data?.step===call?.data?.step).at(-1)
      if(call?.type!=='tool/call'||call.data?.name!==item.toolName||call.data.turn!==assistant.data.turn||!view.activeAnchors.includes(owner?.data?.message?.id)||!owner?.data?.message?.content?.some(block=>block.type==='tool-call'&&block.id===call.data.callId&&block.name===item.toolName)||call.seq<=player.seq||result?.type!=='tool/result'||result.seq>=assistant.seq||result.sourceEventSeqs?.length!==1||result.sourceEventSeqs[0]!==call.seq||message?.source?.kind!=='tool'||message.toolCallId!==call.data.callId||message.source.callId!==call.data.callId||result.data?.turn!==call.data.turn||result.data?.step!==call.data.step||messageText(message)!==item.text||['rp_begin_story','rp_commit_turn','rp_propose_turn','rp_present'].includes(item.toolName))reviewError(code,'Captured observations must match completed native tool results',400)
    }
  }
  return structuredClone(value)
}
export function worldState(entries,refs){
  validateFactState(entries,refs)
  const read=id=>{const ref=refs.find(ref=>ref.entryId===id),entry=ref&&entries.find(entry=>entryKey(entry.ref)===entryKey(ref));if(!entry)reviewError('LEGACY_BASELINE_UNAVAILABLE','This story has no captured scene/facts baseline');return JSON.parse(entry.content)}
  return{scene:read('gm.scene'),facts:read('gm.facts')}
}
export function candidatePayload(value){
  exact(value,['scene','facts','summary','packet'])
  if(!text(value.summary))reviewError('INVALID_FACT_CANDIDATE','A summary is required',400)
  const entries=['scene','facts'].map(kind=>({id:`gm.${kind}`,ref:{sourceKey:'@session',entryId:`gm.${kind}`},content:JSON.stringify(value[kind])}))
  validateFactState(entries,entries.map(entry=>entry.ref))
  return{scene:structuredClone(value.scene),facts:structuredClone(value.facts),summary:value.summary,packet:directionPacket(value.packet)}
}
export const preconditions=(entries,refs)=>refs.map(ref=>{const entry=entries.find(entry=>entryKey(entry.ref)===entryKey(ref));return{ref:structuredClone(ref),fingerprint:entry?fingerprint(entry):null}})
export function checkPreconditions(entries,conditions){
  for(const condition of conditions){const entry=entries.find(entry=>entryKey(entry.ref)===entryKey(condition.ref));if((entry?fingerprint(entry):null)!==condition.fingerprint)reviewError('FACT_BASE_CHANGED','A targeted entry changed after the captured fact baseline')}
}
export function initialCandidate(record,entries,input){
  const keys=new Set(record.binding.factEntryRefs.map(entryKey)),fixedOperations=[],stateOperations=[]
  for(const operation of input.operations){
    if(operation.op!=='add'&&keys.has(entryKey(operation.ref))){
      if(operation.op!=='update'||Object.keys(operation.patch??{}).length!==1||!Object.hasOwn(operation.patch,'content')||!['gm.scene','gm.facts'].includes(operation.ref.entryId))reviewError('INVALID_FACT_CANDIDATE','Registered facts require full scene/facts content updates',400)
      stateOperations.push(operation)
    }else fixedOperations.push(operation)
  }
  const applied=applyScopedOperations(entries,input.operations,{allowFacts:true,factEntryRefs:record.binding.factEntryRefs})
  const payload=candidatePayload({...worldState(applied.entries,record.binding.factEntryRefs),summary:input.summary,packet:input.packet})
  const targeted=[...new Map([...record.binding.factEntryRefs,...fixedOperations.map(operation=>operation.op==='add'?{sourceKey:'@session',entryId:operation.entry.id}:operation.ref)].map(ref=>[entryKey(ref),ref])).values()]
  return{payload,fixedOperations,stateOperations,writePreconditions:preconditions(entries,targeted)}
}
export function originActive(round,view){try{activeFactSource(view,round.source,'review');return true}catch{return false}}
export function ownerRun(view,value,operationId,requestHash,name,{sessionId=value?.sessionId,done=false,settlement}={}){
  const code='DECISION_SOURCE_INVALID'
  exact(value,['sessionId','commandId','runSeq','requestHash',...done?['doneSeq']:[]],code)
  if(value.sessionId!==sessionId||!nonempty(value.commandId)||!seq(value.runSeq)||value.requestHash!==requestHash||!/^[a-f0-9]{64}$/.test(requestHash))reviewError(code,'The owner command source does not match this request')
  const runs=view.events.filter(event=>event.type==='command/run'&&event.data?.commandId===value.commandId),run=runs[0],args=run?.data?.args?.trim().split(/\s+/)
  if(runs.length!==1||run.seq!==value.runSeq||run.data.name!==name||run.data.source?.kind!=='user'||args?.length!==2||args[0]!==operationId||args[1]!==requestHash)reviewError(code,'The exact recorded owner command is required')
  if(done){
    const settlements=view.events.filter(event=>event.type==='command/done'&&event.data?.commandId===value.commandId),completed=settlements[0]
    if(settlements.length!==1||completed.seq!==value.doneSeq||completed.seq<=run.seq||completed.data.kind!=='success')reviewError('DECISION_NOT_CONFIRMED','The exact successful owner command completion is required')
    let body;try{body=JSON.parse(completed.data.text)}catch{reviewError('DECISION_NOT_CONFIRMED','The owner completion has no matching structured settlement')}
    const expected=settlement??(name==='rp-gm-fact-decision'?{schemaVersion:1,operationId,requestHash}:undefined)
    if(!expected||!object(body)||fingerprint(body)!==fingerprint(expected))reviewError('DECISION_NOT_CONFIRMED','The owner completion does not bind this exact operation and result')
  }
  return structuredClone(value)
}
export function runVisible(view,source,operationId,requestHash,name,done=false,settlement){try{ownerRun(view,source,operationId,requestHash,name,{done,settlement});return true}catch{return false}}
export function decisionApplied(record,decision,view){
  if(decision.status==='failed')return false
  if(!decision.completion||!runVisible(view,decision.completion,decision.operationId,decision.requestHash,'rp-gm-fact-decision',true))return false
  if(decision.action==='cancel')return decision.finalized===true
  const receipt=record.receipts?.find(item=>item.receipt.id===decision.factReceiptId)?.receipt
  return !!receipt?.decisionSource&&receipt.factRoundId===decision.roundId&&receipt.candidateId===decision.selectedCandidateId&&fingerprint(receipt.decisionSource)===fingerprint(decision.completion)
}
export function changeVisible(record,change,view){
  if(!change.decisionOperationId){
    const receipt=record.receipts?.find(item=>item.receipt.changeId===change.id&&item.receipt.factRoundId)?.receipt
    return !receipt||!!view&&originActive({source:receipt.source},view)
  }
  const decision=record.factDecisions?.find(value=>value.operationId===change.decisionOperationId)
  return !!view&&!!decision&&decisionApplied(record,decision,view)&&record.receipts?.some(item=>item.receipt.id===decision.factReceiptId&&item.receipt.changeId===change.id&&fingerprint(item.receipt.decisionSource)===fingerprint(change.decisionSource))
}
export function receiptVisible(record,item,view){
  if(item.receipt.factRoundId&&(!view||!originActive({source:item.receipt.source},view)))return false
  if(!item.receipt.decisionSource)return true
  const decision=record.factDecisions?.find(value=>value.factReceiptId===item.receipt.id)
  return !!view&&!!decision&&decisionApplied(record,decision,view)
}
export function candidateVisible(round,candidate,view){
  const cause=round.candidateCauses?.[candidate.id]
  if(!cause)return true
  if(candidate.origin==='regenerated'){
    const generation=round.generations?.find(value=>value.candidateId===candidate.id)
    return !!generation&&(generationConfirmed(round,candidate,view)||generation.request.sessionId===view.sessionId&&generation.attempts.some(source=>runVisible(view,source,generation.request.operationId,generation.requestHash,'rp-gm-fact-regenerate')))
  }
  return runVisible(view,cause.source,cause.operationId,cause.source.requestHash,cause.name)
}
export function generationConfirmed(round,candidate,view){
  const generation=round.generations?.find(value=>value.candidateId===candidate.id)
  return !!generation&&generation.confirmations?.some(source=>runVisible(view,source,generation.request.operationId,generation.requestHash,'rp-gm-fact-regenerate',true,{schemaVersion:1,operationId:generation.request.operationId,candidateId:candidate.id,payloadHash:candidate.payloadHash}))===true
}
export function decisionView(record,decision,view,liveAttempts=new Set()){
  const source=(decision.attempts??[decision.source]).filter(source=>runVisible(view,source,decision.operationId,decision.requestHash,'rp-gm-fact-decision')).at(-1)
  if(!source)return null
  const applied=decisionApplied(record,decision,view),done=view.events.find(event=>event.type==='command/done'&&event.data?.commandId===source.commandId)
  const completion=done&&runVisible(view,{...source,doneSeq:done.seq},decision.operationId,decision.requestHash,'rp-gm-fact-decision',true)?{...source,doneSeq:done.seq}:null
  const status=applied?'applied':decision.status==='failed'&&completion||done&&!completion?'failed':!done&&!liveAttempts.has(source.commandId)?'interrupted':'recorded'
  return{operationId:decision.operationId,roundId:decision.roundId,candidateId:decision.candidateId,action:decision.action,requestHash:decision.requestHash,status,source,...completion?{completion}:{},...applied&&decision.factReceiptId?{factReceiptId:decision.factReceiptId}:{},...status==='failed'?{errorCode:decision.status==='failed'?decision.errorCode:'DECISION_NOT_CONFIRMED'}:{}}
}
export function reviewRoundView(record,round,sessionId,view,receipts){
  const active=originActive(round,view),activeReceipt=receipts.filter(item=>item.receipt.factRoundId===round.roundId).at(-1)?.receipt
  const visibleCandidates=round.candidates.filter(candidate=>candidateVisible(round,candidate,view)).map(candidate=>({...candidate,...candidate.origin==='regenerated'?{generationConfirmed:generationConfirmed(round,candidate,view)}:{}}))
  let pendingCandidateId=round.initialAcceptedReceiptId?null:visibleCandidates[0]?.id??null
  for(const event of round.reviewEvents??[]){
    if(event.type==='candidate'&&visibleCandidates.some(candidate=>candidate.id===event.candidateId&&(candidate.origin!=='regenerated'||candidate.generationConfirmed)))pendingCandidateId=event.candidateId
    if(event.type==='settled'){
      const decision=record.factDecisions?.find(value=>value.operationId===event.operationId)
      if(decision&&decisionApplied(record,decision,view))pendingCandidateId=null
    }
  }
  if(!active)pendingCandidateId=null
  const eligible=active&&(activeReceipt||pendingCandidateId)
  const approvalRequired=(round.generations??[]).filter(generation=>visibleCandidates.some(candidate=>candidate.id===generation.candidateId&&candidate.generationConfirmed)).at(-1)?.request.approvalRequired??round.initialApprovalRequired
  return{roundId:round.roundId,version:round.version,sessionId,turnKey:round.turnKey,source:round.source,base:round.base,capture:round.capture,candidates:visibleCandidates,pendingCandidateId,activeReceiptId:activeReceipt?.id??null,approvalRequired,latest:false,canRegenerate:false,...!eligible?{blockCode:'INACTIVE_SOURCE'}:{}}
}
export function generationRequest(value){
  exact(value,['schemaVersion','sessionId','roundId','operationId','expectedRoundVersion','instruction','approvalRequired'],'INVALID_FACT_GENERATION')
  if(value.schemaVersion!==1||!['sessionId','roundId','operationId'].every(field=>nonempty(value[field]))||!Number.isSafeInteger(value.expectedRoundVersion)||value.expectedRoundVersion<1||!text(value.instruction)||typeof value.approvalRequired!=='boolean')reviewError('INVALID_FACT_GENERATION','A complete normalized generation request is required',400)
  return structuredClone(value)
}
export function modelConfig(value){
  if(value===undefined)return undefined
  exact(value,['provider','model','reasoningEffort','maxTokens'],'INVALID_FACT_GENERATION')
  if(!nonempty(value.provider)||!nonempty(value.model)||value.reasoningEffort!==undefined&&!nonempty(value.reasoningEffort)||value.maxTokens!==undefined&&(!Number.isSafeInteger(value.maxTokens)||value.maxTokens<1))reviewError('INVALID_FACT_GENERATION','Invalid recorded model configuration',400)
  return structuredClone(value)
}
export function decisionRequest(value,candidate){
  const result={sessionId:value.sessionId,roundId:value.roundId,candidateId:value.candidateId,action:value.action,candidatePayloadHash:candidate.payloadHash}
  if(!['approve','custom','cancel'].includes(value.action))reviewError('INVALID_FACT_DECISION','Unknown fact decision action',400)
  if(value.action==='custom')result.custom=candidatePayload(value.custom)
  else if(Object.hasOwn(value,'custom'))reviewError('INVALID_FACT_DECISION','Only custom decisions carry a custom payload',400)
  return result
}
export function stateOperations(record,payload){
  return ['scene','facts'].map(kind=>{const ref=record.binding.factEntryRefs.find(ref=>ref.entryId===`gm.${kind}`);if(!ref)reviewError('LEGACY_BASELINE_UNAVAILABLE','The scene/facts registry is unavailable');return{op:'update',ref,patch:{content:JSON.stringify(payload[kind])}}})
}
