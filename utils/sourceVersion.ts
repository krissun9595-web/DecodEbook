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
// v36: chapter-offset resolver picks the HIGHEST-scoring heading candidate, not the first one
//      above threshold. A distant title match ("Index" inside "The AI Index 2022" in an endnote,
//      ~170 pages before the real Index) was winning over the correct page anchor purely by array
//      order — so the "Index" chapter started mid-Notes and SWALLOWED ~170 pages of endnotes,
//      leaving the Notes chapter with only ch1 notes 1-7. That broke footnote navigation book-wide
//      (most notes unreachable -> SOURCE_REQUIRED; some resolved to the wrong chapter's same-numbered
//      note). Now the page anchor (weighted by proximity) wins, so the Notes chapter spans its full
//      range and note keys resolve. Verified: all 4 regression suites pass.
// v37: a dialogue turn (or CIP field) that WRAPS ACROSS A PAGE BREAK is rejoined. The hanging-list
//      re-splitter, run per page, emits the continuation lines at the top of the next page (they open
//      at the indented tier, before any speaker opener) as their own paragraph — orphaned from the
//      opener on the previous page. Such a leading indented entry is now flagged `carryover`, and the
//      cross-page seam join reunites it with the previous page's last block even though a turn can
//      break at a sentence boundary (the prev tail ends in terminal punctuation, which the normal
//      join rule forbids). Fixes the Ch 8 seam ("…until the 2040s." / "That would dramatically…").
// v38: a URL that WRAPS ACROSS A PAGE BREAK into a list-tagged block renders as ONE clean link.
//      Two coupled gaps on the appendix chart-sources page (p380→p381): (a) the continuation line
//      arrives as ONE text item with a trailing citation glued on ("…data.pdf; Lawrence H. Officer,")
//      and the whole item is inside the loose link box, but the URL-keep anchor required the WHOLE
//      glyph to be a URL substring, so it bailed and left the citation linked — now it anchors on the
//      longest ≥12-char PREFIX the URL contains and the per-glyph walk splits the citation off as
//      plain text; (b) that continuation block is tagged as a list item, so a U+E012 sentinel sits
//      between the "[[PAGE n]]" marker and the span, which blocked the same-URL span collapse — the
//      collapse now tolerates and preserves a leading block sentinel. Result: one clean
//      [url](url), the "; Lawrence H. Officer," citation kept, page marker + list role preserved.
//      Verified on the real p380/381 data + regressions (single-line, one-line wrap, different-URL
//      non-merge, trailing-prose single span).
// v39: a URL containing PARENTHESES (a cell.com PII link "…/S0960-9822(06)02290-1.pdf") renders as
//      ONE clean link. Markdown "[label](href)" — and every "[^)]+" href parser here (the span
//      collapse, the reader's inline renderer) — closes the href at the first ")", so a bare paren
//      truncated the link and spilled the tail as literal text (the "…(06)02290-" linked, then a
//      duplicated "02290-1.pdf) 1.pdf …" mess). Fix: percent-encode "(" / ")" in the HREF position
//      only (browsers decode %28/%29, so clicks resolve), while the visible LABEL keeps literal
//      parens; the span-collapse/clean emit a decoded label + encoded href, and sameUrl compares the
//      decoded forms. No-op for paren-free URLs (zero regression). Verified on the real p404/p430
//      cell.com links + regressions (non-paren wrap still collapses, plain single URL still cleans).
// v40: two more URL-reconstruction cases. (a) A URL whose annotation PERCENT-ENCODES a character the
//      page shows literally (a YouTube link "…W3ceg%E2%80%94uQKM" whose glyph is a literal em-dash
//      "—") no longer truncates + duplicates its tail: the reconstruction now matches glyphs against
//      the DECODED URL and the label is shown decoded ("…W3ceg—uQKM"), while the href keeps the
//      escaped form so the click still resolves. (b) A mailto:/tel: link whose loose box also caught
//      the preceding label ("E-mail: TSG@…", so the run began "l: TSG@TSGINC.com") no longer keeps
//      the label in the link: schemeSplit now splits at the address for mailto/tel too, so urlKeep
//      anchors on the address and drops the "l: " prefix back to plain text. Verified via the ported
//      pipeline on all cases: single, wrap, parens (p404), mid-item scheme, em-dash (p443 YouTube),
//      mailto (Sovereign Individual p527) — plus no regression on the earlier ones.
// v41: a single right-aligned epigraph/quote CREDIT ("—NORMAN COHN", "—EMERSON, The Conduct of
//      Life") is tagged right-aligned (U+E011) so the reader drops its first-line indent by GEOMETRY,
//      not by a fragile date/name text guess. Gated on a leading em/en dash AND geometry (pushed well
//      right of the body margin, reaching the right margin): right-alignment ALONE is overloaded here
//      (this book right-aligns chapter titles), the attribution dash is not — verified across both
//      test books it tags all 14 genuine attributions and none of the headings / index tails / wrapped
//      quote lines. Companion reader change (no re-extraction): plainParagraphStyleFor takes the
//      alignment as a PRIOR before the text heuristics, and the signature/attribution heuristic no
//      longer fires on a citation (URL or quoted title present) — so a note that merely contains a
//      date keeps its indent (note 54 vs 55).
// v42: headings are tagged from the PDF OUTLINE (bookmarks), not just font geometry. The outline
//      loop now RECURSES (it was top-level only, silently dropping nested section headings — 45 of
//      them in the Kurzweil book), and every entry, resolved to its destination Y, tags the matching
//      line on that page as a heading (isHeadingLine ORs it, so the author's structure precedes the
//      font-family rule). A normalized prefix title-gate (either direction) is the safety — it tags
//      real headings the font rule missed ("INTRODUCTION", "WHAT DOES IT MEAN TO REINVENT
//      INTELLIGENCE?", section titles) while rejecting page-only bookmarks whose destination lands on
//      non-heading text (a "Copyright" bookmark → the imprint line). Chapters are unchanged (still
//      built from top-level entries). Flat-outline books (no nested bookmarks) keep the font rule.
// v43: (a) a TAGGED PDF's own structure now drives extraction — getMarkInfo gates a marked-content
//      pass where H1–H6 = heading / P = body (authoritative over font geometry), and text inside an
//      Artifact (pagination) is dropped. (b) Running heads/footers on UNTAGGED PDFs are removed by
//      geometry: a line in the extreme top/bottom margin band (≤8% of page height) that is a bare
//      page number, a "page-number | section" running foot, or a signature recurring on ≥3 pages is
//      pagination, not content. The tight band excludes real headings; the pattern/repeat gate
//      excludes body. Verified: strips all of Agentic Mesh's "xx|Preface"/page-number footers,
//      inert on Kurzweil/Sovereign (no false removals). Also: book title now prefers the PDF's
//      metadata Title over the inferred first line.
// v44: two refinements to v43. (a) The running-head/footer test now strips emphasis markup first —
//      a BOLD footer arrives as "**xvi | Foreword**", and the "**" broke the page-number/shape match
//      so short-section bold footers survived; stripping "*_~`" fixes it. (b) Duplicate list bullets
//      are removed: some generators emit a bullet BOTH as a lone glyph and at the start of the item
//      run ("•" + "• An AI agent…" at the same x/y), doubling it in the reflow; the lone one is
//      dropped when a run at the same spot already carries it. Verified on Agentic Mesh.
// v45: bullet-list fixes extended. The lone-bullet de-dup now also collapses a DOUBLED lone bullet
//      ("• •" — two standalone bullet glyphs at one spot, the item text carrying none), keeping one;
//      and a line that starts with a bullet now begins a new paragraph, so list items (and their
//      wrapped descriptions) no longer reflow into one run-on block. Verified on Agentic Mesh p40.
// v46: two-column (gutter) re-flow. A page region laid out in two columns has a vertical gutter no
//      text crosses; baseline clustering otherwise merges a left-column line with the right-column
//      line at its baseline into one garbled line. Detect a genuine gutter (an empty mid-page band
//      that ≥5 dense lines share, with real word text on both sides — gated hard against tables,
//      indexes-of-numbers, TOCs and coincidences via a density ≥0.7 and right-column non-numeric
//      test) and re-flow: read the whole left column top→bottom, then the right. Verified to fire on
//      the Agentic Mesh back cover / credits / two-column index and on ZERO Kurzweil/Sovereign pages.
// v47: fix a v46 regression — the two-column re-flow re-stamps a line's `y` to a reading-order
//      coordinate (right column pushed below left), which fed the header/footer margin-band test
//      bogus positions (759 "margin" lines vs ~390), so two-column index/back-cover content drifted
//      into the band and risked being dropped as pagination. Lines now carry a real `pageY` (the
//      untouched glyph position) that the margin-band test uses, while `y` stays the reading order.
// v48: lower the two-column density gate 0.7 → 0.6. A genuine but cross-reference-heavy index page
//      scored 0.65 and was left garbled; 0.6 admits it while the numericness gate still rejects the
//      one look-alike near that range (a data table at 0.63 but 0.84 numeric). Verified: still ZERO
//      Kurzweil/Sovereign pages; all 9 Agentic Mesh index pages + back cover + credits now re-flow.
// v49: replace the geometry two-column detector with pdf.js's own signal — content-stream ORDER.
//      getTextContent emits each column top-to-bottom before the next, so a jump BACK UP the page in
//      that order is the column boundary. bodyGlyphs are split into segments at those jumps and each
//      segment clustered + stacked in reading order. Principled (from the document, not a gutter
//      heuristic), and gate-free: it catches all 11 Agentic Mesh two-column pages (back cover,
//      credits, 9 index pages) with ZERO false positives on Kurzweil/Sovereign; single-column pages
//      have no jump so they stay one segment and extract exactly as before.
// v50: a BOLD bullet arrives as "**•** …", so the block assembler's startsBulletLine (which looked
//      for a bullet at the very start of the line) never fired and consecutive bullet items merged
//      into one block. Skip a leading emphasis wrapper before the bullet marker (same fix mirrored in
//      the reader's paragraph-merge guard). Verified end-to-end through the real reader pipeline.
// v51: gate the content-order column split — a content-stream jump-back also happens on a
//      stacked/centred page drawn out of order (a TITLE page: title, author, publisher all centred),
//      which was being segmented and reordered, scrambling it. Only treat segments as columns when
//      their x-centres are horizontally SEPARATED (> 25% of content width); a centred page keeps one
//      x-centre and stays a single flow. Verified: title p5 → single; index/back cover → columns.
// v52: fix the segment stacking order. Segments were re-stamped by SUBTRACTING a cumulative offset,
//      which preserved each segment's real y — so a spine block drawn first at the page bottom sorted
//      back among later columns ("DATA" landing mid-bullets). Now each segment is stacked strictly in
//      content order (segment 0 on top) regardless of real y, keeping its internal spacing. Verified:
//      back-cover spine groups at top, bullets stay contiguous, index unchanged.
// v53: block assembler now refuses to merge two lines that are FAR APART on the physical page
//      (by real pageY), whatever their reading-order y. This cleanly separates a left column's tail
//      from the right column's head (the reflow stacks them adjacent though they sit a page apart)
//      and stops spine/edge metadata gluing onto a column line it reflows next to (the ISBN that was
//      fusing onto bullet 5, real y 68 vs 166). Single-column pages: pageY==y, so only real gaps fire.
// v54: drop cover/barcode metadata (ISBN line, printed price "US $.. CAN $..") — non-content that,
//      ending in digits, the reader was gluing onto the next paragraph. Whole-line patterns that
//      never occur in prose (a sentence mentioning "US $5 billion" is not dropped).
// v55: SIDE-BY-SIDE two columns. Two-column regions are now tagged (each block gets a col: left/right
//      by its x-position) and emitted as a structured block — U+E014 <left ¶s joined by U+E016> U+E015
//      <right ¶s> — that the reader lays out as two columns next to each other (stacking on narrow
//      screens) instead of flattening left-then-right into one flow.
// v56: fix column tagging — a full-width intro and the left column can share ONE content segment
//      (no y-jump between them), so tagging whole segments left the bullets full-width and nothing
//      paired with the right column (twoColUnits=0). Now each LINE is tagged left/right by its own
//      x-position, gated on its real-y overlapping a right-column line — so the left column pairs
//      with the right while the full-width intro stays full-width.
// v57: snap hyperlink boundaries to word edges. pdf.js returns a whole line as one text item, so a
//      link that wraps only part of it is resolved per character by a uniform-width x estimate — a
//      few characters fuzzy, so the link grabbed a leading punctuation (", Andy…") and a trailing
//      partial word ("…stated t"). Each linked run is now pulled to the nearest space, since a link
//      always covers whole words. URLs (no internal spaces) are unaffected.
// v58: EXACT hyperlink boundaries from the operator list. pdf.js hands back a whole line as one text
//      item, so mapping a link rect to characters by uniform width was a few chars fuzzy on short
//      links (two adjacent links "OpenAI"/"Anthropic" merging with "as "/","). The operator list has
//      each glyph's true x (validated against the rects), so each link's exact text is extracted and
//      matched inside the item. Falls back to the estimate+word-snap if the op-list can't be parsed.
// v59: use glyph COLOUR to delimit a link's exact text. A hyperlink is set in a distinct colour
//      (dark red here); matching link glyphs by rect position alone still grabbed a black neighbour
//      word ("as OpenAI,") because the rect's y-tolerance caught the adjacent line. Taking the
//      link-coloured glyphs inside the rect (falling back to a tight-x span for black links) gives the
//      exact text — "OpenAI"/"Anthropic" separate and clean. Verified against the real pages.
// v60: right-aligned PROSE (a "Praise for…" page of flush-right multi-line quotes) is now joined into
//      paragraphs instead of emitted one-per-line. One-per-line shattered each quote/attribution into
//      separate lines that — because a long right-aligned line starts near the left — read as chaotic
//      mixed left/right alignment, and split a two-line "—Name, title" credit across paragraphs. Prose
//      is detected by long lines (median width > 55% of the measure); paragraphs break on a wider gap
//      or a leading em/en dash (the credit marker). Centre display blocks stay one-per-line (titles).
// v61: the right-aligned-prose credit split must see through a leading italic marker. An italic
//      attribution ("—Simon Torrance, CEO, AI Risk" set in MinionPro-Italic) is emitted as
//      "*—Simon…*", so the em/en-dash credit test — which looked at the first character — missed it
//      and the credit stayed glued to the end of its quote. The test now skips a leading */_/~/` .
// v62: ROW-MAJOR two-column tables (a colophon: "Role: Name" credits in two side-by-side columns,
//      each row holding a left cell AND a right cell on the same baseline). The content-order column
//      detector only catches column-MAJOR layouts (whole left column, then whole right), so these
//      merged into one line per row ("Acquisitions Editor: Aaron Black Indexer: Judith McConville").
//      Now the longest contiguous run of rows split by an aligned vertical gutter is cut at it into
//      left (col 0) / right (col 1) cells; a block never spans columns, so each row pairs into a
//      side-by-side two-column unit. Non-table content on the page is untouched.
// v63: the content-order column detector required a y-OVERLAP between the differently-centred
//      segments. A spine/ISBN block emitted first at the page bottom is a separate segment at a
//      different x-centre but a DIFFERENT vertical position — x-centre spread alone falsely flagged
//      the colophon as two-column, sending it down the column path (which merged its row-major credit
//      table) and skipping the v62 row-major splitter. Real side-by-side columns overlap vertically.
// v64: dialogue turns no longer merge. A page of rapid one-line quoted turns makes the first-line
//      INDENT the modal left, so bodyLeft became the indent (not the margin) and the `x > bodyLeft+8`
//      paragraph-start test never fired — a turn that wrapped to a full line merged into the previous
//      turn (short turns escaped via the bothShort rule, long ones didn't). Fixed with paraLeftMargin
//      (the leftmost frequent left = the true margin) and by no longer excluding dialogue lines from
//      the indent break; a wrapped continuation sits at the margin, so it is never split.
// v65: outline chapter offsets resolve for BOLD headings again. The heading offset is located by
//      searching the assembled content for the bookmark's heading line, but pageLineGeom captured the
//      RAW line text (with emphasis markers, "**Title**") while the content strips emphasis from
//      heading blocks — so indexOf failed for every bold heading, ALL offsets fell back to the
//      page-start marker, and same-page bookmarks collapsed (a section + its first topics on one page
//      merged; a topic sharing a page with a prior topic's tail started before it). Match the stripped
//      heading text. Only affects books whose headings are bold (e.g. Transurfing's 78 topics).
// v66: extract embedded raster figures. Each meaningful image XObject (icons/rules filtered by size)
//      is re-encoded to a size-capped JPEG and cached (fileType 'figure-image', bookId+id); a
//      [[FIG id]] marker is injected into the content at the figure's Y so it sits in the reading
//      flow. Markers are stripped from all text consumers (reader display/TTS/LLM/analysis); the
//      reader render arrives in Phase 5. Manifest (rect/aspect, no bytes) rides on FileContext.
// v67: figure size = its real fraction of the page's text column (colFrac in the manifest), so a
//      figure reads proportionally to the surrounding text instead of off a fixed nominal width.
// v79: re-anchor PDF outline chapters by title when the bookmark destination is broken
//      (z-library PDFs use /Fit destinations with no Y, pointing at the wrong pages, so
//      same-page bookmarks collapsed and chapters resolved to the wrong content). Trust
//      the destination only when its heading matches the entry title; else locate the real
//      opener by searching the content for the title (prose-backed, wrap-tolerant).
// v80: recognise "fn"-prefixed footnote markers (markerLabelOf strips a leading "fn"; the note-
//      anchor injection matches an "fn3 …" entry) so link-backed page-bottom/chapter-end footnotes
//      navigate like numbered ones; drop unanchorable outline entries (title unfindable + destination
//      heading mismatch, e.g. an image-only "Picture Section") instead of splitting a real chapter.
// v81: keep the literal "fn" prefix on footnote markers (honest label "fn3", not "3"); anchor an
//      unanchorable image-only outline entry (e.g. "Picture Section") to its real plate figures in
//      reading order instead of dropping it or trusting the broken bookmark destination.
// v84: highlight a URL link by its contiguous displayed token (whitespace-delimited), not by
//      char-matching the annotation URL — the annotation URL is often malformed (doubled
//      "http://http//") or encoded differently ("%2C" vs a literal comma), which truncated the link.
// v85: drop outline entries the resolver couldn't place (undefined offset) instead of letting
//      buildChaptersFromOutline resurrect them via `offset ?? offsetForPage(page)` — a broken
//      bookmark page (Copyright→inside Ch4, Title Page/Dedication→Ch1's page) otherwise splits a
//      real chapter.
// v86: trim trailing sentence punctuation (. , ;) from the URL token (root-cause URL fix in v84 —
//      link a URL by its whitespace-delimited displayed token, never by char-matching the arbitrarily
//      encoded annotation URL).
// v87: emit geometry-only superscript ROMAN footnote markers (e.g. "I", "II" in The Sovereign
//      Individual) as clickable #pdfnote links, like the digit heuristic already did. UPPERCASE only,
//      value 1–40, previous glyph ends a word — so a lowercase superscript roman (a MATH INDEX like
//      "layerⁱ" / "Nⁱ neurons in layer i" in Kurzweil) is NOT mistaken for a footnote.
// v88: capture a multi-level outline hierarchy — promote a Part/Section divider's chapter children
//      into the chapter list (a Part → Chapter book like Agentic Mesh) and record each entry's level
//      in pdfOutline, so both the Part and its Chapters are navigable reading units and the TOC can
//      render nested. Flat outlines are unchanged (every entry stays level 0).
// v89: figure gate by AREA + short-side floor instead of "both sides ≥ 90pt" — the old rule dropped
//      wide-but-short diagrams (Agentic Mesh "Figure 14-1" 288×81pt, Kurzweil cellular-automaton
//      strips). Strict superset of the old gate, so no previously-shown figure is lost.
// v90: index page-number references — make SINGLE page numbers clickable like ranges. A backward
//      numeric go-to link sitting mid-line after an index term ("Africa, 388") is an index page ref,
//      not a note back-link (those lead their line) → emit as a #pdfref cross-ref. endsWithPageRef
//      unwraps a trailing "[213](#pdfref-p274)" link so index detection still fires.
// v91: re-attach a paragraph-LEADING forward footnote marker to the previous sentence. A superscript
//      that wraps to the next line ("…created.\n\n[58](#pdffn-p443-y) Likewise…") was left inert
//      because the reader reads a leading marker as a note-entry label. Move only forward markers
//      (dest page > marker's page); note entries (dest == own page) stay put.
// v92: detect whether the source PDF sets its body text JUSTIFIED (nearly every body line reaches
//      one right margin) vs ragged-left, and store it (sourceJustified). Under the reader's 'auto'
//      alignment setting this mirrors the source — justify + hyphenation for justified books, left
//      for ragged ones (e.g. Elon Musk) — with a Settings override [Auto | Justify | Left].
// v93: a "Praise for …" page (centred heading over flush-RIGHT body prose) mis-split a two-sentence
//      quote at its internal period. The right-aligned display detection is a property of the BODY
//      lines, but it spanned ALL display lines — the centred heading's short right edge inflated the
//      right-edge span, defeated the 'right' classification, and dropped the page into the prose
//      splitter, where the second sentence's line (starting well right of the margin) read as a new
//      first-line-indent paragraph. Classify alignment from the non-heading lines when there are ≥3
//      of them, emit the heading as a heading, and join the flush-right quotes into one paragraph
//      each (breaking on the credit dash) — short display pages keep the legacy whole-page basis.
// v94: two-column short-line measure. The back-cover "what you'll learn" bullets split at their wrap
//      ("…agentic mesh" | "and its transformative potential") because bothShort's short-line test
//      measured every line against the DOCUMENT-wide text width — a column line spans only its column,
//      so all of them read as "short data" and shattered one block per line. Now a line the band
//      detector assigned to a column is measured against that COLUMN's own width (isShortColLine);
//      single-column lines (col===undefined) keep the page-wide measure, so only two-column bands change.
// v95: a CUSTOM-TEXT link (anchor is descriptive text, not the URL) whose anchor wraps across a line
//      rendered as two underlined spans with a gap ("…COO of Google" | "DeepMind, writes") — pdf.js
//      emits one link box per wrapped line, so the same-url anchor came out "[…Google](u) [DeepMind…](u)".
//      The existing merge only covered the HYPHENATED wrap; now consecutive same-url spans separated by
//      the soft-wrap space collapse into one link too (looped for a 3+-line anchor).
// v96: keep front-matter bookmarks (Cover, Copyright, Title Page, Dedication) as their own catalogue
//      chapters. Their titles aren't headings in the page, so heading-offset resolution left them
//      unresolved and pass-2 DROPPED them — the first surviving chapter (Table of Contents) then
//      absorbed their content via sourceStart→0. Now, when the outline is page-MONOTONIC (a reliable
//      /XYZ outline, not a broken z-library /Fit one whose pages jump around), an unresolved entry is
//      anchored at its OWN bookmark page marker when that offset falls in the gap between resolved
//      neighbours. Non-monotonic outlines keep the drop, so broken bookmarks still can't split chapters.
// v97: a multi-line RIGHT-ALIGNED signature at the end of prose (Foreword: "— Sean Falconer" /
//      "Head of AI, Confluent") was split by bothShort (both lines short), so only the dash-led first
//      line got the right-align tag and the title line rendered as stray left-aligned body. bothShort
//      now keeps a FLUSH-RIGHT continuation (no leading dash) attached to its flush-right dash-led
//      opener, so the whole credit is one right-aligned block; a NEW "—credit" still splits normally.
// v98: the v97 right-credit-continuation join missed ITALIC credits. A set-off credit is usually
//      italic, so the emphasis wrapper makes the line text start with "*" ("*— Sean Falconer*"), and
//      the v97 guard's /^\s*[—–]/ dash test failed on the leading marker — so bothShort still split the
//      title line off. Both the continuation guard AND isRightAttribution now skip a leading */_/~/`
//      run before the dash (matching opensCredit), so an italic multi-line credit stays one right block.
// v99: a chapter whose heading sets its NUMBER on its own line above the title ("2" ¶ "AFRICA", Elon
//      Musk) left a stray bold "2" at the END of the previous chapter. findHeadingOffsetByTitle drops
//      the number (normalizeHeadingText) and its `pre` only reaches a same-line number, so the chapter
//      offset landed on the title line and orphaned the number line. Now the match optionally absorbs
//      the title's EXACT leading number sitting on its own line just before the title, so the chapter
//      starts at its number (specific-number match avoids grabbing an unrelated page/footer number).
// v100: block-paragraph layouts on JUSTIFIED pages (e.g. a definition list — an italic term flush at the
//       margin with an indented description under it) were glued into one run-on paragraph. The geometry
//       splitter keyed on the NEXT line's first-line indent + punctuation, both absent here. Add a
//       principled justified-text signal: a previous line that ends SHORT of the right margin (doesn't
//       fill the measure) is a block boundary, so the next line starts a new paragraph. Gated to justified
//       sources; ragged text (short lines everywhere) is untouched. Validated on Agentic Mesh p41.
// v101: preserve indentation on justified pages. (a) A body block whose WHOLE text sits indented under
//       the body margin (a definition description) now carries that left indent as leading NBSP →
//       reader padding. (b) Detect first-line-indent vs BLOCK style from justified-page paragraph
//       geometry (does a paragraph's first line sit deeper than its continuation lines?) and emit a
//       document `sourceFirstLineIndent` flag; when it's block-style the reader stops forcing its fixed
//       1.75em first-line indent, so block-paragraph books (e.g. Agentic Mesh) render flush like the
//       source. Conservative: only 'false' fires, over enough justified samples; ragged/unknown → default.
// v102: a FLUSH labeled list (email header From:/Date:/To:/Subject:, an address block) has each entry on
//       its own line, but with no hanging indent the splitter merged them into a run-on. Split when two
//       CONSECUTIVE lines both open with a short "Label:" (labelStart). Requiring BOTH neighbours keeps
//       prose from splitting (validated: 3 splits on the Elon email header, 0 on Elon/Kurzweil prose).
// v128: detect VECTOR-drawn list bullets (a small filled dot path getTextContent can't see) — track the
//       CTM over the op stream, keep small square/round FILLED paths that form a column of ≥2 aligned
//       markers, match each to the text line it hangs beside, and inject a "•" glyph so the existing
//       bullet-paragraph rendering takes over (parity with the same book's EPUB <ul>). Live audit:
//       window.__dbgVectorBullets + a per-page console log of the matched line content.
// v129: split a hanging-list entry (dialogue speaker turn / CIP field) on the LABEL at the block's
//       outdent tier, not on the previous line's justification — Ch 8 "…give us meaning? RAY: Well…"
//       merged because the "?" line ended only ~8pt short (read as filling the measure) so prevEndsShort
//       missed it. Gated: fires only when the block already has a deeper continuation tier + the current
//       margin line opens with "Label:". Live audit window.__dbgDlgSplit + a [dlg-split] console log.
// v130: keep a whole labeled hanging-list REGION (dialogue/CIP) intact as one group so it splits
//       per-entry on the LABEL (emitHangingEntries), instead of the justified short-line / terminal-
//       indent rules fragmenting a turn whose continuation sits at the indent tier — fixes (a) a turn
//       truncated at an internal sentence end ("…early 2030s. / So the in-between…"), (b) NBSP indent
//       leaking mid-turn as blank gaps ("our  computers"). Live audit window.__dbgHangRegion +
//       [hang-region] console log. (Hanging-indent VISUAL is a follow-up; entries render flush for now.)
// v131: remove the per-line "label at outdent tier" dialogue break (v129) — the v130 region gate now
//       owns genuine dialogue/CIP, and the per-line rule false-fired on a wrapped person's name in prose
//       ("…engineer Daniel Feldman:"), the classic v26 over-fire.
// v132: HANGING-INDENT visual for speaker labels — a region-gated hanging-list entry (dialogue/CIP)
//       is tagged U+E01A + an NBSP run encoding the source outdent→continuation gap; the reader drops
//       the 1.75em first-line indent (para.indent>0), pads left by the tier, and adds a matching
//       negative text-indent so the label hangs at the margin and wraps indent under the text.
// v133: two block-indent/merge fixes surfaced by v132 review — (a) a single-line block-indented
//       paragraph that FILLS the measure keeps its indent (was dropped by the group.length>=2 guard,
//       so one full sentence rendered flush while its multi-line sibling stayed indented); (b) the
//       cross-page seam-merge rejoins a bullet/indented item whose tail wraps onto the next page at the
//       INDENT tier (bodyX), not only a margin continuation — and strips the tail's leading NBSP so no
//       gap leaks mid-sentence.
// v134: refine the two v133 fixes after review — (a) a first-line-indent split now requires the line be
//       deeper than the PREVIOUS line (not just the page margin) OR open a list marker, so a block-indented
//       explanation whose sentence ends at a line boundary stays ONE paragraph ("Some fleets…" + "These
//       fleets…") while MYCIN "1./2." items still split; (b) a block's bodyX (seam-merge tier) is taken
//       from its CONTINUATION lines, not line 1 — a bullet's first line sits at the outdent (x=90) and
//       skewed the tier off the text column (x=102), so the cross-page bullet tail still didn't merge.
// v135: a list marker at END OF LINE (a standalone "IF:" whose conditions are on following lines) now
//       counts as opensListMarker — so a MYCIN rule's "IF:" keeps its block indent and aligns with
//       "THEN: …" (both at x=130 in the source) instead of rendering flush at the margin.
// v141: a lettered SUB-item's block indent is measured from the list's own top-level margin (the
//       leftmost tier holding >=2 numbered markers) instead of the per-page paraLeftMargin, which
//       wobbles right on a page carrying too few top-level openers to be sampled (Sovereign p338:
//       only "8."/"9." at x=84, so the margin collapsed to the continuation tier x=102 and sub-items
//       a.-d. de-nested to flush vs the identical items on p337). Keeps every sub-item at one depth.
// v142: a ragged block on a justified page (a figure caption / source line / address, left-aligned so
//       every line ends short) no longer shatters one line per paragraph. A short line marks a justified
//       paragraph boundary only when it ENDS the paragraph (terminal punctuation); a same-margin mid-phrase
//       wrap ("…in the Twentieth" / "Century (Princeton…", Singularity p165) is kept in the block so the
//       caption reflows. Prose boundaries (last line ends with . ? !) and definition/note boundaries
//       (different left margin) are unaffected.
// v143: the ragged-caption reflow (v142) must not swallow a line that OPENS a new list item/bullet/
//       footnote entry — MYCIN's numbered conditions end mid-clause ("…and") at the same margin, so they
//       were merging into their neighbours and the rule's list collapsed. Exclude currentStartsNewBlock.
// v144: the labelPair splitter (email From:/Date: headers) must require a CLEAN field name — a figure
//       caption "Century (Princeton, NJ: …" carries an early colon too, so the loose test paired it with
//       the "Principal sources:" line above and split the caption there even after prevEndsShort was
//       suppressed. isFieldLabel requires letters/spaces/hyphens before the colon.
// v145: an index alphabet-nav letter (a standalone single uppercase letter linking to its section, on a
//       page with ≥5 such single-letter go-to links) is routed as a plain clickable cross-reference —
//       BEFORE markerLabelOf, so a roman letter (I/V/X, value ≤40) isn't mis-read as a footnote marker and
//       rendered inert. The trailing space that shares the letter's link run is left plain so adjacent
//       same-page letters ("Q R", "Y Z") don't fuse into one link.
// v146: an index alphabet-nav letter carries its section Y in the href (#pdfref-p{page}-y{destY}) so the
//       reader can land on the letter's SECTION heading (a letter's section can start mid-page — U on p651
//       sits below the tail of T), not just the page top.
// v147: each emitted block carries a relative FONT-SIZE tier sentinel (U+E01B–U+E01F) = its dominant line
//       height vs the document body size, quantized to 5 tiers with a deadband around 1.0 (body untagged).
//       The reader renders it as an em-multiple of the base size, reproducing the source's size hierarchy
//       (figure title/subtitle, sub-heads, captions, metadata) instead of flattening everything to body size.
// v179: explicit-LEFT tag (U+E023). On a JUSTIFIED document, a multi-line block at the body margin whose
//       non-last lines all fall short of the right margin is a left-ragged block (copyright/dedication front
//       matter), not justified body — tag it so the reader skips justify and renders it ragged, faithful to
//       the source (the doc-level sourceJustified flag otherwise justifies everything). Narrow gate + 0 body
//       false positives validated on the test PDFs.
// v180: a small-caps BODY lead-in ("DO YOU THINK I'm insane?") no longer shrinks below body. The shrink
//       size tiers (E01B/E01C) now fire only when the block's CAP height is also small (genuine fine print
//       — footnotes/captions); a small-caps run has body-sized caps (the mixed-in regular glyphs), so it
//       stays body size. Same capH principle headings already use, extended to the shrink decision.
// v181: page-seam continuation merge fixed for two cases that split a sentence into a new paragraph at a
//       page break (Elon "…green" | "landmass…", "…write" | "about…"). (a) A prev line that ends short only
//       because the NEXT WORD was too long to fit in the trailing space is a forced WRAP, not a paragraph
//       end (forcedWrapAtSeam) — so it still continues. (b) A continuation may OPEN with a short line (need
//       not fill the measure) as long as it's a substantial body block, not a short running head. On merge,
//       the continuation's leading flush/size sentinels are stripped so nothing leaks mid-sentence. Fixes
//       both the visible gap AND the mid-sentence page break (pagination now breaks at the real boundary).
// v182: in-chapter footnotes with an "fn"-prefixed marker ("[fn2](#pdffn…)", Elon Musk) now start their own
//       block. startsFootnoteEntry's leadLink test matched only a numeric/roman label, so the whole footnote
//       section merged into the body (no blank line, no per-entry break) and fn2 navigation resolved nowhere
//       (SOURCE_REQUIRED). Use markerLabelOf, which accepts fn-prefixed markers while still rejecting a
//       descriptive dest link ("[page](#…)"). Each footnote is now a set-off entry (small font via the shrink
//       tier), the section breaks from the body, and the marker navigates to its local note.
// v183: DOUBLE decorative rules. A chapter deck/subtitle is bracketed by two thin lines ~2pt apart
//       (Sovereign ch1, ch3-8); the isolated-rule filter (drop a rule with >=3 neighbours within 50pt as a
//       table grid) dropped the middle line of each of the two pairs, leaving a single line. Rules are now
//       grouped into UNITS (two lines within 4pt = one DOUBLE unit) before the grid filter, and a double
//       unit emits U+E021 twice so the reader draws two close parallel lines instead of one.
// v184: link-underline guard no longer eats a decorative rule that merely passes near a NARROW link. An
//       underline spans the link TEXT (≈ annotation width); require the rule's width to match the link's, so
//       a full-column epigraph rule 3pt above a footnote marker isn't dropped (Sovereign p56 "We shall not
//       be…" lost its top rule).
// v185: PER-LINE centring on a MIXED page. The whole-page display classifier only fires when the entire
//       page shares one alignment, so a centred line among left-aligned prose (a promo back-matter page:
//       "A TOUCHSTONE BOOK", "FOR MORE ON THESE AUTHORS:") stayed flush-left. Tag a short single-line body
//       block as centred (U+E010) when it's indented on BOTH sides by a similar, significant amount (centre
//       ≈ body centre) — tight gates exclude signatures, headings, hanging entries, indented prose.
// v186: the per-line centre "short line" length check now measures the VISIBLE text — a centred URL line
//       (`[SimonandSchuster.com/…](http://…long…)`) has a ~110-char markdown link but only ~48 visible
//       chars, so it was wrongly excluded as "too long" and stayed flush-left while its neighbours centred.
// v187: VERSE/POEM geometric detection. The prose splitter mangled a poem (merged/split its short lines).
//       Detect a run of >=3 FULLY-ITALIC lines that each end short of the margin and share a left edge
//       (verse; unlike prose that fills the measure or an italic block-quote that wraps to full lines) and
//       emit each stanza as a U+E024 verse block — same reader path (tight <br> lines + stanza gap) as EPUB.
// v188: a page-spanning FIRST-LINE-INDENT paragraph no longer block-indents. Its lone first line at the
//       bottom of a page (indented by the first-line amount) couldn't be told from a block-indented line, so
//       it got a leading block NBSP that the seam-merge then carried into the whole paragraph. At the merge,
//       when the continuation opens flush at the body margin (proving a first-line indent), drop that NBSP.
// v189: a hanging-list region no longer swallows the INTRO PROSE before it. A labeled list ("Layer 1:… /
//       Layer 7:…") outvotes a preceding non-labeled paragraph in detectLabeledHangingList, so that prose was
//       tagged a hanging entry (Agentic Mesh "Here are the seven layers…"). The region must now OPEN with a
//       labeled line or an indented continuation; a non-labeled margin start line is left as normal prose.
// v190: MULTI-COLUMN DATA TABLE fidelity. A ditto/numeric frequency table (Sovereign p297 dice table — a
//       header row plus rows using ditto marks `"` to repeat "The sum of / spots will appear / times.")
//       was cut by the row-major detector at only its single widest gutter → 2 columns, stranding column 1
//       and mashing the other 5 into one cell. Now, when the aligned run has ≥2 majority-empty INTERNAL
//       gutters (≥3 columns), the whole table is emitted as a positioned-token payload (U+E025 <rows joined
//       by U+E024>, each token a PUA position char U+E200+permille of its x-fraction + its text) and dropped
//       into the block stream by yTop like a figure. The reader lays out each token at its x-fraction, so
//       every column — and every ditto mark under the word it repeats — aligns exactly as the original. A
//       plain 2-column colophon (one gutter) still takes the existing 2-col cut. Validated on p296 geometry
//       (nGut=5, all six columns land at a stable permille per row).
// v191: a multi-page data table (the dice table spans two pages: sums 24→9, then 8→2) keeps IDENTICAL
//       column positions across both fragments. The token x-fraction is now measured against the PAGE's
//       content bounds (contentMinX..contentMaxX = the body text column, identical on both pages) instead
//       of the table's OWN bounding box — the continuation page lacks the "The sum of" header, so its own
//       bbox is narrower and scaled/shifted its columns out of line with the first page's fragment.
// v192: the right-marker re-anchor (v160) grouped a CONTIGUOUS marker run across NESTING LEVELS — an outer
//       list ("5."/"7." … "8."/"9."/"10.") and its inner sub-list (a./b./c./d.) are all marker blocks in
//       reading order but at firstX tiers ~2×bodyFont apart, so the whole-run spread (84→114) mis-fired and
//       re-anchored BOTH levels to the deepest tab (Sovereign a/b/c/d dragged deep; 8/9/10 sucked into the
//       sub-list). Now the run is split into per-TIER sub-runs by marker-left (firstX, gap-clustered) and the
//       right-marker test applies PER tier: an aligned single-level list (spread 0) keeps its natural indent,
//       a right-tabbed roman list (markers jitter within ONE tier: i.=150…iii.=143) stays one sub-run and
//       still re-anchors. Validated headless across Sovereign 5/7, MYCIN, Singularity roman by
//       scripts/pdf-list-reanchor-audit.mjs (Sovereign stops firing; roman keeps firing; MYCIN unchanged).
//       NOTE: the a/b/c/d run-on MERGE (they end in ';', not .!?/colon) is a SEPARATE block-split issue, not
//       addressed here — a naive split fix regressed MYCIN, so it needs its own harness pass.
// v192 (final): the LIVE [dbg-reanchor] audit proved the base extraction ALREADY tiers Sovereign p337
//       correctly (outer 3-7 leadNbsp=0 flush; inner a/b/c/d leadNbsp=5 indented) — the ONLY defect is the
//       re-anchor firing on the whole cross-tier run (spread 31, measured 84→114) and OVERWRITING every item
//       to one deep tab (newNbsp 11). Fix: split the run into per-TIER sub-runs by firstX (gap-clustered),
//       apply the right-marker test PER tier — an aligned tier (spread≈0) keeps its correct base indent, a
//       right-tabbed roman list (Singularity, markers jitter within ONE tier) still fires. MYCIN (firstX≈133
//       uniform, spread 3) never fired. Validated on the REAL block geometry from the live audit, not the
//       offline harness (whose block grouping differed). See project_decodebook_pdf_merge_page_seam_only.
export const PDF_TEXT_EXTRACTION_VERSION = 'pdf-text-v250-math-superscript';

