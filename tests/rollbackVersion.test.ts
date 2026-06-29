import assert from 'node:assert/strict';
import { PDF_TEXT_EXTRACTION_VERSION, isStalePdfExtraction } from '../utils/sourceVersion.ts';

// (B) gate, copied verbatim from hydrateLibraryItem in App.tsx: a stale PDF's text is dropped so
// the book prompts a re-upload instead of rendering structure this engine version can't read.
const gateContent = <T extends { fileContext: { sourceKind?: string; sourceExtractorVersion?: string; content?: string } }>(item: T): T =>
  isStalePdfExtraction(item.fileContext.sourceKind, item.fileContext.sourceExtractorVersion)
    ? { ...item, fileContext: { ...item.fileContext, content: undefined } }
    : item;

const pdf = (version: string | undefined, content = 'TEXT') => ({
  fileContext: { sourceKind: 'pdf', sourceExtractorVersion: version, content },
});

// --- isStalePdfExtraction: the version comparison that drives rollback safety ---

// The actual rollback that bit us: content extracted by v26, code rolled back to v25.
assert.equal(
  isStalePdfExtraction('pdf', 'pdf-text-v26-hanging-indent-list'),
  true,
  'content from a NEWER engine (rollback) is stale',
);
// A forward bump (older content, newer code) is equally caught — the check is symmetric.
assert.equal(isStalePdfExtraction('pdf', 'pdf-text-v19-url-link-membership'), true, 'older content is stale after a forward bump');
// Content from THIS build is fresh.
assert.equal(isStalePdfExtraction('pdf', PDF_TEXT_EXTRACTION_VERSION), false, 'current-engine content is not stale');
// A legacy PDF with no stamp must re-extract.
assert.equal(isStalePdfExtraction('pdf', undefined), true, 'unstamped PDF is stale');
// EPUB/TXT never carry an extractor version and must NEVER be treated as stale (no re-upload churn).
assert.equal(isStalePdfExtraction('epub', undefined), false, 'EPUB is never stale');
assert.equal(isStalePdfExtraction('text', undefined), false, 'TXT is never stale');
assert.equal(isStalePdfExtraction(undefined, undefined), false, 'unknown kind is never stale');

// --- the gate's outcome: stale content is dropped, fresh content is kept ---

// Simulate the exact failure: a library item whose content was produced by v26, opened on v25.
const rolledBack = gateContent(pdf('pdf-text-v26-hanging-indent-list', 'BROKEN v26 STRUCTURE'));
assert.equal(rolledBack.fileContext.content, undefined, 'rolled-back v26 content is dropped -> re-upload prompt, not broken render');

// Fresh content (re-uploaded under v25) renders normally.
const fresh = gateContent(pdf(PDF_TEXT_EXTRACTION_VERSION, 'GOOD v25 TEXT'));
assert.equal(fresh.fileContext.content, 'GOOD v25 TEXT', 'current-engine content is preserved');

// EPUB content is untouched by the PDF gate.
const epub = gateContent({ fileContext: { sourceKind: 'epub', sourceExtractorVersion: undefined, content: 'EPUB TEXT' } });
assert.equal(epub.fileContext.content, 'EPUB TEXT', 'EPUB content is preserved');

console.log('rollback / version-gate regression tests passed');
