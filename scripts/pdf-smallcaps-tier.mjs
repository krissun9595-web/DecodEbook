// Blast radius for the small-caps size-tier fix. Per line: char-weighted height (Σ h·len / Σ len) vs cap
// height (tallest letter/digit item). A block is small-caps when some line's capH ≥ 1.25× its char-weighted
// h. Report, per PDF, how many lines are small-caps (would size off capH now) — should be only attributions /
// chart-data titles, not body.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs'; import path from 'node:path';
const PDFS = fs.readdirSync('/root/testfiles').filter(f => f.endsWith('.pdf'));
for (const f of PDFS) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(path.join('/root/testfiles', f))), useSystemFonts: true }).promise;
  let sc = 0, total = 0; const samples = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p); const tc = await page.getTextContent();
    const its = tc.items.filter(i => i.str.trim());
    const byY = new Map();
    for (const i of its) { const y = Math.round(i.transform[5]); (byY.get(y) || byY.set(y, []).get(y)).push(i); }
    for (const [, arr] of byY) {
      total++;
      let sumH = 0, sumL = 0, capH = 0;
      for (const i of arr) { const h = Math.abs(i.transform[3]); const L = i.str.length; sumH += h * L; sumL += L; if (/[A-Za-z0-9]/.test(i.str)) capH = Math.max(capH, h); }
      const charH = sumL ? sumH / sumL : 0;
      if (charH > 0 && capH >= charH * 1.25) {
        sc++;
        if (samples.length < 8) samples.push(`charH=${charH.toFixed(1)} capH=${capH.toFixed(1)} ${JSON.stringify(arr.map(a => a.str).join('').replace(/\s+/g, ' ').trim().slice(0, 46))}`);
      }
    }
  }
  console.log(`\n${f.slice(0, 46)} — small-caps lines: ${sc}/${total}`);
  for (const s of samples) console.log(`   ${s}`);
}
