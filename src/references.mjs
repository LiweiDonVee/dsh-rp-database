import {DatabaseError,applyOperations,selectEntries,validateDatabase} from './core.mjs'

const fail=(code,message)=>{throw new DatabaseError(code,message)}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const nonempty=value=>typeof value==='string'&&value.trim().length>0
const positive=value=>Number.isSafeInteger(value)&&value>0

export function entryRef(value){
  if(!object(value)||Object.keys(value).some(key=>!['sourceKey','entryId'].includes(key))||!nonempty(value.sourceKey)||!nonempty(value.entryId))fail('INVALID_REFERENCE','A sourceKey and entryId are required')
  return{sourceKey:value.sourceKey,entryId:value.entryId}
}
export const entryKey=value=>{const ref=entryRef(value);return JSON.stringify([ref.sourceKey,ref.entryId])}
export function parseEntryKey(value){
  let parts
  try{parts=JSON.parse(value)}catch{fail('INVALID_REFERENCE','Use an entryKey returned by the catalog')}
  if(typeof value!=='string'||!Array.isArray(parts)||parts.length!==2)fail('INVALID_REFERENCE','Use an entryKey returned by the catalog')
  return entryRef({sourceKey:parts[0],entryId:parts[1]})
}
export function sourceBindings(value){
  if(!Array.isArray(value))fail('INVALID_BINDING','Sources must be an ordered list')
  const used=new Set()
  return value.map(source=>{
    if(!object(source)||Object.keys(source).some(key=>!['key','databaseId','version'].includes(key))||!nonempty(source.key)||source.key==='@session'||!nonempty(source.databaseId)||!positive(source.version)||used.has(source.key))fail('INVALID_BINDING','Source slots require unique non-reserved keys and explicit versions')
    used.add(source.key);return{key:source.key,databaseId:source.databaseId,version:source.version}
  })
}
export function entryViews(entries){
  if(!Array.isArray(entries))fail('INVALID_DATA','Entries must be an array')
  const used=new Set()
  return entries.map(value=>{
    const ref=entryRef(value?.ref),key=entryKey(ref)
    if(used.has(key))fail('DUPLICATE_ID','A qualified entry reference is duplicated')
    used.add(key)
    const entry=validateDatabase({id:'view',name:'View',version:1,entries:[value]}).entries[0]
    if(entry.id!==ref.entryId)fail('INVALID_REFERENCE','Entry ID must match its qualified reference')
    if(value.sourceVersion!==undefined&&!positive(value.sourceVersion))fail('INVALID_REFERENCE','sourceVersion must be a positive integer')
    return{...entry,ref,...value.sourceVersion===undefined?{}:{sourceVersion:value.sourceVersion}}
  })
}
const indexed=entries=>entries.map(value=>({...value,id:entryKey(value.ref)}))

/** Validate one atomic qualified batch; source/owner are trusted options, never operation fields. */
export function applyScopedOperations(entries,operations,{factEntryRefs=[],allowFacts=false,additionSourceKey='@session'}={}){
  const original=entryViews(entries),prior=new Map(original.map(value=>[entryKey(value.ref),value]))
  if(!Array.isArray(operations))fail('INVALID_OPERATION','Operations must be an array')
  const protectedKeys=new Set(factEntryRefs.map(entryKey))
  const translated=operations.map(operation=>{
    if(!object(operation))fail('INVALID_OPERATION','Operation must be an object')
    const allowed=operation.op==='add'?['op','entry']:operation.op==='update'?['op','ref','patch']:operation.op==='note'?['op','ref','text']:['op','ref']
    if(Object.keys(operation).some(key=>!allowed.includes(key)))fail('INVALID_OPERATION','Unexpected qualified operation fields')
    if(operation.op==='add')return{op:'add',entry:{...operation.entry,id:entryKey({sourceKey:additionSourceKey,entryId:operation.entry?.id})}}
    const key=entryKey(operation.ref)
    if(protectedKeys.has(key)&&!allowFacts)throw new DatabaseError('FACT_OWNER_REQUIRED','Only the fact stage may modify a registered fact entry',403)
    const {ref:_ref,...rest}=operation
    return{...rest,id:key}
  })
  const result=applyOperations(indexed(original),translated)
  return{entries:result.entries.map(value=>{
    const ref=parseEntryKey(value.id),old=prior.get(value.id)
    return{...value,id:ref.entryId,ref,...old?.sourceVersion===undefined?{}:{sourceVersion:old.sourceVersion}}
  }),notes:result.notes.map(note=>({ref:parseEntryKey(note.id),text:note.text}))}
}
export function selectScopedEntries(entries,refs){
  const original=entryViews(entries),byKey=new Map(original.map(value=>[entryKey(value.ref),value]))
  if(!Array.isArray(refs))fail('INVALID_REFERENCE','Selected references must be an array')
  return selectEntries(indexed(original),refs.map(entryKey)).map(value=>structuredClone(byKey.get(value.id)))
}
export function plannerOperations(operations){
  if(!Array.isArray(operations))fail('INVALID_OPERATION','Operations must be an array')
  return operations.map(operation=>{
    if(!object(operation))fail('INVALID_OPERATION','Operation must be an object')
    if(operation.op==='add')return operation
    if(Object.hasOwn(operation,'ref'))fail('INVALID_OPERATION','Planner selectors must be entryKeys')
    const{id,...rest}=operation
    return{...rest,ref:parseEntryKey(id)}
  })
}
export function legacySnapshot(value){
  const used=new Set()
  if(value.binding.sources.length>1)throw new DatabaseError('QUALIFIED_REFERENCE_REQUIRED','Use the v2 qualified database API',409)
  for(const entry of value.entries){if(used.has(entry.id))throw new DatabaseError('QUALIFIED_REFERENCE_REQUIRED','Use the v2 qualified database API',409);used.add(entry.id)}
  const source=value.binding.sources[0]
  const strip=value=>{const{ref:_ref,sourceVersion:_version,...entry}=value;return entry}
  return{databaseId:source?.databaseId,version:source?.version,sourceId:value.sourceId,entries:value.entries.map(strip),notes:value.notes.map(({ref,...note})=>({id:ref.entryId,...note})),changes:value.changes.map(({additionSourceKey:_slot,...change})=>({...change,operations:change.operations.map(operation=>{if(operation.op==='add')return operation;const{ref,...rest}=operation;return{...rest,id:ref.entryId}})})),revision:value.revision}
}
