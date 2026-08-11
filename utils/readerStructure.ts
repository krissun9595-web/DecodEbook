export type ReaderPageMode = 'plain' | 'principle-topic';

export interface ReaderParagraphBlock {
  type: 'paragraph';
  text: string;
}

export interface ReaderTopicBlock {
  type: 'principle-topic';
  number: string;
  title: string;
  headingText: string;
  principleLabel: string;
  principle: string;
  interpretationLabel: string;
  interpretation: string;
  rawText: string;
}

export type ReaderBlock = ReaderParagraphBlock | ReaderTopicBlock;

export interface ReaderPage {
  mode: ReaderPageMode;
  text: string;
  blocks: ReaderBlock[];
  label?: string;
  // True when this page begins in the MIDDLE of a paragraph — pagination had to split a paragraph
  // that alone exceeds a page, so its first paragraph is a continuation and must render flush (no
  // first-line indent) rather than as a new paragraph.
  continuesParagraph?: boolean;
}

interface TopicHeading {
  lineIndex: number;
  endLineIndex: number;
  startOffset: number;
  number: string;
  title: string;
  headingText: string;
}

interface SectionLabel {
  kind: 'principle' | 'interpretation';
  label: string;
  inlineText: string;
}

interface ParsedTopic extends ReaderTopicBlock {
  startOffset: number;
  lineIndex: number;
}

interface ReaderPaginationOptions {
  topicsPerPage?: number;
  minTopicCount?: number;
  targetSize?: number;
  leadingHeading?: string;
  // Size pages by rendered (visible) length, excluding hidden link hrefs. Needed
  // for link-dense chapters (e.g. an index) where the (...) part of [label](href)
  // would otherwise eat the page budget and leave pages mostly empty.
  measureVisibleLength?: boolean;
  // Prefer breaking pages at line (\n) boundaries. For list-like chapters (notes,
  // index) each item is its own line, so this keeps items intact instead of
  // splitting one mid-way at a sentence/soft break (e.g. inside "op. cit." or after
  // an initial like "V.H.").
  preferLineBreaks?: boolean;
}

const DEFAULT_TOPICS_PER_PAGE = 10;
const DEFAULT_MIN_TOPIC_COUNT = 3;
const LABEL_SCAN_LINE_LIMIT = 80;
const TOPIC_HEADING_RE =
  /^(?:#{1,6}\s*)?(?:(?:topic|day|lesson)\s+)?(\d{1,3})[\).:\-–—|]\s+(.+)$/iu;
const TOPIC_WORD_HEADING_RE =
  /^(?:#{1,6}\s*)?(?:topic|day|lesson)\s+(\d{1,3})\s+(.+)$/iu;
const NUMBER_ONLY_HEADING_RE = /^(?:#{1,6}\s*)?(\d{1,3})[\).:\-–—|]?\s*$/u;
const TOC_ENTRY_RE = /(?:\.{2,}|[\t ]{2,})\s*\d+\s*$/;
const PAGE_MARKER_AT_OFFSET_RE = /^\[\[PAGE\s+\d+\]\]/i;
const NOTE_ENTRY_MARKER_RE = /(^|[\n \t\u00a0])((?:\[\s*([0-9ivxlcdm]{1,8})[.)]?\s*\]\s*\([^)]+\)|\[\s*([0-9ivxlcdm]{1,8})[.)]?\s*\]|(?:no\.?|note)\s*([0-9ivxlcdm]{1,8})[.)]?|(\d{1,3})[.)]?))(?=(?:[.)])?[\s\u00a0]+(?:[\p{Lu}“"‘'\[]|\*))/giu;

const cleanLine = (value: string): string =>
  value
    .replace(/^(?:#{1,6}\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();

const countWords = (value: string): number =>
  value.trim().split(/\s+/).filter(Boolean).length;

const looksLikeTopicTitle = (value: string): boolean => {
  const clean = cleanLine(value);
  const words = countWords(clean);
  if (!clean || clean.length > 140 || words > 18 || TOC_ENTRY_RE.test(clean)) return false;
  if (parseSectionLabel(clean)) return false;
  if (/^[\d\W_]+$/u.test(clean)) return false;
  if (/^(?:contents|table of contents|principle|interpretation)$/iu.test(clean)) return false;
  if (/\b(?:ibid|op\.\s*cit|https?:\/\/|www\.)/iu.test(clean)) return false;
  if (/^\p{Ll}/u.test(clean)) return false;
  if (/[.!?。！？]$/.test(clean) && words > 6) return false;
  return true;
};

const parseSectionLabel = (line: string): SectionLabel | null => {
  const clean = cleanLine(line);
  const match = clean.match(/^(?:the\s+)?(principle|interpretation)\s*([:.\-–—])?\s*(.*)$/iu);
  if (!match) return null;

  const delimiter = match[2] || '';
  const inlineText = (match[3] || '').trim();
  if (!delimiter && inlineText) return null;

  const kind = match[1].toLowerCase() as 'principle' | 'interpretation';
  const label = kind === 'principle' ? 'Principle' : 'Interpretation';
  return { kind, label, inlineText };
};

const nextNonEmptyLine = (
  lines: string[],
  fromIndex: number,
  maxDistance: number
): { index: number; text: string } | null => {
  for (let i = fromIndex; i < lines.length && i <= fromIndex + maxDistance; i++) {
    const text = cleanLine(lines[i]);
    if (text) return { index: i, text };
  }
  return null;
};

const parseTopicHeading = (
  lines: string[],
  lineStarts: number[],
  index: number
): TopicHeading | null => {
  const line = cleanLine(lines[index]);
  if (!line || parseSectionLabel(line)) return null;

  const direct = line.match(TOPIC_HEADING_RE) || line.match(TOPIC_WORD_HEADING_RE);
  if (direct) {
    const title = cleanLine(direct[2]);
    if (!looksLikeTopicTitle(title)) return null;
    return {
      lineIndex: index,
      endLineIndex: index,
      startOffset: lineStarts[index],
      number: direct[1],
      title,
      headingText: line,
    };
  }

  const numberOnly = line.match(NUMBER_ONLY_HEADING_RE);
  if (!numberOnly) return null;

  const titleLine = nextNonEmptyLine(lines, index + 1, 2);
  if (!titleLine || !looksLikeTopicTitle(titleLine.text)) return null;

  return {
    lineIndex: index,
    endLineIndex: titleLine.index,
    startOffset: lineStarts[index],
    number: numberOnly[1],
    title: titleLine.text,
    headingText: [line, titleLine.text].join('\n'),
  };
};

const firstNonEmptyLine = (text: string): string => {
  for (const line of text.split('\n')) {
    const clean = cleanLine(line);
    if (clean) return clean;
  }
  return '';
};

const parseLeadingTopicHeading = (value?: string): string | null => {
  if (!value) return null;
  const clean = cleanLine(value);
  if (!clean) return null;

  const direct = parseTopicHeading([clean], [0], 0);
  if (direct) return direct.headingText;

  const embedded = clean.match(/(?:^|\s)((?:(?:topic|day|lesson)\s+)?\d{1,3}[\).:\-–—|]\s+[^|]{2,140})/iu);
  if (!embedded) return null;

  const candidate = cleanLine(embedded[1]);
  return parseTopicHeading([candidate], [0], 0)?.headingText || null;
};

const shouldPrependLeadingHeading = (text: string, leadingHeading?: string): string | null => {
  const heading = parseLeadingTopicHeading(leadingHeading);
  if (!heading) return null;

  const firstLine = firstNonEmptyLine(text);
  if (!firstLine || parseTopicHeading([firstLine], [0], 0)) return null;

  const firstLabel = parseSectionLabel(firstLine);
  return firstLabel?.kind === 'principle' ? heading : null;
};

const findSectionLabels = (
  lines: string[],
  fromLine: number,
  stopLine: number
): { principle: number; interpretation: number } | null => {
  let principle = -1;
  let interpretation = -1;
  const scanEnd = Math.min(stopLine, fromLine + LABEL_SCAN_LINE_LIMIT);

  for (let i = fromLine; i < scanEnd; i++) {
    const label = parseSectionLabel(lines[i]);
    if (!label) continue;
    if (label.kind === 'principle' && principle === -1) {
      principle = i;
    } else if (label.kind === 'interpretation' && principle !== -1) {
      interpretation = i;
      break;
    }
  }

  return principle !== -1 && interpretation !== -1 ? { principle, interpretation } : null;
};

const collectSectionText = (
  lines: string[],
  startLine: number,
  endLine: number,
  label: SectionLabel
): string => {
  const sectionLines: string[] = [];
  if (label.inlineText) sectionLines.push(label.inlineText);
  for (let i = startLine + 1; i < endLine; i++) {
    sectionLines.push(lines[i]);
  }
  return sectionLines.join('\n').trim();
};

const findNextNonEmpty = (lines: string[], fromIndex: number): string => {
  for (let i = fromIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return '';
};

const shouldMergeAcrossBlankLine = (previous: string, next: string): boolean => {
  if (!previous || !next) return false;
  // VERSE: a poem stanza (U+E024 hard line breaks) ends at a real stanza boundary — never merge it into the
  // next stanza/paragraph across the blank line, even when its last line ends mid-sentence (no terminal
  // punctuation), which the prose-wrap merge below would otherwise do.
  if (previous.includes('') || next.includes('')) return false;
  if (/^[\p{Ll},;:)\]}]/u.test(next)) return true;
  return !/[.!?。！？"”')\]}]$/.test(previous);
};

const normalizeReaderText = (value: string): string => {
  const lines = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const paragraphs: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const paragraph = current.join(' ').replace(/\s+/g, ' ').trim();
    if (paragraph) paragraphs.push(paragraph);
    current = [];
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      const previous = current[current.length - 1] || '';
      const next = findNextNonEmpty(lines, index + 1);
      if (shouldMergeAcrossBlankLine(previous, next)) return;
      flush();
      return;
    }
    current.push(line);
  });

  flush();
  return paragraphs.join('\n\n');
};

