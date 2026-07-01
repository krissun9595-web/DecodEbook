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
  text = text.replace(/[\uE010-\uE013]/g, '');
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
      if (index === 0) return entry.text;
      // Each note entry is its OWN paragraph. pdf.js has no explicit paragraph mark, so the
      // extractor INFERS paragraphs from geometry (a wrapped line that fills the measure joins; a
      // short line / new "N." marker / indent change is a hard break) and already separates the
      // notes into blocks. Join entries with a HARD break ('\n\n') to PRESERVE that: a single '\n'
      // is read by the reader's paragraph model as a soft-wrap and FLOWS adjacent notes into one
      // block (notes 80 and 81 ran together).
      return `${result}\n\n${entry.text}`;
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

  while (remaining.length > 0) {
    // The raw offset that holds ~targetSize of *visible* text. For normal chapters
    // (measureVisible off) this is just targetSize.
    const limit = measureVisible ? visibleAwareLimit(remaining, targetSize) : targetSize;
    if (remaining.length <= limit) {
      const pageText = remaining.trim();
      if (pageText) {
        pages.push({ mode: 'plain', text: pageText, blocks: [{ type: 'paragraph', text: pageText }] });
      }
      break;
    }
    let splitIdx = limit;
    const paragraphBreak = remaining.lastIndexOf('\n\n', limit);
    const lineBreak = preferLineBreaks ? remaining.lastIndexOf('\n', limit) : -1;
    if (paragraphBreak > limit * 0.7) {
      splitIdx = paragraphBreak;
    } else if (lineBreak > limit * 0.5) {
      // List items (notes, index entries) are their own lines — break between them
      // rather than mid-item.
      splitIdx = lineBreak;
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
    }
    const pageText = remaining.substring(0, splitIdx).trim();
    if (pageText) {
      pages.push({ mode: 'plain', text: pageText, blocks: [{ type: 'paragraph', text: pageText }] });
    }
    remaining = remaining.substring(splitIdx).trim();
  }
  return pages;
};

export const paginateReaderText = (
  text: string,
  targetSize: number,
  options: Omit<ReaderPaginationOptions, 'targetSize'> = {}
): ReaderPage[] => {
  return detectPrincipleTopicPages(text, { ...options, targetSize }) || paginatePlainText(text, targetSize, options.measureVisibleLength, options.preferLineBreaks);
};
