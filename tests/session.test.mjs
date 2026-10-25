import test from 'node:test'
import assert from 'node:assert/strict'
import {projectSession,narrativeHistory} from '../src/session.mjs'

test('source projection follows durable replacements and never aliases reused provider call ids', async () => {
  const module = await import('../src/session.mjs').catch(() => ({}))
  assert.equal(typeof module.projectSession, 'function', 'canonical session projection is required')
  const assistant = (seq, id) => ({seq,type:'assistant/message',surfaceOp:'append',data:{turn:seq,step:1,message:{id,role:'assistant',source:{kind:'model'},content:[{type:'tool-call',id:'reused',name:'rp_present',arguments:'{}'}]}}})
  const events = [assistant(1,'m-one'),assistant(3,'m-two'),{seq:4,type:'user/message',surfaceOp:{op:'replace',startSeq:3,endSeq:3},data:{id:'rollback',role:'user',source:{kind:'runtime-context'},content:[]}}]
  const result = module.projectSession({header:{id:'story',parentSession:'parent'},records:events.map(event=>({type:'event',event}))})
  assert.deepEqual(result.activeAnchors,['m-one'])
  assert.equal(result.parentSession,'parent')
  assert.equal(result.currentAnchor,'m-one')
})

test('owner reader fixes paging at the authenticated snapshot and closes its stream', async () => {
  const {createOwnerReader} = await import('../src/session.mjs')
  const calls=[],peer={id:'owner'};let closed=false
  const event=seq=>({type:'event',event:{seq,type:'assistant/message',surfaceOp:'append',data:{message:{id:'m'+seq,role:'assistant',content:[]}}}})
  const ctx={connection:{browserPeer:peer},typertGateway:{stream:async input=>{calls.push(input);return{async *[Symbol.asyncIterator](){try{yield{type:'snapshot',header:{id:'story'},cursor:20,hasMore:true,records:[event(10)]}}finally{closed=true}}}},invoke:async input=>{calls.push(input);return{hasMore:false,records:[event(1)]}}}}
  const read=createOwnerReader(ctx)
  const result=await read('story',new AbortController().signal)
  assert.deepEqual(result.activeAnchors,['m1','m10'])
  assert.equal(closed,true)
  assert.equal(calls[1].args.request.throughSeq,20)
  assert.equal(calls[1].args.request.beforeSeq,10)
  assert.equal(calls[1].peer,peer)
})

test('compaction preserves causal sources and canonical reused-call narratives while rollback excludes them',()=>{
  const events=[]
  for(const [index,id]of ['one','two'].entries()){
    const seq=index*4,turn=index+1
    events.push({seq,type:'user/message',surfaceOp:'append',data:{id:'u'+id,source:{kind:'user'},content:[{type:'text',text:'action '+id}]}})
    events.push({seq:seq+1,type:'assistant/message',surfaceOp:'append',data:{turn,step:1,message:{id:'m'+id,role:'assistant',content:[{type:'tool-call',name:'rp_present',id:'reused'}]}}})
    events.push({seq:seq+2,type:'tool/call',data:{turn,step:1,name:'rp_present',callId:'reused'}})
    events.push({seq:seq+3,type:'tool/result',surfaceOp:'append',sourceEventSeqs:[seq+2],data:{turn,step:1,message:{id:'r'+id,toolCallId:'reused',source:{kind:'tool',callId:'reused'},content:[]},meta:{rpLastStep:{schemaVersion:1,record:{id,text:'narrative '+id,status:'complete'}}}}})
  }
  events.push({seq:8,type:'user/message',surfaceOp:{op:'replace',startSeq:0,endSeq:3},data:{id:'compact',source:{kind:'compact-checkpoint',compactionId:'c'},content:[]}})
  const compacted=projectSession({header:{id:'s'},records:events})
  assert.deepEqual(narrativeHistory(compacted).map(record=>record.id),['one','two'])
  events.push({seq:9,type:'user/message',surfaceOp:{op:'replace',startSeq:4,endSeq:7},data:{id:'undo',source:{kind:'runtime-context'},content:[]}})
  assert.deepEqual(narrativeHistory(projectSession({header:{id:'s'},records:events})).map(record=>record.id),['one'])
})
