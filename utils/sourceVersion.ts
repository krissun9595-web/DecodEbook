// Stamped on every PDF's FileContext at upload time. When this constant changes, PDFs
// already in a library carry the old stamp; the reader (extractChapterText) detects the
// mismatch and asks the user to re-upload, so they pick up the newer extraction. Bump it
// whenever a change alters the extracted text/structure of a PDF.
// v6: outline-based chapters (built from the PDF's own bookmarks, Y-anchored).
// v7: real link annotations — external hyperlinks, and footnote markers anchored to their
//     destination note entry (shared key) for exact bidirectional navigation.
// v8: geometry-driven block structure — lines are classified as heading/body against the
//     document body font, grouped into blocks, and soft-wrapped lines joined, so structure
//     comes from the page layout instead of being re-guessed from flattened text.
// v9: drop inline emphasis markers from heading blocks (a bold-only glyph among bold-italic
//     words otherwise left a stray "**" that showed literally and broke notes-section
//     detection).
// v10: geometry-driven cross-page join — a paragraph that fills the right margin at the
//      bottom of a page and continues at the top of the next is rejoined from the layout
//      (line fills the measure + no terminal punctuation), instead of being guessed from
//      text downstream.
// v11: per-character link resolution — a link annotation that covers only part of a
//      whole-line text item (a URL inside a sentence) now links just those characters,
//      not the whole line.
// v12: index pages reflow their header/intro prose (the lines before the first entry)
//      instead of listing it one fragment per line; the entries stay an indented list.
// v13: Roman-numeral chapter-end footnotes — body markers (I, II, …) are recognised
//      (canonical-strict validated) and emitted, the note anchors are injected for Roman as
//      well as numeric markers, and each footnote entry starts its own block.
// v14: outline chapters whose page range has no extractable text (an image-only title page
//      or cover) are dropped instead of becoming a chapter that errors on open.
// v15: line-structured data (a catalog/CIP block, address, code list) is kept one entry per
//      line — two consecutive lines that each fill less than half the measure don't reflow
//      into a run-on paragraph (the layout-aware "line is too short to be a paragraph line"
//      rule), instead of being joined as prose.
// v16: a drop cap (oversized initial, h ≥ 2.2× body so a chapter-title cap letter is never
//      mistaken for one; a trailing apostrophe allowed) attaches to the line it opens
//      ("I'd like…", "In my 2005…") instead of clustering by baseline with the wrong line;
//      a table of contents without page numbers lists one entry per line; a value-0 "marker"
//      (a code-string subscript) is never a footnote; a right-aligned or centred display
//      block (a title page / "also by" list / dedication — lines that share a right edge or
//      centre while their left edges vary) keeps one item per line and its alignment (a
//      private-use sentinel the reader strips), instead of reflowing into a paragraph.
// v17: internal-link markup is normalised in processPdf BEFORE the outline offsets are
//      computed, so the chapter offsets match the stored (sanitised) content. Previously
//      sanitizeInternalLinkMarkup ran later (hydrateFileContext / the source cache), trimmed
//      whitespace inside link brackets, shifted every following character, and each chapter
//      began a few characters into its heading ("ACKNOWLEDGMENTS" → "NOWLEDGMENTS").
// v18: the geometry-decided block role travels to the reader as a private-use sentinel
//      (U+E012 = list), captured into para.role and stripped at display, so the reader
//      renders a tagged block by its role instead of re-deriving structure from the
//      flattened text — a table of contents now renders uniformly rather than letting the
//      prose subtitle heuristic bold some entries. (Finishes the held "reader renders tagged
//      blocks" stage, scoped to the list role.)
// v19: a URL link keeps its annotation only on text genuinely part of the URL (a scheme/www
//      fragment or a long contiguous slice), so pdf.js's loose bounding box no longer links
//      the citation that precedes the URL on the same wrapped line ("CNBC, June 29, 2023,").
//      Custom-text links (no scheme shown) are left untouched.
// v20: font weight/style is detected from abbreviated subset-font names too ("…-BdCn" = Bold
//      Condensed, "-It" = Italic), not just the full words — so bold/italic that these fonts
//      hid is recovered book-wide. A table of contents keeps its own emphasis (the bold
//      chapter title) and its x-indent tiers (front matter indented, chapters flush), matching
//      the original instead of a flat uniform list.
// v21: a URL link is reconstructed by spelling the URL across its glyphs — the link is kept on
//      exactly the contiguous run that spells the URL (from its scheme), splitting a glyph
//      where a short URL tail is glued to the next citation ("…will-" + "win" + "; Vincent…").
//      Fixes both the citation being linked and the URL tail being dropped.
// v22: a URL is kept as ONE continuous link, not broken by a space. (Not a length limit.)
//      Two ways a URL could gain an internal space: (a) it WRAPS across a line, so it becomes
//      two link spans the soft-wrap join split with a space (the trailing hyphen is hidden
//      behind the "](url)" markup) — adjacent spans pointing to the same URL are merged with
//      no space; (b) a JUSTIFIED line stretches the gap between a URL's pieces past the
//      glue threshold — consecutive glyphs of the same displayed URL are glued.
// v23: a link DISPLAYED as its URL is rendered from the annotation's exact URL (the string
//      pdf.js reports), not rebuilt from the glyph run — which is where internal spaces, a
//      dropped leading "https" character, and truncation came from. Adjacent spans of the same
//      URL (a URL split across a line OR a page break) collapse into one clean link. The URL's
//      glyphs are still located against the URL string so a continuation PAGE (whose glyphs
//      don't re-state the scheme) is recognised and the citation after it ("…sense-engine;
//      \"Frequently Asked\"…") is no longer swept into the link. Replaces the v22 merge/glue.
export const PDF_TEXT_EXTRACTION_VERSION = 'pdf-text-v23-url-from-annotation';
