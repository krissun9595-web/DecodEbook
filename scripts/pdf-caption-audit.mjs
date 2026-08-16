// Figure-caption / narrow-inset-column REGRESSION HARNESS.
//
// The bug: a figure caption (BHI "Figure 2.8: The Roomba…") is typeset in a NARROW column
// symmetrically inset from the body margins. On a single-column page its lines have col===undefined,
// so isShortColLine / the "fills measure" tests measure them against the PAGE width — every caption
// line reads as "short" → bothShort shatters the caption one-block-per-line, and the per-line centring
// heuristic then centres each short line.
//
// The FIX will treat a run of consecutive body lines that form a narrow BOTH-SIDE-inset column as one
// block (measured against its own column width) and NOT centre it. This harness finds EVERY such run
// across all test PDFs so we can see exactly what the fix would touch (blast radius) and confirm the
// runs are captions / set-off quotes (correct to join), not prose (a regression).
//
//   node scripts/pdf-caption-audit.mjs
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';

const DIR = '/root/testfiles';
const PDFS = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mode = (a) => { const m = new Map(); for (const v of a) { const k = Math.round(v); m.set(k, (m.get(k) || 0) + 1); } let best = 0, bv = 0; for (const [k, c] of m) if (c > bv) { bv = c; best = k; } return best; };

// Cluster text items into lines by baseline y (tol = median glyph height * 0.5), like clusterLines.
function pageLines(items) {
  const its = items.filter(i => i.str && i.str.trim()).map(i => ({
    s: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height || Math.abs(i.transform[3]) || 10,
  }));
  if (!its.length) return { lines: [], bodyH: 10 };
  const bodyH = median(its.map(i => i.h)) || 10;
  const tol = Math.max(2, bodyH * 0.5);
  its.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of its) {
    const L = lines.find(l => Math.abs(l.y - it.y) <= tol);
    if (L) L.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    L.x = Math.min(...L.items.map(i => i.x));
    L.rightX = Math.max(...L.items.map(i => i.x + i.w));
    L.text = L.items.map(i => i.s).join('').replace(/\s+/g, ' ').trim();
    L.h = median(L.items.map(i => i.h)) || bodyH;
  }
  lines.sort((a, b) => b.y - a.y);
  return { lines, bodyH };
}

const isListish = (t) => /^(?:[••▪●\-–—*]|\d{1,2}[.)]|[a-z][.)]|[ivxlcdm]{1,4}[.)])\s/i.test(t);

let totalRuns = 0;
for (const file of PDFS) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(`${DIR}/${file}`)), useSystemFonts: true }).promise;
  const bookRuns = [];
  for (let pg = 1; pg <= doc.numPages; pg++) {
    const page = await doc.getPage(pg);
    const { lines, bodyH } = pageLines((await page.getTextContent()).items);
    if (lines.length < 3) continue;
    const bodyFont = bodyH;
    const bodyLeft = mode(lines.map(l => l.x));
    const rightMargin = mode(lines.map(l => l.rightX));
    if (rightMargin <= bodyLeft) continue;
    // Find maximal runs of >=2 consecutive lines forming a narrow BOTH-SIDE-inset column:
    //  - left inset:  min(x) > bodyLeft + 2*bodyFont
    //  - right inset: max(rightX) < rightMargin - 2*bodyFont
    //  - constant left: span(x) <= bodyFont
    //  - not a list/heading run
    let i = 0;
    while (i < lines.length) {
      let j = i + 1;
      while (j < lines.length) {
        const run = lines.slice(i, j + 1);
        const xs = run.map(l => l.x), rxs = run.map(l => l.rightX);
        const leftInset = Math.min(...xs) > bodyLeft + 2 * bodyFont;
        const rightInset = Math.max(...rxs) < rightMargin - 2 * bodyFont;
        const constLeft = Math.max(...xs) - Math.min(...xs) <= bodyFont;
        if (leftInset && rightInset && constLeft) j++; else break;
      }
      const run = lines.slice(i, j);
      if (run.length >= 2 && !run.some(l => isListish(l.text))) {
        // The fix only newly-JOINS a run whose lines form a JUSTIFIED column: >=3 consecutive lines
        // sharing a right edge (rx span <= bodyFont) — i.e. they wrapped at a common column margin.
        // Line-structured data (index/TOC/code) has VARYING right edges → this stays false → untouched.
        let maxSameRight = 1;
        for (let a = 0; a < run.length; a++) { let c = 1; for (let b = a + 1; b < run.length && Math.abs(run[b].rightX - run[a].rightX) <= bodyFont; b++) c++; maxSameRight = Math.max(maxSameRight, c); }
        const wouldJoin = maxSameRight >= 3;
        bookRuns.push({ pg, n: run.length, sameRight: maxSameRight, wouldJoin, x: Math.round(run[0].x), rx: Math.round(Math.max(...run.map(l => l.rightX))), text: run.map(l => l.text).join(' ').slice(0, 84) });
      }
      i = Math.max(j, i + 1);
    }
  }
  const joinRuns = bookRuns.filter(r => r.wouldJoin);
  totalRuns += joinRuns.length;
  console.log(`\n### ${file.slice(0, 42)}  —  ${bookRuns.length} inset run(s), ${joinRuns.length} WOULD-JOIN (>=3 shared-right)`);
  for (const r of joinRuns.slice(0, 25)) console.log(`  p${r.pg} n=${r.n} sr=${r.sameRight} x=${r.x}..${r.rx}  ${JSON.stringify(r.text)}`);
  if (joinRuns.length > 25) console.log(`  … +${joinRuns.length - 25} more would-join`);
}
console.log(`\nTOTAL inset-column runs across all PDFs: ${totalRuns}`);
