import { BookStructure, Chapter } from '../types';

const STRUCTURE_TEXT_LIMIT = 600000;
const STRUCTURE_EXCERPT_SIZE = 30000;
const MAX_STRUCTURE_HEADINGS = 1500;
const MAX_LOCAL_CHAPTERS = 300;

const PAGE_MARKER_RE = /\[\[PAGE\s+\d+\]\]\s*/g;
const MARKDOWN_PREFIX_RE = /^(?:#{1,6}\s*)+/;
const NUMBER_WORD_PATTERN =
  String.raw`(?:\d+|[IVXLCDM]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty[- ]one|twenty[- ]two|twenty[- ]three|twenty[- ]four|twenty[- ]five|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)`;
const NUMBERED_SECTION_RE = new RegExp(
  String.raw`^(?:chapter|ch\.?|part|section|book|volume|vol\.?)\s+${NUMBER_WORD_PATTERN}(?:\s*$|\s*[:.\-—]\s*\S.*|\s+\S.*)$`,
  'iu'
);
const NUMBERED_SECTION_ID_RE = new RegExp(
  String.raw`^(chapter|ch\.?|part|section|book|volume|vol\.?)\s+(${NUMBER_WORD_PATTERN})\b`,
  'iu'
);
const STANDALONE_NUMBERED_SECTION_RE = new RegExp(
  String.raw`^(?:chapter|ch\.?|part|section|book|volume|vol\.?)\s+[\p{L}\p{N}ivxlcdm.-]+$`,
  'iu'
);
const FRONT_BACK_MATTER_RE =
  /^(?:foreword|preface|introduction|prologue|epilogue|afterword|acknowledg(?:e)?ments?|about\s+(?:the\s+)?author|appendix(?:\s+[\p{L}\p{N}.-]+)?|conclusion|notes|bibliography|references|index)\b(?:\s*$|\s*[:.\-—]\s*\S.*)$/iu;
const ORDINAL_HEADING_RE = /^\s*(\d{1,2}|[IVXLCDM]+)[\).:-]\s+(.+)$/u;
const TOC_ENTRY_RE = /(?:\.{2,}|[\t ]{2,})\s*\d+\s*$/;
const BOILERPLATE_RE =
  /^(?:contents|table of contents|copyright|all rights reserved|isbn|published by|publisher|dedication|cover|title page|tittle page)$/iu;
const NON_READING_CHAPTER_RE =
  /^(?:title(?:\s+page)?|tittle(?:\s+page)?|cover(?:\s+page)?|contents?(?:\s+page)?|table\s+of\s+contents|copyright(?:\s+page)?|imprint|publication\s+details)$/iu;

const cleanStructureLine = (value: string): string =>
  value
    .replace(PAGE_MARKER_RE, '')
    .replace(/\[\[FIG\s+[^\]]+\]\]\s*/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .trim();

const cleanHeadingTitle = (value: string): string =>
  cleanStructureLine(value)
    .replace(MARKDOWN_PREFIX_RE, '')
    .trim();

export const isReadableChapterTitle = (value: string): boolean => {
  const clean = cleanHeadingTitle(value);
  return Boolean(clean) && !NON_READING_CHAPTER_RE.test(clean);
};

const countWords = (value: string): number =>
  value.trim().split(/\s+/).filter(Boolean).length;

const normalizeKey = (value: string): string =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const isTocEntry = (line: string): boolean => TOC_ENTRY_RE.test(cleanStructureLine(line));

export const looksLikeStructureHeading = (line: string): boolean => {
  const clean = cleanStructureLine(line);
  if (!clean || clean.length > 180 || isTocEntry(clean)) return false;

  const words = countWords(clean);
  if (words > 24) return false;

  const withoutMarkdown = clean.replace(MARKDOWN_PREFIX_RE, '').trim();
  if (/^index[-_]/iu.test(withoutMarkdown)) return false;
  return (
    /^#{1,6}\s+\S/.test(clean) ||
    NUMBERED_SECTION_RE.test(withoutMarkdown) ||
    FRONT_BACK_MATTER_RE.test(withoutMarkdown) ||
    looksLikeOrdinalHeading(withoutMarkdown) ||
    looksLikeStandaloneTitleHeading(withoutMarkdown)
  );
};

