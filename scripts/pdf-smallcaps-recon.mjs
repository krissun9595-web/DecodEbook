// Validate the PDF small-caps DETECTION + CASE RECONSTRUCTION rule across all PDFs (blast radius).
// Rule: within a line, uppercase-letter items in ONE font at TWO height tiers (tall≈capMax, short≤0.88×) =
// small caps → lowercase the short-tier items (encoded original lowercase), flag the line small-caps.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs'; import path from 'node:path';
const PDFS = fs.readdirSync('/root/testfiles').filter(f => f.endsWith('.pdf'));
const famOf = (page, fn) => { try { if (page.commonObjs?.has?.(fn)) return String(page.commonObjs.get(fn)?.name || ''); } catch {} return ''; };
const mode = a => { const m = new Map(); let best = a[0], bc = 0; for (const v of a) { const c = (m.get(v) || 0) + 1; m.set(v, c); if (c > bc) { bc = c; best = v; } } return best; };

for (const f of PDFS) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(path.join('/root/testfiles', f))), useSystemFonts: true }).promise;
  const fires = []; let lines = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p); const tc = await page.getTextContent();
    const its = tc.items.filter(i => i.str.trim()).map(i => ({ str: i.str, h: Math.abs(i.transform[3]), x: i.transform[4], y: Math.round(i.transform[5]), family: famOf(page, i.fontName) }));
    const byY = new Map(); for (const i of its) (byY.get(i.y) || byY.set(i.y, []).get(i.y)).push(i);
    for (const [, line] of byY) {
      line.sort((a, b) => a.x - b.x); lines++;
      const items = line.map(i => ({ ...i }));
      // ── detection (mirrors the App.tsx insert) ──
      const upItems = items.filter(it => /[A-Z]/.test(it.str) && !/[a-z]/.test(it.str) && it.h > 0);
      if (upItems.length < 2) continue;
      let capMax = 0; for (const it of upItems) if (it.h > capMax) capMax = it.h;
      const fam0 = mode(upItems.map(it => it.family));
      const inFam = upItems.filter(it => it.family === fam0);
      const shorts = inFam.filter(it => it.h <= capMax * 0.88 && it.h >= capMax * 0.55);
      const talls = inFam.filter(it => it.h >= capMax * 0.92);
      if (!shorts.length || !talls.length) continue;
      // ── reconstruction ──
      for (const it of items) if (it.h <= capMax * 0.88 && it.h >= capMax * 0.55 && it.family === fam0 && /[A-Z]/.test(it.str) && !/[a-z]/.test(it.str)) it.str = it.str.toLowerCase();
      const before = line.map(i => i.str).join('').replace(/\s+/g, ' ').trim();
      const after = items.map(i => i.str).join('').replace(/\s+/g, ' ').trim();
      if (fires.length < 8) fires.push({ p, before: before.slice(0, 54), after: after.slice(0, 54) });
    }
  }
  console.log(`\n${f.slice(0, 48)} — ${fires.length ? 'FIRES' : 'no fire'} (${lines} lines scanned)`);
  for (const x of fires) console.log(`  p${x.p}  ${JSON.stringify(x.before)}\n      → ${JSON.stringify(x.after)}`);
}
