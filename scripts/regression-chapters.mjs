// Chapter-boundary REGRESSION HARNESS (Phase 2 — guards the structure/chapter layer the coming
// "route PDF structure through the LLM" change will touch).
//
// The extraction (processPdf/processEpub) is component-scoped + browser-coupled, so this doesn't run it.
// Instead it golden-snapshots the PURE chapter-building pipeline — buildChaptersFromOutline (outline path)
// and buildSourceIndexedChapters (LLM path) from sourceIndex.ts — which is where chapter offsets/boundaries
// are actually decided. Two fixture sources:
//   • SYNTH below — hand-built content + outline/LLM-chapters exercising the boundary logic (immediate guard).
//   • tests/fixtures/chapters/*.json — REAL captured fixtures {mode, content, outline?, llmChapters?} dumped
//     from the app (localStorage.dbgCaptureChapters='1' → console '[dbgCaptureChapters]' JSON). Drop them in,
//     run --update once, commit the golden — then the PDF-LLM change can be proven non-regressive per book.
//
//   node scripts/regression-chapters.mjs            # check (exit 1 on drift)
//   node scripts/regression-chapters.mjs --update   # rewrite goldens (after an INTENDED change)
import { buildChaptersFromOutline, buildSourceIndexedChapters } from '../node_modules/.cache/regressionChaptersEntry.mjs';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const GOLD_DIR = path.join(ROOT, 'tests/golden/chapters');
const FIX_DIR = path.join(ROOT, 'tests/fixtures/chapters');
const UPDATE = process.argv.includes('--update');

// ── synthetic fixtures (readable; each exercises a boundary path) ─────────────────────────────────────────
const SYNTH = {
  // PDF outline via page markers: front-matter image page + Introduction + a number-line chapter opener.
  // Guards buildChaptersFromOutline's page→offset resolution and the boundary between Introduction and Ch.1
  // (the "chapter title stuck at the end of the previous chapter" class).
  'pdf-outline': {
    mode: 'outline',
    content: '[[PAGE 1]]Cover art.\n\n[[PAGE 2]]Introduction\n\nThe introduction runs on for a while with enough body text to survive the empty-range filter and be a real chapter.\n\n[[PAGE 5]]1\n\nThe World Before Brains\n\nThe first chapter opens here with plenty of body text so it is a real chapter of its own.',
    outline: [
      { title: 'Introduction', page: 2, level: 0 },
      { title: 'The World Before Brains', page: 5, level: 0 },
    ],
  },
  // LLM path: chapters carry sourceHeading; buildSourceIndexedChapters title-anchors them into the content.
  'llm-sourceindexed': {
    mode: 'llm',
    content: 'Some front matter here that is not a chapter.\n\nIntroduction\n\nIntroduction body text goes on long enough to be its own readable chapter here.\n\nThe World Before Brains\n\nChapter one body text also goes on long enough to be a real chapter of its own here.',
    llmChapters: [
      { id: 1, title: 'Introduction', sourceHeading: 'Introduction' },
      { id: 2, title: 'The World Before Brains', sourceHeading: 'The World Before Brains' },
    ],
  },
};

// ── load captured real fixtures
const loaded = { ...SYNTH };
if (fs.existsSync(FIX_DIR)) for (const f of fs.readdirSync(FIX_DIR).filter(f => f.endsWith('.json'))) {
  try { loaded['real/' + f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(FIX_DIR, f), 'utf8')); }
  catch (e) { console.log(`  (bad fixture ${f}: ${e.message})`); }
}

const digest = (fx) => {
  const chapters = fx.mode === 'outline'
    ? buildChaptersFromOutline(fx.content, fx.outline || [])
    : buildSourceIndexedChapters(fx.content, fx.llmChapters || []);
  return chapters.map(c => ({
    id: c.id, title: c.title,
    start: c.sourceStart ?? null, end: c.sourceEnd ?? null,
    semanticType: c.semanticType ?? null,
    head: (fx.content.slice(c.sourceStart ?? 0, (c.sourceStart ?? 0) + 40)).replace(/\s+/g, ' '),
  }));
};

fs.mkdirSync(GOLD_DIR, { recursive: true });
let ok = 0, fail = 0;
for (const [key, fx] of Object.entries(loaded)) {
  let dig; try { dig = digest(fx); } catch (e) { console.log(`  ❌ ${key}: threw ${e.message}`); fail++; continue; }
  const goldFile = path.join(GOLD_DIR, key.replace(/\//g, '__') + '.json');
  const actual = JSON.stringify(dig, null, 2);
  if (UPDATE) { fs.writeFileSync(goldFile, actual + '\n'); console.log(`  updated ${key} (${dig.length} chapters)`); continue; }
  if (!fs.existsSync(goldFile)) { console.log(`  ❌ ${key}: NO GOLDEN (run --update)`); fail++; continue; }
  if (fs.readFileSync(goldFile, 'utf8').trim() === actual) { console.log(`  ✓ ${key}  (${dig.length} chapters)`); ok++; }
  else {
    fail++; console.log(`  ❌ ${key}: DRIFT`);
    const a = fs.readFileSync(goldFile, 'utf8').trim().split('\n'), b = actual.split('\n'); let s = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && s < 10; i++) if (a[i] !== b[i]) { console.log(`     golden: ${a[i] ?? ''}`); console.log(`     actual: ${b[i] ?? ''}`); s++; }
  }
}
if (UPDATE) { console.log('goldens updated.'); process.exit(0); }
console.log(`\nchapter regression: ${ok} ok, ${fail} drift`);
process.exit(fail ? 1 : 0);
