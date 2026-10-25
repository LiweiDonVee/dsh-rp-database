import {createHash} from 'node:crypto'
import {DatabaseError} from './core.mjs'

export const EXTRACTION_VERSION='pdf2json-4.1.0/text-utf8-v1'
export const CHUNKING_VERSION='paragraph-1200-v1'
export const textHash=value=>createHash('sha256').update(value).digest('hex')
const invalid=message=>{throw new DatabaseError('INVALID_DOCUMENT',message)}
export function documentBytes({mimeType,dataBase64,text}){
  if(!['text/plain','text/markdown','application/pdf'].includes(mimeType)||(text===undefined)===(dataBase64===undefined)||mimeType==='application/pdf'&&text!==undefined)invalid('Provide exactly one supported text or binary document')
  if(text!==undefined){if(typeof text!=='string')invalid('text must be a string');return Buffer.from(text,'utf8')}
  if(typeof dataBase64!=='string'||dataBase64.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64))invalid('Invalid base64 document')
  return Buffer.from(dataBase64,'base64')
}
export async function extractText(input){
  const bytes=documentBytes(input),diagnostics=[]
  input.signal?.throwIfAborted()
  if(input.mimeType!=='application/pdf'){
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{invalid('Text documents must be UTF-8')}
    return{bytes,pages:[{text:text.replace(/\r\n?/g,'\n')}],diagnostics}
  }
  if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))invalid('PDF bytes must contain a PDF header')
  const {default:PDFParser}=await import('pdf2json')
  const parser=new PDFParser(null,0)
  try{
    const pages=await new Promise((resolve,reject)=>{
      const aborted=()=>reject(input.signal.reason??new DOMException('Aborted','AbortError'))
      input.signal?.addEventListener('abort',aborted,{once:true})
      const clear=()=>input.signal?.removeEventListener('abort',aborted)
      parser.once('pdfParser_dataError',()=>{clear();reject(new DatabaseError('INVALID_DOCUMENT','PDF text extraction failed'))})
      parser.once('pdfParser_dataReady',data=>{clear();try{resolve(data.Pages.map((page,index)=>({page:index+1,text:page.Texts.map(item=>(item.R??[]).map(run=>decodeURIComponent(run.T)).join('')).join('\n')})))}catch{reject(new DatabaseError('INVALID_DOCUMENT','PDF text extraction failed'))}})
      // Give the PDF parser a dedicated byteOffset=0 buffer, independent of Node's pool.
      const isolated=Buffer.alloc(bytes.length);bytes.copy(isolated)
      parser.parseBuffer(isolated,0)
    })
    input.signal?.throwIfAborted()
    if(!pages.some(page=>page.text.trim()))diagnostics.push({code:'NO_TEXT_LAYER',message:'PDF 没有可提取的文本层；未执行 OCR。'})
    return{bytes,pages,diagnostics}
  }finally{parser.destroy()}
}
export function chunkPages(pages){
  const chunks=[]
  for(const page of pages){
    const paragraphs=page.text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split(/\n\s*\n/).map(text=>text.trim()).filter(Boolean)
    paragraphs.forEach((paragraph,index)=>{
      const characters=Array.from(paragraph)
      for(let offset=0;offset<characters.length;offset+=1200){
        const text=characters.slice(offset,offset+1200).join(''),sha256=textHash(text)
        chunks.push({chunkId:`p${page.page??0}-${index+1}-${offset/1200+1}-${sha256.slice(0,16)}`,...page.page===undefined?{}:{page:page.page},paragraph:index+1,text,sha256})
      }
    })
  }
  return chunks
}
