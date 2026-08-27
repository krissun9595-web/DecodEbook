// Dump ALL lines on the McLuhan epigraph page (Sovereign p15) with geometry, and replicate the extraction
// display-page align classifier (leftVaries / rightSpan / centreSpan over non-heading lines) to see why it
// tags center. A "heading" here ≈ a line notably taller than body (small-caps head measured via cap height).
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs'; import path from 'node:path';
const f = fs.readdirSync('/root/testfiles').find(x => /Sovereign/.test(x) && x.endsWith('.pdf'));
const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(path.join('/root/testfiles', f))), useSystemFonts: true }).promise;
const span = a => a.length ? Math.max(...a) - Math.min(...a) : 0;
const page = await doc.getPage(15); const tc = await page.getTextContent();
const its = tc.items.filter(i => i.str.trim());
const byY = new Map();
for (const i of its) { const y = Math.round(i.transform[5]); (byY.get(y) || byY.set(y, []).get(y)).push(i); }
const lines = [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([y, arr]) => {
  arr.sort((a, b) => a.transform[4] - b.transform[4]);
  const x = arr[0].transform[4];
  const last = arr[arr.length - 1];
  const rightX = last.transform[4] + (last.width || 0);
  const h = Math.max(...arr.map(a => Math.abs(a.transform[3])));
  const capH = Math.max(...arr.filter(a => /[A-Z0-9]/.test(a.str)).map(a => Math.abs(a.transform[3])), 0);
  return { y, x, rightX, h, capH, text: arr.map(a => a.str).join('').replace(/\s+/g, ' ').trim() };
}).filter(l => l.text);
const hs = lines.map(l => l.h).sort((a, b) => a - b); const bodyH = hs[Math.floor(hs.length / 2)];
console.log(`page 15 — bodyH≈${bodyH.toFixed(1)}, ${lines.length} lines`);
for (const l of lines) console.log(`  x=${l.x.toFixed(1)} rX=${l.rightX.toFixed(1)} mid=${((l.x + l.rightX) / 2).toFixed(1)} h=${l.h.toFixed(1)} capH=${l.capH.toFixed(1)}  ${JSON.stringify(l.text.slice(0, 54))}`);
// classifier over non-heading lines (heading ≈ capH >= bodyH*1.3)
const body = lines.filter(l => !(l.capH >= bodyH * 1.3 && l.capH >= l.h * 1.25));
const bodyFont = bodyH, tol = Math.max(6, bodyFont);
console.log(`\nnon-heading lines: ${body.length}`);
for (const l of body) console.log(`   mid=${((l.x + l.rightX) / 2).toFixed(1)} x=${l.x.toFixed(1)} rX=${l.rightX.toFixed(1)} ${JSON.stringify(l.text.slice(0, 40))}`);
console.log(`leftVaries(${span(body.map(l => l.x)).toFixed(1)}>${(bodyFont * 2).toFixed(1)})=${span(body.map(l => l.x)) > bodyFont * 2}  rightSpan=${span(body.map(l => l.rightX)).toFixed(1)} (tol ${tol.toFixed(1)})  centreSpan=${span(body.map(l => (l.x + l.rightX) / 2)).toFixed(1)}`);
