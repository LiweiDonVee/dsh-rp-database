import {createHash} from 'node:crypto'
import {DatabaseError,validateDatabase} from './core.mjs'
import {entryKey,entryRef} from './references.mjs'

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const fail=(code,message,status=400)=>{throw new DatabaseError(code,message,status)}
function keys(value,allowed,code){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(code,'Unexpected fields')}
const text=(value,code,label)=>{if(typeof value!=='string')fail(code,`${label} must be text`);return value}
const nonempty=(value,code,label)=>{if(!text(value,code,label).trim())fail(code,`${label} must not be empty`);return value}
const strings=value=>Array.isArray(value)&&value.every(item=>typeof item==='string')
const sequence=value=>Number.isSafeInteger(value)&&value>=0
const stable=value=>Array.isArray(value)?value.map(stable):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value
export const fingerprint=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')

export function directionPacket(value){
  const code='INVALID_DIRECTION_PACKET'
  keys(value,['playerAction','sceneInstruction','resolvedChanges','visibleConsequences','openHooks','proseConstraints','publicFactRefs','variables'],code)
  nonempty(value.playerAction,code,'playerAction')
  if(Object.hasOwn(value,'sceneInstruction'))text(value.sceneInstruction,code,'sceneInstruction')
  for(const key of ['resolvedChanges','visibleConsequences','openHooks','proseConstraints','publicFactRefs'])if(Object.hasOwn(value,key)&&!strings(value[key]))fail(code,`${key} must contain public strings`)
  if(Object.hasOwn(value,'variables')&&(!object(value.variables)||Object.values(value.variables).some(value=>typeof value!=='string')))fail(code,'variables must map names to public strings')
  return structuredClone(value)
}
export function canonicalSource(value){
  const code='INVALID_SOURCE'
  keys(value,['assistantMessageId','callId','callSeq','turnStartSeq'],code)
  nonempty(value.assistantMessageId,code,'assistantMessageId');nonempty(value.callId,code,'callId')
  if(!sequence(value.turnStartSeq)||value.callSeq!==undefined&&!sequence(value.callSeq))fail(code,'Source event sequences must be nonnegative integers')
  return structuredClone(value)
}
export function factCommit(value,sessionId){
  const code='INVALID_FACT_COMMIT'
  keys(value,['turnKey','source','expectedRevision','operations','summary','packet','kind','openingText','capture'],code)
  const source=canonicalSource(value.source)
  if(value.turnKey!==JSON.stringify([sessionId,source.turnStartSeq]))fail(code,'turnKey must identify this story and its canonical turn/start')
  if(!sequence(value.expectedRevision)||!Array.isArray(value.operations)||!['turn','opening'].includes(value.kind))fail(code,'A revision, operations and receipt kind are required')
  text(value.summary,code,'summary')
  if(value.kind==='opening')nonempty(value.openingText,code,'openingText')
  else if(Object.hasOwn(value,'openingText'))fail(code,'openingText is only valid for opening receipts')
  return{...structuredClone(value),source,packet:directionPacket(value.packet)}
}
export function storySeed({entries,factEntryRefs,launchId}){
  nonempty(launchId,'INVALID_STORY_STATE','launchId')
  const normalized=validateDatabase({id:'seed',name:'Seed',version:1,entries}).entries.map(entry=>({...entry,ref:{sourceKey:'@session',entryId:entry.id}}))
  if(!Array.isArray(factEntryRefs))fail('INVALID_STORY_STATE','factEntryRefs must be an array')
  const refs=factEntryRefs.map(entryRef),used=new Set()
  for(const ref of refs){const key=entryKey(ref);if(ref.sourceKey!=='@session'||used.has(key)||!normalized.some(entry=>entryKey(entry.ref)===key))fail('INVALID_STORY_STATE','Fact refs must identify distinct supplied session seed entries');used.add(key)}
  validateFactState(normalized,refs)
  return{entries:normalized,factEntryRefs:refs,launchId}
}
export function validateFactState(entries,refs){
  for(const ref of refs){
    const entry=entries.find(entry=>entryKey(entry.ref)===entryKey(ref))
    if(!entry)fail('INVALID_FACT_STATE','A registered fact entry must remain available')
    if(!['gm.scene','gm.facts'].includes(ref.entryId))continue
    let value;try{value=JSON.parse(entry.content)}catch{fail('INVALID_FACT_STATE','Registered GM state must contain schema-versioned JSON')}
    if(ref.entryId==='gm.scene'){
      keys(value,['schemaVersion','title','location','time','presentActorIds'],'INVALID_FACT_STATE')
      if(value.schemaVersion!==1||typeof value.title!=='string'||typeof value.location!=='string'||value.time!==undefined&&typeof value.time!=='string'||!strings(value.presentActorIds))fail('INVALID_FACT_STATE','Invalid gm.scene state')
    }else{
      keys(value,['schemaVersion','items'],'INVALID_FACT_STATE')
      if(value.schemaVersion!==1||!Array.isArray(value.items)||value.items.some(item=>!object(item)||Object.keys(item).some(key=>!['id','text'].includes(key))||typeof item.id!=='string'||typeof item.text!=='string'))fail('INVALID_FACT_STATE','Invalid gm.facts state')
    }
  }
}

/** Compare actual native turn, assistant block and canonical call; provider call IDs alone are insufficient. */
export function activeFactSource(view,source,kind){
  const normalized=canonicalSource(source),assistant=view.events.find(event=>event.type==='assistant/message'&&event.data?.message?.id===source.assistantMessageId)
  if(!assistant||!view.activeAnchors.includes(source.assistantMessageId))fail('INACTIVE_SOURCE','The factual source is not active',409)
  const start=view.events.filter(event=>event.type==='turn/start'&&event.seq<assistant.seq).at(-1)
  const names=kind==='opening'?['rp_begin_story']:kind==='proposal'?['rp_propose_turn']:kind==='review'?['rp_commit_turn','rp_propose_turn']:['rp_commit_turn']
  const block=assistant.data.message.content?.find(block=>block.type==='tool-call'&&block.id===source.callId&&names.includes(block.name))
  const next=view.events.find(event=>event.seq>assistant.seq&&event.type==='assistant/message'&&event.data?.turn===assistant.data.turn&&event.data?.step===assistant.data.step)
  const calls=view.events.filter(event=>event.type==='tool/call'&&event.seq>assistant.seq&&(!next||event.seq<next.seq)&&event.data?.turn===assistant.data.turn&&event.data?.step===assistant.data.step&&event.data?.callId===source.callId&&event.data?.name===block?.name)
  const call=source.callSeq===undefined?(calls.length===1?calls[0]:undefined):calls.find(call=>call.seq===source.callSeq)
  if(!block||!call||!start||start.seq!==source.turnStartSeq||start.data.turn!==assistant.data.turn)fail('INACTIVE_SOURCE','The source does not match an active native GM tool call',409)
  return{...normalized,callSeq:call.seq}
}
