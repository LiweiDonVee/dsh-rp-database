import React from 'react'
import {afterEach,beforeEach,it,expect,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createDatabaseHost} from '../../src/host.mjs'
import {createDatabaseRoutes} from '../../src/routes.mjs'
import {createRpDatabaseApi} from '../../src/api.js'
import {DatabaseWorkspace} from '../../src/DatabaseWorkspace.jsx'
import {hostFixture} from '../fixtures/database-host.mjs'

const disposers=[]
beforeEach(()=>vi.stubGlobal('EventSource',class{addEventListener(){}close(){}}))
afterEach(async()=>{cleanup();for(const dispose of disposers.splice(0))await dispose();vi.unstubAllGlobals()})
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'rp-db-ui-sources-')),f=hostFixture(),service=await createDatabaseHost(f.ctx,{directory}),routes=createDatabaseRoutes(service),calls=[]
  disposers.push(async()=>{routes.close();await service.close();await rm(directory,{recursive:true,force:true})})
  const world=await service.import({rawText:JSON.stringify({name:'World',entries:[{id:'0',title:'Same title',content:'World original'}]}),expectedRevision:0})
  const actor=await service.import({rawText:JSON.stringify({name:'Actor',entries:[{id:'0',title:'Same title',content:'Actor original'}]}),expectedRevision:1})
  assertV2(service)
  await service.bindSources({sessionId:'story',sources:[{key:'world',databaseId:world.databaseId,version:1},{key:'actor',databaseId:actor.databaseId,version:1}],expectedRevision:2,resetOverlay:false})
  const client=createRpDatabaseApi(async(url,options)=>{calls.push(JSON.parse(options.body));return routes.request(new Request(url,options))})
  render(<DatabaseWorkspace sessionId="story" client={client}/>);await screen.findByRole('region',{name:'故事来源组合'});await screen.findByLabelText('数据库名称')
  return{service,agent:f.agent,calls,world,actor}
}
function assertV2(service){expect(service.apiVersion).toBe(2)}
const click=name=>fireEvent.click(screen.getByRole('button',{name,exact:true}))
it('shows qualified duplicate IDs and preserves overlay when the owner changes source order',async()=>{
  const f=await fixture()
  click('当前故事内容与变更')
  expect(await screen.findByText('world / 0')).toBeInTheDocument();expect(screen.getByText('actor / 0')).toBeInTheDocument()
  click('上移来源 actor');click('保存故事来源')
  await screen.findByText('故事来源已保存，兼容的覆盖已保留。')
  const value=await f.service.effectiveV2({sessionId:'story'})
  expect(value.binding.sources.map(source=>source.key)).toEqual(['actor','world'])
  expect(f.calls.find(value=>value.action==='bindSources')).toMatchObject({expectedRevision:3,resetOverlay:false})
})
it('explains the impact and requires owner acknowledgement before discarding dependent overlay',async()=>{
  const f=await fixture()
  await f.service.patchV2({sessionId:'story',agent:f.agent,expectedRevision:3,operations:[{op:'update',ref:{sourceKey:'world',entryId:'0'},patch:{content:'World changed'}}]})
  click('当前故事内容与变更');click('刷新数据库列表');await screen.findByText('World changed')
  click('移除来源 world');click('保存故事来源')
  await screen.findByText(/这些来源已有故事变化/)
  expect((await f.service.effectiveV2({sessionId:'story'})).entries.find(entry=>entry.ref.sourceKey==='world').content).toBe('World changed')
  fireEvent.click(screen.getByLabelText('确认丢弃当前故事覆盖与临时备注'));click('保存故事来源')
  await screen.findByText('故事来源已保存，当前故事覆盖已重置。')
  expect(f.calls.filter(value=>value.action==='bindSources').at(-1).resetOverlay).toBe(true)
  expect((await f.service.effectiveV2({sessionId:'story'})).changes).toEqual([])
})
it('keeps edited sources and their captured revision after a conflict until an explicit reload',async()=>{
  const f=await fixture(),region=screen.getByRole('region',{name:'故事来源组合'})
  fireEvent.change(within(region).getByLabelText('来源槽位 1'),{target:{value:'renamed-world'}})
  await f.service.create({name:'Concurrent library',expectedRevision:3})
  click('刷新数据库列表');await screen.findByRole('button',{name:'Concurrent library · v1 · 0 条'})
  click('保存故事来源');await screen.findByText(/来源组合已变化/)
  expect(f.calls.filter(value=>value.action==='bindSources').at(-1).expectedRevision).toBe(3)
  expect(within(region).getByLabelText('来源槽位 1')).toHaveValue('renamed-world')
  click('载入最新来源（放弃来源草稿）')
  await waitFor(()=>expect(within(region).getByLabelText('来源槽位 1')).toHaveValue('world'))
})
