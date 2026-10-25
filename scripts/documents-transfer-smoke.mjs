// Standalone current-host acceptance. All content/models/providers are public local fixtures.
import {spawn,execFile} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {isDeepStrictEqual} from 'node:util'
import {resolve,join} from 'node:path'
import {chromium} from '@playwright/test'
import {syntheticPdf} from '../tests/fixtures/synthetic-pdf.mjs'
import {factCommit,fingerprint} from '../src/facts.mjs'

const root=process.cwd(),stamp=Date.now(),sourceHome=resolve(`.runtime/db-b-source-${stamp}`),destinationHome=resolve(`.runtime/db-b-destination-${stamp}`),evidence=resolve('.runtime/documents-transfer-evidence')
const manifest=JSON.parse(await readFile('package.json','utf8')),artifact=resolve(`artifacts/${manifest.name}-${manifest.version}.tgz`),artifactSHA256=createHash('sha256').update(await readFile(artifact)).digest('hex')
const cli=process.env.DSH_BIN??join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'),quote=value=>process.platform==='win32'?`"${value}"`:value
const environment=home=>({...process.env,DSH_HOME:home,DEEPSEEK_API_KEY:'unused-local-fixture'})
const sourceEnv=environment(sourceHome),destinationEnv=environment(destinationHome),httpCalls=[]
const server=createServer(async(request,response)=>{let body='';for await(const chunk of request)body+=chunk;const value=JSON.parse(body);httpCalls.push({path:request.url,...value});response.setHeader('content-type','application/json');response.end(JSON.stringify(request.url.endsWith('/embeddings')?{data:value.input.map((_text,index)=>({index,embedding:[1,0]}))}:{results:value.documents.map((_text,index)=>({index,relevance_score:1/(index+1)}))}))})
server.listen(0,'127.0.0.1');await once(server,'listening')
const provider=`http://127.0.0.1:${server.address().port}/v1`,patch=join(sourceHome,'probe.patch.yml')
for(const home of [sourceHome,destinationHome]){await mkdir(home,{recursive:true});await writeFile(join(home,'package.json'),JSON.stringify({name:'db-b-native-home',type:'module',private:true}))}
await mkdir(evidence,{recursive:true});await writeFile(join(sourceHome,'native-probe.mjs'),await readFile('tests/fixtures/native-probe.mjs'))
await writeFile(patch,`- id: rp-database\n  config:\n    embedding:\n      baseURL: ${provider}\n      model: native-embedding\n    reranking:\n      baseURL: ${provider}\n      model: native-rerank\n- id: agent-default-model\n  config:\n    provider: smoke-local\n    model: main\n- insert:\n    - id: native-smoke-probe\n      name: ${JSON.stringify(join(sourceHome,'native-probe.mjs').replaceAll('\\','/'))}\n    - id: native-smoke-story\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: native-smoke-story\n        name: 独立资料与恢复验收\n        description: 无私有数据或付费请求\n        plugins: []\n`)
const redact=value=>String(value).replace(/([?&]token=)[^\s"'<>]+/gu,'$1[REDACTED]').replace(/(Bearer\s+)[\w.-]+/giu,'$1[REDACTED]')
const kill=child=>new Promise(done=>{if(!child?.pid)return done();if(process.platform==='win32')execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>done());else{child.kill('SIGTERM');done()}})
const run=(args,env)=>new Promise((done,reject)=>{const child=spawn(quote(cli),args.map(quote),{cwd:root,env,shell:process.platform==='win32',windowsHide:true,stdio:'pipe'});let output='';const timer=setTimeout(async()=>{await kill(child);reject(Error('CLI timed out'))},60000);for(const stream of[child.stdout,child.stderr])stream.on('data',part=>output+=part);child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('exit',code=>{clearTimeout(timer);if(code===0)done(output.trim());else reject(Error(redact(output.slice(-5000))))})})
let host,browser,page,logs='',stage='install',result={passed:false,artifactSHA256,packageVersion:manifest.version,sourceHome,destinationHome},pageErrors=[]
const assert=(condition,message)=>{if(!condition)throw Error(message)}
async function start(env){logs='';host=spawn(quote(cli),['--profile','web','--patch',quote(patch),'--host','127.0.0.1','--port','0','--no-open'],{cwd:root,env,shell:process.platform==='win32',windowsHide:true,stdio:['ignore','pipe','pipe']});for(const stream of[host.stdout,host.stderr])stream.on('data',part=>logs+=part);const deadline=Date.now()+40000;while(Date.now()<deadline){const url=/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/.exec(logs)?.[0];if(url)return url;if(host.exitCode!==null)throw Error('Host exited');await new Promise(done=>setTimeout(done,100))}throw Error('Host startup timed out')}
async function visit(url){await page.goto(url,{waitUntil:'networkidle'});const preview=page.getByRole('button',{name:'继续',exact:true});await preview.waitFor({state:'visible',timeout:1500}).catch(()=>{});if(await preview.isVisible())await preview.click()}
const request=(path,input)=>page.evaluate(async({path,input})=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(45000)}),value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value.data??value},{path,input})
const api=(action,input={})=>request('api/rp-database/request',{action,...input}),probe=input=>request('api/native-smoke',input)
const embeddings=()=>httpCalls.filter(call=>call.path.endsWith('/embeddings'))
const countersZero=value=>value.models===0&&value.factTools===0
// Frozen T10: preserve observed data; normalize this one optional host default only for comparison.
const headerIdentity=header=>({...header,delegationDepth:header.delegationDepth===undefined?0:header.delegationDepth})
async function cancelAndReopen(panel,action,button){
  let captured;const held=new Promise(resolve=>{captured=resolve}),pattern='**/api/rp-database/request',mounted=await panel.elementHandle()
  const intercept=route=>{if(route.request().postDataJSON()?.action===action){captured(route);return}return route.continue()}
  await page.route(pattern,intercept)
  try{
    await panel.getByRole('button',{name:button,exact:true}).click()
    const route=await Promise.race([held,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('Pending native '+action+' was not captured')),15000))]),request=route.request(),failed=page.waitForEvent('requestfailed',{predicate:value=>value===request})
    assert(await panel.getByLabel('TXT、Markdown 或 PDF 文件',{exact:true}).isDisabled(),'Pending native operation was not busy')
    await page.getByRole('button',{name:'收起右侧边栏',exact:true}).click();await panel.waitFor({state:'hidden'})
    await route.continue().catch(()=>{});const failure=await failed
    assert(/abort/i.test(failure.failure()?.errorText??''),'Hiding the native panel did not abort its request')
    await page.unroute(pattern,intercept)
    await page.getByRole('button',{name:'打开故事数据库',exact:true}).click();await panel.waitFor({state:'visible'})
    assert(await panel.evaluate((node,original)=>node===original,mounted),'Native hide/show unexpectedly remounted the workspace')
    await panel.getByLabel('TXT、Markdown 或 PDF 文件',{exact:true}).waitFor()
    assert(await panel.getByLabel('TXT、Markdown 或 PDF 文件',{exact:true}).isEnabled(),'Reopened native file control remained busy')
    assert(await panel.getByRole('button',{name:button,exact:true}).isEnabled(),'Reopened native '+action+' remained busy')
    await panel.getByRole('button',{name:button,exact:true}).click()
    return{aborted:true,retryEnabled:true,sameMountedPanel:true}
  }finally{await page.unroute(pattern,intercept);await mounted.dispose()}
}
try{
  result.hostVersion=await run(['--version'],sourceEnv)
  await run(['plugin','--profile','web','add',artifact],sourceEnv)
  browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',error=>pageErrors.push(error.message))
  await page.addInitScript(()=>{Object.defineProperty(window,'__ModuleLoader__',{configurable:true,set(target){Object.defineProperty(window,'__ModuleLoader__',{configurable:true,writable:true,value:target});let load=target.load.bind(target);const observed=row=>load(row.id!=='@deepseek-ai/dsh-client-ui-workspace'?row:{...row,factory(require){const plugin=row.factory(require);return{...plugin,apply(ctx){window.__workspaceCtx=ctx;return plugin.apply(ctx)}}}});Object.defineProperty(target,'load',{configurable:true,get:()=>observed,set(next){load=next.bind(target)}})}})})
  await visit(await start(sourceEnv))
  const story=await probe({action:'create'});await probe({action:'setupFacts',sessionId:story.sessionId});const factual=await probe({action:'runFacts',sessionId:story.sessionId}),receipt=factual.evidence.receipt
  stage='document-native-ui'
  await page.evaluate(id=>window.__workspaceCtx.get('uiWorkspace').openSession(id),story.sessionId);await page.getByRole('button',{name:'打开故事数据库',exact:true}).click()
  const panel=page.locator(`[data-rp-database-session="${story.sessionId}"]`),pdf=syntheticPdf()
  await panel.getByLabel('TXT、Markdown 或 PDF 文件',{exact:true}).setInputFiles({name:'native-text.pdf',mimeType:'application/pdf',buffer:pdf})
  const uploadLifecycle=await cancelAndReopen(panel,'importDocument','导入资料')
  await panel.getByText('Harbor alpha',{exact:true}).first().waitFor();await panel.getByText('第 2 页 · 第 1 段',{exact:true}).waitFor()
  let state=await api('state');const docDatabase=state.databases.find(value=>value.name==='native-text.pdf'),docRef=docDatabase.documentRefs[0],document=await api('document',docRef)
  assert(document.document.dataBase64===pdf.toString('base64'),'Native PDF original bytes changed');assert((await api('effectiveV2',{sessionId:story.sessionId})).binding.sources.length===0,'Upload auto-bound the story')
  await page.screenshot({path:join(evidence,'native-document-preview.png')})
  await panel.getByLabel('TXT、Markdown 或 PDF 文件',{exact:true}).setInputFiles({name:'native-scan.pdf',mimeType:'application/pdf',buffer:syntheticPdf({imageOnly:true})});await panel.getByRole('button',{name:'导入资料',exact:true}).click();await panel.getByText(/NO_TEXT_LAYER/).waitFor()
  const packed=await probe({action:'contentRoundtrip',databaseId:docDatabase.id,version:1});assert(packed.sameBytes&&packed.sourceSame&&packed.remapped&&packed.result.databaseId===packed.replay.databaseId,'Native document pack mapping was not stable')
  stage='http-index'
  state=await api('state');const off=await api('import',{rawText:JSON.stringify({name:'Disabled fixture',entries:[{id:'off',content:'DISABLED_NATIVE_CANARY',mode:'disabled'}]}),expectedRevision:state.revision}),docStory=await probe({action:'create'})
  await api('bindSources',{sessionId:docStory.sessionId,sources:[{key:'document',databaseId:docDatabase.id,version:1},{key:'off',databaseId:off.databaseId,version:1}],expectedRevision:off.revision,resetOverlay:false})
  const before=await api('contentRevision'),mark=embeddings().length
  await api('searchV2',{sessionId:docStory.sessionId,query:'harbor'});await api('searchV2',{sessionId:docStory.sessionId,query:'harbor'})
  assert(JSON.stringify(embeddings().slice(mark).map(call=>call.input.length))==='[1,2,1]','Native repeated query reembedded unchanged chunks');assert((await api('contentRevision')).revision===before.revision,'Cache advanced content revision')
  assert(httpCalls.every(call=>!JSON.stringify(call).includes('DISABLED_NATIVE_CANARY')),'Disabled source reached a provider')
  stage='native-index-cancel-reopen'
  const indexLifecycle=await cancelAndReopen(panel,'rebuildIndex','重建启用库索引');await panel.getByText(/已索引 \d+ 项，复用 \d+ 项/).waitFor()
  const bundle=await probe({action:'snapshotBundle',sessionIds:[story.sessionId,docStory.sessionId]})
  assert(bundle.database.payload.documents.length===1&&!Object.hasOwn(bundle.database.payload,'vectorIndex'),'Export included unrelated documents or derived cache')
  await writeFile(join(evidence,'public-bundle.json'),JSON.stringify(bundle,null,2))
  stage='exact-cold-restore'
  await kill(host);host=null;await run(['plugin','--profile','web','add',artifact],destinationEnv);await visit(await start(destinationEnv))
  const invalidState=structuredClone(bundle.database),badRecord=invalidState.payload.sessions.find(record=>record.id===story.sessionId),badItem=badRecord.receipts[0],badReceipt=badItem.receipt,badChange=badRecord.changes.find(change=>change.id===badReceipt.changeId)
  badChange.operations.find(operation=>operation.op==='update'&&operation.ref.entryId==='gm.facts').patch.content=JSON.stringify({items:[{id:'invalid',text:'Missing schemaVersion'}]})
  const badCommit=factCommit({turnKey:badReceipt.turnKey,source:badReceipt.source,expectedRevision:0,operations:badChange.operations,summary:badReceipt.summary,packet:badReceipt.packet,kind:badReceipt.kind},badReceipt.sessionId),{expectedRevision:_badRevision,...badIdentity}=badCommit;badItem.fingerprint=fingerprint(badIdentity)
  const restored=await probe({action:'restoreBundle',bundle,invalidState,restoreId:'native-restore'})
  assert(restored.rejectedSchema?.preflight.supported===false&&restored.rejectedSchema.code==='RESTORE_PAYLOAD_INVALID'&&restored.rejectedSchema.unchanged&&restored.rejectedSchema.beforeRevision===restored.rejectedSchema.afterRevision,'Native restore accepted malformed GM facts or changed data/revision on rejection')
  assert(restored.result.revision===restored.replay.revision&&countersZero(restored.counters),'Restore replay mutated data or executed historical models/tools')
  for(const original of bundle.sessions){const cold=restored.cold.find(value=>value.header.id===original.header.id);assert(!cold.live&&isDeepStrictEqual(headerIdentity(cold.header),headerIdentity(original.header))&&isDeepStrictEqual(cold.events,original.events)&&cold.inheritedEventCount===original.inheritedEventCount,'Exact imported cold log differs')}
  stage='restored-resume'
  const resumed=await probe({action:'resumeFacts',sessionId:story.sessionId,receiptId:receipt.id})
  assert(resumed.receipt?.id===receipt.id&&countersZero(resumed.counters),'Cold factual receipt resume reran history')
  const destMark=embeddings().length;await api('searchV2',{sessionId:docStory.sessionId,query:'harbor'});assert(JSON.stringify(embeddings().slice(destMark).map(call=>call.input.length))==='[1,2]','Destination did not rebuild omitted vectors')
  stage='restored-fork-prefix'
  const after=await probe({action:'fork',sessionId:story.sessionId}),afterValue=await probe({action:'resumeFacts',sessionId:after.sessionId,receiptId:receipt.id})
  assert(afterValue.receipt?.originSessionId===story.sessionId,'Restored fork lost origin receipt')
  const originEvents=bundle.sessions.find(value=>value.header.id===story.sessionId).events,boundary=originEvents.filter(event=>event.type==='turn/end'&&event.seq<receipt.source.turnStartSeq).at(-1)??originEvents.find(event=>event.type==='approval/policy'&&event.seq<receipt.source.turnStartSeq)
  assert(boundary,'No protected or complete prefix exists before the factual turn')
  const prior=await probe({action:'fork',sessionId:after.sessionId,atSeq:boundary.seq}),priorValue=await probe({action:'resumeFacts',sessionId:prior.sessionId,receiptId:receipt.id})
  assert(JSON.parse(priorValue.snapshot.entries.find(entry=>entry.id==='gm.facts').content).items.length===0&&!priorValue.receipt,'Fork rewind inside inherited prefix resurrected facts or receipt')
  assert(countersZero(priorValue.counters),'Forking replayed historical models/tools')
  await probe({action:'snapshotBundle',sessionIds:[story.sessionId,docStory.sessionId,after.sessionId,prior.sessionId]})
  stage='destination-restart-index'
  await kill(host);host=null;await visit(await start(destinationEnv))
  const cold=await probe({action:'snapshotBundle',sessionIds:[story.sessionId,docStory.sessionId,after.sessionId,prior.sessionId]})
  assert(cold.sessions.every(value=>!value.live)&&countersZero(cold.counters),'Destination restart did not cold-read without execution')
  await writeFile(join(evidence,'cold-prefix-comparison.json'),JSON.stringify({original:bundle.sessions,current:cold.sessions},null,2))
  for(const original of bundle.sessions){const current=cold.sessions.find(value=>value.header.id===original.header.id);assert(isDeepStrictEqual(headerIdentity(current.header),headerIdentity(original.header))&&isDeepStrictEqual(current.events.slice(0,original.events.length),original.events),'Restart changed the imported header/event prefix beyond T10');assert(current.events.slice(original.events.length).every(event=>event.type==='session/end-seed'&&isDeepStrictEqual(event.data,{})),'Unexpected suffix after no-prompt resume')}
  const restartMark=embeddings().length;await api('searchV2',{sessionId:docStory.sessionId,query:'harbor'});assert(JSON.stringify(embeddings().slice(restartMark).map(call=>call.input.length))==='[1]','Persistent cache was not reused after process restart')
  const recovered=await probe({action:'resumeFacts',sessionId:story.sessionId,receiptId:receipt.id}),recoveredPrior=await probe({action:'resumeFacts',sessionId:prior.sessionId,receiptId:receipt.id})
  assert(recovered.receipt?.id===receipt.id&&!recoveredPrior.receipt&&countersZero(recoveredPrior.counters),'Restart lost receipt causality or executed historical work')
  assert(pageErrors.length===0,'Browser errors: '+JSON.stringify(pageErrors))
  result={...result,passed:true,checks:{realTextPdf:true,noTextLayer:true,originalBytes:true,noAutoBind:true,freshDocumentContentMapping:true,incrementalHttp:true,disabledExcluded:true,cacheOmittedFromTransfer:true,exactColdLogs:true,restoreCanonicalRefs:true,restoreReplay:true,noHistoricalExecution:true,inheritedPrefixRewind:true,processRestart:true,persistedIndex:true,restoreFactSchema:true,nativeUploadCancelReopen:true,nativeIndexCancelReopen:true},cancelReopen:{upload:uploadLifecycle,index:indexLifecycle},rejectedFactSchema:restored.rejectedSchema,httpEmbeddingInputLengths:embeddings().map(call=>call.input.length),nativeCounters:{source:bundle.counters,destinationAfterRestore:restored.counters,destinationAfterRestart:recoveredPrior.counters},importedPrefixes:bundle.sessions.map(value=>({sessionId:value.header.id,eventCount:value.events.length})),headerNormalization:'T10: delegationDepth undefined equals numeric 0 only',resumeSuffixTypes:cold.sessions.find(value=>value.header.id===story.sessionId).events.slice(bundle.sessions.find(value=>value.header.id===story.sessionId).events.length).map(event=>event.type),rewindBoundary:boundary.seq,receiptId:receipt.id,pageErrors}
}catch(error){result={...result,passed:false,stage,error:redact(error.message),pageErrors};process.exitCode=1;if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{});await writeFile(join(evidence,'host-redacted.log'),redact(logs.slice(-18000)))}finally{await browser?.close();await kill(host);await new Promise(done=>{server.close(done);server.closeAllConnections()})}
await writeFile(join(evidence,'acceptance.json'),JSON.stringify(result,null,2));await writeFile(join(evidence,'http-calls.json'),JSON.stringify(httpCalls,null,2));console.log(JSON.stringify(result))
