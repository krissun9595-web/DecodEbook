// Approximate heading-italic blast radius per PDF: find short, larger-than-body lines (heading-like) and
// report whether their glyphs are italic (→ would emit E026). Confirms only genuine italic headings fire.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs'; import path from 'node:path';
const PDFS=fs.readdirSync('/root/testfiles').filter(f=>f.endsWith('.pdf'));
const emphOf=(page,fn)=>{ try{ if(page.commonObjs?.has?.(fn)){ const n=String(page.commonObjs.get(fn)?.name||'').toLowerCase(); return {italic:/italic|oblique|[-_ ](?:it|ita|obl)/.test(n), name:n}; } }catch{} return {italic:false,name:''}; };
for(const f of PDFS){
  const doc=await getDocument({data:new Uint8Array(fs.readFileSync(path.join('/root/testfiles',f))), useSystemFonts:true}).promise;
  const italHead=new Set(), plainHead=new Set(); let bodyH=0, samples=0;
  for(let p=6;p<=Math.min(doc.numPages,60);p++){
    const page=await doc.getPage(p); const [,tc]=await Promise.all([page.getOperatorList(), page.getTextContent()]);
    const its=tc.items.filter(i=>i.str.trim());
    const hs=its.map(i=>Math.abs(i.transform[3])); const med=hs.slice().sort((a,b)=>a-b)[Math.floor(hs.length/2)]||10; if(!bodyH) bodyH=med;
    // group items into lines by y
    const byY=new Map(); for(const i of its){ const y=Math.round(i.transform[5]); (byY.get(y)||byY.set(y,[]).get(y)).push(i); }
    for(const [,line] of byY){ const txt=line.map(i=>i.str).join('').replace(/\s+/g,' ').trim(); if(txt.length<4||txt.length>60) continue;
      const lh=Math.abs(line[0].transform[3]); if(lh < med*1.12) continue;                 // heading-like: larger than body
      const allItal=line.every(i=>!i.str.trim()||emphOf(page,i.fontName).italic);
      if(allItal){ if(italHead.size<4) italHead.add(txt.slice(0,38)); } else { if(plainHead.size<3) plainHead.add(txt.slice(0,38)); } }
  }
  console.log(`\n${f.slice(0,46)}`);
  console.log(`  italic heading-like (→E026): ${italHead.size?[...italHead].map(s=>JSON.stringify(s)).join(', '):'none'}`);
  console.log(`  plain  heading-like (stay):  ${plainHead.size?[...plainHead].map(s=>JSON.stringify(s)).join(', '):'none'}`);
}
