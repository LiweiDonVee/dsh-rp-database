import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDatabaseStore} from '../src/store.mjs'
import {createVectorIndex} from '../src/index-store.mjs'
import {retrievalDocument} from '../src/retrieval.mjs'

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'rp-db-index-hot-')),raw=createDatabaseStore({directory})
  t.after(()=>rm(directory,{recursive:true,force:true}))
  await raw.saveDatabase({id:'library',name:'Library',version:1,entries:[{id:'a',content:'alpha'},{id:'b',content:'beta'}]},{expectedRevision:0})
  const writes=[],calls=[],control={dimension:2,fail:false,onEmbed:()=>{}},count={changed:0}
  const store={...raw,cacheWrite:async(identity,dimension,rows,errorCode)=>{writes.push(structuredClone({identity,dimension,rows,errorCode}));return raw.cacheWrite(identity,dimension,rows,errorCode)}}
  const options={config:{baseURL:'https://synthetic.invalid/v1',model:'fixture'},embed:async texts=>{
    calls.push([...texts]);control.onEmbed()
    if(control.fail)throw Error('synthetic failure')
    return texts.map(()=>Array.from({length:control.dimension},(_value,index)=>Number(index===0)))
  },onChange:()=>count.changed++}
  const index=createVectorIndex({store,...options})
  const reset=()=>{writes.length=0;calls.length=0;count.changed=0}
  const query=async()=>{const entries=await raw.indexEntries();return index.embedEntries({query:'query',documents:entries.map(retrievalDocument),entries})}
  return{directory,raw,store,index,options,writes,calls,control,count,reset,query}
}

test('cold indexing writes its vectors once; 120 full cache hits do not write, notify or change the file',async t=>{
  const f=await fixture(t),revision=await f.raw.contentRevision()
  assert.deepEqual(await f.index.rebuild(),{indexedChunks:2,skippedChunks:0,diagnostics:[]})
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].rows.length,2);assert.equal(f.count.changed,1)
  const statePath=join(f.directory,'state.json'),before=await stat(statePath,{bigint:true})
  f.reset()
  for(let index=0;index<120;index++)assert.deepEqual(await f.index.rebuild(),{indexedChunks:0,skippedChunks:2,diagnostics:[]})
  assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);assert.equal(f.count.changed,0)
  assert.equal((await stat(statePath,{bigint:true})).mtimeNs,before.mtimeNs)
  assert.deepEqual(await f.raw.contentRevision(),revision)
  const reopened=createDatabaseStore({directory:f.directory}),coldWrites=[]
  const index=createVectorIndex({...f.options,store:{...reopened,cacheWrite:(...args)=>{coldWrites.push(args);return reopened.cacheWrite(...args)}}})
  await index.rebuild()
  assert.equal(coldWrites.length,0);assert.equal(f.calls.length,0)
})

test('an effective text change only sends its newly embedded row to the store',async t=>{
  const f=await fixture(t)
  await f.index.rebuild()
  const oldHashes=new Set(f.writes[0].rows.map(row=>row.hash)),database=await f.raw.database('library')
  database.entries[0].content='changed alpha'
  await f.raw.saveDatabase(database,{expectedRevision:1});f.reset()
  assert.deepEqual(await f.index.rebuild(),{indexedChunks:1,skippedChunks:1,diagnostics:[]})
  assert.deepEqual(f.calls.map(rows=>rows.length),[1])
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].rows.length,1)
  assert.equal(oldHashes.has(f.writes[0].rows[0].hash),false)
  const state=JSON.parse(await readFile(join(f.directory,'state.json'),'utf8')),provider=Object.values(state.vectorIndex.providers)[0]
  assert.equal(state.vectorIndex.schemaVersion,1)
  assert.equal(Object.keys(provider.dimensions[2]).length,3)
  assert.equal(Object.hasOwn(provider,'activeDimension'),false)
})

test('a cached success clears one recorded error without resending old vectors, then stays read-only',async t=>{
  const f=await fixture(t)
  await f.index.rebuild();f.control.fail=true
  await assert.rejects(f.query(),/synthetic failure/u)
  assert.equal((await f.index.state()).lastErrorCode,'EMBEDDING_FAILED')
  f.control.fail=false;f.reset()
  await f.index.rebuild()
  assert.equal(f.calls.length,0)
  assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].rows,[]);assert.equal(f.writes[0].dimension,2)
  assert.equal(f.count.changed,1)
  assert.equal((await f.index.state()).lastErrorCode,undefined)
  f.reset();await f.index.rebuild()
  assert.equal(f.writes.length,0);assert.equal(f.count.changed,0)
})

test('switching back to an existing dimension changes activity without embedding or uploading cached documents',async t=>{
  const f=await fixture(t)
  await f.query();const identity=f.writes[0].identity
  f.control.dimension=3;await f.query()
  const selected=await f.raw.cacheRead(identity,2,[])
  assert.equal(selected.dimension,2);assert.equal(selected.activeDimension,3)
  f.control.dimension=2;f.reset()
  const vectors=await f.query()
  assert.deepEqual(f.calls,[['query']])
  assert.ok(vectors.every(vector=>vector.length===2))
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].dimension,2);assert.deepEqual(f.writes[0].rows,[])
  assert.equal(f.count.changed,1)
  const after=await f.raw.cacheRead(identity,3,[])
  assert.equal(after.dimension,3);assert.equal(after.activeDimension,2)
  f.reset();await f.query()
  assert.deepEqual(f.calls,[['query']]);assert.equal(f.writes.length,0);assert.equal(f.count.changed,0)
})

test('a newly discovered dimension rebuilds cached documents in the existing missing-then-other order',async t=>{
  const f=await fixture(t)
  await f.index.rebuild()
  const database=await f.raw.database('library')
  database.entries.push({id:'c',content:'gamma'})
  await f.raw.saveDatabase(database,{expectedRevision:1})
  f.control.dimension=3;f.reset()
  assert.deepEqual(await f.index.rebuild(),{indexedChunks:3,skippedChunks:0,diagnostics:[]})
  assert.deepEqual(f.calls.map(rows=>rows.length),[1,2])
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].rows.length,3)
  assert.ok(f.writes[0].rows.every(row=>row.vector.length===3))
})

test('cancellation after embedding or a cached read never writes vectors, errors or changed notifications',async t=>{
  const f=await fixture(t),abort=new AbortController()
  f.control.onEmbed=()=>abort.abort()
  await assert.rejects(f.index.rebuild({signal:abort.signal}),{name:'AbortError'})
  assert.equal(f.writes.length,0);assert.equal(f.count.changed,0)
  f.control.onEmbed=()=>{};await f.index.rebuild();f.reset()
  const second=new AbortController(),cacheRead=f.store.cacheRead
  f.store.cacheRead=async(...args)=>{const value=await cacheRead(...args);second.abort();return value}
  await assert.rejects(f.index.rebuild({signal:second.signal}),{name:'AbortError'})
  assert.equal(f.writes.length,0);assert.equal(f.count.changed,0)
  assert.equal((await f.index.state()).lastErrorCode,undefined)
})
