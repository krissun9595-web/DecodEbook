// Stamped on every PDF's FileContext at upload time. When this constant changes, PDFs
// already in a library carry the old stamp; the reader (extractChapterText) detects the
// mismatch and asks the user to re-upload, so they pick up the newer extraction. Bump it
// whenever a change alters the extracted text/structure of a PDF.
// v6: outline-based chapters (built from the PDF's own bookmarks, Y-anchored).
// v7: real link annotations — external hyperlinks, and footnote markers anchored to their
//     destination note entry (shared key) for exact bidirectional navigation.
export const PDF_TEXT_EXTRACTION_VERSION = 'pdf-text-v7-link-annotations';
