// Re-exports the reader's headless-runnable STRUCTURAL pipeline for the regression harness
// (scripts/regression-reader.mjs). These four functions take extracted chapter text and produce the
// paragraph/segment model the UI renders — where most per-file bugs live — so a change to any of them
// is diffed against a golden snapshot across every real test EPUB BEFORE it ships.
export { buildPageSentenceData, parseInlineFormatting } from '../components/AudioBook';
export { normalizeNotesReaderText } from '../utils/readerStructure';
export { splitIntoSentences } from '../utils/sentenceSplit';
