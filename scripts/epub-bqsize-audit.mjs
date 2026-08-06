import { parseHTML } from 'linkedom';
import { execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EPUB='/root/testfiles/The Sovereign Individual Mastering the Transition to the Information Age (James Dale Davidson  Lord William Rees-Mogg) (Z-Library).epub';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bq-'));execSync(`cd "${dir}" && unzip -o -q "${EPUB}"`);
const cssText=execSync(`find "${dir}" -name '*.css'`).toString().trim().split('\n').filter(Boolean).map(f=>fs.readFileSync(f,'utf8')).join('\n');
// build cssFontRaw (class -> font-size) like App.tsx
const cssFontRaw={};
for(const m of cssText.matchAll(/([^{}]+)\{([^}]*)\}/g)){ const fs2=/font-size\s*:\s*([^;}]+)/i.exec(m[2]); if(!fs2) continue;
  for(const sel of m[1].split(',')){ const rm=sel.trim().split(/\s*[>+~\s]\s*/).filter(Boolean).pop()||''; for(const cm of rm.matchAll(/\.([A-Za-z0-9_-]+)/g)) cssFontRaw[cm[1]]=fs2[1].trim(); } }
const cssFontSizeOf=(el)=>{ for(const c of (el.getAttribute('class')||'').split(/\s+/)) if(cssFontRaw[c]) return cssFontRaw[c]; return null; };
const UA={h1:2,h2:1.5,h3:1.17,h4:1,h5:0.83,h6:0.67};
const resolveFontEm=(el,depth=0)=>{ if(!el||depth>10) return 1; const parentEm=()=>resolveFontEm(el.parentElement,depth+1); const raw=cssFontSizeOf(el);
  if(raw==null){ const t=el.tagName?.toLowerCase(); return t&&UA[t]!==undefined?UA[t]*parentEm():parentEm(); }
  const v=raw.trim().toLowerCase(); let m;
  if((m=/(-?[\d.]+)px/.exec(v))) return (parseFloat(m[1])||16)/16;
  if((m=/(-?[\d.]+)em/.exec(v))) return (parseFloat(m[1])||1)*parentEm();
  if((m=/(-?[\d.]+)%/.exec(v))) return ((parseFloat(m[1])||100)/100)*parentEm();
  return parentEm(); };
const html=fs.readFileSync(`${dir}/text/part0007_split_001.html`,'utf8');
const {document}=parseHTML(html);
const bq=[...document.querySelectorAll('blockquote')].find(b=>/nothing covered that shall/.test(b.textContent||''));
const body=document.querySelector('body');
const currentBodyEm=resolveFontEm(body)||1;
console.log('body class:', body.getAttribute('class'), 'currentBodyEm=', currentBodyEm);
const kids=[...bq.children];
console.log('blockquote class:', bq.getAttribute('class'));
for(const k of kids){ console.log(`  kid <${k.tagName.toLowerCase()} class="${k.getAttribute('class')}"> fontSizeOf=${cssFontSizeOf(k)} resolveEm=${resolveFontEm(k).toFixed(3)}`); }
const minEm=Math.min(...kids.map(k=>resolveFontEm(k)));
const ratio=minEm/currentBodyEm;
const tier = ratio<=0.78?'E01B':ratio<0.97?'E01C':'(none)';
console.log(`minEm=${minEm.toFixed(3)} ratio=${ratio.toFixed(3)} -> sizeTier=${tier}`);
fs.rmSync(dir,{recursive:true,force:true});
