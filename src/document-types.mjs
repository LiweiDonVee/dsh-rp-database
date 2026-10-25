import {createHash} from 'node:crypto'
import {DatabaseError} from './core.mjs'

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const nonempty=value=>typeof value==='string'&&value.trim().length>0
const positive=value=>Number.isSafeInteger(value)&&value>0
const hash=value=>createHash('sha256').update(value).digest('hex')
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const fail=(code,message)=>{throw new DatabaseError(code,message)}
const exact=(value,fields,code)=>{if(!object(value)||Object.keys(value).some(key=>!fields.includes(key)))fail(code,'Unexpected document fields')}
export function chunkRef(value,code='INVALID_DOCUMENT'){
  exact(value,['documentId','documentVersion','chunkId','page','paragraph'],code)
  if(!nonempty(value.documentId)||!positive(value.documentVersion)||!nonempty(value.chunkId)||value.page!==undefined&&!positive(value.page)||value.paragraph!==undefined&&!positive(value.paragraph))fail(code,'Invalid document chunk reference')
  return structuredClone(value)
}
export function documentProvenance(value){
  const code='INVALID_DATA'
  exact(value,['kind','documentId','documentVersion','chunkId','page','paragraph','extractionVersion','chunkingVersion','textSha256'],code)
  const {kind,extractionVersion,chunkingVersion,textSha256,...ref}=value
  if(kind!=='document-chunk'||!nonempty(extractionVersion)||!nonempty(chunkingVersion)||!sha(textSha256))fail(code,'Invalid document provenance')
  return{...chunkRef(ref,code),kind,extractionVersion,chunkingVersion,textSha256}
}
export function documentContent(value,code='INVALID_DOCUMENT'){
  exact(value,['document','extraction'],code)
  const {document,extraction}=value
  exact(document,['id','version','name','mimeType','sha256','dataBase64','databaseId','extractionVersion','chunkingVersion'],code)
  if(!nonempty(document.id)||!positive(document.version)||!nonempty(document.name)||!nonempty(document.databaseId)||!nonempty(document.extractionVersion)||!nonempty(document.chunkingVersion)||!['text/plain','text/markdown','application/pdf'].includes(document.mimeType)||!sha(document.sha256)||typeof document.dataBase64!=='string'||document.dataBase64.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(document.dataBase64)||hash(Buffer.from(document.dataBase64,'base64'))!==document.sha256)fail(code,'Invalid original document bytes or identity')
  exact(extraction,['text','chunks'],code)
  if(typeof extraction.text!=='string'||!Array.isArray(extraction.chunks))fail(code,'Invalid document extraction')
  const used=new Set()
  for(const chunk of extraction.chunks){
    exact(chunk,['ref','text','sha256'],code);const ref=chunkRef(chunk.ref,code)
    if(ref.documentId!==document.id||ref.documentVersion!==document.version||used.has(ref.chunkId)||typeof chunk.text!=='string'||!chunk.text||!sha(chunk.sha256)||hash(chunk.text)!==chunk.sha256||!extraction.text.includes(chunk.text))fail(code,'Invalid extracted chunk content or identity')
    used.add(ref.chunkId)
  }
  return structuredClone(value)
}
export function validateChunkReferences(entries,documents,code='INVALID_CONTENT'){
  const byId=new Map(documents.map(value=>[JSON.stringify([value.document.id,value.document.version]),value]))
  for(const entry of entries){
    if(!entry.provenance)continue
    const p=documentProvenance(entry.provenance),value=byId.get(JSON.stringify([p.documentId,p.documentVersion])),chunk=value?.extraction.chunks.find(chunk=>chunk.ref.chunkId===p.chunkId)
    if(!chunk||chunk.sha256!==p.textSha256||value.document.extractionVersion!==p.extractionVersion||value.document.chunkingVersion!==p.chunkingVersion||chunk.ref.page!==p.page||chunk.ref.paragraph!==p.paragraph)fail(code,'A referenced document chunk is missing or inconsistent')
  }
}