export const normalizeNotesReaderText = (value: string): string => {
  let text = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Block-role/alignment sentinels (U+E010-E013) prefix a paragraph. The notes' per-chapter
  // "CHAPTER N" section headers are now tagged headings (U+E013) by the notes-header detection,
  // and that leading sentinel makes the section-start regex below AND the footnote resolver's
  // chapter-scoping fail to recognise the header — so notes can't be grouped by chapter and
  // key-less footnotes can't resolve (SOURCE_REQUIRED). Strip them before any detection; the
  // headers still render bold via the reader's isNotesSectionHeadingParagraph wording rule.
  // Range extended to U+E020: newer per-paragraph sentinels \u2014 U+E018 (flush first line), U+E019
  // (block quote), U+E01B\u2013U+E01F (relative font-size TIERS) and U+E020 (right-aligned marker gutter)
  // \u2014 also prefix a note paragraph. Notes are set SMALLER than body, so every note now carries a leading
  // U+E01B (tiny tier) sentinel; a leading sentinel makes NOTE_ENTRY_MARKER_RE (which requires the marker be
  // preceded by newline/space) fail to see "\u00ABE01B\u00BB[1]\u2026", so every note collapsed into one entry
  // (INTRODUCTION + notes 1, 2 merged \u2192 SOURCE_REQUIRED). Strip the whole E010\u2013E020 block. The notes'
  // section headers still render bold via the reader's isNotesSectionHeadingParagraph wording rule, and the
  // note size is uniform in the notes chapter, so dropping the tier here is faithful.
  text = text.replace(/[\uE010-\uE02A]/g, '');
  // Page markers ("[[PAGE n]]") are navigation metadata, not note text. A note that spans
  // a page break carries the next page's marker inline (e.g. "…p. 22. [[PAGE 537]]"), and
  // otherwise the marker leaks to screen, so strip them before section/entry detection.
  text = text.replace(/\[\[PAGE\s+\d+\]\]/gi, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  // Strip the publisher's back-link navigation ("BACK TO NOTE REFERENCE 1") that ends each
  // note: it is an internal link from the note back to its body reference, but because the
  // destination is an EARLIER page the link is dropped upstream, leaving the small-caps
  // label as plain text that leaks after every note. Also handle a still-linked variant.
  text = text
    .replace(/[ \t]*\[?[ \t]*BACK[ \t]+TO[ \t]+(?:NOTE[ \t]+)?REFERENCE[ \t]+\d+[ \t]*\]?(?:[ \t]*\([^)\n]*\))?/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  // De-fragment a multi-line "Chapter N. Title" notes heading. PDF extraction emits each
  // visual line of such a heading as its own emphasis-wrapped paragraph ("*Chapter 4. …
  // Between*", "*…Decline of the…*", "*Nanny State*"); the trailing fragment lacks
  // terminal punctuation, so the heading's first note ("1. …") is read as running text
  // and swallowed by the heading — leaving that note undetectable and unlinkable. When
  // (and only when) such continuation fragments actually follow an emphasis-wrapped
  // heading, fold them back into one clean heading line. A normal single-line heading has
  // no following fragments, so it is left untouched (EPUB note headings are unaffected).
  {
    const isContinuationFragment = (block: string): boolean =>
      /^[*_~].*[*_~]$/u.test(block) &&
      block.length <= 80 &&
      !/^\[?\s*\d{1,3}[.)]/.test(block) &&
      !/[.!?。！？]$/u.test(block.replace(/[*_~]+$/u, ''));
    const blocks = text.split(/\n{2,}/);
    const merged: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i].trim();
      const isEmphasisedHeading =
        /^[*_~]/.test(block) &&
        /^[*_~]{0,2}\s*(?:chapter\s+\d+|afterword|epilogue|prologue|introduction)\b/iu.test(block);
      if (isEmphasisedHeading) {
        const fragments: string[] = [];
        let j = i + 1;
        while (j < blocks.length && isContinuationFragment(blocks[j].trim())) {
          fragments.push(blocks[j].trim());
          j++;
        }
        if (fragments.length > 0) {
          merged.push([block, ...fragments].join(' ').replace(/[*_~]+/g, '').replace(/\s+/g, ' ').trim());
          i = j - 1;
          continue;
        }
      }
      merged.push(blocks[i]);
    }
    text = merged.join('\n\n');
  }
  // A notes section heading often italicizes just the keyword (e.g. "<i>Chapter</i> 5"
  // -> "*Chapter* 5"), and the stray "*" breaks the "chapter <n>" heading detection,
  // so the heading merges into the previous note's line. Unwrap emphasis that wraps
  // only a heading keyword. Section detection still requires a paragraph-start
  // position, so unwrapping a keyword inside note prose can't cause a false split.
  text = text.replace(
    /([*_~]{1,2})(Chapter|Part|Book|Afterword|Epilogue|Prologue|Introduction|Conclusion)\1(?=[\s.:;,]|\d)/giu,
    '$2'
  );
  // A following note number can be glued to the previous note's terminal period
  // (e.g. "Ibid.12.", "op. cit.17.", "Ibid.18.") when flattened from superscript
  // markers. Insert a separating space so the marker is detectable downstream;
  // only act when the digits look like a note start (followed by ".)" + space +
  // an uppercase/quote/marker), so decimals and "p.43" page refs are left alone.
  text = text.replace(
    /([\p{Ll}\p{Lo}"'”’)\]]\.)(\d{1,3}[.)])(?=[\s ]+(?:[\p{Lu}\p{Lo}“"‘'\[]|\*))/gu,
    '$1 $2'
  );
  text = text.replace(
    /(^|[\n \t\u00a0])(\d{1,3})[.)](?=[\p{Lu}“"‘'\[]|\*)/giu,
    '$1$2. '
  );
  // Set off an inline notes section heading ("Chapter 5. Title", "Introduction ...")
  // with blank lines — but only at a real boundary (line start or after sentence-ending
  // punctuation). Requiring the boundary avoids matching these words mid-citation, e.g.
  // the book title "An Introduction to the Principles..." (which would split the title
  // and scramble its italics).
  text = text.replace(
    /(^|\n|[.!?。！？][”"’")\]]?)[ \t]*((?:chapter\s+\d+|afterword|epilogue|prologue|introduction)\.?\s+.{4,180}?)(?=\s+\d{1,3}[.)]\s+)/giu,
    '$1\n\n$2\n\n'
  );
  const collapseNoteEntryText = (source: string): string =>
    source
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  const collapseNoteEntries = (source: string, starts: number[]): string => {
    const sortedStarts = [...new Set(starts)].sort((a, b) => a - b);
    if (sortedStarts.length === 0) return collapseNoteEntryText(source);

    const sectionStartSet = new Set(sectionStarts);
    const entries: Array<{ text: string; type: 'prefix' | 'section' | 'note' }> = [];
    if (sortedStarts[0] > 0) {
      const prefix = collapseNoteEntryText(source.slice(0, sortedStarts[0]));
      if (prefix) entries.push({ text: prefix, type: 'prefix' });
    }

    sortedStarts.forEach((start, index) => {
      const nextStart = sortedStarts[index + 1] ?? source.length;
      const entry = collapseNoteEntryText(source.slice(start, nextStart));
      if (entry) entries.push({ text: entry, type: sectionStartSet.has(start) ? 'section' : 'note' });
    });

    return entries.reduce((result, entry, index) => {
      // A per-chapter section header ("Chapter N. ...") begins on a NEW PAGE in the source (each is its
      // own calibre_pb spine file). Prepend the U+E02A hard-break sentinel so the paginator opens a fresh
      // page before each chapter's notes group -- the section-page-break rule, extended into the Notes.
      const _pb = entry.type === 'section' && index > 0 ? '\uE02A' : '';
      if (index === 0) return `${_pb}${entry.text}`;
      // Each note entry is its OWN paragraph. pdf.js has no explicit paragraph mark, so the
      // extractor INFERS paragraphs from geometry (a wrapped line that fills the measure joins; a
      // short line / new "N." marker / indent change is a hard break) and already separates the
      // notes into blocks. Join entries with a HARD break ('\n\n') to PRESERVE that: a single '\n'
      // is read by the reader's paragraph model as a soft-wrap and FLOWS adjacent notes into one
      // block (notes 80 and 81 ran together).
      return `${result}\n\n${_pb}${entry.text}`;
    }, '');
  };

  const noteMarkerRank = (marker: string): number => {
    const clean = marker.toLowerCase().replace(/[^0-9ivxlcdm]+/gu, '');
    if (/^\d+$/u.test(clean)) return Number(clean);
    const roman: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    let total = 0;
    let previous = 0;
    for (let i = clean.length - 1; i >= 0; i--) {
      const value = roman[clean[i]] || 0;
      total += value < previous ? -value : value;
      previous = Math.max(previous, value);
    }
    return total;
  };
  const followsCitationLabel = (start: number): boolean => {
    // A bare number that directly follows a citation-locator abbreviation is part of the
    // citation, not a note marker: a page ("p./pp. 84"), chapter ("chap. 13 of Leviathan"),
    // number ("no. 5"), volume ("vol. 2"), part/book/section/figure/note/line, etc. Without
    // this, "chap. 13" is misread as note 13 — which both splits the note at the chapter
    // number and, being out of sequence, makes the real next note (3) be dropped. Only the
    // same line counts (no newline), so a genuine next note after a note that happens to end
    // in such an abbreviation is unaffected. Strip emphasis so an italicized label
    // ("*op. cit., p.* 173") is still recognized.
    const before = text.slice(Math.max(0, start - 26), start).replace(/[*_~]/g, '');
    return /(?:^|[\s(,;])(?:pp?|chaps?|nos?|vols?|pts?|bks?|secs?|figs?|arts?|paras?|nn?|ll?)\.\s*$/iu.test(before);
  };
  const stripHeadingDisplayMarkers = (value: string): string =>
    value
      .trim()
      .replace(/^(?:[*_~]\s*)+/, '')
      .replace(/(?:\s*[*_~])+$/u, '')
      .replace(/^(?:#{1,6}\s*)+/, '')
      .trim();
  const looksLikeNoteSectionHeading = (value: string): boolean =>
    /^(?:chapter\s+\d+|afterword|epilogue|prologue|introduction)\b/iu.test(stripHeadingDisplayMarkers(value));
  const followsRunningText = (start: number): boolean => {
    const before = text.slice(0, start).trimEnd();
    if (!before) return false;
    const previousBlock = before.split(/\n{2,}/).pop() || '';
    if (looksLikeNoteSectionHeading(previousBlock)) return false;
    // Allow trailing markdown emphasis markers (e.g. a note ending in an italic
    // term like "*Ibid.*" or "*op. cit.*") to count as sentence-final, so the next
    // note marker is not mistaken for running text and dropped.
    return !/[.!?。！？"”')\]}][*_~]*$/u.test(before);
  };
  const candidates = [...text.matchAll(NOTE_ENTRY_MARKER_RE)]
    .map(match => {
      const prefix = match[1] || '';
      const marker = match[3] || match[4] || match[5] || match[6] || '';
      const number = noteMarkerRank(marker);
      // match[3]/[4] = bracketed "[N]"/"[N](href)" markers. These are explicit note
      // notation, never running prose, so they bypass the page-label and running-text
      // heuristics (which exist only to reject false positives among BARE numbers).
      // match[5] = "no./note N" is NOT treated as explicit: "no. 1" inside a citation
      // ("vol. 1, no. 1") is a journal issue, not a note start, and must still be
      // caught by the running-text guard.
      const isExplicitMarker = Boolean(match[3] || match[4]);
      return {
        number,
        start: (match.index ?? 0) + prefix.length,
        isExplicitMarker,
      };
    })
    .filter(candidate =>
      Number.isFinite(candidate.number) &&
      candidate.number > 0 &&
      (candidate.isExplicitMarker ||
        (!followsCitationLabel(candidate.start) && !followsRunningText(candidate.start)))
    );
  const sectionStarts = [...text.matchAll(/(^|\n{2,})\s*[*_~]*(?:#{1,6}\s*)?((?:chapter\s+\d+|afterword|epilogue|prologue|introduction)\b[^\n*]{0,220})[*_~]*/giu)]
    .map(match => (match.index ?? 0) + match[1].length);

  const ordered = candidates.filter((candidate, index) => {
    if (index === 0) return true;
    const previous = candidates[index - 1];
    const between = text.slice(previous.start, candidate.start);
    return candidate.number > previous.number ||
      candidate.number === 1 ||
      /\n{2,}\s*(?:chapter\s+\d+|afterword|epilogue|prologue|introduction)\b/iu.test(between);
  });
  if (ordered.length < 2) {
    const starts = [
      ...ordered.map(candidate => candidate.start),
      ...sectionStarts,
    ];
    return starts.length > 0 ? collapseNoteEntries(text, starts) : collapseNoteEntryText(text.trim());
  }
  return collapseNoteEntries(text, [
    ...ordered.map(candidate => candidate.start),
    ...sectionStarts,
  ]);
};

const lineStartsFor = (text: string, lines: string[]): number[] => {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
};

const normalizeWithIndexMap = (value: string): { normalized: string; indexMap: number[] } => {
  let normalized = '';
  const indexMap: number[] = [];

  for (let i = 0; i < value.length; i++) {
    const pageMarker = value.slice(i).match(PAGE_MARKER_AT_OFFSET_RE);
    if (pageMarker) {
      i += pageMarker[0].length - 1;
      continue;
    }

    const ch = value[i].toLowerCase();
    if (/[\p{L}\p{N}]/u.test(ch)) {
      normalized += ch;
      indexMap.push(i);
    }
  }

  return { normalized, indexMap };
};

export const findTopicHeadingBeforeOffset = (
  sourceText: string,
  offset: number,
  lookbehind = 1600
): string | null => {
  if (!sourceText || offset <= 0) return null;

  const start = Math.max(0, offset - lookbehind);
  const excerpt = sourceText
    .slice(start, offset)
    .replace(/\[\[PAGE\s+\d+\]\]/g, '\n');
  const lines = excerpt.split('\n');
  const lineStarts = lineStartsFor(excerpt, lines);

  for (let i = lines.length - 1; i >= 0; i--) {
    const heading = parseTopicHeading(lines, lineStarts, i);
    if (heading) return heading.headingText;
  }

  return null;
};

export const findTopicHeadingAtOffset = (
  sourceText: string,
  offset: number,
  lookahead = 240
): string | null => {
  if (!sourceText || offset < 0) return null;

  const excerpt = sourceText
    .slice(offset, Math.min(sourceText.length, offset + lookahead))
    .replace(/\[\[PAGE\s+\d+\]\]/g, '\n');
  const lines = excerpt.split('\n');
  const lineStarts = lineStartsFor(excerpt, lines);

  for (let i = 0; i < Math.min(lines.length, 4); i++) {
    const heading = parseTopicHeading(lines, lineStarts, i);
    if (heading) return heading.headingText;
  }

  return null;
};

export const findTopicHeadingForExtractedText = (
  sourceText: string,
  extractedText: string
): string | null => {
  if (!sourceText || !extractedText) return null;

  const cleanExtracted = extractedText.replace(/\[\[PAGE\s+\d+\]\]/g, '\n').trim();
  const firstLine = firstNonEmptyLine(cleanExtracted);
  if (parseSectionLabel(firstLine)?.kind !== 'principle') return null;

  const source = normalizeWithIndexMap(sourceText);
  const extracted = normalizeWithIndexMap(cleanExtracted);
  const query = extracted.normalized.slice(0, 220);
  if (query.length < 40) return null;

  const normalizedOffset = source.normalized.indexOf(query);
  if (normalizedOffset === -1) return null;

  const sourceOffset = source.indexMap[normalizedOffset];
  return (
    findTopicHeadingAtOffset(sourceText, sourceOffset) ||
    findTopicHeadingBeforeOffset(sourceText, sourceOffset)
  );
};

const buildTopicBlock = (
  text: string,
  lines: string[],
  heading: TopicHeading,
  nextStartOffset: number,
  nextLineIndex: number
): ParsedTopic | null => {
  const labels = findSectionLabels(lines, heading.endLineIndex + 1, nextLineIndex);
  if (!labels) return null;

  const principleLabel = parseSectionLabel(lines[labels.principle]);
  const interpretationLabel = parseSectionLabel(lines[labels.interpretation]);
  if (!principleLabel || !interpretationLabel) return null;

  const principle = normalizeReaderText(collectSectionText(lines, labels.principle, labels.interpretation, principleLabel));
  const interpretation = normalizeReaderText(collectSectionText(lines, labels.interpretation, nextLineIndex, interpretationLabel));
  if (!principle || !interpretation) return null;

  const rawText = [
    normalizeReaderText(heading.headingText),
    principleLabel.label,
    principle,
    interpretationLabel.label,
    interpretation,
  ].join('\n\n').trim();

  return {
    type: 'principle-topic',
    number: heading.number,
    title: heading.title,
    headingText: heading.headingText,
    principleLabel: principleLabel.label,
    principle,
    interpretationLabel: interpretationLabel.label,
    interpretation,
    rawText,
    startOffset: heading.startOffset,
    lineIndex: heading.lineIndex,
  };
};

export const detectPrincipleTopicPages = (
  rawText: string,
  options: ReaderPaginationOptions = {}
): ReaderPage[] | null => {
  let text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return null;

  const leadingHeading = shouldPrependLeadingHeading(text, options.leadingHeading);
  if (leadingHeading) {
    text = `${leadingHeading}\n${text}`;
  }

  const lines = text.split('\n');
  const lineStarts = lineStartsFor(text, lines);
  const headings: TopicHeading[] = [];

  for (let i = 0; i < lines.length; i++) {
    const heading = parseTopicHeading(lines, lineStarts, i);
    if (!heading) continue;
    headings.push(heading);
    i = Math.max(i, heading.endLineIndex);
  }

  if (headings.length < (options.minTopicCount ?? DEFAULT_MIN_TOPIC_COUNT)) return null;

  const validHeadings = headings.filter((heading, index) => {
    const nextHeading = headings[index + 1];
    return Boolean(findSectionLabels(lines, heading.endLineIndex + 1, nextHeading?.lineIndex ?? lines.length));
  });

  const topics: ParsedTopic[] = [];
  validHeadings.forEach((heading, index) => {
    const nextHeading = validHeadings[index + 1];
    const topic = buildTopicBlock(
      text,
      lines,
      heading,
      nextHeading?.startOffset ?? text.length,
      nextHeading?.lineIndex ?? lines.length
    );
    if (topic) topics.push(topic);
  });

  if (topics.length < (options.minTopicCount ?? DEFAULT_MIN_TOPIC_COUNT)) return null;

  const maxTopicsPerPage = Math.max(1, options.topicsPerPage ?? DEFAULT_TOPICS_PER_PAGE);
  const targetSize = options.targetSize && options.targetSize > 0
    ? options.targetSize
    : Number.POSITIVE_INFINITY;
  const pages: ReaderPage[] = [];
  const prefix = normalizeReaderText(text.slice(0, topics[0].startOffset).trim());

  let blocks: ReaderBlock[] = [];
  let textParts: string[] = [];
  let group: ParsedTopic[] = [];

  const flushPage = () => {
    if (group.length === 0 && blocks.length === 0) return;
    const first = group[0];
    const last = group[group.length - 1];
    const label = first && last
      ? first.number === last.number
        ? `Topic ${first.number}`
        : `Topics ${first.number}-${last.number}`
      : undefined;

    pages.push({
      mode: 'principle-topic',
      text: textParts.join('\n\n').trim(),
      blocks,
      label,
    });
    blocks = [];
    textParts = [];
    group = [];
  };

  if (prefix) {
    blocks.push({ type: 'paragraph', text: prefix });
    textParts.push(prefix);
  }

  for (const topic of topics) {
    const nextTextLength = textParts.join('\n\n').length + (textParts.length ? 2 : 0) + topic.rawText.length;
    if (
      group.length > 0 &&
      (group.length >= maxTopicsPerPage || nextTextLength > targetSize)
    ) {
      flushPage();
    }

    const { startOffset, lineIndex, ...block } = topic;
    blocks.push(block);
    textParts.push(topic.rawText);
    group.push(topic);
  }

  flushPage();

  return pages.length > 0 ? pages : null;
};

// Raw offset at which the visible (rendered) length of `value` reaches
// `visibleTarget`, counting only the label of [label](href) links, not the hidden
// href. Single forward pass (sticky regex), so it stays O(n).
const visibleAwareLimit = (value: string, visibleTarget: number): number => {
  const linkRe = /\[([^\]\n]*)\]\(([^)\n]+)\)/y;
  let visible = 0;
  let i = 0;
  while (i < value.length) {
    linkRe.lastIndex = i;
    const match = linkRe.exec(value);
    if (match) {
      visible += match[1].length;
      i = linkRe.lastIndex;
    } else {
      visible += 1;
      i += 1;
    }
    if (visible >= visibleTarget) return i;
  }
  return value.length;
};

export const paginatePlainText = (text: string, targetSize: number, measureVisible = false, preferLineBreaks = false): ReaderPage[] => {
  const pages: ReaderPage[] = [];
  // Trim page-boundary whitespace but KEEP a leading NBSP run — it encodes a geometry-derived block
  // indent (a block quote/epigraph/definition description sitting deeper than the body margin) that the
  // reader turns into left padding. A plain .trim() here strips the paragraph-separator "\n\n" AND the
  // NBSP together, so a block-indented paragraph that happens to fall at a reader PAGE BREAK silently
  // lost its indent (Kurzweil "The study is to proceed…" rendered flush only because the page split
  // landed right before it). Strip leading whitespace EXCEPT NBSP; trailing whitespace goes fully.
  const trimPageText = (v: string): string => v.replace(/^[^\S ]+/u, '').replace(/\s+$/u, '');
  let remaining = text;
  const endsWithDetachedNoteMarker = (value: string): boolean =>
    /(?:^|\n)\s*(?:\[[0-9ivxlcdm]{1,8}[.)]?\]\([^)]+\)|\[[0-9ivxlcdm]{1,8}[.)]?\]|(?:no\.?|note)\s*[0-9ivxlcdm]{1,8}[.)]?|[0-9ivxlcdm]{1,8})[.)]?$/iu.test(value.trimEnd());

  const findSafeSentenceBreak = (value: string, limit: number): number => {
    const slice = value.slice(0, limit + 1);
    const matches = [...slice.matchAll(/[.!?]\s+/g)];
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const punctuationIndex = match.index ?? -1;
      if (punctuationIndex < 0) continue;
      const before = slice.slice(0, punctuationIndex).trim();
      const lastToken = before.split(/\s+/).pop() || '';
      if (endsWithDetachedNoteMarker(before)) continue;
      if (/^[A-Z]$/u.test(lastToken)) continue;
      if (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Gen|Gov|Sgt|Cpl|Pvt|Rev|Vol|Vols|Dept|Est|Inc|Ltd|Corp|vs|etc|approx|e\.g|i\.e|al|fig|no|op|ch|pt|p|pp|ed|eds|trans|repr|cf|ca)$/iu.test(lastToken)) continue;
      return punctuationIndex + 1;
    }
    return -1;
  };

  const findNearForwardSentenceBreak = (value: string, limit: number): number => {
    const lookahead = Math.min(360, Math.max(80, Math.floor(limit * 0.25)));
    const max = Math.min(value.length, limit + lookahead);
    const slice = value.slice(limit, max);
    const match = slice.match(/[.!?]\s+/);
    if (!match || typeof match.index !== 'number') return -1;

    const punctuationIndex = limit + match.index;
    const before = value.slice(0, punctuationIndex).trim();
    const lastToken = before.split(/\s+/).pop() || '';
    if (endsWithDetachedNoteMarker(before)) return -1;
    if (/^[A-Z]$/u.test(lastToken)) return -1;
    if (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Gen|Gov|Sgt|Cpl|Pvt|Rev|Vol|Vols|Dept|Est|Inc|Ltd|Corp|vs|etc|approx|e\.g|i\.e|al|fig|no|op|ch|pt|p|pp|ed|eds|trans|repr|cf|ca)$/iu.test(lastToken)) return -1;
    return punctuationIndex + 1;
  };

  const findSafeSoftBreak = (value: string, limit: number): number => {
    const semicolonBreak = value.lastIndexOf('; ', limit);
    if (semicolonBreak > limit * 0.35) return semicolonBreak + 1;

    let spaceBreak = value.lastIndexOf(' ', limit);
    while (spaceBreak > 0) {
      const candidate = value.slice(0, spaceBreak).trim();
      if (endsWithDetachedNoteMarker(candidate)) {
        spaceBreak = value.lastIndexOf(' ', spaceBreak - 1);
        continue;
      }
      if (!/\b[A-Z]\.$/u.test(candidate)) return spaceBreak;
      spaceBreak = value.lastIndexOf(' ', spaceBreak - 1);
    }
    return -1;
  };

  let continuesParagraph = false; // does the CURRENT page start mid-paragraph (prev split was not a boundary)?
  while (remaining.length > 0) {
    // The raw offset that holds ~targetSize of *visible* text. For normal chapters
    // (measureVisible off) this is just targetSize.
    // A two-column block (U+E014 left U+E015 right) renders as two side-by-side columns, so its
    // RIGHT half adds no height; count only up to U+E015 (the left column) toward the page size, so
    // a two-column block stays on the same page as the intro that precedes it instead of being
    // pushed to the next page by its full character count.
    const computeLimit = (value: string, target: number): number => {
      const linkRe = /\[([^\]\n]*)\]\(([^)\n]+)\)/y;
      let eff = 0, i = 0;
      // Weight each character by its RENDERED size²: font-size scales BOTH char width AND line height,
      // so a page of smaller text holds ~1/size² more characters. A 0.86em footnote (U+E01C) char thus
      // costs ~0.74 of a body char, letting a mixed body+footnote page FILL instead of leaving a blank
      // band. Only SHRINK tiers are down-weighted; larger tiers stay 1.0 — a one-line heading doesn't
      // fill the width, so s² would over-count its (single-line) height. Reset per paragraph (\n\n); a
      // paragraph's lead size sentinel sets its weight (body paragraphs carry none → 1.0). The Notes
      // chapter is scaled separately (its 0.83em is a render override with no sentinel here).
      let wsq = 1;
      while (i < value.length) {
        // A figure marker renders as a tall image with ~no text — count a virtual length so a page
        // budgets for its height (else a full page of text plus a figure overflows the viewport).
        if (value.startsWith('[[FIG', i)) { const fe = value.indexOf(']]', i); i = fe < 0 ? value.length : fe + 2; eff += 500; if (eff >= target) return i; continue; }
        if (value[i] === '\n' && value[i + 1] === '\n') { wsq = 1; eff += 2; i += 2; if (eff >= target) return i; continue; }
        if (value[i] === '') { wsq = 0.72 * 0.72; i += 1; continue; } // 0.72em tier
        if (value[i] === '') { wsq = 0.86 * 0.86; i += 1; continue; } // 0.86em tier (footnotes)
        if (value[i] === '') { const be = value.indexOf('\n\n', i); i = be < 0 ? value.length : be; continue; }
        if (measureVisible) { linkRe.lastIndex = i; const m = linkRe.exec(value); if (m) { eff += m[1].length * wsq; i = linkRe.lastIndex; if (eff >= target) return i; continue; } }
        eff += wsq; i += 1;
        if (eff >= target) return i;
      }
      return value.length;
    };
    const limit = computeLimit(remaining, targetSize);
    // HARD PAGE-BREAK sentinel (U+E02A): a heading the SOURCE begins on a new page (a major structural
    // division). Force this reader page to end right before it so the section always opens a fresh page,
    // regardless of remaining space. Only act when the break falls within this page's budget; a break
    // farther down is handled once it reaches the top on a later iteration.
    const pbAt = remaining.indexOf('');
    if (pbAt >= 0 && pbAt <= limit) {
      const beforeVisible = remaining.slice(0, pbAt).replace(/[\s-]/gu, '');
      const beforeTrim = remaining.slice(0, pbAt).trim();
      // EC1: the marker is already at the page top (only whitespace/sentinels precede it) → just drop it,
      // no blank page. EC2: the page so far holds ONLY a heading (adjacent section-starts) → don't strand
      // it on its own page; keep the sections together and let the first break stand.
      const beforeHeadingOnly = beforeTrim.length > 0 && !beforeTrim.includes('\n\n') && /[-]/u.test(beforeTrim.slice(0, 8));
      if (beforeVisible.length === 0 || beforeHeadingOnly) {
        remaining = remaining.slice(0, pbAt) + remaining.slice(pbAt + 1);
        continue;
      }
      const pageText = trimPageText(remaining.slice(0, pbAt));
      if (pageText) pages.push({ mode: 'plain', text: pageText, blocks: [{ type: 'paragraph', text: pageText }], continuesParagraph });
      continuesParagraph = false;
      remaining = trimPageText(remaining.slice(pbAt + 1)); // drop the marker; the next page opens with the heading
      continue;
    }
    if (remaining.length <= limit) {
      const pageText = trimPageText(remaining);
      if (pageText) {
        pages.push({ mode: 'plain', text: pageText, blocks: [{ type: 'paragraph', text: pageText }], continuesParagraph });
      }
      break;
    }
    let splitIdx = limit;
    // Track whether we break at a real boundary (a blank-line paragraph break, or a line break
    // between list items) vs. MID-paragraph (a sentence/space split of an oversized paragraph). Only
    // the latter makes the next page a continuation.
    let brokeAtBoundary = false;
    const paragraphBreak = remaining.lastIndexOf('\n\n', limit);
    const lineBreak = preferLineBreaks ? remaining.lastIndexOf('\n', limit) : -1;
    // The paragraph the limit falls inside starts at paragraphBreak. If it fits on a page by itself,
    // push it WHOLE to the next page (break before it) instead of splitting it mid-sentence — a mid-
    // paragraph page break reads as a spurious new paragraph. Only split a paragraph mid-way when it
    // alone exceeds a page. (The 0.7 branch already keeps this from wasting much space; the fits-check
    // extends it down to half a page so a normal-length paragraph is kept intact.)
    let splitParaFits = false;
    if (paragraphBreak > 0) {
      const nextBreak = remaining.indexOf('\n\n', paragraphBreak + 2);
      splitParaFits = ((nextBreak < 0 ? remaining.length : nextBreak) - (paragraphBreak + 2)) <= targetSize;
    }
    // A FIGURE before this paragraph on the page already fills the page (it counts as ~500 virtual
    // chars toward the limit, which also pushes `limit` far to the right — so the char-based
    // paragraphBreak/limit ratio below reads far too small and the keep-whole branch mis-fires,
    // splitting the paragraph mid-sentence). When a figure precedes a paragraph that fits on a page,
    // break BEFORE it: the figure keeps the current page full and the paragraph stays whole on the next.
    const figureBeforeParagraph = paragraphBreak > 0 && remaining.slice(0, paragraphBreak).includes('[[FIG');
    // Keep every completed paragraph WHOLE: break at the last paragraph boundary whenever it leaves the
    // page at least ~40% full. This lower floor (vs the old 0.7 / 0.5+fits heuristic) means a normal
    // paragraph is never split mid-line — it moves whole to the next page, at the cost of some bottom
    // whitespace. Below the floor a very large paragraph starts early on the page; splitting it mid-way
    // avoids a mostly-blank page. A paragraph that alone exceeds a page (no earlier boundary at all)
    // also splits mid-way — but as the FIRST paragraph of its page, never a partial line after others.
    const keepWholeFloor = limit * 0.4;
    if (paragraphBreak > keepWholeFloor || (figureBeforeParagraph && splitParaFits)) {
      splitIdx = paragraphBreak;
      brokeAtBoundary = true; // a blank-line paragraph boundary
    } else if (lineBreak > limit * 0.5) {
      // List items (notes, index entries) are their own lines — break between them
      // rather than mid-item.
      splitIdx = lineBreak;
      brokeAtBoundary = true; // between list items — a clean item boundary
    } else {
      const sentenceBreak = findSafeSentenceBreak(remaining, limit);
      if (sentenceBreak > limit * 0.5) splitIdx = sentenceBreak + 1;
      else {
        const forwardSentenceBreak = findNearForwardSentenceBreak(remaining, limit);
        if (forwardSentenceBreak > 0) splitIdx = forwardSentenceBreak + 1;
        else {
          const spaceBreak = findSafeSoftBreak(remaining, limit);
          if (spaceBreak > 0) splitIdx = spaceBreak;
        }
      }
      // brokeAtBoundary stays false — this split is inside a paragraph.
    }
    const pageText = trimPageText(remaining.substring(0, splitIdx));
    if (pageText) {
      pages.push({ mode: 'plain', text: pageText, blocks: [{ type: 'paragraph', text: pageText }], continuesParagraph });
    }
    continuesParagraph = !brokeAtBoundary; // the NEXT page continues the paragraph iff we split inside one
    const _nextRemaining = trimPageText(remaining.substring(splitIdx));
    if (continuesParagraph && _nextRemaining) {
      // Carry the split paragraph's SIZE tier (and alignment) sentinel onto the continuation page: a small
      // footnote / a heading that wraps across a reader page keeps its size, instead of the continuation
      // rendering at default body size (its leading sentinel stayed on the first page).
      const _firstPortion = remaining.substring(0, splitIdx);
      const _pStart = _firstPortion.lastIndexOf('\n\n');
      const _lead = _firstPortion.slice(_pStart < 0 ? 0 : _pStart + 2).match(/^[\uE010-\uE023]+/u)?.[0] || '';
      const _carry = (_lead.match(/[\uE01B-\uE01F]/u)?.[0] || '') + (_lead.match(/[\uE010\uE011]/u)?.[0] || '');
      remaining = _carry + _nextRemaining;
    } else {
      remaining = _nextRemaining;
    }
  }
  return pages;
};

