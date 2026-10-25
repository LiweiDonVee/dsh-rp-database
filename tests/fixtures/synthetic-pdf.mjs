/** Public generated PDF with a real cross-reference table; no fixture renderer/CLI. */
export function syntheticPdf({pages=['Harbor alpha','Mountain beta'],imageOnly=false}={}){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],kids=[]
  for(const text of pages){
    const pageId=objects.length+1,contentId=pageId+1,imageId=pageId+2;kids.push(`${pageId} 0 R`)
    const content=imageOnly?'q 30 0 0 30 10 10 cm /Im0 Do Q':`BT /F1 12 Tf 40 160 Td (${text.replace(/[()\\]/g,'\\$&')}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 250 200] /Resources << /Font << /F1 3 0 R >> ${imageOnly?`/XObject << /Im0 ${imageId} 0 R >>`:''} >> /Contents ${contentId} 0 R >>`,`<< /Length ${Buffer.byteLength(content,'latin1')} >>\nstream\n${content}\nendstream`)
    if(imageOnly)objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n\xFF\xFF\xFF\nendstream')
  }
  objects[1]=`<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`
  let source='%PDF-1.4\n',offsets=[0]
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(source,'latin1'));source+=`${index+1} 0 obj\n${object}\nendobj\n`})
  const xref=Buffer.byteLength(source,'latin1')
  source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(source,'latin1')
}
