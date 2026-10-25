export function turnEvents({start=1,turn=1,anchor='assistant-A',callId='reused-call',kind='turn'}={}){
  const name=kind==='opening'?'rp_begin_story':'rp_commit_turn'
  return[{seq:start,type:'turn/start',data:{turn}},{seq:start+1,type:'user/message',surfaceOp:'append',data:{id:`user-${turn}`,role:'user',source:{kind:'user'},content:[{type:'text',text:'Synthetic action'}]}},{seq:start+2,type:'assistant/message',surfaceOp:'append',data:{turn,step:1,message:{id:anchor,role:'assistant',source:{kind:'model'},content:[{type:'tool-call',id:callId,name,arguments:'{}'}]}}},{seq:start+3,type:'tool/call',data:{turn,step:1,callId,name,arguments:'{}'}}]
}
export function hostFixture(events=turnEvents()){
  const handlers=new Map(),agents=new Map(),definitions=new Map()
  const on=(name,listener)=>{const set=handlers.get(name)??new Set();set.add(listener);handlers.set(name,set);return()=>set.delete(listener)}
  const ctx={on,agents:{list:()=>[...agents.values()],get:id=>agents.get(id)},connection:{browserPeer:{id:'owner'}},tools:{get:()=>undefined},systemPrompt:{context:()=>()=>{}},typertGateway:{stream:async input=>({async *[Symbol.asyncIterator](){const id=input.args.request.address.sessionId;yield{type:'snapshot',header:{id},cursor:100,hasMore:false,records:events.map(event=>({type:'event',event}))}}})}}
  const addAgent=(id='story',parentSession)=>{
    const agent={id,session:{id,header:{id,...parentSession?{parentSession}:{}},snapshotEvents:()=>events},ctx:{on,tools:{register:tool=>{definitions.set(tool.name,tool);return()=>definitions.delete(tool.name)},restrict:()=>()=>{}}}}
    agents.set(id,agent);return agent
  }
  return{ctx,agent:addAgent(),addAgent,events,definitions,handlers}
}
export const stateSeeds=(extra={})=>[{id:'gm.scene',title:'Scene',content:JSON.stringify({schemaVersion:1,title:'Harbor',location:'Pier',presentActorIds:[]}),...extra},{id:'gm.facts',title:'Facts',content:JSON.stringify({schemaVersion:1,items:[]}),...extra}]
export const factRefs=[{sourceKey:'@session',entryId:'gm.scene'},{sourceKey:'@session',entryId:'gm.facts'}]