export const paginateReaderText = (
  text: string,
  targetSize: number,
  options: Omit<ReaderPaginationOptions, 'targetSize'> = {}
): ReaderPage[] => {
  // The structured (principle-topic) paginator can't consume the U+E02A hard-break sentinel, so strip
  // it for that branch only; the prose paginator below acts on it.
  const _structured = detectPrincipleTopicPages(text.replace(//g, ''), { ...options, targetSize });
  if (_structured) return _structured;
  return paginatePlainText(text, targetSize, options.measureVisibleLength, options.preferLineBreaks);
};

// Baseline char budget per page (SSR / no-DOM fallback only). ~2500 chars fills ~700px of readable
// FULL-WIDTH prose at 'base'/'normal' — the old 1600 undershot by ~35%, leaving that fraction of every
// page blank. The live path below measures the real zone and ignores this.
export const DEFAULT_PAGE_TARGET_SIZE = 2500;

// One reusable canvas to measure the average rendered width of a character in the reader's ACTUAL
// font — far more accurate than a fixed chars-per-line guess.
let __measureCanvas: HTMLCanvasElement | null = null;
const CHAR_SAMPLE =
  'the quick brown fox jumps over a lazy dog and then some more ordinary english prose to average out letter widths across a line';
const measureAvgCharWidth = (font: string): number => {
  try {
    if (typeof document === 'undefined') return 0;
    if (!__measureCanvas) __measureCanvas = document.createElement('canvas');
    const ctx = __measureCanvas.getContext('2d');
    if (!ctx) return 0;
    ctx.font = font;
    const w = ctx.measureText(CHAR_SAMPLE).width;
    return w > 0 ? w / CHAR_SAMPLE.length : 0;
  } catch { return 0; }
};

// Chars-per-page. PREFERRED path: measure the reader's ACTUAL page zone — the real text-column width
// (max-w-3xl in single view, w-1/2 in split), the visible height, the real font/line-height, letter
// spacing — so the budget equals what genuinely fits. This adapts exactly to window size, browser
// ZOOM (all measured in CSS px), split view, text size and leading, with no magic constant. Falls back
// to a viewport estimate only when the reader isn't mounted (e.g. a search index built before render).
// SHARED by the reader AND the search index so their "PG.NN" page numbers agree — both call this and,
// when the reader is on screen, both read the same DOM and get the same size.
let lastGoodPageTargetSize: number | null = null; // last size from a REAL measurement (survives 0×0 blinks)
export const computePageTargetSize = (textSize: string, lineHeight: string): number => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return DEFAULT_PAGE_TARGET_SIZE;
  const zone = document.querySelector('[data-reader-zone]') as HTMLElement | null;
  // Prefer the always-present, zero-height probe (stable width, present before the page renders); fall back
  // to a rendered line div only if the probe is missing. The line divs are conditionally rendered and can
  // be a transient narrow width mid-render, which produced a broken page count that then stuck.
  const textEl = (document.querySelector('[data-reader-measure]') || document.querySelector('[data-reader-text]')) as HTMLElement | null;
  if (zone && textEl && zone.clientHeight > 0 && textEl.clientWidth > 0) {
    const zcs = getComputedStyle(zone);
    // Usable text height: the scroll viewport minus its top padding and its bottom clearance
    // (pb-32, reserved for the fixed player bar) — i.e. the band a page's text can actually occupy.
    const visibleH = zone.clientHeight - parseFloat(zcs.paddingTop || '0') - parseFloat(zcs.paddingBottom || '0');
    const tcs = getComputedStyle(textEl);
    const padX = parseFloat(tcs.paddingLeft || '0') + parseFloat(tcs.paddingRight || '0');
    const textW = textEl.clientWidth - padX;
    const fontSizePx = parseFloat(tcs.fontSize || '16') || 16;
    const lineHeightPx = parseFloat(tcs.lineHeight || '0') || fontSizePx * 1.5;
    const ls = parseFloat(tcs.letterSpacing || '0'); // 'normal' -> NaN
    const font = `${tcs.fontStyle || 'normal'} ${tcs.fontWeight || '400'} ${tcs.fontSize || '16px'} ${tcs.fontFamily || 'serif'}`;
    const avgCharW = measureAvgCharWidth(font) + (Number.isNaN(ls) ? 0 : ls);
    if (visibleH > 0 && textW > 0 && lineHeightPx > 0 && avgCharW > 0) {
      const charsPerLine = textW / avgCharW;
      const linesPerPage = visibleH / lineHeightPx;
      // 0.94: small headroom for inter-paragraph gaps (vertical space the character count can't see)
      // so a full page doesn't spill into a scrollbar. Fills ~94% vs the old ~63%.
      const size = Math.round(charsPerLine * linesPerPage * 0.94);
      const clamped = Math.min(6000, Math.max(500, size));
      lastGoodPageTargetSize = clamped;
      return clamped;
    }
  }
  // The zone/probe couldn't be measured — the reader zone momentarily collapses to 0×0 during a re-render
  // (chapter switch, view toggle), and the per-line probe fallback can be absent. Reuse the LAST REAL
  // measurement instead of a full-width viewport estimate: otherwise the pagination (and every page
  // number, incl. the search results) flips between the measured value and this estimate — e.g. in split
  // view, half-width 160 pages ↔ full-width 47 pages — every time the zone blinks to 0. Only fall to the
  // estimate before any measurement has ever succeeded.
  if (lastGoodPageTargetSize != null) return lastGoodPageTargetSize;
  const readable = Math.max(360, window.innerHeight - 170); // minus header + reader controls chrome
  const sizeFactor: Record<string, number> = { sm: 1.22, base: 1, lg: 0.82, xl: 0.66 };
  const lineFactor: Record<string, number> = { tight: 1.12, normal: 1, relaxed: 0.9, loose: 0.82 };
  const scaled = (readable / 700) * DEFAULT_PAGE_TARGET_SIZE * (sizeFactor[textSize] ?? 1) * (lineFactor[lineHeight] ?? 1);
  return Math.round(Math.min(6000, Math.max(1100, scaled)));
};
