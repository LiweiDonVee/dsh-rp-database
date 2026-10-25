import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createDatabaseStore} from '../src/store.mjs'

const ref=(sourceKey,entryId)=>({sourceKey,entryId})
const entry=(id,content)=>({id,title:id,content,keywords:[],tags:[],notes:'',readOnly:false,mode:'auto',version:1})
const hash=value=>createHash('sha256').update(value).digest('hex')
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'rp-db-v2-'));t.after(()=>rm(directory,{recursive:true,force:true}));return{directory,store:createDatabaseStore({directory})}}
async function sources(store){
  const world=await store.importSource(JSON.stringify({name:'World',entries:[entry('0','world')]}),{expectedRevision:0})
  const actor=await store.importSource(JSON.stringify({name:'Actor',entries:[entry('0','actor')]}),{expectedRevision:world.revision})
  return[{key:'world',databaseId:world.databaseId,version:1},{key:'actor',databaseId:actor.databaseId,version:1}]
}

test('two pinned sources with raw id zero remain distinct across restart and detached reads',async t=>{
  const {store,directory}=await fixture(t),bindings=await sources(store)
  assert.equal(typeof store.bindSources,'function','v2 bindings are available')
  await store.bindSources('story',{sources:bindings,expectedRevision:2,resetOverlay:false})
  const first=await store.sessionV2('story')
  assert.deepEqual(first.binding,{schemaVersion:2,sources:bindings,factEntryRefs:[]})
  assert.deepEqual(first.entries.map(value=>[value.ref,value.content,value.sourceVersion]),[[ref('world','0'),'world',1],[ref('actor','0'),'actor',1]])
  first.entries[0].content='outside mutation';first.binding.sources[0].key='bad'
  assert.equal((await createDatabaseStore({directory}).sessionV2('story')).entries[0].content,'world')
  await assert.rejects(store.session('story'),{code:'QUALIFIED_REFERENCE_REQUIRED'})
})

test('v1 migration preserves exact source, baseline and anchored legacy additions without flattening',async t=>{
  const {store,directory}=await fixture(t)
  const rawText='\uFEFF{"name":"Old","entries":[]}\r\n',baseline=[entry('0','original')]
  const changes=[{id:'change-A',anchor:'A',operations:[{op:'update',id:'0',patch:{content:'A'}},{op:'add',entry:entry('old-add','old local')}]},{id:'change-B',anchor:'B',operations:[{op:'update',id:'0',patch:{content:'B'}}]}]
  const source={id:'source-old',rawText,sha256:hash(rawText),format:'rp-database',provenance:{name:'Old',entries:[]}}
  await writeFile(join(directory,'state.json'),JSON.stringify({schemaVersion:1,revision:7,databases:{[hash('db-old')]:{versions:[{database:{id:'db-old',name:'Old',version:1,entries:baseline},sourceId:source.id}]}},sources:{[hash(source.id)]:source},sessions:{[hash('parent')]:{id:'parent',databaseId:'db-old',version:1,sourceId:source.id,baseline,baselineNotes:[],reservedIds:['0','old-add'],changes}}}))
  assert.equal(typeof store.sessionV2,'function','v1 files have a qualified read path')
  const active=await store.sessionV2('parent',{activeAnchors:['A'],currentAnchor:'A'})
  assert.deepEqual(active.entries.map(value=>[value.ref,value.content]),[[ref('legacy','0'),'A'],[ref('legacy','old-add'),'old local']])
  assert.equal(active.revision,7)
  assert.deepEqual((await store.sessionV2('parent',{activeAnchors:[]})).entries.map(value=>value.content),['original'])
  assert.deepEqual((await store.session('parent',{activeAnchors:['A']})).changes[0].operations,changes[0].operations)
  assert.deepEqual(await store.source(source.id),source)
  await store.forkSession('parent','child',{activeAnchors:['A'],expectedRevision:7})
  assert.deepEqual((await store.sessionV2('child',{activeAnchors:[]})).entries.map(value=>value.content),['original'])
  const persisted=JSON.parse(await readFile(join(directory,'state.json'),'utf8'))
  assert.equal(persisted.schemaVersion,2)
  assert.equal((await store.source(source.id)).rawText,rawText)
})

