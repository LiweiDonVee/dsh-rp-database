import {homedir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseError,applyOperations,selectEntries} from './core.mjs'
import {createDatabaseStore} from './store.mjs'
import {createRetriever,createHttpRetrieval} from './retrieval.mjs'
import {projectSession,createOwnerReader} from './session.mjs'
import {registerDatabaseTools} from './agent.mjs'
import {createDatabaseRoutes} from './routes.mjs'
import {applyScopedOperations,entryKey,entryRef,parseEntryKey,plannerOperations,selectScopedEntries} from './references.mjs'
import {activeFactSource,factCommit} from './facts.mjs'
import {extractText} from './documents.mjs'
import {createVectorIndex} from './index-store.mjs'
import {restoreEnvelope,restoreTransport,sessionIds,validateCanonicalState} from './state-transfer.mjs'

export const name='rp-database'
export const inject=['connection','typertGateway','agents','tools','systemPrompt']
const meta=entry=>Object.fromEntries(['id','title','keywords','tags','notes','readOnly','mode','version'].map(key=>[key,entry[key]]))
const metaV2=entry=>({...meta(entry),ref:entry.ref,...entry.sourceVersion===undefined?{}:{sourceVersion:entry.sourceVersion},...entry.provenance?{provenance:entry.provenance}:{}})
function owner(input){if(Object.hasOwn(input,'agent'))throw new DatabaseError('OWNER_REQUIRED','Only the owner may bind or initialize a story',403)}
function enabled(value){
  const entries=value.entries.filter(entry=>entry.mode!=='disabled'),allowed=new Set(entries.map(entry=>entryKey(entry.ref)))
  return{...value,entries,notes:value.notes.filter(note=>allowed.has(entryKey(note.ref))),changes:value.changes.filter(change=>change.operations.every(operation=>operation.op==='add'?operation.entry.mode!=='disabled':allowed.has(entryKey(operation.ref))))}
}