const looksLikeOrdinalHeading = (line: string): boolean => {
  const match = line.match(ORDINAL_HEADING_RE);
  if (!match) return false;

  const rest = match[2].trim();
  const words = countWords(rest);
  if (!rest || rest.length > 90 || words > 12) return false;

  const lower = rest.toLowerCase();
  if (/^\p{Ll}/u.test(rest)) return false;
  if (/\b(?:we|they|he|she|it|this|that|these|those)\b/.test(rest)) return false;
  if (/[.!?。！？]$/.test(rest)) return false;
  if (/\b(?:ibid|op\.\s*cit|p{1,2}\.|quoted in|see\s+)/i.test(lower)) return false;

  const hasSentencePunctuation = /[.!?。！？]/.test(rest);
  if (hasSentencePunctuation && words > 5) return false;
  if (/[;:]\s+\S/.test(rest) && words > 6) return false;
  if (words > 3 && !looksTitleLike(rest)) return false;

  return true;
};

const isExplicitStructureHeading = (line: string): boolean => {
  const clean = cleanHeadingTitle(line);
  return (
    /^#{1,6}\s+\S/.test(clean) ||
    NUMBERED_SECTION_RE.test(clean) ||
    FRONT_BACK_MATTER_RE.test(clean) ||
    looksLikeOrdinalHeading(clean)
  );
};

const looksTitleLike = (value: string): boolean => {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  const meaningful = words.filter(word => /[\p{L}\p{N}]/u.test(word));
  if (meaningful.length === 0) return false;

  const titleish = meaningful.filter(word =>
    /^[\p{Lu}\d]/u.test(word) ||
    /^(?:and|or|of|the|a|an|to|in|on|for|with|from|by)$/iu.test(word)
  ).length;

  return titleish / meaningful.length >= 0.65;
};

