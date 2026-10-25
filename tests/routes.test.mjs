import test from 'node:test'
import assert from 'node:assert/strict'

test('exact database routes reject proxy fields and preserve revision conflict codes',async()=>{
  const module=await import('../src/routes.mjs').catch(()=>({}));assert.equal(typeof module.createDatabaseRoutes,'function')
  const calls=[]
  const routes=module.createDatabaseRoutes({state:async value=>{calls.push(value);return{revision:2,databases:[]}},save:async()=>{throw Object.assign(Error('reload'),{name:'DatabaseError',code:'REVISION_CONFLICT',status:409})}})
  const request=body=>new Request('http://localhost/api/rp-database/request',{method:'POST',body:JSON.stringify(body)})
  assert.equal((await routes.request(request({action:'state',sessionId:'s',url:'https://example.com'}))).status,400)
  assert.equal(calls.length,0)
  assert.equal((await routes.request(request({action:'state'}))).status,200)
  assert.equal((await routes.request(request({action:'bind',sessionId:'s',databaseId:'d',version:1}))).status,400)
  assert.equal((await routes.request(request({action:'save',database:{id:'d'},expectedRevision:1}))).status,409)
})

test('authenticated database SSE unsubscribes on abort and unload',async()=>{
  const {createDatabaseRoutes}=await import('../src/routes.mjs');let subscribed=0,unsubscribed=0
  const routes=createDatabaseRoutes({authorize:async()=>{},subscribe:()=>{subscribed++;return()=>unsubscribed++}})
  const controller=new AbortController(),response=await routes.events(new Request('http://localhost/api/rp-database/events?sessionId=s',{signal:controller.signal}))
  assert.equal(response.status,200);assert.equal(subscribed,1);controller.abort();assert.equal(unsubscribed,1)
  await routes.events(new Request('http://localhost/api/rp-database/events?sessionId=s'));routes.close();assert.equal(unsubscribed,2)
})
