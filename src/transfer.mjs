import {createHash} from 'node:crypto'
import {DatabaseError,validateDatabase} from './core.mjs'
import {documentContent,validateChunkReferences} from './document-types.mjs'

export const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const fail=message=>{throw new DatabaseError('INVALID_CONTENT',message)}
export function sourcePayload(value){
  if(!object(value)||Object.keys(value).some(key=>!['format','rawText','dataBase64','sha256','provenance'].includes(key))||typeof value.format!=='string'||!value.format.trim()||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))fail('Invalid source payload')
  if(value.rawText!==undefined&&typeof value.rawText!=='string'||value.provenance!==undefined&&!object(value.provenance))fail('Invalid source provenance')
  let bytes
  if(value.dataBase64!==undefined){
    if(typeof value.dataBase64!=='string'||value.dataBase64.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.dataBase64))fail('Invalid source bytes')
    bytes=Buffer.from(value.dataBase64,'base64')
  }
  if(value.rawText!==undefined){const text=Buffer.from(value.rawText,'utf8');if(bytes&&!bytes.equals(text))fail('Source text and bytes differ');bytes=text}
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==value.sha256)fail('Source hash does not match its original content')
  return structuredClone(value)
}
export function publicSource(source){
  if(!source)return undefined
  return sourcePayload(Object.fromEntries(['format','rawText','dataBase64','sha256','provenance'].filter(key=>source[key]!==undefined).map(key=>[key,source[key]])))
}
export function contentPayload(input){
  let database
  try{database=validateDatabase(input.database)}catch{fail('Invalid database content')}
  if(input.documents!==undefined&&!Array.isArray(input.documents))fail('documents must be an array')
  const documents=(input.documents??[]).map(value=>documentContent(value,'INVALID_CONTENT')),used=new Set()
  for(const value of documents){const key=JSON.stringify([value.document.id,value.document.version]);if(used.has(key))fail('Duplicate document content');used.add(key)}
  validateChunkReferences(database.entries,documents)
  return{database,...input.source===undefined?{}:{source:sourcePayload(input.source)},...documents.length?{documents}:{}}
}
