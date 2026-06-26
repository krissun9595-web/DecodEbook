import { Chapter, PdfOutlineItem } from '../types';

const PAGE_MARKER_RE = /\[\[PAGE\s+(\d+)\]\]/g;
const TITLE_PREFIX_RE = /^(?:chapter|ch\.?|part|section|book|volume|vol\.?)\s+[\p{L}\p{N}ivxlcdm.-]+\s*[:.\-—]?\s*/iu;
const MARKDOWN_PREFIX_RE = /^(?:#{1,6}\s*)+/;
const NUMBERED_TOPIC_HEADING_RE =
  /^(?:#{1,6}\s*)?(?:(?:topic|day|lesson)\s+)?\d{1,3}[\).:\-–—|]\s+\S/iu;
const PRINCIPLE_BODY_START_RE = /^(?:(?:\s+)|(?:\[\[PAGE\s+\d+\]\]))*Principle\b/iu;
const TOPIC_RANGE_RE =
  /(?:^|[^\p{N}])(?:(?:topics?|days?|lessons?|principles?)\s*)?(\d{1,3})\s*(?:-|–|—|to)\s*(\d{1,3})(?:[^\p{N}]|$)/iu;
const MIN_ACCEPTED_CANDIDATE_SCORE = 35;
const TOPIC_HEADING_RE =
  /^(?:#{1,6}\s*)?(?:(?:topic|day|lesson)\s+)?(\d{1,3})[\).:\-–—|]\s+(.+)$/iu;
const TOPIC_WORD_HEADING_RE =
  /^(?:#{1,6}\s*)?(?:topic|day|lesson)\s+(\d{1,3})\s+(.+)$/iu;
const NUMBER_ONLY_TOPIC_RE = /^(?:#{1,6}\s*)?(\d{1,3})[\).:\-–—|]?\s*$/u;
const TOPIC_SECTION_LABEL_RE = /^(?:the\s+)?(principle|interpretation)\s*(?:$|[:.\-–—]\s*\S*)/iu;
const TOPIC_LABEL_SCAN_LIMIT = 80;

type CandidateKind = 'line' | 'normalized' | 'page';

interface PageMarker {
  page: number;
  index: number;
  len: number;
}

interface NormalizedSource {
  value: string;
  indexMap: number[];
}

interface HeadingCandidate {
  headingStart: number;
  headingEnd: number;
  contentStart: number;
  headingText: string;
  variant: string;
  kind: CandidateKind;
  page?: number;
  score: number;
}

interface TopicHeadingMatch {
  number: string;
  title: string;
  headingText: string;
  start: number;
  lineIndex: number;
  endLineIndex: number;
}

const hasSourceRange = (chapter: Chapter): boolean =>
  typeof chapter.sourceStart === 'number' &&
  typeof chapter.sourceEnd === 'number' &&
  chapter.sourceEnd > chapter.sourceStart;

const hasUsableSourceRange = (content: string, chapter: Chapter): boolean =>
  hasSourceRange(chapter) &&
  chapter.sourceStart! >= 0 &&
  chapter.sourceStart! < content.length &&
  chapter.sourceEnd! <= content.length;

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const stripPageMarkers = (value: string): string =>
  value.replace(/\[\[PAGE\s+\d+\]\]\s*/g, '');

const cleanHeadingLine = (value: string): string =>
  stripPageMarkers(value)
    .replace(MARKDOWN_PREFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeForMatch = (value: string): string => {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i].toLowerCase();
    if (/[\p{L}\p{N}]/u.test(ch)) out += ch;
  }
  return out;
};

const buildNormalizedSource = (content: string): NormalizedSource => {
  const indexMap: number[] = [];
  let value = '';
  for (let i = 0; i < content.length; i++) {
    const ch = content[i].toLowerCase();
    if (/[\p{L}\p{N}]/u.test(ch)) {
      value += ch;
      indexMap.push(i);
    }
  }
  return { value, indexMap };
};

const parsePageMarkers = (content: string): PageMarker[] => {
  const markers: PageMarker[] = [];
  for (const match of content.matchAll(/\[\[PAGE\s+(\d+)\]\]/g)) {
    const page = Number(match[1]);
    const index = match.index ?? 0;
    markers.push({ page, index, len: match[0].length });
  }
  return markers;
};

const pageAtIndex = (markers: PageMarker[], index: number): number | undefined => {
  let current: number | undefined;
  for (const marker of markers) {
    if (marker.index > index) break;
    current = marker.page;
  }
  return current;
};

const findMarkerForPage = (markers: PageMarker[], page: number): PageMarker | undefined =>
  markers.find(marker => marker.page >= page);

const skipBlankLines = (content: string, index: number): number => {
  const remainder = content.slice(index);
  const blankPrefix = remainder.match(/^(?:[ \t]*\r?\n)+/);
  return blankPrefix ? index + blankPrefix[0].length : index;
};

const getLineBounds = (
  content: string,
  start: number,
  end: number
): { lineStart: number; lineEnd: number; line: string } => {
  const lineStart = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let lineEnd = content.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = content.length;
  return {
    lineStart,
    lineEnd,
    line: cleanHeadingLine(content.slice(lineStart, lineEnd)),
  };
};

const getMatchedHeadingBounds = (
  content: string,
  match: RegExpExecArray
): { lineStart: number; lineEnd: number; line: string } => {
  const matchStart = match.index ?? 0;
  const headingStart = match[0].startsWith('\n') ? matchStart + 1 : matchStart;
  let lineEnd = content.indexOf('\n', headingStart);
  if (lineEnd === -1) lineEnd = content.length;

  return {
    lineStart: headingStart,
    lineEnd,
    line: cleanHeadingLine(content.slice(headingStart, lineEnd)),
  };
};

const buildTitleVariants = (title: string): string[] => {
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (!trimmed) return [];

  const variants = new Set<string>([trimmed]);
  const withoutPrefix = trimmed.replace(TITLE_PREFIX_RE, '').trim();
  if (withoutPrefix) variants.add(withoutPrefix);

  const withoutLeadingNumber = trimmed
    .replace(/^(?:[\[(]?\s*[\dIVXLCDM]+[\]).:-]?\s*)+/iu, '')
    .trim();
  if (withoutLeadingNumber) variants.add(withoutLeadingNumber);

  const bare = withoutPrefix.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (bare) variants.add(bare);

  if (/^\d+$/.test(trimmed)) variants.add(`Chapter ${trimmed}`);

  return [...variants].filter(Boolean);
};

const buildChapterVariants = (chapter: Chapter): string[] => {
  const variants = new Set<string>();
  for (const value of [
    chapter.sourceHeading,
    ...(chapter.sourceHeadingVariants || []),
    chapter.title,
  ]) {
    for (const variant of buildTitleVariants(value || '')) {
      variants.add(variant);
    }
  }
  return [...variants].filter(Boolean);
};

const topicRangeStart = (chapter: Chapter): number | null => {
  for (const value of [
    chapter.sourceHeading,
    ...(chapter.sourceHeadingVariants || []),
    chapter.title,
  ]) {
    const match = (value || '').match(TOPIC_RANGE_RE);
    if (!match) continue;

    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) {
      return start;
    }
  }

  return null;
};

const findTopicRangeCandidates = (
  content: string,
  chapter: Chapter,
  markers: PageMarker[]
): HeadingCandidate[] => {
  const start = topicRangeStart(chapter);
  if (!start) return [];

  const escapedStart = escapeRegex(String(start));
  const pattern = new RegExp(
    `(?:^|\\n)[ \\t]*(?:\\[\\[PAGE\\s+\\d+\\]\\][ \\t]*)?(?:#{1,6}[ \\t]*)?(?:[*_~]{1,3}[ \\t]*)?(?:(?:topic|day|lesson)[ \\t]+)?${escapedStart}[\\).:\\-–—|][ \\t]+([^\\r\\n]+)(?:\\r?\\n|$)`,
    'giu'
  );
  const candidates: HeadingCandidate[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const { lineStart, lineEnd, line: headingText } = getMatchedHeadingBounds(content, match);
    const contentStart = skipBlankLines(content, lineEnd);
    const bodyStartSample = content.slice(contentStart, contentStart + 240);
    if (!PRINCIPLE_BODY_START_RE.test(bodyStartSample)) continue;

    candidates.push({
      headingStart: lineStart,
      headingEnd: lineEnd,
      contentStart,
      headingText,
      variant: `topic-range:${start}`,
      kind: 'line',
      page: pageAtIndex(markers, lineStart),
      score: 0,
    });
  }

  return candidates;
};

const isPlausibleHeadingLine = (line: string, variant: string): boolean => {
  const cleanLine = cleanHeadingLine(line);
  if (!cleanLine) return false;

  const normalizedLine = normalizeForMatch(cleanLine);
  const normalizedVariant = normalizeForMatch(variant);
  if (!normalizedLine || !normalizedVariant) return false;

  const containsVariant = normalizedLine.includes(normalizedVariant);
  if (!containsVariant) return false;

  const wordCount = countWords(cleanLine);
  if (cleanLine.length > 180 || wordCount > 24) return false;

  const variantShare = normalizedVariant.length / Math.max(normalizedLine.length, 1);
  const hasChapterSyntax =
    MARKDOWN_PREFIX_RE.test(line.trim()) ||
    TITLE_PREFIX_RE.test(cleanLine) ||
    /^[\[(]?\s*[\dIVXLCDM]+[\]).:-]/iu.test(cleanLine);

  return variantShare >= 0.45 || hasChapterSyntax;
};

const countWords = (value: string): number =>
  value.trim().split(/\s+/).filter(Boolean).length;

const looksLikeTopicTitle = (value: string): boolean => {
  const clean = cleanHeadingLine(value);
  const words = countWords(clean);
  if (!clean || clean.length > 140 || words > 18) return false;
  if (/^(?:contents|table of contents|principle|interpretation)$/iu.test(clean)) return false;
  if (/^\p{Ll}/u.test(clean)) return false;
  if (/[.!?。！？]$/.test(clean) && words > 6) return false;
  return true;
};

const lineStartsFor = (text: string, baseOffset = 0): number[] => {
  const starts: number[] = [];
  let offset = baseOffset;
  for (const line of text.split('\n')) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
};

const nextNonEmptyLine = (
  lines: string[],
  fromIndex: number,
  maxDistance: number
): { index: number; text: string } | null => {
  for (let i = fromIndex; i < lines.length && i <= fromIndex + maxDistance; i++) {
    const text = cleanHeadingLine(lines[i]);
    if (text) return { index: i, text };
  }
  return null;
};

const parseTopicHeadingAtLine = (
  lines: string[],
  lineStarts: number[],
  index: number
): TopicHeadingMatch | null => {
  const line = cleanHeadingLine(lines[index]);
  if (!line || TOPIC_SECTION_LABEL_RE.test(line)) return null;

  const direct = line.match(TOPIC_HEADING_RE) || line.match(TOPIC_WORD_HEADING_RE);
  if (direct) {
    const title = cleanHeadingLine(direct[2]);
    if (!looksLikeTopicTitle(title)) return null;
    return {
      number: direct[1],
      title,
      headingText: line,
      start: lineStarts[index],
      lineIndex: index,
      endLineIndex: index,
    };
  }

  const numberOnly = line.match(NUMBER_ONLY_TOPIC_RE);
  if (!numberOnly) return null;

  const titleLine = nextNonEmptyLine(lines, index + 1, 2);
  if (!titleLine || !looksLikeTopicTitle(titleLine.text)) return null;

  return {
    number: numberOnly[1],
    title: titleLine.text,
    headingText: [line, titleLine.text].join('\n'),
    start: lineStarts[index],
    lineIndex: index,
    endLineIndex: titleLine.index,
  };
};

const hasPrincipleInterpretationLabels = (
  lines: string[],
  fromLine: number,
  stopLine: number
): boolean => {
  let sawPrinciple = false;
  const scanEnd = Math.min(stopLine, fromLine + TOPIC_LABEL_SCAN_LIMIT);

  for (let i = fromLine; i < scanEnd; i++) {
    const line = cleanHeadingLine(lines[i]);
    const match = line.match(TOPIC_SECTION_LABEL_RE);
    if (!match) continue;
    const label = match[1].toLowerCase();
    if (label === 'principle') sawPrinciple = true;
    if (label === 'interpretation' && sawPrinciple) return true;
  }

  return false;
};

const topicHeadingsInRange = (
  content: string,
  rangeStart: number,
  rangeEnd: number
): TopicHeadingMatch[] => {
  const slice = content.slice(rangeStart, rangeEnd);
  const lines = slice.split('\n');
  const lineStarts = lineStartsFor(slice, rangeStart);
  const headings: TopicHeadingMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const heading = parseTopicHeadingAtLine(lines, lineStarts, i);
    if (!heading) continue;
    headings.push(heading);
    i = Math.max(i, heading.endLineIndex);
  }

  return headings.filter((heading, index) => {
    const next = headings[index + 1];
    return hasPrincipleInterpretationLabels(
      lines,
      heading.endLineIndex + 1,
      next?.lineIndex ?? lines.length
    );
  });
};

export const expandTopicSectionsIntoChapters = (
  content: string,
  chapters: Chapter[],
  topicsPerChunk = 10
): Chapter[] => {
  if (!content || chapters.length === 0 || topicsPerChunk <= 0) return chapters;

  const expanded: Chapter[] = [];
  let changed = false;

  for (const chapter of chapters) {
    if (topicRangeStart(chapter)) {
      expanded.push(chapter);
      continue;
    }

    const rangeStart = hasUsableSourceRange(content, chapter) ? chapter.sourceStart! : 0;
    const rangeEnd = hasUsableSourceRange(content, chapter) ? chapter.sourceEnd! : content.length;
    const topics = topicHeadingsInRange(content, rangeStart, rangeEnd);

    if (topics.length < topicsPerChunk) {
      expanded.push(chapter);
      continue;
    }

    changed = true;
    for (let i = 0; i < topics.length; i += topicsPerChunk) {
      const chunk = topics.slice(i, i + topicsPerChunk);
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      const title = first.number === last.number
        ? `Topic ${first.number}`
        : `Topics ${first.number}-${last.number}`;
      const {
        sourceStart,
        sourceEnd,
        sourcePageStart,
        sourcePageEnd,
        sourceMethod,
        ...rest
      } = chapter;

      expanded.push({
        ...rest,
        id: expanded.length + 1,
        title,
        description: `${chapter.title}: ${title}`,
        sourceHeading: first.headingText,
        sourceHeadingVariants: [
          first.headingText,
          `${first.number}. ${first.title}`,
          `Topic ${first.number} ${first.title}`,
          title,
        ],
      });
    }
  }

  return changed
    ? expanded.map((chapter, index) => ({ ...chapter, id: index + 1 }))
    : chapters;
};

const scoreBodySample = (sample: string): number => {
  const clean = stripPageMarkers(sample).trim();
  if (!clean) return -10;

  const words = countWords(clean);
  const sentences = (clean.match(/[.!?。！？](?=\s|$)/g) || []).length;
  const lines = clean.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const longLines = lines.filter(line => countWords(line) >= 10).length;

  let score = 0;
  if (words >= 40) score += 8;
  if (words >= 120) score += 8;
  if (sentences >= 2) score += 10;
  if (sentences >= 4) score += 6;
  if (longLines >= 2) score += 5;
  return score;
};

const looksLikeTocRegion = (sample: string): boolean => {
  const clean = stripPageMarkers(sample);
  const lines = clean
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 6);

  if (lines.length < 2) return false;

  const shortLines = lines.filter(line => line.length < 90).length;
  const listLikeLines = lines.filter(line =>
    /(?:\.{2,}|[\t ]\d+\s*$|^[\dIVXLCDM]+[.)]\s)/iu.test(line)
  ).length;
  const sentenceLikeLines = lines.filter(line =>
    /[.!?。！？]/.test(line) && countWords(line) >= 10
  ).length;

  return (
    shortLines >= Math.min(4, lines.length) &&
    sentenceLikeLines === 0 &&
    (listLikeLines >= 1 || lines.filter(line => countWords(line) <= 10).length >= 3)
  );
};