const looksSentenceCaseTitleLike = (value: string): boolean => {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return false;
  if (!/^[\p{Lu}\d"“‘]/u.test(value)) return false;
  if (/[,:;()[\]{}]/u.test(value)) return false;

  const lower = value.toLowerCase();
  if (/^(?:and|but|or|so|because|while|although|however|therefore|thus)\b/u.test(lower)) return false;
  if (/\b(?:we|they|he|she|it|this|that|these|those|you|your|i|am|are|is|was|were|been|being|has|have|had|does|did)\b/u.test(lower)) {
    return false;
  }

  return true;
};

const looksLikeStandaloneTitleHeading = (line: string): boolean => {
  const clean = cleanHeadingTitle(line);
  if (!isReadableChapterTitle(clean)) return false;
  const words = countWords(clean);
  if (!clean || clean.length > 120 || words > 12) return false;
  if (/^\p{Ll}/u.test(clean)) return false;
  if (/[.!?。！？]$/u.test(clean)) return false;
  if (/[;:]\s+\S/u.test(clean) && words > 6) return false;
  if (/^\d/u.test(clean) && !looksLikeOrdinalHeading(clean)) return false;

  const lower = clean.toLowerCase();
  if (/\b(?:we|they|he|she|it|this|that|these|those|you|your|i|am|are|was|were|been|being|has|have|had|does|did)\b/u.test(lower) && words > 4) {
    return false;
  }

  return looksTitleLike(clean) || looksSentenceCaseTitleLike(clean);
};

const isNumberedStructureHeading = (line: string): boolean =>
  NUMBERED_SECTION_RE.test(line) || looksLikeOrdinalHeading(line);

const startsBackMatterRegion = (
  heading: string,
  numberedSectionCount: number,
  offset: number,
  contentLength: number
): boolean =>
  /^(?:notes|bibliography|references|index)\b/iu.test(heading) &&
  numberedSectionCount >= 2 &&
  offset > contentLength * 0.35;

const numberedSectionIdentity = (heading: string): string | null => {
  const match = heading.match(NUMBERED_SECTION_ID_RE);
  if (!match) return null;
  const type = match[1].toLowerCase().replace(/^ch\.?$/, 'chapter').replace(/^vol\.?$/, 'volume');
  return `${type}:${match[2].toLowerCase().replace(/\s+/g, '-')}`;
};

const sampleEvenly = (items: string[], limit: number): string[] => {
  if (items.length <= limit) return items;
  const sampled: string[] = [];
  for (let i = 0; i < limit; i++) {
    const idx = Math.floor((i * (items.length - 1)) / (limit - 1));
    sampled.push(items[idx]);
  }
  return sampled;
};

export const buildStructureAnalysisText = (content: string): string => {
  if (content.length <= STRUCTURE_TEXT_LIMIT) return content;

  const headingCandidates: string[] = [];
  let offset = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (looksLikeStructureHeading(line)) {
      headingCandidates.push(`offset ${offset}: ${cleanHeadingTitle(line)}`);
    }
    offset += rawLine.length + 1;
  }

  const sampledHeadings = sampleEvenly(headingCandidates, MAX_STRUCTURE_HEADINGS);
  return [
    'LONG_SOURCE_OUTLINE: The full source is stored locally, but this compact outline is used for structure analysis.',
    'Use the heading candidates to identify ordered readable sections across the entire document, including foreword, preface, introduction, prologue, numbered chapters, epilogue, afterword, appendices, and notes. Preserve exact visible heading text in sourceHeading when available.',
    '',
    'BEGINNING_EXCERPT:',
    content.slice(0, STRUCTURE_EXCERPT_SIZE),
    '',
    'HEADING_CANDIDATES:',
    sampledHeadings.length ? sampledHeadings.join('\n') : '[none detected]',
    '',
    'ENDING_EXCERPT:',
    content.slice(-STRUCTURE_EXCERPT_SIZE),
  ].join('\n');
};

const makeBookId = (): string => {
  const randomUUID = globalThis.crypto?.randomUUID;
  return typeof randomUUID === 'function'
    ? randomUUID.call(globalThis.crypto)
    : `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const isTitleCandidate = (line: string): boolean => {
  const clean = cleanHeadingTitle(line);
  if (!clean || clean.length > 140 || countWords(clean) > 18) return false;
  if (
    isExplicitStructureHeading(clean) ||
    isTocEntry(clean) ||
    BOILERPLATE_RE.test(clean)
  ) {
    return false;
  }
  if (/^[\d\W_]+$/u.test(clean)) return false;
  return true;
};

const inferTitleAuthor = (content: string): { title: string; author: string } => {
  const lines = content
    .split(/\r?\n/)
    .map(cleanHeadingTitle)
    .filter(line => isTitleCandidate(line))
    .slice(0, 8);

  const title = lines[0] || 'Untitled Document';
  const byline = lines.find(line => /^by\s+\S/i.test(line));
  const author = byline?.replace(/^by\s+/i, '').trim() || 'Unknown Author';
  return { title, author };
};

const withFollowingSubtitle = (lines: string[], index: number, heading: string): string => {
  const next = cleanHeadingTitle(lines[index + 1] || '');
  const standaloneNumbered = STANDALONE_NUMBERED_SECTION_RE.test(heading);
  if (
    standaloneNumbered &&
    next &&
    next.length <= 120 &&
    countWords(next) <= 14 &&
    !/[.!?。！？]$/.test(next) &&
    !isExplicitStructureHeading(next) &&
    !isTocEntry(next)
  ) {
    return `${heading}: ${next}`;
  }
  return heading;
};

export const buildLocalTextStructure = (content: string): BookStructure => {
  const { title, author } = inferTitleAuthor(content);
  const rawLines = content.split(/\r?\n/);
  const chapters: Chapter[] = [];
  const seen = new Set<string>();
  const chapterIndexByKey = new Map<string, number>();
  const seenNumbered = new Set<string>();
  const chapterIndexByNumbered = new Map<string, number>();
  let offset = 0;
  let numberedSectionCount = 0;
  let inBackMatterRegion = false;

  const addVariantToExisting = (
    chapterIndex: number | undefined,
    heading: string,
    displayTitle: string
  ) => {
    if (chapterIndex == null || !chapters[chapterIndex]) return;
    const chapter = chapters[chapterIndex];
    const variants = new Set([
      ...(chapter.sourceHeadingVariants || []),
      chapter.sourceHeading,
      heading,
      displayTitle,
    ].filter(Boolean) as string[]);
    chapter.sourceHeadingVariants = [...variants];
  };

  for (let i = 0; i < rawLines.length && chapters.length < MAX_LOCAL_CHAPTERS; i++) {
    const rawLine = rawLines[i];
    if (!looksLikeStructureHeading(rawLine)) {
      offset += rawLine.length + 1;
      continue;
    }

    const heading = cleanHeadingTitle(rawLine);
    const previousHeading = cleanHeadingTitle(rawLines[i - 1] || '');
    const previousNumberedKey = STANDALONE_NUMBERED_SECTION_RE.test(previousHeading)
      ? numberedSectionIdentity(previousHeading)
      : null;
    if (
      looksLikeStandaloneTitleHeading(heading) &&
      previousNumberedKey &&
      chapterIndexByNumbered.has(previousNumberedKey)
    ) {
      addVariantToExisting(chapterIndexByNumbered.get(previousNumberedKey), heading, `${previousHeading}: ${heading}`);
      offset += rawLine.length + 1;
      continue;
    }

    if (
      title !== 'Untitled Document' &&
      chapters.length === 0 &&
      offset < 1200 &&
      normalizeKey(heading) === normalizeKey(title)
    ) {
      offset += rawLine.length + 1;
      continue;
    }

    const isNumbered = isNumberedStructureHeading(heading);
    if (inBackMatterRegion && isNumbered) {
      offset += rawLine.length + 1;
      continue;
    }

    const displayTitle = withFollowingSubtitle(rawLines, i, heading);
    if (!isReadableChapterTitle(displayTitle)) {
      offset += rawLine.length + 1;
      continue;
    }

    const key = normalizeKey(displayTitle);
    const numberedKey = numberedSectionIdentity(heading);
    if (!key || seen.has(key) || (numberedKey && seenNumbered.has(numberedKey))) {
      addVariantToExisting(
        key && chapterIndexByKey.has(key)
          ? chapterIndexByKey.get(key)
          : numberedKey
            ? chapterIndexByNumbered.get(numberedKey)
            : undefined,
        heading,
        displayTitle
      );
      if (startsBackMatterRegion(heading, numberedSectionCount, offset, content.length)) {
        inBackMatterRegion = true;
      }
      offset += rawLine.length + 1;
      continue;
    }

    seen.add(key);
    chapterIndexByKey.set(key, chapters.length);
    if (numberedKey) {
      seenNumbered.add(numberedKey);
      chapterIndexByNumbered.set(numberedKey, chapters.length);
    }

    chapters.push({
      id: chapters.length + 1,
      title: displayTitle,
      sourceHeading: heading,
      description: '',
    });

    if (isNumbered) numberedSectionCount += 1;
    if (startsBackMatterRegion(heading, numberedSectionCount, offset, content.length)) {
      inBackMatterRegion = true;
    }

    offset += rawLine.length + 1;
  }

  if (chapters.length === 0 && content.trim()) {
    chapters.push({
      id: 1,
      title: 'Full Text',
      sourceHeading: undefined,
      sourceStart: 0,
      sourceEnd: content.length,
      sourceMethod: 'heading',
      description: '',
    });
  }

  return {
    id: makeBookId(),
    title,
    author,
    chapters,
    bookmarks: [],
  };
};
