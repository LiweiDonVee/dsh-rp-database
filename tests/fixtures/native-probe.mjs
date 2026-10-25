// Local deterministic models; no paid providers, private profiles, or source imports.
export const name='native-smoke-probe'
export const inject=['llm','agents','tools','connection','typertGateway']
async function* textChunks(text){yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text};yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'usage',usage:{inputTokens:10,outputTokens:10}};yield{type:'finish',reason:{kind:'stop'}}}
async function* toolChunks(name,args){const id='reused-smoke-wire-id';yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)};yield{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}};yield{type:'finish',reason:{kind:'tool-calls'}}}
export function apply(ctx){
 const calls=[]
 const invoke=(method,request,signal)=>ctx.typertGateway.invoke({namespace:'session',method,args:{request},peer:ctx.connection.browserPeer,signal})
 const adapter={providerInfo:id=>({id,name:id}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_p,_m,v)=>v,
 listModels:async provider=>[{provider,id:'main',name:'main'}],resolveModel:async(provider,id)=>({provider,id,name:id}),
 async prepareCall(provider,id){return{model:await this.resolveModel(provider,id),stream:options=>this.stream(options)}},
 async*stream(options){
  const human=options.messages.findLastIndex(m=>m.role==='user'&&m.source?.kind==='user')
  if(human<0){yield*textChunks('Synthetic database story');return}
  const agent=ctx.agents.currentInitiator(),tail=options.messages.slice(human+1)
  if(tail.some(m=>m.role==='tool')){yield*textChunks('故事条目已更新，来源保持不变。');return}
  if(!options.tools?.some(tool=>tool.name==='rp_db_patch'))throw Error('Bound story is missing database tools')
  const state=await ctx.get('rpDatabase').catalog({sessionId:agent.session.id,agent})
  calls.push({kind:'main-patch',sessionId:agent.session.id})
  yield*toolChunks('rp_db_patch',{expectedRevision:state.revision,operations:[{op:'update',id:'open',patch:{content:'本故事中门已关紧。'}},{op:'add',entry:{id:'local',title:'故事新线索',content:'脚印留在门外。'}},{op:'note',id:'open',text:'这是本轮临时线索，不是永久世界事实。'}]})
 }}
 ctx.llm.registerAdapter(['smoke-local'],adapter)
 ctx.connection.fetch.register({path:'/api/native-smoke',methods:['POST'],requestBody:'buffered',fetch:async request=>{try{
  const input=await request.json(),service=ctx.get('rpDatabase')
  if(input.action==='create')return Response.json(await invoke('create',{agentPreset:'native-smoke-story'},request.signal))
  if(input.action==='run'){await invoke('prompt',{sessionId:input.sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'我关上门，查看门外脚印。'}]},request.signal);await ctx.agents.get(input.sessionId).whenIdle();return Response.json({calls})}
  const agent=ctx.agents.get(input.sessionId)
  if(!agent||agent.session.id!==input.sessionId)throw Error('Live fixture story required')
  if(input.action==='catalog'||input.action==='effective')return Response.json(await service[input.action]({sessionId:input.sessionId,agent,signal:request.signal}))
  if(input.action==='read')return Response.json(await service.read({sessionId:input.sessionId,agent,entryIds:input.entryIds,signal:request.signal}))
  if(input.action==='rejectPolicies'){
   const codes=[]
   for(const operations of [[{op:'update',id:'locked',patch:{content:'forbidden'}}],[{op:'remove',id:'required'}],[{op:'update',id:'disabled',patch:{content:'forbidden'}}]]){
    const state=await service.catalog({sessionId:input.sessionId,agent})
    try{await service.patch({sessionId:input.sessionId,agent,expectedRevision:state.revision,operations});codes.push('ACCEPTED')}catch(error){codes.push(error.code)}
   }return Response.json({codes})
  }
  return Response.json({error:'Unknown fixture action'},{status:400})
 }catch(error){return Response.json({error:{message:error.message,code:error.code}},{status:500})}}})
}