const looksLikeTocEntryLine = (line: string): boolean => {
  const clean = stripPageMarkers(line).trim();
  if (!clean) return false;
  return (
    /\.{2,}\s*\d+\s*$/.test(clean) ||
    /[\t ]{2,}\d+\s*$/.test(clean)
  );
};

const scoreCandidate = (
  content: string,
  candidate: Omit<HeadingCandidate, 'score'>,
  chapter: Chapter,
  markers: PageMarker[]
): number => {
  let score = candidate.kind === 'line' ? 60 : candidate.kind === 'normalized' ? 25 : 20;
  const headingText = candidate.headingText;
  const headingWords = countWords(headingText);

  const sample = content.slice(candidate.contentStart, candidate.contentStart + 1600);
  const isChapterMarkerHeading = /^(?:\[\[PAGE[^\]]*\]\]\s*)?(?:[*_~]{1,3}\s*)?(?:chapter|ch\.?|part|book|volume|vol\.?)\s+[\divxlcdm]+\b/iu.test((headingText || '').trim());
  // A "Chapter N. Title" line immediately followed by a numbered reference list is a
  // per-chapter label *inside the Notes/back-matter section*, not the chapter's real
  // body heading. (Endnotes are grouped as "Chapter 4. ...\n1. Author... 2. ...".)
  // Without recognising this, such a label wins the "Chapter N" bonus below and the
  // chapter resolves into the back matter — swallowing the real chapters between and
  // leaving the Notes chapter itself unlocatable. Gated on the heading being a
  // "Chapter N" marker so a chapter that legitimately opens with a numbered topic
  // list ("1. Topic 1 ...") is not mistaken for a notes group.
  const numberedEntries = (sample.slice(0, 1200).match(/(?:^|\n)\s*\d{1,3}[.)]\s+["“A-Z]/g) || []).length;
  const looksLikeNotesGroupLabel = isChapterMarkerHeading && numberedEntries >= 3;

  if (headingText) {
    if (headingText.length <= 120) score += 12;
    else score -= 16;

    if (headingWords <= 14) score += 8;
    else if (headingWords > 30) score -= 12;

    if (looksLikeTocEntryLine(headingText)) score -= 55;

    // A heading line that carries an explicit "Chapter/Part/Book N" marker is the
    // real chapter heading, not a running header that merely repeats the title on
    // every page. Without this, the (often long) real heading loses on length to a
    // short running header and the chapter resolves several pages late, pulling its
    // opening into the previous chapter. Excludes Notes-section group labels.
    if (isChapterMarkerHeading && !looksLikeNotesGroupLabel) {
      score += 50;
    }
  }

  if (chapter.pageStart && candidate.page != null) {
    score += Math.max(-16, 28 - Math.abs(candidate.page - chapter.pageStart) * 8);
  }
  if (chapter.pageEnd && candidate.page != null && candidate.page > chapter.pageEnd + 1) {
    score -= 12;
  }

  score += scoreBodySample(sample);
  // Never resolve a chapter's body to a Notes-section group label.
  if (looksLikeNotesGroupLabel) score -= 70;
  // A real "Index" section legitimately has a TOC-like body (terms + page numbers),
  // so the TOC-region penalty would wrongly reject it and let the previous chapter
  // (e.g. Notes) swallow it. The heading-line TOC-entry check above still guards
  // against matching the front table of contents.
  const isIndexSectionHeading = /^\s*index\s*$/iu.test(headingText);
  if (looksLikeTocRegion(sample) && !isIndexSectionHeading) score -= 60;

  if (!chapter.pageStart && candidate.headingStart < Math.floor(content.length * 0.08)) {
    const earlySample = content.slice(candidate.headingStart, candidate.headingStart + 500);
    if (looksLikeTocRegion(earlySample)) score -= 18;
  }

  return score;
};

const shouldIncludeHeadingInExtraction = (
  content: string,
  candidate: HeadingCandidate
): boolean => {
  if (!candidate.headingText || !NUMBERED_TOPIC_HEADING_RE.test(candidate.headingText.trim())) {
    return false;
  }

  const bodyStartSample = content.slice(candidate.contentStart, candidate.contentStart + 240);
  return PRINCIPLE_BODY_START_RE.test(bodyStartSample);
};

const dedupeCandidates = (candidates: HeadingCandidate[]): HeadingCandidate[] => {
  const bestByKey = new Map<string, HeadingCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.headingStart}:${candidate.contentStart}`;
    const existing = bestByKey.get(key);
    if (!existing || candidate.score > existing.score) {
      bestByKey.set(key, candidate);
    }
  }
  return [...bestByKey.values()].sort(
    (a, b) => b.score - a.score || a.headingStart - b.headingStart
  );
};

const findHeadingCandidates = (
  content: string,
  chapter: Chapter,
  normalized: NormalizedSource,
  markers: PageMarker[]
): HeadingCandidate[] => {
  const variants = buildChapterVariants(chapter);
  const rawCandidates: HeadingCandidate[] = findTopicRangeCandidates(content, chapter, markers);

  for (const variant of variants) {
    const escaped = escapeRegex(variant);
    const pattern = new RegExp(
      `(?:^|\\n)[ \\t]*(?:\\[\\[PAGE\\s+\\d+\\]\\][ \\t]*)?(?:#{1,6}[ \\t]*)?(?:[*_~]{1,3}[ \\t]*)?(?:(?:Chapter|Ch\\.?|Part|Section|Book|Volume|Vol\\.?)\\s+[\\p{L}\\p{N}IVXLCDM.-]+[ \\t]*[:.\\-—]?[ \\t]*)?${escaped}(?:[ \\t]*[*_~]{1,3})?[ \\t]*(?:\\r?\\n|$)`,
      'giu'
    );

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const { lineStart, lineEnd, line: headingText } = getMatchedHeadingBounds(content, match);
      const contentStart = skipBlankLines(content, lineEnd);
      rawCandidates.push({
        headingStart: lineStart,
        headingEnd: lineEnd,
        contentStart,
        headingText,
        variant,
        kind: 'line',
        page: pageAtIndex(markers, lineStart),
        score: 0,
      });
    }
  }

  for (const variant of variants) {
    const normalizedVariant = normalizeForMatch(variant);
    if (normalizedVariant.length < 4) continue;

    let from = 0;
    while (from < normalized.value.length) {
      const normalizedIndex = normalized.value.indexOf(normalizedVariant, from);
      if (normalizedIndex === -1) break;

      const start = normalized.indexMap[normalizedIndex];
      const end = normalized.indexMap[normalizedIndex + normalizedVariant.length - 1] + 1;
      const { lineStart, lineEnd, line } = getLineBounds(content, start, end);
      if (!isPlausibleHeadingLine(content.slice(lineStart, lineEnd), variant)) {
        from = normalizedIndex + normalizedVariant.length;
        continue;
      }
      rawCandidates.push({
        headingStart: lineStart,
        headingEnd: lineEnd,
        contentStart: skipBlankLines(content, lineEnd),
        headingText: line,
        variant,
        kind: 'normalized',
        page: pageAtIndex(markers, lineStart),
        score: 0,
      });

      from = normalizedIndex + normalizedVariant.length;
    }
  }

  if (chapter.pageStart) {
    const marker = findMarkerForPage(markers, chapter.pageStart);
    if (marker) {
      rawCandidates.push({
        headingStart: marker.index,
        headingEnd: marker.index + marker.len,
        contentStart: skipBlankLines(content, marker.index + marker.len),
        headingText: '',
        variant: `page:${chapter.pageStart}`,
        kind: 'page',
        page: marker.page,
        score: 0,
      });
    }
  }

  return dedupeCandidates(
    rawCandidates.map(candidate => ({
      ...candidate,
      score: scoreCandidate(content, candidate, chapter, markers),
    }))
  );
};

