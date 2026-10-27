import {createHash} from 'node:crypto'
import {DatabaseError,validateDatabase} from './core.mjs'
import {applyScopedOperations,entryKey,entryRef,entryViews,parseEntryKey,sourceBindings} from './references.mjs'
import {activeFactSource,factCommit,fingerprint,validateFactState} from './facts.mjs'
import {documentContent,validateChunkReferences} from './document-types.mjs'
import {publicSource} from './transfer.mjs'
import {projectSession} from './session.mjs'
import {changeVisible} from './fact-review.mjs'
import {validateReviewCanonical,validateReviewReceipt,validateReviewStructure} from './fact-review-transfer.mjs'

const key=value=>createHash('sha256').update(value).digest('hex')
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const text=value=>typeof value==='string'&&value.trim().length>0
const positive=value=>Number.isSafeInteger(value)&&value>0
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const invalid=message=>{throw new DatabaseError('RESTORE_PAYLOAD_INVALID',message)}
const requireContent=message=>{throw new DatabaseError('RESTORE_REQUIREMENT_MISSING',message)}
const exact=(value,allowed)=>{if(!object(value)||Object.keys(value).some(field=>!allowed.includes(field)))invalid('Unexpected restore fields')}
export function sessionIds(value){if(!Array.isArray(value)||value.some(id=>!text(id))||new Set(value).size!==value.length)invalid('sessionIds must be distinct IDs');return[...value]}
export function restoreTransport(input){
  if(!object(input)||!text(input.restoreId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)invalid('A restoreId, Session set and nonnegative expectedRevision are required')
  const ids=sessionIds(input.sessionIds),state=input.state
  exact(state,['schemaVersion','revision','payload'])
  if(!positive(state.schemaVersion)||!Number.isSafeInteger(state.revision)||state.revision<0||!object(state.payload))invalid('A serializable versioned state envelope is required')
  const seen=new Set()
  function json(value){
    if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return
    if(typeof value!=='object'||seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid('Restore state must be JSON-serializable data')
    seen.add(value);for(const child of Object.values(value))json(child);seen.delete(value)
  }
  json(state);return ids
}
const unique=(values,name)=>{const set=new Set();for(const value of values){if(!text(value)||set.has(value))invalid(`Duplicate or invalid ${name}`);set.add(value)}return set}
function additionalDatabaseRefs(value=[]){
  if(!Array.isArray(value)||value.some(ref=>!object(ref)||Object.keys(ref).some(field=>!['databaseId','version'].includes(field))||!text(ref.databaseId)||!positive(ref.version)))throw new DatabaseError('INVALID_DATA','additionalDatabaseRefs must contain exact databaseId/version references')
  return value
}
function databaseVersion(state,id,version){
  const pinned=state.databases[key(id)]?.versions.find(value=>value.database.version===version)
  if(!pinned)throw new DatabaseError('EXPORT_REQUIREMENT_MISSING','Missing pinned database reference '+JSON.stringify({databaseId:id,version}))
  return pinned
}
export function checkExportDatabaseRefs(state,value){
  const refs=additionalDatabaseRefs(value);for(const ref of refs)databaseVersion(state,ref.databaseId,ref.version);return refs
}

/** Select dependency versions only; derived vectors and operation journals are never exported. */
export function exportDatabaseState(state,ids,additionalRefs){
  sessionIds(ids);const requested=additionalDatabaseRefs(additionalRefs)
  const databases=new Map(),sources=new Map(),documents=new Map(),sessions=ids.map(id=>state.sessions[key(id)]).filter(Boolean)
  function source(id){if(!id)return;const value=state.sources[key(id)];if(!value)requireContent('An immutable source is missing');sources.set(id,value)}
  function database(id,version){
    const pinned=databaseVersion(state,id,version)
    let selected=databases.get(id);if(!selected){selected=new Map();databases.set(id,selected)}if(selected.has(version))return;selected.set(version,pinned)
    source(pinned.sourceId)
    for(const ref of pinned.documentRefs??[])document(ref.documentId,ref.version)
    for(const entry of pinned.database.entries)if(entry.provenance)document(entry.provenance.documentId,entry.provenance.documentVersion)
  }
  function document(id,version){
    const pinned=state.documents?.[key(id)]?.versions.find(value=>value.document.version===version)
    if(!pinned)requireContent('A referenced document version is missing')
    let selected=documents.get(id);if(!selected){selected=new Map();documents.set(id,selected)}if(selected.has(version))return;selected.set(version,pinned)
  }
  for(const ref of requested)database(ref.databaseId,ref.version)
  for(const record of sessions){
    for(const binding of record.binding.sources)database(binding.databaseId,binding.version)
    source(record.sourceId)
    for(const entry of record.baseline)if(entry.provenance)document(entry.provenance.documentId,entry.provenance.documentVersion)
    for(const item of record.receipts??[])if(!ids.includes(item.receipt.sessionId))requireContent('Include the receipt origin ancestor in sessionIds')
    for(const round of record.factRounds??[])if(!ids.includes(round.sessionId))requireContent('Include the captured fact origin ancestor in sessionIds')
    for(const source of [...(record.factDecisions??[]).flatMap(decision=>decision.attempts),...(record.factRounds??[]).flatMap(round=>(round.generations??[]).flatMap(generation=>generation.attempts))])if(!ids.includes(source.sessionId))requireContent('Include the owner command origin ancestor in sessionIds')
  }
  // Document ownership names an ID, not a version. All explicit runtime/passive refs are now selected.
  for(const versions of documents.values())for(const item of versions.values())if(!databases.has(item.document.databaseId))throw new DatabaseError('EXPORT_REQUIREMENT_MISSING','A document owner requires an explicit database version '+JSON.stringify({databaseId:item.document.databaseId,documentId:item.document.id,documentVersion:item.document.version}))
  return structuredClone({schemaVersion:1,revision:state.revision,payload:{storeSchemaVersion:2,databases:[...databases].map(([id,versions])=>({id,versions:[...versions.values()].sort((a,b)=>a.database.version-b.database.version)})),sources:[...sources.values()],documents:[...documents].map(([id,versions])=>({id,versions:[...versions.values()].sort((a,b)=>a.document.version-b.document.version)})),sessions}})
}

export function restoreEnvelope(value,ids){
  try{return validateEnvelope(value,sessionIds(ids))}catch(error){if(error instanceof DatabaseError&&error.code.startsWith('RESTORE_'))throw error;invalid('Invalid Database restore payload')}
}
function validateEnvelope(value,ids){
  exact(value,['schemaVersion','revision','payload'])
  if(value.schemaVersion!==1||!Number.isSafeInteger(value.revision)||value.revision<0)invalid('Unsupported restore schema')
  const state=structuredClone(value),p=state.payload
  exact(p,['storeSchemaVersion','databases','sources','documents','sessions'])
  if(p.storeSchemaVersion!==2||!['databases','sources','documents','sessions'].every(field=>Array.isArray(p[field])))invalid('Unsupported Database payload schema')
  unique(p.sources.map(source=>source.id),'source IDs');unique(p.databases.map(record=>record.id),'database IDs');unique(p.documents.map(record=>record.id),'document IDs');unique(p.sessions.map(record=>record.id),'session IDs')
  const sources=new Set(p.sources.map(source=>source.id)),dbs=new Map(),docs=new Map()
  for(const source of p.sources){exact(source,['id','format','rawText','dataBase64','sha256','provenance','importReport']);publicSource(source);if(source.importReport!==undefined&&!object(source.importReport))invalid('Invalid source report')}
  for(const record of p.documents){
    exact(record,['id','versions']);if(!Array.isArray(record.versions)||!record.versions.length)invalid('Missing document versions')
    const versions=new Set()
    for(const item of record.versions){exact(item,['document','extraction','diagnostics']);documentContent({document:item.document,extraction:item.extraction},'RESTORE_PAYLOAD_INVALID');if(item.document.id!==record.id||versions.has(item.document.version)||!Array.isArray(item.diagnostics))invalid('Invalid document identity');versions.add(item.document.version);docs.set(JSON.stringify([record.id,item.document.version]),item)}
  }
  for(const record of p.databases){
    exact(record,['id','versions']);if(!Array.isArray(record.versions)||!record.versions.length)invalid('Missing database versions')
    const versions=new Set()
    for(const item of record.versions){
      exact(item,['database','sourceId','documentRefs']);item.database=validateDatabase(item.database)
      if(item.database.id!==record.id||versions.has(item.database.version))invalid('Invalid database version identity');versions.add(item.database.version)
      if(item.sourceId!==undefined&&!sources.has(item.sourceId))requireContent('Missing immutable source dependency')
      if(item.documentRefs!==undefined&&(!Array.isArray(item.documentRefs)||item.documentRefs.some(ref=>!object(ref)||Object.keys(ref).some(key=>!['documentId','version'].includes(key))||!docs.has(JSON.stringify([ref.documentId,ref.version])))))requireContent('Missing document dependency')
      validateChunkReferences(item.database.entries,[...docs.values()],'RESTORE_PAYLOAD_INVALID');dbs.set(JSON.stringify([record.id,item.database.version]),item)
    }
  }
  for(const item of docs.values())if(!p.databases.some(record=>record.id===item.document.databaseId))requireContent('Missing document owner library')
  for(const record of p.sessions){
    exact(record,['id','binding','sourceId','baseline','baselineNotes','reservedKeys','changes','initialization','receipts','factReviewVersion','factRounds','factDecisions'])
    if(!ids.includes(record.id))invalid('Session record is outside the requested namespace')
    exact(record.binding,['schemaVersion','sources','factEntryRefs']);if(record.binding.schemaVersion!==2||!Array.isArray(record.binding.factEntryRefs))invalid('Invalid binding')
    record.binding.sources=sourceBindings(record.binding.sources);record.binding.factEntryRefs=record.binding.factEntryRefs.map(entryRef);unique(record.binding.factEntryRefs.map(entryKey),'fact refs')
    record.baseline=entryViews(record.baseline);validateChunkReferences(record.baseline,[...docs.values()],'RESTORE_PAYLOAD_INVALID')
    const slots=new Set(['@session',...record.binding.sources.map(source=>source.key)])
    if(record.baseline.some(entry=>!slots.has(entry.ref.sourceKey)))invalid('Unknown baseline source slot')
    for(const binding of record.binding.sources){
      const pinned=dbs.get(JSON.stringify([binding.databaseId,binding.version]));if(!pinned)requireContent('Missing pinned source version')
      const expected=pinned.database.entries.map(entry=>({...entry,ref:{sourceKey:binding.key,entryId:entry.id},sourceVersion:binding.version}))
      if(fingerprint(record.baseline.filter(entry=>entry.ref.sourceKey===binding.key))!==fingerprint(expected))invalid('Source baseline differs from its immutable pinned version')
    }
    if(record.sourceId!==undefined&&!sources.has(record.sourceId))requireContent('Missing legacy source')
    if(!Array.isArray(record.baselineNotes)||!Array.isArray(record.reservedKeys)||!Array.isArray(record.changes))invalid('Invalid causal record')
    const reserved=unique(record.reservedKeys,'reserved keys'),seen=new Set(record.baseline.map(entry=>entryKey(entry.ref)))
    for(const value of reserved)if(entryKey(parseEntryKey(value))!==value)invalid('Noncanonical reserved entry key')
    for(const value of seen)if(!reserved.has(value))invalid('Baseline ID is not reserved')
    for(const note of record.baselineNotes){exact(note,['ref','text','anchor']);entryRef(note.ref);if(!text(note.text)||!text(note.anchor))invalid('Invalid baseline note')}
    unique(record.changes.map(change=>change.id),'change IDs')
    for(const change of record.changes){
      exact(change,['id','anchor','operations','additionSourceKey','decisionOperationId','decisionSource']);if(!text(change.anchor)||!Array.isArray(change.operations)||!slots.has(change.additionSourceKey??'@session'))invalid('Invalid causal change')
      for(const operation of change.operations){
        if(operation.op==='add'){
          applyScopedOperations([],[operation]);const id=entryKey({sourceKey:change.additionSourceKey??'@session',entryId:operation.entry.id})
          if(seen.has(id)||!reserved.has(id))invalid('Reused or unreserved addition');seen.add(id)
        }else{
          const ref=entryRef(operation.ref);if(!slots.has(ref.sourceKey))invalid('Unknown operation slot')
          applyScopedOperations([{id:ref.entryId,ref,content:''}],[operation],{allowFacts:true})
        }
      }
    }
    if(record.initialization){exact(record.initialization,['launchId','fingerprint','result']);exact(record.initialization.result,['revision','factEntryRefs']);if(!text(record.initialization.launchId)||!digest(record.initialization.fingerprint)||!positive(record.initialization.result.revision)||fingerprint(record.initialization.result.factEntryRefs)!==fingerprint(record.binding.factEntryRefs))invalid('Invalid initialization journal');validateFactState(record.baseline,record.binding.factEntryRefs)}
    else if(record.binding.factEntryRefs.length)invalid('Fact registry has no initialization')
    record.receipts??=[];if(!Array.isArray(record.receipts))invalid('Invalid receipts');unique(record.receipts.map(item=>item.receipt?.id),'receipt IDs')
    validateReviewStructure(record,ids)
    const protectedKeys=new Set(record.binding.factEntryRefs.map(entryKey))
    for(const change of record.changes){
      const operations=change.operations.filter(operation=>operation.op!=='add'&&protectedKeys.has(entryKey(operation.ref)))
      // Content patches replace the full JSON value. Check each atomic batch against the seed;
      // do not flatten changes from distinct causal branches during structural preflight.
      if(operations.length)validateFactState(applyScopedOperations(record.baseline,operations,{allowFacts:true}).entries,record.binding.factEntryRefs)
    }
    for(const item of record.receipts){
      exact(item,['receipt','fingerprint']);const r=item.receipt
      exact(r,['schemaVersion','id','sessionId','turnKey','source','kind','databaseRevision','changeId','stateRefs','summary','packet','openingText','createdAt','factRoundId','factRevision','candidateId','supersedesFactReceiptId','decisionSource'])
      const change=r.changeId===null?undefined:record.changes.find(change=>change.id===r.changeId)
      if(r.schemaVersion!==1||!ids.includes(r.sessionId)||!positive(r.databaseRevision)||r.changeId!==null&&!change||!text(r.createdAt)||!Number.isFinite(Date.parse(r.createdAt))||!Array.isArray(r.stateRefs)||change&&change.anchor!==r.source?.assistantMessageId)invalid('Invalid fact receipt')
      const originChange=p.sessions.find(value=>value.id===r.sessionId)?.changes?.find(value=>value.id===r.changeId)??change
      if(change&&originChange!==change&&fingerprint(change.operations)!==fingerprint(originChange.operations)&&fingerprint(change.operations)!==fingerprint(originChange.operations.filter(operation=>operation.op!=='note')))invalid('Inherited receipt operations differ from the original causal change')
      const round=r.factRoundId?validateReviewReceipt(record,r,change,originChange):undefined
      if(!round&&['factRevision','candidateId','supersedesFactReceiptId','decisionSource'].some(field=>r[field]!==undefined))invalid('Fact revision metadata has no captured round')
      const commit=factCommit({turnKey:r.turnKey,source:r.source,expectedRevision:0,operations:originChange?.operations??[],summary:r.summary,packet:r.packet,kind:r.kind,...round?{capture:round.capture}:{},...r.openingText===undefined?{}:{openingText:r.openingText}},r.sessionId),{expectedRevision:_revision,...content}=commit
      if(!digest(item.fingerprint)||item.fingerprint!==fingerprint(content))invalid('Receipt input fingerprint differs')
      unique(r.stateRefs.map(ref=>{const{version,...entry}=ref;if(!positive(version))invalid('Invalid state version');return entryKey(entry)}),'receipt state refs')
    }
    for(const change of record.changes)if(change.operations.some(operation=>operation.op!=='add'&&protectedKeys.has(entryKey(operation.ref)))&&!record.receipts.some(item=>item.receipt.changeId===change.id))invalid('Protected fact change has no canonical receipt')
  }
  return state
}

/** Actual destination histories are supplied by the authenticated owner reader, never caller JSON. */
export function validateCanonicalState(state,views){
  for(const record of state.payload.sessions){
    const view=views.get(record.id);if(!view)requireContent('Destination canonical Session is missing')
    const assistants=new Map(view.events.filter(event=>event.type==='assistant/message').map(event=>[event.data?.message?.id,event])),all={...view,activeAnchors:[...assistants.keys()]}
    for(const change of record.changes)if(!assistants.has(change.anchor))invalid('Causal anchor does not exist in the canonical destination')
    for(const note of record.baselineNotes)if(!assistants.has(note.anchor))invalid('Note anchor does not exist in the canonical destination')
    function projected(through,limit=record.changes.length){
      const prefix=projectSession({header:view.header,records:view.events.filter(event=>event.seq<=through)}),active=new Set(prefix.activeAnchors);let entries=record.baseline
      for(const change of record.changes.slice(0,limit))if(active.has(change.anchor)&&changeVisible(record,change,prefix)){
        entries=applyScopedOperations(entries,change.operations,{allowFacts:true,additionSourceKey:change.additionSourceKey??'@session'}).entries
        validateFactState(entries,record.binding.factEntryRefs)
      }
      return entries
    }
    try{
      record.changes.forEach((change,index)=>projected(change.decisionSource?.doneSeq??assistants.get(change.anchor).seq,index+1))
      for(const item of record.receipts){
        const r=item.receipt;activeFactSource(all,r.source,r.factRoundId?'review':r.kind)
        let owner=record.id;const visited=new Set()
        while(owner!==r.sessionId&&!visited.has(owner)){visited.add(owner);owner=views.get(owner)?.header?.parentSession;if(!owner)break}
        if(owner!==r.sessionId)invalid('Receipt origin is not this story or its canonical ancestor')
        const entries=projected(r.decisionSource?.doneSeq??(r.factRoundId?r.source.callSeq:assistants.get(r.source.assistantMessageId).seq)),expected=record.binding.factEntryRefs.map(ref=>({ ...ref,version:entries.find(entry=>entryKey(entry.ref)===entryKey(ref))?.version }))
        if(fingerprint(expected)!==fingerprint(r.stateRefs))invalid('Receipt state refs do not match the causal prefix')
      }
      validateReviewCanonical(record,all,{projected,views,records:new Map(state.payload.sessions.map(record=>[record.id,record]))})
    }catch(error){if(error?.code==='RESTORE_REQUIREMENT_MISSING')throw error;invalid('Canonical causal or factual evidence is invalid')}
  }
}

export function restoreConflicts(destination,state,ids,{allowOwned=false}={}){
  const conflicts=[]
  if(!allowOwned)for(const id of ids)if(Object.values(destination.restoreJobs??{}).some(job=>job.result.restoredSessionIds.includes(id)))conflicts.push({code:'RESTORE_ID_CONFLICT',id})
  for(const record of state.payload.sessions)if(destination.sessions[key(record.id)]&&!allowOwned)conflicts.push({code:'RESTORE_ID_CONFLICT',id:record.id})
  for(const source of state.payload.sources){const old=destination.sources[key(source.id)];if(old&&fingerprint(old)!==fingerprint(source))conflicts.push({code:'RESTORE_CONTENT_CONFLICT',id:source.id})}
  for(const record of state.payload.databases)for(const item of record.versions){const old=destination.databases[key(record.id)]?.versions.find(value=>value.database.version===item.database.version);if(old&&fingerprint(old)!==fingerprint(item))conflicts.push({code:'RESTORE_CONTENT_CONFLICT',id:record.id})}
  for(const record of state.payload.documents)for(const item of record.versions){const old=destination.documents?.[key(record.id)]?.versions.find(value=>value.document.version===item.document.version);if(old&&fingerprint(old)!==fingerprint(item))conflicts.push({code:'RESTORE_CONTENT_CONFLICT',id:record.id})}
  return [...new Map(conflicts.map(item=>[JSON.stringify([item.code,item.id]),item])).values()]
}
