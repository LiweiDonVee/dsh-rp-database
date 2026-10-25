const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const stEntry=value=>record(value)&&['uid','key','keys','secondary_keys','enabled','insertion_order'].some(key=>Object.hasOwn(value,key))
const ownEntry=value=>record(value)&&['mode','readOnly','keywords','tags','notes','version'].some(key=>Object.hasOwn(value,key))

/** Parse ST data only. Runtime triggers stay inert and are named in the import report. */
export function parseWorldbook(parsed,fail){
  let book=parsed,path='',format='st-worldbook',character=false
  if(Object.hasOwn(parsed,'data')&&record(parsed.data)&&Object.hasOwn(parsed.data,'character_book')){book=parsed.data.character_book;path='data.character_book';character=true}
  else if(Object.hasOwn(parsed,'character_book')){book=parsed.character_book;path='character_book';character=true}
  else if(/^chara_card_v[23]$/u.test(parsed.spec??''))fail('WORLD_BOOK_NOT_FOUND','角色卡 JSON 中没有内嵌世界书；请导出关联的世界书 JSON。')
  if(character&&(!record(book)||!Array.isArray(book.entries)))fail('WORLD_BOOK_NOT_FOUND','角色卡 JSON 中没有有效的内嵌世界书。')
  if(!character&&Array.isArray(book.entries)){
    if(!book.entries.some(stEntry))return null
    if(book.entries.some(ownEntry)||!book.entries.every(stEntry))fail('INVALID_DATA','不能混合数据库条目与 SillyTavern 世界书条目。')
    character=book.entries.some(value=>Object.hasOwn(value,'keys')||Object.hasOwn(value,'enabled')||Object.hasOwn(value,'insertion_order'))
  }else if(!character&&!record(book.entries))return null
  if(character)format='st-character-book'
  const diagnostics=[],entryRefs=[]
  const warn=(code,message,id)=>diagnostics.push({code,severity:'warning',message,...id!==undefined?{entryId:id}:{}})
  const list=Array.isArray(book.entries)?book.entries.map((value,index)=>({key:index,value,index})):Object.entries(book.entries).map(([key,value],index)=>({key,value,index}))
  const scalarId=(value,fallback)=>{
    if(value===undefined||value===null)return String(fallback)
    if(typeof value==='string'&&value.trim()||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return String(value)
    fail('INVALID_DATA','世界书条目 ID 必须是非空文本或非负整数。')
  }
  const keys=(value,label)=>{if(value===undefined||value===null)return[];if(!Array.isArray(value)||value.some(key=>typeof key!=='string'))fail('INVALID_DATA',`${label} 必须是字符串数组。`);return value}
  const bool=(value,fallback,label)=>{if(value===undefined||value===null)return fallback;if(typeof value!=='boolean')fail('INVALID_DATA',`${label} 必须是布尔值。`);return value}
  const mapped=list.map(({key,value,index})=>{
    if(!record(value))fail('INVALID_DATA','世界书条目必须是对象。')
    const extensions=record(value.extensions)?value.extensions:{}
    const setting=(camel,snake=camel)=>Object.hasOwn(value,camel)?value[camel]:extensions[snake]
    const id=scalarId(character?value.id??value.uid:value.uid??value.id,key)
    const primary=keys(character?value.keys??value.key:value.key??value.keys,'关键词')
    const secondary=keys(character?value.secondary_keys??value.keysecondary:value.keysecondary??value.secondary_keys,'次级关键词')
    const disabled=bool(value.disable,false,'disable')||!bool(value.enabled,true,'enabled')
    const constant=bool(value.constant,false,'constant')
    const logic=setting('selectiveLogic')??0,negative=logic===1||logic===2
    const content=value.content??''
    if(typeof content!=='string')fail('INVALID_DATA','世界书正文必须是文本。')
    const title=value.comment||value.name||primary[0]||`条目 ${id}`
    if(typeof title!=='string')fail('INVALID_DATA','世界书标题必须是文本。')
    if(secondary.length||value.selective===true&&primary.length===0)warn('ST_ACTIVATION_LOGIC',`条目 ${id}：次级键及 AND/NOT 条件只保留来源，不复现酒馆激活逻辑；${negative?'否定键未加入正向检索关键词。':'正向次级键仅作检索提示。'}`,id)
    if([...primary,...secondary].some(key=>/^\/.+\/[dgimsuvy]*$/u.test(key)))warn('ST_REGEX_KEYS',`条目 ${id}：正则关键词按字面文本保存，不执行正则。`,id)
    if(/\{\{[\s\S]*?\}\}/u.test(content))warn('ST_MACROS_LITERAL',`条目 ${id}：正文中的酒馆宏保持原样，不自动展开或执行。`,id)
    if(['sticky','cooldown','delay'].some(key=>Number(setting(key))>0))warn('ST_TIMED_EFFECTS',`条目 ${id}：粘滞、冷却和延迟只保留来源，由当前 Agent 流程决定取用。`,id)
    if(setting('useProbability')!==false&&setting('probability')!=null&&Number(setting('probability'))!==100)warn('ST_PROBABILITY',`条目 ${id}：概率激活只保留来源，不进行随机启停。`,id)
    if(setting('excludeRecursion','exclude_recursion')||setting('preventRecursion','prevent_recursion')||setting('delayUntilRecursion','delay_until_recursion'))warn('ST_RECURSION',`条目 ${id}：递归扫描选项只保留来源，不模拟酒馆递归触发。`,id)
    if((value.position??extensions.position)!=null||(value.order??value.insertion_order)!=null||(value.depth??extensions.depth)!=null||setting('role')!=null||setting('outletName','outlet_name'))warn('ST_INSERTION',`条目 ${id}：注入位置、深度、角色及优先级保留在来源；本轮顺序由 GM 选材决定。`,id)
    if(setting('caseSensitive','case_sensitive')!=null||setting('matchWholeWords','match_whole_words')!=null||setting('scanDepth','scan_depth')!=null)warn('ST_MATCH_OPTIONS',`条目 ${id}：大小写、整词匹配与扫描深度不自动迁为运行规则。`,id)
    if(setting('group')||setting('groupOverride','group_override')||setting('useGroupScoring','use_group_scoring')||setting('vectorized')||setting('automationId','automation_id')||(setting('triggers')??[]).length||value.characterFilterNames?.length||value.characterFilterTags?.length)warn('ST_EXTENDED_ACTIVATION',`条目 ${id}：分组、向量标记、自动化或角色过滤只保留来源；不会因此启动外部服务或脚本。`,id)
    if(value.forbid_overrides||extensions.forbid_overrides||value.readOnly)warn('ST_AUTHOR_LOCK',`条目 ${id}：来源的禁止覆盖标记未自动变成人类 Agent 锁，请在导入后自行设置。`,id)
    if(record(value.extensions)&&Object.keys(value.extensions).length)warn('ST_EXTENSIONS_INERT',`条目 ${id}：扩展字段完整留存于原件，不执行其中的脚本或未知规则。`,id)
    const insertionOrder=value.order??value.insertion_order
    const ref={id,path:`${path?path+'.':''}entries.${key}`,sourceId:character?value.id??value.uid??null:value.uid??value.id??null,index,
      ...insertionOrder!==undefined?{insertionOrder}:{}}
    entryRefs.push(ref)
    const display=value.displayIndex??extensions.display_index
    return{index,display:Number.isFinite(display)?display:index,entry:{id,title,content,keywords:[...new Set([...primary,...negative?[]:secondary])],tags:[],notes:'',readOnly:false,mode:disabled?'disabled':constant?'required':'auto',version:1}}
  })
  if(['scan_depth','token_budget','recursive_scanning','extensions','originalData'].some(key=>Object.hasOwn(book,key)))warn('ST_BOOK_SETTINGS','世界书全局扫描、预算及扩展配置仅保留来源；当前系统使用数据库检索与 GM 选材。')
  return{name:book.name,format,entries:mapped.sort((a,b)=>a.display-b.display||a.index-b.index).map(item=>item.entry),diagnostics,entryRefs}
}
