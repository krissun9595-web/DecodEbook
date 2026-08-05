// Headless harness for the EPUB measured-paragraph-gap change (U+E028). Replicates processEpub's
// lenToEm / buildCssModel / declProp / vMarginEm over the real EPUBs, and reports, per book, how many
// body <p> would emit E028 (_gapAbove >= 0.35em) — so a block-spaced EPUB shows its real spacing while a
// first-line-indent EPUB (margin:0) stays ~0. Run: node scripts/epub-gap-audit.mjs
import { parseHTML } from 'linkedom';
import { execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const EPUBS = fs.readdirSync('/root/testfiles').filter(f => f.endsWith('.epub')).map(f => path.join('/root/testfiles', f));
const lenToEm = (value) => { const m = /(-?[\d.]+)\s*(em|rem|px)/i.exec(value || ''); if (m) { const n = parseFloat(m[1]) || 0; return m[2].toLowerCase() === 'px' ? n / 16 : n; } return /^\s*0/.test(value || '') ? 0 : null; };
const specOf = (sel) => { const ids=(sel.match(/#[\w-]+/g)||[]).length, cls=(sel.match(/[.\[][\w-]+/g)||[]).length, tag=(sel.match(/(^|[\s>+~])[a-z][\w-]*/gi)||[]).length; return ids*10000+cls*100+tag; };
function buildCss(cssText){ const cssRules=[]; const clean=cssText.replace(/\/\*[\s\S]*?\*\//g,''); const ruleRe=/([^{}]+)\{([^}]*)\}/g; let m;
  while((m=ruleRe.exec(clean))){ const selRaw=m[1].trim(), decl=m[2].trim(); if(!selRaw||selRaw.startsWith('@'))continue;
    for(const oneSel of selRaw.split(',')){ const sel=oneSel.trim(); if(!sel||sel==='*')continue; const rm=sel.split(/\s*[>+~\s]\s*/).filter(Boolean).pop()||''; const rmTag=(rm.match(/^[a-z][\w-]*/i)||[''])[0].toLowerCase(); cssRules.push({sel,decl,spec:specOf(sel),tag:rmTag}); } }
  return cssRules; }
function makeDeclProp(cssRules){
  const matchSimple=(el,c)=>{ const tagM=c.match(/^[a-z][\w-]*/i); if(tagM&&el.tagName.toLowerCase()!==tagM[0].toLowerCase())return false; for(const cm of c.matchAll(/\.([A-Za-z0-9_-]+)/g)) if(!(el.getAttribute('class')||'').split(/\s+/).includes(cm[1]))return false; for(const am of c.matchAll(/\[([\w-]+)(?:([~]?=)"?([^"\]]*)"?)?\]/g)){ const v=el.getAttribute(am[1]); if(v==null)return false; if(am[2]==='='&&v!==am[3])return false; if(am[2]==='~='&&!v.split(/\s+/).includes(am[3]))return false; } return true; };
  const selMatches=(el,sel)=>{ const parts=sel.split(/\s+/).filter(Boolean); if(!matchSimple(el,parts[parts.length-1]))return false; let anc=el.parentElement; for(let i=parts.length-2;i>=0;i--){ while(anc&&!matchSimple(anc,parts[i]))anc=anc.parentElement; if(!anc)return false; anc=anc.parentElement; } return true; };
  return (el,prop)=>{ const hits=cssRules.filter(r=>(!r.tag||r.tag===el.tagName.toLowerCase())&&selMatches(el,r.sel)).sort((a,b)=>a.spec-b.spec); let val=null; for(const r of hits){ const dm=new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`,'i').exec(r.decl); if(dm)val=dm[1].trim(); } return val; };
}
const makeVMargin=(declProp)=>(el)=>{ const side=(which)=>{ const ex=declProp(el,`margin-${which}`); if(ex!=null)return lenToEm(ex.replace(/!important/ig,''))??0; const sh=(declProp(el,'margin')||'').replace(/!important/ig,'').trim(); if(!sh)return 0; const q=sh.split(/\s+/); return lenToEm(which==='top'?q[0]:(q.length>=3?q[2]:q[0]))??0; }; const st=el.style||{}; return { top:(st.marginTop&&lenToEm(st.marginTop))||side('top'), bottom:(st.marginBottom&&lenToEm(st.marginBottom))||side('bottom') }; };

for(const epub of EPUBS){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gap-')); execSync(`cd "${dir}" && unzip -o -q "${epub}"`);
  const cssText=execSync(`find "${dir}" -name '*.css'`).toString().trim().split('\n').filter(Boolean).map(f=>fs.readFileSync(f,'utf8')).join('\n');
  const declProp=makeDeclProp(buildCss(cssText)); const vMarginEm=makeVMargin(declProp);
  const htmlFiles=execSync(`find "${dir}" -name '*.html' -o -name '*.xhtml'`).toString().trim().split('\n').filter(Boolean);
  let total=0, fire=0; const samples=[];
  for(const hf of htmlFiles){ const raw=fs.readFileSync(hf,'utf8'); if(/\b(nav|toc)\b/i.test(path.basename(hf))||/<nav\b/i.test(raw))continue;
    const { document }=parseHTML(raw);
    for(const p of document.querySelectorAll('p')){ const txt=(p.textContent||'').replace(/\s+/g,' ').trim(); if(txt.length<20)continue; total++;
      const prev=p.previousElementSibling; const gap=Math.max(vMarginEm(p).top, (prev&&!/^h[1-6]$/i.test(prev.tagName||''))?vMarginEm(prev).bottom:0);
      if(gap>=0.35){ fire++; if(samples.length<5) samples.push(`gap=${gap.toFixed(2)}em cls="${p.getAttribute('class')||''}" | ${txt.slice(0,30)}`); } }
  }
  console.log(`${path.basename(epub).slice(0,44).padEnd(44)} p=${total} E028=${fire} (${total?(fire/total*100).toFixed(1):0}%)`);
  samples.forEach(s=>console.log('   '+s));
  fs.rmSync(dir,{recursive:true,force:true});
}
