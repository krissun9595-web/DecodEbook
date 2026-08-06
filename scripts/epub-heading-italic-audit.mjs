// Blast radius of the wholly-italic <h*> detection across all EPUBs: lists, per book, how many headings
// would emit E026 (italic) vs stay plain, with samples — so we can point at concrete verify cases and
// confirm plain/bold headings never misfire.
import { parseHTML } from 'linkedom';
import { execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EPUBS=fs.readdirSync('/root/testfiles').filter(f=>f.endsWith('.epub')).map(f=>path.join('/root/testfiles',f));
const whollyItalic=(el)=>{ let hasText=false, allItalic=true;
  const walk=(n,it)=>{ if(n.nodeType===3){ if((n.textContent||'').trim()){ hasText=true; if(!it) allItalic=false; } return; }
    if(n.nodeType!==1) return; const t=(n.tagName||'').toLowerCase(); const nit=it||t==='i'||t==='em';
    for(const c of Array.from(n.childNodes)) walk(c,nit); };
  walk(el,false); return hasText&&allItalic; };
for(const epub of EPUBS){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hi-'));execSync(`cd "${dir}" && unzip -o -q "${epub}"`);
  const htmls=execSync(`find "${dir}" \\( -name '*.html' -o -name '*.xhtml' \\)`).toString().trim().split('\n').filter(Boolean);
  let ital=0, plain=0; const italSamples=[], plainSamples=[];
  for(const hf of htmls){ const {document}=parseHTML(fs.readFileSync(hf,'utf8'));
    for(const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')){ const t=(h.textContent||'').replace(/\s+/g,' ').trim(); if(!t||t.length>90) continue;
      if(whollyItalic(h)){ ital++; if(italSamples.length<3) italSamples.push(t.slice(0,40)); }
      else { plain++; if(plainSamples.length<2) plainSamples.push(t.slice(0,40)); } } }
  console.log(`\n${path.basename(epub).slice(0,46)}`);
  console.log(`  italic headings (→E026): ${ital}${italSamples.length?'  e.g. '+JSON.stringify(italSamples):''}`);
  console.log(`  plain  headings (stay):  ${plain}${plainSamples.length?'  e.g. '+JSON.stringify(plainSamples):''}`);
  fs.rmSync(dir,{recursive:true,force:true});
}
