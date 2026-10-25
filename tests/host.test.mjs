import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

function fixture(events=[]){
  const handlers=new Map(),agents=new Map(),definitions=new Map()
  const on=(name,fn)=>{const set=handlers.get(name)??new Set();set.add(fn);handlers.set(name,set);return()=>set.delete(fn)}
  const ctx={on,emit:(name,...args)=>{for(const fn of handlers.get(name)??[])void fn(...args)},get:()=>undefined,agents:{list:()=>[...agents.values()],get:id=>agents.get(id)},connection:{browserPeer:{id:'owner'}},
    tools:{get:()=>undefined},systemPrompt:{context:()=>()=>{},tools:()=>()=>{}},
    typertGateway:{stream:async input=>({async *[Symbol.asyncIterator](){const id=input.args.request.address.sessionId;if(id==='denied')throw Object.assign(Error('secret'),{code:'gateway/forbidden'});yield{type:'snapshot',header:{id},cursor:100,hasMore:false,records:events.map(event=>({type:'event',event}))}}})}}
  const agent={id:'story',session:{id:'story',header:{id:'story'},snapshotEvents:()=>events},ctx:{on,tools:{register:tool=>{definitions.set(tool.name,tool);return()=>definitions.delete(tool.name)},restrict:()=>()=>{}}}}
  agents.set('story',agent)
  return{ctx,agent,handlers,definitions,events}
}
const assistant=id=>({seq:1,type:'assistant/message',surfaceOp:'append',data:{message:{id,role:'assistant',source:{kind:'model'},content:[]}}})

test('bound native database reads are scoped, locked and disabled entries cannot be bypassed, source remains exact',async()=>{
  const module=await import('../src/host.mjs').catch(()=>({}))
  assert.equal(typeof module.createDatabaseHost,'function','native database host is required')
  const directory=await mkdtemp(join(tmpdir(),'rp-db-host-')),f=fixture([assistant('turn-one')])
  let service
  try{
    service=await module.createDatabaseHost(f.ctx,{directory})
    const raw=JSON.stringify({name:'fixture',entries:[{id:'law',title:'约束',content:'固定事实',mode:'required',readOnly:true},{id:'topic',title:'灯塔',content:'旧灯塔'},{id:'off',title:'禁用',content:'DISABLED_CANARY',mode:'disabled'}]})
    const imported=await service.import({rawText:raw,expectedRevision:0})
    await service.bind({sessionId:'story',databaseId:imported.databaseId,version:1,expectedRevision:imported.revision})
    const catalog=await service.catalog({sessionId:'story',agent:f.agent})
    await assert.rejects(service.catalog({sessionId:'different-story',agent:f.agent}),{code:'AGENT_MISMATCH'})
    assert.deepEqual(catalog.entries.map(entry=>entry.id),['law','topic'])
    assert.ok(f.definitions.has('rp_db_search'))
    await assert.rejects(service.read({sessionId:'story',entryIds:['off'],agent:f.agent}),{code:'ENTRY_DISABLED'})
    await assert.rejects(service.patch({sessionId:'story',agent:f.agent,expectedRevision:catalog.revision,operations:[{op:'update',id:'law',patch:{content:'changed'}}]}),{code:'READ_ONLY'})
    const patched=await service.patch({sessionId:'story',agent:f.agent,expectedRevision:catalog.revision,operations:[{op:'update',id:'topic',patch:{content:'已点亮的灯塔'}}]})
    assert.equal(patched.session.entries.find(entry=>entry.id==='topic').content,'已点亮的灯塔')
    assert.equal((await service.source({sourceId:imported.sourceId})).source.rawText,raw)
    f.events.push({seq:2,type:'user/message',surfaceOp:{op:'replace',startSeq:1,endSeq:1},data:{id:'rollback',source:{kind:'runtime-context'},content:[]}})
    assert.equal((await service.effective({sessionId:'story',agent:f.agent})).entries.find(entry=>entry.id==='topic').content,'旧灯塔')
    await assert.rejects(service.state({sessionId:'denied'}),{code:'FORBIDDEN'})
  }finally{await service?.close();await rm(directory,{recursive:true,force:true})}
})

test('unbound child tools are masked and canonical fork inherits only the active branch state',async()=>{
  const {createDatabaseHost}=await import('../src/host.mjs')
  const directory=await mkdtemp(join(tmpdir(),'rp-db-fork-')),f=fixture([assistant('turn-one')]);let service
  try{
    service=await createDatabaseHost(f.ctx,{directory})
    const imported=await service.import({rawText:JSON.stringify({name:'fixture',entries:[{id:'a',content:'base'}]}),expectedRevision:0})
    const bound=await service.bind({sessionId:'story',databaseId:imported.databaseId,version:1,expectedRevision:imported.revision})
    await service.patch({sessionId:'story',agent:f.agent,operations:[{op:'update',id:'a',patch:{content:'parent'}}],expectedRevision:bound.revision})
    const child={id:'child',session:{id:'child',header:{id:'child',parentSession:'story'},snapshotEvents:()=>f.events},ctx:{on:f.ctx.on,tools:{register:()=>()=>{},restrict:()=>()=>{}}}}
    const original=f.ctx.agents.get;f.ctx.agents.get=id=>id==='child'?child:original(id)
    const state=await service.effective({sessionId:'child',agent:child})
    assert.equal(state.entries[0].content,'parent')
    const before=(await service.state({sessionId:'story'})).revision
    await service.patch({sessionId:'child',agent:child,operations:[{op:'update',id:'a',patch:{content:'child'}}],expectedRevision:before})
    assert.equal((await service.effective({sessionId:'story',agent:f.agent})).entries[0].content,'parent')
  }finally{await service?.close();await rm(directory,{recursive:true,force:true})}
})
