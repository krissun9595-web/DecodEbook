// Audit PDF small-caps: within each line, detect runs of UPPERCASE-letter items whose heights are BIMODAL
// (a tall cap-height glyph adjacent to a shorter same-family glyph = small caps). Dump the structure so we
// can see how the corpus encodes small caps (per-item split? uniform reduced height? fully-capped phrases?).
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs'; import path from 'node:path';
const only = process.argv[2];               // optional filename substring filter
const PDFS = fs.readdirSync('/root/testfiles').filter(f => f.endsWith('.pdf') && (!only || f.includes(only)));
const famOf = (page, fn) => { try { if (page.commonObjs?.has?.(fn)) return String(page.commonObjs.get(fn)?.name || ''); } catch {} return ''; };
const isUpperWord = s => /^[A-Z][A-Z.,;:'’&\- ]*$/.test(s) && /[A-Z]/.test(s);

for (const f of PDFS) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(path.join('/root/testfiles', f))), useSystemFonts: true }).promise;
  console.log(`\n===== ${f.slice(0, 50)} (${doc.numPages}pp) =====`);
  const samples = []; let bodyH = 0;
  for (let p = 6; p <= Math.min(doc.numPages, 80) && samples.length < 12; p++) {
    const page = await doc.getPage(p); const tc = await page.getTextContent();
    const its = tc.items.filter(i => i.str.trim()).map(i => ({ str: i.str, h: Math.abs(i.transform[3]), x: i.transform[4], y: Math.round(i.transform[5]), fam: famOf(page, i.fontName) }));
    if (!its.length) continue;
    if (!bodyH) { const hs = its.map(i => i.h).sort((a, b) => a - b); bodyH = hs[Math.floor(hs.length / 2)]; }
    // group into lines by y
    const byY = new Map(); for (const i of its) (byY.get(i.y) || byY.set(i.y, []).get(i.y)).push(i);
    for (const [, line] of byY) {
      line.sort((a, b) => a.x - b.x);
      const txt = line.map(i => i.str).join('').replace(/\s+/g, ' ').trim();
      // Candidate: line has ≥2 uppercase-ish items with a height DROP between adjacent same-family items
      let bimodal = false;
      for (let k = 1; k < line.length; k++) {
        const a = line[k - 1], b = line[k];
        if (a.fam && a.fam === b.fam && isUpperWord(a.str) && isUpperWord(b.str)) {
          const r = Math.min(a.h, b.h) / Math.max(a.h, b.h);
          if (r > 0.55 && r < 0.9) bimodal = true;
        }
      }
      // Also: a whole line of uppercase letters at a height notably below bodyH*capfactor (fully small-capped)
      const allUpper = /[A-Z]/.test(txt) && !/[a-z]/.test(txt) && txt.replace(/[^A-Za-z]/g, '').length >= 4;
      if ((bimodal || (allUpper && line[0].h < bodyH * 0.95)) && samples.length < 12) {
        samples.push({ p, txt: txt.slice(0, 56), bimodal, items: line.slice(0, 10).map(i => `${JSON.stringify(i.str)}@${i.h.toFixed(1)}`) });
      }
    }
  }
  console.log(`  bodyH≈${bodyH.toFixed(1)}`);
  for (const s of samples) console.log(`  p${s.p} ${s.bimodal ? 'BIMODAL' : 'all-upper'} ${JSON.stringify(s.txt)}\n      ${s.items.join('  ')}`);
  if (!samples.length) console.log('  (no small-caps candidates found)');
}
