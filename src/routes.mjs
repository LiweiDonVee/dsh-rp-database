import {DatabaseError} from './core.mjs'

const fields={state:['sessionId'],database:['databaseId','version'],source:['sourceId'],create:['name','expectedRevision'],import:['rawText','name','expectedRevision'],save:['database','expectedRevision'],bind:['sessionId','databaseId','version','expectedRevision'],search:['sessionId','query','limit']}
const writes=new Set(['create','import','save','bind'])
const id=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const failure=(status,code,message)=>Response.json({error:{code,message}},{status,headers:{'cache-control':'no-store'}})
function valid(input){
  if(!object(input)||!Object.hasOwn(fields,input.action)||Object.keys(input).some(key=>key!=='action'&&!fields[input.action].includes(key)))return false
  if(writes.has(input.action)&&(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0))return false
  if(input.sessionId!==undefined&&!id(input.sessionId))return false
  if(['bind','search'].includes(input.action)&&!id(input.sessionId))return false
  if(['database','bind'].includes(input.action)&&!id(input.databaseId))return false
  if(input.version!==undefined&&(!Number.isSafeInteger(input.version)||input.version<1))return false
  if(input.action==='bind'&&input.version===undefined)return false
  if(input.action==='source'&&!id(input.sourceId))return false
  if(input.action==='create'&&!id(input.name))return false
  if(input.action==='import'&&(typeof input.rawText!=='string'||input.rawText.length>8_000_000||input.name!==undefined&&!id(input.name)))return false
  if(input.action==='save'&&!object(input.database))return false
  if(input.action==='search'&&(typeof input.query!=='string'||input.query.length>4000||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100)))return false
  return true
}
function errorResponse(error){
  if(error instanceof DatabaseError||error?.name==='DatabaseError')return failure(error.status??400,error.code,error.message)
  if(error?.name==='AbortError')return failure(499,'CANCELLED','The request was cancelled')
  return failure(503,'UNAVAILABLE','Database is temporarily unavailable')
}

/** Exact owner Connection operations; no arbitrary Remote or URL forwarding. */
export function createDatabaseRoutes(service){
  let stopped=false;const streams=new Set()
  return{
    async request(request){
      if(stopped)return failure(503,'UNAVAILABLE','Database has been unloaded')
      let input;try{input=await request.json()}catch{return failure(400,'INVALID_REQUEST','A JSON operation is required')}
      if(!valid(input))return failure(400,'INVALID_REQUEST','Invalid database operation')
      try{request.signal.throwIfAborted();const{action,...args}=input;return Response.json(await service[action]({...args,signal:request.signal}),{headers:{'cache-control':'no-store'}})}catch(error){return errorResponse(error)}
    },
    async events(request){
      if(stopped)return failure(503,'UNAVAILABLE','Database has been unloaded')
      const sessionId=new URL(request.url).searchParams.get('sessionId');if(!id(sessionId))return failure(400,'INVALID_REQUEST','A session is required')
      try{
        await service.authorize(sessionId,request.signal);if(stopped||request.signal.aborted)return new Response(null,{status:204})
        let cleanup=()=>{}
        const body=new ReadableStream({start(controller){
          let closed=false,unsubscribe=()=>{};const encoder=new TextEncoder()
          const write=text=>{if(closed)return;const bytes=encoder.encode(text);if(controller.desiredSize<bytes.byteLength){cleanup();return}controller.enqueue(bytes)}
          const timer=setInterval(()=>write(': heartbeat\n\n'),15000);timer.unref?.()
          const aborted=()=>cleanup()
          cleanup=cancelled=>{if(closed)return;closed=true;clearInterval(timer);unsubscribe();streams.delete(cleanup);request.signal.removeEventListener('abort',aborted);if(cancelled!==true)controller.close()}
          streams.add(cleanup);request.signal.addEventListener('abort',aborted,{once:true})
          unsubscribe=service.subscribe(sessionId,()=>write(`event: changed\ndata: ${JSON.stringify({type:'changed',sessionId})}\n\n`))
          if(stopped||request.signal.aborted)cleanup();else write(`event: connected\ndata: ${JSON.stringify({type:'connected',sessionId})}\n\n`)
        },cancel(){cleanup(true)}},{highWaterMark:16384,size:chunk=>chunk.byteLength})
        return new Response(body,{headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'}})
      }catch(error){return errorResponse(error)}
    },
    close(){stopped=true;for(const close of streams)close()},
  }
}
