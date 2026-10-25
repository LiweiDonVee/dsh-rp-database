import {textHash} from './documents.mjs'
import {retrievalDocument,validateVectors} from './retrieval.mjs'

const valid=(vector,dimension)=>Array.isArray(vector)&&vector.length===dimension&&vector.every(value=>typeof value==='number'&&Number.isFinite(value))
const cacheHash=(text,provenance)=>textHash(JSON.stringify([textHash(text),provenance?.extractionVersion??'entry-text-v1',provenance?.chunkingVersion??'entry-single-v1']))
export function createVectorIndex({store,embed,config,onChange=()=>{}}){
  const identity=config&&embed?{provider:new URL(config.baseURL).href.replace(/\/+$/,''),model:config.model,policy:'retrieval-fields-v2'}:null
  async function failure(error,signal){
    if(signal?.aborted||error?.name==='AbortError')throw error
    await store.cacheWrite(identity,undefined,[],'EMBEDDING_FAILED');onChange();throw error
  }
  async function ensure(texts,signal,requiredDimension,provenance=[]){
    signal?.throwIfAborted()
    const unique=new Map(texts.map((text,index)=>[cacheHash(text,provenance[index]),text])),hashes=[...unique.keys()],cached=await store.cacheRead(identity,requiredDimension,hashes)
    let dimension=requiredDimension??cached.dimension
    const values=new Map(hashes.filter(hash=>valid(cached.vectors[hash],dimension)).map(hash=>[hash,cached.vectors[hash]]))
    const missing=hashes.filter(hash=>!values.has(hash));let indexed=0
    if(missing.length){
      const vectors=validateVectors(await embed(missing.map(hash=>unique.get(hash)),signal),missing.length),actual=vectors[0].length
      if(requiredDimension!==undefined&&actual!==requiredDimension)throw Error('Embedding dimensions changed inside one request')
      if(dimension!==actual){dimension=actual;values.clear()}
      missing.forEach((hash,index)=>values.set(hash,vectors[index]));indexed+=missing.length
      const other=hashes.filter(hash=>!values.has(hash))
      if(other.length){const more=validateVectors(await embed(other.map(hash=>unique.get(hash)),signal),other.length);if(more[0].length!==dimension)throw Error('Inconsistent embedding dimensions');other.forEach((hash,index)=>values.set(hash,more[index]));indexed+=other.length}
    }
    signal?.throwIfAborted()
    if(dimension!==undefined){await store.cacheWrite(identity,dimension,[...values].map(([hash,vector])=>({hash,vector})));onChange()}
    return{vectors:texts.map((text,index)=>values.get(cacheHash(text,provenance[index]))),indexedChunks:indexed,skippedChunks:texts.length-indexed}
  }
  return{
    embedEntries:identity?async({query,documents,entries,signal})=>{try{const vector=validateVectors(await embed([query],signal),1)[0],indexed=await ensure(documents,signal,vector.length,entries.map(entry=>entry.provenance));return[vector,...indexed.vectors]}catch(error){return failure(error,signal)}}:undefined,
    async state(signal){
      signal?.throwIfAborted();const entries=await store.indexEntries(),hashes=entries.map(entry=>cacheHash(retrievalDocument(entry),entry.provenance))
      if(!identity)return{readyChunks:0,staleChunks:entries.length,lastErrorCode:embed?'EMBEDDING_IDENTITY_REQUIRED':'EMBEDDING_UNCONFIGURED'}
      const cached=await store.cacheRead(identity,undefined,hashes),readyChunks=hashes.filter(hash=>valid(cached.vectors[hash],cached.dimension)).length
      return{model:config.model,readyChunks,staleChunks:entries.length-readyChunks,...cached.lastErrorCode?{lastErrorCode:cached.lastErrorCode}:{}}
    },
    async rebuild({databaseIds,signal}={}){
      const entries=await store.indexEntries(databaseIds)
      if(!identity)return{indexedChunks:0,skippedChunks:entries.length,diagnostics:[{code:embed?'EMBEDDING_IDENTITY_REQUIRED':'EMBEDDING_UNCONFIGURED',message:'需明确配置 embedding 提供方与模型后重建。'}]}
      try{const result=await ensure(entries.map(retrievalDocument),signal,undefined,entries.map(entry=>entry.provenance));return{indexedChunks:result.indexedChunks,skippedChunks:result.skippedChunks,diagnostics:[]}}catch(error){try{await failure(error,signal)}catch(failure){if(signal?.aborted||failure?.name==='AbortError')throw failure}return{indexedChunks:0,skippedChunks:entries.length,diagnostics:[{code:'EMBEDDING_FAILED',message:'向量索引重建失败；可继续使用关键词检索。'}]}}
    },
  }
}
