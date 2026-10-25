import test from 'node:test'
import assert from 'node:assert/strict'

const ref=(sourceKey,entryId)=>({sourceKey,entryId})
const view=(sourceKey,id,content,extra={})=>({id,title:id,content,keywords:[],tags:[],notes:'',readOnly:false,mode:'auto',version:1,ref:ref(sourceKey,id),...extra})
async function module(){const value=await import('../src/references.mjs').catch(()=>({}));assert.equal(typeof value.applyScopedOperations,'function','qualified operation kernel is available');return value}

test('qualified keys round trip unusual IDs without aliasing two source slots',async()=>{
  const {entryKey,parseEntryKey}=await module()
  assert.equal(entryKey(ref('world','0')),'["world","0"]')
  assert.equal(entryKey(ref('actor','0')),'["actor","0"]')
  assert.deepEqual(parseEntryKey('["a\\\"b","../0"]'),ref('a"b','../0'))
  for(const invalid of ['0','["world"]','{"sourceKey":"world","entryId":"0"}','["world","0",1]'])assert.throws(()=>parseEntryKey(invalid),{code:'INVALID_REFERENCE'})
  assert.throws(()=>entryKey({...ref('world','0'),owner:'fact'}),{code:'INVALID_REFERENCE'})
})

test('qualified operations preserve same raw IDs and add only to the session slot',async()=>{
  const {applyScopedOperations}=await module()
  const original=[view('world','0','world'),view('actor','0','actor')]
  const result=applyScopedOperations(original,[{op:'update',ref:ref('actor','0'),patch:{content:'actor changed'}},{op:'add',entry:{id:'0',content:'local'}}])
  assert.deepEqual(result.entries.map(entry=>[entry.ref,entry.content]),[[ref('world','0'),'world'],[ref('actor','0'),'actor changed'],[ref('@session','0'),'local']])
  assert.equal(result.entries[1].version,2)
  assert.equal(original[1].content,'actor')
  assert.throws(()=>applyScopedOperations(original,[{op:'add',sourceKey:'world',entry:{id:'new'}}]),{code:'INVALID_OPERATION'})
})

test('qualified selection unions required refs and cannot bypass disabled or readonly policies',async()=>{
  const {applyScopedOperations,selectScopedEntries}=await module()
  const entries=[view('world','0','rule',{mode:'required',readOnly:true}),view('actor','0','actor'),view('actor','off','secret',{mode:'disabled'})]
  assert.deepEqual(selectScopedEntries(entries,[ref('actor','0')]).map(item=>item.ref),[ref('actor','0'),ref('world','0')])
  assert.throws(()=>selectScopedEntries(entries,[ref('actor','off')]),{code:'DISABLED'})
  assert.throws(()=>applyScopedOperations(entries,[{op:'update',ref:ref('actor','0'),patch:{content:'partial'}},{op:'note',ref:ref('world','0'),text:'blocked'}]),{code:'READ_ONLY'})
  assert.equal(entries[1].content,'actor')
})
