// Reader-pipeline REGRESSION HARNESS (Phase 1 of the "always fine on 99.99% of files" work).
//
// Runs the reader's headless-runnable structural pipeline — normalizeNotesReaderText → buildPageSentenceData
// → parseInlineFormatting / splitIntoSentences — over the REAL test EPUBs and a set of synthetic behaviour
// fixtures, produces a compact per-chapter DIGEST, and diffs it against a committed golden snapshot. A change
// to any shared reader function that alters a previously-good book is then caught automatically, instead of
// surfacing one file at a time. (Extraction — processPdf/processEpub — is browser-coupled; a matching
// extraction harness is Phase 2. This one guards the layer where most per-file bugs landed this session.)
//
//   node scripts/regression-reader.mjs            # check against goldens (exit 1 on drift)
//   node scripts/regression-reader.mjs --update   # rewrite goldens (after an INTENDED change — review the diff)
//
// Requires the bundle: esbuild tests/regressionReaderEntry.ts -> node_modules/.cache/regressionReaderEntry.mjs
import { buildPageSentenceData, parseInlineFormatting, normalizeNotesReaderText } from '../node_modules/.cache/regressionReaderEntry.mjs';
import { parseHTML } from 'linkedom';
import { execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const GOLD_DIR = path.join(ROOT, 'tests/golden/reader');
const TESTFILES = '/root/testfiles';
const UPDATE = process.argv.includes('--update');

// ── Serialize a spine XHTML file to the reader-input text processEpub produces for its INLINE/BLOCK core
// (verified this session against the live [dbgNotes] dump): <i>/<em>→*…*, <b>/<strong>→**…**, note <a>→
// [label](#frag), block tags→\n\n. (Alignment/heading/indent SENTINELS aren't emitted here — those need the
// full extractor and are Phase 2 — so this harness guards paragraph splitting, note grouping, segment
// formats, sentence boundaries and the watermark filter, not sentinel-driven align/role.)
const serialize = (node) => {
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  const el = node, tag = (el.tagName || '').toLowerCase();
  const kids = Array.from(el.childNodes).map(serialize).join('');
  const t = kids.trim();
  if (tag === 'em' || tag === 'i') return `*${t}*`;
  if (tag === 'strong' || tag === 'b') return `**${t}**`;
  if (tag === 'a') {
    const h = el.getAttribute('href') || ''; const x = h.indexOf('#'); const fr = x >= 0 ? h.slice(x + 1) : '';
    const l = t.replace(/\s+/g, ' ').replace(/^\[+\s*|\s*\]+$/g, '').replace(/\.$/, '');
    if (fr) return `[${l}](#${fr})`;
    if (h) return `[${l}](${h})`;
    return kids;
  }
  if (/^(h[1-6]|p|div|section|li|blockquote)$/.test(tag)) return `\n\n${kids}\n\n`;
  return kids;
};
const chapterText = (xhtmlPath) => {
  const { document } = parseHTML(fs.readFileSync(xhtmlPath, 'utf8'));
  return serialize(document.querySelector('body') || document.documentElement).replace(/\n{3,}/g, '\n\n').trim();
};

// ── Compact, deterministic digest of the paragraph model + a segment-format view.
const digestChapter = (text, { isNotes }) => {
  const input = isNotes ? normalizeNotesReaderText(text, true) : text;
  const { paragraphData } = buildPageSentenceData(input);
  const roleHist = {}, alignHist = {}, segHist = {};
  const bump = (h, k) => { h[k] = (h[k] || 0) + 1; };
  const opts = { internalNoteLinksAsFootnotes: !isNotes, inferBareFootnotes: true, romanMarkersAsReferences: !isNotes, noteEntryMarkersAsReferences: isNotes };
  for (const p of paragraphData) {
    bump(roleHist, p.role || 'body'); bump(alignHist, p.align || 'default');
    for (const s of parseInlineFormatting((p.original || [])[0] || '', opts)) bump(segHist, s.format);
  }
  const sample = paragraphData.slice(0, 12).map(p => ({
    role: p.role || 'body', align: p.align || 'default', indent: p.indent || 0,
    bq: !!p.blockQuote, size: p.sizeEm ?? null,
    segs: parseInlineFormatting((p.original || [])[0] || '', opts).map(s => s.format),
    t: (p.original || []).join(' ').replace(/\s+/g, ' ').slice(0, 34),
  }));
  return { blocks: paragraphData.length, roleHist, alignHist, segHist, sample };
};

// ── Synthetic behaviour fixtures: precise guards for specific fixes (format-agnostic reader behaviour).
const SYNTH = {
  'watermark-filter': { isNotes: false, text:
    'A real body paragraph that mentions research libraries and should survive intact for the reader.\n\n[OceanofPDF.com](https://oceanofpdf.com)\n\nOceanofPDF.com\n\nDownloaded from Z-Library\n\nAnother real paragraph after the injected watermark lines.' },
  'epigraph-attribution': { isNotes: false, text:
    'Nature has placed mankind under the governance of two sovereign masters, pain and pleasure.\n\n—JEREMY BENTHAM, *AN INTRODUCTION TO THE PRINCIPLES OF MORALS AND LEGISLATION*' },
  'phrase-keyed-note': { isNotes: true, text:
    '*[the tree of life](#note26):* Timing emergence of eukaryotes.\n\n[*Figure 1.5*](#note28): Illustration from Reichert, 1990.\n\n*[whom all neurons descend](#note29):* There may be a single exception.' },
};

// ── real EPUB notes chapters (the highest-value regression targets from this session)
const EPUB_TARGETS = [
  { epub: /Brief History of Intelligence/i, file: 'Notes.xhtml', isNotes: true },
  { epub: /Singularity/i, file: '18_Notes.xhtml', isNotes: true },
  { epub: /Brief History of Intelligence/i, file: 'Chapter_2.xhtml', isNotes: false },
];

const digests = {};
for (const [name, f] of Object.entries(SYNTH)) digests[`synth/${name}`] = digestChapter(f.text, f);
for (const t of EPUB_TARGETS) {
  const epub = fs.readdirSync(TESTFILES).find(f => f.endsWith('.epub') && t.epub.test(f));
  if (!epub) { console.log(`  (skip: no EPUB matching ${t.epub})`); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  execSync(`cd "${dir}" && unzip -o -q "${TESTFILES}/${epub}"`);
  const xhtml = execSync(`find "${dir}" -iname '*${t.file}'`).toString().trim().split('\n')[0];
  if (xhtml) digests[`epub/${epub.slice(0, 20).replace(/\W+/g, '_')}/${t.file}`] = digestChapter(chapterText(xhtml), t);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── compare vs golden
fs.mkdirSync(GOLD_DIR, { recursive: true });
let fail = 0, ok = 0;
for (const [key, dig] of Object.entries(digests)) {
  const goldFile = path.join(GOLD_DIR, key.replace(/\//g, '__') + '.json');
  const actual = JSON.stringify(dig, null, 2);
  if (UPDATE) { fs.writeFileSync(goldFile, actual + '\n'); console.log(`  updated ${key}`); continue; }
  if (!fs.existsSync(goldFile)) { console.log(`  ❌ ${key}: NO GOLDEN (run --update)`); fail++; continue; }
  const golden = fs.readFileSync(goldFile, 'utf8').trim();
  if (golden === actual) { console.log(`  ✓ ${key}  (blocks=${dig.blocks})`); ok++; }
  else {
    fail++; console.log(`  ❌ ${key}: DRIFT vs golden`);
    const a = golden.split('\n'), b = actual.split('\n');
    let shown = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 12; i++) if (a[i] !== b[i]) { console.log(`     L${i} golden: ${a[i] ?? ''}`); console.log(`     L${i} actual: ${b[i] ?? ''}`); shown++; }
  }
}
if (UPDATE) { console.log('goldens updated.'); process.exit(0); }
console.log(`\nreader regression: ${ok} ok, ${fail} drift`);
process.exit(fail ? 1 : 0);