// EPUB extraction engine version. Bump whenever a change alters an EPUB's extracted text/structure.
// v1: first stamped EPUB engine — native structure (nav/NCX chapters, h1–h6 headings, img figures,
//     CSS text-align) emitting the same reader sentinels the PDF path uses. Existing EPUBs carry no
//     stamp ('(none)'), so they read as stale on this build and are re-extracted from their stored
//     original (or prompt a one-time re-upload when no original was kept).
// v3: a <blockquote> renders like the PDF — FLUSH-LEFT and full-width with a set-off gap above (U+E019
//     role, no forced indent; U+E022 top margin on the first block), a FLUSH FIRST LINE (U+E018, since the
//     source `.block/.noindent` set text-indent:0 and the reader otherwise adds its default first-line
//     indent), and the quote's OWN smaller font (a size tier read from the quote's font-size — e.g.
//     Sovereign's .block/.att 0.833em → E01C 0.86 — since sizeTierSentinel skips small tiers globally to
//     protect small-caps headings). Source italics + right-aligned attribution kept. (v2 wrongly indented.)
// v4: doc-level layout flags — sourceJustified + sourceFirstLineIndent, the parity the PDF already sets.
//     A tally over body paragraphs (CSS-inheritance-aware) decides whether most body text resolves to
//     JUSTIFIED (Sovereign's `.calibre` base = text-align:justify → the reader's 'auto' align justifies
//     the body, matching the PDF) and whether it uses a first-line indent vs block style. Conservative:
//     only decided over >= 8 sampled paragraphs, else left undefined (reader default).
// v5: per-paragraph FLUSH FIRST LINE — a paragraph the source explicitly sets text-indent:0 (e.g.
//     Sovereign's `.noindent` first-of-section paragraph) emits U+E018 so the reader drops its default
//     first-line indent, matching the PDF (first paragraph of each section flush, the rest indented).
//     Only fires on an explicit text-indent~=0 (not a mere omission, not a negative hanging indent).
// v6: SMALL-FONT parity — the EPUB now emits the shrink size tiers (E01B 0.72 / E01C 0.86) for genuine
//     small BODY content (footnotes, "also by", copyright fine print via the <p> path; endnotes via the
//     <li> path), matching the PDF (measured: notes/quotes/copyright ~0.85x body). sizeTierSentinel gains
//     an allowShrink flag — enlarge tiers always fire, shrink only for body callers. A heading guard keeps
//     it off headings: <h*>/nav-anchored heads use the enlarge-only path, and a short ALL-CAPS <p> (an
//     untagged small-caps head) is excluded, so a title can't be shrunk to fine print. Existing tiers are
//     reused (no new codepoints — the ~2 real shrink values are covered, and new sentinels would need
//     every strip site widened). Ratio thresholds mirror the PDF (<0.80 -> E01B, <0.90 -> E01C).
// v7: explicit-LEFT tag (U+E023) — a paragraph the source aligns left (copyright/dedication `.copya/.copyb`
//     in a justified book) emits it so the reader skips justify and renders it left-ragged, matching the
//     source. effectiveAlignOf resolves CSS inheritance (body prose = justify, no tag). Pairs with the PDF's
//     v179 (same sentinel + reader support).
// v8: DECORATIVE RULES (U+E021) — the EPUB draws rules as top/bottom BORDERS, so a `border-top/bottom:
//     … double …` (`.heading_break1` deck) emits a DOUBLE rule and `… solid/dashed …` (`.blockquote1/2a/2b`
//     epigraph, `.footnote` top separator) a SINGLE rule, as their own U+E021 divider paragraphs bracketing
//     the block — the same reader path the PDF's v183 double-rules use (unifies EPUB with PDF). Only top/
//     bottom borders (a horizontal line), never the all-sides `border:` shorthand or table/figure boxes; a
//     ruled block child inside a heading (the deck) is bracketed by the h1 handler so the rule paragraphs
//     sit OUTSIDE the heading sentinel.
// v9: (a) BOX borders no longer become decorative rules — a class with a left/right border (a promo
//     sign-up box side like `.signup-top`) is a box frame, not a horizontal divider, so its top/bottom
//     edges are skipped (they were littering back-matter pages with stray lines). (b) A <br>-separated
//     line block containing standalone LINKS ("FOR MORE ON THESE AUTHORS:" + author URLs) splits into a
//     paragraph per line, preserving the source's 3-line structure instead of running the URLs off-edge.
// v10: index INTRO note no longer shrinks. The "A note about the index:" para (`.indextxt`) and the index
//     entries (`.indexmain`) are BOTH 0.75em — the whole index shares a reduced baseline — so the note must
//     match the entries, which the <li> path renders at reader-normal size (no shrink). Suppress the shrink
//     tier for index-class paragraphs; the note read a size smaller than its own entries before.
// v11: a CENTRED small caps line is display/promo text, not an untagged section head — honour its real
//     small size (Sovereign's 0.75em "A TOUCHSTONE BOOK" was kept full-size by the all-caps shrink guard).
//     The shrink guard now yields to `text-align:center`. (Pairs with the reader no-bolding centred lines.)
// v14: VERSE/POEM support. A poem (`.poem` lines, `.poemb` stanza ends) now emits each STANZA as one
//     paragraph whose lines are joined by U+E024 — a hard line-break sentinel that survives the chapter-build
//     whitespace collapse (unlike a raw \n) and is restored to \n in buildPageSentenceData, so the lines
//     render TIGHT (lineBreakAfter → <br>) and each stanza (its own paragraph, flagged para.verse) gets a
//     stanza gap. normalizeReaderText never merges a verse stanza across the blank line; combinedText
//     neutralises U+E024 for search/footnote offsets.
// v15: EPUB now returns its OPF <dc:title> as docTitle (like the PDF's metadata title), so the display
//     title + re-upload dedup identity use the real book title instead of the one INFERRED from the content
//     title page. That inferred title could differ from the PDF's metadata title (a different subtitle
//     edition — Sovereign "How to Survive…" vs "Mastering…"), splitting one book into two library items.
//     Bumping re-extracts existing EPUBs so their title (and dedup) self-correct in place.
// v16: DATA TABLE parity with the PDF. A multi-column <table> (Sovereign's dice-frequency ditto table) is
//      emitted as the same positioned-token payload the PDF uses (U+E025 <rows joined by U+E024>, each token
//      a PUA position char U+E200 + permille of its x-fraction + text), so the reader renders every column
//      aligned exactly instead of flowing the cells into a run-on line. The EPUB has no coordinates, so a
//      cell's x-fraction is its COLUMN INDEX / total columns (honouring colspan — the header's spanning cell
//      starts at its column). Gated to ≥3 columns and ≥3 rows; a smaller/layout table is unchanged.
// v17: infer a Part→Chapter TOC hierarchy when the nav is FLAT. Some EPUBs (Agentic Mesh) list the Part
//      dividers and their Chapters as SIBLINGS at the same nav level, so the nested catalogue the PDF shows
//      (Part I → chapters 1-4, Part II → 5-12, …) was flattened. When the outline came out entirely flat
//      AND holds ≥2 Part dividers (a bare Roman-numeral / "Part …" title, never "Chapter I.") with numbered
//      Chapters after them, each numbered Chapter is nested (level 1) under its preceding Part;
//      buildChaptersFromOutline then links parentId and the reader renders the collapsible tree. Front/back
//      matter stays top-level. Gated on ≥2 Parts so partless books (Elon, Sovereign, Transurfing) are
//      untouched (validated across all test EPUBs: only Agentic Mesh nests).
// v18: GENERAL CSS selector matching. The style resolver was class-keyed — it read font-style/weight/
//      text-align/font-size/indent from `.class` rules only, so a PROFESSIONAL EPUB (O'Reilly's Agentic
//      Mesh) that styles via TAG / ATTRIBUTE / DESCENDANT selectors and ::before pseudo-elements resolved
//      NOTHING (italic quotes read roman, attributions lost their right-align + em-dash). Added a general
//      matcher (tag + [attr] + ancestor/descendant, specificity-ordered cascade) used as a FALLBACK after
//      the class/inline fast path — so class-styled conversions (Sovereign/Elon/Transurfing) are unchanged
//      while semantic stylesheets now resolve. A whole-paragraph italic emits U+E026 (survives sentence
//      splitting, unlike wrapping in *…*); a ::before content (attribution em-dash) is prepended; an
//      attribution <p> (right-aligned) is kept out of the block-quote set-off.
// v19: DEFINITION LISTS (<dl>/<dt>/<dd>) — O'Reilly's "What You Will Learn" etc. No handler existed, so
//      the term/description pairs flattened into run-on prose. Now each <dt> is its own paragraph (italic
//      when `dt{font-style:italic}` resolves via the general matcher) and each <dd> an indented paragraph
//      below it, the indent from the <dd>'s own left margin (`dd{margin-left:1.5em}`) → NBSP.
// v20: STYLE resolvers go through the general selector matcher, NOT the class-keyed maps. The class maps
//      OVER-ATTRIBUTED a compound rule's property to every class in it (`div.preface dt em code{font-style:
//      italic}` marked `.preface` ITSELF italic; a descendant font-size leaked onto a wrapper class), which
//      flat-italicised whole professional-EPUB sections and enlarged paragraphs. elItalicOf/elBoldOf/alignFor/
//      effectiveAlignOf/cssFontSizeOf/boxLeftEm/isBlockChild/borderRuleOf/indentFor now resolve via the
//      matcher (correct specificity + descendant/attribute matching). This is the mechanism by which
//      professional/native EPUBs INHERIT every style-based solution built for calibre conversions.
// v21: fix the class-map POPULATION (root of v20's over-attribution) — a property is attributed ONLY to
//      the class(es) in a selector's RIGHTMOST compound (its subject), so `div.preface dt em code{italic}`
//      no longer marks `.preface` italic. Resolvers keep the CLASS fast path FIRST (calibre unchanged) then
//      fall back to the general matcher (professional EPUBs inherit). Also: a verse blockquote no longer
//      DROPS a trailing non-poem child — a credit after the stanzas (Sovereign's "—FIFTEENTH-CENTURY ENGLISH
//      BALLAD") is emitted as its own block.
// v22: (a) an <ol>'s <li> markers honour `list-style-type` (Sovereign's `ol.nlista_lower` → a/b/c/d, not
//      1/2/3/4) + the item's own value/start — resolved via the general matcher. (b) an href-less <a> that
//      WRAPPED block content (a self-closing `<a data-type="indexterm"/>` HTML didn't self-close, so the open
//      <a> swallowed the following <dl>) returns its childText UNFLATTENED — the definition list no longer
//      collapses into run-on prose.
// v23: a NESTED list item (an <ol>/<ul> whose parent list sits inside another list's <li> — Sovereign's
//      a/b/c/d sub-list under "5. …") indents by its rendered depth (renderedIndentEm → NBSP, the SAME
//      mechanism the index sub-entries already use); a top-level item nets 0 and stays flush. Validated
//      headless across all 4 test EPUBs by scripts/epub-list-audit.mjs: the change touches ONLY the 8
//      genuine sub-list items — 0 index entries, 0 flat lists, 0 in the other three books.
// v24: a list item that CONTAINS a nested sub-list now emits its OWN text and the sub-list as SEPARATE
//      \n\n paragraphs (mirrors the index-entry handler), instead of folding the sub-list into the item's
//      text where the <ol>/<ul> wrapper's .trim() stripped the FIRST sub-item's leading NBSP+newline and
//      glued it onto the parent (Sovereign "5." swallowed sub-item "a." — a floated flush while b/c/d were
//      indented). Now a/b/c/d are uniform indent-7 paragraphs under item 5. Validated headless by
//      scripts/epub-list-audit.mjs: touches ONLY 2 sites (Sovereign items 5 & 7) — 0 in the professional
//      EPUB (Agentic Mesh; its index already separated) and 0 in Elon/Transurfing.
// v59: preserve a blockquote's source typography through its wrapper. A right-aligned ATTRIBUTION now
//      carries its own resolved source font-size tier, so O'Reilly's inherited `font-size:95%` applies to
//      both quote and credit. The wrapper also captures the newer E028/E029 controls before inserting its
//      NBSP indent; otherwise the indent hid a later E026 italic flag and rendered the authored quote Roman.
export const EPUB_TEXT_EXTRACTION_VERSION = 'epub-text-v84-callout-label-searchable';

// The extractor version this build EXPECTS for a given source kind (undefined for TXT/HTML/etc.,
// which have no structured extractor and are never stale).
export const expectedExtractorVersion = (sourceKind: string | undefined): string | undefined =>
  sourceKind === 'pdf' ? PDF_TEXT_EXTRACTION_VERSION
    : sourceKind === 'epub' ? EPUB_TEXT_EXTRACTION_VERSION
    : undefined;

// A book's stored text is stale when it was produced by a different extraction engine than this
// build — a NEWER one, or one we rolled back FROM. A code rollback never rewrites already-stored
// text, and the source cache key is shared across engine versions, so without this check a
// rollback keeps serving (and rendering) text whose block structure / sentinels this build can't
// interpret. Applies to PDF and EPUB (both carry a version); TXT/HTML carry none and are never stale.
export const isStaleExtraction = (
  sourceKind: string | undefined,
  sourceExtractorVersion: string | undefined,
): boolean => {
  const expected = expectedExtractorVersion(sourceKind);
  return expected !== undefined && sourceExtractorVersion !== expected;
};

// Back-compat alias (PDF-only historical name) — same generalized check.
export const isStalePdfExtraction = isStaleExtraction;
