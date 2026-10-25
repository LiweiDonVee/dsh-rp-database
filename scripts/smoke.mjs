import {spawn,execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {chromium} from '@playwright/test'

const packageName="dsh-rp-database",root=process.cwd(),home=resolve('.runtime/'+packageName+'-smoke-'+Date.now()),evidence=resolve('.runtime/native-evidence')
const manifest=JSON.parse(await readFile('package.json','utf8'))
const artifact=resolve('artifacts/'+packageName+'-'+manifest.version+'.tgz')
const artifactSHA256=createHash('sha256').update(await readFile(artifact)).digest('hex')
const cli=process.env.DSH_BIN??(process.platform==='win32'?join(process.env.LOCALAPPDATA??'','Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'):'dsh')
const quote=value=>process.platform==='win32'?'"'+value+'"':value
const env={...process.env,DSH_HOME:home,DEEPSEEK_API_KEY:'native-smoke-placeholder-unused'}
const redact=value=>String(value).replace(/([?&]token=)[^\s"'<>]+/gu,'$1[REDACTED]').replace(/(Bearer\s+)[\w.-]+/giu,'$1[REDACTED]')
await mkdir(home,{recursive:true});await mkdir(evidence,{recursive:true})
await writeFile(join(home,'package.json'),JSON.stringify({name:packageName+'-smoke-home',private:true,type:'module'}))
let host,browser,page,logs='',stage='install',result={passed:false,status:'running',artifactSHA256,standalone:true,packageName,packageVersion:manifest.version},errors=[]
const save=()=>writeFile(join(evidence,'acceptance.json'),JSON.stringify(result,null,2))
await save()
const kill=child=>new Promise(done=>{if(!child?.pid)return done();if(process.platform==='win32')execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>done());else{child.kill('SIGTERM');done()}})
const install=()=>new Promise((done,reject)=>{
 const child=spawn(quote(cli),['plugin','--profile','web','add',quote(artifact)],{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:'pipe'});let output=''
 const timer=setTimeout(async()=>{await kill(child);reject(Error('Package installation timed out'))},60_000)
 for(const stream of[child.stdout,child.stderr])stream.on('data',data=>output+=data)
 child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('exit',code=>{clearTimeout(timer);if(code===0)done();else reject(Error('Package installation failed: '+redact(output.slice(-6000))))})
})
const assert=(condition,message)=>{if(!condition)throw Error(message)}
try{
 result.hostVersion=await new Promise((done,reject)=>{const child=spawn(quote(cli),['--version'],{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:'pipe'});let output='';child.stdout.on('data',data=>output+=data);child.on('error',reject);child.on('exit',code=>code===0?done(output.trim()):reject(Error('Could not read native host version')))})
 await install()
 const fixture=join(home,'native-probe.mjs');await writeFile(fixture,await readFile('tests/fixtures/native-probe.mjs'))
 const patch=join(home,'probe.patch.yml')
 await writeFile(patch,'- id: agent-default-model\n  config:\n    provider: smoke-local\n    model: main\n- insert:\n    - id: native-smoke-probe\n      name: '+JSON.stringify(fixture.replaceAll('\\','/'))+'\n    - id: native-smoke-story\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: native-smoke-story\n        name: 独立合成故事验收\n        description: 本地确定性模型，无私有资料\n        plugins: []\n')
 stage='host-start'
 host=spawn(quote(cli),['--profile','web','--patch',quote(patch),'--host','127.0.0.1','--port','0','--no-open'],{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:['ignore','pipe','pipe']})
 for(const stream of[host.stdout,host.stderr])stream.on('data',data=>logs+=data)
 let url;const deadline=Date.now()+40_000
 while(Date.now()<deadline){url=/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0];if(url)break;if(host.exitCode!==null)throw Error('Native host exited');await new Promise(done=>setTimeout(done,100))}
 assert(url,'Native host startup timed out')
 stage='browser'
 browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}})
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15_000);page.on('pageerror',error=>errors.push(error.message))
 // Observe the public workspace UI service only; no loop/session state rewriting.
 await page.addInitScript(()=>{Object.defineProperty(window,'__ModuleLoader__',{configurable:true,set(target){Object.defineProperty(window,'__ModuleLoader__',{configurable:true,writable:true,value:target});let load=target.load.bind(target);const observed=row=>load(row.id!=='@deepseek-ai/dsh-client-ui-workspace'?row:{...row,factory(require){const plugin=row.factory(require);return{...plugin,apply(ctx){window.__workspaceCtx=ctx;return plugin.apply(ctx)}}}});Object.defineProperty(target,'load',{configurable:true,get:()=>observed,set(next){load=next.bind(target)}})}})})
 await page.goto(url,{waitUntil:'networkidle'})
 const preview=page.getByRole('button',{name:'继续',exact:true});await preview.waitFor({state:'visible',timeout:2000}).catch(()=>{});if(await preview.isVisible())await preview.click()
 const request=(path,input)=>page.evaluate(async({path,input})=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(35_000)}),value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value.data??value},{path,input})
 const api=(action,input={})=>request('api/'+packageName.replace('dsh-','')+'/request',{action,...input})
 const probe=input=>request('api/native-smoke',input)
 const {sessionId}=await probe({action:'create'})
 stage='initial-empty-source-native-ui'
 await page.evaluate(id=>window.__workspaceCtx.get('uiWorkspace').openSession(id),sessionId)
 await page.getByRole('button',{name:'打开故事数据库',exact:true}).click()
 const emptyPanel=page.locator(`[data-rp-database-session="${sessionId}"]`)
 const emptySave=emptyPanel.getByRole('button',{name:'保存故事来源',exact:true})
 await emptySave.waitFor({state:'visible'})
 assert(await emptySave.isEnabled(),'Unbound empty source list has no initial save entry')
 assert(await emptyPanel.getByRole('button',{name:'添加来源',exact:true}).isDisabled(),'Empty library unexpectedly provides a source')
 await emptySave.click();await emptyPanel.getByText('故事来源已保存，兼容的覆盖已保留。',{exact:true}).waitFor()
 const emptyBinding=await api('effectiveV2',{sessionId}),emptyState=await api('state')
 assert(emptyBinding.binding.sources.length===0&&emptyState.databases.length===0,'Initial empty UI binding created a global library or lost its binding')
 assert(await emptySave.isDisabled(),'Unchanged bound empty list remained saveable')
 await page.screenshot({path:join(evidence,'native-initial-empty-binding.png')})
 stage='database-policies'
 let state=await api('state')
 await api('create',{name:'空白验收数据库',expectedRevision:state.revision})
 state=await api('state');assert(state.databases.length===1,'Owner create did not persist')
 const raw='\uFEFF'+JSON.stringify({name:'合成数据库',entries:{locked:{uid:'locked',comment:'固定门锁',key:['门锁'],content:'锁不允许改动。'},required:{uid:'required',comment:'必须存在的规则',content:'门是否打开以既定结算为准。',constant:true},disabled:{uid:'disabled',comment:'禁用秘密',content:'DISABLED_CANARY',disable:true},open:{uid:'open',comment:'门状态',key:['门'],content:'来源中的门仍半开。',probability:35,useProbability:true}},extensions:{script:'window.__sourceExecuted=true'}},null,2)+'\r\n'
 const imported=await api('import',{rawText:raw,name:'合成数据库',expectedRevision:state.revision})
 const loaded=await api('database',{databaseId:imported.databaseId,version:imported.version}),database=loaded.database
 assert(imported.diagnostics.some(item=>item.code==='ST_PROBABILITY')&&loaded.importReport.diagnostics.some(item=>item.code==='ST_PROBABILITY'),'ST unsupported behavior was not reported or persisted')
 database.entries.find(row=>row.id==='locked').readOnly=true
 database.entries.find(row=>row.id==='required').mode='required'
 database.entries.find(row=>row.id==='disabled').mode='disabled'
 const saved=await api('save',{database,expectedRevision:loaded.revision})
 await api('bind',{sessionId,databaseId:saved.databaseId,version:saved.version,expectedRevision:saved.revision})
 const catalog=await probe({action:'catalog',sessionId})
 assert(catalog.entries.length===3&&!catalog.entries.some(row=>row.id==='disabled'),'Disabled entry leaked through catalog')
 assert(catalog.entries.find(row=>row.id==='locked').readOnly&&catalog.entries.find(row=>row.id==='required').mode==='required','Owner policies missing')
 let disabledRejected=false;try{await probe({action:'read',sessionId,entryIds:['disabled']})}catch(error){disabledRejected=error.message.includes('ENTRY_DISABLED')}assert(disabledRejected,'Disabled read was accepted')
 const run=await probe({action:'run',sessionId});assert(run.calls.filter(row=>row.kind==='main-patch').length===1,'Real native tool was not requested once')
 const effective=await probe({action:'effective',sessionId})
 assert(effective.entries.find(row=>row.id==='open').content==='本故事中门已关紧。'&&effective.entries.some(row=>row.id==='local'),'Native patch tool failed to update/add story entries')
 const rejected=await probe({action:'rejectPolicies',sessionId});assert(JSON.stringify(rejected.codes)===JSON.stringify(['READ_ONLY','REQUIRED','DISABLED']),'Protected operations were accepted')
 const second=await probe({action:'create'});state=await api('state')
 await api('bind',{sessionId:second.sessionId,databaseId:saved.databaseId,version:saved.version,expectedRevision:state.revision})
 const isolated=await probe({action:'effective',sessionId:second.sessionId})
 assert(!isolated.entries.some(row=>row.id==='local')&&isolated.entries.find(row=>row.id==='open').content==='来源中的门仍半开。','Story overlay leaked into second story')
 const source=await api('source',{sourceId:imported.sourceId}),unchanged=await api('database',{databaseId:saved.databaseId,version:saved.version})
 assert(source.source.rawText===raw&&unchanged.database.entries.find(row=>row.id==='open').content==='来源中的门仍半开。','Source changed through story tool')
 state=await api('state')
 const cardRaw=JSON.stringify({spec:'chara_card_v3',spec_version:'3.0',data:{name:'合成角色',system_prompt:'CARD_INSTRUCTIONS_NOT_DATABASE',character_book:{name:'内嵌验收世界书',entries:[{id:0,keys:['旧信'],content:'只提取世界资料。',enabled:true},{keys:['停用'],content:'关闭项',enabled:false}]}}})
 const embedded=await api('import',{rawText:cardRaw,expectedRevision:state.revision}),embeddedData=await api('database',{databaseId:embedded.databaseId,version:embedded.version})
 assert(embeddedData.database.name==='内嵌验收世界书'&&embeddedData.database.entries[0].id==='0'&&embeddedData.database.entries[1].mode==='disabled'&&!JSON.stringify(embeddedData.database).includes('CARD_INSTRUCTIONS_NOT_DATABASE'),'Embedded V3 book import failed')
 const checks={ownerCreate:true,ownerImport:true,stWorldbookMap:true,embeddedCharacterBook:true,unsupportedBehaviorReported:true,readOnly:true,required:true,disabledCatalogAndRead:true,nativePatch:true,storyIsolation:true,sourceExact:true,nativeInitialEmptyBinding:true}

 stage='qualified-facts'
 state=await api('state')
 const actorSource=await api('import',{rawText:JSON.stringify({name:'Actor source',entries:[{id:'0',title:'Actor zero',content:'Actor zero is distinct.'}]}),expectedRevision:state.revision})
 const factStory=await probe({action:'create'})
 await api('bindSources',{sessionId:factStory.sessionId,sources:[{key:'world',databaseId:embedded.databaseId,version:1},{key:'actor',databaseId:actorSource.databaseId,version:1}],expectedRevision:actorSource.revision,resetOverlay:false})
 const initialized=await probe({action:'setupFacts',sessionId:factStory.sessionId})
 assert(initialized.materialStagingCode==='FACT_OWNER_REQUIRED'&&initialized.materialStagingAtomic,'A pre-initialization native material facade staged registered facts')
 checks.nativeMaterialStagingAfterInitialize=true
 const factRun=await probe({action:'runFacts',sessionId:factStory.sessionId}),factProof=factRun.evidence
 assert(factRun.calls.filter(call=>call.kind==='fact-main'&&call.sessionId===factStory.sessionId).length===1,'Synthetic fact tool was not requested once')
 assert(factProof?.duplicateSame&&factProof.conflict?.code==='TURN_ALREADY_COMMITTED'&&factProof.conflict.receiptId===factProof.receipt.id,'Native fact duplicate/conflict was not stable')
 assert(factProof.materialCode==='FACT_OWNER_REQUIRED'&&factProof.atomic&&factProof.factVersion===2,'Native material stage bypassed factual ownership or atomicity')
 const recovered=await probe({action:'recoverFacts',sessionId:factStory.sessionId,receiptId:factProof.receipt.id})
 assert(recovered.receipt.id===factProof.receipt.id,'Native receipt could not be recovered after its tool returned')
 const zero=recovered.snapshot.entries.filter(entry=>entry.id==='0')
 assert(zero.length===2&&zero[0].ref.sourceKey==='world'&&zero[1].ref.sourceKey==='actor'&&zero[0].content!==zero[1].content,'Qualified same-ID native entries aliased')
 assert(!recovered.snapshot.entries.some(entry=>entry.mode==='disabled'),'Agent snapshot leaked a disabled entry')
 checks.qualifiedSameID=true;checks.nativeFactReceiptOnce=true;checks.nativeMaterialGuard=true;checks.nativeReceiptRecovery=true
 result.factEvidence={sessionId:factStory.sessionId,receiptId:factProof.receipt.id,source:factProof.receipt.source,databaseRevision:factProof.receipt.databaseRevision}

 stage='native-ui'
 await page.evaluate(id=>window.__workspaceCtx.get('uiWorkspace').openSession(id),sessionId)
 await page.getByRole('button',{name:"打开故事数据库",exact:true}).click()
 const panel=page.locator("[data-rp-database-session]");await panel.waitFor({state:'visible'})
 await page.getByRole('button',{name:/合成数据库 · v/}).click()
 await page.locator('.rpdb-entry-item').filter({hasText:'固定门锁'}).click()
 await page.getByRole('textbox',{name:'条目正文',exact:true}).waitFor()
 assert(await page.getByRole('checkbox',{name:'Agent 只读',exact:true}).isChecked(),'Native editor does not show human read-only policy')
 await page.getByRole('button',{name:'查看只读原件',exact:true}).click()
 assert(await page.getByRole('textbox',{name:'原始 JSON（只读）',exact:true}).inputValue()===raw.replaceAll('\r\n','\n'),'Native original viewer changed source beyond browser textarea newline normalization')
 assert(!await page.evaluate(()=>window.__sourceExecuted),'Imported source script executed')
 assert((await panel.innerText()).includes('概率激活只保留来源'),'Native UI did not restore the selected import report')

 await page.screenshot({path:join(evidence,'native-sidebar.png')})
 const layoutMetrics=[]
 const metrics=label=>page.evaluate(({selector,label})=>{const node=document.querySelector(selector),box=node.getBoundingClientRect();return{label,viewport:innerWidth,width:Math.round(box.width),height:Math.round(box.height),scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,documentWidth:document.documentElement.scrollWidth}},{selector:"[data-rp-database-session]",label})
 layoutMetrics.push(await metrics('sidebar'))
 const fullscreen=page.getByRole('button',{name:'全屏',exact:true})
 await fullscreen.click();await page.waitForTimeout(200)
 layoutMetrics.push(await metrics('fullscreen'));assert(layoutMetrics.at(-1).width>900,'Native full-screen panel did not expand')
 await page.screenshot({path:join(evidence,'native-fullscreen.png')})
 await page.setViewportSize({width:520,height:900});await page.waitForTimeout(150)
 layoutMetrics.push(await metrics('narrow'));await page.screenshot({path:join(evidence,'native-narrow.png')})
 assert(layoutMetrics.at(-1).documentWidth<=530,'Narrow native UI overflows viewport')
 await page.setViewportSize({width:1440,height:1000})
 // Native close followed by the same conversation header entry.
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 await panel.waitFor({state:'hidden'})
 await page.getByRole('button',{name:"打开故事数据库",exact:true}).click();await panel.waitFor({state:'visible'})
 await page.screenshot({path:join(evidence,'native-reopened.png')})

 stage='qualified-native-ui'
 await page.evaluate(id=>window.__workspaceCtx.get('uiWorkspace').openSession(id),factStory.sessionId)
 await page.getByRole('button',{name:'打开故事数据库',exact:true}).click()
 const qualifiedPanel=page.locator(`[data-rp-database-session="${factStory.sessionId}"]`)
 await qualifiedPanel.waitFor({state:'visible'})
 await qualifiedPanel.getByRole('button',{name:'当前故事内容与变更',exact:true}).click()
 await qualifiedPanel.getByText('world / 0',{exact:true}).waitFor()
 await qualifiedPanel.getByText('actor / 0',{exact:true}).waitFor()
 await qualifiedPanel.getByRole('button',{name:'上移来源 actor',exact:true}).click()
 await qualifiedPanel.getByRole('button',{name:'保存故事来源',exact:true}).click()
 await qualifiedPanel.getByText('故事来源已保存，兼容的覆盖已保留。',{exact:true}).waitFor()
 const reordered=await probe({action:'effectiveV2',sessionId:factStory.sessionId})
 assert(reordered.binding.sources[0].key==='actor'&&reordered.entries.find(entry=>entry.id==='gm.facts').version===2,'Native source reorder lost facts')
 await page.screenshot({path:join(evidence,'native-qualified-sources.png')})
 checks.nativeSourceComposition=true
 assert(errors.length===0,'Browser page errors: '+JSON.stringify(errors))
 result={...result,passed:true,status:'passed',checks,layoutMetrics,pageErrors:errors};await save();console.log(JSON.stringify(result))
}catch(error){
 if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})
 result={...result,passed:false,status:'failed',stage,error:redact(error.message),pageErrors:errors};await save()
 await writeFile(join(evidence,'host-redacted.log'),redact(logs.slice(-16000)))
 console.error(JSON.stringify(result));process.exitCode=1
}finally{await browser?.close();await kill(host)}

