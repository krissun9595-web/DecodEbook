import { Chapter } from '../types';
import { extractChapterFromSource } from './sourceIndex';
import { rearrangeAndCleanText } from './textCleanup';
import {
  normalizeNotesReaderText,
  paginateReaderText,
  findTopicHeadingForExtractedText,
  findTopicHeadingAtOffset,
  findTopicHeadingBeforeOffset,
} from './readerStructure';

// Full-text search index for a book's reader content.
//
// IMPORTANT: this module reproduces the reader's extract -> clean -> paginate
// pipeline (AudioBook.loadContent) verbatim so that a result's page number is the
// exact page the reader will display when navigated. It only *reads* the shared,
// exported utilities — it never mutates reader state — so it cannot affect the
// reader, audio, or translation paths. The few small helpers below mirror the
// ones local to AudioBook.tsx; if that pipeline changes, mirror it here too.

const PAGE_TARGET_SIZE = 2500; // fallback only; App passes the live computePageTargetSize value

const isNotesChapterTitle = (value: string): boolean =>
  /^(?:chapter\s+)?(?:notes|endnotes|footnotes|references)\b|(?:notes|endnotes|footnotes)$/iu.test(value.trim());

const isIndexChapterTitle = (value: string): boolean =>
  /^(?:chapter\s+)?index\b|\bindex$/iu.test(value.trim());

const normalizeInternalLinkMarkup = (value: string): string =>
  value.replace(/\[\s*([^\]\n]{1,120}?)\s*\]\s*\(([^)\n]+)\)/g, (match, rawLabel: string, rawHref: string) => {
    const label = rawLabel.replace(/\s+/g, ' ').trim();
    const href = rawHref.trim();
    return label && href ? `[${label}](${href})` : match;
  });

const leadingTopicHeadingFor = (chapter: Chapter, sourceText?: string, chapterText?: string): string => {
  const inferredFromExtractedText =
    sourceText && chapterText ? findTopicHeadingForExtractedText(sourceText, chapterText) : null;
  const inferredFromSource =
    sourceText && typeof chapter.sourceStart === 'number'
      ? findTopicHeadingAtOffset(sourceText, chapter.sourceStart) ||
        findTopicHeadingBeforeOffset(sourceText, chapter.sourceStart)
      : null;
  const candidates = [
    inferredFromExtractedText,
    inferredFromSource,
    chapter.sourceHeading,
    ...(chapter.sourceHeadingVariants || []),
    chapter.title,
  ].filter(Boolean) as string[];
  return candidates.find(candidate =>
    /^(?:#{1,6}\s*)?(?:(?:topic|day|lesson)\s+)?\d{1,3}[\).:\-–—|]\s+\S/iu.test(candidate.trim())
  ) || chapter.sourceHeading || chapter.title;
};

// Reduce the reader's markdown-ish markup to the visible words, so a search
// matches what the reader actually shows (not a link's hidden href) and snippets
// read cleanly. Page boundaries are unchanged — only the matched text is cleaned.
const stripForSearch = (text: string): string =>
  text
    // Drop every PRIVATE-USE control sentinel (size tier, block role, flush/indent flags, table position
    // chars, etc. — all in U+E000–F8FF). They're invisible in the reader but leak into a search snippet as
    // tofu boxes (e.g. the extract block's size-tier + first-line-indent sentinels after "Musk said,"). NBSP
    // is whitespace, so the \s+ collapse below already folds a leading block indent into a trimmed space.
    .replace(/[--]/gu, ' ') // table cell/row/break/token separators -> SPACE (keep cells word-separated in search)
    .replace(/[-]/gu, '')
    // Drop the extractor's structural markers "[[FIG id]]" (a figure — the reader swaps it for the image) and
    // "[[PAGE n]]" (a page boundary). They're invisible in the reader but leaked into a search snippet as
    // literal "[[FIG p13n1]]" text (and a bare "FIG"/"PAGE" could even be matched).
    .replace(/\[\[(?:FIG|PAGE)\b[^\]]*\]\]/gi, ' ')
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ');

interface IndexedPage {
  text: string;   // visible text, original case (for snippets)
  lower: string;  // lower-cased (for matching)
}

export interface ChapterPageIndex {
  chapterId: number;
  chapterTitle: string;
  chapterNumber: number; // 1-based position in the chapter list
  pages: IndexedPage[];
}

