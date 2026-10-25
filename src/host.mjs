import {homedir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseError,applyOperations,selectEntries} from './core.mjs'
import {createDatabaseStore} from './store.mjs'
import {createRetriever,createHttpRetrieval} from './retrieval.mjs'
import {projectSession,createOwnerReader} from './session.mjs'
import {registerDatabaseTools} from './agent.mjs'
import {createDatabaseRoutes} from './routes.mjs'

export const name='rp-database'
export const inject=['connection','typertGateway','agents','tools','systemPrompt']
const meta=entry=>Object.fromEntries(['id','title','keywords','tags','notes','readOnly','mode','version'].map(key=>[key,entry[key]]))

/** Standalone database owner, scoped Agent tools and optional retrieval providers. */
export async function createDatabaseHost(ctx,options={}){
  const store=options.store??createDatabaseStore({directory:options.directory??join(process.env.DSH_HOME??join(homedir(),'.dsh'),'app-data','rp-database')})
  const configured=createHttpRetrieval({embedding:options.embedding,reranking:options.reranking,fetch:options.fetch})
  const retriever=options.retriever??createRetriever({...configured,...options.providers})
  const readOwner=createOwnerReader(ctx),bindings=new Map(),subscribers=new Map(),operations=new Set(),forking=new Map()
  let stopped=false,adapter
  async function sync(){bindings.clear();for(const item of await store.bindings())bindings.set(item.sessionId,item);adapter?.sync()}
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
    const promise=(async()=>{
      const snapshot=await store.snapshot()
      try{await store.forkSession(view.parentSession,view.sessionId,{activeAnchors:view.activeAnchors,expectedRevision:snapshot.revision})}
      catch(error){if(error.code!=='SESSION_EXISTS')throw error}
      await sync();changed(view.sessionId)
    })()
    forking.set(view.sessionId,promise)
    try{await promise}finally{forking.delete(view.sessionId)}
  }
  async function current(input,signal){
    const view=await scope(input,signal);await ensure(view)
    if(!bindings.has(view.sessionId))throw new DatabaseError('NOT_BOUND','Bind a database to this story first',409)
    return{view,value:await store.session(view.sessionId,{activeAnchors:view.activeAnchors,...view.currentAnchor?{currentAnchor:view.currentAnchor}:{}})}
  }
  const service={
    hasBinding:id=>!stopped&&bindings.has(id),
    ensureAgent:agent=>run(undefined,async()=>ensure(liveView(agent))),
    async state(input={}){return run(input.signal,async signal=>{
      let binding=null
      if(input.sessionId){const view=await scope(input,signal);await ensure(view);if(bindings.has(view.sessionId))binding=await store.session(view.sessionId,{activeAnchors:view.activeAnchors,...view.currentAnchor?{currentAnchor:view.currentAnchor}:{}})}
      return{...await store.snapshot(),binding,retrieval:{embedding:{configured:!!(configured.embed??options.providers?.embed),model:options.embedding?.model??null},reranking:{configured:!!(configured.rerank??options.providers?.rerank),model:options.reranking?.model??null}}}
    })},
    database:input=>run(input.signal,async()=>({revision:(await store.snapshot()).revision,database:await store.database(input.databaseId,input.version)})),
    source:input=>run(input.signal,async()=>({source:await store.source(input.sourceId)})),
    create:input=>run(input.signal,async()=>{const result=await store.saveDatabase({id:randomUUID(),name:input.name,version:1,entries:[]},{expectedRevision:input.expectedRevision});await sync();changed();return result}),
    import:input=>run(input.signal,async()=>{const result=await store.importSource(input.rawText,input);await sync();changed();return result}),
    save:input=>run(input.signal,async()=>{const result=await store.saveDatabase(input.database,{expectedRevision:input.expectedRevision});await sync();changed();return result}),
    bind:input=>run(input.signal,async signal=>{await scope(input,signal);const result=await store.bindSession(input.sessionId,input);await sync();changed(input.sessionId);return result}),
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
    async close(){if(stopped)return;stopped=true;for(const life of operations)life.abort();adapter?.();subscribers.clear();bindings.clear()},
  }
  adapter=registerDatabaseTools(ctx,service)
  return service
}

export async function apply(ctx,config={}){
  const service=await createDatabaseHost(ctx,config),routes=createDatabaseRoutes(service)
  ctx.provide('rpDatabase',service)
  const unregister=[ctx.connection.fetch.register({path:'/api/rp-database/request',methods:['POST'],requestBody:'buffered',fetch:request=>routes.request(request)}),ctx.connection.fetch.register({path:'/api/rp-database/events',methods:['GET'],requestBody:'buffered',fetch:request=>routes.events(request)})]
  ctx.effect(()=>async()=>{routes.close();await service.close();for(const dispose of unregister)dispose()},'RP database runtime')
}
