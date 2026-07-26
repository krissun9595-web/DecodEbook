import assert from 'node:assert/strict';
import { PDF_TEXT_EXTRACTION_VERSION, EPUB_TEXT_EXTRACTION_VERSION, isStaleExtraction, isStalePdfExtraction } from '../utils/sourceVersion.ts';

// (B) gate, copied verbatim from hydrateLibraryItem in App.tsx: a stale book's text is dropped so
// the book re-extracts (from its stored original) or prompts a re-upload, instead of rendering
// structure this engine version can't read.
const gateContent = <T extends { fileContext: { sourceKind?: string; sourceExtractorVersion?: string; content?: string } }>(item: T): T =>
  isStaleExtraction(item.fileContext.sourceKind, item.fileContext.sourceExtractorVersion)
    ? { ...item, fileContext: { ...item.fileContext, content: undefined } }
    : item;

const book = (sourceKind: string, version: string | undefined, content = 'TEXT') => ({
  fileContext: { sourceKind, sourceExtractorVersion: version, content },
});

// --- isStaleExtraction: the version comparison that drives rollback safety (PDF + EPUB) ---

// The actual rollback that bit us: content extracted by v26, code rolled back to v25.
assert.equal(
  isStaleExtraction('pdf', 'pdf-text-v26-hanging-indent-list'),
  true,
  'PDF content from a NEWER engine (rollback) is stale',
);
// A forward bump (older content, newer code) is equally caught — the check is symmetric.
assert.equal(isStaleExtraction('pdf', 'pdf-text-v19-url-link-membership'), true, 'older PDF content is stale after a forward bump');
// Content from THIS build is fresh.
assert.equal(isStaleExtraction('pdf', PDF_TEXT_EXTRACTION_VERSION), false, 'current-engine PDF content is not stale');
// A legacy PDF with no stamp must re-extract.
assert.equal(isStaleExtraction('pdf', undefined), true, 'unstamped PDF is stale');

// EPUB is now versioned too (native-structure extractor). Same symmetric rule as PDF.
assert.equal(isStaleExtraction('epub', EPUB_TEXT_EXTRACTION_VERSION), false, 'current-engine EPUB content is not stale');
assert.equal(isStaleExtraction('epub', 'epub-text-v0-legacy'), true, 'EPUB content from a different engine is stale');
// A legacy EPUB with no stamp must re-extract (this is the intended behavior CHANGE — pre-versioning
// EPUBs carried no stamp; they now re-extract from the stored original / prompt a one-time re-upload).
assert.equal(isStaleExtraction('epub', undefined), true, 'unstamped legacy EPUB is stale (re-extract)');

// TXT/HTML and unknown kinds carry no extractor and must NEVER be treated as stale (no re-upload churn).
assert.equal(isStaleExtraction('text', undefined), false, 'TXT is never stale');
assert.equal(isStaleExtraction(undefined, undefined), false, 'unknown kind is never stale');

// The historical PDF-only name is a back-compat alias of the generalized check.
assert.equal(isStalePdfExtraction, isStaleExtraction, 'isStalePdfExtraction aliases isStaleExtraction');

// --- the gate's outcome: stale content is dropped, fresh content is kept ---

// Simulate the exact failure: a library item whose content was produced by v26, opened on v25.
const rolledBack = gateContent(book('pdf', 'pdf-text-v26-hanging-indent-list', 'BROKEN v26 STRUCTURE'));
assert.equal(rolledBack.fileContext.content, undefined, 'rolled-back v26 content is dropped -> re-extract, not broken render');

// Fresh content (re-uploaded under the current engine) renders normally.
const fresh = gateContent(book('pdf', PDF_TEXT_EXTRACTION_VERSION, 'GOOD TEXT'));
assert.equal(fresh.fileContext.content, 'GOOD TEXT', 'current-engine PDF content is preserved');

// An unstamped legacy EPUB's content is dropped (pending auto re-extraction from its stored original).
const legacyEpub = gateContent(book('epub', undefined, 'LEGACY EPUB TEXT'));
assert.equal(legacyEpub.fileContext.content, undefined, 'unstamped EPUB content is dropped -> re-extract');

// A current-engine EPUB renders normally.
const freshEpub = gateContent(book('epub', EPUB_TEXT_EXTRACTION_VERSION, 'FRESH EPUB TEXT'));
assert.equal(freshEpub.fileContext.content, 'FRESH EPUB TEXT', 'current-engine EPUB content is preserved');

console.log('rollback / version-gate regression tests passed');
