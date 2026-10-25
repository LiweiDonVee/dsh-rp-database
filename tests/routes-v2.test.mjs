import test from 'node:test'
import assert from 'node:assert/strict'
import {createDatabaseRoutes} from '../src/routes.mjs'
import {DatabaseError} from '../src/core.mjs'

const request=input=>new Request('http://localhost/api/rp-database/request',{method:'POST',body:JSON.stringify(input)})
test('owner v2 routes accept exact qualified source DTOs and reject model-controlled stage fields',async()=>{
  const seen=[],routes=createDatabaseRoutes({bindSources:async input=>{seen.push(input);return{revision:4,binding:{schemaVersion:2,sources:input.sources,factEntryRefs:[]}}},effectiveV2:async()=>({revision:4,binding:{schemaVersion:2,sources:[],factEntryRefs:[]},entries:[],notes:[],changes:[]})})
  const input={action:'bindSources',sessionId:'story',sources:[{key:'world',databaseId:'db',version:1}],expectedRevision:3,resetOverlay:false}
  assert.equal((await routes.request(request(input))).status,200)
  assert.equal(seen.length,1)
  for(const value of [{...input,stage:'fact'},{...input,agent:{session:{id:'story'}}},{...input,sources:[{...input.sources[0],key:'@session'}]},{...input,resetOverlay:'true'},{...input,sources:[{...input.sources[0],owner:'human'}]},{action:'initializeStoryState',sessionId:'story'},{action:'patchV2',sessionId:'story'}])assert.equal((await routes.request(request(value))).status,400)
  assert.equal(seen.length,1)
  assert.equal((await routes.request(request({action:'effectiveV2',sessionId:'story'}))).status,200)
})
test('safe error projection preserves only same-story receiptId alongside code and message',async()=>{
  const error=new DatabaseError('TURN_ALREADY_COMMITTED','Already committed',409);error.receiptId='same-story-receipt';error.secret='private'
  const routes=createDatabaseRoutes({bindSources:async()=>{throw error}})
  const response=await routes.request(request({action:'bindSources',sessionId:'story',sources:[],expectedRevision:0,resetOverlay:false}))
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:{code:'TURN_ALREADY_COMMITTED',message:'Already committed',receiptId:'same-story-receipt'}})
})
