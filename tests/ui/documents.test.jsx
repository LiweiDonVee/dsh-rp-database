import React from 'react'
import {afterEach,beforeEach,it,expect,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createDatabaseHost} from '../../src/host.mjs'
import {createDatabaseRoutes} from '../../src/routes.mjs'
import {createRpDatabaseApi} from '../../src/api.js'
import {DatabaseWorkspace} from '../../src/DatabaseWorkspace.jsx'
import {DocumentPanel} from '../../src/DocumentPanel.jsx'
import {hostFixture} from '../fixtures/database-host.mjs'
import {syntheticPdf} from '../fixtures/synthetic-pdf.mjs'
const disposers=[]
beforeEach(()=>vi.stubGlobal('EventSource',class{addEventListener(){}close(){}}))
afterEach(async()=>{cleanup();for(const dispose of disposers.splice(0))await dispose();vi.unstubAllGlobals()})
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'rp-db-doc-ui-')),f=hostFixture(),service=await createDatabaseHost(f.ctx,{directory}),routes=createDatabaseRoutes(service),calls=[]
  disposers.push(async()=>{routes.close();await service.close();await rm(directory,{recursive:true,force:true})})
  const client=createRpDatabaseApi(async(url,options)=>{calls.push(JSON.parse(options.body));return routes.request(new Request(url,options))})
  render(<DatabaseWorkspace sessionId="story" client={client}/>);await screen.findByText('还没有数据库');await screen.findByText('EMBEDDING_UNCONFIGURED')
  return{service,calls}
}
const click=name=>fireEvent.click(screen.getByRole('button',{name,exact:true}))
const file=(buffer,name,type)=>fireEvent.change(screen.getByLabelText('TXT、Markdown 或 PDF 文件'),{target:{files:[new File([buffer],name,{type})]}})
it('imports a real text PDF and shows original page references while leaving the story unbound',async()=>{
  const {service}=await fixture()
  file(syntheticPdf(),'pages.pdf','application/pdf')
  await waitFor(()=>expect(screen.getByRole('button',{name:'导入资料'}),screen.getByRole('region',{name:'资料与索引'}).textContent).toBeEnabled());click('导入资料')
  expect(await screen.findByText('Harbor alpha')).toBeInTheDocument();expect(screen.getByText('Mountain beta')).toBeInTheDocument()
  expect(screen.getByText('第 1 页 · 第 1 段')).toBeInTheDocument();expect(screen.getByText('第 2 页 · 第 1 段')).toBeInTheDocument()
  expect(service.hasBinding('story')).toBe(false)
  await screen.findByLabelText('条目正文');fireEvent.change(screen.getByLabelText('条目正文'),{target:{value:'Working edit'}})
  expect(await screen.findByText('当前条目已编辑，以下保留原始提取文本。')).toBeInTheDocument()
  expect(screen.getByText('Harbor alpha')).toBeInTheDocument()
})
it('reports an image-only PDF as NO_TEXT_LAYER without fabricating chunks',async()=>{
  const {service}=await fixture();file(syntheticPdf({imageOnly:true}),'scan.pdf','application/pdf')
  await waitFor(()=>expect(screen.getByRole('button',{name:'导入资料'})).toBeEnabled());click('导入资料')
  expect(await screen.findByText(/NO_TEXT_LAYER/)).toBeInTheDocument()
  expect((await service.database({databaseId:(await service.state()).databases[0].id})).database.entries).toEqual([])
  expect(service.hasBinding('story')).toBe(false)
})
it('retains upload bytes and requestId through a revision conflict until explicit rebase',async()=>{
  const {service,calls}=await fixture();file('Text file','notes.txt','text/plain')
  await waitFor(()=>expect(screen.getByRole('button',{name:'导入资料'})).toBeEnabled())
  await service.create({name:'Concurrent library',expectedRevision:0});click('刷新数据库列表');await screen.findByDisplayValue('Concurrent library')
  click('导入资料');await screen.findByText(/资料修订冲突/)
  expect(screen.getByLabelText('资料名称')).toHaveValue('notes.txt')
  click('更新资料修订并保留文件');await waitFor(()=>expect(screen.getByRole('button',{name:'导入资料'})).toBeEnabled());click('导入资料')
  await screen.findByText('Text file')
  const imports=calls.filter(call=>call.action==='importDocument')
  expect(imports.map(call=>call.expectedRevision)).toEqual([0,1]);expect(imports[0].requestId).toBe(imports[1].requestId);expect(imports[0].dataBase64).toBe(imports[1].dataBase64)
})

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
function pendingPanel(operation){
  const pending=[],client={indexState:vi.fn(async()=>({readyChunks:0,staleChunks:2})),[operation]:vi.fn((input,signal)=>{const hold=deferred();pending.push({...hold,input,signal});return hold.promise}),document:vi.fn(async()=>({document:{id:'fresh',version:1,name:'Fresh document',sha256:'a'.repeat(64)},extraction:{chunks:[]},diagnostics:[]}))}
  const props={client,state:{revision:0,retrieval:{embedding:{configured:true}}},sessionId:'story',blocked:false,onImported:vi.fn(async()=>{}),onRefresh:vi.fn(async()=>{})}
  const view=render(<DocumentPanel {...props} visible/>),show=visible=>view.rerender(<DocumentPanel {...props} visible={visible}/>)
  return{pending,client,props,show}
}
it('can retry a pending upload after hide abort and ignores its late completion while a new upload is busy',async()=>{
  const {pending,client,props,show}=pendingPanel('importDocument')
  file('Retained upload','notes.txt','text/plain')
  await waitFor(()=>expect(screen.getByRole('button',{name:'导入资料'})).toBeEnabled());click('导入资料')
  expect(pending).toHaveLength(1);expect(screen.getByLabelText('TXT、Markdown 或 PDF 文件')).toBeDisabled()
  show(false);expect(pending[0].signal.aborted).toBe(true);show(true)
  await waitFor(()=>expect(screen.getByRole('button',{name:'导入资料'})).toBeEnabled())
  expect(screen.getByLabelText('TXT、Markdown 或 PDF 文件')).toBeEnabled();click('导入资料');expect(pending).toHaveLength(2)
  expect(pending[1].input).toEqual(pending[0].input)
  await act(async()=>pending[0].resolve({documentId:'old',version:1,chunkCount:99}))
  expect(screen.getByRole('button',{name:'正在提取…'})).toBeDisabled();expect(client.document).not.toHaveBeenCalled();expect(props.onImported).not.toHaveBeenCalled()
  await act(async()=>pending[1].resolve({documentId:'fresh',version:1,chunkCount:1}))
  expect(await screen.findByText('Fresh document · v1')).toBeInTheDocument();expect(props.onImported).toHaveBeenCalledTimes(1)
  expect(client.document).toHaveBeenCalledWith('fresh',1,expect.any(AbortSignal));expect(screen.getByLabelText('TXT、Markdown 或 PDF 文件')).toBeEnabled()
})
it('can retry a pending index rebuild after hide abort without an old completion clearing the new busy state',async()=>{
  const {pending,client,show}=pendingPanel('rebuildIndex')
  click('重建启用库索引');expect(pending).toHaveLength(1)
  show(false);expect(pending[0].signal.aborted).toBe(true);show(true)
  await waitFor(()=>expect(screen.getByRole('button',{name:'重建启用库索引'})).toBeEnabled())
  click('重建启用库索引');expect(pending).toHaveLength(2)
  await act(async()=>pending[0].reject(new Error('Ignored failure from a cancelled rebuild')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'重建启用库索引'})).toBeDisabled()
  await act(async()=>pending[1].resolve({diagnostics:[],indexedChunks:2,skippedChunks:1}))
  expect(await screen.findByText('已索引 2 项，复用 1 项。')).toBeInTheDocument();expect(screen.getByRole('button',{name:'重建启用库索引'})).toBeEnabled()
  expect(client.indexState).toHaveBeenCalledTimes(3)
})
