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
// v24: fix a URL that wrapped into SEPARATE blocks rendering its tail twice (the full URL, then
//      a leftover "Index-Report.pdf"). The v23 collapse only bridged spaces, so cross-block
//      fragments weren't merged, and the v23 single-span clean then expanded the first fragment
//      to the full URL while the second stayed. Now the collapse bridges a block/page break
//      (whitespace + optional [[PAGE n]] marker), and the single-span clean fires only on a
//      label that is the WHOLE URL (spurious internal spaces), never a fragment.
// v25: a URL whose scheme sits MID-item is recognised. pdf.js can return the citation and the
//      URL as one text item ("Equipment Corporation, 1963), 10, http://s3data…"), which the
//      loose link box links whole; the reconstruction anchored only on a scheme at a glyph's
//      START, so it latched onto the URL's continuation line and dropped the scheme line as
//      "citation". Now a linked glyph is split at a mid-item scheme so the URL is anchored and
//      its leading citation dropped.
// (v26 = a hanging-indent definition-list detector; reverted — it misfired book-wide. See git.)
// v27: a small-font number is NOT taken as a flattened footnote marker when the glyph right
//      before it ends in a DIGIT — that's a math exponent ("10" + raised "20" = 10^20), not a
//      reference. A real marker follows a word or sentence punctuation. (The matching reader-side
//      guard — never inferring a marker from a digit inside a URL, e.g. "…59763136bdd7" — needs
//      no re-extraction.)
// v28: an index page's intro prose is reflowed even when it shares the body margin with the
//      entries. The intro/entry boundary now requires the first entry to END IN A PAGE
//      REFERENCE (the intro never does); an x-only test treated the intro as entry one and chopped
//      its wrapped sentence ("…reference on" / "your e-reader.") into separate lines.
// v29: a glyph whose font maps it to a Private-Use codepoint (a broken/missing ToUnicode map —
//      a character pdf.js can't recover) is replaced with a visible "□" placeholder instead of
//      being silently dropped, so a fetch omission is never invisible. Excludes U+E010–E014 (our
//      own block-role sentinels). For this book it affects exactly one glyph (a decorative promo
//      font's "h"); the 657 content pages have zero unmapped glyphs.
// v30: a LABELED hanging-indent list (a dialogue "CASSANDRA:/RAY:", a CIP block "Names:/Title:",
//      a glossary) is split into one paragraph per entry instead of reflowing into a run-on. The
//      splitter only broke on an INDENTED line, but these entries start at the margin. Detected
//      from geometry (≥3 margin entries + continuations on one consistent deeper tier, each
//      continuing a non-terminal line) AND a discriminator prose lacks — most entries begin with
//      a short "Label:". Emits plain body paragraphs (no hanging-indent visual). Replaces v26's
//      bare two-tier detector, which over-fired book-wide; verified to fire only on the CIP and
//      the Ch 8 dialogue across all 658 pages (the contents is handled separately).
// v31: headings are detected by FONT FAMILY, not size — the principled signal pdf.js actually
//      provides (the real font name via commonObjs). A heading is text set in the typesetter's
//      heading family (a display family distinct from the body family), LEARNED from the contents
//      page (the document's own list of headings); the body family is the document's dominant one.
//      This recognises a notes-section chapter header ("CHAPTER 7: PERIL") that equals body SIZE but
//      uses the heading family, AND correctly excludes epigraphs/quotes/attributions/italic titles/
//      figure captions (all non-heading families) — which a size rule could not (the header is
//      body-size; an epigraph is smaller than body). pdf.js exposes no semantic structure here
//      (getStructTree/getMarkInfo null; marked content is generic "Span"), so font family is the
//      most-principled available signal. The 'heading' block role now travels to the reader as
//      U+E013 (as 'list' carries U+E012); the reader renders by it (bold, no indent). Falls back to
//      the old size rule when there is no contents page / no distinct heading family. Replaces the
//      reverted size-based v31 (which mis-bolded epigraph attributions — see git c5236b3 / 30a2765).
// v32: heading detection combines BOTH principled signals — a heading is in the heading font FAMILY
//      (distinct display family, learned from the contents page) AND typographically LARGER than the
//      body of its OWN section (a per-line LOCAL body font, windowed across pages and max'd with the
//      page's own font). Family alone over-caught body content set in the display family (the Ch 8
//      dialogue, the "late-breaking news" callout — both at body size); local size alone over-caught
//      body prose on figure/footnote-heavy pages (wrong family). Together they cancel: the size-15
//      notes header (large vs the h11 notes) and the big titles pass; the size-15 callout/dialogue
//      (not large vs the h15 body) do not. Replaces v31's family-only rule + its !fills/!lowercase
//      hacks. Verified book-wide: 0 callout/dialogue/sentence-like false positives.
// v33: the Ch 8 dialogue is segmented into one paragraph per turn again. The labeled-hanging-list
//      detector's label test ran on the raw line text, but a speaker label is set BOLD, so the line
//      is "**CASSANDRA: **So you anticipate…" — the leading "**" tripped the label regex's first-char
//      anchor, so 0 turns matched and the dialogue emitted as one block. Strip emphasis markup before
//      the label test (pdf.js DOES give the space after the colon — verified). (Companion reader-side
//      fix, no re-extraction: consecutive chapter-end NOTES are separated by a blank line so adjacent
//      notes like 80/81 no longer render as one merged block.)
// v34: the labeled hanging-list (dialogue/CIP) detector is anchored on the GROUP's own leftmost x,
//      not the page's most-frequent left (bodyLeft) — which for a hanging-indent block lands on the
//      CONTINUATION tier (the wrapped lines outnumber the entry openers), so every line read as
//      "margin" and detection failed page-wide. Plus two continuation cases that were wrongly bailing
//      detection: a leading indented line with NO prev (a turn that wrapped across the previous PAGE
//      break) and an indented line whose prev is another INDENTED line that ended a sentence mid-entry
//      (a long turn whose wrap fell on a period) are both still continuations — the terminal-punct
//      guard now fires only when the line above is a MARGIN line that ended (a true first-line indent).
//      The label requirement is KEPT (pure geometry over-fires on first-line-indent prose — the v26
//      regression). Verified: all Ch 8 dialogue pages (p371–376) segment per-turn; a body-wide sweep
//      fires only on the dialogue (prose/callout/index excluded).
// v35: a SHORT labeled entry opener (a one-word dialogue turn "RAY: Right.", a CIP field) no longer
//      triggers the block-split's bothShort "line-structured data" break. A one-word turn sitting
//      beside a short wrapped continuation tripped bothShort, fragmenting the dialogue into 3-line
//      blocks that fell below detectLabeledHangingList's ≥4-line/≥3-entry thresholds, so that run
//      merged into one paragraph (most turns split, the one-word ones huddled). Excluding labeled
//      openers keeps each dialogue page ONE block, detected at the original safe thresholds.
//      Verified: p371-376 each segment per turn (incl. the one-word turns); body-wide sweep fires
//      only on the dialogue.
export const PDF_TEXT_EXTRACTION_VERSION = 'pdf-text-v35-short-labeled-opener';

// A PDF's stored text is stale when it was produced by a different extraction engine than this
// build — a NEWER one, or one we rolled back FROM. A code rollback never rewrites already-stored
// text, and the source cache key is shared across engine versions, so without this check a
// rollback keeps serving (and rendering) text whose block structure / sentinels this build can't
// interpret. EPUB/TXT carry no extractor version and are never stale by this rule.
export const isStalePdfExtraction = (
  sourceKind: string | undefined,
  sourceExtractorVersion: string | undefined,
): boolean => sourceKind === 'pdf' && sourceExtractorVersion !== PDF_TEXT_EXTRACTION_VERSION;
