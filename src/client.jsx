import React from 'react'
import {DatabaseWorkspace, DatabaseIcon} from './DatabaseWorkspace.jsx'
import css from './styles.css'

export const inject=['slots','sidebarRight','sidebarRightTabs']
export const TAB_ID='dsh-rp-database/workspace'
export const TAB_KIND='rp-database'

function OpenButton({open}) {
  return <button type="button" className="rpdb-open-entry" aria-label="打开故事数据库" title="故事数据库" onClick={open}><DatabaseIcon/><span>数据库</span></button>
}

export function apply(ctx) {
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.rpDatabase='';style.textContent=css;document.head.append(style);return()=>style.remove()},'RP database styles')
  function Body({sessionId,useTabInfo}) {const {tab}=useTabInfo();return <DatabaseWorkspace key={sessionId} sessionId={sessionId} visible={tab.visible}/>}
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:TAB_ID,kind:TAB_KIND,title:()=> '故事数据库',guide:[{id:TAB_KIND,order:38,title:()=> '故事数据库',description:()=> '条目、源版本与当前故事继承'}]}),'RP database tab')
  ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:TAB_ID},Body)),'RP database pane')
  for(const name of ['conversation.session.header.actions','conversation.hero.options','rp.studio.workspace.actions'])ctx.effect(()=>ctx.slots.inject(name,()=>ctx.slots.register({name,id:TAB_ID,order:38,inject:()=>({open:()=>ctx.sidebarRight.openTab(TAB_KIND)})},OpenButton)),`RP database entry ${name}`)
}
