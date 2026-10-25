import React,{useEffect,useRef,useState} from 'react'

const mime=file=>file.type==='application/pdf'||/\.pdf$/i.test(file.name)?'application/pdf':/\.md$/i.test(file.name)?'text/markdown':'text/plain'
const base64=buffer=>{let value='';for(const byte of new Uint8Array(buffer))value+=String.fromCharCode(byte);return btoa(value)}
export function DocumentPanel({client,state,visible,sessionId,blocked,documentRef,selectedDatabaseId,selectedEntry,onImported,onRefresh}){
  const [draft,setDraft]=useState(null),[preview,setPreview]=useState(null),[index,setIndex]=useState(null),[busy,setBusy]=useState(''),[failure,setFailure]=useState(null),[notice,setNotice]=useState('')
  const life=useRef(null),fileToken=useRef(0),previewToken=useRef(0),indexToken=useRef(0)
  const active=scope=>scope?.active&&life.current===scope
  async function request(work,scope=life.current){if(!active(scope))throw new DOMException('Cancelled','AbortError');const controller=new AbortController();scope.controllers.add(controller);try{const value=await work(controller.signal);if(!active(scope))throw new DOMException('Cancelled','AbortError');return value}finally{scope.controllers.delete(controller)}}
  useEffect(()=>{if(!visible)return;const scope={active:true,controllers:new Set(),readers:new Set()};life.current=scope;setBusy('');return()=>{scope.active=false;for(const controller of scope.controllers)controller.abort();for(const reader of scope.readers)reader.abort();fileToken.current++;previewToken.current++;indexToken.current++}},[client,visible,sessionId])
  async function refreshIndex(scope=life.current){const token=++indexToken.current;try{const value=await request(signal=>client.indexState(signal),scope);if(token===indexToken.current)setIndex(value)}catch(error){if(active(scope)&&error.name!=='AbortError'&&token===indexToken.current)setIndex({readyChunks:0,staleChunks:0,lastErrorCode:error.code??'INDEX_UNAVAILABLE'})}}
  useEffect(()=>{if(visible)void refreshIndex()},[state,visible,client])
  useEffect(()=>{
    const token=++previewToken.current
    if(!documentRef){setPreview(null);return}
    if(!visible)return
    void request(signal=>client.document(documentRef.documentId,documentRef.version,signal)).then(value=>{if(token===previewToken.current)setPreview(value)}).catch(error=>{if(error.name!=='AbortError'&&token===previewToken.current)setFailure(error)})
  },[documentRef?.documentId,documentRef?.version,selectedDatabaseId,visible,client])
  async function choose(file){
    const scope=life.current,token=++fileToken.current,capturedRevision=state.revision
    if(!file||!scope?.active)return
    setFailure(null);setNotice('')
    try{
      const buffer=await new Promise((resolve,reject)=>{const reader=new FileReader();scope.readers.add(reader);const done=()=>scope.readers.delete(reader);reader.onload=()=>{done();resolve(reader.result)};reader.onerror=()=>{done();reject(new Error('无法读取资料文件。'))};reader.onabort=()=>{done();reject(new DOMException('Cancelled','AbortError'))};reader.readAsArrayBuffer(file)})
      if(scope.active&&token===fileToken.current)setDraft({name:file.name,mimeType:mime(file),dataBase64:base64(buffer),requestId:crypto.randomUUID(),baseRevision:capturedRevision})
    }catch(error){if(scope.active&&token===fileToken.current&&error.name!=='AbortError')setFailure(error)}
  }
  async function submit(){
    if(!draft||busy||blocked||!active(life.current))return
    const scope=life.current,captured=draft;setBusy('import');setFailure(null);setNotice('')
    try{
      const {baseRevision,...input}=captured,result=await request(signal=>client.importDocument({...input,expectedRevision:baseRevision},signal),scope),document=await request(signal=>client.document(result.documentId,result.version,signal),scope)
      await onImported(result)
      if(active(scope)){setPreview(document);setDraft(null);setNotice(`已导入 ${result.chunkCount} 个资料片段，尚未自动绑定故事。`)}
    }catch(error){if(active(scope)&&error.name!=='AbortError')setFailure(error)}finally{if(active(scope))setBusy('')}
  }
  async function rebase(){const scope=life.current;if(!active(scope))return;setBusy('rebase');try{const next=await onRefresh();if(active(scope)&&next){setDraft(current=>current?{...current,baseRevision:next.revision}:current);setFailure(null)}}catch(error){if(active(scope)&&error.name!=='AbortError')setFailure(error)}finally{if(active(scope))setBusy('')}}
  async function rebuild(){const scope=life.current;if(!active(scope))return;setBusy('index');setFailure(null);try{const result=await request(signal=>client.rebuildIndex({},signal),scope);await refreshIndex(scope);if(active(scope))setNotice(result.diagnostics.length?result.diagnostics.map(item=>`${item.code} · ${item.message}`).join('；'):`已索引 ${result.indexedChunks} 项，复用 ${result.skippedChunks} 项。`)}catch(error){if(active(scope)&&error.name!=='AbortError')setFailure(error)}finally{if(active(scope))setBusy('')}}
  const edited=preview&&selectedEntry?.provenance?.documentId===preview.document.id&&preview.extraction.chunks.some(chunk=>chunk.ref.chunkId===selectedEntry.provenance.chunkId&&chunk.text!==selectedEntry.content)
  return <section className="rpdb-documents" aria-label="资料与索引">
    <div className="rpdb-section-title"><h3>资料与索引</h3><span>TXT / MD / PDF</span></div>
    <p className="rpdb-help">原始字节独立保留。PDF 只提取文本层；片段存入新来源库，核对后再明确绑定故事。</p>
    <label className="rpdb-field"><span>TXT、Markdown 或 PDF 文件</span><input type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" disabled={blocked||!!busy} onChange={event=>{void choose(event.target.files?.[0]);event.target.value=''}}/></label>
    {draft&&<label className="rpdb-field"><span>资料名称</span><input value={draft.name} disabled={blocked||!!busy} onChange={event=>setDraft({...draft,name:event.target.value,requestId:crypto.randomUUID()})}/></label>}
    <button type="button" disabled={blocked||!!busy||!draft?.name.trim()} onClick={()=>void submit()}>{busy==='import'?'正在提取…':'导入资料'}</button>
    {failure&&<div className="rpdb-message rpdb-warning" role="alert"><p>{failure.code==='REVISION_CONFLICT'?'资料修订冲突，文件与请求 ID 已保留。请核对最新内容后再提交。':failure.message}</p>{failure.code==='REVISION_CONFLICT'&&<button type="button" disabled={!!busy} onClick={()=>void rebase()}>更新资料修订并保留文件</button>}</div>}
    {notice&&<p className="rpdb-help" role="status">{notice}</p>}
    <div className="rpdb-index" aria-label="向量索引状态"><p>索引模型：{index?.model??'未配置'} · 可用 {index?.readyChunks??0} · 待处理 {index?.staleChunks??0}</p>{index?.lastErrorCode&&<p className="rpdb-help">{index.lastErrorCode}</p>}<button type="button" disabled={blocked||!!busy||!state.retrieval?.embedding?.configured} onClick={()=>void rebuild()}>重建启用库索引</button></div>
    {preview&&<section className="rpdb-document-preview" aria-label="资料提取预览"><h4>{preview.document.name} · v{preview.document.version}</h4><p className="rpdb-hash">原件 SHA-256 · {preview.document.sha256}</p><p className="rpdb-help">{preview.document.extractionVersion} / {preview.document.chunkingVersion}</p>{edited&&<p className="rpdb-help">当前条目已编辑，以下保留原始提取文本。</p>}{preview.diagnostics.map((item,index)=><p key={index} className="rpdb-help">{item.code} · {item.message}</p>)}{preview.extraction.chunks.map(chunk=><article key={chunk.ref.chunkId}><strong>{chunk.ref.page?`第 ${chunk.ref.page} 页 · `:''}第 {chunk.ref.paragraph} 段</strong><pre>{chunk.text}</pre></article>)}{!preview.extraction.chunks.length&&<p className="rpdb-help">没有提取出正文片段。</p>}</section>}
  </section>
}
