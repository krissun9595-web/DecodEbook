// Harness for the proposed general-<p> block-indent (read margin-left -> NBSP). Counts, per EPUB, how
// many body <p> have boxLeft margin-left >= 0.5em (would become block-indented) + samples, to confirm it
// only catches genuine set-off extracts/quotes, not normal first-line-indent paragraphs (margin-left 0).
import { parseHTML } from 'linkedom';
import { execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EPUBS = fs.readdirSync('/root/testfiles').filter(f => f.endsWith('.epub')).map(f => path.join('/root/testfiles', f));
const lenToEm = (v) => { const m=/(-?[\d.]+)\s*(em|rem|px)/i.exec(v||''); if(m){const n=parseFloat(m[1])||0;return m[2].toLowerCase()==='px'?n/16:n;} return /^\s*0/.test(v||'')?0:null; };
const specOf = s=>{const i=(s.match(/#[\w-]+/g)||[]).length,c=(s.match(/[.\[][\w-]+/g)||[]).length,t=(s.match(/(^|[\s>+~])[a-z][\w-]*/gi)||[]).length;return i*10000+c*100+t;};
function buildCss(t){const rules=[];const clean=t.replace(/\/\*[\s\S]*?\*\//g,'');let m;const rr=/([^{}]+)\{([^}]*)\}/g;while((m=rr.exec(clean))){const sr=m[1].trim(),d=m[2].trim();if(!sr||sr.startsWith('@'))continue;for(const o of sr.split(',')){const s=o.trim();if(!s||s==='*')continue;const rm=s.split(/\s*[>+~\s]\s*/).filter(Boolean).pop()||'';rules.push({sel:s,decl:d,spec:specOf(s),tag:(rm.match(/^[a-z][\w-]*/i)||[''])[0].toLowerCase()});}}return rules;}
function dpMaker(rules){const mS=(el,c)=>{const t=c.match(/^[a-z][\w-]*/i);if(t&&el.tagName.toLowerCase()!==t[0].toLowerCase())return false;for(const cm of c.matchAll(/\.([A-Za-z0-9_-]+)/g))if(!(el.getAttribute('class')||'').split(/\s+/).includes(cm[1]))return false;return true;};const sM=(el,sel)=>{const p=sel.split(/\s+/).filter(Boolean);if(!mS(el,p[p.length-1]))return false;let a=el.parentElement;for(let i=p.length-2;i>=0;i--){while(a&&!mS(a,p[i]))a=a.parentElement;if(!a)return false;a=a.parentElement;}return true;};return (el,pr)=>{const h=rules.filter(r=>(!r.tag||r.tag===el.tagName.toLowerCase())&&sM(el,r.sel)).sort((a,b)=>a.spec-b.spec);let v=null;for(const r of h){const dm=new RegExp(`(?:^|;)\\s*${pr}\\s*:\\s*([^;]+)`,'i').exec(r.decl);if(dm)v=dm[1].trim();}return v;};}
const sideM=(dp,side)=>(el)=>{const idx={top:0,right:1,bottom:2,left:3};const ex=dp(el,`margin-${side}`);if(ex!=null)return lenToEm(ex.replace(/!important/ig,''))??0;const sh=(dp(el,'margin')||'').replace(/!important/ig,'').trim();if(!sh)return 0;const q=sh.split(/\s+/);let v;if(q.length===4)v=q[idx[side]];else if(q.length===3)v=side==='left'?q[1]:side==='right'?q[1]:side==='top'?q[0]:q[2];else if(q.length===2)v=(side==='left'||side==='right')?q[1]:q[0];else v=q[0];return lenToEm(v)??0;};
for(const epub of EPUBS){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-'));execSync(`cd "${dir}" && unzip -o -q "${epub}"`);
  const cssText=execSync(`find "${dir}" -name '*.css'`).toString().trim().split('\n').filter(Boolean).map(f=>fs.readFileSync(f,'utf8')).join('\n');
  const dp=dpMaker(buildCss(cssText));const bL=sideM(dp,'left');const bR=sideM(dp,'right');const fsz=el=>{const v=dp(el,'font-size');const e=lenToEm(v);return e==null?1:e;};
  const htmls=execSync(`find "${dir}" -name '*.html' -o -name '*.xhtml'`).toString().trim().split('\n').filter(Boolean);
  let total=0,fire=0;const byCls={};
  for(const hf of htmls){const raw=fs.readFileSync(hf,'utf8');if(/<nav\b/i.test(raw))continue;const {document}=parseHTML(raw);
    for(const p of document.querySelectorAll('p')){const t=(p.textContent||'').trim();if(t.length<20)continue;total++;const ml=bL(p),mr=bR(p);const sib=z=>z&&z.tagName.toLowerCase()==="p"&&bR(z)>=0.5&&Math.abs(bL(z)-ml)<0.3;if((mr>=0.5||sib(p.previousElementSibling)||sib(p.nextElementSibling))&&ml>=0.5){fire++;const c=p.getAttribute('class')||'(none)';byCls[c]=(byCls[c]||0)+1;}}}
  console.log(`${path.basename(epub).slice(0,42).padEnd(42)} p=${total} blockIndent=${fire} (${total?(fire/total*100).toFixed(1):0}%)`);
  Object.entries(byCls).sort((a,b)=>b[1]-a[1]).slice(0,4).forEach(([c,n])=>console.log(`   ${n}  .${c}`));
  fs.rmSync(dir,{recursive:true,force:true});
}