export interface SearchHit {
  chapterId: number;
  chapterTitle: string;
  chapterNumber: number;
  pageIndex: number;  // 0-based — feeds ReaderPageTarget { type: 'page', pageIndex }
  pageNumber: number; // 1-based — matches the reader's "PG.NN" display
  snippet: string;
  matchStart: number; // offset of the match within `snippet`
  matchLength: number;
  occurrences: number; // total matches on that page
  anchor: string; // raw text at the match — the reader locates THIS to navigate (pagination-independent)
}

// Paginate one chapter exactly like the reader does, returning visible page text.
const indexChapterPages = (content: string, chapter: Chapter, allChapters: Chapter[], pageTargetSize: number): IndexedPage[] => {
  const rawText = extractChapterFromSource(content, chapter, allChapters);
  if (!rawText) return [];

  const isIndexSource = isIndexChapterTitle(chapter.title) || isIndexChapterTitle(chapter.sourceHeading || '');
  let cleanText = isIndexSource
    ? normalizeInternalLinkMarkup(normalizeInternalLinkMarkup(rawText).replace(/\n{3,}/g, '\n\n').trim())
    : normalizeInternalLinkMarkup(rearrangeAndCleanText(normalizeInternalLinkMarkup(rawText)));

  const isNotesSource = isNotesChapterTitle(chapter.title) || isNotesChapterTitle(chapter.sourceHeading || '');
  if (isNotesSource) cleanText = normalizeNotesReaderText(cleanText);

  const pages = paginateReaderText(cleanText, pageTargetSize, {
    topicsPerPage: 10,
    leadingHeading: leadingTopicHeadingFor(chapter, content, cleanText),
    measureVisibleLength: isIndexSource,
    preferLineBreaks: isNotesSource || isIndexSource,
  });

  return pages.map(page => {
    const text = stripForSearch(page.text).trim();
    return { text, lower: text.toLowerCase() };
  });
};

// Build a search index for the whole book. Synchronous and offline (extraction is
// local), so it is safe to memoise/cache per book and reuse across queries.
export const buildBookPageIndex = (content: string | undefined, chapters: Chapter[], pageTargetSize: number = PAGE_TARGET_SIZE): ChapterPageIndex[] => {
  if (!content || chapters.length === 0) return [];
  return chapters.map((chapter, idx) => {
    let pages: IndexedPage[] = [];
    try {
      pages = indexChapterPages(content, chapter, chapters, pageTargetSize);
    } catch {
      pages = [];
    }
    return {
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      chapterNumber: idx + 1,
      pages,
    };
  });
};

const SNIPPET_RADIUS = 48;

const buildSnippet = (text: string, matchIndex: number, matchLength: number): {
  snippet: string;
  matchStart: number;
} => {
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
  const end = Math.min(text.length, matchIndex + matchLength + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const snippet = `${prefix}${text.slice(start, end)}${suffix}`;
  return { snippet, matchStart: prefix.length + (matchIndex - start) };
};

// Search the prebuilt index. Returns one hit per matching page (with an occurrence
// count), ordered by chapter then page — the order the reader presents them.
export const searchBookIndex = (index: ChapterPageIndex[], rawQuery: string): SearchHit[] => {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < 2) return [];

  const hits: SearchHit[] = [];
  for (const chapter of index) {
    chapter.pages.forEach((page, pageIndex) => {
      const firstIndex = page.lower.indexOf(query);
      if (firstIndex < 0) return;

      let occurrences = 0;
      let from = firstIndex;
      while (from >= 0) {
        occurrences += 1;
        from = page.lower.indexOf(query, from + query.length);
      }

      const { snippet, matchStart } = buildSnippet(page.text, firstIndex, query.length);
      // Anchor = the matched text plus a little following context (~64 chars) — enough to be unique within
      // the chapter and short enough to sit on one reader page. The reader normalises it (wordsOnly) and
      // finds the page containing it, so navigation is independent of the reader's live page count.
      const anchor = page.text.slice(firstIndex, firstIndex + 64);
      hits.push({
        chapterId: chapter.chapterId,
        chapterTitle: chapter.chapterTitle,
        chapterNumber: chapter.chapterNumber,
        pageIndex,
        pageNumber: pageIndex + 1,
        snippet,
        matchStart,
        matchLength: query.length,
        occurrences,
        anchor,
      });
    });
  }
  return hits;
};
