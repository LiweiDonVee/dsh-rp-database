import React,{useEffect,useRef,useState} from 'react'

const clone=value=>structuredClone(value)
export function SourceComposition({sources,revision,databases,sessionId,bound,visible,blocked,selected,onSave,onReload}){
  const [draft,setDraft]=useState(()=>clone(sources)),[baseRevision,setBaseRevision]=useState(revision),[dirty,setDirty]=useState(false),[reset,setReset]=useState(false),[failure,setFailure]=useState(null),[notice,setNotice]=useState('')
  const generation=useRef(0)
  useEffect(()=>{if(!dirty){setDraft(clone(sources));setBaseRevision(revision)}},[sources,revision,dirty])
  useEffect(()=>()=>{generation.current++},[visible,sessionId])
  function edit(next){if(!dirty)setBaseRevision(revision);setDraft(next);setDirty(true);setReset(false);setNotice('');setFailure(null)}
  function update(index,patch){edit(draft.map((source,at)=>at===index?{...source,...patch}:source))}
  function move(index,offset){const next=[...draft];[next[index],next[index+offset]]=[next[index+offset],next[index]];edit(next)}
  function add(){
    const database=selected??databases[0];if(!database)return
    let ordinal=1;while(draft.some(source=>source.key===`source-${ordinal}`))ordinal++
    edit([...draft,{key:`source-${ordinal}`,databaseId:database.id,version:database.version}])
  }
  async function save(){
    const token=++generation.current
    try{
      await onSave({sources:clone(draft),expectedRevision:baseRevision,resetOverlay:reset})
      if(token!==generation.current)return
      setDirty(false);setFailure(null);setReset(false);setNotice(reset?'故事来源已保存，当前故事覆盖已重置。':'故事来源已保存，兼容的覆盖已保留。')
    }catch(error){if(token===generation.current&&error.name!=='AbortError')setFailure(error)}
  }
  async function reload(){const token=++generation.current;await onReload();if(token===generation.current){setDirty(false);setFailure(null);setReset(false);setNotice('')}}
  const invalid=draft.some((source,index)=>!source.key.trim()||source.key==='@session'||!source.databaseId||!Number.isSafeInteger(source.version)||source.version<1||draft.some((other,at)=>at!==index&&other.key===source.key))
  return <section className="rpdb-composition" aria-label="故事来源组合">
    <div className="rpdb-section-title"><h3>故事来源组合</h3><span>{draft.length} 个来源{dirty?' · 未保存':''}</span></div>
    <p className="rpdb-help">按顺序固定来源与版本。同名、同 ID 条目分别保留；顺序不决定事实优先级。保留相同来源槽位和版本会保留故事变化。</p>
    <ol className="rpdb-source-list">{draft.map((source,index)=><li key={index}>
      <div className="rpdb-source-fields"><label className="rpdb-field"><span>来源槽位 {index+1}</span><input value={source.key} disabled={blocked} onChange={event=>update(index,{key:event.target.value})}/></label>
        <label className="rpdb-field"><span>来源数据库 {index+1}</span><select value={source.databaseId} disabled={blocked} onChange={event=>{const database=databases.find(value=>value.id===event.target.value);update(index,{databaseId:database.id,version:database.version})}}>{databases.map(database=><option key={database.id} value={database.id}>{database.name}</option>)}</select></label>
        <label className="rpdb-field"><span>固定版本 {index+1}</span><input type="number" min="1" step="1" value={source.version} disabled={blocked} onChange={event=>update(index,{version:Number(event.target.value)})}/></label></div>
      <div className="rpdb-actions"><button type="button" aria-label={`上移来源 ${source.key}`} disabled={blocked||index===0} onClick={()=>move(index,-1)}>上移</button><button type="button" aria-label={`下移来源 ${source.key}`} disabled={blocked||index===draft.length-1} onClick={()=>move(index,1)}>下移</button><button type="button" aria-label={`移除来源 ${source.key}`} disabled={blocked} onClick={()=>edit(draft.filter((_value,at)=>at!==index))}>移除来源</button></div>
    </li>)}</ol>
    {!draft.length&&<p className="rpdb-help">空来源列表可保存；故事内新增条目仍由当前故事独立维护。</p>}
    <div className="rpdb-actions"><button type="button" disabled={blocked||!databases.length} onClick={add}>{selected?'添加所选版本为来源':'添加来源'}</button><button type="button" disabled={blocked||!sessionId||(!dirty&&bound)||invalid} onClick={()=>void save()}>保存故事来源</button></div>
    <p className="rpdb-help">移除或替换已有变化的来源需要明确重置。GM 初始化后的事实与回执不能在这里重置，需另开故事。{dirty?`来源草稿基于修订 ${baseRevision}`:''}</p>
    {invalid&&<p role="status" className="rpdb-help">来源槽位须唯一且不能为空，不能使用 @session；版本须为正整数。</p>}
    {failure&&<div className="rpdb-message rpdb-warning" role="alert">
      <p>{failure.code==='BINDING_CHANGE_REQUIRES_RESET'?'这些来源已有故事变化。移除或替换后会丢弃当前故事覆盖与临时备注，请确认后再次保存。':failure.code==='REVISION_CONFLICT'?'来源组合已变化，草稿与原修订已保留。请载入最新来源后重新编辑。':failure.code==='STORY_RESTART_REQUIRED'?'当前故事已有 GM 状态，不能丢弃事实或回执。请保留来源，或另开故事。':failure.message}</p>
      {failure.code==='BINDING_CHANGE_REQUIRES_RESET'&&<label className="rpdb-check"><input type="checkbox" checked={reset} onChange={event=>setReset(event.target.checked)}/><span>确认丢弃当前故事覆盖与临时备注</span></label>}
      <button type="button" disabled={blocked} onClick={()=>void reload()}>载入最新来源（放弃来源草稿）</button>
    </div>}
    {notice&&<p role="status" className="rpdb-help">{notice}</p>}
  </section>
}
