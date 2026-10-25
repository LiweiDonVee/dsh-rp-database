import {DatabaseError} from './core.mjs'

export const TOOL_NAMES=['rp_db_catalog','rp_db_read','rp_db_search','rp_db_patch']
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const output={schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]}

/** Register database capabilities only for bound sessions and release inherited scopes. */
export function registerDatabaseTools(ctx,service){
  const scopes=new Map(),disposers=[];let stopped=false,syncing=false
  const definitions=[
    {name:'rp_db_catalog',description:'Inspect the current story database catalog and human policies. Disabled entries are unavailable.',parameters:object({}),method:'catalog'},
    {name:'rp_db_read',description:'Read enabled story entries by stable ID, including entries outside initial search candidates.',parameters:object({entryIds:{type:'array',items:{type:'string'}}},['entryIds']),method:'read'},
    {name:'rp_db_search',description:'Search the entire enabled story database by names, keywords and configured semantic retrieval.',parameters:object({query:{type:'string'},limit:{type:'integer',minimum:1,maximum:100}},['query']),method:'search'},
    {name:'rp_db_patch',description:'Atomically change this story overlay using a current catalog revision. Human read-only and selection policies cannot change.',parameters:object({expectedRevision:{type:'integer',minimum:0},operations:{type:'array',items:{type:'object'}}},['expectedRevision','operations']),method:'patch'},
  ].map(definition=>({...definition,output,execute:async(args,exec)=>{
    exec.signal.throwIfAborted()
    const id=exec.agent?.session?.id
    if(!service.hasBinding(id))throw new DatabaseError('NOT_BOUND','Bind a database to this story first',409)
    const allowed=Object.keys(definition.parameters.properties)
    if(!args||typeof args!=='object'||Object.keys(args).some(key=>!allowed.includes(key)))throw new DatabaseError('INVALID_OPERATION','Unexpected database arguments')
    return service[definition.method]({...args,sessionId:id,agent:exec.agent,signal:exec.signal})
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
