import test from 'node:test'
import assert from 'node:assert/strict'
import {createDatabaseRoutes} from '../src/routes.mjs'
const request=input=>new Request('http://localhost/api/rp-database/request',{method:'POST',body:JSON.stringify(input)})
test('document/index owner routes accept only bytes/text DTOs and never proxy filesystem or provider settings',async()=>{
  const seen=[],routes=createDatabaseRoutes({importDocument:async input=>{seen.push(input);return{revision:1,documentId:'doc',databaseId:'db',version:1,chunkCount:1,diagnostics:[]}},document:async()=>({document:{id:'doc'}}),indexState:async()=>({readyChunks:0,staleChunks:1}),rebuildIndex:async()=>({indexedChunks:1,skippedChunks:0,diagnostics:[]})})
  const valid={action:'importDocument',name:'file.txt',mimeType:'text/plain',text:'text',requestId:'doc-request',expectedRevision:0}
  assert.equal((await routes.request(request(valid))).status,200)
  for(const input of [{...valid,filePath:'C:/private.txt'},{...valid,url:'https://example.com'},{...valid,stage:'facts'},{...valid,dataBase64:'Yg=='},{...valid,mimeType:'image/png'},{...valid,requestId:''},{...valid,mimeType:'application/pdf'}])assert.equal((await routes.request(request(input))).status,400)
  assert.equal(seen.length,1)
  assert.equal((await routes.request(request({action:'indexState'}))).status,200)
  assert.equal((await routes.request(request({action:'rebuildIndex',databaseIds:['db']}))).status,200)
  assert.equal((await routes.request(request({action:'rebuildIndex',baseURL:'https://example.com'}))).status,400)
})
