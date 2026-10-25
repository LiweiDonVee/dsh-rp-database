import {DatabaseError} from './core.mjs'
import {entryKey,parseEntryKey} from './references.mjs'

export const TOOL_NAMES=['rp_db_catalog','rp_db_read','rp_db_search','rp_db_patch']
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const output={schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]}

/** Register database capabilities only for bound sessions and release inherited scopes. */
export function registerDatabaseTools(ctx,service){
  const scopes=new Map(),disposers=[];let stopped=false,syncing=false
  async function execute(method,args,input){
    if(method==='catalog'){
      const result=await service.catalogV2(input)
      return{...result,entries:result.entries.map(entry=>({...entry,key:entryKey(entry.ref)}))}
    }
    if(method==='search'){
      const result=await service.searchV2({...args,...input})
      return{...result,candidates:result.candidates.map(candidate=>({...candidate,key:entryKey(candidate.ref)})),required:result.required.map(ref=>({key:entryKey(ref),ref}))}
    }
    const catalog=await service.catalogV2(input),byId=new Map(),duplicates=new Set()
    for(const entry of catalog.entries){if(byId.has(entry.id))duplicates.add(entry.id);byId.set(entry.id,entry.ref)}
    const resolve=id=>{
      try{return parseEntryKey(id)}catch{
        if(catalog.binding.sources.length!==1||catalog.binding.sources[0].key!=='legacy'||duplicates.has(id))throw new DatabaseError('QUALIFIED_REFERENCE_REQUIRED','Use a program-generated entryKey from the catalog',409)
        const ref=byId.get(id);if(!ref)throw new DatabaseError('ENTRY_NOT_FOUND','Entry is unavailable',404);return ref
      }
    }
    if(method==='read'){
      if(!Array.isArray(args.entryIds))throw new DatabaseError('INVALID_OPERATION','Entry IDs must be an array')
      return service.readV2({...input,refs:args.entryIds.map(resolve)})
    }
    if(!Array.isArray(args.operations))throw new DatabaseError('INVALID_OPERATION','Operations must be an array')
    const operations=args.operations.map(operation=>{
      if(operation?.op==='add')return operation
      if(!operation||typeof operation!=='object'||Object.hasOwn(operation,'ref'))throw new DatabaseError('INVALID_OPERATION','Tool operations must use catalog entryKeys')
      const{id,...rest}=operation;return{...rest,ref:resolve(id)}
    })
    return service.patchV2({...input,expectedRevision:args.expectedRevision,operations})
  }
  const definitions=[
    {name:'rp_db_catalog',description:'Inspect the current story database catalog and human policies. Disabled entries are unavailable.',parameters:object({}),method:'catalog'},
    {name:'rp_db_read',description:'Read enabled story entries using program-generated entryKeys from the catalog, including entries outside initial search candidates.',parameters:object({entryIds:{type:'array',items:{type:'string'}}},['entryIds']),method:'read'},
    {name:'rp_db_search',description:'Search the entire enabled story database by names, keywords and configured semantic retrieval.',parameters:object({query:{type:'string'},limit:{type:'integer',minimum:1,maximum:100}},['query']),method:'search'},
    {name:'rp_db_patch',description:'Atomically change this story overlay using a current catalog revision. Human read-only and selection policies cannot change.',parameters:object({expectedRevision:{type:'integer',minimum:0},operations:{type:'array',items:{type:'object'}}},['expectedRevision','operations']),method:'patch'},
  ].map(definition=>({...definition,output,execute:async(args,exec)=>{
    exec.signal.throwIfAborted()
    const id=exec.agent?.session?.id
    if(!service.hasBinding(id))throw new DatabaseError('NOT_BOUND','Bind a database to this story first',409)
    const allowed=Object.keys(definition.parameters.properties)
    if(!args||typeof args!=='object'||Object.keys(args).some(key=>!allowed.includes(key)))throw new DatabaseError('INVALID_OPERATION','Unexpected database arguments')
    return execute(definition.method,args,{sessionId:id,agent:exec.agent,signal:exec.signal})
  }}))
  function sync(subject){
    if(stopped||syncing)return;syncing=true
    try{
      const agents=ctx.agents.list();if(subject&&!agents.includes(subject))agents.push(subject)
      for(const [agent,record]of scopes)if(!agents.includes(agent)){for(const dispose of record.tools)dispose();record.mask?.();record.preflight?.();scopes.delete(agent)}
      for(const agent of agents){
        let record=scopes.get(agent)
        if(!record){
          record={tools:[]};scopes.set(agent,record)
          record.preflight=agent.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{await service.ensureAgent(agent);sync(agent);return next()},{prepend:true})
        }
        if(service.hasBinding(agent.session.id)){
          record.mask?.();record.mask=undefined
          if(!record.tools.length)for(const definition of definitions)record.tools.push(agent.ctx.tools.register(definition))
        }else{
          for(const dispose of record.tools.splice(0))dispose()
          if(!record.mask&&TOOL_NAMES.some(name=>ctx.tools.get(name,agent)))record.mask=agent.ctx.tools.restrict({deny:TOOL_NAMES})
        }
      }
    }finally{syncing=false}
  }
  sync()
  // DSH awaits serial agent/created listeners before releasing queued prompts.
  disposers.push(ctx.on('agent/created',async({agent})=>{await service.ensureAgent(agent);sync(agent)}))
  disposers.push(ctx.on('agent/disposed',({agent})=>{const record=scopes.get(agent);if(record){for(const dispose of record.tools)dispose();record.mask?.();record.preflight?.();scopes.delete(agent)}}))
  disposers.push(ctx.on('tools/change',()=>sync()))
  disposers.push(ctx.systemPrompt.context({name:'rp-database-workflow',order:290,required:true,interpolate:false,text:()=>{
    const agent=ctx.agents.currentInitiator?.()
    return agent&&service.hasBinding(agent.session.id)?'A story database is bound. Use rp_db_catalog/read/search to inspect relevant material and narrative notes; use rp_db_patch for permitted story-local updates. Human read-only, required and disabled policies are enforced. Knowledge notes guide GM judgment; do not treat proposals as happened facts or rewrite a resolved outcome through notes. Sources and other sessions remain unchanged.':''
  }}))
  const close=()=>{stopped=true;for(const record of scopes.values()){for(const dispose of record.tools)dispose();record.mask?.();record.preflight?.()}scopes.clear();for(const dispose of disposers)dispose()}
  close.sync=sync;return close
}
