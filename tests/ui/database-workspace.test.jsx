import React from 'react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import {DatabaseWorkspace} from '../../src/DatabaseWorkspace.jsx'
import {createRpDatabaseApi} from '../../src/api.js'

const entry = {id:'entry-a',title:'灯塔',content:'旧正文',keywords:['港口'],tags:['地点'],notes:'旁白',readOnly:false,mode:'auto',version:1}
const database = {id:'db-a',name:'海港故事',version:1,entries:[entry]}
const other = {id:'db-b',name:'山城故事',version:1,entries:[{...entry,id:'entry-b',title:'山城'}]}
const clone = value => structuredClone(value)
const deferred = () => {let resolve; const promise = new Promise(done=>{resolve=done});return {promise,resolve}}
class Events {
  static instances=[]
  constructor(url){this.url=String(url);this.listeners={};this.closed=false;Events.instances.push(this)}
  addEventListener(type,handler){this.listeners[type]=handler}
  emit(type,sessionId='story-a'){this.listeners[type]?.({data:JSON.stringify({type,sessionId})})}
  close(){this.closed=true}
}

function fixture({empty=false}={}) {
  const dbs=new Map(empty?[]:[['db-a',clone(database)],['db-b',clone(other)]])
  const versions=new Map([...dbs].map(([id,db])=>[`${id}:1`,clone(db)]))
  const state={revision:3,databases:[],binding:null,retrieval:{embedding:{configured:false,model:null},reranking:{configured:false,model:null}}}
  const calls=[];const overrides={}
  const source={id:'source-a',rawText:'<script>globalThis.executed = true</script>\n{{macro}}',sha256:'abc123',format:'st-worldbook',provenance:{}}
  const list=()=>[...dbs.values()].map(db=>({id:db.id,name:db.name,version:db.version,entryCount:db.entries.length,sourceId:'source-a'}))
  const send=async(url,options)=>{
    const input=JSON.parse(options.body);calls.push({url:String(url),input,signal:options.signal})
    let result
    if(overrides[input.action]) result=await overrides[input.action](input,options)
    else if(input.action==='state')result={...clone(state),databases:list()}
    else if(input.action==='database')result={revision:state.revision,database:clone(versions.get(`${input.databaseId}:${input.version??dbs.get(input.databaseId)?.version}`))}
    else if(input.action==='source')result={source}
    else if(input.action==='import'||input.action==='create'){
      const db={id:'db-new',name:input.name??'导入世界书',version:1,entries:input.action==='create'?[]:[clone(entry)]}
      dbs.set(db.id,db);versions.set('db-new:1',db);state.revision++
      result={revision:state.revision,databaseId:db.id,version:1,sourceId:'source-a',diagnostics:[]}
    }else if(input.action==='save'){
      if(input.expectedRevision!==state.revision)return new Response(JSON.stringify({error:{code:'REVISION_CONFLICT',message:'版本冲突'}}),{status:409})
      const db={...clone(input.database),version:input.database.version+1};state.revision++
      dbs.set(db.id,db);versions.set(`${db.id}:${db.version}`,db)
      result={revision:state.revision,databaseId:db.id,version:db.version,sourceId:'source-a'}
    }else if(input.action==='bind'){
      state.revision++;state.binding={revision:state.revision,databaseId:input.databaseId,version:input.version,sourceId:'source-a',entries:clone(versions.get(`${input.databaseId}:${input.version}`).entries),notes:[],changes:[]}
      result={revision:state.revision,databaseId:input.databaseId,version:input.version,session:clone(state.binding)}
    }else if(input.action==='search')result={revision:state.revision,candidates:[{id:'entry-a',score:1,reasons:['keyword:港口']}],required:['entry-a'],degraded:['EMBEDDING_FAILED','RERANKING_UNCONFIGURED']}
    return new Response(JSON.stringify(result),{status:result?.error?409:200,headers:{'content-type':'application/json'}})
  }
  return {client:createRpDatabaseApi(send),calls,overrides,state,dbs,versions,source}
}
async function ready(f){render(<DatabaseWorkspace sessionId="story-a" client={f.client}/>);await screen.findByDisplayValue('海港故事')}
const click = name => fireEvent.click(screen.getByRole('button',{name,exact:true}))
beforeEach(()=>{Events.instances=[];vi.stubGlobal('EventSource',Events)})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})

