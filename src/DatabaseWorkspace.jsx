import React, {useCallback, useEffect, useRef, useState} from 'react'
import {createRpDatabaseApi} from './api.js'

const defaultApi = createRpDatabaseApi()
const clone = value => JSON.parse(JSON.stringify(value))
const modes = {auto:'自动', required:'必开', disabled:'禁用'}
const positive = value => Number.isSafeInteger(value) && value > 0
const revision = value => Number.isSafeInteger(value) && value >= 0
const degradation = code => ({EMBEDDING_UNCONFIGURED:'向量检索未配置', EMBEDDING_FAILED:'向量检索失败', RERANKING_UNCONFIGURED:'重排未配置', RERANKING_FAILED:'重排失败'}[String(code).toUpperCase()] ?? String(code))

export function DatabaseIcon({size = 18}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></svg>
}

async function request(scope, work) {
  const controller = new AbortController()
  scope.controllers.add(controller)
  try { return await work(controller.signal) }
  finally { scope.controllers.delete(controller) }
}

export function DatabaseWorkspace({sessionId, visible = true, client = defaultApi}) {
  return <section className="rpdb" data-rp-database-session={sessionId ?? ''} hidden={!visible} aria-label="故事数据库工作区"><SessionWorkspace key={sessionId ?? ''} sessionId={sessionId} visible={visible} client={client}/></section>
}

function StoryView({binding}) {
  const [expanded, setExpanded] = useState(false)
  return <section className="rpdb-story">
    <button type="button" className="rpdb-disclosure" aria-label="当前故事内容与变更" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>当前故事内容与变更 <span>{expanded?'收起':'展开'}</span></button>
    {expanded && <div className="rpdb-story-body">
      <p className="rpdb-help">以下是当前故事的有效内容，包含继承和 Agent 覆盖。</p>
      {binding.entries?.map(item=><article key={item.id} className="rpdb-effective"><div className="rpdb-section-title"><strong>{item.title || '未命名条目'}</strong><span className="rpdb-badge">{modes[item.mode]}{item.readOnly?' · Agent 只读':''}</span></div><pre>{item.content}</pre>{item.notes&&<p>{item.notes}</p>}</article>)}
      {!binding.entries?.length&&<p className="rpdb-help">当前故事没有有效条目。</p>}
      <h4>临时叙事备注</h4>{binding.notes?.length?binding.notes.map((note,index)=><p key={`${note.id}-${index}`}>{note.text}</p>):<p className="rpdb-help">暂无临时备注</p>}
      <details className="rpdb-details"><summary>覆盖变更 · {binding.changes?.length ?? 0} 项</summary><pre>{JSON.stringify(binding.changes ?? [],null,2)}</pre></details>
    </div>}
  </section>
}

