import React from 'react'
import {afterEach,beforeEach,it,expect,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createDatabaseHost} from '../../src/host.mjs'
import {createDatabaseRoutes} from '../../src/routes.mjs'
import {createRpDatabaseApi} from '../../src/api.js'
import {DatabaseWorkspace} from '../../src/DatabaseWorkspace.jsx'
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