test('qualified fork keeps A but excludes B and can rewind before inherited A',async t=>{
  const {store}=await fixture(t),bindings=await sources(store)
  assert.equal(typeof store.bindSources,'function','qualified causal binding is available')
  await store.bindSources('parent',{sources:bindings,expectedRevision:2,resetOverlay:false})
  await store.applyOperationsV2('parent',[{op:'update',ref:ref('world','0'),patch:{content:'A'}}],{expectedRevision:3,anchor:'A'})
  await store.applyOperationsV2('parent',[{op:'update',ref:ref('world','0'),patch:{content:'B'}}],{expectedRevision:4,anchor:'B'})
  await store.forkSession('parent','child',{activeAnchors:['A'],expectedRevision:5})
  assert.deepEqual((await store.sessionV2('child',{activeAnchors:['A']})).entries.map(value=>value.content),['A','actor'])
  assert.deepEqual((await store.sessionV2('child',{activeAnchors:[]})).entries.map(value=>value.content),['world','actor'])
})

test('compatible source rebind retains changes and destructive rebind is an explicit owner reset',async t=>{
  const {store}=await fixture(t),bindings=await sources(store)
  assert.equal(typeof store.bindSources,'function','safe source rebind is available')
  await store.bindSources('story',{sources:bindings,expectedRevision:2,resetOverlay:false})
  await store.applyOperationsV2('story',[{op:'update',ref:ref('world','0'),patch:{content:'changed'}}],{expectedRevision:3,anchor:'A'})
  await store.bindSources('story',{sources:[bindings[1],bindings[0]],expectedRevision:4,resetOverlay:false})
  assert.deepEqual((await store.sessionV2('story')).entries.map(value=>value.content),['actor','changed'])
  await assert.rejects(store.bindSources('story',{sources:[bindings[1]],expectedRevision:5,resetOverlay:false}),{code:'BINDING_CHANGE_REQUIRES_RESET'})
  assert.equal((await store.snapshot()).revision,5)
  await store.bindSources('story',{sources:[bindings[1]],expectedRevision:5,resetOverlay:true})
  assert.deepEqual((await store.sessionV2('story')).changes,[])
  for(const invalid of [[{...bindings[0],key:'@session'}],[bindings[0],bindings[0]]])await assert.rejects(store.bindSources('bad',{sources:invalid,expectedRevision:6,resetOverlay:false}),{code:'INVALID_BINDING'})
})

test('legacy additions remain in their source iteration slot after adding another source',async t=>{
  const {store}=await fixture(t),bindings=await sources(store)
  await store.bindSession('story',{databaseId:bindings[0].databaseId,version:1,expectedRevision:2})
  await store.applyOperations('story',[{op:'add',entry:{id:'legacy-add',content:'old API addition'}}],{anchor:'A',expectedRevision:3})
  await store.bindSources('story',{sources:[{...bindings[0],key:'legacy'},bindings[1]],expectedRevision:4,resetOverlay:false})
  assert.deepEqual((await store.sessionV2('story')).entries.map(value=>value.ref),[ref('legacy','0'),ref('legacy','legacy-add'),ref('actor','0')])
})

test('legacy single-source reads retain the correct original source ID after a compatible rebind',async t=>{
  const {store}=await fixture(t),bindings=await sources(store),metadata=await store.snapshot()
  await store.bindSources('story',{sources:[bindings[0]],expectedRevision:2,resetOverlay:false})
  assert.equal((await store.session('story')).sourceId,metadata.databases[0].sourceId)
  await store.bindSources('story',{sources:[bindings[1]],expectedRevision:3,resetOverlay:false})
  assert.equal((await store.session('story')).sourceId,metadata.databases[1].sourceId)
})
