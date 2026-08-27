// Blast-radius for the ROBUST CENTRING leftShared guard. For each PDF, approximate the block grouping:
// cluster lines by y, then group consecutive lines into blocks by a vertical-gap break. For each block whose
// FIRST line is symmetrically inset (the OLD center rule), report whether it is leftShared (multi-line, text
// lines share one left edge) — those FLIP to not-centered. A genuine centered block (varying lefts) stays.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs'; import path from 'node:path';
const PDFS = fs.readdirSync('/root/testfiles').filter(f => f.endsWith('.pdf'));
for (const f of PDFS) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(path.join('/root/testfiles', f))), useSystemFonts: true }).promise;
  let flips = 0, stays = 0; const flipSamples = [], staySamples = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p); const tc = await page.getTextContent();
    const its = tc.items.filter(i => i.str.trim());
    if (!its.length) continue;
    const byY = new Map();
    for (const i of its) { const y = Math.round(i.transform[5]); (byY.get(y) || byY.set(y, []).get(y)).push(i); }
    let lines = [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([y, arr]) => {
      arr.sort((a, b) => a.transform[4] - b.transform[4]);
      const last = arr[arr.length - 1];
      return { y, x: arr[0].transform[4], rightX: last.transform[4] + (last.width || 0), h: Math.max(...arr.map(a => Math.abs(a.transform[3]))), text: arr.map(a => a.str).join('').replace(/\s+/g, ' ').trim() };
    }).filter(l => l.text);
    if (lines.length < 2) continue;
    const hs = lines.map(l => l.h).sort((a, b) => a - b); const bodyFont = hs[Math.floor(hs.length / 2)] || 12;
    const docLeft = Math.min(...lines.map(l => l.x));
    const docRight = Math.max(...lines.map(l => l.rightX));
    const docCentre = (docLeft + docRight) / 2;
    // group into blocks by a vertical gap > 1.6× median line gap
    const gaps = []; for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
    const medGap = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || bodyFont * 1.2;
    const blocks = []; let cur = [lines[0]];
    for (let i = 1; i < lines.length; i++) { if (lines[i - 1].y - lines[i].y > medGap * 1.6) { blocks.push(cur); cur = []; } cur.push(lines[i]); }
    if (cur.length) blocks.push(cur);
    for (const g of blocks) {
      const first = g[0];
      const left = first.x - docLeft, right = docRight - first.rightX, centre = (first.x + first.rightX) / 2;
      const symmetric = left > bodyFont && right > bodyFont && Math.abs(left - right) <= bodyFont && Math.abs(centre - docCentre) <= bodyFont;
      if (!symmetric) continue; // OLD rule would NOT center it
      const t = g.filter(l => (l.rightX - l.x) > bodyFont);
      const leftShared = t.length >= 2 && (Math.max(...t.map(l => l.x)) - Math.min(...t.map(l => l.x))) <= bodyFont;
      if (leftShared) { flips++; if (flipSamples.length < 6) flipSamples.push(`p${p} ${JSON.stringify(g.map(l => l.text).join(' ').slice(0, 50))}`); }
      else { stays++; if (staySamples.length < 6) staySamples.push(`p${p} ${JSON.stringify(g.map(l => l.text).join(' ').slice(0, 46))}`); }
    }
  }
  console.log(`\n${f.slice(0, 46)} — FLIP(→not-centered)=${flips}  STAY(centered)=${stays}`);
  for (const s of flipSamples) console.log(`   FLIP ${s}`);
  for (const s of staySamples) console.log(`   stay ${s}`);
}
