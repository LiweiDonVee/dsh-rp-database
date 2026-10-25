import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {importDatabase} from '../src/core.mjs'
import {createDatabaseStore} from '../src/store.mjs'

test('native ST worldbook keeps disabled/constants, display order, Unicode and UID zero with exact source text',()=>{
  const raw='\uFEFF'+JSON.stringify({name:'海港世界',entries:{0:{uid:0,comment:'灯塔',key:['灯塔'],keysecondary:['港口'],content:'灯塔正文',constant:true,disable:true,displayIndex:2},7:{uid:7,comment:'守卫',key:['卫兵'],content:'守卫正文',displayIndex:1,extensions:{script:'throw new Error()'}}}},null,2)+'\r\n'
  const result=importDatabase(raw)
  assert.deepEqual(result.database.entries.map(entry=>entry.id),['7','0'])
  assert.equal(result.database.entries[1].mode,'disabled')
  assert.equal(result.database.entries[1].readOnly,false)
  assert.equal(result.source.rawText,raw)
  assert.equal(result.source.sha256,createHash('sha256').update(raw).digest('hex'))
  assert.equal(result.source.importReport.entryRefs.find(ref=>ref.id==='0').path,'entries.0')
  assert.equal(result.source.provenance.entries['7'].extensions.script,'throw new Error()')
  const zeroOrder=importDatabase(JSON.stringify({entries:{0:{uid:0,content:'x',order:0}}}))
  assert.equal(zeroOrder.source.importReport.entryRefs[0].insertionOrder,0)
})

test('standalone character books and V2/V3 character JSON extract the embedded worldbook without importing card instructions',()=>{
  const book={name:'内嵌世界',description:'来源说明',entries:[{id:0,name:'旧信',comment:'短标题',keys:['旧信'],secondary_keys:['档案'],content:'信中的事实',enabled:true,constant:true,insertion_order:250,extensions:{position:4,depth:3}},{keys:['门'],content:'门没有打开',enabled:false}]}
  for(const value of[book,{character_book:book,name:'人物'},{spec:'chara_card_v2',spec_version:'2.0',data:{name:'人物',system_prompt:'CARD_INSTRUCTIONS_NOT_DATABASE',character_book:book}},{spec:'chara_card_v3',spec_version:'3.0',data:{name:'人物',character_book:book}}]){
    const result=importDatabase(JSON.stringify(value))
    assert.equal(result.database.name,'内嵌世界')
    assert.deepEqual(result.database.entries.map(entry=>entry.id),['0','1'])
    assert.equal(result.database.entries[0].title,'短标题')
    assert.deepEqual(result.database.entries[0].keywords,['旧信','档案'])
    assert.equal(result.database.entries[0].mode,'required')
    assert.equal(result.database.entries[1].mode,'disabled')
    assert.doesNotMatch(JSON.stringify(result.database),/CARD_INSTRUCTIONS_NOT_DATABASE/u)
    assert.equal(result.source.importReport.entryRefs.length,2)
  }
})

test('unsupported ST activation behavior is explicitly reported, and negative keys never become positive retrieval hints',()=>{
  const result=importDatabase(JSON.stringify({name:'逻辑条目',scan_depth:5,entries:{x:{uid:4,comment:'线索',key:['港口','/雨.+/i'],keysecondary:['排除词'],selective:true,selectiveLogic:2,content:'只保留 {{char}} 的原文。',probability:35,useProbability:true,group:'互斥组',excludeRecursion:true,sticky:3,cooldown:2,delay:1,caseSensitive:true,forbid_overrides:true,position:4,depth:2}}}))
  assert.deepEqual(result.database.entries[0].keywords,['港口','/雨.+/i'])
  assert.equal(result.database.entries[0].content,'只保留 {{char}} 的原文。')
  assert.equal(result.database.entries[0].readOnly,false)
  const codes=result.diagnostics.map(item=>item.code)
  for(const code of['ST_ACTIVATION_LOGIC','ST_REGEX_KEYS','ST_MACROS_LITERAL','ST_TIMED_EFFECTS','ST_PROBABILITY','ST_RECURSION','ST_INSERTION','ST_MATCH_OPTIONS','ST_AUTHOR_LOCK','ST_BOOK_SETTINGS'])assert.ok(codes.includes(code),code)
  assert.ok(result.diagnostics.every(item=>typeof item.message==='string'&&item.message.length>0))
  assert.deepEqual(result.source.importReport.diagnostics,result.diagnostics)
})

test('ST array exports do not steal native database arrays or silently accept mixed/invalid entry formats',()=>{
  assert.equal(importDatabase(JSON.stringify({entries:[{uid:8,key:['灯塔'],content:'source',constant:true}]})).database.entries[0].id,'8')
  const native=importDatabase(JSON.stringify({name:'native',entries:[{id:'mine',content:'body',readOnly:true,mode:'required',notes:'note'}]}))
  assert.equal(native.source.format,'rp-database')
  assert.equal(native.database.entries[0].readOnly,true)
  assert.equal(native.database.entries[0].notes,'note')
  assert.throws(()=>importDatabase(JSON.stringify({entries:[{id:'native',content:'a',mode:'auto'},{uid:3,key:['x'],content:'b'}]})),{code:'INVALID_DATA'})
  assert.throws(()=>importDatabase(JSON.stringify({entries:{a:{uid:1,content:'a'},b:{uid:1,content:'b'}}})),{code:'DUPLICATE_ID'})
  assert.throws(()=>importDatabase(JSON.stringify({entries:{a:{uid:{unsafe:1},content:'a'}}})),{code:'INVALID_DATA'})
  assert.throws(()=>importDatabase(JSON.stringify({spec:'chara_card_v2',data:{name:'没有内嵌世界书'}})),{code:'WORLD_BOOK_NOT_FOUND'})
})

test('import report survives restart and source edits without mutating the original or pinned story',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'st-worldbook-import-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const raw=JSON.stringify({entries:{0:{uid:0,comment:'线索',key:['信'],content:'原文',constant:true,probability:50}}})
  const store=createDatabaseStore({directory}),imported=await store.importSource(raw,{name:'导入名称',expectedRevision:0})
  await store.bindSession('story',{databaseId:imported.databaseId,version:1,expectedRevision:imported.revision})
  const database=await store.database(imported.databaseId);database.entries[0].content='人类新版'
  await store.saveDatabase(database,{expectedRevision:2})
  const reopened=createDatabaseStore({directory}),source=await reopened.source(imported.sourceId)
  assert.equal(source.rawText,raw)
  assert.ok(source.importReport.diagnostics.some(item=>item.code==='ST_PROBABILITY'))
  assert.equal((await reopened.session('story')).entries[0].content,'原文')
})
