import {DatabaseError} from './core.mjs'

const text=message=>(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n')
const messageOf=event=>event.type==='user/message'?event.data:event.data?.message

/** Derive visible sources, retaining compacted originals but excluding replaced branches. */
export function projectSession(snapshot) {
  const events=[...new Map((snapshot.records??[]).map(row=>row.type==='event'?row.event:row).filter(event=>Number.isSafeInteger(event?.seq)).map(event=>[event.seq,event])).values()].sort((a,b)=>a.seq-b.seq)
  const bySeq=new Map(events.map(event=>[event.seq,event])),nodes=[],semantic=new Map()
  for(const event of events){
    if(event.surfaceOp==='append'){nodes.push(event.seq);semantic.set(event.seq,[event.seq]);continue}
    if(event.surfaceOp?.op!=='replace')continue
    const start=nodes.indexOf(event.surfaceOp.startSeq),end=nodes.indexOf(event.surfaceOp.endSeq)
    if(start<0||end<start)continue
    const replaced=nodes.slice(start,end+1)
    const preserved=messageOf(event)?.source?.kind==='compact-checkpoint'?replaced.flatMap(seq=>semantic.get(seq)??[seq]):[]
    semantic.set(event.seq,[...preserved,event.seq]);nodes.splice(start,end-start+1,event.seq)
  }
  const activeSeqs=new Set(nodes.flatMap(seq=>semantic.get(seq)??[seq]))
  const activeEvents=events.filter(event=>activeSeqs.has(event.seq))
  const messages=nodes.map(seq=>messageOf(bySeq.get(seq))).filter(Boolean)
  const activeAnchors=activeEvents.filter(event=>event.type==='assistant/message'&&typeof event.data?.message?.id==='string').map(event=>event.data.message.id)
  return {sessionId:snapshot.header?.id,parentSession:snapshot.header?.parentSession,header:snapshot.header,projections:snapshot.projections,
    events,visible: nodes.map(seq=>bySeq.get(seq)),activeEvents,messages,activeAnchors,currentAnchor:activeAnchors.at(-1)??null}
}

/** Read the complete canonical history under the authenticated owner peer. */
export function createOwnerReader(ctx) {
  return async function read(sessionId,signal){
    if(typeof sessionId!=='string'||!sessionId.trim())throw new DatabaseError('INVALID_SESSION','A session is required')
    signal?.throwIfAborted()
    const lifetime=new AbortController(),combined=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal
    let iterator
    try{
      const stream=await ctx.typertGateway.stream({namespace:'session',method:'follow',args:{request:{address:{kind:'session',sessionId},maxMessages:100}},peer:ctx.connection.browserPeer,signal:combined})
      iterator=stream[Symbol.asyncIterator]();const first=await iterator.next();combined.throwIfAborted()
      const snapshot=first.value
      if(first.done||snapshot?.type!=='snapshot'||snapshot.header?.id!==sessionId||!Array.isArray(snapshot.records))throw new DatabaseError('SESSION_NOT_FOUND','Session is unavailable',404)
      const records=[...snapshot.records];let page=snapshot,before=snapshot.cursor+1
      while(page.hasMore){
        const next=Math.min(...page.records.map(row=>(row.type==='event'?row.event:row)?.seq))
        if(!Number.isSafeInteger(next)||next<0||next>=before)throw new DatabaseError('HISTORY_INVALID','Session history did not advance',503)
        before=next
        page=await ctx.typertGateway.invoke({namespace:'session',method:'page',args:{request:{address:{kind:'session',sessionId},throughSeq:snapshot.cursor,beforeSeq:before,maxMessages:500}},peer:ctx.connection.browserPeer,signal:combined})
        combined.throwIfAborted()
        if(!Array.isArray(page?.records)||typeof page.hasMore!=='boolean')throw new DatabaseError('HISTORY_INVALID','Session history is unavailable',503)
        records.push(...page.records)
      }
      return projectSession({...snapshot,records})
    }catch(error){
      if(combined.aborted)combined.throwIfAborted()
      if(error instanceof DatabaseError)throw error
      if(['gateway/forbidden','gateway/access-denied'].includes(error?.code))throw new DatabaseError('FORBIDDEN','Session access was denied',403)
      throw new DatabaseError('SESSION_UNAVAILABLE','Session is unavailable',503)
    }finally{lifetime.abort();try{await iterator?.return?.()}catch{/* Reader disposal does not replace its accepted result. */}}
  }
}

/** Only canonical successful rp_present receipts form narrative history. */
export function narrativeHistory(view) {
  const active=new Set(view.activeAnchors),bySeq=new Map(view.events.map(event=>[event.seq,event])),latest=new Map(),calls=new Map(),results=[]
  let action=''
  for(const event of view.events){
    const identity=`${event.data?.turn}:${event.data?.step}`
    if(event.type==='user/message'&&event.data?.source?.kind==='user')action=text(event.data)
    if(event.type==='assistant/message')latest.set(identity,{event,action})
    if(event.type==='tool/call'&&event.data?.name==='rp_present'){
      const owner=latest.get(identity),message=owner?.event.data?.message
      if(active.has(message?.id)&&message.content?.some(block=>block.type==='tool-call'&&block.name==='rp_present'&&block.id===event.data.callId))calls.set(event.seq,{...owner,call:event})
    }
  }
  for(const event of view.activeEvents){
    if(event.type!=='tool/result'||event.sourceEventSeqs?.length!==1)continue
    const owner=calls.get(event.sourceEventSeqs[0]),message=event.data?.message,envelope=event.data?.meta?.rpLastStep,item=envelope?.record
    if(!owner||!bySeq.has(owner.call.seq)||message?.isError||message?.source?.kind!=='tool'||message.toolCallId!==message.source.callId||message.toolCallId!==owner.call.data.callId
      ||event.data.turn!==owner.call.data.turn||event.data.step!==owner.call.data.step||envelope?.schemaVersion!==1||item?.status!=='complete'||typeof item.id!=='string'||typeof item.text!=='string')continue
    results.push({id:item.id,anchor:owner.event.data.message.id,turn:event.data.turn,action:owner.action,text:item.text,createdAt:item.createdAt,
      source:{sessionId:view.sessionId,assistantMessageId:owner.event.data.message.id,callSeq:owner.call.seq,resultSeq:event.seq,callId:owner.call.data.callId}})
  }
  return results
}