const inferPageEnd = (
  markers: PageMarker[],
  fallback: number | undefined,
  index: number
): number | undefined => pageAtIndex(markers, index) ?? fallback;

export const computeSourceHash = (content: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length.toString(36)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

// A standalone "INDEX" heading line (its own line, optionally preceded by a page
// marker). Used to split an index section off a chapter that swallowed it when the
// structure analysis did not list "Index" as its own chapter.
const STANDALONE_INDEX_HEADING_RE = /\n[ \t]*(?:\[\[PAGE[^\]\n]*\]\][ \t]*)*index[ \t]*(?=\r?\n)/i;

const isIndexTitle = (value?: string): boolean => /^\s*index\s*$/i.test(value || '');

// Some books' structure analysis omits the back-matter "Index" section, so the
// preceding chapter (usually Notes) runs to the end of the book and absorbs the
// whole index. Detect a standalone "INDEX" heading inside a resolved chapter and
// split it into its own Index chapter so it gets index-aware extraction/rendering.
export const splitDetectedBackMatter = (content: string, chapters: Chapter[]): Chapter[] => {
  if (!content) return chapters;
  const out: Chapter[] = [];
  for (const chapter of chapters) {
    if (isIndexTitle(chapter.title) || isIndexTitle(chapter.sourceHeading) || !hasUsableSourceRange(content, chapter)) {
      out.push(chapter);
      continue;
    }
    const start = chapter.sourceStart!;
    const end = chapter.sourceEnd!;
    const body = content.slice(start, end);
    const match = STANDALONE_INDEX_HEADING_RE.exec(body);
    // Require the heading to sit well into the chapter body (not be the chapter's
    // own heading) and in the back portion of the whole book, to avoid false splits.
    if (!match || match.index < 40 || start + match.index < content.length * 0.5) {
      out.push(chapter);
      continue;
    }
    const headingNewlineAbs = start + match.index;
    const headingLineEndRel = body.indexOf('\n', match.index + 1);
    const headingLineEndAbs = headingLineEndRel === -1 ? end : start + headingLineEndRel;
    const indexContentStart = skipBlankLines(content, headingLineEndAbs);
    if (indexContentStart >= end) {
      out.push(chapter);
      continue;
    }
    out.push({ ...chapter, sourceEnd: headingNewlineAbs });
    out.push({
      ...chapter,
      title: 'Index',
      sourceStart: indexContentStart,
      sourceEnd: end,
      sourceHeading: 'Index',
      sourceHeadingVariants: undefined,
    });
  }
  return out.map((chapter, index) => ({ ...chapter, id: index + 1 }));
};