describe('native database workspace',()=>{
  it('imports the exact raw source and displays the original only as inert readonly text',async()=>{
    const f=fixture({empty:true});render(<DatabaseWorkspace sessionId="story-a" client={f.client}/>)
    await screen.findByText('还没有数据库')
    const raw='\uFEFF{ "entries": {"1":{"content":"{{macro}}<script>x()</script>"}} }\n'
    fireEvent.change(screen.getByLabelText('SillyTavern 世界书 JSON'),{target:{value:raw}})
    click('导入 JSON')
    await screen.findByDisplayValue('导入世界书')
    expect(f.calls.find(call=>call.input.action==='import').input).toEqual({action:'import',rawText:raw,expectedRevision:3})
    click('查看只读原件')
    const viewer=await screen.findByLabelText('原始 JSON（只读）')
    expect(viewer).toHaveValue(f.source.rawText);expect(viewer).toHaveAttribute('readonly')
    expect(screen.getByText(/SHA-256 · abc123/)).toBeInTheDocument();expect(globalThis.executed).toBeUndefined()
  })
  it('lets a human edit an Agent-readonly entry and saves independent policy before explicitly binding the returned version',async()=>{
    const f=fixture();await ready(f)
    fireEvent.click(screen.getByLabelText('Agent 只读'))
    fireEvent.change(screen.getByLabelText('选材方式'),{target:{value:'required'}})
    expect(screen.getByLabelText('Agent 只读')).toBeChecked()
    fireEvent.change(screen.getByLabelText('选材方式'),{target:{value:'disabled'}})
    expect(screen.getByLabelText('Agent 只读')).toBeChecked()
    fireEvent.change(screen.getByLabelText('条目正文'),{target:{value:'人类修订正文'}})
    expect(screen.getByRole('button',{name:'应用到当前故事'})).toBeDisabled()
    click('保存新版本')
    await screen.findByText(/已保存 v2/)
    const saved=f.calls.find(call=>call.input.action==='save').input
    expect(saved.expectedRevision).toBe(3)
    expect(saved.database.entries[0]).toEqual({...entry,readOnly:true,mode:'disabled',content:'人类修订正文'})
    expect(f.calls.filter(call=>call.input.action==='bind')).toHaveLength(0)
    expect(screen.getByText(/会重置当前故事覆盖/)).toBeInTheDocument()
    click('应用到当前故事')
    await screen.findByText(/已应用 v2/)
    expect(f.calls.find(call=>call.input.action==='bind').input).toEqual({action:'bind',sessionId:'story-a',databaseId:'db-a',version:2,expectedRevision:4})
  })
  it('preserves a dirty draft and its base revision through SSE and conflict until explicit reload',async()=>{
    const f=fixture();await ready(f)
    fireEvent.change(screen.getByLabelText('条目正文'),{target:{value:'本地未保存'}})
    f.state.revision=9;f.dbs.get('db-a').version=2;f.versions.set('db-a:2',{...clone(database),version:2,entries:[{...entry,content:'远端正文'}]})
    act(()=>Events.instances[0].emit('changed'))
    await waitFor(()=>expect(f.calls.filter(call=>call.input.action==='state').length).toBeGreaterThan(1))
    f.overrides.save=()=>({error:{code:'REVISION_CONFLICT',message:'版本冲突'}})
    click('保存新版本')
    await screen.findByRole('alert')
    expect(f.calls.find(call=>call.input.action==='save').input.expectedRevision).toBe(3)
    expect(screen.getByLabelText('条目正文')).toHaveValue('本地未保存')
    click('重新载入数据库')
    await waitFor(()=>expect(screen.getByLabelText('条目正文')).toHaveValue('远端正文'))
  })
  it('can edit and save immediately after its own successful bind without a false revision conflict',async()=>{
    const f=fixture();await ready(f)
    click('应用到当前故事');await screen.findByText(/已应用 v1/)
    fireEvent.change(screen.getByLabelText('条目正文'),{target:{value:'应用后继续编辑'}})
    click('保存新版本');await screen.findByText(/已保存 v2/)
    expect(f.calls.find(call=>call.input.action==='save').input.expectedRevision).toBe(4)
  })
  it('does not announce save success while the response is pending',async()=>{
    const f=fixture();await ready(f);const hold=deferred();f.overrides.save=()=>hold.promise
    fireEvent.change(screen.getByLabelText('条目标题'),{target:{value:'等待保存'}});click('保存新版本')
    expect(screen.queryByText(/已保存 v/)).not.toBeInTheDocument()
    await act(async()=>hold.resolve({error:{code:'REVISION_CONFLICT',message:'保存未提交'}}))
    expect(screen.getByLabelText('条目标题')).toHaveValue('等待保存')
    expect(screen.queryByText(/已保存 v/)).not.toBeInTheDocument()
  })
  it('aborts requests and closes events on hide, switch and unmount, ignoring late prior-story data',async()=>{
    const f=fixture();const first=deferred();f.overrides.state=input=>input.sessionId==='story-a'?first.promise:{...f.state,databases:[{id:'db-b',name:'山城故事',version:1,entryCount:1}]}
    const view=render(<DatabaseWorkspace sessionId="story-a" client={f.client}/>)
    await waitFor(()=>expect(f.calls).toHaveLength(1));const initial=f.calls[0]
    view.rerender(<DatabaseWorkspace sessionId="story-b" client={f.client}/>)
    await screen.findByDisplayValue('山城故事');expect(initial.signal.aborted).toBe(true);expect(Events.instances[0].closed).toBe(true)
    await act(async()=>first.resolve({...f.state,databases:[{id:'db-a',name:'海港故事',version:1,entryCount:1}]}))
    expect(screen.getByLabelText('数据库名称')).toHaveValue('山城故事')
    view.rerender(<DatabaseWorkspace sessionId="story-b" visible={false} client={f.client}/>)
    expect(Events.instances[1].closed).toBe(true)
    view.rerender(<DatabaseWorkspace sessionId="story-b" client={f.client}/>);await waitFor(()=>expect(Events.instances).toHaveLength(3))
    view.unmount();expect(Events.instances[2].closed).toBe(true)
  })
  it('ignores a late import after the user selects another database',async()=>{
    const f=fixture();await ready(f);const hold=deferred();f.overrides.import=()=>hold.promise
    fireEvent.change(screen.getByLabelText('SillyTavern 世界书 JSON'),{target:{value:'{"entries":[]}'}});click('导入 JSON')
    click('山城故事 · v1 · 1 条')
    await screen.findByDisplayValue('山城故事')
    await act(async()=>hold.resolve({revision:4,databaseId:'db-a',version:1,sourceId:'source-a',diagnostics:[]}))
    expect(screen.getByLabelText('数据库名称')).toHaveValue('山城故事')
  })
  it('shows the current-story effective entries, notes and retrieval degradation',async()=>{
    const f=fixture();f.state.binding={revision:3,databaseId:'db-a',version:1,entries:[{...entry,content:'故事覆盖正文'}],notes:[{id:'entry-a',text:'临时线索'}],changes:[{anchor:'turn-a',operations:[{op:'update',id:'entry-a',patch:{content:'故事覆盖正文'}}]}]}
    await ready(f)
    click('当前故事内容与变更')
    expect(screen.getByText('故事覆盖正文')).toBeInTheDocument();expect(screen.getByText('临时线索')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('搜索条目'),{target:{value:'港口'}});click('搜索')
    await screen.findByText('keyword:港口')
    expect(within(screen.getByLabelText('搜索降级状态')).getByText('向量检索失败')).toBeInTheDocument()
    expect(within(screen.getByLabelText('搜索降级状态')).getByText('重排未配置')).toBeInTheDocument()
    expect(screen.getByLabelText('条目正文')).toHaveValue('旧正文')
  })
  it('preserves exact UTF-8 file text including BOM and CRLF when importing',async()=>{
    const f=fixture({empty:true});render(<DatabaseWorkspace sessionId="story-a" client={f.client}/>)
    await screen.findByText('还没有数据库')
    const raw='\uFEFF{ "entries": [] }\r\n'
    fireEvent.change(screen.getByLabelText('选择 JSON 文件'),{target:{files:[new File([raw],'worldbook.json',{type:'application/json'})]}})
    await waitFor(()=>expect(screen.getByLabelText('SillyTavern 世界书 JSON').value).toContain('entries'))
    click('导入 JSON');await screen.findByDisplayValue('导入世界书')
    expect(f.calls.find(call=>call.input.action==='import').input.rawText).toBe(raw)
  })
  it('ignores a late file read after text editing or database selection',async()=>{
    const readers=[]
    class Reader {constructor(){readers.push(this)}readAsArrayBuffer(){}finish(text){this.result=new TextEncoder().encode(text).buffer;this.onload()}}
    vi.stubGlobal('FileReader',Reader)
    const f=fixture();await ready(f)
    const file=new File(['ignored'],'delayed.json')
    fireEvent.change(screen.getByLabelText('选择 JSON 文件'),{target:{files:[file]}})
    fireEvent.change(screen.getByLabelText('SillyTavern 世界书 JSON'),{target:{value:'手动输入'}})
    act(()=>readers[0].finish('迟到文件'))
    expect(screen.getByLabelText('SillyTavern 世界书 JSON')).toHaveValue('手动输入')
    fireEvent.change(screen.getByLabelText('选择 JSON 文件'),{target:{files:[file]}})
    click('山城故事 · v1 · 1 条');await screen.findByDisplayValue('山城故事')
    act(()=>readers[1].finish('旧数据库的文件'))
    expect(screen.getByLabelText('SillyTavern 世界书 JSON')).toHaveValue('手动输入')
  })
  it('keeps the newly selected database after a late save receipt',async()=>{
    const f=fixture();await ready(f);const hold=deferred();f.overrides.save=()=>hold.promise
    fireEvent.change(screen.getByLabelText('条目正文'),{target:{value:'待提交'}});click('保存新版本')
    click('山城故事 · v1 · 1 条');click('放弃修改并切换');await screen.findByDisplayValue('山城故事')
    await act(async()=>hold.resolve({revision:4,databaseId:'db-a',version:2,sourceId:'source-a'}))
    expect(screen.getByLabelText('数据库名称')).toHaveValue('山城故事');expect(screen.queryByText(/已保存 v2/)).not.toBeInTheDocument()
  })
  it('does not show a saved status for an incomplete success response',async()=>{
    const f=fixture();await ready(f);f.overrides.save=()=>({revision:4})
    fireEvent.change(screen.getByLabelText('条目正文'),{target:{value:'仍需保存'}});click('保存新版本')
    await screen.findByRole('alert');expect(screen.getByLabelText('条目正文')).toHaveValue('仍需保存')
    expect(screen.queryByText(/已保存 v/)).not.toBeInTheDocument()
  })
  it('does not attach the previous database original to a newly created empty database',async()=>{
    const f=fixture();await ready(f)
    f.overrides.create=input=>{
      f.state.revision=4
      const created={id:'blank',name:input.name,version:1,entries:[]}
      f.dbs.set('blank',created);f.versions.set('blank:1',created)
      return {revision:4,databaseId:'blank',version:1}
    }
    fireEvent.change(screen.getByLabelText('新数据库名称'),{target:{value:'新数据库'}});click('新建空白数据库')
    await screen.findByDisplayValue('新数据库')
    expect(screen.queryByRole('button',{name:'查看只读原件'})).not.toBeInTheDocument()
    expect(screen.getByText('还没有条目')).toBeInTheDocument()
  })
  it('keeps unsaved source edits until they are saved or explicitly discarded',async()=>{
    const f=fixture();await ready(f)
    fireEvent.change(screen.getByLabelText('条目正文'),{target:{value:'保留我的修改'}})
    fireEvent.change(screen.getByLabelText('新数据库名称'),{target:{value:'另一个库'}})
    fireEvent.change(screen.getByLabelText('SillyTavern 世界书 JSON'),{target:{value:'{"entries":[]}'}})
    expect(screen.getByRole('button',{name:'新建空白数据库'})).toBeDisabled()
    expect(screen.getByRole('button',{name:'导入 JSON'})).toBeDisabled()
    click('山城故事 · v1 · 1 条')
    expect(screen.getByLabelText('条目正文')).toHaveValue('保留我的修改')
    click('继续编辑');expect(screen.getByLabelText('数据库名称')).toHaveValue('海港故事')
  })
})
