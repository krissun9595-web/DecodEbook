// Headless pdfjs harness for the PDF list-marker re-anchor (App.tsx ~4699).
// Replicates: glyph extraction → clusterLines → marker-block grouping (firstX/bodyX) → the re-anchor
// RUN grouping + guard, so a change to the run grouping/guard can be diffed old-vs-new across all test
// PDFs BEFORE shipping. Focus: does the contiguous marker run mix an OUTER list with its INNER sub-list?
//
// Usage: node scripts/pdf-list-reanchor-audit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// The lists we care about, keyed by a unique opening phrase → which PDF + a label.
const TARGETS = [
  { pdf: 'Sovereign', find: 'An intense and even violent', label: 'Sovereign item 5 (a-d sub-list)' },
  { pdf: 'Sovereign', find: 'The nationalist-Luddite reaction will not', label: 'Sovereign item 7 (a-d + 8/9/10)' },
  { pdf: 'Singularity', find: 'typical MYCIN', label: 'MYCIN IF/1-7' },
];
const PDF_FILES = fs.readdirSync('/root/testfiles').filter(f => f.endsWith('.pdf'));
const pdfPath = (key) => path.join('/root/testfiles', PDF_FILES.find(f => f.toLowerCase().includes(key.toLowerCase())));

const openRe = /^(?:IF:|THEN:|\d{1,2}[.)]|(?:[a-z]|[ivxlcdm]{2,7})[.)])(?:\s|$)/u;

// The re-anchor guard, and the CURRENT (whole-run) vs FIX (firstX-tier split) comparison.
function guardFires(run, bodyFont, docBodyLeft) {
  const lefts = run.map(b => b.firstX);
  const spread = Math.max(...lefts) - Math.min(...lefts);
  const tab = Math.max(...run.map(b => b.bodyX ?? b.firstX));
  const romanRun = run.some(b => /^[ivxlcdm]{2,7}[.)]/u.test(b.marker));
  return { fires: (spread > bodyFont * 0.3 || romanRun) && bodyFont > 0 && tab > docBodyLeft + bodyFont * 0.9, spread, tab, romanRun };
}
function firstXTiers(blocks, bodyFont) {
  const tierList = [];
  for (const b of [...blocks].sort((a, c) => a.firstX - c.firstX)) {
    const cur = tierList[tierList.length - 1];
    if (cur && b.firstX - cur[cur.length - 1].firstX <= bodyFont * 1.5) cur.push(b);
    else tierList.push([b]);
  }
  return tierList;
}
function analyze(blocks, bodyFont, docBodyLeft) {
  if (!blocks.length) { console.log('   (no marker blocks)'); return; }
  const cur = guardFires(blocks, bodyFont, docBodyLeft);
  console.log(`   CURRENT (whole run): spread=${cur.spread} tab=${cur.tab} roman=${cur.romanRun} → FIRES=${cur.fires}${cur.fires ? '  ← re-anchors EVERY item to tab' : ''}`);
  const tiers = firstXTiers(blocks, bodyFont);
  console.log(`   FIX (split by firstX → ${tiers.length} tier(s)):`);
  for (const sub of tiers) {
    const g = guardFires(sub, bodyFont, docBodyLeft);
    console.log(`      tier firstX≈${mode(sub.map(b => b.firstX))} markers=[${sub.map(b => b.marker).join(' ')}]  spread=${g.spread} roman=${g.romanRun} → FIRES=${g.fires}`);
  }
}
const mode = (xs) => { const m = {}; let best = xs[0], bc = 0; for (const x of xs) { m[x] = (m[x] || 0) + 1; if (m[x] > bc) { bc = m[x]; best = x; } } return best; };

// clusterLines port (App.tsx 2976): group glyphs into lines by baseline y within tol.
function clusterLines(gs, tol) {
  const out = [];
  for (const g of [...gs].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let best = null, bestDist = Infinity;
    for (const grp of out) { const d = Math.abs(grp.baseY - g.y); if (d <= tol && d < bestDist) { bestDist = d; best = grp; } }
    if (!best) { best = { baseY: g.y, baseH: g.h, items: [] }; out.push(best); }
    best.items.push(g);
    if (g.h > best.baseH * 1.05) { best.baseY = g.y; best.baseH = g.h; }
  }
  return out;
}

