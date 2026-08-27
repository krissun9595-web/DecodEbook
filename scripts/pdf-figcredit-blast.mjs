import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs'; import path from 'node:path';
const PDFS = fs.readdirSync('/root/testfiles').filter(f => f.endsWith('.pdf'));
const italOf = (page, fn) => { try { if (page.commonObjs?.has?.(fn)) return /italic|oblique/.test(String(page.commonObjs.get(fn)?.name||'').toLowerCase()); } catch {} return false; };
const capOpener = /^[*_~\s]*(?:Figure|Fig\.|Table|Plate|Chart)\s*\d/i;
const OLD_KW = /^(?:original art|photograph|photo|illustration|image|drawing|painting|courtesy|source|credit|reprinted|adapted|art by|map by|diagram by|©|copyright|by\s+[A-Z])/i;
const NEW_KW = /^(?:original art|photograph|photo|illustration|image|drawing|painting|courtesy|source|credit|reprinted|adapted|(?:art|map|diagram|figure|photo|photograph|illustration|drawing|painting|image)\s+by|©|copyright|by\s+[A-Z])/i;
for (const f of PDFS) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(path.join('/root/testfiles', f))), useSystemFonts: true }).promise;
  const hits = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p); const [, tc] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
    const its = tc.items.filter(i => i.str.trim());
    // cluster into lines by y; build a per-line "block text" with *italic* runs (mimic the extractor's per-line wrap)
    const byY = new Map(); for (const i of its) { const y = Math.round(i.transform[5]); (byY.get(y)||byY.set(y,[]).get(y)).push(i); }
    // build blocks = consecutive lines whose text — a CAPTION line + following ITALIC lines (approx clustering)
    const lines = [...byY.entries()].sort((a,b)=>b[0]-a[0]).map(([y,arr])=>{arr.sort((a,b)=>a.transform[4]-b.transform[4]);
      let t='',open=false; for(const i of arr){const it=italOf(page,i.fontName); if(it&&!open){t+='*';open=true;} if(!it&&open){t+='*';open=false;} t+=i.str;} if(open)t+='*';
      return {y, x:arr[0].transform[4], text:t.replace(/\s+/g,' ').trim()};});
    for (let k=0;k<lines.length;k++){
      if(!capOpener.test(lines[k].text.replace(/[*_]/g,''))) continue;
      // gather this caption + following consecutive italic-ish lines into one block text
      let block=lines[k].text; let j=k+1;
      while(j<lines.length && Math.abs(lines[j-1].y-lines[j].y)<20 && /^\*|by |art|photo|courtesy|source|©/i.test(lines[j].text.replace(/^\*/,''))){ block+=' '+lines[j].text; j++; }
      const mOld=block.match(/^(.+?\S)\s+(\*[^*\n]+\*|_[^_\n]+_)\s*$/u);
      const mNew=block.match(/^(.+?\S)\s+((?:(?:\*[^*\n]+\*|_[^_\n]+_)\s*)+)$/u);
      const ciOld=mOld?mOld[2].replace(/^[*_]|[*_]$/g,'').trim():'';
      const ciNew=mNew?mNew[2].replace(/[*_]/g,'').replace(/\s+/g,' ').trim():'';
      const oldSplit=mOld&&!capOpener.test(ciOld)&&OLD_KW.test(ciOld);
      const newSplit=mNew&&!capOpener.test(ciNew)&&NEW_KW.test(ciNew);
      if(oldSplit!==newSplit) hits.push(`p${p} [${oldSplit?'OLD':'   '}→${newSplit?'NEW-SPLIT':'no'}] ${JSON.stringify(block.slice(0,80))}`);
    }
  }
  console.log(`\n${f.slice(0,44)} — newly-affected caption blocks: ${hits.length}`);
  for(const h of hits.slice(0,12)) console.log('  '+h);
}