function SessionWorkspace({sessionId, visible, client}) {
  const [state,setState] = useState(null)
  const stateRef = useRef(null)
  const [draft,setDraft] = useState(null)
  const draftRef = useRef(null)
  const [entryId,setEntryId] = useState(null)
  const [busy,setBusy] = useState('')
  const [error,setError] = useState('')
  const [conflict,setConflict] = useState('')
  const [notice,setNotice] = useState('')
  const [transportError,setTransportError] = useState('')
  const [pending,setPending] = useState(null)
  const [newName,setNewName] = useState('')
  const [importName,setImportName] = useState('')
  const [importText,setImportText] = useState('')
  const [diagnostics,setDiagnostics] = useState([])
  const [source,setSource] = useState(null)
  const [sourceBusy,setSourceBusy] = useState(false)
  const [query,setQuery] = useState('')
  const [results,setResults] = useState(null)
  const [searchBusy,setSearchBusy] = useState(false)
  const lifecycle = useRef(null)
  const selection = useRef(0)
  const fileSequence = useRef(0)
  const sourceSequence = useRef(0)
  const searchSequence = useRef(0)
  const formRevision = useRef({create:null,import:null})
  const attempted = useRef(false)
  const valid = (scope, sequence) => scope?.active && lifecycle.current === scope && (sequence === undefined || selection.current === sequence)

  const acceptDraft = useCallback((database,baseRevision,sourceId,report) => {
    const next = {database:clone(database),baseRevision,sourceId,dirty:false}
    draftRef.current=next;setDraft(next);setEntryId(database.entries[0]?.id ?? null)
    setSource(null);setSourceBusy(false);setPending(null);setConflict('');setError('')
    setDiagnostics(report?.diagnostics ?? [])
  },[])

  const refresh = useCallback(scope => {
    if (!scope?.active) return Promise.resolve(null)
    if (scope.refreshing) {scope.again=true;return scope.refreshing}
    scope.refreshing = (async()=>{
      do {
        scope.again=false
        try {
          const next=await request(scope,signal=>client.state(sessionId,signal))
          if (!scope.active) break
          if (!revision(next.revision) || !Array.isArray(next.databases)) throw new Error('数据库列表响应不完整。')
          if (next.revision >= scope.minimum && next.revision >= (stateRef.current?.revision ?? 0)) {
            stateRef.current=next;setState(next);setTransportError('')
          }
        } catch (failure) {if(scope.active && failure.name!=='AbortError')setTransportError(failure.message)}
      } while(scope.active && scope.again)
      return stateRef.current
    })().finally(()=>{scope.refreshing=null})
    return scope.refreshing
  },[client,sessionId])

  useEffect(()=>{
    if (!visible) return
    const scope={active:true,controllers:new Set(),minimum:stateRef.current?.revision ?? 0,refreshing:null,again:false}
    lifecycle.current=scope
    setBusy('');setSourceBusy(false);setSearchBusy(false)
    if (!draftRef.current) attempted.current=false
    void refresh(scope)
    let close
    if (sessionId) {
      try {close=client.subscribe(sessionId,()=>{if(scope.active)void refresh(scope)},()=>{if(scope.active)setTransportError('实时同步连接已断开，可刷新数据库列表。')})}
      catch (failure) {setTransportError(failure.message || '实时同步暂不可用。')}
    }
    return ()=>{scope.active=false;for(const controller of scope.controllers)controller.abort();close?.();++fileSequence.current;++sourceSequence.current;++searchSequence.current}
  },[client,refresh,sessionId,visible])

  const openDatabase = useCallback(async(id,version) => {
    const scope=lifecycle.current
    if (!scope?.active) return
    const sequence=++selection.current
    ++fileSequence.current;++sourceSequence.current
    setSource(null);setSourceBusy(false);setBusy('load');setNotice('');setError('');setConflict('')
    try {
      const result=await request(scope,signal=>client.database(id,version,signal))
      if (!scope.active || selection.current!==sequence) return
      if (result.database?.id!==id || !positive(result.database.version) || !Array.isArray(result.database.entries) || !revision(result.revision)) throw new Error('数据库版本响应不完整，请重新载入。')
      const metadata=stateRef.current?.databases.find(item=>item.id===id)
      acceptDraft(result.database,result.revision,metadata?.sourceId,result.importReport)
    } catch (failure) {if(scope.active && selection.current===sequence && failure.name!=='AbortError')setError(failure.message)}
    finally {if(scope.active && selection.current===sequence)setBusy('')}
  },[acceptDraft,client])

  useEffect(()=>{
    if(!visible || !state || draftRef.current || busy || attempted.current || !state.databases.length)return
    attempted.current=true
    const initial=state.databases.find(item=>item.id===state.binding?.databaseId) ?? state.databases[0]
    void openDatabase(initial.id,initial.version)
  },[state,busy,visible,openDatabase])

  function selectDatabase(id,version) {
    if(draftRef.current?.dirty){setPending({id,version});return}
    void openDatabase(id,version)
  }
  function edit(change) {
    if(!draftRef.current || busy)return
    const next={...draftRef.current,database:change(draftRef.current.database),dirty:true}
    draftRef.current=next;setDraft(next);setNotice('')
  }
  function editEntry(patch) {edit(value=>({...value,entries:value.entries.map(item=>item.id===entryId?{...item,...patch}:item)}))}
  function captureForm(kind) {if(formRevision.current[kind]===null)formRevision.current[kind]=stateRef.current?.revision ?? null}

  async function perform(kind,work) {
    const scope=lifecycle.current,sequence=selection.current
    if(!valid(scope) || busy)return
    setBusy(kind);setError('');setNotice('');setConflict('')
    try {await work(scope,sequence)}
    catch(failure){
      if(valid(scope,sequence) && failure.name!=='AbortError'){
        setError(failure.message || '操作失败，草稿已保留。')
        if(failure.status===409 || failure.code==='REVISION_CONFLICT')setConflict(kind)
      }
    } finally {if(valid(scope,sequence))setBusy('')}
  }
  async function receiveVersion(scope,sequence,result) {
    if(!valid(scope,sequence))return false
    if(!revision(result.revision) || !result.databaseId || !positive(result.version))throw new Error('未收到完整的已保存版本，请重新载入数据库核对。')
    scope.minimum=Math.max(scope.minimum,result.revision)
    const saved=await request(scope,signal=>client.database(result.databaseId,result.version,signal))
    if(!valid(scope,sequence))return false
    if(saved.database?.id!==result.databaseId || saved.database.version!==result.version || !Array.isArray(saved.database.entries))throw new Error('版本已写入，但读取失败；请重新载入数据库核对。')
    acceptDraft(saved.database,result.revision,result.sourceId ?? (draftRef.current?.database.id===result.databaseId?draftRef.current.sourceId:undefined),saved.importReport)
    return true
  }
  function save() {
    const captured=draftRef.current
    if(!captured?.dirty)return
    void perform('save',async(scope,sequence)=>{
      const result=await request(scope,signal=>client.save(captured.database,captured.baseRevision,signal))
      if(!await receiveVersion(scope,sequence,result))return
      setNotice(`已保存 v${result.version}。应用后才会更新当前故事。`)
      await refresh(scope)
    })
  }
  function create() {
    if(!newName.trim() || !stateRef.current || draftRef.current?.dirty)return
    void perform('create',async(scope,sequence)=>{
      const result=await request(scope,signal=>client.create(newName.trim(),formRevision.current.create ?? stateRef.current.revision,signal))
      if(!await receiveVersion(scope,sequence,result))return
      setNewName('');formRevision.current.create=null;setDiagnostics([]);setNotice('已新建空白数据库。添加条目后保存新版本。');await refresh(scope)
    })
  }
  function importDatabase() {
    if(!importText.trim() || !stateRef.current || draftRef.current?.dirty)return
    void perform('import',async(scope,sequence)=>{
      const result=await request(scope,signal=>client.import(importText,{expectedRevision:formRevision.current.import ?? stateRef.current.revision,...(importName.trim()?{name:importName.trim()}:{})},signal))
      if(!await receiveVersion(scope,sequence,result))return
      setDiagnostics(result.diagnostics ?? []);formRevision.current.import=null;setNotice(`已导入 v${result.version}。请核对条目与选材方式。`);await refresh(scope)
    })
  }
  async function readFile(file) {
    const scope=lifecycle.current,sequence=selection.current,token=++fileSequence.current
    if(!file || !valid(scope))return
    captureForm('import')
    try {
      const bytes=await new Promise((resolve,reject)=>{
        const reader=new FileReader()
        reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取 JSON 文件，请重试。'))
        reader.readAsArrayBuffer(file)
      })
      if(valid(scope,sequence) && token===fileSequence.current)setImportText(new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes))
    }catch(failure){if(valid(scope,sequence) && token===fileSequence.current)setError(failure.message)}
  }
  async function viewSource() {
    const scope=lifecycle.current,sequence=selection.current,sourceId=draftRef.current?.sourceId,token=++sourceSequence.current
    if(!sourceId || !valid(scope))return
    setSourceBusy(true);setError('')
    try{
      const result=await request(scope,signal=>client.source(sourceId,signal))
      if(!valid(scope,sequence) || token!==sourceSequence.current)return
      if(typeof result.source?.rawText!=='string' || typeof result.source?.sha256!=='string')throw new Error('原件响应不完整。')
      setSource(result.source)
    }catch(failure){if(valid(scope,sequence) && token===sourceSequence.current && failure.name!=='AbortError')setError(failure.message)}
    finally{if(valid(scope,sequence) && token===sourceSequence.current)setSourceBusy(false)}
  }
  function bind() {
    const captured=draftRef.current
    if(!sessionId || !captured || captured.dirty)return
    void perform('bind',async(scope,sequence)=>{
      const result=await request(scope,signal=>client.bind(sessionId,{databaseId:captured.database.id,version:captured.database.version,expectedRevision:stateRef.current.revision},signal))
      if(!valid(scope,sequence))return
      if(!revision(result.revision) || result.databaseId!==captured.database.id || result.version!==captured.database.version || !result.session)throw new Error('应用响应不完整，请刷新当前故事核对。')
      scope.minimum=Math.max(scope.minimum,result.revision)
      if(draftRef.current===captured && !captured.dirty){
        const next={...captured,baseRevision:result.revision};draftRef.current=next;setDraft(next)
      }
      setNotice(`已应用 v${result.version} 到当前故事。`);await refresh(scope)
    })
  }
  async function search() {
    const scope=lifecycle.current,token=++searchSequence.current
    if(!sessionId || !query.trim() || !valid(scope))return
    setSearchBusy(true);setResults(null);setError('')
    try{
      const result=await request(scope,signal=>client.search(sessionId,query,signal))
      if(valid(scope) && token===searchSequence.current){
        if(!Array.isArray(result.candidates) || !Array.isArray(result.required) || !Array.isArray(result.degraded))throw new Error('搜索响应不完整。')
        setResults(result)
      }
    }catch(failure){if(valid(scope) && token===searchSequence.current && failure.name!=='AbortError')setError(failure.message)}
    finally{if(valid(scope) && token===searchSequence.current)setSearchBusy(false)}
  }
  async function updateFormRevision() {
    const scope=lifecycle.current,sequence=selection.current,kind=conflict
    const next=await refresh(scope)
    if(valid(scope,sequence) && next){formRevision.current[kind]=next.revision;setConflict('');setError('');setNotice('表单已使用最新修订，输入内容已保留。请再次提交。')}
  }

  const db=draft?.database
  const selected=db?.entries.find(item=>item.id===entryId)
  const binding=state?.binding
  const blocked=!!busy
  const retrieval=state?.retrieval
  return <>
    <header className="rpdb-header"><div className="rpdb-heading"><DatabaseIcon size={23}/><div><h2>故事数据库</h2><p>管理可复用条目，为当前故事固定一个版本。</p></div></div><button className="rpdb-icon-button" type="button" disabled={!state || busy==='refresh'} onClick={()=>void refresh(lifecycle.current)} title="刷新数据库列表" aria-label="刷新数据库列表">↻</button></header>
    {transportError&&<p className="rpdb-message rpdb-warning" role="status">{transportError}</p>}
    {error&&<div className="rpdb-message rpdb-error" role="alert"><p>{error}</p>{conflict&&<p>草稿与输入已保留。{conflict==='save'?'重新载入数据库会放弃本地编辑，请先复制需要保留的内容。':'请先刷新并核对最新内容，再重试。'}</p>}{['import','create'].includes(conflict)&&<button type="button" onClick={()=>void updateFormRevision()}>更新表单修订并保留输入</button>}</div>}
    {notice&&<p className="rpdb-message" role="status">{notice}</p>}
    {!state&&<p className="rpdb-empty" role="status">正在读取数据库…</p>}
    {state&&<div className="rpdb-layout"><aside className="rpdb-library" aria-label="数据库列表">
      <div className="rpdb-section-title"><h3>数据库列表</h3><span>{state.databases.length} 个</span></div>
      <div className="rpdb-library-list">{state.databases.map(item=><button type="button" className={`rpdb-library-item${db?.id===item.id?' is-selected':''}`} aria-label={`${item.name} · v${item.version} · ${item.entryCount} 条`} aria-pressed={db?.id===item.id} key={item.id} onClick={()=>selectDatabase(item.id,item.version)}><strong>{item.name}</strong><small>v{item.version} · {item.entryCount} 条</small>{binding?.databaseId===item.id&&<span className="rpdb-badge">故事固定 v{binding.version}</span>}</button>)}{!state.databases.length&&<div className="rpdb-empty"><strong>还没有数据库</strong><p>新建数据库，或导入自己的世界书 JSON。</p></div>}</div>
      {draft?.dirty&&<p className="rpdb-help">先保存当前修改，再新建或导入数据库。</p>}<details className="rpdb-details"><summary>新建数据库</summary><div className="rpdb-form"><label className="rpdb-field"><span>新数据库名称</span><input value={newName} disabled={blocked} onChange={event=>{captureForm('create');setNewName(event.target.value)}}/></label><button type="button" disabled={blocked || draft?.dirty || !newName.trim()} onClick={create}>新建空白数据库</button></div></details>
      <details className="rpdb-details" open={!state.databases.length}><summary>导入 JSON</summary><div className="rpdb-form"><p className="rpdb-help">支持数据库 JSON 与 SillyTavern 世界书，原件按原文保留。</p><label className="rpdb-field"><span>导入名称（可选）</span><input value={importName} disabled={blocked} onChange={event=>{captureForm('import');setImportName(event.target.value)}}/></label><label className="rpdb-field"><span>选择 JSON 文件</span><input type="file" accept=".json,application/json" disabled={blocked} onChange={event=>{void readFile(event.target.files?.[0]);event.target.value=''}}/></label><label className="rpdb-field"><span>SillyTavern 世界书 JSON</span><textarea rows={6} spellCheck={false} value={importText} disabled={blocked} onChange={event=>{++fileSequence.current;captureForm('import');setImportText(event.target.value)}}/></label><button type="button" disabled={blocked || draft?.dirty || !importText.trim()} onClick={importDatabase}>{busy==='import'?'正在导入…':'导入 JSON'}</button></div></details>
    </aside><main className="rpdb-main">
      <section className="rpdb-binding" aria-label="当前故事绑定"><span className="rpdb-eyebrow">当前故事</span>{binding?<><strong>{state.databases.find(item=>item.id===binding.databaseId)?.name ?? binding.databaseId} · 固定 v{binding.version}</strong><p className="rpdb-help">故事继承该版本，Agent 覆盖仅影响当前故事。</p></>:<><strong>{sessionId?'尚未绑定数据库':'请先选择一个故事'}</strong><p className="rpdb-help">保存源版本后，可在这里将它应用到当前故事。</p></>}</section>
      {binding&&<StoryView binding={binding}/>}
      {pending&&<div className="rpdb-message rpdb-warning" role="status"><p>当前数据库有未保存修改，切换会放弃这些修改。</p><div className="rpdb-actions"><button type="button" onClick={()=>void openDatabase(pending.id,pending.version)}>放弃修改并切换</button><button type="button" onClick={()=>setPending(null)}>继续编辑</button></div></div>}
      {!db?<div className="rpdb-empty rpdb-welcome"><DatabaseIcon size={34}/><h3>{busy==='load'?'正在读取版本…':'选择一个数据库开始'}</h3><p>把人物、地点与叙事线索整理为条目，独立设置 Agent 只读与选材方式。</p></div>:<>
        <div className="rpdb-editor-heading"><div className="rpdb-section-title"><h3>源版本编辑</h3><span className="rpdb-badge">v{db.version}{draft.dirty?' · 未保存':''}</span></div><label className="rpdb-field"><span>数据库名称</span><input value={db.name} disabled={blocked} onChange={event=>edit(value=>({...value,name:event.target.value}))}/></label><p className="rpdb-help">源版本与故事固定版本分别管理。保存不会自动应用。</p></div>
        <div className="rpdb-editor"><section className="rpdb-entries" aria-label="条目列表"><div className="rpdb-section-title"><h3>条目</h3><button type="button" className="rpdb-text-button" disabled={blocked} onClick={()=>{const id=globalThis.crypto.randomUUID();edit(value=>({...value,entries:[...value.entries,{id,title:'新条目',content:'',keywords:[],tags:[],notes:'',readOnly:false,mode:'auto',version:1}]}));setEntryId(id)}}>添加条目</button></div><div className="rpdb-entry-list">{db.entries.map(item=><button type="button" className={`rpdb-entry-item${entryId===item.id?' is-selected':''}`} key={item.id} aria-pressed={entryId===item.id} onClick={()=>setEntryId(item.id)}><strong>{item.title || '未命名条目'}</strong><small>{modes[item.mode]}{item.readOnly?' · Agent 只读':''}</small></button>)}{!db.entries.length&&<p className="rpdb-help">还没有条目</p>}</div></section>
          <section className="rpdb-entry-editor" aria-label="条目编辑">{selected?<><div className="rpdb-section-title"><h3>条目设置</h3><button type="button" className="rpdb-text-button rpdb-danger" disabled={blocked} onClick={()=>{edit(value=>({...value,entries:value.entries.filter(item=>item.id!==selected.id)}));setEntryId(db.entries.find(item=>item.id!==selected.id)?.id ?? null)}}>删除条目</button></div><label className="rpdb-field"><span>条目标题</span><input value={selected.title} disabled={blocked} onChange={event=>editEntry({title:event.target.value})}/></label><div className="rpdb-policy"><label className="rpdb-check"><input type="checkbox" checked={selected.readOnly} disabled={blocked} onChange={event=>editEntry({readOnly:event.target.checked})}/><span>Agent 只读</span></label><label className="rpdb-field"><span>选材方式</span><select value={selected.mode} disabled={blocked} onChange={event=>editEntry({mode:event.target.value})}>{Object.entries(modes).map(([value,name])=><option value={value} key={value}>{name}</option>)}</select></label></div><p className="rpdb-help">Agent 只读限制 Agent 修改；选材方式控制检索与入选。你始终可以编辑这两项。</p><label className="rpdb-field"><span>条目正文</span><textarea rows={10} spellCheck={false} value={selected.content} disabled={blocked} onChange={event=>editEntry({content:event.target.value})}/></label><div className="rpdb-pair"><label className="rpdb-field"><span>关键词</span><textarea rows={2} value={selected.keywords.join('\n')} disabled={blocked} onChange={event=>editEntry({keywords:event.target.value.split('\n')})}/></label><label className="rpdb-field"><span>标签</span><textarea rows={2} value={selected.tags.join('\n')} disabled={blocked} onChange={event=>editEntry({tags:event.target.value.split('\n')})}/></label></div><p className="rpdb-help">关键词与标签每行一个。</p><label className="rpdb-field"><span>叙事备注</span><textarea rows={3} value={selected.notes} disabled={blocked} onChange={event=>editEntry({notes:event.target.value})}/></label><small className="rpdb-id">条目 ID · {selected.id} · v{selected.version}</small></>:<div className="rpdb-empty">添加或选择条目，开始编辑内容。</div>}</section>
        </div>
        <div className="rpdb-save-bar"><div className="rpdb-actions"><button type="button" className="rpdb-primary" disabled={blocked || !draft.dirty || !db.name.trim()} onClick={save}>{busy==='save'?'正在保存…':'保存新版本'}</button><button type="button" disabled={blocked} onClick={()=>void openDatabase(db.id,undefined)}>重新载入数据库</button><button type="button" disabled={blocked || draft.dirty || !sessionId} onClick={bind}>{busy==='bind'?'正在应用…':'应用到当前故事'}</button></div><p className="rpdb-help">应用会重置当前故事覆盖与临时备注。{draft.dirty?'先保存新版本，再应用。重新载入会放弃未保存修改。':`编辑 v${db.version} · 基于修订 ${draft.baseRevision}`}</p></div>
        {draft.sourceId&&<section className="rpdb-source"><div className="rpdb-section-title"><h3>导入原件</h3><button type="button" className="rpdb-text-button" disabled={sourceBusy || blocked} onClick={()=>void viewSource()}>{sourceBusy?'正在读取原件…':'查看只读原件'}</button></div><p className="rpdb-help">原始文本仅供核对与回溯。</p>{source&&<><label className="rpdb-field"><span>原始 JSON（只读）</span><textarea rows={10} spellCheck={false} value={source.rawText} readOnly/></label><small className="rpdb-hash">SHA-256 · {source.sha256}</small></>}</section>}
        {!!diagnostics.length&&<ul className="rpdb-diagnostics">{diagnostics.map((item,index)=><li key={index}>{item.message ?? String(item)}</li>)}</ul>}
      </>}
      <section className="rpdb-search" aria-label="搜索检查"><div className="rpdb-section-title"><h3>当前故事搜索</h3></div><div className="rpdb-retrieval"><span>向量检索{retrieval?.embedding?.configured?`已配置 · ${retrieval.embedding.model ?? '默认模型'}`:'未配置'}</span><span>重排{retrieval?.reranking?.configured?`已配置 · ${retrieval.reranking.model ?? '默认模型'}`:'未配置'}</span></div><p className="rpdb-help">检查当前故事有效条目的检索结果与命中理由。未配置或失败时使用可用检索方式。</p><div className="rpdb-search-form"><label className="rpdb-field"><span>搜索条目</span><input value={query} placeholder="输入情节、人物或关键词" onChange={event=>{++searchSequence.current;setQuery(event.target.value);setResults(null);setSearchBusy(false)}} onKeyDown={event=>{if(event.key==='Enter' && binding)void search()}}/></label><button type="button" disabled={!binding || !query.trim() || searchBusy} onClick={()=>void search()}>{searchBusy?'正在搜索…':'搜索'}</button></div>{!binding&&<p className="rpdb-help">应用数据库到当前故事后，可检查搜索结果。</p>}{results&&<div className="rpdb-results"><div className="rpdb-degraded" role="status" aria-label="搜索降级状态">{results.degraded.map(code=><span key={code}>{degradation(code)}</span>)}</div><p className="rpdb-help">必开条目：{results.required.map(id=>binding?.entries.find(item=>item.id===id)?.title || id).join('、') || '无'}</p>{results.candidates.map(candidate=><article key={candidate.id}><div className="rpdb-section-title"><strong>{binding?.entries.find(item=>item.id===candidate.id)?.title || candidate.id}</strong><span>得分 {Number(candidate.score).toFixed(3)}</span></div><ul>{candidate.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul></article>)}{!results.candidates.length&&<p className="rpdb-help">没有匹配的条目。</p>}</div>}</section>
    </main></div>}
  </>
}
