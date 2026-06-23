// Stamped on every PDF's FileContext at upload time. When this constant changes, PDFs
// already in a library carry the old stamp; the reader (extractChapterText) detects the
// mismatch and asks the user to re-upload, so they pick up the newer extraction. Bump it
// whenever a change alters the extracted text/structure of a PDF.
// v6 adds outline-based chapters (built from the PDF's own bookmarks, Y-anchored), and
// also covers this cycle's structural footnote markers and index sub-entry indentation.
export const PDF_TEXT_EXTRACTION_VERSION = 'pdf-text-v6-outline-chapters';