/** Standalone database owner, scoped Agent tools and optional retrieval providers. */
export async function createDatabaseHost(ctx,options={}){
  const store=options.store??createDatabaseStore({directory:options.directory??join(process.env.DSH_HOME??join(homedir(),'.dsh'),'app-data','rp-database')})
  const configured=createHttpRetrieval({embedding:options.embedding,reranking:options.reranking,fetch:options.fetch})
  const index=createVectorIndex({store,embed:options.providers?.embed??configured.embed,config:options.embedding,onChange:()=>changed()})
  const retriever=options.retriever??createRetriever({...configured,...options.providers,...index.embedEntries?{embedEntries:index.embedEntries}:{}})
  const readOwner=createOwnerReader(ctx),bindings=new Map(),subscribers=new Map(),operations=new Set(),forking=new Map()
  let stopped=false,adapter,unsubscribeSource,inheritance=Promise.resolve()
  async function sync(){bindings.clear();for(const item of await store.bindingsV2())bindings.set(item.sessionId,item);adapter?.sync()}
  await sync()
  async function run(signal,work){
    if(stopped)throw new DatabaseError('UNAVAILABLE','Database plugin has been unloaded',503)
    const life=new AbortController();operations.add(life);const combined=signal?AbortSignal.any([signal,life.signal]):life.signal
    try{combined.throwIfAborted();return await work(combined)}finally{operations.delete(life)}
  }
  function changed(id){for(const [sessionId,listeners]of subscribers)if(!id||sessionId===id)for(const listener of listeners){try{listener({type:'changed',sessionId})}catch{/* An observer cannot reject a committed change. */}}}
  function liveView(agent){
    if(ctx.agents.get(agent.session.id)!==agent)throw new DatabaseError('AGENT_MISMATCH','The caller does not own this story',403)
    if(typeof agent.session.snapshotEvents!=='function')throw new DatabaseError('SESSION_UNAVAILABLE','Canonical session history is unavailable',503)
    return projectSession({header:agent.session.header??{id:agent.session.id},records:agent.session.snapshotEvents()})
  }
  async function scope(input,signal){
    if(input.agent&&input.agent.session.id!==input.sessionId)throw new DatabaseError('AGENT_MISMATCH','The caller does not own this story',403)
    return input.agent?liveView(input.agent):readOwner(input.sessionId,signal)
  }
  async function ensure(view){
    if(bindings.has(view.sessionId))return
    if(!view.parentSession||!bindings.has(view.parentSession))return
    if(forking.has(view.sessionId))return forking.get(view.sessionId)
    const promise=inheritance.then(async()=>{
      if(bindings.has(view.sessionId))return
      const snapshot=await store.snapshot()
      try{await store.forkSession(view.parentSession,view.sessionId,{activeAnchors:view.activeAnchors,expectedRevision:snapshot.revision})}
      catch(error){if(error.code!=='SESSION_EXISTS')throw error}
      await sync();changed(view.sessionId)
    })
    inheritance=promise.catch(()=>{})
    forking.set(view.sessionId,promise)
    try{await promise}finally{forking.delete(view.sessionId)}
  }
  async function current(input,signal){
    const view=await scope(input,signal);await ensure(view)
    if(!bindings.has(view.sessionId))throw new DatabaseError('NOT_BOUND','Bind a database to this story first',409)
    return{view,value:await store.session(view.sessionId,{activeAnchors:view.activeAnchors,...view.currentAnchor?{currentAnchor:view.currentAnchor}:{}})}
  }
  async function currentV2(input,signal){
    const view=await scope(input,signal);await ensure(view)
    if(!bindings.has(view.sessionId))throw new DatabaseError('NOT_BOUND','Bind sources to this story first',409)
    return{view,value:await store.sessionV2(view.sessionId,{activeAnchors:view.activeAnchors,...view.currentAnchor?{currentAnchor:view.currentAnchor}:{}})}
  }
  async function qualifiedSearch(input,signal){
    const{value}=await currentV2(input,signal),indexed=value.entries.map(entry=>({...entry,id:entryKey(entry.ref)}))
    const result=await retriever.search({entries:indexed,query:input.query,limit:input.limit??12,signal})
    return{revision:value.revision,candidates:result.candidates.map(({id,...candidate})=>({...candidate,ref:parseEntryKey(id)})),required:result.required.map(parseEntryKey),degraded:result.degraded}
  }
  async function genericCommit(input,signal){
    const{view}=await currentV2(input,signal)
    if(!view.currentAnchor)throw new DatabaseError('ANCHOR_REQUIRED','Story edits require a current Agent turn',409)
    const result=await store.applyOperationsV2(input.sessionId,input.operations,{expectedRevision:input.expectedRevision,anchor:view.currentAnchor,activeAnchors:view.activeAnchors,currentAnchor:view.currentAnchor})
    changed(input.sessionId);return input.agent?{...result,session:enabled(result.session),entries:result.entries.filter(entry=>entry.mode!=='disabled')}:result
  }
  async function receiptFor(input,selector,signal){
    const{view}=await currentV2(input,signal),receipt=await store.receipt(input.sessionId,selector,{activeAnchors:view.activeAnchors})
    if(receipt)activeFactSource(view,receipt.source,receipt.kind)
    return receipt
  }
  const service={
    apiVersion:2,
    contentRevision:(input={})=>run(input.signal,()=>store.contentRevision()),
    exportContent:input=>run(input.signal,()=>{owner(input);return store.exportContent(input)}),
    importContent:input=>run(input.signal,async()=>{owner(input);const result=await store.importContent(input);await sync();changed();return result}),
    importDocument:input=>run(input.signal,async signal=>{owner(input);const extracted=await extractText({...input,signal}),result=await store.importDocument(input,extracted);await sync();changed();return result}),
    document:input=>run(input.signal,()=>{owner(input);return store.document(input)}),
    indexState:(input={})=>run(input.signal,signal=>{owner(input);return index.state(signal)}),
    rebuildIndex:(input={})=>run(input.signal,signal=>{owner(input);return index.rebuild({...input,signal})}),
    exportState:input=>run(input.signal,async signal=>{
      owner(input);const ids=sessionIds(input.sessionIds),views=new Map()
      // Reject missing passive dependencies before export can materialize a cold child's inheritance.
      if(input.additionalDatabaseRefs!==undefined)await store.exportState({sessionIds:[],additionalDatabaseRefs:input.additionalDatabaseRefs})
      for(const id of ids){const view=await readOwner(id,signal);await ensure(view);views.set(id,view)}
      const exported=restoreEnvelope(await store.exportState({sessionIds:ids,additionalDatabaseRefs:input.additionalDatabaseRefs}),ids);validateCanonicalState(exported,views);return exported
    }),
    preflightRestore:input=>run(input.signal,()=>{owner(input);return store.preflightRestore(input)}),
    restoreState:(input={})=>run(input.signal,async signal=>{
      owner(input)
      const ids=restoreTransport(input),request={...input,sessionIds:ids},replayed=await store.restoreReplay(request)
      if(replayed)return replayed
      restoreEnvelope(input.state,ids)
      const preflight=await store.preflightRestore(request)
      if(!preflight.supported)throw new DatabaseError(preflight.conflicts[0]?.code??'RESTORE_PAYLOAD_INVALID','Database restore preflight failed',409)
      if((await store.contentRevision()).revision!==input.expectedRevision)throw new DatabaseError('REVISION_CONFLICT','Database state changed; reload before restoring',409)
      const views=new Map()
      for(const id of ids){try{views.set(id,await readOwner(id,signal))}catch(error){if(error.code==='FORBIDDEN')throw error;throw new DatabaseError('RESTORE_REQUIREMENT_MISSING','Import and cold-validate the exact destination canonical Sessions before Database restore',409)}}
      const result=await store.restoreState(request,views);await sync();changed();return result
    }),
    hasBinding:id=>!stopped&&bindings.has(id),
    ensureAgent:agent=>run(undefined,async()=>ensure(liveView(agent))),
    async state(input={}){return run(input.signal,async signal=>{
      let binding=null
      if(input.sessionId){const view=await scope(input,signal);await ensure(view);if(bindings.has(view.sessionId)){
        const options={activeAnchors:view.activeAnchors,...view.currentAnchor?{currentAnchor:view.currentAnchor}:{}}
        try{binding=await store.session(view.sessionId,options)}catch(error){if(error.code!=='QUALIFIED_REFERENCE_REQUIRED')throw error;binding=await store.sessionV2(view.sessionId,options)}
      }}
      return{...await store.snapshot(),binding,capabilities:{documents:true,index:true,contentTransfer:true,stateTransfer:true},retrieval:{embedding:{configured:!!(configured.embed??options.providers?.embed),model:options.embedding?.model??null},reranking:{configured:!!(configured.rerank??options.providers?.rerank),model:options.reranking?.model??null}}}
    })},
    database:input=>run(input.signal,async()=>{
      const snapshot=await store.snapshot(),database=await store.database(input.databaseId,input.version),sourceId=snapshot.databases.find(item=>item.id===database.id)?.sourceId
      const source=sourceId?await store.source(sourceId):null
      return{revision:snapshot.revision,database,...source?.importReport?{importReport:source.importReport}:{}}
    }),
    source:input=>run(input.signal,async()=>({source:await store.source(input.sourceId)})),
    create:input=>run(input.signal,async()=>{const result=await store.saveDatabase({id:randomUUID(),name:input.name,version:1,entries:[]},{expectedRevision:input.expectedRevision});await sync();changed();return result}),
    import:input=>run(input.signal,async()=>{const result=await store.importSource(input.rawText,input);await sync();changed();return result}),
    save:input=>run(input.signal,async()=>{const result=await store.saveDatabase(input.database,{expectedRevision:input.expectedRevision});await sync();changed();return result}),
    bind:input=>run(input.signal,async signal=>{owner(input);await scope(input,signal);const result=await store.bindSession(input.sessionId,input);await sync();changed(input.sessionId);return result}),
    bindSources:input=>run(input.signal,async signal=>{owner(input);await scope(input,signal);const result=await store.bindSources(input.sessionId,input);await sync();changed(input.sessionId);return result}),
    effectiveV2:input=>run(input.signal,async signal=>{const{value}=await currentV2(input,signal);return input.agent?enabled(value):value}),
    catalogV2:input=>run(input.signal,async signal=>{const{value}=await currentV2(input,signal);return{revision:value.revision,binding:value.binding,entries:value.entries.filter(entry=>entry.mode!=='disabled').map(metaV2),notes:enabled(value).notes}}),
    readV2:input=>run(input.signal,async signal=>{
      if(!Array.isArray(input.refs))throw new DatabaseError('INVALID_REFERENCE','refs must be an array')
      const refs=input.refs.map(entryRef),{value}=await currentV2(input,signal),byKey=new Map(value.entries.map(entry=>[entryKey(entry.ref),entry]))
      const entries=[...new Set(refs.map(entryKey))].map(key=>{const entry=byKey.get(key);if(!entry)throw new DatabaseError('ENTRY_NOT_FOUND','Entry is unavailable',404);if(entry.mode==='disabled')throw new DatabaseError('ENTRY_DISABLED','Entry is disabled',403);return entry})
      return{revision:value.revision,entries}
    }),
    searchV2:input=>run(input.signal,signal=>qualifiedSearch(input,signal)),
    patchV2:input=>run(input.signal,signal=>genericCommit(input,signal)),
    initializeStoryState:input=>run(input.signal,async signal=>{owner(input);await scope(input,signal);const result=await store.initializeStoryState(input.sessionId,input);await sync();changed(input.sessionId);return result}),
    factAccess:input=>run(input.signal,async signal=>{
      if(!input.agent)throw new DatabaseError('AGENT_REQUIRED','Fact access requires the live story Agent',403)
      await currentV2(input,signal)
      const bound={sessionId:input.sessionId,agent:input.agent}
      return Object.freeze({
        snapshot:()=>run(input.signal,async signal=>enabled((await currentV2(bound,signal)).value)),
        commit:value=>run(input.signal,async signal=>{
          const normalized=factCommit(value,bound.sessionId),{view}=await currentV2(bound,signal)
          normalized.source=activeFactSource(view,normalized.source,normalized.kind)
          const receipt=await store.commitFacts(bound.sessionId,normalized,{activeAnchors:view.activeAnchors,currentAnchor:view.currentAnchor})
          changed(bound.sessionId);return receipt
        }),
        getReceipt:id=>run(input.signal,signal=>receiptFor(bound,{id},signal)),
        currentReceipt:turnKey=>run(input.signal,signal=>receiptFor(bound,{turnKey},signal)),
      })
    }),
    materialAccess:input=>run(input.signal,async signal=>{
      await currentV2(input,signal)
      const bound={sessionId:input.sessionId,...input.agent?{agent:input.agent}:{}}
      return Object.freeze({
        version:2,
        snapshot:()=>run(input.signal,async signal=>enabled((await currentV2(bound,signal)).value)),
        search:args=>run(args.signal??input.signal,async signal=>{
          const result=await qualifiedSearch({...bound,query:args.query,limit:args.limit},signal)
          return{...result,candidates:result.candidates.map(candidate=>({...candidate,key:entryKey(candidate.ref)})),required:result.required.map(ref=>({key:entryKey(ref),ref}))}
        }),
        apply:(entries,operations)=>{
          const current=bindings.get(bound.sessionId)
          if(stopped||!current)throw new DatabaseError('UNAVAILABLE','The material binding is no longer available',503)
          return applyScopedOperations(entries,plannerOperations(operations),{factEntryRefs:current.binding.factEntryRefs})
        },
        select:(entries,keys)=>{if(!Array.isArray(keys))throw new DatabaseError('INVALID_REFERENCE','Selected entryKeys must be an array');return selectScopedEntries(entries,keys.map(parseEntryKey))},
        commit:args=>run(args.signal??input.signal,signal=>genericCommit({...bound,operations:plannerOperations(args.operations),expectedRevision:args.expectedRevision},signal)),
      })
    }),
    effective:input=>run(input.signal,async signal=>(await current(input,signal)).value),
    catalog:input=>run(input.signal,async signal=>{const {value}=await current(input,signal);return{revision:value.revision,databaseId:value.databaseId,version:value.version,entries:value.entries.filter(entry=>entry.mode!=='disabled').map(meta),notes:value.notes}}),
    read:input=>run(input.signal,async signal=>{
      if(!Array.isArray(input.entryIds)||input.entryIds.some(id=>typeof id!=='string'))throw new DatabaseError('INVALID_OPERATION','Entry IDs must be strings')
      const {value}=await current(input,signal)
      const entries=[...new Set(input.entryIds)].map(id=>{const entry=value.entries.find(entry=>entry.id===id);if(!entry)throw new DatabaseError('ENTRY_NOT_FOUND','Entry is unavailable',404);if(entry.mode==='disabled')throw new DatabaseError('ENTRY_DISABLED','Entry is disabled',403);return entry})
      return{revision:value.revision,entries}
    }),
    search:input=>run(input.signal,async signal=>{const {value}=await current(input,signal);return{revision:value.revision,...await retriever.search({entries:value.entries,query:input.query,limit:input.limit??12,signal})}}),
    patch:input=>run(input.signal,async signal=>{
      const {view}=await current(input,signal)
      if(!view.currentAnchor)throw new DatabaseError('ANCHOR_REQUIRED','Story edits require a current Agent turn',409)
      const result=await store.applyOperations(input.sessionId,input.operations,{expectedRevision:input.expectedRevision,anchor:view.currentAnchor,activeAnchors:view.activeAnchors,currentAnchor:view.currentAnchor})
      changed(input.sessionId);return result
    }),
    applyToSnapshot:applyOperations,
    selectFromSnapshot:selectEntries,
    authorize:(id,signal)=>run(signal,combined=>readOwner(id,combined)),
    subscribe(id,listener){const set=subscribers.get(id)??new Set();set.add(listener);subscribers.set(id,set);return()=>{set.delete(listener);if(!set.size)subscribers.delete(id)}},
    async close(){if(stopped)return;stopped=true;unsubscribeSource?.();for(const life of operations)life.abort();adapter?.();subscribers.clear();bindings.clear()},
  }
  adapter=registerDatabaseTools(ctx,service)
  unsubscribeSource=ctx.on('session/event',(session,event)=>{if(['user/message','assistant/message','tool/result','turn/end'].includes(event.type))changed(session.id)})
  return service
}

export async function apply(ctx,config={}){
  const service=await createDatabaseHost(ctx,config),routes=createDatabaseRoutes(service)
  ctx.provide('rpDatabase',service)
  const unregister=[ctx.connection.fetch.register({path:'/api/rp-database/request',methods:['POST'],requestBody:'buffered',fetch:request=>routes.request(request)}),ctx.connection.fetch.register({path:'/api/rp-database/events',methods:['GET'],requestBody:'buffered',fetch:request=>routes.events(request)})]
  ctx.effect(()=>async()=>{routes.close();await service.close();for(const dispose of unregister)dispose()},'RP database runtime')
}