async function pageLines(page) {
  const tc = await page.getTextContent();
  const glyphs = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    glyphs.push({ x, y, w: it.width, h: it.height || Math.abs(it.transform[3]) || 10, str: it.str });
  }
  if (!glyphs.length) return [];
  const bodyH = mode(glyphs.map(g => Math.round(g.h)));
  const lines = clusterLines(glyphs, Math.max(2, bodyH * 0.5)).map(grp => {
    const items = grp.items.sort((a, b) => a.x - b.x);
    return { x: Math.round(Math.min(...items.map(i => i.x))), rightX: Math.round(Math.max(...items.map(i => i.x + i.w))),
             y: grp.baseY, h: grp.baseH, text: items.map(i => i.str).join('').replace(/\s+/g, ' ').trim() };
  }).sort((a, b) => b.y - a.y);
  return { lines, bodyH };
}

// Simplified marker-block grouping: a marker line opens a block; following NON-marker lines that sit
// DEEPER than the page body margin join as continuation (giving bodyX). firstX = marker line x.
function markerBlocks(lines, bodyLeft) {
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const ln = lines[i];
    if (!openRe.test(ln.text.replace(/^[*_~]+/u, ''))) { i++; continue; }
    const cont = [];
    let j = i + 1;
    while (j < lines.length && !openRe.test(lines[j].text.replace(/^[*_~]+/u, '')) && lines[j].x > bodyLeft - 4) { cont.push(lines[j]); j++; }
    const marker = (ln.text.match(openRe)?.[0] || '').trim();
    blocks.push({ firstX: ln.x, bodyX: cont.length ? mode(cont.map(l => l.x)) : ln.x, marker, text: ln.text.slice(0, 46) });
    i = j;
  }
  return blocks;
}

// Locate a genuine RIGHT-TABBED roman sub-list in a PDF (≥2 lines whose marker is multi-char roman
// ii./iii./iv.) so we can confirm the fix keeps re-anchoring it.
async function findRomanList(key) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath(key))), useSystemFonts: true }).promise;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const res = await pageLines(page);
    if (!res || !res.lines) continue;
    const romans = res.lines.filter(l => /^[ivxlcdm]{2,7}[.)]/u.test(l.text));
    if (romans.length >= 2) return { key, p, ...res };
  }
  return null;
}

for (const t of TARGETS) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath(t.pdf))), useSystemFonts: true }).promise;
  // find the page holding the target phrase
  let found = null;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { lines, bodyH } = await pageLines(page);
    if (!lines) continue;
    if (lines.some(l => l.text.includes(t.find))) { found = { p, lines, bodyH }; break; }
  }
  if (!found) { console.log(`\n### ${t.label}: NOT FOUND`); continue; }
  const { lines, bodyH } = found;
  const bodyLeft = mode(lines.filter(l => l.text.length > 30).map(l => l.x));
  const docBodyLeft = bodyLeft, bodyFont = bodyH;
  const blocks = markerBlocks(lines, bodyLeft);
  console.log(`\n### ${t.label}  [page ${found.p}, bodyLeft=${bodyLeft} bodyFont=${bodyFont}]`);
  for (const b of blocks) console.log(`   mk="${b.marker}" firstX=${b.firstX} bodyX=${b.bodyX}  ${b.text}`);

  analyze(blocks, bodyFont, docBodyLeft);
}

// Roman right-tabbed sub-list (regression guard for the fix — must STILL fire under the tier split).
for (const key of ['Singularity', 'Sovereign', 'Agentic']) {
  const r = await findRomanList(key);
  if (!r) { console.log(`\n### roman sub-list in ${key}: none`); continue; }
  const bodyLeft = mode(r.lines.filter(l => l.text.length > 30).map(l => l.x));
  const blocks = markerBlocks(r.lines, bodyLeft).filter(b => /^[ivxlcdm]{2,7}[.)]|^[ivx]\./iu.test(b.marker) || /^[ivxlcdm]/i.test(b.marker));
  console.log(`\n### roman sub-list in ${key} [page ${r.p}, bodyLeft=${bodyLeft} bodyFont=${r.bodyH}]`);
  const rb = markerBlocks(r.lines, bodyLeft);
  for (const b of rb) console.log(`   mk="${b.marker}" firstX=${b.firstX} bodyX=${b.bodyX}  ${b.text}`);
  analyze(rb, r.bodyH, bodyLeft);
}