export const buildSourceIndexedChapters = (content: string, chapters: Chapter[]): Chapter[] => {
  if (!content || chapters.length === 0) return chapters;

  const normalized = buildNormalizedSource(content);
  const markers = parsePageMarkers(content);
  const resolved: (HeadingCandidate | null)[] = new Array(chapters.length).fill(null);
  let minIndex = 0;

  chapters.forEach((chapter, idx) => {
    const candidates = findHeadingCandidates(content, chapter, normalized, markers).filter(candidate =>
      candidate.contentStart >= minIndex || candidate.headingStart >= minIndex
    );

    const best = candidates.find(candidate => candidate.score >= MIN_ACCEPTED_CANDIDATE_SCORE) || null;
    if (best) {
      resolved[idx] = best;
      minIndex = Math.max(best.headingEnd, best.contentStart + 1);
    }
  });

  return chapters.map((chapter, idx) => {
    const chosen = resolved[idx];
    if (!chosen) {
      return {
        ...chapter,
        sourceHeadingVariants: buildChapterVariants(chapter),
      };
    }

    const sourceStart = shouldIncludeHeadingInExtraction(content, chosen)
      ? chosen.headingStart
      : chosen.contentStart;

    let end = content.length;
    for (let nextIdx = idx + 1; nextIdx < resolved.length; nextIdx++) {
      const next = resolved[nextIdx];
      if (next) {
        end = next.headingStart;
        break;
      }
    }

    const nextChapter = chapters[idx + 1];
    if (typeof nextChapter?.pageStart === 'number') {
      const nextPageMarker = findMarkerForPage(markers, nextChapter.pageStart);
      if (
        nextPageMarker &&
        nextPageMarker.index > chosen.contentStart &&
        nextPageMarker.index < end
      ) {
        end = nextPageMarker.index;
      }
    }

    if (typeof chapter.pageEnd === 'number') {
      const pageEndMarker = findMarkerForPage(markers, chapter.pageEnd + 1);
      if (
        pageEndMarker &&
        pageEndMarker.index > chosen.contentStart &&
        pageEndMarker.index < end
      ) {
        end = pageEndMarker.index;
      }
    }

    if (end < sourceStart) end = sourceStart;

    return {
      ...chapter,
      sourceStart,
      sourceEnd: end,
      sourceHeading: chosen.headingText || undefined,
      sourceHeadingVariants: buildChapterVariants({
        ...chapter,
        sourceHeading: chosen.headingText || chapter.sourceHeading,
      }),
      sourcePageStart: chosen.page ?? chapter.pageStart,
      sourcePageEnd: inferPageEnd(markers, chapter.pageEnd, Math.max(sourceStart, end - 1)),
      sourceMethod: chapter.pageStart && chosen.kind !== 'page' ? 'hybrid' : chosen.kind === 'page' ? 'page' : 'heading',
    };
  });
};

