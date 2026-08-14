// Re-exports the PURE chapter-building pipeline for the Phase-2 chapter-boundary regression harness
// (scripts/regression-chapters.mjs). These functions turn extracted content + a PDF/EPUB outline (or the
// LLM's chapter list) into the ordered chapters with source offsets — the exact code the coming
// "route PDF structure through the LLM" change will touch, so a golden over their boundaries lets that
// change be proven to fix the target book AND leave the working books byte-identical.
export {
  buildChaptersFromOutline,
  buildSourceIndexedChapters,
  findHeadingOffsetByTitle,
  isUsablePdfOutline,
  splitDetectedBackMatter,
} from '../utils/sourceIndex';