export const extractChapterFromSource = (
  content: string,
  chapter: Chapter,
  allChapters?: Chapter[]
): string | null => {
  const extractRange = (resolvedChapter: Chapter): string | null => {
    if (!hasUsableSourceRange(content, resolvedChapter)) return null;

    const text = content
      .slice(resolvedChapter.sourceStart!, resolvedChapter.sourceEnd!)
      .replace(PAGE_MARKER_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text.length > 0 ? text : null;
  };

  const existing = extractRange(chapter);
  if (existing) return existing;

  if (allChapters?.length) {
    const reindexed = buildSourceIndexedChapters(content, allChapters);
    const found = reindexed.find(candidate => candidate.id === chapter.id);
    if (found) return extractRange(found);
  }

  return null;
};

// Locate the offset of a "[[PAGE n]]" marker for a 1-based page number. Pages with no
// extractable text emit no marker, so fall back to the nearest following page within a
// small window.
const offsetForPage = (content: string, page: number): number | null => {
  for (let p = page; p < page + 12; p++) {
    const idx = content.indexOf(`[[PAGE ${p}]]`);
    if (idx >= 0) return idx;
  }
  return null;
};

// True when a PDF outline has enough resolvable, real content entries to be worth using
// in place of heuristic chapter resolution. Guards against trivial outlines (e.g. a lone
// "Cover" bookmark) and outlines whose pages don't map to extracted text.
export const isUsablePdfOutline = (content: string, outline: PdfOutlineItem[] | undefined): boolean => {
  if (!outline || outline.length === 0) return false;
  const resolved = outline.filter(
    item => item.title.trim().length > 0 && offsetForPage(content, item.page) != null
  );
  return resolved.length >= 3;
};

// Build the chapter list directly from a PDF's own outline (bookmarks): map each entry's
// page to its "[[PAGE n]]" offset in the extracted text, in document order, with each
// chapter running until the next. This replaces heuristic title-to-offset resolution for
// PDFs that carry a usable outline — the page destinations are authoritative, so no
// scoring/guessing is involved. Falls back (returns []) when the outline is unusable, so
// the caller can use the existing pipeline.
export const buildChaptersFromOutline = (content: string, outline: PdfOutlineItem[]): Chapter[] => {
  const resolved = outline
    // Prefer the Y-resolved heading offset (separates same-page bookmarks); fall back to
    // the page-start marker when extraction couldn't locate the heading.
    .map(item => ({
      title: item.title.replace(/\s+/g, ' ').trim(),
      page: item.page,
      start: item.offset ?? offsetForPage(content, item.page),
    }))
    .filter((item): item is { title: string; page: number; start: number } => Boolean(item.title) && item.start != null)
    .sort((a, b) => a.start - b.start);

  // Collapse entries that still resolve to the same (or earlier) offset — e.g. same-page
  // bookmarks whose heading text couldn't be located; keep the first.
  const monotonic: typeof resolved = [];
  for (const item of resolved) {
    if (monotonic.length && item.start <= monotonic[monotonic.length - 1].start) continue;
    monotonic.push(item);
  }

  const chapters: Chapter[] = monotonic.map((item, index) => ({
    id: index + 1,
    title: item.title,
    sourceStart: item.start,
    sourceEnd: monotonic[index + 1]?.start ?? content.length,
    sourcePageStart: item.page,
    sourceMethod: 'outline' as const,
  }));

  // Drop entries whose page range holds no extractable text — image-only front matter (a
  // title page, cover, or art plate) would otherwise become a chapter that errors with
  // SOURCE_REQUIRED when opened. Keep the originals if filtering would empty the list, and
  // renumber the survivors.
  const withText = chapters.filter(chapter =>
    content.slice(chapter.sourceStart!, chapter.sourceEnd!).replace(PAGE_MARKER_RE, '').trim().length > 0
  );
  return (withText.length ? withText : chapters).map((chapter, index) => ({ ...chapter, id: index + 1 }));
};
