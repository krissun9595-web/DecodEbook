
import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { Upload, BookOpen, Headphones, Image as ImageIcon, BookA, Film, Menu, X, ChevronRight, FileText, Mic2, Settings as SettingsIcon, Library as LibraryIcon, Tag, Bookmark, Notebook as NotebookIcon, Terminal, Shield, HardDrive, User as UserIcon, Trash2, Search } from 'lucide-react';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';
import { BookStructure, Chapter, AppView, Tab, FileContext, AppSettings, LibraryItem, NotebookItem, ReaderPageTarget, PdfOutlineItem } from './types';
import { analyzeBookStructure, getQuickDefinition, batchGetDefinitions, setGeminiApiKey, setLLMModel, setTTSModel, setImageModel, setVideoModel } from './services/gemini';
import { SettingsModal } from './components/SettingsModal';
import { AuthGate } from './components/AuthModal';
import { GlobalContextLayer } from './components/GlobalContextLayer';
import { Loader } from './components/ui/Loader';
import { AIAssistant } from './components/AIAssistant';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { AccountPanel } from './components/PricingModal';
import { LandingPage } from './components/LandingPage';
import { fetchUserTier, UserTier } from './services/stripe';
import { getSession, loadUserSettings, saveUserSettings, isSupabaseConfigured, bootstrapSupabase, onAuthStateChange, handleOAuthCallback } from './services/supabase';
import { startSession, trackEvent, trackBookAction, trackNavigation, trackGeneration } from './utils/analytics';
import { trackReferralClick, registerReferralSignup } from './services/referral';
import { saveBookToCloud, deleteBookFromCloud, loadLibraryFromCloud, saveNotebookToCloud, loadNotebookFromCloud, saveReadingPosition, loadReadingPositions, mergeLibrary, mergeNotebook, debounce } from './services/librarySync';
import { saveFile, getFile, deleteFile, listFiles, buildCacheKey, clearBook } from './services/fileCache';
import { buildChaptersFromOutline, buildSourceIndexedChapters, computeSourceHash, expandTopicSectionsIntoChapters, findHeadingOffsetByTitle, headingMatchesTitle, isUsableEpubOutline, isUsablePdfOutline, splitDetectedBackMatter } from './utils/sourceIndex';
import { PDF_TEXT_EXTRACTION_VERSION, EPUB_TEXT_EXTRACTION_VERSION, expectedExtractorVersion, isStaleExtraction } from './utils/sourceVersion';
import { isReadableChapterTitle } from './utils/structureAnalysis';
import { buildBookPageIndex, searchBookIndex, ChapterPageIndex, SearchHit } from './utils/searchIndex';
import { computePageTargetSize } from './utils/readerStructure';
import type { User } from '@supabase/supabase-js';

const lazyRetry = <T,>(factory: () => Promise<T>): Promise<T> =>
  factory().catch(() => {
    const reloaded = sessionStorage.getItem('chunk_reload');
    if (!reloaded) {
      sessionStorage.setItem('chunk_reload', '1');
      window.location.reload();
    }
    sessionStorage.removeItem('chunk_reload');
    return factory();
  });

const PodcastPlayer = React.lazy(() => lazyRetry(() => import('./components/PodcastPlayer').then(m => ({ default: m.PodcastPlayer }))));
const Visualizer = React.lazy(() => lazyRetry(() => import('./components/Visualizer').then(m => ({ default: m.Visualizer }))));
const VideoSummary = React.lazy(() => lazyRetry(() => import('./components/VideoSummary').then(m => ({ default: m.VideoSummary }))));
const AudioBook = React.lazy(() => lazyRetry(() => import('./components/AudioBook').then(m => ({ default: m.AudioBook }))));
const Notebook = React.lazy(() => lazyRetry(() => import('./components/Notebook').then(m => ({ default: m.Notebook }))));
const GeneratedFilesPanel = React.lazy(() => lazyRetry(() => import('./components/GeneratedFilesPanel').then(m => ({ default: m.GeneratedFilesPanel }))));

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();

// Piracy re-distribution watermarks (a URL/domain the SOURCE book never had, stamped at page tops and
// before notes by the site that leaked it). Never real content — filtered from links AND standalone text.
export const WATERMARK_RE = /\b(?:oceanofpdf|z-?lib(?:rary)?|1lib|b-ok|libgen|annas?[-\s]?archive|pdfdrive|memoware|dokumen\.pub)\b|z-lib\.\w+|1lib\.\w+/i;

// Strip the watermark TOKEN from the assembled CONTENT (not just at render). Previously only standalone
// watermark PARAGRAPHS were dropped at display, so the text leaked into SEARCH + TTS + translation, and a
// page-seam-merged case ("*OceanofPDF.com* [[PAGE 14]] Special thanks…") stayed visible. This removes the
// domain token wherever it sits — with its own leading paragraph sentinels/emphasis/indent (U+E000–F8FF)
// and trailing markup — preserving the real text and the [[PAGE n]] markers around it, then collapses the
// blank line it leaves. Verified on all 4 test PDFs: BHI 81→0 watermarks, real prose + page markers intact,
// the other three (no watermark) byte-unchanged. The domains are distinctive, so no false removal.
const WM_TOKEN_RE = /[ \t -]*[*_~`]*\[?[ \t]*(?:oceanofpdf|z-?lib(?:rary)?|1lib|b-ok|libgen|annas?[-\s]?archive|pdfdrive|memoware|dokumen)(?:\.[a-z]{2,4})?\b[ \t]*\]?(?:\([^)\n]*\))?[*_~`]*/gi;
export const stripPiracyWatermarks = (text: string): string =>
  text.replace(WM_TOKEN_RE, '').replace(/[^\S\n]+$/gm, '').replace(/\n{3,}/g, '\n\n');

// EPUB 3 Structural Semantics (epub:type) + W3C DPUB-ARIA (role="doc-*") — the publisher's OWN, standardized
// declaration of a section's purpose. Authoritative where present, so it's the FIRST signal for naming a
// spine file (ahead of the content heuristics, which only exist for EPUBs that carry no semantics — Elon,
// Transurfing). Maps a specific type token → the canonical reader name. Matter GROUP tokens (frontmatter/
// bodymatter/backmatter) and a bare chapter/part are intentionally absent → caller falls back to the heading.
const EPUB_TYPE_NAME: Record<string, string> = {
  cover: 'Cover', titlepage: 'Title Page', 'copyright-page': 'Copyright', copyright: 'Copyright',
  dedication: 'Dedication', epigraph: 'Epigraph', toc: 'Contents', colophon: 'Colophon',
  acknowledgments: 'Acknowledgments', acknowledgements: 'Acknowledgments', foreword: 'Foreword',
  preface: 'Preface', prologue: 'Prologue', introduction: 'Introduction', epilogue: 'Epilogue',
  afterword: 'Afterword', conclusion: 'Conclusion', bibliography: 'Bibliography', glossary: 'Glossary',
  index: 'Index', endnotes: 'Notes', footnotes: 'Notes', notes: 'Notes', appendix: 'Appendix',
};
const DPUB_ROLE_TYPE: Record<string, string> = {
  'doc-cover': 'cover', 'doc-toc': 'toc', 'doc-dedication': 'dedication', 'doc-acknowledgments': 'acknowledgments',
  'doc-foreword': 'foreword', 'doc-preface': 'preface', 'doc-introduction': 'introduction', 'doc-epilogue': 'epilogue',
  'doc-afterword': 'afterword', 'doc-conclusion': 'conclusion', 'doc-bibliography': 'bibliography', 'doc-glossary': 'glossary',
  'doc-index': 'index', 'doc-endnotes': 'endnotes', 'doc-appendix': 'appendix', 'doc-epigraph': 'epigraph',
};
const EPUB_MATTER_GROUP = new Set(['frontmatter', 'bodymatter', 'backmatter']);
// Canonical semantic { type token, reader name } for a spine file from its epub:type / DPUB-ARIA role, or
// null when it carries no SPECIFIC type (a plain chapter, or a semantics-free EPUB) — caller then falls back
// to nav/heading/heuristics. `type` is the raw token (endnotes/index/toc/cover/…) for structural routing;
// `name` is the display name.
export const epubSemantic = (doc: Document): { type: string; name: string } | null => {
  const els = [doc.body, ...Array.from(doc.querySelectorAll('section, nav'))].filter(Boolean) as Element[];
  for (const el of els) {
    for (const ty of (el.getAttribute('epub:type') || '').toLowerCase().split(/\s+/)) {
      if (!EPUB_MATTER_GROUP.has(ty) && EPUB_TYPE_NAME[ty]) return { type: ty, name: EPUB_TYPE_NAME[ty] };
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (DPUB_ROLE_TYPE[role]) { const t = DPUB_ROLE_TYPE[role]; return { type: t, name: EPUB_TYPE_NAME[t] || '' }; }
  }
  return null;
};

const SOURCE_CACHE_CHAPTER_ID = 0;
const SOURCE_CACHE_VERSION = 'v4-internal-link-normalization';
const PREVIOUS_SOURCE_CACHE_VERSION = 'v3-pdf-paragraph-boundary-corrections';
const LEGACY_SOURCE_CACHE_VERSION = 'v1';
const SOVEREIGN_CACHE_PURGE_PREFIX = 'decodebook_cache_purge_sovereign_individual_v1';
const TARGET_LANGUAGES = [
  'Original',
  'Arabic',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Dutch',
  'English',
  'French',
  'German',
  'Hindi',
  'Indonesian',
  'Italian',
  'Japanese',
  'Korean',
  'Polish',
  'Portuguese',
  'Russian',
  'Spanish',
  'Swedish',
  'Thai',
  'Turkish',
  'Vietnamese',
];

const sourceCacheKey = (bookId: string, version = SOURCE_CACHE_VERSION) =>
  buildCacheKey(bookId, SOURCE_CACHE_CHAPTER_ID, 'source-file', version);

// The ORIGINAL uploaded file bytes (PDF/EPUB), kept so a book whose extraction engine is stale can be
// re-extracted automatically (no manual re-upload). One per book, overwritten on re-upload; best-effort
// (a save failure — e.g. quota — just falls back to the re-upload prompt). NOT versioned by engine: it's
// the raw file, engine-independent, so it survives extractor bumps.
const originalFileKey = (bookId: string) =>
  buildCacheKey(bookId, SOURCE_CACHE_CHAPTER_ID, 'original-file', 'v1');

const isSovereignIndividualTitle = (value?: string): boolean =>
  /sovereign\s+individual/iu.test(value || '');

// A URL can legitimately contain parentheses (a cell.com PII link
// "…/S0960-9822(06)02290-1.pdf"). Markdown's `[label](href)` — and every `[^)]+` href
// parser in this codebase (the collapse below, the reader's inline renderer) — closes the
// href at the first ")", so a bare paren truncates the link and spills the tail as text.
// Percent-encode parens in the HREF position only (browsers decode %28/%29, so clicks still
// resolve); the visible LABEL keeps literal parens. `showHref` reverses it for a label.
// Internal anchors (#note/#pdfnote) never carry parens, so they're left untouched.
const wireHref = (url: string): string => (url.startsWith('#') ? url : url.replace(/\(/g, '%28').replace(/\)/g, '%29'));
// The human-readable form of a URL, for DISPLAY (the link label) and for matching against the
// on-page glyphs — percent-escapes decoded back to their characters, so a URL whose annotation
// encodes a character the page shows literally (an em-dash "%E2%80%94" → "—", or the parens above)
// is displayed and RECONSTRUCTED against what the reader actually sees, not the escaped bytes.
// Falls back to the raw URL if decoding fails or would introduce a markdown-breaking "]"/"["/newline.
const showHref = (url: string): string => {
  try { const decoded = decodeURIComponent(url); return /[[\]\n]/u.test(decoded) ? url : decoded; } catch { return url; }
};

const sanitizeInternalLinkMarkup = (content: string): string =>
  content.replace(/\[\s*([^\]\n]{1,120}?)\s*\]\s*\(([^)\n]+)\)/g, (match, rawLabel: string, rawHref: string) => {
    const label = rawLabel.replace(/\s+/g, ' ').trim();
    const href = rawHref.trim();
    return label && href ? `[${label}](${href})` : match;
  });

const hydrateFileContext = (fileContext: FileContext): FileContext => {
  if (!fileContext.content) return fileContext;
  const content = sanitizeInternalLinkMarkup(fileContext.content);
  return {
    ...fileContext,
    content,
    sourceHash: computeSourceHash(content),
  };
};

const hydrateLibraryItem = (item: LibraryItem): LibraryItem => {
  if (!item.fileContext.content) return item;

  // (B) Stale extraction: drop the content so the book cleanly prompts a re-upload instead of
  // rendering text this engine version can't interpret. This is the single gate that the render
  // path lacked — it covers both the stored-content and source-cache paths, since the version
  // stamp travels on fileContext regardless of where the text was loaded from.
  if (isStaleExtraction(item.fileContext.sourceKind, item.fileContext.sourceExtractorVersion)) {
    return { ...item, fileContext: { ...item.fileContext, content: undefined } };
  }

  const fileContext = hydrateFileContext(item.fileContext);
  const readableChapters = item.book.chapters.filter(chapter =>
    isReadableChapterTitle(chapter.title) &&
    isReadableChapterTitle(chapter.sourceHeading || chapter.title)
  );
  // Mirror the upload path (finalizeUpload): when the PDF carries a usable bookmark outline, build
  // chapters from it — the page destinations are authoritative. Without this, a reload rebuilt
  // chapters purely by heuristic title-matching (buildSourceIndexedChapters), which mis-scored the
  // one-word "Index" chapter against an "index" string inside the endnotes (Stanford "AI Index"
  // URLs, "…/index.html" links) — starting Index deep in the Notes and swallowing the endnotes. The
  // outline survives the reload on fileContext.pdfOutline, so reload now agrees with fresh upload.
  // EPUB carries the same authoritative outline (from its nav/NCX, offsets already resolved), so it
  // takes the same builder — additive, the PDF branch is unchanged.
  const useOutline =
    (fileContext.sourceKind === 'pdf' && isUsablePdfOutline(fileContext.content, fileContext.pdfOutline)) ||
    (fileContext.sourceKind === 'epub' && isUsableEpubOutline(fileContext.pdfOutline));
  const chapters = useOutline
    ? buildChaptersFromOutline(fileContext.content, fileContext.pdfOutline!)
    : fileContext.isText
    ? splitDetectedBackMatter(
        fileContext.content,
        buildSourceIndexedChapters(
          fileContext.content,
          expandTopicSectionsIntoChapters(
            fileContext.content,
            buildSourceIndexedChapters(fileContext.content, readableChapters),
            10
          )
        )
      )
    : readableChapters;

  return {
    ...item,
    book: { ...item.book, chapters },
    fileContext,
  };
};

const saveSourceToCache = async (item: LibraryItem): Promise<void> => {
  if (!item.fileContext.content) return;
  const content = sanitizeInternalLinkMarkup(item.fileContext.content);
  const blob = new Blob([content], { type: 'text/plain' });
  await saveFile(sourceCacheKey(item.book.id), blob, {
    filename: `source-${item.book.id}.txt`,
    mimeType: item.fileContext.mimeType,
    timestamp: Date.now(),
    bookId: item.book.id,
    chapterId: SOURCE_CACHE_CHAPTER_ID,
    componentSource: 'source-cache',
    fileType: 'source-file',
  });
};

const purgeSovereignIndividualDerivedCache = async (item: LibraryItem): Promise<void> => {
  const purgeKey = `${SOVEREIGN_CACHE_PURGE_PREFIX}:${item.book.id}`;
  if (localStorage.getItem(purgeKey) === '1') return;
  if (!isSovereignIndividualTitle(item.book.title)) return;

  if (item.fileContext.content) {
    await saveSourceToCache(item);
  }

  const currentSourceKey = sourceCacheKey(item.book.id);
  const keepKey = originalFileKey(item.book.id); // never purge the ORIGINAL file — it's needed to re-extract
  const files = await listFiles(item.book.id);
  await Promise.all(files
    .filter(file => file.key !== currentSourceKey && file.key !== keepKey)
    .map(file => deleteFile(file.key).catch(() => undefined))
  );
  localStorage.setItem(purgeKey, '1');
};

const restoreLibrarySources = async (items: LibraryItem[]): Promise<LibraryItem[]> => {
  const restored = await Promise.all(items.map(async item => {
    // (A) Stale PDF extraction: purge the cached text so a re-upload re-extracts cleanly. The
    // source cache key is shared across engine versions (it uses SOURCE_CACHE_VERSION, not the
    // extractor version), so after a rollback it would otherwise keep handing back the old text.
    // hydrateLibraryItem then drops the stale content, surfacing the re-upload prompt (B).
    if (isStaleExtraction(item.fileContext.sourceKind, item.fileContext.sourceExtractorVersion)) {
      deleteFile(sourceCacheKey(item.book.id)).catch(() => undefined);
      return hydrateLibraryItem(item);
    }
    if (item.fileContext.content) return hydrateLibraryItem(item);
    try {
      const sourceVersions = [
        SOURCE_CACHE_VERSION,
        PREVIOUS_SOURCE_CACHE_VERSION,
        ...(item.fileContext.sourceKind === 'pdf' ? [LEGACY_SOURCE_CACHE_VERSION] : []),
      ];
      let cached = null;
      for (const version of sourceVersions) {
        cached = await getFile(sourceCacheKey(item.book.id, version));
        if (cached) break;
      }
      if (!cached) return item;
      return {
        ...hydrateLibraryItem({
          ...item,
          fileContext: {
            ...item.fileContext,
            content: await cached.blob.text(),
          },
        }),
      };
    } catch {
      return item;
    }
  }));
  return restored;
};

const App: React.FC = () => {
  const [view, setView] = useState<AppView>(AppView.LANDING);
  const [landingVariant, setLandingVariant] = useState<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'>('A');
  const unsubRef = useRef<(() => void) | null>(null);

  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [cloudSynced, setCloudSynced] = useState(false);

  // Notebook State
  const [notebook, setNotebook] = useState<NotebookItem[]>([]);

  const activeBook = library.find(item => item.book.id === activeBookId)?.book || null;
  const activeFileContext = library.find(item => item.book.id === activeBookId)?.fileContext || null;

  const [activeChapterId, setActiveChapterId] = useState<number | null>(null);
  const [activeChapterPageTarget, setActiveChapterPageTarget] = useState<ReaderPageTarget>('first');
  // Last in-chapter reading position per book:chapter (a pagination-independent anchor), so switching
  // modules and returning to the reader restores the page you left off on instead of jumping to page 1.
  const readingPositionRef = useRef<Map<string, ReaderPageTarget>>(new Map());
  // Parts collapsed in the nested TOC (by chapter id). Default expanded.
  const [collapsedParts, setCollapsedParts] = useState<Set<number>>(new Set());
  const activeChapter = activeBook?.chapters.find(c => c.id === activeChapterId) || null;

  // --- Full-text search (sidebar) ---------------------------------------------
  // Self-contained: indexes the active book's reader text and navigates via the
  // same chapter/page primitives the TOC already uses, so it never touches the
  // reader/audio/translation modules.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchActive, setSearchActive] = useState(false); // a query has been run
  const [isIndexing, setIsIndexing] = useState(false);
  // The page-target size the reader is CURRENTLY paginating with (reported by AudioBook). The search box
  // is only visible while the sidebar is open (a narrowed reader), so the search must paginate at the
  // reader's CURRENT width — its "PG.NN" then matches exactly what the reader shows in that state, and a
  // result click lands on the same page. STATE (not a ref) + a search-effect dep: the reader re-paginates
  // a couple of times per load (fallback → measured, and on sidebar toggle), so the search MUST rebuild
  // when this changes, or its numbers go stale relative to what the reader now displays (they'd mismatch,
  // even swap). When the sidebar closes to full view, the reader recomputes its own pages and the search
  // UI is gone, so there's never a visible mismatch.
  const [readerPageSize, setReaderPageSize] = useState<number | null>(null);
  const readerSizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The reader re-paginates a few times right after a chapter loads (a fallback size before the text
  // column is measured, then the measured size, then font/layout settling). Commit the size to state only
  // once it STOPS changing (~500ms stable), so the search doesn't rebuild on every intermediate value and
  // its result page numbers don't flicker for several seconds.
  const reportReaderSize = React.useCallback((size: number) => {
    if (readerSizeTimerRef.current) clearTimeout(readerSizeTimerRef.current);
    readerSizeTimerRef.current = setTimeout(() => setReaderPageSize(prev => (prev === size ? prev : size)), 500);
  }, []);
  const searchIndexCache = useRef<Map<string, ChapterPageIndex[]>>(new Map());
  const activeChapterItemRef = useRef<HTMLDivElement | null>(null);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setSearchActive(false);
    setIsIndexing(false);
  }, []);

  // Plain function (not useCallback) so it doesn't reference currentUser at render
  // time — currentUser is declared further down; the body runs only on click.
  const handleSearchResultClick = (hit: SearchHit) => {
    // Navigate by the matched TEXT, not a page index: the reader's page count depends on its live width,
    // so a fixed index lands on the wrong page. The anchor is located in whatever pagination the reader
    // has and RE-located after re-pagination.
    setActiveChapterPageTarget({ type: 'text', anchor: hit.anchor });
    setActiveChapterId(hit.chapterId);
    if (currentUser && activeBookId) debouncedReadingSync(currentUser.id, activeBookId, hit.chapterId);
    closeSidebarMobile();
    // Keep the result list open (desktop) — the reader is at the same width the result was labelled for,
    // so the anchor lands on exactly that page. The user can jump to other results freely.
  };

  // Reset search when the open book changes.
  useEffect(() => { clearSearch(); }, [activeBookId, clearSearch]);

  // Debounced search: build (and cache) the book index lazily, then match.
  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2 || !activeBook || !activeFileContext?.content) {
      setSearchResults([]);
      setSearchActive(query.length >= 2);
      return;
    }
    let cancelled = false;
    setIsIndexing(true);
    const handle = setTimeout(() => {
      try {
        // Key the search index on the page target size too: the reader paginates with the responsive
        // computePageTargetSize, so the index must use the SAME size or its "PG.NN" won't match the
        // reader's page number. Use the size the reader is CURRENTLY paginating with (readerPageSize,
        // reported by AudioBook) so the search's "PG.NN" equals what the reader shows in the current
        // (sidebar-open) state — stable because it's the reader's SETTLED size, not an independent
        // re-measurement of a transient layout. Fall back to a fresh compute only before the reader has
        // paginated.
        const pageTargetSize = readerPageSize ?? computePageTargetSize(settings.textSize, settings.lineHeight);
        const indexKey = `${activeBook.id}:${pageTargetSize}`;
        let index = searchIndexCache.current.get(indexKey);
        if (!index) {
          index = buildBookPageIndex(activeFileContext.content, activeBook.chapters, pageTargetSize);
          searchIndexCache.current.set(indexKey, index);
        }
        if (cancelled) return;
        setSearchResults(searchBookIndex(index, query));
        setSearchActive(true);
      } finally {
        if (!cancelled) setIsIndexing(false);
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [searchQuery, activeBook, activeFileContext, readerPageSize]);

  // Scroll the TOC so the active chapter is in view after a jump.
  useEffect(() => {
    activeChapterItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeChapterId]);

  const [activeTab, setActiveTab] = useState<Tab>(Tab.AUDIOBOOK);
  const [isSidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLibraryList, setShowLibraryList] = useState(false);
  const [pendingLanguagePromptBookId, setPendingLanguagePromptBookId] = useState<string | null>(null);
  
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isFilesOpen, setIsFilesOpen] = useState(false);
  const [userTier, setUserTier] = useState<UserTier | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authGatePassed, setAuthGatePassed] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    targetLanguage: 'Spanish',
    highlightColor: 'indigo',
    inkLine: 'full',
    textSize: 'base',
    lineHeight: 'normal',
    letterSpacing: 'normal',
    textAlign: 'auto',
    font: 'Inter',
    llmModel: 'gemini-3-flash-preview',
    ttsModel: 'gemini-3.1-flash-tts-preview',
    imageModel: 'gemini-3-pro-image-preview',
    videoModel: 'veo-3.1-fast-generate-preview'
  });

  useEffect(() => {
    if (!activeBook || activeBook.chapters.length === 0) return;
    if (activeChapterId != null && activeBook.chapters.some(chapter => chapter.id === activeChapterId)) return;
    setActiveChapterPageTarget('first');
    setActiveChapterId(activeBook.chapters[0].id);
  }, [activeBook, activeChapterId]);

  useEffect(() => {
      let cancelled = false;
      const params = new URLSearchParams(window.location.search);
      const v = params.get('v');
      if (v === 'B' || v === 'b') setLandingVariant('B');
      else if (v === 'C' || v === 'c') setLandingVariant('C');
      else if (v === 'D' || v === 'd') setLandingVariant('D');
      else if (v === 'E' || v === 'e') setLandingVariant('E');
      else if (v === 'F' || v === 'f') setLandingVariant('F');
      else if (v === 'G' || v === 'g') setLandingVariant('G');

      // Handle referral link
      const refCode = params.get('ref');
      if (refCode) {
        trackReferralClick(refCode).then(referrerId => {
          if (referrerId) localStorage.setItem('referrer_id', referrerId);
        });
        window.history.replaceState({}, '', window.location.pathname);
      }

      const savedNotebook = localStorage.getItem('notebook');
      if (savedNotebook) setNotebook(JSON.parse(savedNotebook));

      const savedLibrary = localStorage.getItem('library');
      if (savedLibrary) {
        const parsed = JSON.parse(savedLibrary);
        // Extraction-version audit — opt-in (set localStorage.dbgVersion = '1' to enable). Dumps each
        // book's recorded vs expected extractor version + staleness on load.
        try {
          if (localStorage.getItem('dbgVersion') === '1') {
            console.log('%c[extraction-version] expected  PDF =', 'color:#00e5ff', PDF_TEXT_EXTRACTION_VERSION, ' EPUB =', EPUB_TEXT_EXTRACTION_VERSION);
            console.table(parsed.map((it: any) => ({
              title: it?.book?.title,
              kind: it?.fileContext?.sourceKind,
              recorded: it?.fileContext?.sourceExtractorVersion ?? '(none)',
              expected: expectedExtractorVersion(it?.fileContext?.sourceKind) ?? '(n/a)',
              stale: isStaleExtraction(it?.fileContext?.sourceKind, it?.fileContext?.sourceExtractorVersion),
            })));
          }
        } catch {}
        setLibrary(parsed);
        if (parsed.length > 0) setView(AppView.UPLOAD);
        restoreLibrarySources(parsed).then(restored => {
          if (cancelled) return;
          setLibrary(restored);
          const firstUsable = restored.find(item => item.fileContext.content);
          if (firstUsable && !activeBookId) {
            setActiveBookId(firstUsable.book.id);
            if (firstUsable.book.chapters.length > 0) {
              setActiveChapterPageTarget('first');
              setActiveChapterId(firstUsable.book.chapters[0].id);
            }
            setView(AppView.DASHBOARD);
          }
        }).catch(e => console.warn('[source-cache] Failed to restore sources:', e));
      }

      const savedSettings = localStorage.getItem('app_settings');
      if (savedSettings) {
        try {
          const parsed = JSON.parse(savedSettings);
          if (parsed.ttsModel === 'gemini-2.5-flash-preview-tts') parsed.ttsModel = 'gemini-3.1-flash-tts-preview';
          setSettings(prev => ({ ...prev, ...parsed }));
          if (parsed.geminiKey) setGeminiApiKey(parsed.geminiKey);
          if (parsed.llmModel) setLLMModel(parsed.llmModel);
          if (parsed.ttsModel) setTTSModel(parsed.ttsModel);
          if (parsed.imageModel) setImageModel(parsed.imageModel);
          if (parsed.videoModel) setVideoModel(parsed.videoModel);
        } catch (e) {}
      }

      // Handle Stripe checkout return
      const checkoutParam = new URLSearchParams(window.location.search).get('checkout');
      if (checkoutParam === 'success') {
        window.history.replaceState({}, '', window.location.pathname);
        setTimeout(() => { fetchUserTier().then(setUserTier).catch(() => {}); }, 2000);
      }

      bootstrapSupabase().then(async () => {
        if (localStorage.getItem('auth_gate_skipped')) setAuthGatePassed(true);
        // Explicitly exchange OAuth code if present in URL (PKCE flow)
        const oauthSession = await handleOAuthCallback();
        if (oauthSession) return oauthSession;
        return getSession();
      }).then(session => {
        if (session?.user) {
          setCurrentUser(session.user);
          setAuthGatePassed(true);
          startSession();
          loadUserSettings(session.user.id).then(remote => {
            if (remote) {
              setSettings(prev => ({
                ...prev,
                targetLanguage: remote.target_language || prev.targetLanguage,
                highlightColor: (remote.highlight_color as any) || prev.highlightColor,
                textSize: (remote.text_size as any) || prev.textSize,
                lineHeight: (remote.line_height as any) || prev.lineHeight,
                letterSpacing: (remote.letter_spacing as any) || prev.letterSpacing,
                font: remote.font || prev.font,
                llmModel: remote.llm_model || prev.llmModel,
                ttsModel: remote.tts_model || prev.ttsModel,
                imageModel: remote.image_model || prev.imageModel,
                videoModel: remote.video_model || prev.videoModel,
                geminiKey: remote.gemini_key || prev.geminiKey,
                openrouterKey: remote.openrouter_key || prev.openrouterKey,
              }));
            }
          }).catch(e => console.warn('[Supabase] Failed to load settings:', e));
          fetchUserTier().then(setUserTier).catch(() => {});
          // Cloud library sync
          const uid = session.user.id;
          Promise.all([loadLibraryFromCloud(uid), loadNotebookFromCloud(uid), loadReadingPositions(uid)]).then(([cloudLib, cloudNotes, positions]) => {
            setLibrary(prev => {
              const { merged, toUpload } = mergeLibrary(prev, cloudLib);
              const hydrated = merged.map(hydrateLibraryItem);
              toUpload.map(hydrateLibraryItem).forEach(item => saveBookToCloud(uid, item).catch(() => {}));
              hydrated.forEach(item => saveSourceToCache(item).catch(() => {}));
              if (hydrated.length > 0 && !activeBookId) {
                const firstBook = hydrated[0];
                setActiveBookId(firstBook.book.id);
                const pos = positions[firstBook.book.id];
                setActiveChapterPageTarget('first');
                if (pos != null) setActiveChapterId(pos);
                else if (firstBook.book.chapters.length > 0) setActiveChapterId(firstBook.book.chapters[0].id);
                if (hydrated.some(m => m.fileContext.content)) setView(AppView.DASHBOARD);
              }
              return hydrated;
            });
            setNotebook(prev => {
              const merged = mergeNotebook(prev, cloudNotes);
              return merged;
            });
            setCloudSynced(true);
          }).catch(e => console.warn('[sync] Cloud sync failed:', e));
        }
      }).catch(e => console.warn('[Supabase] Failed to get session:', e))
        .finally(() => {
          setConfigReady(true);
          // Listen for OAuth callback redirects after client is ready
          const cleanup = onAuthStateChange((user) => {
            if (user) {
              setCurrentUser(user);
              setAuthGatePassed(true);
              // Link referral if user just signed up via a referral link
              const referrerId = localStorage.getItem('referrer_id');
              if (referrerId) {
                registerReferralSignup(referrerId).then(() => localStorage.removeItem('referrer_id'));
              }
            }
          });
          if (cleanup) unsubRef.current = cleanup;
        });

      return () => {
        cancelled = true;
        if (unsubRef.current) unsubRef.current();
      };
  }, []);

  useEffect(() => {
      try {
        localStorage.setItem('notebook', JSON.stringify(notebook));
      } catch (e) {
        console.warn('Failed to save notebook to localStorage:', e);
      }
      if (currentUser && cloudSynced) debouncedNotebookSync(currentUser.id, notebook);
  }, [notebook]);

  useEffect(() => {
      try {
        library.forEach(item => saveSourceToCache(item).catch(() => {}));
        // Save library metadata only — fileContext contains large base64 data
        // that can exceed localStorage's ~5MB limit with multiple books
        const libraryMeta = library.map(item => ({
          book: item.book,
          fileContext: { ...item.fileContext, content: '' },
          uploadDate: item.uploadDate
        }));
        localStorage.setItem('library', JSON.stringify(libraryMeta));
      } catch (e) {
        console.warn('Failed to save library to localStorage (likely quota exceeded):', e);
      }
  }, [library]);

  useEffect(() => {
    library
      .filter(item => isSovereignIndividualTitle(item.book.title))
      .forEach(item => purgeSovereignIndividualDerivedCache(item).catch(error => {
        console.warn('Sovereign Individual cache purge failed:', error);
      }));
  }, [library]);

  // Persist settings to localStorage + Supabase, and sync API key
  useEffect(() => {
      localStorage.setItem('app_settings', JSON.stringify(settings));
      if (settings.geminiKey) setGeminiApiKey(settings.geminiKey);
      if (settings.llmModel) setLLMModel(settings.llmModel);
      if (settings.ttsModel) setTTSModel(settings.ttsModel);
      if (settings.imageModel) setImageModel(settings.imageModel);
      if (settings.videoModel) setVideoModel(settings.videoModel);
      if (currentUser) {
        saveUserSettings(currentUser.id, {
          target_language: settings.targetLanguage,
          highlight_color: settings.highlightColor,
          text_size: settings.textSize,
          line_height: settings.lineHeight,
          letter_spacing: settings.letterSpacing,
          font: settings.font,
          gemini_key: settings.geminiKey,
          openrouter_key: settings.openrouterKey,
          llm_model: settings.llmModel,
          tts_model: settings.ttsModel,
          image_model: settings.imageModel,
          video_model: settings.videoModel,
        }).catch(() => {});
      }
  }, [settings, currentUser]);

  const handleAddToNotebook = (item: Omit<NotebookItem, 'id' | 'timestamp'>) => {
      // Clean text: remove ** characters and trim whitespace
      const cleanText = item.text.replace(/\*\*/g, '').trim();

      const normalizedContextSource =
          item.inked === true && item.contextSource && !/inked/i.test(item.contextSource)
              ? `${item.contextSource}:INKED`
              : item.inked === false && item.contextSource
                  ? item.contextSource.replace(/:INKED/ig, '')
              : item.contextSource;

      const existing = notebook.find(n => n.text === cleanText);
      if (existing) {
          setNotebook(prev => prev.map(n => {
              if (n.text !== cleanText) return n;
              return {
                  ...n,
                  definition: item.definition || n.definition,
                  comment: item.comment !== undefined ? item.comment : n.comment,
                  contextSource: normalizedContextSource || n.contextSource,
                  inked: item.inked !== undefined ? item.inked : n.inked,
              };
          }));
          return;
      }

      if (item.inked === false && !item.definition && item.comment === undefined) {
          return;
      }

      // Improved classification logic for Words vs Phrases vs Sentences
      let detectedType: 'word' | 'phrase' | 'sentence' = 'word';
      const wordCount = cleanText.split(/\s+/).length;
      
      if (wordCount === 1 || cleanText.length < 15) {
          detectedType = 'word';
      } else if (wordCount <= 6 && cleanText.length < 50) {
          detectedType = 'phrase';
      } else {
          detectedType = 'sentence';
      }

      const newItem: NotebookItem = {
          ...item,
          text: cleanText,
          contextSource: normalizedContextSource,
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          type: detectedType,
          sourceChapter: activeChapter?.title,
          bookTitle: activeBook?.title,
          bookAuthor: activeBook?.author
      };
      
      setNotebook(prev => [newItem, ...prev]);

      // If no definition is provided (e.g., quick add), fetch one in background
      if (!item.definition) {
          getQuickDefinition(cleanText, settings.targetLanguage)
              .then(def => {
                  handleBatchUpdateDefinitions({ [newItem.id]: def });
              })
              .catch(err => {
                  console.error("Auto-definition fetch failed during add:", err);
              });
      }
  };

  const handleDeleteBook = (bookId: string) => {
    const book = library.find(item => item.book.id === bookId)?.book;
    trackBookAction('delete', { title: book?.title }, bookId);
    if (currentUser) deleteBookFromCloud(currentUser.id, bookId).catch(() => {});
    deleteFile(sourceCacheKey(bookId)).catch(() => {});
    setLibrary(prev => prev.filter(item => item.book.id !== bookId));
    if (activeBookId === bookId) {
      const remaining = library.filter(item => item.book.id !== bookId);
      if (remaining.length > 0) {
        setActiveBookId(remaining[0].book.id);
        if (remaining[0].book.chapters.length > 0) {
          setActiveChapterPageTarget('first');
          setActiveChapterId(remaining[0].book.chapters[0].id);
        }
      } else {
        setActiveBookId(null);
        setView(AppView.UPLOAD);
      }
    }
  };

  const handleDeleteNotebookItem = (id: string) => {
      setNotebook(prev => prev.filter(i => i.id !== id));
  };
  
  const handleBulkDeleteNotebookItems = (ids: string[]) => {
      setNotebook(prev => prev.filter(i => !ids.includes(i.id)));
  };
  
  const handleUpdateNotebookComment = (id: string, comment: string) => {
      setNotebook(prev => prev.map(item => item.id === id ? { ...item, comment } : item));
  };

  const handleBatchUpdateDefinitions = (updates: Record<string, string>) => {
      setNotebook(prev => prev.map(item => {
          if (updates[item.id]) {
              return { ...item, definition: updates[item.id] };
          }
          return item;
      }));
  };

  const debouncedNotebookSync = useRef(debounce((userId: string, items: NotebookItem[]) => {
    saveNotebookToCloud(userId, items).catch(() => {});
  }, 1000)).current;

  const debouncedReadingSync = useRef(debounce((userId: string, bookId: string, chapterId: number) => {
    saveReadingPosition(userId, bookId, chapterId).catch(() => {});
  }, 500)).current;

  const prevLanguageRef = useRef(settings.targetLanguage);
  useEffect(() => {
      if (prevLanguageRef.current === settings.targetLanguage) return;
      prevLanguageRef.current = settings.targetLanguage;
      const itemsWithDefs = notebook.filter(i => i.definition);
      if (itemsWithDefs.length === 0) return;
      const batch = itemsWithDefs.map(i => ({ id: i.id, text: i.text }));
      batchGetDefinitions(batch, settings.targetLanguage)
          .then(updates => {
              if (Object.keys(updates).length > 0) handleBatchUpdateDefinitions(updates);
          })
          .catch(err => console.error('Definition re-fetch failed:', err));
  }, [settings.targetLanguage]);

  // EPUB is a STRUCTURED format (OPF spine, EPUB3 nav / EPUB2 NCX table of contents, semantic
  // HTML). Unlike PDF — where structure is reverse-engineered from geometry — we use the native
  // structure: chapters from the nav/NCX (authoritative), heading role from <h1>–<h6>, figures from
  // <img>, centre/right from CSS text-align. All emitted as the SAME sentinels the reader already
  // renders for PDF (U+E013 heading, U+E010/E011 align, [[FIG]]), so no reader/PDF code changes.
  const processEpub = async (
    file: File,
  ): Promise<{ content: string; outline: PdfOutlineItem[]; figures: ExtractedFigure[]; anchors: Record<string, string> }> => {
    try {
      const zip = await JSZip.loadAsync(file);
      const zipKeys = Object.keys(zip.files);
      const parser = new DOMParser();

      // Resolve an href (relative to baseDir) to a zip entry key. Normalises ./ and ../ segments,
      // strips the #fragment, and falls back to a suffix match when the path can't be normalised.
      const resolveZip = (href: string, baseDir: string): string | undefined => {
        const clean = decodeURIComponent((href || '').split('#')[0]).trim();
        if (!clean) return undefined;
        const segs = `${baseDir}${clean}`.split('/');
        const out: string[] = [];
        for (const s of segs) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }
        const norm = out.join('/');
        if (zip.files[norm]) return norm;
        return zipKeys.find(k => k === clean || k.endsWith(`/${clean}`) || k.endsWith(clean));
      };

      // Attempt to find the OPF file to determine reading order
      const opfPath = Object.keys(zip.files).find(f => f.toLowerCase().endsWith('.opf'));
      let sortedFiles: string[] = [];
      const manifestMeta: Record<string, { href: string; properties: string; mediaType: string }> = {};
      let navFullPath: string | undefined; // EPUB3 nav.xhtml
      let ncxFullPath: string | undefined; // EPUB2 toc.ncx
      let opfDir = '';
      let bodyStartFull: string | undefined; // OPF <guide> type="text" — where the reading body begins
      let coverFull: string | undefined;     // OPF <guide> type="cover" (or a cover-image page)
      let coverImageKey: string | undefined; // OPF cover IMAGE (properties="cover-image" / <meta name=cover>) — book metadata, not inline content
      let epubTitle: string | undefined; // OPF <dc:title> — the publisher's book title (display + re-upload dedup)

      if (opfPath) {
          // Robust EPUB Parsing via OPF Spine
          const opfContent = await zip.files[opfPath].async("string");
          const opfDoc = parser.parseFromString(opfContent, "text/xml");
          opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);
          // The publisher's <dc:title> — the book's real metadata title. Return it as the EPUB's docTitle so
          // the display title + re-upload dedup identity match the PDF path (which uses the PDF metadata
          // title). Without it the EPUB used the title INFERRED from its content title page, which can differ
          // from the PDF's metadata title (a different subtitle edition), splitting one book into two library
          // items that never dedup against each other.
          const _titleEl = opfDoc.getElementsByTagName('dc:title')[0] || opfDoc.getElementsByTagName('title')[0];
          epubTitle = _titleEl?.textContent?.replace(/\s+/g, ' ').trim() || undefined;

          // 1. Map id -> {href, properties, media-type} (Manifest). The nav doc (EPUB3) and the NCX
          //    (EPUB2) are located here so we can build authoritative chapters from the publisher TOC.
          Array.from(opfDoc.getElementsByTagName("item")).forEach(item => {
              const id = item.getAttribute("id");
              const href = item.getAttribute("href");
              if (id && href) {
                  const properties = item.getAttribute("properties") || '';
                  const mediaType = item.getAttribute("media-type") || '';
                  manifestMeta[id] = { href, properties, mediaType };
                  if (/\bnav\b/i.test(properties)) navFullPath = resolveZip(href, opfDir);
                  if (/ncx/i.test(mediaType) || /\.ncx$/i.test(href)) ncxFullPath = resolveZip(href, opfDir);
                  if (/\bcover-image\b/i.test(properties)) coverImageKey = resolveZip(href, opfDir);
              }
          });
          // EPUB2 cover convention: <meta name="cover" content="<item-id>"> points at the cover image item.
          if (!coverImageKey) {
              const cid = Array.from(opfDoc.getElementsByTagName('meta')).find(m => (m.getAttribute('name') || '').toLowerCase() === 'cover')?.getAttribute('content');
              if (cid && manifestMeta[cid] && /^image\//i.test(manifestMeta[cid].mediaType)) coverImageKey = resolveZip(manifestMeta[cid].href, opfDir);
          }

          // 2. Get spine order (idref); the NCX may also be pointed at by <spine toc="...">.
          const spineIds = Array.from(opfDoc.getElementsByTagName("itemref"))
              .map(item => item.getAttribute("idref"))
              .filter(id => id !== null) as string[];
          const tocId = opfDoc.getElementsByTagName('spine')[0]?.getAttribute('toc');
          if (!ncxFullPath && tocId && manifestMeta[tocId]) ncxFullPath = resolveZip(manifestMeta[tocId].href, opfDir);

          // 3. Resolve spine file paths (skipping the nav doc, which is metadata not reading content).
          spineIds.forEach(id => {
              const entry = manifestMeta[id];
              if (!entry) return;
              const decodedHref = decodeURIComponent(entry.href);
              const isNavDoc = /\bnav\b/i.test(entry.properties) || /(?:^|\/)(?:toc|nav)(?:[._-]|$)/i.test(decodedHref);
              if (isNavDoc) return;
              const full = resolveZip(entry.href, opfDir);
              if (full) sortedFiles.push(full);
          });

          // 4. OPF <guide> (EPUB2 landmarks): the "text" reference marks where the body begins, so the
          //    spine files before it are front matter (cover/copyright/contents); "cover" marks the cover.
          for (const ref of Array.from(opfDoc.getElementsByTagName('reference'))) {
              const type = (ref.getAttribute('type') || '').toLowerCase();
              const href = ref.getAttribute('href') || '';
              if (!href) continue;
              if ((type === 'text' || type === 'bodymatter') && !bodyStartFull) bodyStartFull = resolveZip(href, opfDir);
              if ((type === 'cover' || type === 'coverpage') && !coverFull) coverFull = resolveZip(href, opfDir);
          }
      }

      if (sortedFiles.length === 0) {
          sortedFiles = Object.keys(zip.files).filter(filename => 
            filename.match(/\.(html|xhtml|htm)$/i) &&
            !filename.includes('__MACOSX') &&
            !/(?:^|\/)(?:toc|nav)(?:[._-]|$)/i.test(filename)
          );
          sortedFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      }

      // Build a class → text-align map from the EPUB's CSS so centre/right blocks can be tagged
      // (mirrors PDF's U+E010/E011). A light regex over the stylesheets — enough for the common
      // ".center { text-align: center }" idiom without pulling in a full CSS parser.
      const cssAlign: Record<string, 'center' | 'right'> = {};
      const cssJustify = new Set<string>(); // text-align:justify — for the doc-level sourceJustified flag
      const cssLeft = new Set<string>();    // text-align:left — explicit override of an inherited justify
      // Doc-level layout tally (mirrors the PDF's line-fill measurement, but from the CSS the EPUB declares):
      // count body paragraphs, how many resolve to justified text, and how many carry a first-line indent.
      let bodyParaTally = 0, justifiedParaTally = 0, firstIndentParaTally = 0, flushDeclParaTally = 0;
      const firstIndentEms: number[] = []; // declared first-line-indent magnitudes (em) across body <p> → source median
      const cssBlock = new Set<string>();  // display:block — keep line breaks inside a heading
      const cssItalic = new Set<string>(); // font-style:italic — many books italicise via a class, not <i>
      const cssBold = new Set<string>();   // font-weight:bold/700
      const cssSmallCaps = new Set<string>(); // font-variant:small-caps — a class the reader renders small-caps
      const cssDropCap = new Set<string>();   // a class whose ::first-letter is a floated drop cap (chapter opener)
      const cssIndent: Record<string, number> = {}; // left indent (px) — for TOC/Contents sub-entries
      // The effective LEFT indent (px) a declaration block sets, from margin-left/padding-left OR the
      // `margin`/`padding` SHORTHAND's left value (4 values → 4th; 2–3 values → 2nd = left). Only a
      // positive BLOCK indent matters (a Contents sub-entry like `.ogl-zag1 { margin: 0 0 0 14px }`); NOT
      // text-indent, which is a first-line indent on ordinary body paragraphs (`body-text`, etc.).
      const leftIndentPx = (decls: string): number => {
        let px = 0;
        const m = /(?:margin-left|padding-left)\s*:\s*([\d.]+)px/i.exec(decls);
        if (m) px = Math.max(px, parseFloat(m[1]) || 0);
        for (const sh of decls.matchAll(/\b(?:margin|padding)\s*:\s*([^;}]+)/gi)) {
          const parts = sh[1].trim().split(/\s+/);
          const left = parts.length === 4 ? parts[3] : parts.length >= 2 ? parts[1] : undefined;
          const v = left && /^([\d.]+)px$/.exec(left);
          if (v) px = Math.max(px, parseFloat(v[1]) || 0);
        }
        return px;
      };
      // A CSS length → EM (px→em at 16px/em; em/rem ≈ base em; "0" → 0). Used to compute an INDEX entry's
      // rendered left indent, which the reader represents as leading NBSP.
      const lenToEm = (value: string): number | null => {
        const m = /(-?[\d.]+)\s*(em|rem|px)/i.exec(value);
        if (m) { const n = parseFloat(m[1]) || 0; return m[2].toLowerCase() === 'px' ? n / 16 : n; }
        return /^\s*0/.test(value) ? 0 : null;
      };
      // The margin-left / padding-left / text-indent (em) a declaration sets — explicit prop, else the
      // margin/padding shorthand's left value (4 → 4th, 2–3 → 2nd, 1 → all).
      const sideLeftEm = (decls: string, prop: 'margin' | 'padding'): number | null => {
        const explicit = new RegExp(`${prop}-left\\s*:\\s*([^;}]+)`, 'i').exec(decls);
        if (explicit) return lenToEm(explicit[1]);
        const sh = new RegExp(`\\b${prop}\\s*:\\s*([^;}]+)`, 'i').exec(decls);
        if (sh) { const p = sh[1].trim().split(/\s+/); const left = p.length === 4 ? p[3] : p.length >= 2 ? p[1] : p[0]; return left ? lenToEm(left) : null; }
        return null;
      };
      const cssBoxLeftEm: Record<string, { m: number; p: number; ti: number }> = {}; // class → left margin/padding/text-indent (em)
      const cssTiDeclared = new Set<string>(); // classes that EXPLICITLY declare text-indent (so ti:0 = a deliberate flush, not a default)
      const cssFontRaw: Record<string, string> = {}; // class → raw font-size value (for the U+E01B-E01F size tier)
      const cssColor: Record<string, string> = {}; // class → text `color` (a saturated accent, e.g. Transurfing's teal `.zag`)
      // Decorative horizontal RULES the EPUB draws as top/bottom BORDERS (mirrors the PDF's U+E021): a
      // `border-top/bottom: … double …` brackets a chapter DECK (`.heading_break1`), a `… solid/dashed …`
      // brackets an epigraph (`.blockquote1/2a/2b`) or tops a footnote block (`.footnote`). Only top/bottom
      // (a horizontal line) — never the `border:` all-sides shorthand (image frames) or left/right (table/
      // figure boxes). class → 'single' | 'double'.
      const cssBorderTop: Record<string, 'single' | 'double'> = {};
      const cssBorderBottom: Record<string, 'single' | 'double'> = {};
      // GENERAL selector matcher — the class-keyed maps above are the fast path for class-styled EPUBs
      // (calibre/z-library conversions: `.att`, `.calibre3`, `.indexsubentry`). PROFESSIONAL EPUBs (O'Reilly)
      // style via TAG / ATTRIBUTE / DESCENDANT selectors and ::before pseudo-elements — none of which are
      // classes — so those books resolve NOTHING through the maps. Keep every rule here so a resolver can
      // fall back to matching an element by tag + [attr] + ancestor when its class/inline lookup is empty.
      const cssRules: { sel: string; decl: string; spec: number; tag: string }[] = [];
      const cssBeforeRules: { sel: string; content: string }[] = []; // ::before { content } (e.g. attribution em-dash)
      const specOf = (sel: string): number =>
        (sel.match(/#[\w-]+/g) || []).length * 100
        + (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length * 10
        + (sel.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
      for (const key of zipKeys.filter(k => /\.css$/i.test(k))) {
        try {
          const css = await zip.files[key].async('string');
          for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            const am = /text-align\s*:\s*(center|right|justify|left)/i.exec(rule[2]);
            const isBlock = /display\s*:\s*block/i.test(rule[2]);
            const isItalic = /font-style\s*:\s*italic/i.test(rule[2]);
            const isBold = /font-weight\s*:\s*(?:bold|[6-9]00)/i.test(rule[2]);
            const isNormalWeight = /font-weight\s*:\s*(?:normal|[1-4]00)/i.test(rule[2]);
            const isNormalStyle = /font-style\s*:\s*normal/i.test(rule[2]);
            // font-variant:small-caps (or font-variant-caps) — a true typographic small-caps run/block the
            // reader can reproduce with `font-variant:small-caps` on the ORIGINAL mixed-case text (unlike a
            // `text-transform:uppercase` simulation, which is already reproduced by upper-casing). Section
            // heads, epigraph attributions, chart-data titles use it.
            const isSmallCaps = /font-variant(?:-caps)?\s*:\s*(?:all-)?small-caps/i.test(rule[2]);
            const isNormalVariant = /font-variant(?:-caps)?\s*:\s*normal/i.test(rule[2]);
            const li = leftIndentPx(rule[2]);
            const mE = sideLeftEm(rule[2], 'margin'), pE = sideLeftEm(rule[2], 'padding');
            const tiM = /text-indent\s*:\s*([^;}]+)/i.exec(rule[2]); const tiE = tiM ? lenToEm(tiM[1]) : null;
            const fsM = /font-size\s*:\s*([^;}]+)/i.exec(rule[2]); const fs = fsM ? fsM[1].trim() : null;
            // text `color` (NOT background-/border-color) — a saturated accent the reader maps to its own palette.
            const colM = /(?:^|[;{\s])color\s*:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]+\))/i.exec(rule[2]); const col = colM ? colM[1].trim() : null;
            const btM = /border-top\s*:\s*[^;}]*?\b(solid|double|dashed)\b/i.exec(rule[2]);
            const bbM = /border-bottom\s*:\s*[^;}]*?\b(solid|double|dashed)\b/i.exec(rule[2]);
            // A left/right border means this class is a BOX side (e.g. a promo sign-up box's `.signup-top`
            // = border-top + border-right), not a standalone horizontal divider — its top/bottom edges must
            // NOT become decorative rules, or the box frame litters the page with stray lines.
            const isBoxSide = /border-(?:left|right)\s*:\s*[^;}]*?\b(?:solid|double|dashed)\b/i.test(rule[2]);
            const hasListStyle = /list-style(?:-type)?\s*:/i.test(rule[2]);
            // Record every rule with a property a resolver cares about — split on comma into single selectors.
            // A `::before/::after` rule with `content` goes to cssBeforeRules (e.g. the attribution em-dash);
            // everything else (tag/attr/descendant/class) goes to cssRules for general matching.
            const _relevant = am || isBlock || isItalic || isBold || isNormalWeight || isNormalStyle
              || isSmallCaps || isNormalVariant || col != null
              || li || mE != null || pE != null || tiE != null || fs != null || btM || bbM || hasListStyle;
            const _beforeContent = /::?(?:before|after)\b/i.test(rule[1]) ? /content\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/i.exec(rule[2]) : null;
            // A `::first-letter` rule that FLOATS its initial is a drop cap (a chapter-opener's oversized
            // first letter — Singularity `p.x03-CO-Body-Text::first-letter{float:left;font-size:3.2em}`).
            // Record the base class so the block emitting it carries the drop-cap sentinel; the reader
            // reproduces it via a `::first-letter` CSS class (an inline style can't target the pseudo).
            const _isDropCapFL = /::?first-letter\b/i.test(rule[1]) && /float\s*:\s*(?:left|right)/i.test(rule[2]);
            for (const rawSel of rule[1].split(',')) {
              const sel = rawSel.replace(/\s+/g, ' ').trim();
              if (!sel) continue;
              // Skip AT-RULES (@font-face/@media/@page/@charset). @font-face carries a `font-style` for the
              // font variant, and its selector has no tag/class/attr — so it would match EVERY element and
              // (font-style:normal) wipe out all italic. Never a document element selector.
              if (sel.startsWith('@')) continue;
              if (/::?(?:before|after)\b/i.test(sel)) { if (_beforeContent) cssBeforeRules.push({ sel: sel.replace(/\s*::?(?:before|after)\b/ig, '').trim() || '*', content: _beforeContent[2] }); continue; }
              if (/::?first-letter\b/i.test(sel)) { if (_isDropCapFL) for (const cm of sel.replace(/\s*::?first-letter\b/ig, '').matchAll(/\.([A-Za-z0-9_-]+)/g)) cssDropCap.add(cm[1]); continue; }
              if (/::?[a-z]/i.test(sel)) continue; // an un-evaluable pseudo-element on a non-before rule — skip
              // A selector with no tag AND no class AND no attribute (a bare combinator artefact or `*`) would
              // match every element — skip it so a stray universal rule can't blanket the whole book.
              if (!/[a-zA-Z]|\[|\./.test(sel.replace(/[>+~\s*]/g, ''))) continue;
              if (_relevant) { const _rt = (sel.split(/\s*>\s*|\s+/).pop() || '').match(/^([a-zA-Z][\w-]*)/); cssRules.push({ sel, decl: rule[2], spec: specOf(sel), tag: _rt ? _rt[1].toLowerCase() : '' }); }
            }
            if (!am && !isBlock && !isItalic && !isBold && !isNormalWeight && !isNormalStyle && !isSmallCaps && !isNormalVariant && col == null && !li && mE == null && pE == null && tiE == null && fs == null && !btM && !bbM) continue;
            // Attribute a property ONLY to the class(es) in the RIGHTMOST compound (the rule's actual
            // subject), not every class in the selector. `div.preface dt em code{font-style:italic}` styles
            // the `code`, NOT `.preface` — over-attributing to `.preface` flat-italicised whole sections.
            const _subjectClasses = new Set<string>();
            // Classes that are the subject of an UNCONDITIONAL (single-compound) selector. A descendant-scoped
            // rule (`aside[data-type=sidebar] p.byline{text-align:center}`) is CONDITIONAL, so its alignment
            // must NOT enter the class fast-path — that over-centred EVERY `.byline`, overriding the byline's
            // own `p.byline{text-align:left}` (a foreword author byline got the sidebar's centre). Such rules
            // are still applied IN CONTEXT by the general matcher (cssRules → alignFor's declProp fallback).
            const _simpleSubjectClasses = new Set<string>();
            for (const _oneSel of rule[1].split(',')) {
              const _parts = _oneSel.trim().split(/\s*[>+~\s]\s*/).filter(Boolean);
              const _rm = _parts.pop() || '';
              for (const cm of _rm.matchAll(/\.([A-Za-z0-9_-]+)/g)) { _subjectClasses.add(cm[1]); if (_parts.length === 0) _simpleSubjectClasses.add(cm[1]); }
            }
            for (const c of _subjectClasses) {
              if (btM && !isBoxSide) cssBorderTop[c] = btM[1].toLowerCase() === 'double' ? 'double' : 'single';
              if (bbM && !isBoxSide) cssBorderBottom[c] = bbM[1].toLowerCase() === 'double' ? 'double' : 'single';
              if (am && _simpleSubjectClasses.has(c)) { const av = am[1].toLowerCase(); if (av === 'center' || av === 'right') cssAlign[c] = av; else if (av === 'justify') cssJustify.add(c); else if (av === 'left') cssLeft.add(c); }
              if (isBlock) cssBlock.add(c);
              if (isItalic) cssItalic.add(c); else if (isNormalStyle) cssItalic.delete(c);
              if (isBold) cssBold.add(c); else if (isNormalWeight) cssBold.delete(c);
              if (isSmallCaps) cssSmallCaps.add(c); else if (isNormalVariant) cssSmallCaps.delete(c);
              if (li > 0) cssIndent[c] = Math.max(cssIndent[c] || 0, li);
              if (mE != null || pE != null || tiE != null) { const cur = cssBoxLeftEm[c] || { m: 0, p: 0, ti: 0 }; cssBoxLeftEm[c] = { m: mE ?? cur.m, p: pE ?? cur.p, ti: tiE ?? cur.ti }; }
              if (tiE != null) cssTiDeclared.add(c);
              if (fs) cssFontRaw[c] = fs;
              if (col) cssColor[c] = col;
            }
          }
        } catch { /* skip an unreadable stylesheet */ }
      }
      // ── GENERAL selector matching ──────────────────────────────────────────────────────────────────
      // Match ONE compound selector (no combinators) against an element: tag + .class + [attr]. Loose on
      // attribute operators beyond = / ~= (treated as "attribute present"), which covers real stylesheets.
      const matchSimple = (el: Element, simple: string): boolean => {
        const s = simple.trim();
        if (!s || s === '*') return true;
        const tagM = s.match(/^([a-zA-Z][\w-]*)/);
        if (tagM && (el.tagName || '').toLowerCase() !== tagM[1].toLowerCase()) return false;
        const classes = (el.getAttribute('class') || '').split(/\s+/);
        for (const cm of s.matchAll(/\.([\w-]+)/g)) if (!classes.includes(cm[1])) return false;
        for (const am of s.matchAll(/\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*"?([^"\]]*?)"?\s*)?\]/g)) {
          const av = el.getAttribute(am[1]);
          if (av == null) return false;
          if (am[2] === '=' && av !== am[3]) return false;
          if (am[2] === '~=' && !av.split(/\s+/).includes(am[3])) return false;
        }
        return true;
      };
      // Match a full selector (descendant/child combinators) against an element — the rightmost compound
      // must match `el`, each earlier compound must match SOME ancestor in order (child `>` treated as
      // descendant, a safe over-match).
      const selMatches = (el: Element, sel: string): boolean => {
        const combos = sel.split(/\s*>\s*|\s+/).filter(Boolean);
        if (!combos.length || !matchSimple(el, combos[combos.length - 1])) return false;
        let anc: Element | null = el.parentElement;
        for (let i = combos.length - 2; i >= 0; i--) {
          let ok = false;
          while (anc) { const p: Element | null = anc.parentElement; if (matchSimple(anc, combos[i])) { ok = true; anc = p; break; } anc = p; }
          if (!ok) return false;
        }
        return true;
      };
      // The effective declaration string for an element: every matching rule's declarations, LOW→HIGH
      // specificity (stable sort keeps source order within a tier), then the inline style last — so reading
      // "the last value of a property wins" mirrors the CSS cascade closely enough for these stylesheets.
      const declCache = new WeakMap<Element, string>();
      const matchDecl = (el: Element): string => {
        const c = declCache.get(el); if (c != null) return c;
        const elTag = (el.tagName || '').toLowerCase();
        const decl = cssRules.filter(r => (r.tag === '' || r.tag === elTag) && selMatches(el, r.sel)).sort((a, b) => a.spec - b.spec)
          .map(r => r.decl).join(';') + ';' + ((el as HTMLElement).style?.cssText || '');
        declCache.set(el, decl);
        return decl;
      };
      // Last value of a CSS property across the cascaded declaration string (cascade → last wins).
      const declProp = (el: Element, prop: string): string | null => {
        const re = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, 'gi');
        let m: RegExpExecArray | null, last: string | null = null;
        const d = matchDecl(el);
        while ((m = re.exec(d)) !== null) last = m[1].trim();
        return last;
      };
      // ::before content (decoded from CSS \HHHH escapes) for an element — the highest-specificity match.
      const beforeContentOf = (el: Element): string => {
        let best = '', bestSpec = -1;
        for (const b of cssBeforeRules) { if (selMatches(el, b.sel)) { const s = specOf(b.sel); if (s >= bestSpec) { bestSpec = s; best = b.content; } } }
        return best.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } });
      };
      const alignFor = (el: Element): 'center' | 'right' | null => {
        const inline = (el as HTMLElement).style?.textAlign?.toLowerCase();
        if (inline === 'center' || inline === 'right') return inline;
        for (const c of (el.getAttribute('class') || '').split(/\s+/)) if (cssAlign[c]) return cssAlign[c]; // calibre fast path
        const d = declProp(el, 'text-align'); // general matcher (professional)
        return d === 'center' || d === 'right' ? d : null;
      };
      // The EFFECTIVE text-align of an element, resolving CSS inheritance (text-align inherits, so a
      // paragraph with no align of its own takes its ancestor's — commonly the body's `.calibre` justify).
      // Walks up the element chain checking inline style then class → justify/center/right/left. Used to
      // tally how much of the body is justified for the doc-level sourceJustified flag.
      const effectiveAlignOf = (el: Element | null): 'justify' | 'center' | 'right' | 'left' | null => {
        let cur: Element | null = el;
        for (let depth = 0; cur && cur.nodeType === 1 && depth < 12; depth++, cur = cur.parentElement) {
          const inline = (cur as HTMLElement).style?.textAlign?.toLowerCase();
          if (inline === 'justify' || inline === 'left' || inline === 'right' || inline === 'center') return inline;
          for (const c of (cur.getAttribute('class') || '').split(/\s+/)) { // calibre fast path
            if (cssJustify.has(c)) return 'justify';
            if (cssAlign[c]) return cssAlign[c];
            if (cssLeft.has(c)) return 'left';
          }
          const d = declProp(cur, 'text-align'); // general matcher (professional)
          if (d === 'justify' || d === 'left' || d === 'right' || d === 'center') return d;
        }
        return null;
      };
      const indentFor = (el: Element): number => {
        const s = (el as HTMLElement).style;
        const inline = leftIndentPx(`margin-left:${s?.marginLeft || ''};padding-left:${s?.paddingLeft || ''};text-indent:${s?.textIndent || ''}`);
        if (inline > 0) return inline;
        let px = 0;
        for (const c of (el.getAttribute('class') || '').split(/\s+/)) if (cssIndent[c]) px = Math.max(px, cssIndent[c]); // calibre fast path
        return px > 0 ? px : leftIndentPx(matchDecl(el)); // general matcher (professional)
      };
      const isBlockChild = (n: Node): boolean => {
        if (n.nodeType !== Node.ELEMENT_NODE) return false;
        const el = n as HTMLElement;
        if ((el.style?.display || '').toLowerCase() === 'block') return true;
        if ((el.getAttribute('class') || '').split(/\s+/).some(c => cssBlock.has(c))) return true; // calibre fast path
        return (declProp(el, 'display') || '').toLowerCase() === 'block'; // general matcher (professional)
      };
      // The rendered LEFT indent (em) where an INDEX entry's text starts, relative to the top-level index
      // list. Walk up summing each ancestor's margin-left + padding-left (em) — INCLUDING the browser
      // default ~2.5em a bare nested <ul>/<ol> carries (which the old fixed 4-NBSP ignored, so sub-entries
      // sat ~half as deep as the source) — plus the entry's OWN text-indent (its hanging first-line
      // offset). Stops at the top-level list (its indent is the reader's container reference), so a main
      // entry nets ~0 (padding cancels its negative text-indent) and stays flush.
      const boxLeftEm = (el: Element): { m: number; p: number; ti: number } => {
        const acc = { m: 0, p: 0, ti: 0 };
        for (const c of (el.getAttribute('class') || '').split(/\s+/)) { const b = cssBoxLeftEm[c]; if (b) { if (b.m) acc.m = b.m; if (b.p) acc.p = b.p; if (b.ti) acc.ti = b.ti; } } // calibre fast path
        // General matcher (professional) — correct cascade (the reset's `margin:0` is OVERRIDDEN by a later
        // `dd{margin:…1.5em}`, so take the LAST value of each property, reading the left value from the shorthand).
        const leftOf = (prop: 'margin' | 'padding'): number | null => {
          const explicit = declProp(el, `${prop}-left`);
          if (explicit != null) return lenToEm(explicit.replace(/!important/ig, ''));
          const sh = (declProp(el, prop) || '').replace(/!important/ig, '').trim();
          if (!sh) return null;
          const q = sh.split(/\s+/); const l = q.length === 4 ? q[3] : q.length >= 2 ? q[1] : q[0];
          return lenToEm(l);
        };
        // Only fill in what the class fast path didn't set (class-first, so calibre is unchanged).
        if (!acc.m) { const dm = leftOf('margin'); if (dm != null) acc.m = dm; }
        if (!acc.p) { const dp = leftOf('padding'); if (dp != null) acc.p = dp; }
        if (!acc.ti) { const dti = declProp(el, 'text-indent'); if (dti != null) { const e = lenToEm(dti.replace(/!important/ig, '')); if (e != null) acc.ti = e; } }
        const s = (el as HTMLElement).style;
        if (s?.marginLeft) { const e = lenToEm(s.marginLeft); if (e != null) acc.m = e; }
        if (s?.paddingLeft) { const e = lenToEm(s.paddingLeft); if (e != null) acc.p = e; }
        if (s?.textIndent) { const e = lenToEm(s.textIndent); if (e != null) acc.ti = e; }
        return acc;
      };
      // Vertical (top/bottom) source margins in em — so a block's own set-off gaps (a labelled-list's
      // margin-top on IF: / margin-bottom on THEN:) are reproduced from the SOURCE, not hard-coded.
      const vMarginEm = (el: Element): { top: number; bottom: number } => {
        const side = (which: 'top' | 'bottom'): number => {
          const ex = declProp(el, `margin-${which}`);
          if (ex != null) return lenToEm(ex.replace(/!important/ig, '')) ?? 0;
          const sh = (declProp(el, 'margin') || '').replace(/!important/ig, '').trim();
          if (!sh) return 0;
          const q = sh.split(/\s+/);
          return lenToEm(which === 'top' ? q[0] : (q.length >= 3 ? q[2] : q[0])) ?? 0;
        };
        const st = (el as HTMLElement).style;
        return { top: (st?.marginTop && lenToEm(st.marginTop)) || side('top'), bottom: (st?.marginBottom && lenToEm(st.marginBottom)) || side('bottom') };
      };
      const renderedIndentEm = (el: Element, uaListPadEm = 2.5): number => {
        let em = 0; let node: Element | null = el; let first = true;
        while (node) {
          const tag = node.tagName?.toLowerCase();
          if (!tag || tag === 'body') break;
          // A top-level list (parent is not an <li>) is the container reference — stop before counting it.
          if ((tag === 'ul' || tag === 'ol') && node.parentElement?.tagName.toLowerCase() !== 'li') break;
          const b = boxLeftEm(node);
          em += b.m + b.p;
          if ((tag === 'ul' || tag === 'ol') && b.p === 0) em += uaListPadEm; // UA default list padding-inline-start
          if (first) { em += b.ti; first = false; }
          node = node.parentElement;
        }
        return Math.max(0, em);
      };
      // Whether an element resolves to italic / bold. Resolved through the GENERAL matcher (proper
      // specificity + descendant/attribute matching), NOT the class-keyed sets — those OVER-ATTRIBUTE a
      // compound rule's property to every class in it (`div.preface dt em code{font-style:italic}` would
      // mark `.preface` ITSELF italic), which flatly italicised whole professional-EPUB sections. An
      // explicit `normal` wins (`p[data-type=attribution]{font-style:normal}` beats the quote's italic).
      const elItalicOf = (el: Element): boolean => {
        const inline = ((el as HTMLElement).style?.fontStyle || '').toLowerCase();
        if (inline === 'italic') return true; if (inline === 'normal') return false;
        if ((el.getAttribute('class') || '').split(/\s+/).some(c => cssItalic.has(c))) return true; // calibre fast path
        return declProp(el, 'font-style') === 'italic'; // general matcher (professional tag/descendant/attr rules)
      };
      const cssColorOf = (el: Element): string | null => {
        const inline = (el as HTMLElement).style?.color;
        if (inline) return inline;
        for (const c of (el.getAttribute('class') || '').split(/\s+/)) if (cssColor[c]) return cssColor[c];
        return declProp(el, 'color');
      };
      // Map a source text `color` to the NEAREST reader-palette accent by HUE, returning its sentinel
      // (U+E030 + index into cyan/red/pink/violet/amber/yellow). '' for a default/near-grey color (black body
      // text, grey, near-white) — the reader keeps its own text colour there. The reader owns the actual hex,
      // so a book's arbitrary accent (Transurfing's teal #36938f → cyan) stays coherent with the dark theme.
      const READER_ACCENT_HUES = [184, 348, 312, 255, 43, 55]; // cyan, red, pink, violet, amber, yellow
      const accentSentinelFor = (raw: string | null): string => {
        if (!raw) return '';
        let r: number, g: number, b: number;
        const hm = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
        if (hm) { const h = hm[1].length === 3 ? hm[1].replace(/(.)/g, '$1$1') : hm[1]; r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16); }
        else { const rm = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(raw); if (!rm) return ''; r = +rm[1]; g = +rm[2]; b = +rm[3]; }
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        const l = (mx + mn) / 2 / 255;
        const s = d === 0 ? 0 : d / (255 - Math.abs(mx + mn - 255));
        if (s < 0.22 || l < 0.15 || l > 0.9) return ''; // grey / near-black body / near-white → not an accent
        let hue = 0;
        if (d) { if (mx === r) hue = ((g - b) / d) % 6; else if (mx === g) hue = (b - r) / d + 2; else hue = (r - g) / d + 4; hue *= 60; if (hue < 0) hue += 360; }
        let best = 0, bestD = 999;
        for (let i = 0; i < READER_ACCENT_HUES.length; i++) { let dh = Math.abs(hue - READER_ACCENT_HUES[i]); if (dh > 180) dh = 360 - dh; if (dh < bestD) { bestD = dh; best = i; } }
        return String.fromCharCode(0xE030 + best);
      };
      const elBoldOf = (el: Element): boolean => {
        const inline = ((el as HTMLElement).style?.fontWeight || '').toLowerCase();
        if (/^(?:bold|[6-9]00)$/.test(inline)) return true; if (/^(?:normal|[1-4]00)$/.test(inline)) return false;
        if ((el.getAttribute('class') || '').split(/\s+/).some(c => cssBold.has(c))) return true;
        return /^(?:bold|[6-9]00)$/.test((declProp(el, 'font-weight') || '').toLowerCase());
      };
      const elSmallCapsOf = (el: Element): boolean => {
        const inline = ((el as HTMLElement).style?.fontVariant || (el as HTMLElement).style?.fontVariantCaps || '').toLowerCase();
        if (/small-caps/.test(inline)) return true; if (inline === 'normal') return false;
        const _cls = (el.getAttribute('class') || '').split(/\s+/);
        if (_cls.some(c => cssSmallCaps.has(c))) return true;
        // A class explicitly NAMED small-caps but implemented via font-size only (no `font-variant`): the text
        // is pre-uppercased and shrunk (brief_history's run-in openers `span.smallcaps{font-size:.833em}`,
        // Sovereign `.smallcaps{.75em;text-transform:uppercase}`). Treat it as small-caps intent — the reader
        // renders it small-caps (inline: all-small-caps → small capitals; block: font-variant, a no-op on the
        // already-uppercase text, harmless).
        if (_cls.some(c => /^small-?caps\d*$/i.test(c))) return true;
        return /small-caps/.test((declProp(el, 'font-variant') || declProp(el, 'font-variant-caps') || '').toLowerCase());
      };
      // CSS-driven emphasis: an element italicised/bolded via a class/tag/attribute (not <i>/<b>) — wrap its
      // text in the markdown the reader renders. Guard against double-wrapping when a nested <i>/<em> did.
      const emphasize = (text: string, el: Element): string => {
        // Never wrap a figure marker in emphasis. A decorative image inside <span class="bold">
        // (chapter-opener rules/ornaments in this EPUB) would become "**[[FIG id]]**"; when the image is
        // then dropped as decorative, blankMarker blanks only the marker, leaving the "**" bookends as two
        // stray bold-marker paragraphs — a phantom vertical gap between the heading and the next block.
        if (!text || text.includes('[[FIG ')) return text;
        // Reproduce CSS `text-transform:uppercase` (a dialogue speaker label "Cassandra:" → "CASSANDRA:", a
        // small-caps run-in) — but never upper-case a markdown link (its href must stay verbatim).
        const _tt = ((el as HTMLElement).style?.textTransform || declProp(el, 'text-transform') || '').toLowerCase();
        const t = _tt === 'uppercase' && !/\]\(/.test(text) ? text.toUpperCase() : text;
        // Inline small-caps run (font-variant:small-caps via a class/CSS, e.g. brief_history's run-in chapter
        // openers `<span class="smallcaps">LIFE EXISTED ON</span>`, Singularity `span.SCAP`) → the U+E02D
        // inline sentinel the reader renders as small caps. Corpus small-caps runs are plain (never also
        // bold/italic), so wrap only when the inner has no emphasis markers, avoiding a nested-marker tangle.
        if (elSmallCapsOf(el) && !/[*_]/u.test(t)) {
          // SIZE-based small-caps (a class that pre-uppercases + shrinks the text, no font-variant —
          // brief_history .833em, Sovereign .75em) → reproduce the EXACT reduced size (keeps the uppercase
          // text, just smaller) via the U+E02F sentinel carrying the ratio (U+E100 + round(ratio×100)).
          // FONT-VARIANT small-caps (Singularity SCAP, ~1em, lowercase) → all-small-caps via U+E02D.
          const _r = currentBodyEm > 0 ? resolveFontEm(el) / currentBodyEm : 1;
          return (_r > 0.4 && _r < 0.95)
            ? `${String.fromCharCode(0xE100 + Math.round(_r * 100))}${t}`
            : `${t}`;
        }
        if (/[*_]/u.test(t)) return t;
        if (elBoldOf(el)) return `**${t}**`;
        if (elItalicOf(el)) return `*${t}*`;
        return t;
      };

      // FONT-SIZE tier (mirrors PDF's U+E01B–E01F). Resolve an element's CSS font-size to an absolute em
      // (relative to the 16px root), compounding relative units up the cascade, then compare to THIS
      // document's body base; emit the reader's size sentinel when a block is clearly larger (sub-head) or
      // smaller (caption/fine-print). EPUB font-size is authoritative CSS — unlike the PDF geometry guess.
      // The reader's 0.90–1.08 dead-zone leaves ordinary body text untiered even if the baseline is a touch off.
      const cssFontSizeOf = (el: Element): string | null => {
        const inline = (el as HTMLElement).style?.fontSize;
        if (inline) return inline;
        for (const c of (el.getAttribute('class') || '').split(/\s+/)) if (cssFontRaw[c]) return cssFontRaw[c]; // calibre fast path
        const d = declProp(el, 'font-size'); // general matcher (professional)
        return d != null ? d.replace(/!important/ig, '').trim() : null;
      };
      const UA_HEADING_EM: Record<string, number> = { h1: 2, h2: 1.5, h3: 1.17, h4: 1, h5: 0.83, h6: 0.67 };
      const resolveFontEm = (el: Element | null, depth = 0): number => {
        if (!el || depth > 10) return 1;
        const parentEm = () => resolveFontEm(el.parentElement, depth + 1);
        const raw = cssFontSizeOf(el);
        if (raw == null) {
          // A heading with no explicit CSS size keeps the browser default for its level.
          const tag = el.tagName?.toLowerCase();
          return tag && UA_HEADING_EM[tag] !== undefined ? UA_HEADING_EM[tag] * parentEm() : parentEm();
        }
        const v = raw.trim().toLowerCase();
        let m: RegExpExecArray | null;
        if ((m = /(-?[\d.]+)px/.exec(v))) return (parseFloat(m[1]) || 16) / 16;
        if ((m = /(-?[\d.]+)pt/.exec(v))) return ((parseFloat(m[1]) || 12) * 4 / 3) / 16;
        if ((m = /(-?[\d.]+)rem/.exec(v))) return parseFloat(m[1]) || 1;
        if ((m = /(-?[\d.]+)em/.exec(v))) return (parseFloat(m[1]) || 1) * parentEm();
        if ((m = /(-?[\d.]+)%/.exec(v))) return ((parseFloat(m[1]) || 100) / 100) * parentEm();
        const kw: Record<string, number> = { 'xx-small': 0.6, 'x-small': 0.75, small: 0.89, medium: 1, large: 1.2, 'x-large': 1.5, 'xx-large': 2 };
        if (kw[v] !== undefined) return kw[v];
        if (v.includes('smaller')) return 0.83 * parentEm();
        if (v.includes('larger')) return 1.2 * parentEm();
        return parentEm();
      };
      let currentBodyEm = 1; // this document's base font-size (set per spine file before the walk)
      // Map an element's CSS font-size (relative to its file's body em) to a size-tier sentinel, matching
      // the PDF's tiers/thresholds (App.tsx sizeSentinel). ENLARGE tiers (E01D/E01E/E01F) always fire.
      // SHRINK tiers (E01B 0.72 / E01C 0.86) fire ONLY when allowShrink=true — the caller passes it for
      // genuine BODY content (notes, quotes, copyright fine print) but NOT for headings: an EPUB section
      // heading is often a small-caps block with a deliberately small font-size, and the reader flattens
      // small-caps, so shrinking it would render the title tiny (Sovereign's "PREMONITIONS"). Headings go
      // through their own path (_tierOf, enlarge-only) or pass allowShrink=false here, so they can't shrink.
      const sizeTierSentinel = (el: Element, allowShrink = false): string => {
        // Also carry the source text COLOR here (→ reader accent): sizeTierSentinel is in EVERY block-emit
        // return, so folding the accent in one place colours a paragraph regardless of which return path it
        // takes (hanging entry, indented, plain, …) — a per-return mark kept getting missed on some paths.
        const _color = accentSentinelFor(cssColorOf(el));
        const ratio = currentBodyEm > 0 ? resolveFontEm(el) / currentBodyEm : 1;
        const tier = ratio >= 1.6 ? String.fromCharCode(0xE01F)
          : ratio >= 1.25 ? String.fromCharCode(0xE01E)
          : ratio > 1.08 ? String.fromCharCode(0xE01D)
          : (allowShrink && ratio < 0.80) ? String.fromCharCode(0xE01B)
          : (allowShrink && ratio < 0.905) ? String.fromCharCode(0xE01C)
          : '';
        return tier + _color;
      };

      // Heading anchors from the publisher's TOC: any element the nav/NCX points at via "#fragment" is a
      // heading (chapter or SECTION) — even when the source styles it as <p class="zag1"> rather than an
      // <h1>–<h6> tag (this EPUB, and many z-library conversions use CSS-class headings). Collect those
      // fragment ids so the walk can mark such paragraphs as real headings (U+E013). Without this they
      // extract as plain bold paragraphs and depend on the reader's Title-Case subtitle heuristic, which
      // drops sentence-case ("You get what you do not want") and single-word ("Guilt", "War") section
      // titles into the following paragraph as a bold run-in. (A broken NCX whose fragments point at
      // footnote anchors — e.g. Elon Musk's #fnn2 — is unaffected: those ids sit on inline <a> elements,
      // which never reach the block-heading path below.)
      const navAnchorIds = new Set<string>();
      const navDocPath = (navFullPath && zip.files[navFullPath]) ? navFullPath : ((ncxFullPath && zip.files[ncxFullPath]) ? ncxFullPath : undefined);
      if (navDocPath) {
        try {
          const navRaw = await zip.files[navDocPath].async('string');
          for (const m of navRaw.matchAll(/(?:href|src)\s*=\s*["'][^"'#]*#([^"']+)["']/gi)) navAnchorIds.add(decodeURIComponent(m[1]).trim());
        } catch { /* nav unreadable — fall back to <h1>–<h6> only */ }
      }

      // FOOTNOTE / ENDNOTE references. In EPUB a body reference <a href="notes.html#en5">5</a> and its note
      // body <a id="en5" …>5.</a> text are NATIVELY linked by href (unlike PDF, which reverse-engineers this
      // from superscript geometry). Detect them here and emit the SAME "[label](#key)" markers the reader
      // already renders + navigates for PDF footnotes → no reader changes on the common path. A "notes file"
      // is one that ≥3 marker-links point INTO — that direction resolves the ref↔note back-link ambiguity
      // (a reference goes from a chapter INTO the notes file; the note's back-link goes the other way). The
      // shared key is the note body's fragment id, used identically on both the reference and the body.
      const noteRefLabels = new Map<string, string>(); // note-body fragment id -> marker label
      {
        const MARKER = /^(?:\d{1,3}|[ivxlcdm]{1,4}|fn\.?\d{1,3}|[*†‡§‖¶]{1,4})\.?$/i;
        // A NOTE anchor (en/fn/note + digit), not a page-break/cross-ref marker — many EPUBs (Sovereign)
        // emit <a href="#page_213">213</a> for epub:type="pagebreak", which has a numeric label too and
        // would otherwise be mistaken for a footnote reference.
        const isNoteFrag = (frag: string): boolean =>
          /(?:fn|en|ftn|rn|note|fnote|footnote|endnote)[-_]?\d/i.test(frag) && !/pag/i.test(frag);
        const links: { src: string; tgt: string; frag: string; label: string; srcOffset: number }[] = [];
        const noteIdOffsets = new Map<string, Map<string, number>>(); // file -> (note-ish anchor id -> its offset)
        for (const filename of sortedFiles) {
          let raw = '';
          try { raw = await zip.files[filename].async('string'); } catch { continue; }
          const dir = filename.slice(0, filename.lastIndexOf('/') + 1);
          // Record where each note-ish anchor id SITS in this file, so an intra-file reference→body link
          // can be told from its back-link by document order (below).
          const ids = new Map<string, number>();
          for (const im of raw.matchAll(/<[a-z][a-z0-9]*\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
            const id = decodeURIComponent(im[1]).trim();
            if (isNoteFrag(id) && !ids.has(id)) ids.set(id, im.index ?? 0);
          }
          noteIdOffsets.set(filename, ids);
          for (const m of raw.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
            const hash = m[1].indexOf('#');
            if (hash < 0) continue;
            const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
            // A SEMANTIC note reference (EPUB3 `role="doc-noteref"`, or a `…noteref/endnote-reference…` class —
            // Singularity: `<a class="Endnote-Reference" role="doc-noteref" href="18_Notes.xhtml#EndnoteNumber200">[15]</a>`).
            // Its fragment ("EndnoteNumber200") has a word between "Endnote" and the digit so isNoteFrag misses
            // it, and its label ("[15]") is bracketed so MARKER rejects it — yet the role/class say
            // unambiguously it IS a note ref. Trust the semantic marker and bypass those two heuristics.
            const semanticNoteRef = /\brole=["']doc-noteref["']|\bclass=["'][^"']*(?:noteref|endnote-reference|footnote-reference)/i.test(openTag);
            // Strip a bracketed marker ("[15]" → "15") so it passes MARKER and renders as a clean note number.
            const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().replace(/^\[+\s*|\s*\]+$/g, '').replace(/\.$/, '');
            const frag = decodeURIComponent(m[1].slice(hash + 1)).trim();
            if (!semanticNoteRef) {
              if (!MARKER.test(label)) continue;
              if (!isNoteFrag(frag)) continue;
            } else if (!label || label.length > 8) continue; // a note marker is short
            const tgt = hash > 0 ? (resolveZip(m[1].slice(0, hash), dir) || filename) : filename;
            links.push({ src: filename, tgt, frag, label, srcOffset: m.index ?? 0 });
          }
        }
        // A reference points FORWARD in spine order (endnotes sit at the back of the book); the note's
        // back-link points backward. Both have note-ish fragments, so direction is what tells them apart —
        // count only forward links so a chapter targeted by the notes file's back-links isn't itself
        // mistaken for a notes file. A notes file is one ≥3 forward note-links point into.
        const spineIdx = new Map<string, number>(sortedFiles.map((f, i) => [f, i]));
        const forward = links.filter(l => (spineIdx.get(l.src) ?? -1) < (spineIdx.get(l.tgt) ?? -1));
        const intoCount = new Map<string, number>();
        for (const l of forward) intoCount.set(l.tgt, (intoCount.get(l.tgt) ?? 0) + 1);
        const notesFiles = new Set([...intoCount].filter(([, n]) => n >= 3).map(([f]) => f));
        for (const l of forward) if (notesFiles.has(l.tgt) && !noteRefLabels.has(l.frag)) noteRefLabels.set(l.frag, l.label);
        // IN-CHAPTER footnotes: the reference AND the note body live in the SAME file, cross-linked
        // (ref <a id=X href=#Y>…</a> in the prose, body <a id=Y href=#X>…</a> in a chapter-end block —
        // e.g. this z-library Elon EPUB's fn1↔fnn1). Same file = no spine direction, so use DOCUMENT order:
        // the reference sits inline earlier and points FORWARD to the body; a link whose target id appears
        // LATER in its own file is that reference, and its target frag (the body's id) is the shared key —
        // matching the key the reader derives from the reference's href. The body's own back-link points
        // EARLIER, so it's skipped and the pair keys to ONE id. Without this the body falls to the generic
        // link path and is keyed by its back-link (#fnn1), never matching the reference's key (#fn1) → the
        // note is unreachable in its own chapter and the reader errors SOURCE_REQUIRED.
        for (const l of links) {
          if (l.src !== l.tgt || noteRefLabels.has(l.frag)) continue;
          const targetOffset = noteIdOffsets.get(l.src)?.get(l.frag);
          if (targetOffset != null && targetOffset > l.srcOffset) noteRefLabels.set(l.frag, l.label);
        }
        // CROSS-FILE in-chapter footnotes below the ≥3 "notes file" threshold: a calibre chapter SPLIT
        // across files puts a footnote's reference and its body in DIFFERENT files (Sovereign ch1: ref in
        // …_004, body in …_010) and with only 1–2 footnotes the notes-file heuristic misses them, while the
        // same-file path (src===tgt) skips them — so the two sides emit DIFFERENT keys (#ch01fn1 vs
        // #ch01-fn1) and never pair → the note is unreachable and its marker renders as a dead reference.
        // A MUTUAL pair — a forward note-link A→B#f whose target file B holds the anchor id `f` AND a
        // reciprocal back-link B→A — is unambiguously a footnote. Key it by f (the body anchor id the reader
        // derives from the reference's href), exactly like the notes-file and same-file paths above.
        for (const l of links) {
          if (noteRefLabels.has(l.frag)) continue;
          if ((spineIdx.get(l.src) ?? -1) >= (spineIdx.get(l.tgt) ?? -1)) continue; // the reference points forward to the body
          const bodyHasAnchor = noteIdOffsets.get(l.tgt)?.has(l.frag);
          const reciprocal = links.some(b => b.src === l.tgt && b.tgt === l.src);
          if (bodyHasAnchor && reciprocal) noteRefLabels.set(l.frag, l.label);
        }
      }

      // <img>/<image> → a [[FIG id]] marker; the bytes are extracted after the walk and cached like a
      // PDF figure, so the existing reader figure block renders them. baseDir resolves relative srcs.
      const figSrc = new Map<string, string>(); // figId -> resolved zip key
      const figWidthFrac = new Map<string, number>(); // figId -> width fraction from the wrapping div.fig_NN (NN% of the column)
      let figSeq = 0;
      // The reader's block-role/alignment sentinels (PUA chars), defined via char codes so they can't
      // be lost in transit: heading U+E013, centre U+E010, right U+E011.
      const SENT_HEADING = String.fromCharCode(0xE013);
      const SENT_CENTER = String.fromCharCode(0xE010);
      const SENT_RIGHT = String.fromCharCode(0xE011);
      // A decorative RULE sentinel (U+E021) — one for a single line, two for a double rule (chapter deck
      // bracket). The reader draws them exactly like the PDF path (buildPageSentenceData matches a
      // paragraph that is ONLY U+E021s). ruleBlock wraps it as its own paragraph.
      const SENT_RULE = String.fromCharCode(0xE021);
      const ruleBlock = (kind: 'single' | 'double'): string => `\n\n${kind === 'double' ? SENT_RULE + SENT_RULE : SENT_RULE}\n\n`;
      // The decorative top/bottom border an element declares (inline style OR a class from cssBorderTop/
      // Bottom) → the rule kind to draw above/below it. Skips table context (a cell's border-bottom is a
      // grid line, not a content divider).
      const borderRuleOf = (el: Element): { top: 'single' | 'double' | null; bottom: 'single' | 'double' | null } => {
        if (el.closest('table')) return { top: null, bottom: null };
        let top: 'single' | 'double' | null = null, bottom: 'single' | 'double' | null = null;
        const st = (el as HTMLElement).style;
        const inlKind = (s: string | undefined): 'single' | 'double' | null =>
          (s || '').toLowerCase() === 'double' ? 'double' : ((s || '').toLowerCase() === 'solid' || (s || '').toLowerCase() === 'dashed') ? 'single' : null;
        top = inlKind(st?.borderTopStyle);
        bottom = inlKind(st?.borderBottomStyle);
        for (const c of (el.getAttribute('class') || '').split(/\s+/)) { // calibre fast path
          if (!top && cssBorderTop[c]) top = cssBorderTop[c];
          if (!bottom && cssBorderBottom[c]) bottom = cssBorderBottom[c];
        }
        // General matcher (professional) for whatever the class path didn't set. A left/right border means a
        // BOX FRAME, not a horizontal divider — skip its top/bottom edges.
        if (!top || !bottom) {
          const kindOf = (v: string | null): 'single' | 'double' | null => {
            const m = v ? /\b(solid|double|dashed)\b/i.exec(v) : null;
            return m ? (m[1].toLowerCase() === 'double' ? 'double' : 'single') : null;
          };
          const isBox = kindOf(declProp(el, 'border-left')) || kindOf(declProp(el, 'border-right'));
          if (!top && !isBox) top = kindOf(declProp(el, 'border-top'));
          if (!bottom && !isBox) bottom = kindOf(declProp(el, 'border-bottom'));
        }
        return { top, bottom };
      };
      // An email/memo header field line ("From: …", "Date: …", "To: …", "Subject: …"). Such a header
      // is authored as one <p> with <br>-separated fields; those <br> become soft \n breaks, leaving
      // the fields in one paragraph. Promote them to SEPARATE paragraphs (\n\n) so the reader styles
      // each field uniformly (flush, un-bold, tight) — the same result the PDF path produces.
      const EPUB_EMAIL_HDR = /^(?:[*_~`]*)(?:From|To|Cc|Bcc|Date|Sent|Subject|Reply-To)\s*:\s/i;
      const isEmailHeaderBlock = (raw: string): boolean => {
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        return lines.length >= 2 && lines.every(l => EPUB_EMAIL_HDR.test(l));
      };

      const nodeToMarkedText = (node: Node, baseDir: string): string => {
        // Collapse a text node's whitespace to single spaces, as HTML does in normal flow. Source markup
        // wraps lines mid-paragraph ("<span class=small>DO YOU THINK</span>\n I'm insane?"), and keeping
        // that raw newline made a small-caps chapter LEAD-IN split onto its own line — where its all-caps
        // shape then read as a heading. Block structure comes from the block-tag handlers (\n\n) and <br>
        // (\n), never from a text node's own newlines, so this can't merge real blocks.
        if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replace(/\s+/gu, ' ');
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const element = node as HTMLElement;
        const tag = element.tagName.toLowerCase();
        if (['script', 'style', 'nav', 'math'].includes(tag)) return '';
        if (tag === 'br') return '\n';
        // Raster image: <img src> or an SVG <image xlink:href> (covers). Emit a figure marker.
        if (tag === 'img' || tag === 'image') {
          const src = element.getAttribute('src') || element.getAttribute('xlink:href') || element.getAttribute('href') || '';
          const full = src ? resolveZip(src, baseDir) : undefined;
          // The cover IMAGE is book metadata (like a PDF cover), not inline reading content — never emit it
          // as an inline figure, so the cover page renders clean (no "figure unavailable" placeholder).
          if (full && coverImageKey && full === coverImageKey) return '';
          if (full && /\.(jpe?g|png|gif|webp|svg)$/i.test(full)) {
            const id = `epub${++figSeq}`;
            figSrc.set(id, full);
            // The publisher sizes the figure by a width TIER encoded in the wrapping div's class
            // ("div.fig_30 { width:30% }" … up to fig_85), covering the image AND its caption/credit box.
            // Walk up to that wrapper and record the fraction so the reader renders the figure UNIT (image +
            // caption + attribution) at its true source width instead of the full-column fallback.
            for (let p: HTMLElement | null = element.parentElement; p; p = p.parentElement) {
              const m = (p.getAttribute('class') || '').match(/\bfig_(\d{2,3})\b/);
              if (m) { figWidthFrac.set(id, Math.min(1, Number(m[1]) / 100)); break; }
            }
            return `\n\n[[FIG ${id}]]\n\n`;
          }
          return '';
        }
        if (tag === 'svg') return Array.from(element.childNodes).map(n => nodeToMarkedText(n, baseDir)).join('');

        // HIDDEN content is invisible in the source, so drop it to render faithfully: a display:none /
        // visibility:hidden element, or a font-size:0 TEXT LEAF (a publisher's zero-width label — Kurzweil's
        // Contents `<span class="CN">Chapter 1:</span>` at font-size:0, hidden so the entry reads just the
        // title). font-size:0 is leaf-gated (no child elements) so a wrapper resetting its children's size
        // isn't dropped with them.
        {
          const _st = (element as HTMLElement).style;
          if ((_st?.display || '').toLowerCase() === 'none' || (_st?.visibility || '').toLowerCase() === 'hidden') return '';
          const _fs = cssFontSizeOf(element);
          if (_fs != null && /^0(?:px|em|rem|pt|%)?$/u.test(_fs.trim()) && !element.querySelector('*')) return '';
        }

        // A DATA TABLE (Sovereign's dice-frequency table — a header row plus rows that use ditto marks `"`
        // to repeat "The sum of / spots will appear / times."). Emit the SAME positioned-token payload the
        // PDF path uses (U+E025 <rows joined by U+E024>, each token a PUA position char U+E200 + permille of
        // its x-fraction + its text), so the reader lays out every column aligned exactly — parity with the
        // PDF. The EPUB has no x-coordinates, so a cell's x-fraction is its COLUMN INDEX / total columns
        // (honouring colspan, so the header's spanning cell starts at its column). Gated to ≥3 columns and
        // ≥3 rows (a real data table, mirroring the PDF's multi-gutter rule); a smaller/layout table falls
        // through to the default per-cell text flow, unchanged.
        // An ADMONITION callout (O'Reilly note/tip/warning/caution — agentic_mesh `<div data-type="tip">
        // <h6>Tip</h6><p>…</p></div>`): the source draws a labelled bordered box. Emit the body as ONE
        // paragraph (per-sentence translatable) with a leading callout marker (U+E03B note / U+E03C tip /
        // U+E03D warning) so the reader wraps it in a bordered box + type label; the <h6> label is dropped
        // (the reader regenerates it from the type). Body paragraphs are joined inline into the one unit.
        {
          const _cType = ((element.getAttribute('data-type') || '') + ' ' + (element.getAttribute('class') || '')).toLowerCase();
          const _adm = (tag === 'div' || tag === 'aside' || tag === 'section')
            ? (/\b(note|tip|warning|caution|important)\b/.test(_cType) ? _cType.match(/\b(note|tip|warning|caution|important)\b/)![1] : '')
            : '';
          if (_adm) {
            const _isTip = _adm === 'tip';
            const _isWarn = _adm === 'warning' || _adm === 'caution' || _adm === 'important';
            const _mk = _isTip ? String.fromCharCode(0xE03C) : _isWarn ? String.fromCharCode(0xE03D) : String.fromCharCode(0xE03B);
            const _label = _isTip ? 'Tip' : _isWarn ? 'Warning' : 'Note';
            const _body = Array.from(element.children)
              .filter(c => !/^h[1-6]$/i.test(c.tagName || ''))
              .map(c => Array.from(c.childNodes).map(n => nodeToMarkedText(n, baseDir)).join('').replace(/\s+/gu, ' ').trim())
              .filter(Boolean).join(' ');
            // Prepend the type LABEL word (Tip/Note/Warning) after the marker so it stays in the searchable
            // content (the source had it in the dropped <h6>); the reader strips this leading word from the
            // DISPLAYED body since it regenerates the styled label from the marker.
            if (_body) return `\n\n${_mk}${_label} ${_body}\n\n`;
          }
        }
        // A <pre> code / prompt block (agentic_mesh's Ubuntu-Mono `<pre>` prompts): keep the source line
        // breaks + indentation instead of collapsing them to one line, and mark it a code block (U+E031) so
        // the reader sets it off in a bordered panel with `white-space:pre-wrap` in the reader's own font
        // (option A — no monospace). Newlines → U+E024 (survives the whitespace collapse, like verse/table);
        // trailing space per line trimmed; leading indent kept. Marker U+E036 (NOT in the E030-E035 accent-
        // color range, which a leading-sentinel scan would otherwise mistake for a code block).
        if (tag === 'pre') {
          const raw = (element.textContent || '').replace(/\r\n?/gu, '\n').replace(/^\n+|\n+$/gu, '');
          if (!raw.trim()) return '';
          const enc = raw.split('\n').map(ln => ln.replace(/\s+$/u, '')).join(String.fromCharCode(0xE024));
          return `\n\n${String.fromCharCode(0xE036)}${enc}\n\n`;
        }
        if (tag === 'table') {
          const trs = Array.from(element.getElementsByTagName('tr'));
          const rowCells = trs.map(tr => Array.from(tr.children).filter(c => /^t[dh]$/i.test(c.tagName || '')));
          const colsOf = (cells: Element[]) => cells.reduce((n, c) => n + (parseInt(c.getAttribute('colspan') || '1', 10) || 1), 0);
          const totalCols = Math.max(1, ...rowCells.map(colsOf));
          const posChar = (xf: number) => String.fromCharCode(0xE200 + Math.max(0, Math.min(1000, Math.round(xf * 1000))));
          const rowsEnc = rowCells.map(cells => {
            let col = 0, out = '';
            for (const c of cells) {
              const span = parseInt(c.getAttribute('colspan') || '1', 10) || 1;
              const txt = (c.textContent || '').replace(/\s+/g, ' ').trim();
              if (txt) out += posChar(col / totalCols) + txt;
              col += span;
            }
            return out;
          }).filter(Boolean);
          if (totalCols >= 3 && rowsEnc.length >= 3) {
            return '\n\n' + String.fromCharCode(0xE025) + rowsEnc.join(String.fromCharCode(0xE024)) + '\n\n';
          }
          // A 2-COLUMN LABEL|CONTENT table (agentic_mesh's Table 11-1: `<th>User input</th><td>…</td>`, each
          // content cell a stack of `<p><code>…</code></p>` lines). The numeric-grid path above needs ≥3 cols;
          // this falls through to a flattened prose dump that also mangles code underscores (`user_name`→
          // italic). Reconstruct it as a real 2-col table (U+E037): each row = label U+E038 content, the
          // content's lines joined by U+E024. Content is emitted VERBATIM (no markdown) so identifiers survive.
          const isLabelContent = rowCells.length >= 2
            && rowCells.every(cells => cells.length === 2 && /^th$/i.test(cells[0].tagName || ''));
          if (isLabelContent) {
            const rowsLc = rowCells.map(([th, td]) => {
              const label = (th.textContent || '').replace(/\s+/gu, ' ').trim();
              const ps = Array.from(td.querySelectorAll('p, div, li'));
              const lines = (ps.length ? ps.map(p => p.textContent || '')
                : [(td.textContent || '')])
                .map(s => s.replace(/\s+/gu, ' ').trim()).filter(Boolean);
              return label + String.fromCharCode(0xE038) + lines.join(String.fromCharCode(0xE024));
            }).filter(r => r.replace(/[]/gu, '').trim());
            if (rowsLc.length >= 2) {
              return '\n\n' + String.fromCharCode(0xE037) + rowsLc.join(String.fromCharCode(0xE039)) + '\n\n';
            }
          }
        }

        const childText = Array.from(element.childNodes).map(n => nodeToMarkedText(n, baseDir)).join('');
        const trimmed = childText.trim();
        if (!trimmed) return '';

        // Render a <blockquote> like the PDF: a FLUSH-LEFT set-off quotation (gap above, flush first line,
        // the source's own smaller font + italics, attribution right-aligned) - NOT a horizontally-indented
        // block. The PDF insets a quote only when the print geometry is inset on both margins, which these
        // are not (`.blockquote` = `margin:0 10% 0 0` -> left 0). So per inner block emit: the block-quote
        // ROLE (U+E019) for the set-off gap WITHOUT any NBSP indent (stays flush/full-width, reader pads
        // only when para.indent>0); U+E018 flush-first-line (the source `.block/.noindent` set text-indent:0,
        // and the reader otherwise applies its default 1.75em first-line indent since para.indent is 0); and
        // a small SIZE tier read from the quote's own font-size (sizeTierSentinel skips small tiers globally
        // to protect small-caps section headings - a quote is not a heading, so read it here: Sovereign's
        // .block/.att = 0.833em -> E01C 0.86, matching the PDF). U+E022 gives the first block the full set-
        // off top margin. ORDER IS LOAD-BEARING: every sentinel must precede any text.
        if (tag === 'blockquote') {
          // VERSE/POEM: source `.poem` lines (each a `<p>`, tight margin:0) with `.poemb` ending a stanza
          // (margin 0 0 1em). Emit each STANZA as ONE paragraph whose lines are joined by U+E024 (a hard
          // line-break sentinel the reader restores to \n so the lines render TIGHT via lineBreakAfter);
          // separate stanzas with \n\n so the reader's verse spacing puts a stanza gap between them. Not a
          // block quote — verse has its own tight-line + stanza-gap layout.
          const _poemKids = Array.from(element.children).filter(c => /\bpoem/i.test(c.getAttribute('class') || ''));
          if (_poemKids.length >= 2) {
            const _VLB = String.fromCharCode(0xE024);
            const _pMin = Math.min(..._poemKids.map(c => resolveFontEm(c)));
            const _pRatio = currentBodyEm > 0 ? _pMin / currentBodyEm : 1;
            const _pTier = _pRatio <= 0.78 ? String.fromCharCode(0xE01B) : _pRatio < 0.94 ? String.fromCharCode(0xE01C) : '';
            // Walk ALL children in order: poem lines build tight stanzas; a NON-poem child (a credit/
            // attribution after the verse — Sovereign's "—FIFTEENTH-CENTURY ENGLISH BALLAD" as a
            // `<p class="noindent">`) is flushed as its OWN block via the normal path, so it is no longer
            // dropped along with everything that isn't `.poem`.
            const _out: string[] = []; let _cur: string[] = [];
            const _flush = () => { if (_cur.length) { _out.push(_pTier + _cur.join(_VLB)); _cur = []; } };
            for (const _c of Array.from(element.children)) {
              if (/\bpoem/i.test(_c.getAttribute('class') || '')) {
                const _lt = Array.from(_c.childNodes).map(n => nodeToMarkedText(n, baseDir)).join('').replace(/\s+/g, ' ').trim();
                if (_lt) _cur.push(_lt);
                if (/\bpoemb/i.test(_c.getAttribute('class') || '')) _flush();
              } else {
                _flush();
                const _nt = nodeToMarkedText(_c, baseDir).replace(/^\n+|\n+$/g, '').trim();
                if (_nt) _out.push(_nt);
              }
            }
            _flush();
            if (_out.length) return '\n\n' + _out.join('\n\n') + '\n\n';
          }
          const blocks = childText.split(/\n{2,}/u).map(b => b.trim()).filter(Boolean);
          if (!blocks.length) return '';
          const E018 = String.fromCharCode(0xE018); // flush first line
          const E019 = String.fromCharCode(0xE019); // block-quote role (set-off gap)
          const E022 = String.fromCharCode(0xE022); // full set-off gap above (first block only)
          const _kids = Array.from(element.children).filter(c => isBlockChild(c));
          const _minEm = _kids.length ? Math.min(..._kids.map(c => resolveFontEm(c))) : resolveFontEm(element);
          const _ratio = currentBodyEm > 0 ? _minEm / currentBodyEm : 1;
          // A block quote set BELOW body (a set-off quote/definition) renders at the reader's mild-shrink tier
          // E01C (0.86). Professional EPUBs use a MILD shrink — O'Reilly's `blockquote{font-size:95%}` — which
          // the old `< 0.94` gate rounded away to body size, so the "An agent is a program…" definition read
          // full-size while the SAME book's PDF renders it smaller (measured ratio 0.82 → E01C). Extend the
          // gate to `< 0.97` so any deliberately-sub-body quote hits E01C (body-size quotes at ≥0.97 stay
          // body). Only Agentic Mesh's 95% quotes are affected among the test EPUBs; Sovereign's are 0.833.
          const _quoteSizeTier = (ratio: number): string =>
            ratio <= 0.78 ? String.fromCharCode(0xE01B) : ratio < 0.97 ? String.fromCharCode(0xE01C) : '';
          const sizeTier = _quoteSizeTier(_ratio);
          const E011 = String.fromCharCode(0xE011); // right-align (an attribution p carries this from its own handler)
          // A block quote whose source gives it a real LEFT MARGIN is an INDENTED set-off block (O'Reilly's
          // `blockquote{margin:10px}`, and its PDF insets the "An agent\u2026" definition ~1.6em). Emit a leading
          // NBSP run so the reader pads it left (bodyBlockPadStyle; E018 below keeps the first line flush at
          // that tier). Reads the ACTUAL left margin, so it is NOT specific to one book: Sovereign's
          // left-0 quotes (`.epigraph` 14% 0 0, `.blockquote` 0 10% 0 0, `.blockquote1b`) stay flush, while its
          // `.blockquote1/2/2a/2b/3a` (`margin:1em 1.2em`, inset on BOTH margins) now correctly indent \u2014 user
          // verified against the Sovereign PDF that those quotes ARE indented there. A set-off quote gets at
          // least the conventional ~1.5em (4 NBSP, matching the PDF), more if the source margin is larger.
          const _bqLeftEm = boxLeftEm(element).m;
          const _bqIndent = _bqLeftEm > 0.1 ? '\u00A0'.repeat(Math.max(4, Math.round(_bqLeftEm / 0.375))) : '';
          // Match each E011 block to its source right-aligned child. Its resolved size includes inherited
          // blockquote sizing (`blockquote{font-size:95%}`), but can still honour an explicit child reset.
          // The p handler deliberately has a wider shrink dead-zone, so without this propagation the quote
          // got E01C (0.86 reader tier) while its attribution fell back to full reader body size.
          const _rightKids = Array.from(element.children).filter(c => alignFor(c) === 'right');
          let _rightKidIndex = 0;
          const tagged = blocks.map((b, i) => {
            // Capture the COMPLETE p-handler control run before inserting block indentation. U+E028/E029
            // were added after this wrapper's old E027 ceiling; leaving them behind put the NBSP indent
            // before E028 + later controls (including E026 italic), so the reader stopped parsing at NBSP
            // and rendered an authored italic quote Roman.
            const lead = b.match(/^[\uE010-\uE029]*/u)![0];
            // An ATTRIBUTION block (right-aligned, E011) is NOT a quote: keep its own alignment/style and
            // em-dash, but carry its SOURCE size. Inherited blockquote sizing applies equally to quote and
            // attribution in CSS, so skipping the tier here made the attribution visibly larger.
            if (lead.includes(E011)) {
              const _rightKid = _rightKids[_rightKidIndex++];
              const _rightRatio = _rightKid && currentBodyEm > 0 ? resolveFontEm(_rightKid) / currentBodyEm : _ratio;
              const _rightTier = _quoteSizeTier(_rightRatio);
              // A SOURCE width constraint on the attribution (`p[data-type=attribution]{width:80%}` \u2014 O'Reilly
              // praise credits) makes it a NARROWER right-aligned block INSET from the edge, not flush. Carry
              // U+E02B so the reader insets it instead of running every wrapped line to the full right margin.
              // Only fires when the source declares a percentage width < 95% (other books' credits are full-width).
              const _wProp = _rightKid ? declProp(_rightKid, 'width') : null;
              const _wPctM = _wProp ? /^\s*(\d{1,3})\s*%\s*$/.exec(_wProp) : null;
              const _narrowAttr = _wPctM && +_wPctM[1] >= 30 && +_wPctM[1] < 95 ? String.fromCharCode(0xE02B) : '';
              return _narrowAttr + (/[\uE01B-\uE01F]/u.test(lead) ? b : _rightTier + b);
            }
            // A HANGING ENTRY (dialogue speaker turn, U+E01A) is NOT a quote \u2014 the reader renders it hanging
            // (dialogueHangStyle). Leave it verbatim so it isn't re-wrapped flush; its own source gaps (E022/E027)
            // already ride along in `lead`.
            if (lead.includes(String.fromCharCode(0xE01A))) return b;
            return (i === 0 ? E022 : '') + sizeTier + E018 + E019 + lead + _bqIndent + b.slice(lead.length);
          });
          // A ruled block-quote (`.blockquote1/2a/2b` = a solid border top+bottom) is an epigraph bracketed
          // by decorative rules in the source \u2014 emit them, like the PDF.
          const _bq = borderRuleOf(element);
          return `\n\n${_bq.top ? ruleBlock(_bq.top) : ''}${tagged.join('\n\n')}${_bq.bottom ? ruleBlock(_bq.bottom) : ''}\n\n`;
        }
        if (tag === 'cite') return `\n—— ${trimmed.replace(/^(?:——|--|—|–|-)\s*/u, '')}\n`;
        // Emphasis via a tag: same figure-marker guard as emphasize() — a decorative image inside
        // <b>/<i>/<em> must not be wrapped, or a stray "**"/"*" survives when the image is dropped.
        if (/^(?:strong|b|em|i|u|s|strike|del)$/.test(tag) && trimmed.includes('[[FIG ')) return trimmed;
        if (tag === 'strong' || tag === 'b') return `**${trimmed}**`;
        if (tag === 'em' || tag === 'i') return `*${trimmed}*`;
        if (tag === 'u') return `__${trimmed}__`;
        // A superscript. A NUMERIC one is math — an exponent like "2⁵⁰" or "10¹⁵" (the reader has no
        // superscript styling, so it flattened "2<sup>50</sup>" to "250"): map the digits to Unicode
        // superscript glyphs so they render raised in any font, extraction-only. A superscript that carries a
        // NOTE marker (a footnote ref `<sup><a>*</a></sup>`) is non-numeric → stay transparent so the inner
        // <a> emits the note reference unchanged.
        if (tag === 'sup') {
          const _sc = trimmed.replace(/\s+/g, '');
          if (/^[0-9]{1,4}$/.test(_sc)) {
            const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
            return [..._sc].map(c => SUP[c]).join('');
          }
          return childText;
        }
        if (tag === 'sub') {
          const _sc = trimmed.replace(/\s+/g, '');
          if (/^[0-9]{1,4}$/.test(_sc)) {
            const SUB: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
            return [..._sc].map(c => SUB[c]).join('');
          }
          return childText;
        }
        if (tag === 'a') {
          const href = element.getAttribute('href') || '';
          // A back-link ("BACK TO NOTE REFERENCE N", role="doc-backlink") is source navigation the reader
          // regenerates itself (handleNoteBackNavigation) — drop it so it doesn't clutter a note body as a
          // stray "[BACK TO NOTE REFERENCE N](…)" link.
          if ((element.getAttribute('role') || '').toLowerCase() === 'doc-backlink') return '';
          // Note-BODY anchor: this <a> carries the id a reference points to → emit the reader's note anchor
          // (key = the id), dropping its own back-link href. (Matches the reference's "[label](#id)".)
          const aId = element.getAttribute('id');
          if (aId && noteRefLabels.has(aId)) return `[${noteRefLabels.get(aId)}](#${aId})`;
          // Note REFERENCE: this <a> points at a note body → emit the reader's note reference marker.
          const hash = href.indexOf('#');
          const frag = hash >= 0 ? decodeURIComponent(href.slice(hash + 1)).trim() : '';
          if (frag && noteRefLabels.has(frag)) {
            // Strip a bracketed marker ("[15]" → "15") so the emitted ref is `[15](#frag)`, not the double-
            // bracketed `[[15]](#frag)` the reader's link parser can't read (leaked as raw text before).
            const lbl = (trimmed.replace(/\s+/g, ' ').trim().replace(/^\[+\s*|\s*\]+$/g, '') || noteRefLabels.get(frag)!).replace(/\.$/, '');
            return `[${lbl}](#${frag})`;
          }
          const label = trimmed.replace(/\s+/g, ' ').trim();
          // A FIGURE/IMAGE wrapped in a (navigation) link — a cover/title-page image linking back to the
          // Contents. A figure is a block, not clickable text; keeping the wrapper emitted a raw
          // "[[[FIG …]]](…Contents.xhtml#rtitle)" that leaked as the page's catalogue name. Drop the link.
          if (/^\[\[FIG\b/u.test(label) && /\]\]$/u.test(label)) return childText;
          if (href) return `[${label}](${href})`;
          // An href-less <a> is a zero-width index MARKER — a self-closing `<a data-type="indexterm" …/>`
          // that text/html parsing does NOT self-close, so the open <a> swallows the following flow content
          // (inline text, or a whole <dl>/paragraphs). The marker itself contributes NOTHING, so return its
          // childText VERBATIM — never the trimmed/flattened `label`. Trimming dropped the LEADING space of
          // swallowed inline text ("So<a/> while…" → "Sowhile…"; "Uses<a/> sophisticated…" →
          // "Usessophisticated…"); flattening collapsed a swallowed <dl> into run-on prose. childText keeps
          // both the boundary whitespace and the block \n\n structure. (`label` retained above for hrefs.)
          void label;
          return childText;
        }
        // Semantic heading → the reader's heading role (U+E013), the same sentinel PDF emits. EPUB
        // headings are authoritative (unlike PDF font-size guessing). Strip inner emphasis markers,
        // as the reader styles a heading as a whole (matches the PDF heading path).
        if (/^h[1-6]$/.test(tag)) {
          // A heading's text is a TITLE, not a hyperlink: this book wraps the chapter NUMBER and TITLE in a
          // link back to the Contents (`<h1 class="chap_head"><a href="…Contents.xhtml#rch1">…</a></h1>`).
          // Kept as `[1](…)`/`[Title](…)`, the number tripped the reader's bare-footnote inference (cyan
          // superscript) and the title rendered as a dead underlined cross-chapter link. Strip the link to
          // its text so the heading renders plain (the reader has its own chapter nav).
          const clean = trimmed.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1').replace(/[*_~`]/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n+ */g, '\n').replace(/^\n+|\n+$/g, '');
          if (!clean) return '';
          // A heading the source sets WHOLLY ITALIC (Sovereign's sub-section titles are `<h3><i>The
          // Information Revolution</i></h3>`) loses that when the emphasis markers are stripped above (the
          // reader styles a heading as a whole). Detect it from the DOM — every text-bearing node sits under
          // an <i>/<em> or an italic-resolving element — and emit the U+E026 whole-paragraph-italic sentinel
          // so the reader renders the heading italic (its own font-bold + fontStyle:italic = bold italic).
          const SENT_ITALIC = String.fromCharCode(0xE026);
          const _hWhollyItalic = ((): boolean => {
            let hasText = false, allItalic = true;
            const walkI = (n: Node, inItalic: boolean): void => {
              if (n.nodeType === 3) { if ((n.textContent || '').trim()) { hasText = true; if (!inItalic) allItalic = false; } return; }
              if (n.nodeType !== 1) return;
              const e = n as Element; const t = (e.tagName || '').toLowerCase();
              const it = inItalic || t === 'i' || t === 'em' || elItalicOf(e);
              for (const c of Array.from(e.childNodes)) walkI(c, it);
            };
            walkI(element, false);
            return hasText && allItalic;
          })();
          const _hItalicMark = _hWhollyItalic ? SENT_ITALIC : '';
          // A heading the source sets small-caps (Singularity's `h2.x07-List-Unnumbered-Head` chart-data
          // titles, `font-variant:small-caps`) → the U+E02C whole-paragraph small-caps sentinel so the reader
          // renders it small-caps on the ORIGINAL mixed-case text (not the flat all-caps it decoded to before).
          const _hSmallCapsMark = elSmallCapsOf(element) ? String.fromCharCode(0xE02C) : '';
          const _hColorMark = accentSentinelFor(cssColorOf(element)); // source heading color → reader accent (U+E030+)
          // A "heading" whose text is a LIST-MARKER LABEL ("IF:"/"THEN:", or a bare "1."/"a." marker) is a list
          // head, NOT a section title (Singularity's `.x07-List-Head` <h2>IF:</h2> above a numbered <ol>). Emit
          // it as an INDENTED, non-heading paragraph (leading NBSP from its source left margin, no U+E013) so
          // the reader's isRuleItem — which recognises the SAME IF:/THEN:/N. markers the PDF splitter does —
          // renders it via ruleHangStyle, coherent with the numbered items below it and identical to the PDF.
          // (A numbered SECTION heading like "1. Introduction" has text after the marker, so it is NOT caught.)
          const _hm = clean.replace(/^[*_~`]+/u, '');
          if (/^(?:IF:|THEN:)/i.test(_hm) || /^(?:\d{1,2}[.)]|(?:[a-z]|[ivxlcdm]{2,7})[.)])\s*$/u.test(_hm)) {
            // Mother level of a LABELLED LIST: this IF:/THEN: label sits right before a numbered <ol>
            // (the EPUB nests nothing — they are flat siblings), so render the label one tier SHALLOWER
            // than the items (4 NBSP) and let the <li> items go one tier deeper (8 NBSP, below), inferring
            // the hierarchy the PDF shows. A lone marker label with no following list keeps its source margin.
            const _nextIsList = /^(?:ol|ul)$/i.test(element.nextElementSibling?.tagName || '');
            const _hEm = boxLeftEm(element).m;
            const _hInd = _nextIsList ? ' '.repeat(4) : (_hEm > 0.5 ? ' '.repeat(Math.min(12, Math.round(_hEm / 0.375))) : '');
            const _hv = vMarginEm(element);
            const _hGap = (_hv.top > 1 ? String.fromCharCode(0xE022) : '') + (_hv.bottom > 1 ? String.fromCharCode(0xE027) : '');
            return `\n\n${_hGap}${_hInd}${_hm.replace(/\n/g, ' ')}\n\n`;
          }
          const _lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
          // MAJOR STRUCTURAL DIVISION ON A NEW PAGE: the source begins this section on a fresh page — signalled
          // by a calibre page-break split id (`calibre_pb_N`) on the heading, or a CSS page-break-before /
          // break-before of always|page|left|right. Emit the U+E02A hard-break sentinel so the reader's
          // paginator opens a new page before it, regardless of remaining space (the typographic rule the
          // Sovereign uses: every in-chapter <h2> sub-section starts a new page). NOT the frequent print
          // page-NUMBER anchors (`<span epub:type="pagebreak" id="page_213">`) — those are spans, never headings.
          const _pbId = element.getAttribute('id') || '';
          const _pbCss = ((element as HTMLElement).style?.pageBreakBefore || (element as HTMLElement).style?.breakBefore
            || declProp(element, 'page-break-before') || declProp(element, 'break-before') || '').toLowerCase();
          const _pbMark = (/calibre_pb|(?:^|[_-])pb[_-]?\d/i.test(_pbId) || ['always', 'page', 'left', 'right'].includes(_pbCss))
            ? String.fromCharCode(0xE02A) : '';
          const _h1em = resolveFontEm(element);
          const _tierOf = (em: number) => { const r = currentBodyEm > 0 ? em / currentBodyEm : 1; return r >= 1.6 ? String.fromCharCode(0xE01F) : r >= 1.25 ? String.fromCharCode(0xE01E) : r > 1.08 ? String.fromCharCode(0xE01D) : ''; };
          // PRINCIPLE FIRST — the file's OWN size signal wins: read each display:block child's CSS font-size
          // (a chapter heading's title/deck are styled spans). If the heading differentiates its lines' sizes
          // itself, honour them per line and skip the heuristic below.
          const _kids = Array.from(element.children).filter(c => isBlockChild(c));
          const _kidEms = _kids.map(c => resolveFontEm(c));
          const _multiSized = _kidEms.some(e => Math.abs(e - _h1em) >= 0.02) || _kidEms.some((e, k) => k > 0 && Math.abs(e - _kidEms[0]) >= 0.02);
          // A chapter DECK (e.g. `.heading_break1`) is a styled block child bracketed by a DOUBLE border top+
          // bottom — the source's decorative rules around the subtitle. Map each heading line back to its block
          // child (offset 1 when a leading text node like "CHAPTER 3" precedes the first child) and emit that
          // child's rules as their OWN divider paragraphs around the line (never inside the heading sentinel).
          const _off = _lines.length - _kids.length; // 0 (line↔child) or 1 (leading text node first)
          // A heading carries its own text-align (this book's `.chap_num`/`.chap_head` are text-align:center;
          // the reader left-aligns a heading unless it sees the align sentinel). Emit it so a centred chapter
          // number/title stays centred instead of collapsing to the left.
          const _hAlign = alignFor(element);
          const _hAlignSent = _hAlign === 'center' ? SENT_CENTER : _hAlign === 'right' ? String.fromCharCode(0xE011) : '';
          const _wrapHeadingLine = (l: string, k: number, tier: string): string => {
            const kid = (_off === 0 || _off === 1) ? _kids[k - _off] : undefined;
            const br = kid ? borderRuleOf(kid) : { top: null, bottom: null };
            return (br.top ? ruleBlock(br.top) : '') + _hAlignSent + tier + SENT_HEADING + _hItalicMark + _hSmallCapsMark + _hColorMark + l + (br.bottom ? ruleBlock(br.bottom) : '');
          };
          if (_multiSized && (_lines.length === _kidEms.length || _lines.length === _kidEms.length + 1)) {
            const _ems = _lines.length === _kidEms.length ? _kidEms : [_h1em, ..._kidEms];
            return '\n\n' + _pbMark + _lines.map((l, k) => _wrapHeadingLine(l, k, _tierOf(_ems[k]))).join('\n\n') + '\n\n';
          }
          // FLAT — the CSS gives the whole heading ONE font-size (a chapter <h1> stacks number / title / deck
          // all at ~2em; the deck only LOOKS bigger via a distinct sans font, which the single-font reader
          // can't reproduce). Render every line at the heading's OWN tier — a uniform chapter block (all
          // 1.5em) that stays larger than section headings (1.25em) and is faithful to the real font-sizes.
          const _st = _tierOf(_h1em);
          return '\n\n' + _pbMark + _lines.map((l, k) => _wrapHeadingLine(l, k, _st)).join('\n\n') + '\n\n';
        }
        if (['p', 'div', 'section', 'article'].includes(tag)) {
          // The publisher's TOC points at this styled paragraph (see navAnchorIds) → it IS a heading, so
          // emit the heading sentinel like an <h1>–<h6>. This renders a CSS-class section heading as a
          // heading regardless of casing, instead of a bold run-in. Guard: a real heading isn't a full
          // sentence, so skip when the text ends in terminal punctuation (a footnote/prose paragraph that
          // happens to carry a TOC-referenced id). ALSO guard on LENGTH: a heading is short — a whole
          // chapter CONTAINER that a nav entry points at (an <section data-type="index"> the "Index" nav
          // entry targets, or a chapter wrapper) is thousands of chars; treating it as one heading collapses
          // all its inner \n\n to \n (via / *\n+ */→\n) and stamps the whole chapter bold+oversized. Only a
          // short, heading-length block qualifies.
          const headId = element.getAttribute('id');
          const _navHeadLen = trimmed.replace(/\[\[(?:FIG|PAGE)[^\]]*\]\]/gu, '').replace(/[-]/gu, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim().length;
          // A nav-referenced block that CONTAINS a figure is a figure PAGE (this book's "The Basics of
          // Human Brain Anatomy": <section><h2>title</h2><div class="fig_85"><img/><p>credit</p></div>), NOT a
          // run-in heading. Flattening it into one heading dropped the [[FIG]] marker (the figure vanished);
          // let its own <h2>/<img> children render instead.
          if (headId && navAnchorIds.has(headId) && !/\[\[FIG/u.test(trimmed) && _navHeadLen > 0 && _navHeadLen < 90 && !/[.!?。！？]["'”’)\]]?$/u.test(trimmed.replace(/[*_~`]+$/u, '').trim())) {
            const clean = trimmed.replace(/[*_~`]/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n+ */g, '\n').replace(/^\n+|\n+$/g, '');
            if (clean) return `\n\n${sizeTierSentinel(element)}${SENT_HEADING}${clean}\n\n`;
          }
          const a = alignFor(element);
          const sentinel = a === 'center' ? '' : a === 'right' ? '' : '';
          // Whole-paragraph italic (a quote/epigraph <p> the stylesheet italicises — often through a
          // descendant selector the class maps can't see) → the E026 paragraph-italic sentinel, NOT a `*…*`
          // wrap (the reader's sentence splitter would break the markers across sentences). Inner <em> stays
          // wrapped inline. A ::before pseudo-element's content (an attribution em-dash, never in textContent)
          // is prepended.
          const _pItalic = elItalicOf(element);
          // Whole-paragraph small-caps (an epigraph attribution `p.x03-Chapter-Epigraph-Source`, a chart-data
          // title) → the U+E02C sentinel, same leading-flag mechanism as whole-para italic.
          const _pSmallCaps = elSmallCapsOf(element);
          // Drop cap — a chapter-opener <p> whose class has a floated ::first-letter → the U+E02E sentinel so
          // the reader floats an oversized initial (via a ::first-letter CSS class, reproducing the source).
          const _pDropCap = (element.getAttribute('class') || '').split(/\s+/).some(c => cssDropCap.has(c));
          const _before = beforeContentOf(element);
          // The "already emphasised" guard must ignore a LINK's href — a TOC/Contents entry is a single
          // link "[Chapter 1: …](09_Chapter_1_Where_Are_W.xhtml)" whose href is full of underscores; counting
          // those as emphasis markers wrongly dropped the source's bold (font-weight:bold on the entry). Strip
          // `](href)` targets before the check so only REAL emphasis in the visible text suppresses the wrap.
          const _emphProbe = trimmed.replace(/\]\([^)\n]*\)/gu, ']');
          // A whole-paragraph BOLD block → wrap in `**…**`. This coexists with whole-paragraph italic (E026):
          // a `.byline`/credit set both bold AND italic, so DON'T gate on `!_pItalic` (that dropped the bold,
          // leaving the byline italic-only). The reader renders the `**` bold run inside the E026 italic para.
          const _bodyBold = elBoldOf(element) && !/[*_]/u.test(_emphProbe) && !trimmed.includes('[[FIG ');
          let body = _before + (_bodyBold ? `**${trimmed}**` : trimmed);
          // Reproduce CSS `text-transform:uppercase` on a block (a Contents entry, a small-caps section head):
          // upper-case the VISIBLE text but PROTECT link hrefs (a `[Title](09_Chapter_1_…xhtml)` target must
          // stay verbatim or the reader can't resolve the jump). Kurzweil's Contents entries are uppercase.
          {
            const _tt = ((element as HTMLElement).style?.textTransform || declProp(element, 'text-transform') || '').toLowerCase();
            if (_tt === 'uppercase' && body) {
              const _hrefs: string[] = [];
              const _MK = '\uE0FF'; // PUA delimiter — never in body text, survives toUpperCase
              body = body
                .replace(/\]\(([^)\n]*)\)/gu, (_m, h) => { _hrefs.push(h); return `](${_MK}${_hrefs.length - 1}${_MK})`; })
                .toUpperCase()
                .replace(new RegExp(_MK + '(\\d+)' + _MK, 'gu'), (_m, i) => _hrefs[Number(i)]);
            }
          }
          // A lone TOC/Contents LINK ("[10 THE REVENGE…](text00015.html)") also uses a negative
          // text-indent + matching margin (a hanging-NUMBER technique), which would otherwise trip the
          // dialogue hanging-entry detector below and render it flush. Compute it here so that branch can
          // skip it — a TOC entry indents via its margin-left in the lone-link branch instead.
          const _loneLink = /^\*{0,2}\[[^\]\n]+\]\([^)\n]+\)\*{0,2}$/.test(body.trim());
          // HANGING ENTRY (dialogue speaker turn / hanging definition). The source gives the <p> a NEGATIVE
          // text-indent with a matching positive left margin so the first line (the speaker label) hangs at the
          // margin while wrapped lines indent — Kurzweil's `p.x06-Dialogue { margin-left:3.4em; text-indent:-3.4em }`.
          // This is the SAME geometry the PDF's hanging-list detector emits U+E01A for; emit it here so the reader
          // renders each turn hanging (dialogueHangStyle) instead of a flush block-quote. General (any hanging <p>,
          // margin ≈ -text-indent), not class-specific; the source top/bottom margin drives the set-off gaps.
          const _tIndentEm = lenToEm((declProp(element, 'text-indent') || (element as HTMLElement).style?.textIndent || '').replace(/!important/ig, '')) ?? 0;
          const _hangLeftEm = boxLeftEm(element).m;
          if (!_loneLink && _tIndentEm < -0.5 && _hangLeftEm > 0.5 && Math.abs(_hangLeftEm + _tIndentEm) < 1.2) {
            const _hn = Math.max(4, Math.round(_hangLeftEm / 0.375));
            const _hv = vMarginEm(element);
            const _hGap = (_hv.top > 1 ? String.fromCharCode(0xE022) : '') + (_hv.bottom > 1 ? String.fromCharCode(0xE027) : '');
            return `\n\n${_hGap}${sizeTierSentinel(element)}${String.fromCharCode(0xE01A)}${'\u00a0'.repeat(_hn)}${body}\n\n`;
          }
          // Email/memo header block: split its <br>-joined fields into their own paragraphs so the
          // reader renders each field flush + un-bold + tight (matches the PDF appendix path).
          if (isEmailHeaderBlock(trimmed)) {
            // A <br/>'s \n is followed by the next line's leading whitespace (the source newline after
            // <br/> collapses to a space), so consume that whitespace before the label or the split misses.
            const perField = body.replace(/\n[^\S\n]*(?=(?:[*_~`]*)(?:From|To|Cc|Bcc|Date|Sent|Subject|Reply-To)\s*:\s)/gi, '\n\n');
            return `\n\n${sizeTierSentinel(element)}${sentinel}${perField}\n\n`;
          }
          // A <br>-separated LINE BLOCK that includes standalone LINKS (e.g. "FOR MORE ON THESE AUTHORS:"
          // followed by two author URLs, each on its own line) — the reader flows a single \n, collapsing
          // the source's explicit breaks and running the long URLs off the edge. Promote each <br> line to
          // its own paragraph so the 3-line structure survives (and each URL wraps within the column).
          const _brLines = body.split('\n').map(s => s.trim()).filter(Boolean);
          if (_brLines.length >= 2 && _brLines.some(s => /^\[[^\]]+\]\([^)]+\)\s*$/.test(s)) && _brLines.every(s => s.length < 120)) {
            return `\n\n${_brLines.map(s => `${sizeTierSentinel(element)}${sentinel}${s}`).join('\n\n')}\n\n`;
          }
          // A Contents/TOC SUB-entry — a lone internal link whose CSS gives it a left indent (e.g.
          // Transurfing's `.ogl-zag1 { margin: 0 0 0 14px }`) sits indented under its chapter. Mirror the
          // index-sub mechanism: prefix leading NBSP (4 per ~14px depth level, which the reader's
          // index/Contents indent renders as padding). Gated to a lone link so body prose / blockquotes
          // with a left margin never pick up a stray indent.
          const indentPx = indentFor(element);
          // Tolerate a `**…**` bold wrap (a bold TOC entry — Kurzweil's `x01-FM-Contents-FM` is bold AND
          // margin-left:10% indented) so it still gets its indent NBSP, not just chapters. The `**` rides along.
          if (_loneLink && indentPx >= 8) {
            const levels = Math.min(4, Math.max(1, Math.round(indentPx / 14)));
            return `\n\n${sizeTierSentinel(element)}${sentinel}${' '.repeat(levels * 4)}${body}\n\n`;
          }
          // indentFor is px-ONLY, so a Kurzweil TOC front-matter entry's `margin-left:10%` (em/%) read as
          // 0 and rendered FLUSH like a chapter. Resolve an em/% left margin here (~% of the reading
          // column) and emit its NBSP so front matter indents and chapters (margin-left:0) stay flush.
          if (_loneLink && indentPx < 8) {
            const _mlRaw = (((element as HTMLElement).style?.marginLeft
              || declProp(element, 'margin-left')
              || ((): string => { const q = (declProp(element, 'margin') || '').replace(/!important/ig, '').trim().split(/\s+/); return q.length === 4 ? q[3] : q.length >= 2 ? q[1] : ''; })()
              || '') as string).replace(/!important/ig, '').trim();
            const _mlNum = parseFloat(_mlRaw) || 0;
            const _indentEm = /%$/.test(_mlRaw) ? _mlNum * 0.36 : /r?em$/i.test(_mlRaw) ? _mlNum : 0;
            // A TOC front-matter entry positions its (single) line with a POSITIVE first-line text-indent
            // on top of the small margin (Elon EPUB `.toc_text { margin-left:0.3em; text-indent:1em }` →
            // 1.3em, aligned with the chapter titles). Margin alone (0.3em) read as flush and broke that
            // alignment. Use the FULL text-indent (a single line's position = margin + text-indent): positive
            // pushes front matter out to the title column, negative pulls a non-numbered entry back (EPILOGUE
            // `margin-left:2.3em; text-indent:-1em` → 1.3em, aligned). A numbered chapter's negative text-indent
            // is its number-hang, but those render via the reader gutter (para.indent ignored), so this is safe.
            const _effEm = Math.max(0, _indentEm + _tIndentEm);
            if (_effEm >= 0.6) {
              const _nbsp = Math.min(16, Math.round(_effEm / 0.375));
              return `\n\n${sizeTierSentinel(element)}${sentinel}${' '.repeat(_nbsp)}${body}\n\n`;
            }
          }
          // A list-head LABEL paragraph (Singularity's `.x07-List-Head-No-Space` <p>THEN: …</p>, the twin of
          // the <h2>IF:</h2> above the numbered list): its text is a THEN:/IF: marker. Give it its source
          // left indent (leading NBSP) so the reader's isRuleItem renders it via ruleHangStyle — coherent
          // with IF: and the numbered items, matching the PDF. Narrowly gated to the IF:/THEN: label so
          // ordinary indented prose is untouched.
          // A list-head LABEL paragraph (THEN:) — read its indent from boxLeftEm (the general CSS matcher),
          // NOT indentFor, which returns 0 for this <p class=x07-List-Head-No-Space>. When it follows the
          // numbered <ol>, it is the MOTHER level (4 NBSP), aligned with the IF: label; otherwise its source
          // margin. isRuleItem then renders 'THEN:' via ruleHangStyle.
          const _thenEm = boxLeftEm(element).m;
          if (_thenEm >= 1.5 && /^(?:IF:|THEN:)/i.test(body.replace(/^[*_~`]+/u, ''))) {
            const _prevIsList = /^(?:ol|ul)$/i.test(element.previousElementSibling?.tagName || '');
            const _pn = _prevIsList ? 4 : Math.min(12, Math.round(_thenEm / 0.375));
            const _pv = vMarginEm(element);
            const _pGap = (_pv.top > 1 ? String.fromCharCode(0xE022) : '') + (_pv.bottom > 1 ? String.fromCharCode(0xE027) : '');
            return `\n\n${_pGap}${sizeTierSentinel(element)}${sentinel}${' '.repeat(_pn)}${body}\n\n`;
          }
          // Doc-level layout tally: this is a genuine body paragraph. Count it, whether it resolves to
          // JUSTIFIED text (CSS inheritance walked), and whether it carries a first-line indent (its own
          // text-indent) - feeds sourceJustified / sourceFirstLineIndent after the walk. Real prose only.
          if (tag === 'p' && trimmed.length > 40) {
            bodyParaTally++;
            if (effectiveAlignOf(element) === 'justify') justifiedParaTally++;
            // Resolve this paragraph's DECLARED first-line indent (inline style, else its text-indent-declaring
            // class with the largest-magnitude value). The book's first-line-indent convention is judged ONLY
            // over paragraphs that DECLARE a treatment — positive (indented) vs ~zero (flush body). UNDECLARED
            // paragraphs and NEGATIVE (hanging index/bibliography) entries vote for NEITHER: else a big index /
            // notes / undeclared front-matter section (hundreds of flush/hanging ¶) drowns a genuine first-line
            // indent body — Kurzweil has 697 indented body ¶ (x04-Body-Text, 1.32em) yet the raw all-¶ ratio
            // fell to 0.24, misclassifying the book as block-style and flushing every paragraph.
            const _tiIn = (element as HTMLElement).style?.textIndent;
            const _hasInlineTi = !!_tiIn && _tiIn.trim() !== '';
            const _declCls = (element.getAttribute('class') || '').split(/\s+/).filter(c => cssTiDeclared.has(c));
            let _declTi = _hasInlineTi ? (lenToEm(_tiIn) ?? 0) : 0;
            if (!_hasInlineTi) for (const c of _declCls) { const t = cssBoxLeftEm[c].ti; if (Math.abs(t) > Math.abs(_declTi)) _declTi = t; }
            if (_declTi > 0.1) { firstIndentParaTally++; firstIndentEms.push(_declTi); }
            else if ((_hasInlineTi || _declCls.length > 0) && Math.abs(_declTi) <= 0.1) flushDeclParaTally++;
          }
          // Reproduce the source's per-paragraph FIRST-LINE INDENT. The reader indents every body paragraph
          // by default (1.75em); a paragraph the source sets flush (text-indent:0 — e.g. Sovereign's
          // `.noindent` first-of-section paragraph) emits U+E018 (flush first line) to override that, matching
          // the PDF. Only when the paragraph EXPLICITLY declares text-indent ~= 0 (cssTiDeclared) and no
          // positive indent; a paragraph that merely omits text-indent keeps the reader default, and a
          // negative (hanging) text-indent is left alone.
          const _tiInlineRaw = (element as HTMLElement).style?.textIndent;
          const _tiInline = _tiInlineRaw && _tiInlineRaw.trim() !== '' ? (lenToEm(_tiInlineRaw) ?? null) : null;
          const _tiDecl = _tiInline != null ? [_tiInline]
            : (element.getAttribute('class') || '').split(/\s+/).filter(c => cssTiDeclared.has(c)).map(c => cssBoxLeftEm[c].ti);
          const flushFirst = tag === 'p' && !_tiDecl.some(v => v > 0.05) && _tiDecl.some(v => Math.abs(v) <= 0.05);
          const flushSentinel = flushFirst ? String.fromCharCode(0xE018) : '';
          // Heading guard for the shrink tier: an EPUB heading is normally an <h*>/nav-anchored element
          // handled in an earlier branch, so anything reaching here is body content. As a backstop against
          // an UNTAGGED small-caps section head (a short all-caps <p> with a small font), don't allow shrink
          // on a short ALL-CAPS line with no terminal punctuation. Genuine small body text (notes, copyright
          // fine print, even short address lines like 'New York, NY 10020') has lowercase, so it still shrinks.
          const _shrinkText = trimmed.replace(/[\uE000-\uF8FF*_~`]+/gu, '').trim();
          const _looksLikeHeading = _shrinkText.length > 0 && _shrinkText.length < 50 && /[A-Za-z]/.test(_shrinkText) && _shrinkText === _shrinkText.toUpperCase() && !/[.!?]$/.test(_shrinkText);
          // Explicit LEFT: a paragraph the source aligns left (e.g. copyright/dedication `.copya/.copyb`
          // in a book whose body is justified) emits U+E023 so the reader skips justify and renders it
          // left-ragged, matching the source. effectiveAlignOf resolves CSS inheritance; body prose
          // resolves to 'justify' (no sentinel), only genuinely-left paragraphs get E023.
          const leftSentinel = effectiveAlignOf(element) === 'left' ? String.fromCharCode(0xE023) : '';
          // An INDEX paragraph (the "A note about the index:" intro, class `indextxt`) shares the index's own
          // reduced baseline (the whole index is 0.75em — note AND entries alike), so it must NOT be shrunk
          // relative to the document body: the index <li> entries render at reader-normal size (no shrink),
          // and the note has to match them. Suppress the shrink tier for index-class paragraphs.
          const _isIndexPara = (element.getAttribute('class') || '').split(/\s+/).some(c => /^index/i.test(c));
          // The all-caps SHRINK guard protects an UNTAGGED section heading (a flush-left short caps line) from
          // being read as small print. A CENTRED caps line is not a section head — it's display/promo text
          // (e.g. Sovereign's centred 0.75em "A TOUCHSTONE BOOK") — so honour its real small size.
          const _allowShrink = (!_looksLikeHeading || a === 'center') && !_isIndexPara;
          // A ruled block (`.footnote` = a solid border-top separating chapter-end notes from the body; or a
          // block that brackets itself with a border) draws the source's decorative rule above/below it.
          const _pr = borderRuleOf(element);
          // MEASURED paragraph gap (ports the PDF's U+E028): reproduce the source's inter-paragraph spacing
          // from the CSS vertical margin — this paragraph's margin-top OR the previous block's margin-bottom
          // (CSS adjacent margins collapse to the MAX, e.g. the gap after a <dl>'s margin-bottom lands on the
          // next <p>). Block-spaced EPUB gets its real gaps; a first-line-indent EPUB (margin:0) adds nothing —
          // the analogue of the PDF's gapRatio>=1.35 gate. Reader renders E028 (shared path).
          const _prevSib = element.previousElementSibling;
          // Read the previous block's margin-bottom ONLY when it is a body block the reader does NOT space
          // itself — a HEADING already carries its own bottom gap (mt-8 mb-3), so reading its margin-bottom here
          // would DOUBLE-count (Sovereign's 368 `.noindent` section openers follow an <h*> and have no margin
          // of their own). Excluding headings keeps a genuine block-spaced book firing while a first-line-indent
          // book (opener flush after a heading) adds nothing spurious.
          const _prevBottom = (_prevSib && !/^h[1-6]$/i.test(_prevSib.tagName || '')) ? vMarginEm(_prevSib).bottom : 0;
          const _gapAbove = Math.max(vMarginEm(element).top, _prevBottom);
          const gapSentinel = _gapAbove >= 0.35 ? String.fromCharCode(0xE028) : '';
          // A SET-OFF <p> EXTRACT (O'Reilly `p.extract_*` = inset on BOTH margins + smaller font) is not a
          // <blockquote> TAG, so it reached this general path with NO block indent -> rendered full-width. Detect
          // it by its RIGHT inset (body text fills the width, so margin-right>0 is the set-off signal; absolute
          // margin-LEFT can't tell it from a book with a base body margin, e.g. Agentic has margin-left on every
          // p) and emit the left margin as a leading NBSP run (same as the <blockquote> handler) so the reader
          // insets it. Harness scripts/epub-pindent-audit.mjs: 0% on Agentic/Transurfing/Sovereign body.
          const _mrOf = (el: Element): number => { const d = declProp(el, 'margin-right'); if (d != null) return lenToEm(d.replace(/!important/ig, '')) ?? 0; const sh = (declProp(el, 'margin') || '').replace(/!important/ig, '').trim(); if (!sh) return 0; const q = sh.split(/\s+/); return lenToEm(q.length >= 2 ? q[1] : q[0]) ?? 0; };
          const _pLeftEm = boxLeftEm(element).m;
          // Set-off = a RIGHT inset (extracts inset BOTH margins; footnotes/body inset only the left). declProp
          // resolves the right margin unreliably for the FIRST extract paragraph (`extract_flush_left` -> 0 vs
          // `extract_indented` -> 2 on IDENTICAL CSS), so ALSO treat a paragraph as set-off when an ADJACENT
          // sibling at the SAME left margin carries the right inset — the memo's flush opener then insets with
          // its indented siblings. A footnote (margin-left, no right inset, no right-inset sibling) and body text
          // stay full-width. Harness scripts/epub-pindent-audit.mjs verifies 0% on Agentic body + footnotes out.
          const _setoffSib = (sib: Element | null): boolean => !!sib && (sib.tagName || '').toLowerCase() === 'p' && _mrOf(sib) >= 0.5 && Math.abs(boxLeftEm(sib).m - _pLeftEm) < 0.3;
          const _isSetoff = _mrOf(element) >= 0.5 || _setoffSib(element.previousElementSibling) || _setoffSib(element.nextElementSibling);
          const _pIndent = (_isSetoff && _pLeftEm >= 0.5) ? '\u00A0'.repeat(Math.max(4, Math.round(_pLeftEm / 0.375))) : '';
          // Within a SET-OFF extract the source keeps its per-paragraph first-line structure: FIRST paragraph
          // flush (`extract_flush_left`, text-indent:0 -> the U+E018 flush sentinel) and CONTINUATION paragraphs
          // first-line-indented (`extract_indented`, text-indent:1em). The block indent (leading NBSP -> para.indent)
          // otherwise makes the reader drop ALL first-line indent (para.indent>0 => noTextIndent), flattening the
          // block. Emit U+E029 -- a POSITIVE "first-line indented" flag (complement of E018) -- on a block-indented
          // paragraph that DECLARES a positive text-indent, so the reader restores its first-line indent ON TOP of
          // the block padding. Positive signal (not "absence of E018"), so a <dd>/blockquote/index never picks it up.
          const _firstIndentSentinel = (_isSetoff && _pLeftEm >= 0.5 && _tiDecl.some(v => v > 0.05)) ? String.fromCharCode(0xE029) : '';
          return `\n\n${_pr.top ? ruleBlock(_pr.top) : ''}${gapSentinel}${sizeTierSentinel(element, _allowShrink)}${sentinel}${flushSentinel}${leftSentinel}${_firstIndentSentinel}${_pItalic ? '' : ''}${_pSmallCaps ? '' : ''}${_pDropCap ? '' : ''}${_pIndent}${body}${_pr.bottom ? ruleBlock(_pr.bottom) : ''}\n\n`;
        }
        // A DEFINITION LIST (<dl> of <dt> term / <dd> description) — O'Reilly's "What You Will Learn" and
        // similar. Without a handler the whole list flattens into run-on prose. Emit each <dt> as its OWN
        // paragraph (italic when `dt{font-style:italic}` resolves — via the general matcher) and each <dd> as
        // an INDENTED paragraph below it, the indent taken from the <dd>'s own left margin (`dd{margin-left:
        // 1.5em}`), mapped to the reader's NBSP indent the same way index sub-entries are.
        if (tag === 'dl') {
          const E026 = String.fromCharCode(0xE026);
          const parts: string[] = [];
          for (const kid of Array.from(element.children)) {
            const kt = (kid.tagName || '').toLowerCase();
            if (kt !== 'dt' && kt !== 'dd') continue;
            const raw = Array.from(kid.childNodes).map(n => nodeToMarkedText(n, baseDir)).join('');
            if (kt === 'dt') {
              const term = raw.replace(/[\u{E000}-\u{F8FF}]/gu, '').replace(/\s+/g, ' ').trim();
              if (term) parts.push((elItalicOf(kid) ? E026 : '') + (elSmallCapsOf(kid) ? String.fromCharCode(0xE02C) : '') + term);
            } else {
              // Keep the description's inline emphasis/links; drop its inner block sentinels, then indent it.
              const desc = raw.replace(/[\u{E010}-\u{E026}]/gu, '').replace(/\s+/g, ' ').trim();
              if (!desc) continue;
              // The <dd>'s cascaded left margin (LAST value wins — the reset's `margin:0` precedes
              // `dd{margin:…1.5em}`, so read the LAST margin/margin-left, not the first).
              const _explicit = declProp(kid, 'margin-left');
              let ml = _explicit != null ? (lenToEm(_explicit.replace(/!important/ig, '')) ?? 0) : 0;
              if (!ml) { const sh = (declProp(kid, 'margin') || '').replace(/!important/ig, '').trim(); if (sh) { const q = sh.split(/\s+/); const l = q.length === 4 ? q[3] : q.length >= 2 ? q[1] : q[0]; ml = lenToEm(l) ?? 0; } }
              const nbsp = Math.round(Math.max(0, ml) / 0.375);
              parts.push(' '.repeat(nbsp) + desc);
            }
          }
          return parts.length ? '\n\n' + parts.join('\n\n') + '\n\n' : '';
        }
        if (tag === 'li') {
          const liClass = (element.getAttribute('class') || '').toLowerCase();
          // Note BODY as a semantic <li> (O'Reilly/Kurzweil: `<ol class="endnotes"><li id="EndnoteNumberN">`
          // under `<div role="doc-endnotes">`). The frag id sits on the <li>, not an <a>, so the note-body
          // ANCHOR rule (~line 1535) can't key it — and the ol-marker path below would stamp the LIST position
          // (which drifts from the displayed number: notes restart per chapter while the frag increments
          // globally) instead of the note's own key. Emit the SAME `[label](#id)` key marker calibre's <a id>
          // note bodies use, so the reader's note locator (parseLeadingNoteMarker → noteKey match) resolves it
          // and bounds each entry — inheriting the working path (fixes the merged 18/19 body + SOURCE_REQUIRED).
          const _noteBodyId = element.getAttribute('id') || '';
          if (_noteBodyId && noteRefLabels.has(_noteBodyId)) {
            const _noteText = Array.from(element.childNodes).map(n => nodeToMarkedText(n, baseDir)).join('')
              .replace(/[\u{E010}-\u{E027}]/gu, '').replace(/\s+/g, ' ').trim();
            return `\n\n[${noteRefLabels.get(_noteBodyId)}](#${_noteBodyId}) ${_noteText}\n\n`;
          }
          // Index entries are a structured list: emit each as its own paragraph so
          // downstream prose-reflow can't merge them, and prefix sub-entries with
          // non-breaking spaces (which survive whitespace collapsing) to preserve
          // their indentation under the parent term.
          // An index entry can be marked by CLASS (indexsub/indexmain \u2014 Sovereign) OR by the semantic
          // EPUB index markup (a <section|div data-type="index"> container with <span data-type="index-term">
          // / <a data-type="index:locator"> children \u2014 Agentic Mesh). Either way it is a structured index
          // entry, NOT a bulleted list: the source sets `list-style-type:none`, so it must emit flush (with
          // NBSP indent for sub-entries under a parent term), never with a "\u2022".
          const isIndexEntry = (() => {
            if (liClass.includes('indexsub') || liClass.includes('indexmain')) return true;
            // Walk ancestors with getAttribute (querySelector/closest can be unreliable on the EPUB's
            // parsed XHTML DOM) for the index container: <section|div data-type="index"> / <div class="index">
            // / epub:type="index".
            for (let anc: Element | null = element; anc; anc = anc.parentElement) {
              const dt = (anc.getAttribute('data-type') || '').toLowerCase();
              const cl = (anc.getAttribute('class') || '').toLowerCase();
              const et = (anc.getAttribute('epub:type') || anc.getAttribute('type') || '').toLowerCase();
              if (dt === 'index' || et.includes('index') || /\bindex\b/.test(cl)) return true;
            }
            return false;
          })();
          if (isIndexEntry) {
            // CSS-derived index indent: reader renders (nbsp/4)*1.5em = nbsp*0.375em, so map the entry's
            // rendered em indent to leading NBSP. A main entry nets ~0 (flush); a sub-entry gets its real
            // margin + the nested list's UA padding (~2.2-4em) instead of a flat single level.
            const nbsp = Math.round(renderedIndentEm(element) / 0.375);
            // Emit the entry's OWN text (index term + its direct locator links) as ONE paragraph, then
            // recurse into any nested sub-entry <ul>/<ol> so each sub-entry is its OWN indented paragraph.
            // Do NOT let the generic block wrapper handle the nested list: it joins with a single '\n', which
            // merges a parent term with its first sub-entry (and cascades the whole index into the "Index"
            // heading paragraph \u2014 rendering every entry bold + oversized). Explicit '\n\n' keeps entries apart.
            const isSubList = (n: Node): boolean => n.nodeType === 1 && /^(?:ul|ol)$/i.test((n as Element).tagName || '');
            const ownText = Array.from(element.childNodes).filter(n => !isSubList(n))
              .map(n => nodeToMarkedText(n, baseDir)).join('').replace(/\s+/g, ' ').trim();
            const subs = Array.from(element.children).filter(c => isSubList(c))
              .flatMap(ul => Array.from(ul.children).filter(c => c.tagName.toLowerCase() === 'li'))
              .map(li => nodeToMarkedText(li, baseDir)).join('');
            return `\n\n${'\u00a0'.repeat(Math.max(0, nbsp))}${ownText}\n\n${subs}`;
          }
          // Reveal list structure: bullets for <ul>, numbers for <ol>. Skip when the
          // item already carries its own marker (e.g. endnote backlinks "[2](...)"),
          // so notes aren't double-numbered.
          const parentTag = element.parentElement?.tagName.toLowerCase();
          const alreadyMarked = /^\[?\s*[0-9ivxlcdm]{1,8}[.)\]]/i.test(trimmed);
          if (!alreadyMarked) {
            // A NESTED list item (an <ol>/<ul> inside another list's <li> — Sovereign's a/b/c/d sub-list under
            // "5. …") indents by its rendered depth; a top-level item nets 0 and stays flush. Same NBSP→reader-
            // padding mechanism the index sub-entries use.
            // A nested rule-item sub-list (a./b./i./ii. inside a numbered item — Sovereign a-d under "5.") goes
            // through the reader's ruleHang (which already adds a 1.5em hang), so use the PDF's tighter print
            // per-tier step (~1.875em -> 5 NBSP, matching the Sovereign PDF's leadNbsp=5) rather than the browser's
            // wider 2.5em UA <ol> padding, which over-indented it ~2 NBSP deeper than the PDF. Index keeps 2.5em.
            const _liInd = ' '.repeat(Math.max(0, Math.round(renderedIndentEm(element, 1.875) / 0.375)));
            // Sub level of a LABELLED LIST: if this list sits right after an IF:/THEN: label (the EPUB
            // does NOT nest them — flat siblings — so nothing else marks the hierarchy), indent its items
            // one tier DEEPER than that mother label (8 NBSP vs the label's 4), reproducing the PDF's tiering.
            const _prevSib = element.parentElement?.previousElementSibling;
            const _underLabel = !!_prevSib && /^(?:h[1-6]|p)$/i.test(_prevSib.tagName || '') && /^(?:IF:|THEN:)/i.test((_prevSib.textContent || '').trim());
            const _liIndEff = _underLabel ? ' '.repeat(8) : _liInd;
            // A list item that CONTAINS a nested sub-list must emit its OWN text (this marker line) and the
            // sub-list as SEPARATE \n\n paragraphs — NEVER fold the sub-list into this item's text. Otherwise the
            // <ol>/<ul> wrapper's .trim() strips the first sub-item's leading NBSP+newline and glues it onto this
            // item (Sovereign "5. …reaction:" swallowed sub-item "a.", so "a" lost its indent while b/c/d kept
            // theirs). Mirrors the index-entry handler above: own text, then recurse the sub-<li> as their own
            // paragraphs (each re-enters this handler and carries its own renderedIndentEm NBSP tier).
            const _isSubList = (n: Node): boolean => n.nodeType === 1 && /^(?:ul|ol)$/i.test((n as Element).tagName || '');
            const _hasSub = Array.from(element.children).some(_isSubList);
            const _ownTrim = (_hasSub
              ? Array.from(element.childNodes).filter(n => !_isSubList(n)).map(n => nodeToMarkedText(n, baseDir)).join('')
              : childText).trim();
            const _subs = _hasSub
              ? Array.from(element.children).filter(_isSubList)
                  .flatMap(sl => Array.from(sl.children).filter(c => c.tagName.toLowerCase() === 'li'))
                  .map(li => nodeToMarkedText(li, baseDir)).join('')
              : '';
            if (parentTag === 'ol') {
              const items = Array.from(element.parentElement!.children).filter(c => c.tagName.toLowerCase() === 'li');
              // Honour the list's `list-style-type` (Sovereign's `ol.nlista_lower` → a/b/c/d, not 1/2/3/4) and
              // the item's own `value`/`start`. Resolved via the general matcher, so a class OR a tag rule works.
              const _n = (() => { const v = element.getAttribute('value'); if (v && /^\d+$/.test(v)) return parseInt(v, 10); const st = element.parentElement!.getAttribute('start'); return items.indexOf(element) + (st && /^\d+$/.test(st) ? parseInt(st, 10) : 1); })();
              // list-style-type can sit on the <li> (Kurzweil `li.x10-Sidebar-List-Numbered`), the <ol>
              // (Sovereign `ol.nlista_lower`, Agentic Mesh `ol ol`), or an inherited container <div> (Agentic
              // Mesh `div.orderedlistalpha`). CSS list-style-type INHERITS, so take the nearest EXPLICIT
              // declaration walking li → ol → ancestors — not just the parent <ol>, which missed Kurzweil's
              // per-<li> style so its roman sidebar list rendered as decimal "1./2./3." instead of "i./ii./iii.".
              let _lst = '';
              { let _el: Element | null = element; for (let _d = 0; _el && _d < 4 && !_lst; _el = _el.parentElement, _d++) _lst = (declProp(_el, 'list-style-type') || '').toLowerCase(); }
              const _roman = (n: number): string => { const t: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [val, sym] of t) while (n >= val) { s += sym; n -= val; } return s; };
              const _isRoman = _lst.includes('lower-roman') || _lst.includes('upper-roman');
              const _marker = _lst.includes('lower-alpha') || _lst.includes('lower-latin') ? String.fromCharCode(96 + ((_n - 1) % 26) + 1)
                : _lst.includes('upper-alpha') || _lst.includes('upper-latin') ? String.fromCharCode(64 + ((_n - 1) % 26) + 1)
                : _lst.includes('lower-roman') ? _roman(_n) : _lst.includes('upper-roman') ? _roman(_n).toUpperCase()
                : _lst === 'none' ? '' : `${_n}`;
              // A ROMAN marker (i./ii./iii./iv.…) VARIES in width, so the source right-tabs it into a gutter (the
              // periods align). Emit the reader's U+E020 right-marker gutter — mirroring the PDF's roman sub-list
              // (the EPUB path was missing it, so roman markers rendered left-aligned). Single-char alpha/decimal
              // are uniform width (right-align == left-align), so they keep the normal left-hang, untouched.
              const _romanGutter = _isRoman && _marker ? String.fromCharCode(0xE020) : '';
              // A TOP-LEVEL list item (no leading NBSP indent) isn't caught by the reader's isRuleItem (which
              // needs indent>0), so it falls to a prose first-line indent (marker pushed right, continuation
              // flush at the margin) instead of HANGING like the PDF. Emit U+E018 (flushFirstLine) so it becomes
              // a rule item and hangs (marker at the paragraph indent, wrapped lines one hang deeper) — matching
              // the PDF, whose top-level list items carry flushFirstLine (verified via [dbg-sublist-render]).
              const _flushFL = _liIndEff === '' ? String.fromCharCode(0xE018) : '';
              const _line = `${_flushFL}${_romanGutter}${_liIndEff}${_marker ? _marker + '. ' : ''}${_ownTrim}`;
              return _hasSub ? (_ownTrim ? `\n\n${_line}\n\n${_subs}\n\n` : `\n\n${_subs}\n\n`) : `\n${_line}\n`;
            }
            if (parentTag === 'ul') {
              const _line = `${_liIndEff}• ${_ownTrim}`;
              return _hasSub ? (_ownTrim ? `\n\n${_line}\n\n${_subs}\n\n` : `\n\n${_subs}\n\n`) : `\n${_line}\n`;
            }
          }
          // Endnotes (<li class="endnotes">, 0.833em) and other already-marked list entries land here.
          // Emit the shrink tier (ratio-gated) so small notes render smaller like the PDF; a body-size
          // item computes ratio ~1 and gets no tier. (Index li return earlier; ol/ul markers above.)
          return `\n${sizeTierSentinel(element, true)}${trimmed}\n`;
        }
        // A display:block inline element (e.g. a heading_break span carrying a title line) is a visual
        // line — put it on its own so a multi-line heading/label keeps its breaks (see the h1 handler).
        if (isBlockChild(element)) {
          // A ruled block span (e.g. `.font` = a double border-bottom under a title). Inside a heading the
          // h1/h2 handler owns the rule (so it isn't swallowed by the heading sentinel), so skip here.
          const _cr = element.closest('h1,h2,h3,h4,h5,h6') ? { top: null, bottom: null } : borderRuleOf(element);
          return `${_cr.top ? ruleBlock(_cr.top) : '\n'}${emphasize(trimmed, element)}${_cr.bottom ? ruleBlock(_cr.bottom) : '\n'}`;
        }
        return emphasize(childText, element);
      };

      const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/') + 1);
      const fileStartOffset = new Map<string, number>(); // spine file → offset where its content begins
      // A front-matter page's own <section title="…"> attribute (Cover / Title Page / Dedication / Epigraph)
      // — a clean, authoritative name for pages the TOC omits, so they don't fold together under a guessed
      // "Cover"/"Front Matter" (this book's Cover + Title Page — both a lone linked image — merged into one).
      const fileSectionTitle = new Map<string, string>();
      // Canonical { type, name } from the file's OWN epub:type / DPUB-ARIA role (authoritative when present).
      const fileSemantic = new Map<string, { type: string; name: string }>();
      let fullText = "";
      for (const filename of sortedFiles) {
        const rawContent = await zip.files[filename].async("string");
        // The EPUB is XHTML, so zero-width index markers are written SELF-CLOSING: `<a data-type="indexterm"
        // id="…"/>` (Agentic Mesh has 1056 of them). Parsed as text/html (below), a self-closing <a> is NOT
        // honoured — the open <a> triggers the HTML parser's adoption-agency algorithm, which SWALLOWS the
        // following flow content and RESTRUCTURES it: inline text lost its boundary space ("So<a/> while" →
        // "Sowhile") and, inside a <dl>, the parser pulled the <dt> terms out and DROPPED whole entries (the
        // "Agentic" glossary row vanished; only 2 of 6 dt/dd parts survived). Close every self-closing NON-VOID
        // element to `<tag …></tag>` first (keeping its id for navigation) so the tree parses clean; the empty
        // marker then contributes nothing and the surrounding text/blocks keep their structure. Originally only
        // <a/> was seen, but Kurzweil also writes SELF-CLOSING page-break spans INSIDE a bold/uppercase speaker
        // span (`<span class="…Speaker-Inline"><span epub:type="pagebreak" …/>Cassandra: </span>Okay…`): the
        // unhonoured `<span/>` opens an inner span, the single `</span>` closes THAT, leaving the speaker span
        // open to swallow the rest of the turn — so the whole paragraph rendered bold + uppercase. Generalise to
        // any non-void tag (void tags stay self-closing: they're legitimately empty).
        const content = rawContent.replace(
          /<(?!(?:area|base|br|col|embed|hr|img|input|keygen|link|meta|param|source|track|wbr)\b)([a-z][\w:-]*)\b([^>]*?)\/>/gi,
          '<$1$2></$1>');
        // Parse the RAW html — DOMParser builds a correct, properly-scoped tree (headings close, blocks
        // nest right) and nodeToMarkedText derives the \n\n structure. The old pre-strip that turned
        // closing tags into newlines REMOVED them, which left an <h1> unclosed so it swallowed the whole
        // chapter body — and the heading handler then flattened + bolded all of it.
        const doc = parser.parseFromString(content, "text/html");
        const _secTitle = (doc.querySelector('section[title]')?.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        if (_secTitle && _secTitle.length >= 3 && _secTitle.length <= 60 && !/^\d+$/.test(_secTitle) && !/\.(x?html?|opf)$/i.test(_secTitle)) fileSectionTitle.set(filename, _secTitle);
        const _sem = epubSemantic(doc);
        if (_sem) fileSemantic.set(filename, _sem);
        currentBodyEm = resolveFontEm(doc.body) || 1; // this file's base size, so the tier ratio is relative to ITS body
        const text = nodeToMarkedText(doc.body, dirOf(filename))
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n[ \t]+/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
        fileStartOffset.set(filename, fullText.length); // BEFORE appending: where this file starts
        fullText += text + "\n\n";
      }
      if (!fullText.trim()) throw new Error("No readable text found in EPUB.");

      // Internal cross-navigation anchors (Contents/TOC entries, Index page-locators, inline
      // cross-references). Any "<a href='…#frag'>" points at an element in the book — a one-way jump
      // target. For each such target fragment id, capture a short SNIPPET of the readable words right
      // AFTER that element; at read time the reader locates the snippet in the content to resolve the
      // jump to a chapter + page (pagination-independent), mirroring the PDF "[[PAGE n]]"→text-anchor
      // path but keyed by fragment id (EPUB has no page markers, and reusing "[[PAGE]]" would trip the
      // isPdfSource gate). A SNIPPET (not a raw offset) survives cleanup and reuses the reader's existing
      // {type:'text'} anchor navigation, so no new content markers / offset bookkeeping.
      const epubAnchors: Record<string, string> = {};
      {
        const targetIds = new Set<string>();
        const rawByFile: [string, string][] = [];
        for (const filename of sortedFiles) {
          let raw = '';
          try { raw = await zip.files[filename].async('string'); } catch { continue; }
          rawByFile.push([filename, raw]);
          for (const m of raw.matchAll(/<a\b[^>]*\bhref="[^"]*#([^"]+)"/gi)) targetIds.add(decodeURIComponent(m[1]).trim());
        }
        for (const [filename, raw] of rawByFile) {
          for (const im of raw.matchAll(/<[a-z][a-z0-9]*\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
            const id = decodeURIComponent(im[1]).trim();
            if (!targetIds.has(id) || epubAnchors[id]) continue;
            // Skip this element's own opening tag, strip the following tags, take the first ~12 words —
            // enough to be unique on a page, short enough to sit on one reader page.
            const after = raw.slice((im.index ?? 0)).replace(/^<[^>]*>/, '');
            const snippet = after
              .replace(/<[^>]+>/g, ' ')
              .replace(/&#\d+;|&[a-z]+;| /gi, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .split(' ')
              .slice(0, 12)
              .join(' ');
            if (snippet.length >= 8) epubAnchors[id] = snippet;
          }
          // File-level target: a Contents entry or cross-reference pointing at a WHOLE file
          // ("text00019.html" / "see Appendix 1", no #fragment) resolves to that file's OPENING text.
          // Keyed by basename under a "@file:" prefix so it can't collide with a fragment id. Take the
          // snippet from the CLEANED fullText at this file's recorded offset (not the raw HTML) — it is
          // then GUARANTEED to appear verbatim in the content the reader searches, so navigation resolves
          // (a raw-HTML snippet can diverge from the cleaned text — reordered emphasis, inserted note
          // markers, stripped decorations — and then match nothing).
          const fileKey = '@file:' + (filename.split('/').pop() || filename);
          const fileOff = fileStartOffset.get(filename);
          if (!epubAnchors[fileKey] && fileOff != null) {
            const clean = fullText.slice(fileOff, fileOff + 300)
              .replace(/[-]/g, ' ')            // block-role / heading / list sentinels (PUA)
              .replace(/\[\[[^\]]*\]\]/g, ' ')             // [[FIG …]] / [[PAGE …]] markers
              .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // link markup → its label text
              .replace(/[*_~`#]/g, ' ')                    // markdown emphasis/heading punctuation
              .replace(/\s+/g, ' ')
              .trim()
              .split(' ')
              .slice(0, 14)
              .join(' ');
            if (clean.length >= 8) epubAnchors[fileKey] = clean;
          }
        }
      }

      // Extract each referenced image's bytes + intrinsic size; drop decorative (tiny) ones and their
      // markers. Figures are cached and rendered by the SAME path as PDF figures.
      const figures: ExtractedFigure[] = [];
      // Drop a decorative/unreadable figure's marker WITHOUT shifting text — the fileStartOffset values
      // recorded during the walk are used to anchor chapters, so any length change here would drift every
      // later chapter boundary (a heading like "NOTES" slipping into the previous chapter). Blank the
      // marker to same-length spaces (they collapse to an empty, filtered paragraph in the reader).
      const blankMarker = (id: string) => { const m = `[[FIG ${id}]]`; fullText = fullText.replace(m, ' '.repeat(m.length)); };
      for (const [id, key] of figSrc) {
        try {
          const blob = await zip.files[key].async('blob');
          let wPx = 0, hPx = 0;
          try { const bmp = await createImageBitmap(blob); wPx = bmp.width; hPx = bmp.height; (bmp as any).close?.(); } catch { /* dims unknown (e.g. SVG) */ }
          if (wPx && hPx && Math.min(wPx, hPx) < 48) { blankMarker(id); continue; }
          const mimeType = blob.type || (/\.png$/i.test(key) ? 'image/png' : /\.gif$/i.test(key) ? 'image/gif' : /\.svg$/i.test(key) ? 'image/svg+xml' : 'image/jpeg');
          figures.push({ id, page: 0, wPts: 0, hPts: 0, wPx, hPx, mimeType, colFrac: figWidthFrac.get(id), blob });
        } catch { blankMarker(id); }
      }

      // Chapters from the publisher's TOC (EPUB3 nav.xhtml or EPUB2 NCX): map each entry's target file
      // to the offset where that file's content begins. Authoritative, like a PDF bookmark outline.
      const parseNavXhtml = (html: string): { title: string; href: string; level: number }[] => {
        let d = parser.parseFromString(html, 'application/xhtml+xml');
        if (d.getElementsByTagName('parsererror').length) d = parser.parseFromString(html, 'text/html');
        const navs = Array.from(d.getElementsByTagName('nav'));
        const toc = navs.find(n => (n.getAttribute('epub:type') || n.getAttribute('type') || '').toLowerCase().includes('toc')) || navs[0];
        const root = toc?.getElementsByTagName('ol')[0];
        const out: { title: string; href: string; level: number }[] = [];
        const walk = (ol: Element, level: number) => {
          for (const li of Array.from(ol.children).filter(c => c.tagName.toLowerCase() === 'li')) {
            const a = Array.from(li.children).find(c => c.tagName.toLowerCase() === 'a') as HTMLAnchorElement | undefined;
            if (a) { const href = a.getAttribute('href') || ''; const title = (a.textContent || '').replace(/\s+/g, ' ').trim(); if (href && title) out.push({ title, href, level }); }
            const sub = Array.from(li.children).find(c => c.tagName.toLowerCase() === 'ol') as Element | undefined;
            if (sub) walk(sub, level + 1);
          }
        };
        if (root) walk(root, 0);
        return out;
      };
      const parseNcx = (xml: string): { title: string; href: string; level: number }[] => {
        const d = parser.parseFromString(xml, 'text/xml');
        const out: { title: string; href: string; level: number }[] = [];
        const walk = (np: Element, level: number) => {
          const title = (np.getElementsByTagName('text')[0]?.textContent || '').replace(/\s+/g, ' ').trim();
          const href = np.getElementsByTagName('content')[0]?.getAttribute('src') || '';
          if (title && href) out.push({ title, href, level });
          for (const child of Array.from(np.children).filter(c => c.tagName.toLowerCase() === 'navpoint')) walk(child, level + 1);
        };
        const map = d.getElementsByTagName('navMap')[0];
        if (map) for (const np of Array.from(map.children).filter(c => c.tagName.toLowerCase() === 'navpoint')) walk(np, 0);
        return out;
      };

      let navEntries: { title: string; href: string; level: number }[] = [];
      let navBaseDir = opfDir;
      if (navFullPath && zip.files[navFullPath]) { navEntries = parseNavXhtml(await zip.files[navFullPath].async('string')); navBaseDir = dirOf(navFullPath); }
      else if (ncxFullPath && zip.files[ncxFullPath]) { navEntries = parseNcx(await zip.files[ncxFullPath].async('string')); navBaseDir = dirOf(ncxFullPath); }

      // A CHAPTER is a spine FILE. Many EPUBs list a chapter AND its sections as flat TOC entries that
      // all point into the SAME file via "#anchor" (this book: Chapter I + "The Rustle…"/"SUMMARY" all
      // in part0004.html). The sections are content WITHIN the chapter, not separate reading units — so
      // keep only the FIRST entry per file (the chapter opener) and drop later same-file entries. Map to
      // the file's start; buildChaptersFromOutline bounds each chapter at the next.
      const outline: PdfOutlineItem[] = [];
      const seenFile = new Set<string>();

      // FRONT MATTER: the spine files BEFORE the body start (OPF guide "text", else the first TOC entry's
      // file) are cover/copyright/contents pages the TOC omits. The files carry no usable title tag
      // (calibre writes the ISBN filename into <title>), so NAME each from its content and give it its own
      // catalogue entry — otherwise they all fold into the first chapter. Consecutive same-kind pages merge.
      const firstNavFile = navEntries.length ? resolveZip(navEntries[0].href, navBaseDir) : undefined;
      const bodyStartIdx = bodyStartFull && sortedFiles.indexOf(bodyStartFull) > 0
        ? sortedFiles.indexOf(bodyStartFull)
        : (firstNavFile ? Math.max(0, sortedFiles.indexOf(firstNavFile)) : 0);
      const fileOffsetsAsc = [...new Set(fileStartOffset.values())].sort((a, b) => a - b);
      const navTitles = navEntries.map(e => e.title).filter(t => t.length > 4);
      let lastFront = '';
      for (let i = 0; i < bodyStartIdx && i < sortedFiles.length; i++) {
        const file = sortedFiles[i];
        const fileOff = fileStartOffset.get(file);
        if (fileOff == null) continue;
        const regionEnd = fileOffsetsAsc.find(o => o > fileOff) ?? fullText.length;
        const text = fullText.slice(fileOff, regionEnd).replace(/[\u{E010}-\u{E013}]/gu, '').replace(/\s+/g, ' ').trim();
        const low = text.toLowerCase();
        // FAITHFUL naming: a front-matter file that carries its OWN heading (an <h1> the source gave it — e.g.
        // the praise page's "Praise for Agentic Mesh") names itself. Reading the file's first U+E013 heading
        // beats guessing from content, which mislabeled the praise page "Contents" (its quotes mention chapter
        // titles) — and that made the reader treat it as a Contents chapter and apply the index hanging indent.
        const ownHead = (() => {
          const region = fullText.slice(fileOff, Math.min(regionEnd, fileOff + 600));
          const hs: string[] = [];
          for (const ln of region.split('\n')) {
            const idx = ln.indexOf('');
            if (idx >= 0) { hs.push(ln.slice(idx + 1).replace(/[\u{E000}-\u{F8FF}*_`~]/gu, '').trim()); if (hs.join('').length > 3 && !/^\d+$/.test(hs.join(''))) break; }
            else if (hs.length && ln.trim()) break;
            if (hs.length >= 3) break;
          }
          return hs.join(' ').replace(/\s+/g, ' ').trim();
        })();
        const semName = fileSemantic.get(file)?.name;
        const secTitle = fileSectionTitle.get(file);
        let title: string;
        // FIRST signal: the file's own epub:type / DPUB-ARIA role (EPUB 3 / W3C standards, publisher-authored).
        // Authoritative when present, so it beats every heuristic below — a titlepage/copyright/dedication/
        // toc page names itself correctly regardless of its content or class names. Falls through when absent.
        if (semName) title = semName;
        // A lone linked cover/title image is < 30 chars of text, so the length heuristic named BOTH 'Cover'
        // and merged them — only fall back to it when the page has no authoritative <section title>.
        else if (file === coverFull || (low.length < 30 && !secTitle)) title = 'Cover';
        else if (/©|\bcopyright\b|all rights reserved|\bisbn\b/u.test(low)
          && !/^(?:table of )?contents\b/u.test(low)
          && !/^(?:table of )?contents$/iu.test(ownHead)) title = 'Copyright'; // copyright markers win over an h1 title — UNLESS this IS the Contents page: a TOC lists a "COPYRIGHT" entry, so the bare copyright test mislabelled the whole table of contents "Copyright" (its own heading is "Contents"), knocking it off the Contents render path
        else if (ownHead && ownHead.length >= 3 && ownHead.length <= 60) title = ownHead; // the file names itself (praise, dedication, …)
        else if (/^(?:table of )?contents\b/u.test(low) || navTitles.filter(t => low.includes(t.toLowerCase())).length >= 3) title = 'Contents';
        else if (secTitle) title = secTitle; // authoritative <section title="Title Page"/"Dedication"/"Epigraph">
        else title = 'Front Matter';
        if (title === lastFront) continue; // merge consecutive same-kind pages into one entry
        lastFront = title;
        outline.push({ title, page: 0, level: 0, offset: fileOff });
      }

      // VERIFY THE NAV AGAINST THE CONTENT — do not blindly trust the TOC's file pointer. Mirrors the PDF
      // outline path (which title-anchors via findHeadingOffsetByTitle instead of trusting a bookmark's
      // destination): a broken/mangled TOC (z-library Elon Musk EPUB) piles every chapter onto the wrong
      // spine file and leaves the real chapter files unreferenced, so trusting `src` folds a dozen chapters
      // into one entry (a 700-page "Acknowledgments"). Per entry, in reading order (titles resolve FORWARD
      // from the last placed chapter — order is reliable even when `src` isn't):
      //  • the file's OWN opening heading matches this title → honest opener → use the file start
      //    (byte-identical to the old behaviour for well-formed EPUBs); a 2nd same-file entry is a section → drop.
      //  • else, the title's real heading is found elsewhere → misdirected pointer → re-anchor there (Elon).
      //  • else (title unresolvable): keep at the file start only if the pointer is UNCONTESTED (one entry →
      //    this file: an OCR-corrupted but honest heading, e.g. Sovereign) or the page is headingless
      //    (front matter); a title aimed at a CONTESTED file (several chapters collapsed onto it) → drop.
      // The text of the chapter heading(s) at a spine file's start — collects the first run of consecutive
      // U+E013 heading lines (so a "2"¶"AFRICA" number-then-title pair reads as "2 AFRICA"), stopping at
      // the first prose line. '' when the file opens with no heading (a plain front-matter page).
      const firstHeadingText = (from: number, to: number): string => {
        const region = fullText.slice(from, Math.min(to, from + 600));
        const hs: string[] = [];
        for (const ln of region.split('\n')) {
          const i = ln.indexOf(SENT_HEADING);
          if (i >= 0) {
            hs.push(ln.slice(i + 1).replace(/[\u{E000}-\u{F8FF}*_`~]/gu, '').trim());
            if (hs.join('').length > 3 && !/^\d+$/.test(hs.join(''))) break; // have a real (non-numeric) title
          } else if (hs.length && ln.trim()) break;                          // first prose after the heading
          if (hs.length >= 3) break;
        }
        return hs.join(' ').replace(/\s+/g, ' ').trim();
      };
      // How many nav entries point at each spine file. A file targeted by ONE entry is "uncontested" — its
      // pointer is trustworthy even if we can't verify the heading (OCR-corrupted titles, e.g. Sovereign
      // Individual's "Megapdlitics"). A file targeted by MANY entries is "contested" — a broken/collapsed TOC
      // that piles several chapters onto one wrong file (Elon Musk), so only a heading/title match is trusted.
      const fileEntryCount = new Map<string, number>();
      for (const e of navEntries) { const t = resolveZip(e.href, navBaseDir); if (t) fileEntryCount.set(t, (fileEntryCount.get(t) ?? 0) + 1); }
      // In-content Contents/TOC page → a RELIABLE title→file map the broken NCX lacks. A spine file whose
      // body is mostly links to OTHER spine files IS the contents page; use it to place a nav entry the NCX
      // misdirects to a HEADING-LESS section — e.g. an image-plate "Picture Section" the NCX points at the
      // wrong chapter file and which has no heading text for findHeadingOffsetByTitle to anchor.
      const normNavTitle = (s: string): string =>
        s.replace(/^\s*\d+[.)\s]+/u, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toUpperCase();
      const tocPageFileFor = new Map<string, string>();
      for (const filename of sortedFiles) {
        let raw = '';
        try { raw = await zip.files[filename].async('string'); } catch { continue; }
        const dir = dirOf(filename);
        const spineLinks = [...raw.matchAll(/<a\b[^>]*\bhref="([^"#]+)(?:#[^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi)]
          .map(m => ({ file: resolveZip(m[1], dir), label: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }))
          .filter(l => l.file && fileStartOffset.has(l.file) && l.label.length > 2);
        if (spineLinks.length < 5) continue; // not a contents page
        for (const l of spineLinks) { const k = normNavTitle(l.label); if (k.length >= 3 && !tocPageFileFor.has(k)) tocPageFileFor.set(k, l.file!); }
        break; // the first contents-like page
      }
      let lastResolvedOffset = 0;
      const usedOffsets = new Set<number>(outline.map(o => o.offset).filter((o): o is number => o != null));
      for (const e of navEntries) {
        const target = resolveZip(e.href, navBaseDir);
        if (!target || !e.title) continue;
        let anchoredFile = target; // the file that ends up holding this entry's offset (may be re-pointed below)
        const fileOff = fileStartOffset.get(target);
        const regionEnd = fileOff != null ? (fileOffsetsAsc.find(o => o > fileOff) ?? fullText.length) : undefined;
        const headingAtFile = fileOff != null ? firstHeadingText(fileOff, regionEnd!) : '';

        let offset: number | undefined;
        if (fileOff != null && headingMatchesTitle(headingAtFile, e.title)) {
          // HONEST pointer — the file's own opening heading matches this entry's title (like the PDF path
          // trusting a destination whose heading matches). Trust the file start; a 2nd same-file entry is a
          // section → drop. This keeps well-formed EPUBs byte-identical and survives a title that
          // findHeadingOffsetByTitle's prose-gate can't resolve (e.g. a smart-quoted heading).
          if (seenFile.has(target)) continue;
          offset = fileOff;
        } else {
          // The pointer's file does NOT open with this title. Locate the title's real heading in the content.
          const titleOff = findHeadingOffsetByTitle(fullText, e.title, lastResolvedOffset);
          if (seenFile.has(target) && titleOff != null && fileOff != null && titleOff >= fileOff && titleOff < regionEnd!) {
            continue;                                                 // section inside an already-added chapter → keep as content
          } else if (seenFile.has(target) && (e.level ?? 0) >= 1) {
            // A DEEP nav entry (a section, level >= 1) whose FILE is already claimed by a shallower entry is
            // content within that chapter — NOT a separate reading unit. Drop it; never re-anchor it to a
            // DIFFERENT file. (Agentic Mesh's Preface > "Navigating This Book" links descriptively to the
            // Part title pages — "Part I: Defining the Essentials" -> preface01.html; re-anchoring it to the
            // real part01.html would STEAL the divider's file, drop the real "I. Defining" divider, and
            // leave a mis-nested "Part I" under the Preface — which also broke the flat-nav Part inference.)
            continue;
          } else if (titleOff != null && (e.level ?? 0) === 0) {
            offset = titleOff;                                        // misdirected TOP-LEVEL pointer → re-anchor to the real heading (Elon)
          } else if (fileOff != null && !seenFile.has(target) && (fileEntryCount.get(target) === 1 || headingAtFile === '')) {
            offset = fileOff;                                         // uncontested pointer / headingless page → trust the file start
          } else {
            // Last resort — the in-content Contents page maps this title to a DISTINCT, unclaimed,
            // HEADING-LESS file (an image-plate section the NCX misdirects). Anchor there. Else drop.
            const tocFile = tocPageFileFor.get(normNavTitle(e.title));
            const tocOff = tocFile ? fileStartOffset.get(tocFile) : undefined;
            const tocRegionEnd = tocOff != null ? (fileOffsetsAsc.find(o => o > tocOff) ?? fullText.length) : undefined;
            if (tocFile && tocOff != null && !seenFile.has(tocFile) && !usedOffsets.has(tocOff)
                && firstHeadingText(tocOff, tocRegionEnd!) === '') {
              offset = tocOff;
              anchoredFile = tocFile;
            } else {
              continue;                                               // unresolvable entry aimed at a contested chapter file → drop
            }
          }
        }
        if (usedOffsets.has(offset)) continue;
        usedOffsets.add(offset);
        seenFile.add(anchoredFile);
        outline.push({ title: e.title, page: 0, level: e.level, offset });
        lastResolvedOffset = Math.max(lastResolvedOffset, offset);
      }
      // (buildChaptersFromOutline sorts by offset and collapses non-monotonic entries, so re-anchored
      // entries that land out of nav order are put back into reading order there.)

      // INFER a Part→Chapter hierarchy when the nav is FLAT. Some EPUBs (Agentic Mesh) list the Part
      // dividers and their Chapters as SIBLINGS at the same nav level, so the nested TOC the PDF shows
      // (Part I → chapters 1–4, Part II → 5–12, …) is flattened. When the outline came out entirely flat
      // AND holds ≥2 Part dividers with numbered Chapters after them, nest each numbered Chapter under its
      // preceding Part — mirroring the PDF outline's own nesting (buildChaptersFromOutline then assigns
      // parentId from the levels, and the reader renders the collapsible tree). Front/back matter (Foreword,
      // Preface, Index, …) is neither a Part nor a numbered Chapter, so it stays top-level. A Part is a bare
      // Roman-numeral or "Part …" divider — NOT "Chapter I." (Reality Transurfing's roman-numbered chapters),
      // which keeps that book flat. Gated on ≥2 Parts so a partless book (Elon) is untouched.
      const isPartTitle = (t: string): boolean =>
        /^\s*part\b/i.test(t) || (/^\s*[IVXLCDM]+[.:]\s+\S/.test(t) && !/^\s*chapter\b/i.test(t));
      const isChapterTitle = (t: string): boolean => /^\s*(?:chapter\s+)?\d+[.:)]\s+\S/i.test(t);
      if (outline.every(o => (o.level ?? 0) === 0)) {
        const ordered = [...outline].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
        const nParts = ordered.filter(o => isPartTitle(o.title)).length;
        const nChaps = ordered.filter(o => isChapterTitle(o.title)).length;
        if (nParts >= 2 && nChaps >= nParts) {
          let inParts = false;
          for (const o of ordered) {
            if (isPartTitle(o.title)) inParts = true;                    // a Part divider — stays level 0
            else if (inParts && isChapterTitle(o.title)) o.level = 1;    // a numbered Chapter — nest under it
          }
        }
      }

      // Doc-level layout flags from the tally (parity with the PDF's line-fill measurement). Conservative,
      // like the PDF: only decide over enough samples. justified = most body paragraphs resolve to justify
      // (the reader's 'auto' align then mirrors it); firstLineIndent = most carry a first-line indent
      // (true) vs clearly block-style (false) — undefined when unclear, leaving the reader's default.
      const justified = bodyParaTally >= 8 ? justifiedParaTally / bodyParaTally > 0.6 : undefined;
      // Judge over DECLARED paragraphs (indented + flush-declared) with a 0.5 split — robust to a book whose
      // non-prose (index/notes/undeclared) volume would otherwise dilute the all-¶ ratio below 0.25. Fall back
      // to the all-¶ ratio only when too few paragraphs declare a treatment (a book that omits text-indent
      // entirely — then the reader's default applies, unchanged from before).
      const _declTotal = firstIndentParaTally + flushDeclParaTally;
      const firstLineIndent = _declTotal >= 8
        ? firstIndentParaTally / _declTotal >= 0.5
        : (bodyParaTally >= 8 ? firstIndentParaTally / bodyParaTally >= 0.25 : undefined);
      // MEASURED first-line-indent magnitude (em): the source declares its own indent (Random House
      // `p.indented`/`extract_indented` = 1em), which the reader otherwise renders at its fixed 1.75em —
      // ~2x too deep. Take the MEDIAN declared indent (clamp 0.5–2.5em) so the reader reproduces the real
      // depth for both normal body prose AND the set-off extract continuations. Needs enough samples.
      const _sortedTi = firstIndentEms.slice().sort((a, b) => a - b);
      const firstLineIndentEm = _sortedTi.length >= 8
        ? Math.min(2.5, Math.max(0.5, _sortedTi[Math.floor(_sortedTi.length / 2)]))
        : undefined;
      // Stamp each outline entry with its spine file's epub:type / DPUB-ARIA token (endnotes/index/toc/…) by
      // resolving its offset to the file it falls in. One post-pass covers BOTH the front-matter loop and the
      // nav-built entries; buildChaptersFromOutline then carries it onto each Chapter so the reader can route
      // notes/index handling on the publisher's declaration instead of matching the title.
      {
        const _ranges = [...fileStartOffset.entries()].sort((a, b) => a[1] - b[1]); // [file, startOffset] ascending
        const _typeAt = (off: number): string | undefined => {
          let f: string | undefined;
          for (const [file, start] of _ranges) { if (start <= off) f = file; else break; }
          return f ? fileSemantic.get(f)?.type : undefined;
        };
        for (const it of outline) if (it.offset != null) { const t = _typeAt(it.offset); if (t) it.semanticType = t; }
      }
      return { content: fullText, outline, title: epubTitle, figures, anchors: epubAnchors, justified, firstLineIndent, firstLineIndentEm };

    } catch (e) {
      console.error("EPUB processing error", e);
      throw new Error("Could not parse EPUB file. Structure may be corrupted.");
    }
  };

  type ExtractedFigure = { id: string; page: number; wPts: number; hPts: number; wPx: number; hPx: number; mimeType: string; colFrac?: number; blob: Blob };
  const processPdf = async (file: File): Promise<{ content: string; outline: PdfOutlineItem[]; title?: string; figures: ExtractedFigure[]; justified?: boolean; firstLineIndent?: boolean; firstLineIndentEm?: number; hangs?: { bullet?: number; list?: number; index?: number } }> => {
    try {
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      const pages: string[] = [];

      // ── PDF figures (embedded raster image XObjects) ──────────────────────────────────
      // Each figure is captured with its placed rect (flow position + column-proportion sizing) and
      // its pixels (re-encoded to JPEG, long edge capped). Icons/rules/logos are filtered by size.
      // The bytes go to the file cache after upload; the content gets a [[FIG id]] marker at the
      // figure's Y so the reader drops it into the reading flow.
      const allFigures: ExtractedFigure[] = [];
      // Figure de-dup: a piracy re-distribution (OceanofPDF) duplicates front-matter pages, so the same
      // picture is captured twice on nearby pages (BHI's title page on p3 AND p4, byte-identical). Fingerprint
      // = pixel dims + encoded byte length → drop a repeat within a few pages, keeping the first.
      const _figFp = new Map<string, number>();
      const figuresByPage = new Map<number, { id: string; yTop: number }[]>();
      // O'Reilly admonition ICONS (note/tip/warning coloured animal silhouettes) per page: captured like a
      // figure but NOT placed as a standalone [[FIG]] — the block emission tags the adjacent indented body
      // block as a callout carrying this icon id + type (reader renders the same labelled box + the icon).
      const admonIconsByPage = new Map<number, { id: string; type: 'note' | 'tip' | 'warning'; yTop: number; yBot: number; x: number; w: number }[]>();
      // A row-major DATA TABLE detected on a page (a ditto/numeric table like the Sovereign dice
      // frequencies): the whole table encoded as a single positioned-token payload (U+E025 …) so the
      // reader can reproduce its column alignment exactly. Dropped into the block stream by yTop, like
      // a figure. See the row-major detection below and the reader's table branch.
      const tablesByPage = new Map<number, { text: string; yTop: number }[]>();
      // Right-edge of every substantial body line, gathered across pages: a JUSTIFIED source fills to
      // one right margin on nearly every line (only paragraph-final lines fall short), while a
      // ragged-left source scatters. Used at the end to set fileContext.sourceJustified so the reader
      // can mirror the source alignment.
      const lineRightEdges: number[] = [];
      // A real figure occupies a meaningful AREA and isn't a thin line. The old "both sides ≥ 90pt"
      // rule wrongly dropped WIDE-BUT-SHORT diagrams (e.g. Agentic Mesh "Figure 14-1" 288×81pt — a
      // horizontal fleet diagram): 81 < 90 on the short side. Gate on area (≥ the old 90×90 bar, but
      // shape-independent) plus a short-side floor that still excludes rules/underlines (a few pt
      // tall) and tiny icons. This is a strict superset of the old gate, so no figure is lost.
      const FIG_MIN_AREA = 8100;  // ≈ 90×90pt — the "meaningful size" bar, independent of aspect ratio
      const FIG_MIN_SIDE = 20;    // a figure is > ~20pt on its short side; a rule/underline is thinner
      const FIG_MAX_EDGE = 1400;  // cap the stored image's long edge (crisp zoom, sane storage)
      const mulMat = (m: number[], n: number[]): number[] => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
      const getImageObj = (pg: any, name: string): Promise<any> => new Promise(resolve => {
        // A full-page cover can be a very large object that pdf.js is still decoding; give it room.
        // A "g_"-prefixed name is a document-level (common) object, not a page object.
        let done = false; const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 20000);
        const store = typeof name === 'string' && name.startsWith('g_') ? pg.commonObjs : pg.objs;
        try { store.get(name, (d: any) => { if (!done) { done = true; clearTimeout(t); resolve(d); } }); }
        catch { clearTimeout(t); resolve(null); }
      });
      // decoded pdf.js image (ImageBitmap OR {data,width,height,kind}) -> size-capped JPEG blob
      const encodeFigure = async (img: any): Promise<{ blob: Blob; wPx: number; hPx: number } | null> => {
        try {
          let sw: number, sh: number, source: CanvasImageSource | null = null;
          if (img?.bitmap) { source = img.bitmap; sw = img.bitmap.width || img.width; sh = img.bitmap.height || img.height; if (!sw || !sh) return null; }
          else if (img?.data && img.width && img.height) {
            sw = img.width; sh = img.height; const d: Uint8Array | Uint8ClampedArray = img.data;
            // pdf.js usually reports kind (1=GRAY, 2=RGB, 3=RGBA); when it's absent, infer from the byte
            // count so a valid image isn't dropped (a full-page cover came through with kind undefined).
            let kind = img.kind as number | undefined;
            if (!kind) kind = d.length === sw * sh * 4 ? 3 : d.length === sw * sh * 3 ? 2 : d.length === sw * sh ? 1 : 0;
            const rgba = new Uint8ClampedArray(sw * sh * 4);
            if (kind === 3) rgba.set(d);                                                                                          // RGBA_32BPP
            else if (kind === 2) { for (let i = 0, j = 0; i < d.length; i += 3, j += 4) { rgba[j] = d[i]; rgba[j + 1] = d[i + 1]; rgba[j + 2] = d[i + 2]; rgba[j + 3] = 255; } } // RGB_24BPP
            else if (kind === 1) { for (let i = 0; i < sw * sh; i++) { const v = d[i]; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; } } // GRAY_8BPP
            else return null;                                                                                                    // 1bpp packed / unknown — skip
            const src = new OffscreenCanvas(sw, sh); const sctx = src.getContext('2d'); if (!sctx) return null;
            sctx.putImageData(new ImageData(rgba, sw, sh), 0, 0); source = src as unknown as CanvasImageSource;
          } else return null;
          const scale = Math.min(1, FIG_MAX_EDGE / Math.max(sw, sh));
          const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
          const out = new OffscreenCanvas(dw, dh); const octx = out.getContext('2d'); if (!octx) return null;
          octx.drawImage(source, 0, 0, dw, dh);
          const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
          return { blob, wPx: dw, hPx: dh };
        } catch { return null; }
      };
      // Classify an O'Reilly admonition ICON (a small solid-colour animal silhouette) by its dominant hue:
      // green → tip, blue → note, red/orange → warning. Returns null for a non-admonition image (grey/black
      // logo, photo, low saturation) so only the three coloured callout icons are picked up.
      const admonitionTypeOf = async (img: any): Promise<'note' | 'tip' | 'warning' | null> => {
        try {
          // Sample the icon's pixels via a tiny canvas so BOTH decode shapes work: an ImageBitmap (img.bitmap,
          // the common browser case) and a raw {data,width,height,kind} buffer. Downscale to ~24px for speed.
          let source: CanvasImageSource | null = null, sw = 0, sh = 0;
          if (img?.bitmap) { source = img.bitmap; sw = img.bitmap.width || img.width; sh = img.bitmap.height || img.height; }
          else if (img?.data && img.width && img.height) {
            sw = img.width; sh = img.height; const d: Uint8Array | Uint8ClampedArray = img.data;
            let kind = img.kind as number | undefined;
            if (!kind) kind = d.length === sw * sh * 4 ? 3 : d.length === sw * sh * 3 ? 2 : d.length === sw * sh ? 1 : 0;
            if (kind !== 2 && kind !== 3) return null; // grey / 1bpp can't be a coloured icon
            const rgba = new Uint8ClampedArray(sw * sh * 4);
            if (kind === 3) rgba.set(d);
            else for (let i = 0, j = 0; i < d.length; i += 3, j += 4) { rgba[j] = d[i]; rgba[j + 1] = d[i + 1]; rgba[j + 2] = d[i + 2]; rgba[j + 3] = 255; }
            const c0 = new OffscreenCanvas(sw, sh); const x0 = c0.getContext('2d'); if (!x0) return null;
            x0.putImageData(new ImageData(rgba, sw, sh), 0, 0); source = c0 as unknown as CanvasImageSource;
          } else return null;
          if (!sw || !sh) return null;
          const s = Math.min(1, 24 / Math.max(sw, sh)); const dw = Math.max(1, Math.round(sw * s)), dh = Math.max(1, Math.round(sh * s));
          const cv = new OffscreenCanvas(dw, dh); const cx = cv.getContext('2d'); if (!cx) return null;
          cx.drawImage(source, 0, 0, dw, dh);
          const px = cx.getImageData(0, 0, dw, dh).data;
          let r = 0, g = 0, b = 0, cnt = 0; const n = dw * dh;
          for (let i = 0; i < n; i++) { const R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2], A = px[i * 4 + 3]; if (A < 128 || (R > 230 && G > 230 && B > 230)) continue; r += R; g += G; b += B; cnt++; }
          if (cnt < n * 0.02) return null; // essentially blank
          r /= cnt; g /= cnt; b /= cnt;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b), delta = mx - mn;
          if (mx <= 0 || delta / mx < 0.25) return null; // low saturation (grey/black) — not a coloured icon
          let hue = 0;
          if (mx === r) hue = ((g - b) / delta) % 6; else if (mx === g) hue = (b - r) / delta + 2; else hue = (r - g) / delta + 4;
          hue = (hue * 60 + 360) % 360;
          if (hue < 45 || hue > 325) return 'warning';       // red / orange (scorpion)
          if (hue >= 120 && hue < 190) return 'tip';         // green (monkey)
          if (hue >= 190 && hue < 280) return 'note';        // blue (crow)
          return null;
        } catch { return null; }
      };

      // Resolve the PDF's outline (bookmarks) up front: each entry's destination gives a
      // page and a Y position. Capturing it now lets us anchor each chapter to its exact
      // heading line (by page + Y) while the per-page glyph geometry is still in scope —
      // which also separates multiple bookmarks that share one page. Failures are
      // non-fatal; unresolved entries are dropped and the caller falls back to heuristics.
      const outlineEntries: { title: string; page: number; y: number | null; level: number }[] = [];
      // Every outline entry at EVERY level (chapters + nested section headings) with a resolved
      // Y — the author's own heading structure, used below to tag headings the font-family rule
      // misses (a nested section title set in the body font).
      const outlineHeadingTargets: { title: string; page: number; y: number }[] = [];
      try {
        const rawOutline = await pdf.getOutline();
        // A top-level entry is a CONTAINER when its children are the real reading units — either it
        // is itself a Part/Section/Book/Volume divider, or a majority of its direct children read as
        // chapters ("Chapter 1", "1. …"). This promotes a Part's chapters into the chapter list while
        // leaving a content entry's sub-sections out (a Preface's "What This Book Isn't" is not a
        // chapter). A flat book (no containers) is unchanged — only depth 0 becomes chapters.
        const isChapterTitle = (t: string): boolean => /^(chapter|chap\.?|lecture|lesson)\b/iu.test(t) || /^\d{1,3}[.:)]\s/u.test(t);
        const isDividerTitle = (t: string): boolean => /^(part|section|book|volume|unit)\b/iu.test(t);
        const looksLikeContainer = (item: any): boolean => {
          const kids = (item?.items || []) as any[];
          if (!kids.length) return false;
          const titles = kids.map(k => (k.title || '').replace(/\s+/g, ' ').trim());
          const chapterLike = titles.filter(isChapterTitle).length;
          return isDividerTitle((item.title || '').trim()) || chapterLike >= Math.max(2, Math.ceil(titles.length / 2));
        };
        // A chapter (reading unit) is any top-level entry, plus the direct children of a container
        // (one level of promotion — a chapter's own sub-sections stay heading targets, not chapters).
        const collectOutline = async (items: typeof rawOutline, depth: number, parentIsContainer: boolean): Promise<void> => {
          for (const item of items || []) {
            const isContainer = depth === 0 && looksLikeContainer(item);
            try {
              const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
              if (dest && dest[0]) {
                const page = (await pdf.getPageIndex(dest[0])) + 1;
                const y = typeof dest[3] === 'number' ? dest[3] : null;
                const title = (item.title || '').replace(/\s+/g, ' ').trim();
                if (page && title) {
                  const isChapter = depth === 0 || (depth === 1 && parentIsContainer);
                  if (isChapter) outlineEntries.push({ title, page, y, level: depth });
                  if (y != null) outlineHeadingTargets.push({ title, page, y });
                }
              }
            } catch { /* skip unresolvable entry */ }
            if (item.items && item.items.length) await collectOutline(item.items, depth + 1, isContainer);
          }
        };
        await collectOutline(rawOutline || [], 0, false);
      } catch (e) {
        console.warn('PDF outline unavailable; will fall back to heuristic chapters', e);
      }
      const outlinePages = new Set(outlineEntries.map(o => o.page));
      const pageLineGeom = new Map<number, { y: number; text: string }[]>();

      // Phase B: a footnote/cross-reference marker is a Link annotation whose destination
      // is the note. As we emit each marker (on its body page) we record the destination
      // (page + Y) so that, when the destination page is later processed, we can inject a
      // matching anchor onto the exact note line — making PDF footnotes structurally
      // identical to EPUB anchored footnotes (shared key) so the proven note-navigation
      // path handles them. Keyed by destination page; notes pages follow body pages, so
      // the targets are known by the time we reach them.
      const noteAnchorTargets = new Map<number, { y: number; key: string }[]>();
      // Only inject a note anchor when a real footnote MARKER with that key was emitted —
      // so a table-of-contents / cross-reference link (which also has a destination but no
      // numeric marker) never turns a destination heading into a spurious footnote.
      const emittedMarkerKeys = new Set<string>();
      // A trailing footnote/cross-reference link ("…AGES.”[2](#…)") and any trailing
      // emphasis sit after the sentence's terminal punctuation; strip them first so a
      // sentence that ends with a footnote marker still counts as ending — otherwise a new
      // (indented) paragraph after it is wrongly merged in.
      const endsWithTerminalPunctuation = (value: string): boolean =>
        /[.!?。！？]["'”’)\]]?$/u.test(
          value.trim().replace(/\s*\[[^\]]*\]\([^)]*\)\s*$/u, '').replace(/[*_~]+$/u, '').trim(),
        );
      const looksLikeQuotedTermLine = (value: string): boolean => {
        const trimmed = value.trim();
        if (!/^[‘']/u.test(trimmed)) return false;
        const inner = trimmed.match(/^[‘']([^’']{1,80})[’'](?:\s*[.,;:!?])?$/u)?.[1]?.trim();
        if (inner && !/\s/.test(inner) && /^[\p{Ll}\p{N}_-]+$/u.test(inner)) return true;
        const afterOpen = trimmed.slice(1).trimStart();
        return /^[\p{Ll}\p{N}_-]/u.test(afterOpen);
      };
      const startsDialogueLine = (value: string): boolean => {
        const trimmed = value.trim();
        if (!/^[“"‘'][^”"’']+/u.test(trimmed)) return false;
        if (looksLikeQuotedTermLine(trimmed)) return false;
        return true;
      };
      const startsParagraphTransitionLine = (value: string): boolean =>
        /^(?:However|Therefore|Thus|Consequently|Moreover|Furthermore|Meanwhile|In ancient times|In contrast|At the same time|As a result|For example|For instance)\b/iu.test(value.trim());
      const median = (values: number[]): number => {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] || 0;
      };
      const mode = (values: number[]): number => {
        const counts = new Map<number, number>();
        let best = 0, bestCount = -1;
        values.forEach(v => { const c = (counts.get(v) || 0) + 1; counts.set(v, c); if (c > bestCount) { bestCount = c; best = v; } });
        return best;
      };
      const modeStr = (values: string[]): string => {
        const counts = new Map<string, number>();
        let best = '', bestCount = -1;
        values.forEach(v => { if (!v) return; const c = (counts.get(v) || 0) + 1; counts.set(v, c); if (c > bestCount) { bestCount = c; best = v; } });
        return best;
      };
      // Resolve a font subset to italic/bold from its real descriptor name. PDF text
      // extraction reports opaque subset names (e.g. "g_d0_f3"), but the loaded font
      // object exposes the real name ("EBGaramond-Italic") — the only reliable emphasis
      // signal. Requires getOperatorList() to have loaded the page's fonts first.
      const fontEmphasisFor = (page: any, fontName: string, cache: Map<string, { italic: boolean; bold: boolean; semibold: boolean; family: string }>) => {
        const cached = cache.get(fontName);
        if (cached) return cached;
        let italic = false, bold = false, semibold = false, family = '';
        try {
          if (page.commonObjs?.has?.(fontName)) {
            const rawName = String(page.commonObjs.get(fontName)?.name || '');
            const realName = rawName.toLowerCase();
            // Match full weight/style words AND the abbreviated tokens many subset fonts use
            // after a separator (e.g. "TradeGothicNextLTPro-BdCn" = Bold Condensed, "-It" =
            // Italic). The separator prefix keeps "bd"/"it" from matching mid-word.
            italic = /italic|oblique|[-_ ](?:it|ita|obl)/.test(realName);
            bold = /bold|black|heavy|semibold|demi|[-_ ](?:bd|blk|hvy?|sb|smbd|xbd?|extrab)/.test(realName);
            // A MEDIUM / SEMIBOLD display weight ("GillSansNova-Medium" — Kurzweil's chart titles) is heavier
            // than the body regular but not matched as bold. Flag it so a HEADING-SIZED display block can be
            // rendered bold (scoped by size downstream, so a small same-font caption like "Source:" stays regular).
            semibold = bold || /[-_ ](?:medium|md|semib|semibold|book)\b/.test(realName);
            // Font FAMILY: subset prefix ("ABCDEF+") stripped, weight/style suffix dropped. This is
            // the typesetter's family choice — the principled signal for a heading: a heading is set
            // in a display family DISTINCT from the body family (identified from the contents page
            // below), which size cannot capture (a notes-section header equals body size; an
            // epigraph is smaller than body).
            family = rawName.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0].trim();
          }
        } catch { /* font flags unavailable — fall back to plain text */ }
        const style = { italic, bold, semibold, family };
        cache.set(fontName, style);
        return style;
      };
      const mostFrequentLeft = (values: number[]): number => {
        const buckets = new Map<number, { count: number; valueTotal: number }>();
        values.forEach(value => {
          const bucket = Math.round(value);
          const entry = buckets.get(bucket) || { count: 0, valueTotal: 0 };
          entry.count += 1;
          entry.valueTotal += value;
          buckets.set(bucket, entry);
        });
        const ranked = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count || a[0] - b[0]);
        return ranked[0] ? ranked[0][1].valueTotal / ranked[0][1].count : 0;
      };

      // Footnote markers may be Roman numerals (I, II, …), not just digits — this book uses
      // Roman, chapter-end footnotes alongside the numeric endnotes. Validate Roman with the
      // canonical strict regex (one form per value) and bound the value (a marker is small,
      // never "MIX"=1009), so a stray word made of i/v/x/l/c/d/m letters can't pass.
      const ROMAN_MARKER_RE = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
      // Unicode super/subscript digit maps for MATH scripts (10^20, H2O) that pdf.js flattens to the
      // baseline. The EPUB path maps <sup>/<sub> the same way; the PDF path has no tag, so it keys off
      // glyph geometry (a small digit run vertically offset from its base) — see the emit loop below.
      const SUPERSCRIPT_DIGITS: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
      const SUBSCRIPT_DIGITS: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
      const romanValue = (s: string): number => {
        const r: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
        let total = 0, prev = 0;
        for (let k = s.length - 1; k >= 0; k--) { const v = r[s[k].toLowerCase()] || 0; total += v < prev ? -v : v; prev = Math.max(prev, v); }
        return total;
      };
      // The marker label for a candidate run ("14" / "[14]" / "II" / "ii." / "fn3"), or '' if
      // it isn't a valid 1–3 digit number or small Roman numeral. A leading "fn" prefix is the
      // literal marker text some PDFs use for page-bottom / chapter-end footnotes (this z-library
      // book links "fn3" body markers to "fn3 …" entries via go-to annotations). We VALIDATE by
      // stripping the prefix (so "fnabc"/"fn0" are rejected) but PRESERVE it in the returned label —
      // the reader should show the marker the book actually printed ("fn3"), not a synthesized "3".
      const markerLabelOf = (raw: string): string => {
        const trimmed = raw.replace(/^[[(\s]+/u, '').replace(/[\].)\s]+$/u, '');
        // This book's chapter-end note entries drop the "f" for double digits ("n10"–"n14") while their
        // body refs keep it ("fn10") — an OCR artifact. Accept a leading "n" as an "fn" alias and NORMALISE
        // to "fn…" so the entry marker pairs with its body ref (both resolve as "fn10"). No roman marker
        // starts with "n" (ivxlcdm), and a bare number takes no prefix, so this is a safe widening.
        const fnPrefix = /^f?n\s*/iu.exec(trimmed)?.[0] ? 'fn' : '';
        const bare = trimmed.replace(/^f?n\s*/iu, '');
        if (/^\d{1,3}$/.test(bare)) return Number(bare) >= 1 ? `${fnPrefix}${bare}` : ''; // footnotes are 1-indexed
        if (bare.length >= 1 && ROMAN_MARKER_RE.test(bare)) { const v = romanValue(bare); if (v >= 1 && v <= 40) return `${fnPrefix}${bare.toUpperCase()}`; }
        return '';
      };

      // Phase C: structure is decided from the page geometry, not guessed from the text
      // downstream. Each page's classified lines are buffered, then — once the whole
      // document's body font size is known (a chapter-start page is heading-heavy and would
      // skew a per-page estimate) — grouped into blocks and emitted. INDENT_TOL is shared
      // with the per-page index-indent logic.
      const INDENT_TOL = 4;
      // `y` is the reading-order coordinate (the two-column re-flow re-stamps it so the y-sort yields
      // left-column-then-right-column); `pageY` is the line's REAL vertical position on the page, used
      // by anything that reasons about physical geometry (the header/footer margin band).
      type PdfLine = { y: number; pageY: number; col?: 0 | 1; x: number; rightX: number; text: string; h: number; capH?: number; bold: boolean; semibold?: boolean; family: string; localFont: number; outlineHeading?: boolean; mcRole?: string; dropCapStart?: boolean };
      const pageBuffers: { pageNum: number; lines: PdfLine[]; bodyLeft: number; paraLeftMargin: number; listMarginLeft: number | undefined; lineGap: number; isListPage: boolean; indentTiers: number[]; pageHeight: number; pageTwoColumn: boolean; hRules: { y: number; x: number; w: number; double?: boolean }[] }[] = [];
      const allLineHeights: number[] = [];
      const allRightEdges: number[] = []; // body line right edges, for the document text right margin

      // A genuinely TAGGED PDF carries its own structure: the getTextContent stream is wrapped in
      // marked-content role tags (H1–H6 = heading, P = body, …), which is authoritative — so we can
      // drive block roles from it instead of guessing from fonts. But detect it by COVERAGE, not the
      // /MarkInfo /Marked flag: a PDF can carry a StructTreeRoot (a viewer then shows "Tagged: Yes")
      // yet leave almost all text UNtagged — a stub tree, e.g. one book here has a StructTreeRoot but
      // only ~89 P tags across 416 pages. Sample pages and measure the fraction of text sitting
      // inside a block-level structural role; only take the tagged path when that is a clear majority
      // — otherwise the geometry path is more consistent than a sprinkling of tags.
      const STRUCT_ROLE = /^(?:H[1-6]?|P|LI|LBody|Caption|TD|TH|Title|Blockquote)$/u;
      let taggedChars = 0, totalChars = 0;
      const tagSampleN = Math.min(pdf.numPages, 12);
      for (let s = 0; s < tagSampleN; s++) {
        const samplePageNum = 1 + Math.floor((s + 0.5) * pdf.numPages / tagSampleN);
        const sampleTc = await (await pdf.getPage(samplePageNum)).getTextContent({ includeMarkedContent: true }).catch(() => null);
        if (!sampleTc) continue;
        const roleStack: string[] = [];
        for (const it of sampleTc.items as any[]) {
          if (it.type === 'beginMarkedContent' || it.type === 'beginMarkedContentProps') { roleStack.push(it.tag || ''); continue; }
          if (it.type === 'endMarkedContent') { roleStack.pop(); continue; }
          if (!('str' in it) || !it.str.trim()) continue;
          totalChars += it.str.length;
          if (roleStack.some(t => STRUCT_ROLE.test(t))) taggedChars += it.str.length;
        }
      }
      const isTaggedPdf = totalChars > 0 && taggedChars / totalChars >= 0.5;
      // The PDF's own metadata Title — cleaner than inferring one from the first content line
      // (which on a title-heavy page is a fragment). Used only if it looks like a real title.
      const meta = await pdf.getMetadata().catch(() => null);
      const metaTitleRaw = ((meta?.info as { Title?: string })?.Title || '').replace(/\s+/g, ' ').trim();
      const metaTitle = metaTitleRaw.length >= 3 && !/\.(pdf|docx?|indd)$/i.test(metaTitleRaw) ? metaTitleRaw : undefined;

      let seenTextPage = false; // first page bearing real text — a full-bleed image before it is the COVER
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const _vp1 = page.getViewport({ scale: 1 });
        const pageHeight = _vp1.height;
        const _pageW = _vp1.width;
        const pageWidth = page.getViewport({ scale: 1 }).width;
        // getOperatorList loads the page's fonts (so their real italic/bold names are
        // resolvable); getTextContent gives the glyph runs. Run both together.
        // Always pull marked content + struct tree: a book can be tagged ONLY in its front matter
        // (this one is — body 0% tagged, so document-wide isTaggedPdf is false), yet a tagged page
        // still carries authoritative reading order we must use for its columns. Per-page tagging
        // drives the struct column path below; the document-wide flag still gates headings/artifacts.
        const [opList, textContent, annotations, structTree] = await Promise.all([
          page.getOperatorList().catch(() => null),
          page.getTextContent({ includeMarkedContent: true }),
          page.getAnnotations().catch(() => [] as any[]),
          page.getStructTree().catch(() => null),
        ]);
        // PRINCIPLED reading order from the tagged PDF's own structure: walk the struct tree (which is
        // in logical reading order, unlike the content stream) and map every marked-content id to the
        // index of the block (P/H/LI/…) that owns it. A glyph's mc id then gives its paragraph AND its
        // reading position — no geometric column/gutter guessing needed on tagged pages.
        const mcOrder = new Map<string, number>();
        if (structTree) {
          const BLOCK_ROLE = /^(?:H[1-6]?|P|LI|LBody|Lbl|Caption|TD|TH|Title|Blockquote|Figure|Formula)$/u;
          let paraIdx = 0;
          const walkStruct = (node: any): void => {
            if (!node) return;
            if (node.role && BLOCK_ROLE.test(node.role)) {
              const gather = (n: any): void => { if (n.type === 'content' && n.id) mcOrder.set(n.id, paraIdx); (n.children || []).forEach(gather); };
              gather(node); paraIdx++; return; // a block owns all its content; don't split nested inline nodes
            }
            (node.children || []).forEach(walkStruct);
          };
          walkStruct(structTree);
        }
        // Figures on this page: walk the op stream tracking the CTM; each paintImageXObject placed at
        // a meaningful size is a figure. Record its top-Y (to drop the marker into the reading flow)
        // and encode its pixels. Runs only when the page draws images (cheap otherwise).
        if (opList && typeof OffscreenCanvas !== 'undefined') {
          try {
            const OPS = pdfjsLib.OPS;
            // Page text-column width (points) — a figure is sized in the reader as its fraction of
            // this, so it reads proportionally to the surrounding text rather than off a fixed guess.
            const txt = ((textContent as any).items || []).filter((it: any) => 'str' in it && it.str.trim());
            let colW = txt.length >= 10 ? Math.max(...txt.map((it: any) => it.transform[4] + (it.width || 0))) - Math.min(...txt.map((it: any) => it.transform[4])) : 0;
            // Figure-heavy page (little/no body text): no reliable text column — fall back to a
            // typical measure (~72% of the page width) so the figure still gets a sane proportion.
            if (colW < 150) colW = page.getViewport({ scale: 1 }).width * 0.72;
            const _pageLeft = txt.length >= 6 ? Math.min(...txt.map((it: any) => it.transform[4])) : 72;
            let ctm = [1, 0, 0, 1, 0, 0]; const gstack: number[][] = []; let n = 0;
            for (let i = 0; i < opList.fnArray.length; i++) {
              const fn = opList.fnArray[i]; const a = opList.argsArray[i];
              if (fn === OPS.save) gstack.push(ctm.slice());
              else if (fn === OPS.restore) { const s = gstack.pop(); if (s) ctm = s; }
              else if (fn === OPS.transform) ctm = mulMat(ctm, a);
              else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
                const wPts = Math.abs(ctm[0]), hPts = Math.abs(ctm[3]);
                // O'Reilly admonition ICON — a SMALL coloured animal silhouette at the LEFT margin, below the
                // figure-size bar (so it'd otherwise be dropped as "tiny icon"). Classify by dominant hue;
                // capture it + record its type/position so the adjacent indented body becomes a callout.
                if (wPts >= 18 && wPts <= 72 && hPts >= 18 && hPts <= 84 && ctm[4] <= _pageLeft + 30 && ctm[4] >= _pageLeft - 40) {
                  const _im = await getImageObj(page, a[0]);
                  const _adm = _im ? await admonitionTypeOf(_im) : null;
                  if (_adm) {
                    const _enc = await encodeFigure(_im);
                    if (_enc) {
                      const _id = `adm_p${pageNum}n${++n}`;
                      allFigures.push({ id: _id, page: pageNum, wPts, hPts, wPx: _enc.wPx, hPx: _enc.hPx, mimeType: 'image/jpeg', blob: _enc.blob });
                      const _lst = admonIconsByPage.get(pageNum) || []; _lst.push({ id: _id, type: _adm, yTop: Math.max(ctm[5], ctm[5] + ctm[3]), yBot: Math.min(ctm[5], ctm[5] + ctm[3]), x: ctm[4], w: wPts }); admonIconsByPage.set(pageNum, _lst);
                    }
                    continue; // handled — never a standalone figure
                  }
                }
                if (wPts * hPts < FIG_MIN_AREA || Math.min(wPts, hPts) < FIG_MIN_SIDE) continue; // rule / underline / tiny icon
                const yTop = Math.max(ctm[5], ctm[5] + ctm[3]);
                const img = await getImageObj(page, a[0]);
                const enc = img ? await encodeFigure(img) : null;
                if (!enc) continue;
                // Skip a byte-identical image that recurs within 3 pages (a duplicated page from the pirate
                // re-render); keep the first. Far-apart recurrences (a chapter ornament) are left alone.
                const _fp = `${enc.wPx}x${enc.hPx}x${(enc.blob as any).size}`;
                const _fpPrev = _figFp.get(_fp);
                _figFp.set(_fp, pageNum);
                if (_fpPrev != null && pageNum - _fpPrev <= 3) continue;
                const id = `p${pageNum}n${++n}`;
                allFigures.push({ id, page: pageNum, wPts, hPts, wPx: enc.wPx, hPx: enc.hPx, mimeType: 'image/jpeg', colFrac: colW > 0 ? Math.min(1, wPts / colW) : undefined, blob: enc.blob });
                const list = figuresByPage.get(pageNum) || []; list.push({ id, yTop }); figuresByPage.set(pageNum, list);
              }
            }
          } catch { /* figure extraction is best-effort — never block text extraction */ }
        }
        const fontCache = new Map<string, { italic: boolean; bold: boolean; semibold: boolean; family: string }>();

        // Link annotations on this page: external URLs (rendered as hyperlinks) and
        // internal go-to destinations (footnote/cross-reference markers). For each go-to
        // marker, resolve its destination to a page + Y and stash a note-anchor target so
        // the destination page can be anchored with the same key (see noteAnchorTargets).
        const uriLinks: { rect: number[]; url: string }[] = [];
        const gotoLinks: { rect: number[]; key: string }[] = [];
        for (const a of (annotations as any[]) || []) {
          if (a?.subtype !== 'Link' || !a.rect) continue;
          if (a.url) {
            // calibre rewrites some in-chapter footnote refs to a fake-domain anchor
            // ("https://calibre-pdf-anchor.a/#aN") whose named dest doesn't exist in the PDF (0 named dests),
            // so it can't resolve and was rendered as a DEAD external URL (full underlined link, no
            // superscript, navigates to nowhere). Route it as a KEYLESS footnote ref (#pdfnote-) so the reader
            // renders the marker ("fn10") as a superscript and resolves it to the matching in-chapter entry by
            // pattern — not the broken URL.
            const _calM = /^https?:\/\/calibre-pdf-anchor\.[^/]*\/#(\S+)/iu.exec(a.url);
            if (_calM) { gotoLinks.push({ rect: a.rect, key: `pdfnote-cal-${_calM[1]}` }); continue; }
            // Piracy watermark injected by the distribution site (OceanofPDF / Z-Library / libgen / Anna's
            // Archive): a link annotation the SOURCE book never had, sprinkled at page tops + before every
            // note, rendered as a stray hyperlink. Drop the annotation so it isn't a link (the glyphs are
            // dropped separately by the watermark line filter). NOT real content.
            if (WATERMARK_RE.test(a.url)) continue;
            uriLinks.push({ rect: a.rect, url: a.url }); continue;
          }
          if (!a.dest) continue;
          try {
            const dest = typeof a.dest === 'string' ? await pdf.getDestination(a.dest) : a.dest;
            if (!dest || !dest[0]) continue;
            const destPage = (await pdf.getPageIndex(dest[0])) + 1;
            const destY = typeof dest[3] === 'number' ? dest[3] : null;
            if (destY == null) continue;
            const key = `pdffn-p${destPage}-y${Math.round(destY)}`;
            gotoLinks.push({ rect: a.rect, key });
            const targets = noteAnchorTargets.get(destPage) || [];
            targets.push({ y: destY, key });
            noteAnchorTargets.set(destPage, targets);
          } catch { /* unresolvable destination — skip */ }
        }
        // A link annotation often covers only PART of a text item: pdf.js returns a whole
        // line as one item, while the link rect wraps just a URL inside the sentence.
        // Resolve the link per character (estimating each character's x by proportional
        // width) and split the item at link boundaries, so only the covered characters — the
        // URL — become the link, not the whole line. EPUB has no annotations, so this is
        // PDF-only.
        type LinkAnn = { rect: number[]; url?: string; key?: string; text?: string };
        const links: LinkAnn[] = [
          ...uriLinks.map(u => ({ rect: u.rect, url: u.url })),
          ...gotoLinks.map(g => ({ rect: g.rect, key: g.key })),
        ];
        const linkAt = (px: number, py: number): LinkAnn | null => {
          for (const l of links) { const [x1, y1, x2, y2] = l.rect; if (px >= x1 - 1 && px <= x2 + 1 && py >= y1 - 2 && py <= y2 + 2) return l; }
          return null;
        };
        // pdf.js returns a whole line as one text item, so mapping a link rect to characters by
        // uniform width is a few characters fuzzy on short links ("OpenAI" grabbing "as "). The
        // operator list has each glyph's TRUE x, so extract each link's exact text (the glyphs whose
        // origin sits inside the rect) for precise matching below. Cheap: only when the page has links.
        if (links.length && opList) {
          try {
            const OPS = pdfjsLib.OPS;
            const mul = (m: number[], q: number[]): number[] => [m[0] * q[0] + m[2] * q[1], m[1] * q[0] + m[3] * q[1], m[0] * q[2] + m[2] * q[3], m[1] * q[2] + m[3] * q[3], m[0] * q[4] + m[2] * q[5] + m[4], m[1] * q[4] + m[3] * q[5] + m[5]];
            const asMat = (a: any): number[] => (a.length === 6 ? a : a[0]);
            const accG: { x: number; y: number; ch: string; fill: string }[] = [];
            let ctm = [1, 0, 0, 1, 0, 0], tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], fsz = 0, wsp = 0, fill = '#000000';
            const gstack: { ctm: number[]; fill: string }[] = [];
            for (let i = 0; i < opList.fnArray.length; i++) {
              const fn = opList.fnArray[i]; const a = opList.argsArray[i];
              if (fn === OPS.save) gstack.push({ ctm: ctm.slice(), fill });
              else if (fn === OPS.restore) { const s = gstack.pop(); if (s) { ctm = s.ctm; fill = s.fill; } }
              else if (fn === OPS.transform) ctm = mul(ctm, a);
              else if (fn === OPS.setFillRGBColor) fill = String(a[0]);
              else if (fn === OPS.beginText) { tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); }
              else if (fn === OPS.setFont) fsz = a[1];
              else if (fn === OPS.setTextMatrix) { const m = asMat(a); tm = [m[0], m[1], m[2], m[3], m[4], m[5]]; tlm = tm.slice(); }
              else if (fn === OPS.moveText) { tlm = mul(tlm, [1, 0, 0, 1, a[0], a[1]]); tm = tlm.slice(); }
              else if (fn === OPS.setWordSpacing) wsp = a[0];
              else if (fn === OPS.showText) {
                for (const el of a[0]) {
                  if (typeof el === 'number') { tm = mul(tm, [1, 0, 0, 1, -el / 1000 * fsz, 0]); continue; }
                  const d = mul(ctm, tm);
                  if (el.unicode && el.unicode !== '') accG.push({ x: d[4], y: d[5], ch: el.unicode, fill });
                  let adv = (el.width || 0) / 1000 * fsz; if (el.isSpace) adv += wsp;
                  tm = mul(tm, [1, 0, 0, 1, adv, 0]);
                }
              }
            }
            const isBlack = (c: string): boolean => c === '#000000' || c === '#000' || c === 'rgb(0,0,0)';
            for (const L of links) {
              const [x1, y1, x2, y2] = L.rect;
              // Glyphs on this link's line — baseline within the rect (tight band keeps the line above/
              // below out, which x-only matching wrongly grabbed) and inside the rect's x-span.
              const near = accG.filter(g => g.y >= y1 - 3 && g.y <= y2 + 3 && g.x >= x1 - 2 && g.x <= x2 + 1);
              // PREFER the link-coloured glyphs: a hyperlink is set in a distinct colour (dark red
              // here), so this drops a black neighbouring word the rect marginally overlaps
              // ("as OpenAI," → "OpenAI"). If nothing is coloured (a black link), use the tight-x span.
              const coloured = near.filter(g => !isBlack(g.fill));
              const chosen = coloured.length ? coloured : near.filter(g => g.x >= x1 - 1 && g.x < x2 - 1);
              const t = chosen.map(g => g.ch).join('').replace(/^\s+|\s+$/gu, '');
              if (t) L.text = t;
            }
            // Wrapped-destination-link resolver. A "this page"-style dest link whose anchor WRAPS across a
            // line break has no quadPoints, no colour distinction and (untagged PDF) no struct tree — so its
            // annotation rect is the UNION box spanning the full width of BOTH lines, and the grab above
            // swallowed the unrelated body text on those lines ("user Valcenteu via CC BY 3.0 …"). The SAME
            // anchor phrase appears as SINGLE-LINE dest links elsewhere on the page; use those as a per-page
            // dictionary and split the wrapped link into two TIGHT per-line fragments — the phrase straddling
            // the break (e.g. "this" at the top line's right edge ⇥ / ⇤ "page" at the next line's left edge).
            // Fragment TEXT comes from the real glyphs (exact), the dictionary only VALIDATES the split.
            const lineYs: number[] = [];
            for (const y of [...new Set(accG.map(g => Math.round(g.y)))].sort((a, b) => b - a)) {
              if (!lineYs.some(v => Math.abs(v - y) <= 3)) lineYs.push(y);
            }
            const glyphsAtLine = (ly: number) => accG.filter(g => Math.abs(g.y - ly) <= 3).sort((a, b) => a.x - b.x);
            const destDict = [...new Set(links
              .filter(L => L.key && !L.url && L.text && (L.rect[3] - L.rect[1]) < 20)
              .map(L => (L.text as string).trim()))].filter(t => /\s/u.test(t));
            if (destDict.length) {
              const extraFrags: LinkAnn[] = [];
              for (const L of links) {
                if (!L.key || L.url || (L.rect[3] - L.rect[1]) < 20) continue; // only MULTI-LINE dest links
                const covered = lineYs.filter(ly => ly >= L.rect[1] - 3 && ly <= L.rect[3] + 3).sort((a, b) => b - a);
                if (covered.length !== 2) continue; // handle the common two-line wrap only
                const topG = glyphsAtLine(covered[0]), botG = glyphsAtLine(covered[1]);
                if (!topG.length || !botG.length) continue;
                const topText = topG.map(g => g.ch).join(''), botText = botG.map(g => g.ch).join('');
                const topTrim = topText.replace(/\s+$/u, ''), botTrim = botText.replace(/^\s+/u, '');
                let done = false;
                for (const A of destDict) {
                  const toks = A.split(/\s+/u).filter(Boolean);
                  for (let i = 1; i < toks.length && !done; i++) {
                    const top = toks.slice(0, i).join(' '), bot = toks.slice(i).join(' ');
                    if (!topTrim.endsWith(top) || !botTrim.startsWith(bot)) continue;
                    const topFragG = topG.slice(topTrim.length - top.length, topTrim.length);
                    const lead = botText.length - botTrim.length;
                    const botFragG = botG.slice(lead, lead + bot.length);
                    if (!topFragG.length || !botFragG.length) continue;
                    const advs: number[] = [];
                    for (let k = 1; k < topG.length; k++) { const d = topG[k].x - topG[k - 1].x; if (d > 0 && d < 40) advs.push(d); }
                    const cw = advs.length ? advs.sort((a, b) => a - b)[advs.length >> 1] : 6;
                    const yTop = topFragG[0].y, yBot = botFragG[0].y;
                    L.rect = [topFragG[0].x - 1, yTop - 3, topFragG[topFragG.length - 1].x + cw, yTop + 11];
                    L.text = topFragG.map(g => g.ch).join('');
                    extraFrags.push({ rect: [botFragG[0].x - 1, yBot - 3, botFragG[botFragG.length - 1].x + cw, yBot + 11], key: L.key, text: botFragG.map(g => g.ch).join('') });
                    done = true;
                  }
                }
              }
              for (const f of extraFrags) links.push(f);
            }
          } catch { /* op-list parse failed — fall back to the uniform estimate below */ }
        }
        // An INDEX alphabet-nav bar: a row of standalone single uppercase letters (A B C … Z), each a
        // go-to link to that letter's section. Detected by ≥5 single-letter go-to links on the page so a
        // stray uppercase-roman body footnote marker never trips it. Used below to route each nav letter
        // as a plain clickable cross-reference instead of the footnote-marker path — a roman letter (I/V/X,
        // value ≤40) would otherwise be mis-read by markerLabelOf as a marker and render inert.
        const isAlphaNavPage = links.filter(l => (l as LinkAnn).key && /^[A-Z]$/u.test(((l as LinkAnn).text || '').trim())).length >= 5;
        // Vector-drawn list bullets: some PDFs (this book's list on p39) draw the bullet as a small
        // FILLED path (a round/square dot) rather than a text glyph, so getTextContent never sees it and
        // the list renders with no markers — while the same book's EPUB, carrying real <li> markup, DOES
        // show them. Scan the op stream (tracking the CTM) for small filled dots. A genuine list is a
        // COLUMN of ≥2 dots sharing an x, so that gate keeps this from firing on a stray filled
        // rule/underline/icon. Matched to their text lines and injected as "•" glyphs below, they flow
        // through the same isBulletParagraph path as text-glyph / EPUB <ul> bullets.
        const vectorBullets: { cx: number; cy: number; size: number }[] = [];
        // Decorative horizontal RULES (epigraph/section dividers) drawn as thin filled rects.
        const hRules: { y: number; x: number; w: number; double?: boolean }[] = [];
        if (opList) {
          try {
            const OPS = pdfjsLib.OPS;
            const FILL_OP = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke]);
            const apply = (m: number[], px: number, py: number): number[] => [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]];
            let ctm = [1, 0, 0, 1, 0, 0]; const gstack: number[][] = [];
            const dots: { cx: number; cy: number; size: number }[] = [];
            const ruleCands: { y: number; x: number; w: number }[] = [];
            for (let i = 0; i < opList.fnArray.length; i++) {
              const fn = opList.fnArray[i]; const a = opList.argsArray[i];
              if (fn === OPS.save) gstack.push(ctm.slice());
              else if (fn === OPS.restore) { const s = gstack.pop(); if (s) ctm = s; }
              else if (fn === OPS.transform) ctm = mulMat(ctm, a);
              else if (fn === OPS.constructPath) {
                const op = a[0], mm = a[2]; // args = [paintOp, drawOps, [xMin,yMin,xMax,yMax]] in user space
                if (!FILL_OP.has(op) || !mm) continue; // only FILLED paths; a bullet is a filled dot, not a stroke/clip
                const [x0, y0] = apply(ctm, mm[0], mm[1]); const [x1, y1] = apply(ctm, mm[2], mm[3]);
                const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
                // A decorative horizontal RULE (epigraph/section divider): thin and spans most of the text
                // column. Narrow table/chart cell rules (< 0.55 page width) are excluded here; grid-like
                // clusters are dropped below, so only genuine content dividers survive.
                if (h <= 2 && w >= pageWidth * 0.55) { ruleCands.push({ y: (y0 + y1) / 2, x: Math.min(x0, x1), w }); continue; }
                // A bullet dot is SMALL and roughly SQUARE (a filled circle/square). This excludes the
                // page-clip rect, wide rules/underlines (w ≫ h), and figures (large either side).
                if (w < 1.5 || h < 1.5 || w > 12 || h > 12 || Math.abs(w - h) > Math.max(w, h) * 0.5) continue;
                dots.push({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: Math.max(w, h) });
              }
            }
            // Keep only dots that form a COLUMN — ≥2 dots sharing an x (±2pt). A real list hangs its
            // markers at one indent; a single isolated filled dot is more likely a decorative mark.
            for (const d of dots) if (dots.filter(o => Math.abs(o.cx - d.cx) <= 2).length >= 2) vectorBullets.push(d);
            // A LINK UNDERLINE is a thin filled rect drawn right under a hyperlink (a citation URL) — NOT a
            // decorative divider. It sits at the link annotation's baseline and spans its width, so it slips
            // through the width gate above (a wide URL underline is >0.55×page). Drop any rule that coincides
            // with a link annotation, else a notes page of URL citations injects stray U+E021 divider marks
            // into the text (Singularity p489's "Me Too? ////").
            // Match the link's WIDTH too: an underline spans the link TEXT (≈ the annotation width), so a
            // full-column decorative rule (e.g. an epigraph bracket that merely passes 3pt above a footnote
            // link's narrow marker) is NOT an underline and must be kept. Without this, a wide rule crossing a
            // narrow link's x-range slipped the >50%-overlap gate and was wrongly dropped (Sovereign p56's
            // "We shall not be…" epigraph lost its TOP rule).
            const coincidesWithLink = (r: { y: number; x: number; w: number }): boolean =>
              links.some(l => { const [lx1, ly1, lx2, ly2] = l.rect; return r.y >= ly1 - 4 && r.y <= ly2 + 3 && r.w <= (lx2 - lx1) + 12 && Math.min(r.x + r.w, lx2) - Math.max(r.x, lx1) > (lx2 - lx1) * 0.5; });
            // Group rule candidates into UNITS first: a decorative rule is a SINGLE line OR a DOUBLE rule
            // (two thin lines ~2-4pt apart, bracketing a chapter DECK/subtitle — Sovereign ch1, ch3-8). Two
            // lines within 4pt collapse to one double unit, so the double-rule pairs framing a deck (4 lines
            // total) count as 2 units, not 4, and aren't mistaken for a table grid.
            const _sortedRules = [...ruleCands].sort((a, b) => a.y - b.y);
            const ruleUnits: { y: number; x: number; w: number; double: boolean }[] = [];
            for (const r of _sortedRules) {
              const last = ruleUnits[ruleUnits.length - 1];
              if (last && !last.double && Math.abs(r.y - last.y) <= 4) last.double = true; // 2nd line of a pair
              else ruleUnits.push({ y: r.y, x: r.x, w: r.w, double: false });
            }
            // Keep only ISOLATED units — a table/chart grid stacks ≥3 UNITS within a small y-span; a content
            // divider (single or double) stands alone (or a pair bracketing an epigraph, ≥50pt apart).
            for (const u of ruleUnits) if (ruleUnits.filter(o => Math.abs(o.y - u.y) <= 50).length < 3 && !coincidesWithLink(u)) hRules.push(u);
          } catch { /* best-effort — a parse failure just means no vector bullets are detected on this page */ }
        }
        type PdfGlyph = { x: number; y: number; h: number; w: number; str: string; italic: boolean; bold: boolean; semibold?: boolean; family: string; linkUrl?: string; noteKey?: string; dropCap?: boolean; mcRole?: string; paraOrder?: number };
        const glyphs: PdfGlyph[] = [];
        // Marked-content role stack (only populated for tagged PDFs). The structural role of a
        // glyph is the innermost stack entry that is a block role, not an inline one — Span and
        // Artifact wrap runs inside a paragraph and don't change what the block IS.
        const mcStack: string[] = [];
        const idStack: (string | undefined)[] = []; // parallel marked-content id stack (for reading order)
        const currentMcRole = (): string | undefined => { for (let k = mcStack.length - 1; k >= 0; k--) { const t = mcStack[k]; if (t && t !== 'Span' && t !== 'Artifact' && t !== 'NonStruct') return t; } return undefined; };
        const currentParaOrder = (): number | undefined => { for (let k = idStack.length - 1; k >= 0; k--) { const id = idStack[k]; if (id && mcOrder.has(id)) return mcOrder.get(id); } return undefined; };
        for (const item of textContent.items as any[]) {
          if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') { mcStack.push(item.tag || ''); idStack.push(item.id); continue; }
          if (item.type === 'endMarkedContent') { mcStack.pop(); idStack.pop(); continue; }
          if (!('str' in item) || !item.str.trim()) continue;
          // Tagged PDF: text inside an Artifact is pagination/running-head/footer/background, not
          // content — drop it. (Untagged PDFs have an empty stack; their footers are removed by the
          // geometry pass below.)
          if (isTaggedPdf && mcStack.includes('Artifact')) continue;
          const mcRole = isTaggedPdf ? currentMcRole() : undefined;
          const paraOrder = currentParaOrder(); // always — per-page struct columns don't need the doc-wide flag
          const tr = item.transform || [];
          const emphasis = fontEmphasisFor(page, item.fontName, fontCache);
          const x = tr[4] || 0, y = tr[5] || 0, w = item.width || 0;
          const h = Math.hypot(tr[0] || 0, tr[1] || 0) || item.height || 0;
          // A glyph whose font maps it to a Private-Use codepoint has a broken/missing ToUnicode
          // map (e.g. a decorative subset font's "h" -> U+E4C7); pdf.js can't recover the real
          // character. Make the loss VISIBLE with a placeholder instead of silently dropping it,
          // so a fetch omission is never invisible. (Excludes U+E010–E014, our own block-role
          // sentinels — those are added downstream, never present in raw pdf.js text.)
          const str: string = item.str.replace(/[\uE000-\uE00F\uE015-\uF8FF]/g, '□');
          const n = str.length;
          // Fast path: the item touches no link rect — emit it whole.
          const overlaps = n > 0 && links.some(l => { const [x1, y1, x2, y2] = l.rect; return x < x2 + 1 && x + w > x1 - 1 && y >= y1 - 2 && y <= y2 + 2; });
          if (!overlaps) {
            glyphs.push({ x, y, h, w, str, italic: emphasis.italic, bold: emphasis.bold, semibold: emphasis.semibold, family: emphasis.family, mcRole, paraOrder });
            continue;
          }
          // Resolve each character's link. PREFER the operator list's exact link text: find each
          // overlapping link's text inside this item and mark exactly those characters — precise even
          // for short links. Fall back to the uniform-width estimate + word-snap only if a link has no
          // extracted text or it isn't found here.
          const hitLinks = links.filter(L => { const [x1, y1, x2, y2] = L.rect; return x < x2 + 1 && x + w > x1 - 1 && y >= y1 - 2 && y <= y2 + 2; });
          let linked: (LinkAnn | null)[] | null = null;
          if (hitLinks.length && hitLinks.every(L => L.text)) {
            const cl: (LinkAnn | null)[] = new Array(n).fill(null);
            let allFound = true;
            for (const L of hitLinks) {
              const estCentre = ((L.rect[0] + L.rect[2]) / 2 - x) / (w / n); // rect centre → est. char index (to disambiguate repeats)
              let bestIdx = -1, bestD = Infinity;
              for (let from = 0; ;) { const idx = str.indexOf(L.text!, from); if (idx < 0) break; const c = idx + L.text!.length / 2; if (Math.abs(c - estCentre) < bestD) { bestD = Math.abs(c - estCentre); bestIdx = idx; } from = idx + 1; }
              if (bestIdx < 0) { allFound = false; break; }
              for (let k = bestIdx; k < bestIdx + L.text!.length; k++) cl[k] = L;
            }
            if (allFound) linked = cl;
          }
          if (!linked) {
            const charLink: (LinkAnn | null)[] = [];
            for (let i = 0; i < n; i++) charLink.push(linkAt(x + (w * (i + 0.5)) / n, y));
            // word-boundary snap: the uniform estimate is a few chars fuzzy and a link covers whole
            // words, so pull a boundary on leading punctuation (", Andy…") or inside a word to a space.
            const snapEdge = (b: number, start: boolean): number => {
              let best = b, bestD = 5;
              for (let p = Math.max(0, b - 4); p <= Math.min(n, b + 4); p++) {
                const isEdge = start
                  ? (p === 0 || /\s/u.test(str[p - 1])) && p < n && !/\s/u.test(str[p])
                  : (p === n || /\s/u.test(str[p])) && p > 0 && !/\s/u.test(str[p - 1]);
                if (isEdge && Math.abs(p - b) < bestD) { bestD = Math.abs(p - b); best = p; }
              }
              return best;
            };
            const snapped: (LinkAnn | null)[] = charLink.slice();
            for (let i = 0; i < n;) {
              if (!charLink[i]) { i++; continue; }
              let j = i; while (j < n && charLink[j] === charLink[i]) j++;
              const a = snapEdge(i, true), b = snapEdge(j, false);
              for (let k = i; k < j; k++) snapped[k] = null;
              for (let k = a; k < b; k++) snapped[k] = charLink[i];
              i = j;
            }
            linked = snapped;
          }
          let runStart = 0;
          let runLink = linked[0] || null;
          for (let i = 1; i <= n; i++) {
            const cl = i < n ? (linked[i] || null) : null;
            if (i === n || cl !== runLink) {
              glyphs.push({
                x: x + (w * runStart) / n,
                y, h,
                w: (w * (i - runStart)) / n,
                str: str.slice(runStart, i),
                italic: emphasis.italic,
                bold: emphasis.bold,
                semibold: emphasis.semibold,
                family: emphasis.family,
                linkUrl: runLink?.url,
                noteKey: runLink?.key,
                mcRole,
                paraOrder,
              });
              runStart = i;
              runLink = cl;
            }
          }
        }
        // Inject a "•" glyph for each vector-drawn bullet detected above, at the baseline of the text
        // line it marks (the nearest glyph baseline just below the dot centre, with body text to its
        // right — a hanging marker). Downstream line-clustering + isBulletParagraph then render it
        // exactly like a text-glyph or EPUB <ul> bullet.
        for (const b of vectorBullets) {
          // The line this bullet marks: the nearest glyph baseline just below the dot centre whose x
          // is to the RIGHT of the dot. (The dot centre sits a few points above the baseline.)
          let bestY: number | null = null, bestDy = Infinity;
          for (const g of glyphs) {
            if (g.x <= b.cx + 1) continue;               // marker hangs to the left of the text
            const dy = b.cy - g.y;                        // dot centre is above the baseline
            if (dy < -2 || dy > b.size * 3) continue;     // same line only, not the line above/below
            if (dy < bestDy) { bestDy = dy; bestY = g.y; }
          }
          if (bestY === null) continue;                  // no body text to the right — inject nothing
          // Leftmost glyph on that line — copy its style + reading order so the "•" joins its block.
          const ref = glyphs.filter(g => Math.abs(g.y - bestY!) < 3 && g.x > b.cx + 1).sort((a, c) => a.x - c.x)[0];
          glyphs.push({ x: b.cx, y: bestY, h: ref ? ref.h : b.size, w: b.size, str: '•', italic: false, bold: false, family: ref ? ref.family : '', mcRole: ref?.mcRole, paraOrder: ref?.paraOrder });
        }
        // De-duplicate list bullets: some PDF generators emit a list item's bullet BOTH as a
        // standalone glyph AND at the start of the item's text run (a lone "•" and "• An AI agent…"
        // at the same x/y), which doubles the bullet in the reflow ("•• …"). Drop the lone bullet
        // when a run at the same spot already carries it; a genuine standalone bullet is kept.
        const BULLET_RE = /^[•‣▪●◦⁃∙○■]$/u;
        const nearGlyph = (a: PdfGlyph, b: PdfGlyph): boolean => Math.abs(a.x - b.x) < 6 && Math.abs(a.y - b.y) < 4;
        const loneBullets = glyphs.filter(g => BULLET_RE.test(g.str.trim()));
        const dropBullet = new Set<PdfGlyph>();
        for (const g of loneBullets) {
          if (dropBullet.has(g)) continue;
          // A run at the same spot already carries the bullet ("• An AI agent…") → drop this lone one.
          if (glyphs.some(h => h !== g && nearGlyph(h, g) && h.str.trim().length > 1 && BULLET_RE.test(h.str.trim().charAt(0)))) { dropBullet.add(g); continue; }
          // Otherwise keep g and drop any OTHER lone bullets at the same spot (a doubled "• •").
          for (const h of loneBullets) if (h !== g && !dropBullet.has(h) && nearGlyph(h, g)) dropBullet.add(h);
        }
        if (dropBullet.size) { const kept = glyphs.filter(g => !dropBullet.has(g)); glyphs.length = 0; glyphs.push(...kept); }
        // De-duplicate list NUMBERS the same way: some tagged-PDF exports draw a numbered item's marker
        // TWICE at the identical x/y — once inside the item's text run ("1. Validate identity…") and once
        // as a standalone label ("1.") — so the reflow appends the stray number to the item ("…verified1.",
        // Agentic Mesh p65). Drop a lone "N."/"N)" (number/roman/letter) marker when a longer run at the
        // SAME spot already OPENS with that exact marker. A normal list (marker glyph then a SEPARATE text
        // glyph) is untouched: the text run starts with the word, not the marker, so startsWith fails.
        const MARKER_DUP_RE = /^(?:\d{1,3}|[ivxlcdm]{1,4}|[a-z])[.)]$/iu;
        const loneMarkers = glyphs.filter(g => MARKER_DUP_RE.test(g.str.trim()));
        const dropMarker = new Set<PdfGlyph>();
        for (const g of loneMarkers) {
          const m = g.str.trim();
          if (glyphs.some(h => h !== g && nearGlyph(h, g) && h.str.trim().length > m.length && h.str.trim().startsWith(m))) dropMarker.add(g);
        }
        if (dropMarker.size) { const kept = glyphs.filter(g => !dropMarker.has(g)); glyphs.length = 0; glyphs.push(...kept); }
        // pdf.js can return the citation and the URL on a line as ONE text item ("Equipment
        // Corporation, 1963), 10, http://s3data…"), and the loose box links the whole item — so
        // the scheme ends up MID-glyph. Split such a glyph at the scheme so the URL
        // reconstruction below can anchor on the scheme glyph and drop the citation before it.
        const schemeSplit: PdfGlyph[] = [];
        for (const g of glyphs) {
          let at = g.linkUrl ? g.str.search(/https?:\/\/|www\./u) : -1;
          // A mailto:/tel: box often also catches the preceding label ("E-mail: TSG@…"); the DISPLAY
          // is only the address/number, so split at it (case-insensitive) — urlKeep then anchors on
          // the address and drops the label prefix ("l: " → back to plain "E-mail: ").
          if (at < 0 && g.linkUrl && /^(?:mailto|tel):/iu.test(g.linkUrl)) {
            const id = g.linkUrl.replace(/^(?:mailto|tel):/iu, '').split(/[?#]/u)[0];
            const k = id ? g.str.toLowerCase().indexOf(id.toLowerCase()) : -1;
            if (k > 0) at = k;
          }
          if (at > 0) {
            const n = g.str.length;
            schemeSplit.push({ ...g, str: g.str.slice(0, at), w: (g.w * at) / n });
            schemeSplit.push({ ...g, str: g.str.slice(at), x: g.x + (g.w * at) / n, w: (g.w * (n - at)) / n });
          } else {
            schemeSplit.push(g);
          }
        }
        glyphs.length = 0;
        glyphs.push(...schemeSplit);
        // pdf.js gives ONE loose bounding box per link, spanning every line it wraps across, so
        // the box also covers the citation before a URL ("CNBC, June 29, 2023, https://…") and
        // the next one after it. When the link is shown as the URL itself (a fragment carries a
        // scheme/www), keep it ONLY on the contiguous run of glyphs that actually spell the URL:
        // walk from the scheme glyph and match each fragment against the URL, so a short tail
        // ("…will-win") is kept while the surrounding citations are dropped. Custom-text links
        // ("click here") and internal go-to links (noteKey) are left untouched.
        const urlGlyphs = new Map<string, PdfGlyph[]>();
        for (const g of glyphs) {
          if (!g.linkUrl) continue;
          const arr = urlGlyphs.get(g.linkUrl);
          if (arr) arr.push(g); else urlGlyphs.set(g.linkUrl, [g]);
        }
        const urlKeep = new Map<PdfGlyph, number>(); // leading chars of a glyph that spell its URL
        for (const [url, gs] of urlGlyphs) {
          // Match against the DECODED URL so glyphs the page shows literally (an em-dash the
          // annotation percent-encodes as %E2%80%94) are recognised instead of truncating the link.
          const nurl = showHref(url).toLowerCase();
          // Find where the displayed URL begins among these glyphs, and where that maps into the
          // URL. Prefer a scheme/www glyph (the URL's start); otherwise the first glyph that
          // spells a long (≥12-char) contiguous slice — so a URL that CONTINUED onto this page
          // from the previous one (the scheme is on the prior page, not re-stated here) is still
          // recognised, while a short citation word that merely coincides with the URL ("Sense"
          // in "common-sense") is not chosen as the anchor.
          let anchorIdx = -1;
          for (let i = 0; i < gs.length; i++) {
            const lo = gs[i].str.toLowerCase().replace(/^[^a-z0-9]+/u, '').replace(/[.,;:!?)\]"'»]+$/u, '');
            if (/^https?:\/\//u.test(lo) || /^www\./u.test(lo)) { anchorIdx = i; break; }
            if (anchorIdx < 0 && lo.length >= 12) {
              // A URL that CONTINUED from the previous page arrives without a scheme; anchor on the
              // first ≥12-char glyph the URL contains (a prefix, if a trailing citation is glued on).
              let at = nurl.indexOf(lo);
              if (at < 0) { for (let len = lo.length - 1; len >= 12; len--) { if (nurl.indexOf(lo.slice(0, len)) >= 0) { at = 0; break; } } }
              if (at >= 0) { anchorIdx = i; }
            }
          }
          if (anchorIdx < 0) continue; // custom-text link (display doesn't spell the URL) — leave untouched
          for (let i = 0; i < anchorIdx; i++) urlKeep.set(gs[i], 0); // citation before the URL on this page
          // Keep the URL by WHITESPACE, not by char-matching the annotation URL. The annotation URL
          // is frequently malformed (a doubled "http://http//…" scheme) or percent-encoded
          // differently from what the page prints ("%2C" vs a literal comma) — char-matching then
          // truncated the highlighted link at the first divergence ("http://", or up to "%2C"). A URL
          // contains no spaces, so the displayed link is the contiguous non-space run from the scheme;
          // it ends at the first whitespace (the citation/sentence that the loose link box also covers).
          // The URL is set in ONE consistent font from its scheme; the citation that follows it (a report
          // TITLE, an author) is set in a DIFFERENT font/italic. When the URL tail is glued to that citation
          // with NO space ("…campaignid=DemocracyIndex2011;Democracy Index 2012…") the whitespace test never
          // fires, so the run ran deep into the italic title ("*Democracy*](url)" — a malformed link). End the
          // run at the emphasis change (italic or font family) so the link stops at the URL. Only applies when
          // the source actually carries emphasis (opaque font subsets that lose it are simply unaffected).
          // Use ITALIC only (not font family): a long URL can legitimately span two opaque font subsets,
          // so a family change is NOT a safe boundary, but a regular-font URL giving way to an ITALIC title is.
          const anchorGlyph = gs[anchorIdx];
          const emphasisBreak = (g: PdfGlyph): boolean => !!anchorGlyph && g.italic !== anchorGlyph.italic;
          // The SPACE between a URL and the citation glued after it is often NOT a tagged glyph — pdf.js
          // gives one wide link box and the space falls outside the URL run — so the whitespace test above
          // never fires and the link ran through "…a16-bionic; Nick Guy and Roderick Scott, “Which i".
          // A URL contains no spaces, so a same-line x-GAP to the next tagged glyph marks its end. (Only
          // same-line: the wrap seam between the URL's two lines is contiguous and must NOT break.)
          const gapBreak = (a: PdfGlyph, b: PdfGlyph): boolean =>
            Math.abs(a.y - b.y) < Math.max(a.h, 1) * 0.5 && (b.x - (a.x + a.w)) > Math.max(a.h, 1) * 0.2;
          let ended = false;
          for (let i = anchorIdx; i < gs.length; i++) {
            if (ended) { urlKeep.set(gs[i], 0); continue; }
            const s = gs[i].str;
            const wsAt = s.search(/\s/u);
            let keep = wsAt < 0 ? s.length : wsAt;
            const nextBreaks = gs[i + 1] ? (emphasisBreak(gs[i + 1]) || gapBreak(gs[i], gs[i + 1])) : false;
            // Trim trailing sentence punctuation from the glyph that ENDS the URL run — a period,
            // comma, or semicolon glued after the address ("…rocket-man.", "…html.") is the
            // surrounding sentence, not the URL. Only these three, which effectively never end a URL;
            // query/fragment/path chars (? & = # / - _ ~ and parens) are left intact.
            if (wsAt >= 0 || i === gs.length - 1 || nextBreaks) { while (keep > 0 && /[.,;]/u.test(s[keep - 1])) keep--; }
            urlKeep.set(gs[i], keep);
            if (wsAt >= 0 || nextBreaks) ended = true;
          }
        }
        // Split a glyph whose text runs past the URL — a short URL tail glued to the next
        // citation ("win; Vincent…") — into a linked head and an unlinked tail; drop glyphs
        // the box covered that spell none of the URL (the preceding/next citation).
        if (urlKeep.size) {
          const rebuilt: PdfGlyph[] = [];
          for (const g of glyphs) {
            const keep = urlKeep.get(g);
            if (keep === undefined || keep >= g.str.length) { rebuilt.push(g); continue; }
            if (keep <= 0) { rebuilt.push({ ...g, linkUrl: undefined }); continue; }
            const n = g.str.length;
            rebuilt.push({ ...g, str: g.str.slice(0, keep), w: (g.w * keep) / n });
            rebuilt.push({ ...g, str: g.str.slice(keep), x: g.x + (g.w * keep) / n, w: (g.w * (n - keep)) / n, linkUrl: undefined });
          }
          glyphs.length = 0;
          glyphs.push(...rebuilt);
        }
        if (glyphs.length === 0) {
          // An image-only page (cover, title-page art, a full-page plate) has NO text glyphs, but it may
          // carry a captured figure. Skipping it outright orphaned that figure — it never reached pageEmit,
          // so the cover/title art was dropped from the reading flow. Emit a minimal, text-less page buffer
          // so the figure-injection in the emit loop drops its [[FIG]] marker into the content in page order
          // (the reader then renders it inline). Default margins (no text to measure); the prose branch just
          // splices the figure. Pages with neither text nor a figure (a truly blank leaf) are still skipped.
          const _pageFigs = figuresByPage.get(pageNum) || [];
          // The COVER is the leading FULL-BLEED image (fills the page) appearing BEFORE any text page: it's
          // already the library thumbnail, and for text-cover books it duplicates the title page — so keep it
          // out of the reading flow. A title page (has margins) and full-page plates AFTER text begins stay.
          const _isCover = !seenTextPage && _pageFigs.some(f => {
            const af = allFigures.find(x => x.id === f.id);
            return !!af && af.wPts >= _pageW * 0.9 && af.hPts >= pageHeight * 0.9;
          });
          if (_pageFigs.length && !_isCover) {
            pageBuffers.push({ pageNum, lines: [], bodyLeft: 0, paraLeftMargin: 0, listMarginLeft: undefined, lineGap: 0, isListPage: false, indentTiers: [], pageHeight, pageTwoColumn: false, hRules: [] });
          }
          continue;
        }
        seenTextPage = true;

        // Cluster glyphs into visual lines by baseline with a tolerance, so a raised
        // superscript footnote marker (smaller font, a few points above the baseline)
        // joins its own line instead of becoming a detached digit on its own line.
        const bodyHeight = mode(glyphs.map(g => Math.round(g.h))) || median(glyphs.map(g => g.h));
        const lineTolerance = Math.max(2, bodyHeight * 0.5);
        // A drop cap is a single oversized initial spanning several body lines; its baseline
        // sits well below the line it begins, so baseline clustering would attach it to the
        // wrong line ("In my…" → "n my…" + "Itheory…"). Hold these aside and, after the body
        // lines are clustered, prepend each to the TOP line of its vertical span — the
        // opening line, whose cap height the initial aligns with (the typographic definition
        // of a dropped initial). Threshold 2.2× body: a real drop cap is ~3× body, while a
        // chapter-title cap line is ~1.8× — so a single title letter (the "I" in "WHO AM I?")
        // is never mistaken for one. Allow a trailing apostrophe: the cap extracts as "I'".
        const isDropCap = (g: PdfGlyph): boolean => {
          const s = g.str.trim();
          return bodyHeight > 0 && g.h >= bodyHeight * 2.2 && [...s].length <= 2 && /^\p{L}/u.test(s);
        };
        const dropCaps = glyphs.filter(isDropCap);
        dropCaps.forEach(cap => { cap.dropCap = true; });
        type LineGroup = { baseY: number; baseH: number; items: PdfGlyph[]; col?: 0 | 1 };
        const bodyGlyphs = glyphs.filter(g => !isDropCap(g)); // kept in pdf.js content-stream order
        // Cluster a set of glyphs into baseline "lines": sort top→bottom, then join each glyph to the
        // nearest existing line within tolerance (anchoring the line on its tallest glyph so a raised
        // superscript doesn't pull the baseline up).
        const clusterLines = (gs: PdfGlyph[], tol: number = lineTolerance): LineGroup[] => {
          const out: LineGroup[] = [];
          for (const g of [...gs].sort((a, b) => b.y - a.y || a.x - b.x)) {
            let best: LineGroup | null = null;
            let bestDist = Infinity;
            for (const group of out) {
              const dist = Math.abs(group.baseY - g.y);
              if (dist <= tol && dist < bestDist) { bestDist = dist; best = group; }
            }
            if (!best) { best = { baseY: g.y, baseH: g.h, items: [] }; out.push(best); }
            best.items.push(g);
            if (g.h > best.baseH * 1.05) { best.baseY = g.y; best.baseH = g.h; }
          }
          return out;
        };

        const groups: LineGroup[] = [];
        // ── PRINCIPLED: reading order & columns from the tagged struct tree ────────────────
        // Each glyph carries its struct paragraph index (reading order). When the struct tree reveals a
        // genuine two-column region (a paragraph sitting wholly right of a gutter, overlapping a
        // left paragraph in y), emit paragraphs in struct order with the columns tagged from geometry —
        // no gutter/midpoint heuristics. Only takes over when real columns exist; every other page
        // (single-column, tagged or not) keeps the geometry path unchanged.
        let structPlan: { lines: LineGroup[]; col?: 0 | 1 }[] | null = null;
        // True only for a GENUINE two-column region (real central gutter) via the struct-tag or
        // geometry-BAND path — NOT the row-major path, which false-fires on a single-column TOC by
        // mistaking the title→page-number gap ("Explainable and Traceable  81") for a column gutter.
        // Drives the reader's two-column index/TOC grid (a U+E017 marker on the list page's text).
        let pageTwoColumn = false;
        // ── DIAGNOSTIC (two-column) ── remove after the index issue is resolved.
        const __dbg: any = { pageNum, path: 'geo-single', gut0: -1, band: null, rowMajorRun: 0 };
        const structKeys = [...new Set(bodyGlyphs.map(g => g.paraOrder).filter((v): v is number => v !== undefined))].sort((a, b) => a - b);
        __dbg.structKeys = structKeys.length;
        if (structKeys.length >= 2) {
          const byPara = new Map<number, PdfGlyph[]>();
          for (const g of bodyGlyphs) { if (g.paraOrder === undefined) continue; const a = byPara.get(g.paraOrder) || []; a.push(g); byPara.set(g.paraOrder, a); }
          const paras = structKeys.filter(k => byPara.has(k)).map(k => { const gs = byPara.get(k)!; return { lines: clusterLines(gs), minX: Math.min(...gs.map(g => g.x)), maxX: Math.max(...gs.map(g => g.x + (g.w || 0))), yTop: Math.max(...gs.map(g => g.y)), yBot: Math.min(...gs.map(g => g.y)) }; });
          const leftCounts = new Map<number, number>();
          for (const p of paras) { const k = Math.round(p.minX / 5) * 5; leftCounts.set(k, (leftCounts.get(k) || 0) + 1); }
          const bodyLeftX = [...leftCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
          const contentW = Math.max(...paras.map(p => p.maxX)) - Math.min(...paras.map(p => p.minX));
          const rStarts = paras.filter(p => p.minX > bodyLeftX + contentW * 0.22).map(p => p.minX).sort((a, b) => a - b);
          const gutter = rStarts.length >= 1 ? rStarts[0] - 4 : Infinity;
          const sideOf = (p: typeof paras[0]): 'left' | 'right' | 'full' => gutter === Infinity ? 'full' : p.minX >= gutter ? 'right' : p.maxX <= gutter ? 'left' : 'full';
          const sides = paras.map(sideOf);
          const yOv = (a: typeof paras[0], b: typeof paras[0]): boolean => Math.max(a.yBot, b.yBot) <= Math.min(a.yTop, b.yTop);
          const cols = paras.map((p, i) => { const s = sides[i]; if (s === 'full') return undefined; const opp = s === 'left' ? 'right' : 'left'; return paras.some((q, j) => j !== i && sides[j] === opp && yOv(p, q)) ? (s === 'left' ? 0 : 1) as 0 | 1 : undefined; });
          if (cols.some(c => c !== undefined)) structPlan = paras.map((p, i) => ({ lines: p.lines, col: cols[i] }));
        }
        if (structPlan) {
          pageTwoColumn = true;
          __dbg.path = 'struct-plan';
          __dbg.structCols = structPlan.filter(p => p.col !== undefined).length;
          // Emit struct paragraphs in reading order; re-stamp baseY so the downstream y-sort preserves
          // it (left column, then right column, then the full-width blocks around them).
          let cursor = pageHeight;
          const LN = Math.max(6, bodyHeight * 1.15), PGAP = Math.max(40, bodyHeight * 3.5);
          for (const p of structPlan) {
            for (const ln of p.lines.sort((a, b) => b.baseY - a.baseY)) { ln.baseY = cursor; ln.col = p.col; cursor -= LN; groups.push(ln); }
            cursor -= PGAP;
          }
        } else {
        // ── Two-column layout via LINE GEOMETRY (band detection) ──────────────────────────
        // pdf.js content-stream order is NOT reliable reading order — a back cover can draw its blocks
        // out of visual order (ISBN first, praise last), so trusting stream order scrambled the page.
        // Detect columns from GEOMETRY instead: find the contiguous vertical BAND where a genuine left
        // and right column coexist — a run of non-full lines carrying ≥3 left-only AND ≥3 right-only
        // OFFSET lines. (Requiring offset lines keeps a full-width paragraph out, and keeps an aligned
        // same-baseline row-major colophon out — that stays on its own path below.) Reflow ONLY that
        // band (left column top-to-bottom, then right); every line above/below it keeps its natural
        // full-width reading position. No qualifying band ⇒ single flow, exactly as before.
        const contentMinX = Math.min(...bodyGlyphs.map(g => g.x));
        const contentMaxX = Math.max(...bodyGlyphs.map(g => g.x + (g.w || 0)));
        const pageMid = (contentMinX + contentMaxX) / 2;
        const span = contentMaxX - contentMinX;
        const gMaxX = (g: LineGroup): number => Math.max(...g.items.map(it => it.x + (it.w || 0)));
        const gMinX = (g: LineGroup): number => Math.min(...g.items.map(it => it.x));
        const bandGutterMin = Math.max(28, bodyHeight * 2.5);
        // Cluster with a TIGHTER baseline tolerance than the document-wide `lineTolerance` for column
        // detection. The band test needs OFFSET evidence — ≥2 pure-left AND ≥2 pure-right lines — to
        // tell a column-major two-column INDEX (independent left/right rhythms, so their baselines
        // drift apart by a few pt) from a row-major aligned TABLE (every row's two cells share one
        // baseline exactly). The normal tolerance (~half the line height) merged an index's small
        // (~4pt) baseline offsets into "aligned" split lines, hiding the evidence so the band was
        // never found and both columns glued into one line. A true aligned table has 0pt offset, so it
        // stays merged (no pure-left/right lines) at the tighter tolerance too → still routes to the
        // row-major path. Validated across the test PDFs: only the index pages change; the aligned
        // tables (Sovereign p297 dice frequencies, etc.) are untouched.
        const colTolerance = Math.max(1, bodyHeight * 0.25);
        const sortedGroups = clusterLines(bodyGlyphs, colTolerance).sort((a, b) => b.baseY - a.baseY); // top → bottom
        // The RIGHT column's left edge (if any): the leftmost x of lines starting well right of centre,
        // taken as a robust low percentile so an outlier doesn't move it. Classifying against THIS, not
        // the page midpoint, keeps a long left-column bullet (which can extend past mid) as LEFT rather
        // than full-width — the misclassification that stopped the band from ever being detected.
        const rightStarts = sortedGroups.map(gMinX).filter(x => x > pageMid + span * 0.05).sort((a, b) => a - b);
        // Prefer the GUTTER — the widest empty vertical strip in the central band of the page — as the
        // column boundary. On a narrow, multi-indent two-column INDEX the right column starts just right
        // of centre and the per-entry start-x scatters (two indent levels, wrapped continuations), so the
        // right-start percentile lands too far right and misfiles right-column headers as left. The empty
        // strip is unambiguous: no glyph covers it. Use its RIGHT edge (the right column's left edge) as
        // gut0; require a real strip (≥ ~0.6× line height) so a page with no clean central gutter (a title
        // page, offset art) falls back to the right-start percentile, unchanged.
        const gutterFromStrip = (): number | null => {
          const width = Math.ceil(contentMaxX - contentMinX) + 1;
          const cover = new Float32Array(width);
          for (const g of bodyGlyphs) {
            const a = Math.floor(g.x - contentMinX), b = Math.ceil(g.x + (g.w || 0) - contentMinX);
            for (let i = Math.max(0, a); i < Math.min(width, b); i++) cover[i]++;
          }
          const lo = Math.floor((contentMaxX - contentMinX) * 0.25), hi = Math.ceil((contentMaxX - contentMinX) * 0.75);
          let bestRun = 0, bestStart = -1, run = 0, runStart = -1;
          for (let i = lo; i <= hi; i++) {
            if (cover[i] === 0) { if (run === 0) runStart = i; run++; if (run > bestRun) { bestRun = run; bestStart = runStart; } }
            else run = 0;
          }
          return bestRun >= Math.max(6, bodyHeight * 0.6) ? bestStart + bestRun + contentMinX : null;
        };
        const gutStrip = gutterFromStrip();
        const gut0 = gutStrip !== null ? gutStrip
          : rightStarts.length >= 3 ? rightStarts[Math.floor(rightStarts.length * 0.15)] - 4 : pageMid;
        const colClass = (g: LineGroup): 'left' | 'right' | 'split' | 'full' => {
          const mn = gMinX(g), mx = gMaxX(g);
          if (mn >= gut0) return 'right';
          if (mx <= gut0) return 'left';
          const its = [...g.items].sort((a, b) => a.x - b.x); // spans the gutter: real gap = split, else full
          for (let i = 1; i < its.length; i++) { const lo = its[i - 1].x + (its[i - 1].w || 0), hi = its[i].x; if (lo < gut0 && hi > gut0 && hi - lo > bandGutterMin) return 'split'; }
          return 'full';
        };
        const cls = sortedGroups.map(colClass);
        const maxGap = Math.max(30, bodyHeight * 3);
        let bStart = -1, bEnd = -1;
        for (let i = 0; i < sortedGroups.length;) {
          if (cls[i] === 'full') { i++; continue; }
          // Contiguous non-full lines, no large vertical gap. A genuine COLUMN band needs OFFSET
          // evidence — ≥2 left-only AND ≥2 right-only lines (whose lines don't all pair up on one
          // baseline) — which excludes a row-major colophon (every row an aligned split). Splits count
          // toward each side's total so a mostly-aligned band still clears the ≥3 content bar.
          let j = i, lo = 0, ro = 0, sp = 0;
          while (j < sortedGroups.length && cls[j] !== 'full' && (j === i || sortedGroups[j - 1].baseY - sortedGroups[j].baseY < maxGap)) { if (cls[j] === 'left') lo++; else if (cls[j] === 'right') ro++; else sp++; j++; }
          if (lo >= 2 && ro >= 2 && lo + sp >= 3 && ro + sp >= 3 && (bStart < 0 || (j - i) > (bEnd - bStart))) { bStart = i; bEnd = j; }
          i = j;
        }
        __dbg.path = 'geo-band';
        __dbg.gut0 = Math.round(gut0);
        __dbg.gutStrip = gutStrip !== null ? Math.round(gutStrip) : null;
        __dbg.nLines = sortedGroups.length;
        __dbg.clsCounts = cls.reduce((a: any, c: string) => { a[c] = (a[c] || 0) + 1; return a; }, {});
        __dbg.band = bStart >= 0 ? [bStart, bEnd] : null;
        if (bStart >= 0) {
          pageTwoColumn = true;
          // Cut the whole band at the same gutter used to classify — the right column's left edge — so
          // every row (offset or aligned, short or long) splits identically into a left and right cell.
          const gutter = gut0;
          // A genuine band line never has text CONTINUOUS across the gutter — the left column stops
          // before it and the right column starts after it (or the line sits wholly on one side). A
          // full-width prose line DOES cross it. So extend the band over adjacent lines that don't
          // cross the gutter, bounded by a normal line gap so it can't leak into a separate block
          // below (DATA/ISBN) or the full-width paragraph above.
          const crossesGutter = (g: LineGroup): boolean => g.items.some(it => it.x < gutter - 2 && it.x + (it.w || 0) > gutter + 2);
          while (bStart > 0 && !crossesGutter(sortedGroups[bStart - 1]) && sortedGroups[bStart - 1].baseY - sortedGroups[bStart].baseY < maxGap) bStart--;
          while (bEnd < sortedGroups.length && !crossesGutter(sortedGroups[bEnd]) && sortedGroups[bEnd - 1].baseY - sortedGroups[bEnd].baseY < maxGap) bEnd++;
          // Above the band: full-width, natural order (real baseY, already the highest on the page).
          for (let i = 0; i < bStart; i++) { sortedGroups[i].col = undefined; groups.push(sortedGroups[i]); }
          // The band: cut EVERY row at the single gutter → a left cell and a right cell.
          const leftCells: LineGroup[] = [], rightCells: LineGroup[] = [];
          for (let i = bStart; i < bEnd; i++) {
            const g = sortedGroups[i];
            const l = g.items.filter(it => it.x + (it.w || 0) / 2 < gutter), r = g.items.filter(it => it.x + (it.w || 0) / 2 >= gutter);
            if (l.length) leftCells.push({ baseY: g.baseY, baseH: g.baseH, items: l });
            if (r.length) rightCells.push({ baseY: g.baseY, baseH: g.baseH, items: r });
          }
          // Re-stamp baseY so the downstream y-sort reads above → left column → right column → below.
          // Shift (don't flatten) so each column keeps its own internal spacing and paragraph breaks.
          const bandTop = sortedGroups[bStart].baseY, bandBottom = sortedGroups[bEnd - 1].baseY;
          const bandShift = Math.max(bandTop - bandBottom, bodyHeight) + Math.max(40, bodyHeight * 3);
          for (const g of leftCells) g.col = 0;                       // left keeps its real baseY
          for (const g of rightCells) { g.baseY -= bandShift; g.col = 1; }
          groups.push(...leftCells, ...rightCells);
          // Below the band: full-width again, dropped below the shifted right column, natural order.
          for (let i = bEnd; i < sortedGroups.length; i++) { const g = sortedGroups[i]; g.baseY -= bandShift * 2; g.col = undefined; groups.push(g); }
        } else {
          const flowGroups = clusterLines(bodyGlyphs);
          // ROW-MAJOR two-column table (a colophon: "Role: Name" credits in two side-by-side columns —
          // each ROW holds a left cell AND a right cell at the SAME baseline, so the content-order
          // detector above sees no column jump and the cells would merge into one line). Find the
          // longest contiguous run of rows split by an ALIGNED vertical gutter, cut each such row at it
          // into a left cell (col 0) and a right cell (col 1); the block assembler's column-change
          // break keeps them apart and the emitter pairs each row into a side-by-side two-column unit.
          const cx = (it: PdfGlyph): number => it.x + (it.w || 0) / 2;
          const minCX = bodyGlyphs.length ? Math.min(...bodyGlyphs.map(g => g.x)) : 0;
          const maxCX = bodyGlyphs.length ? Math.max(...bodyGlyphs.map(g => g.x + (g.w || 0))) : 0;
          const gutterMin = Math.max(28, bodyHeight * 2.5);
          const rowInfo = flowGroups.map(g => {
            const its = [...g.items].sort((a, b) => a.x - b.x);
            let gap = 0, at = 0;
            for (let i = 1; i < its.length; i++) { const d = its[i].x - (its[i - 1].x + (its[i - 1].w || 0)); if (d > gap) { gap = d; at = (its[i].x + its[i - 1].x + (its[i - 1].w || 0)) / 2; } }
            const hasGutter = gap > gutterMin && at > minCX + (maxCX - minCX) * 0.2 && at < maxCX - (maxCX - minCX) * 0.2;
            return { its, at, hasGutter };
          });
          let runStart = -1, runLen = 0;
          for (let i = 0; i < rowInfo.length;) {
            if (!rowInfo[i].hasGutter) { i++; continue; }
            let j = i; while (j < rowInfo.length && rowInfo[j].hasGutter) j++;
            const centres = rowInfo.slice(i, j).map(r => r.at);
            if (Math.max(...centres) - Math.min(...centres) <= bodyHeight * 3 && j - i > runLen) { runLen = j - i; runStart = i; }
            i = j;
          }
          __dbg.rowMajorRun = runLen;
          // A TOC / index is NOT a row-major table: "Short Term … 26" has an aligned gutter too (before
          // the right-aligned page number), and cutting it splits the page number onto its own line and
          // shatters the entry. Such a page has many lines ENDING IN A PAGE NUMBER; a real colophon
          // table ("Editor: Jane Smith") does not. Skip the row-major cut for a list-like page. (A
          // genuinely two-column index is handled by the geometry BAND above, not here.)
          const isListLikePage = flowGroups.filter(g => /\d[.)]?\s*$/u.test([...g.items].sort((a, b) => a.x - b.x).map(it => it.str).join('').trim())).length >= 6;
          // Distinguish a real MULTI-COLUMN data table (a ditto/numeric frequency table — Sovereign's
          // dice table) from a plain 2-column colophon. Count the INTERNAL vertical gutters that stay
          // empty across MOST rows of the aligned run: a colophon has ONE (label | value); a data table
          // has ≥2 (≥3 columns). A run with ≥2 such gutters is emitted as a positioned-token TABLE so the
          // reader reproduces every column's alignment exactly, instead of the single-gutter 2-col cut
          // (which strands column 1 and mashes the rest into one cell — the bug the user flagged). The
          // header row may bridge some gutters, so the empty test tolerates a minority (≤50%) of rows.
          const runRows = flowGroups.slice(runStart, runStart + runLen);
          const nRows = runRows.length;
          const rLeft = Math.min(...runRows.flatMap(g => g.items.map(it => it.x)));
          const rRight = Math.max(...runRows.flatMap(g => g.items.map(it => it.x + (it.w || 0))));
          const tW = Math.max(1, Math.ceil(rRight - rLeft) + 1);
          const coverRows = new Int32Array(tW);
          for (const g of runRows) {
            const mark = new Uint8Array(tW);
            for (const it of g.items) { const a = Math.max(0, Math.floor(it.x - rLeft)), b = Math.min(tW, Math.ceil(it.x + (it.w || 0) - rLeft)); for (let i = a; i < b; i++) mark[i] = 1; }
            for (let i = 0; i < tW; i++) coverRows[i] += mark[i];
          }
          const gutThresh = Math.max(8, bodyHeight * 1.2);
          let nGut = 0, gutRun = 0;
          for (let i = 0; i < tW; i++) {
            if (coverRows[i] <= nRows * 0.5) gutRun++;
            else { if (gutRun >= gutThresh && i - gutRun > 0) nGut++; gutRun = 0; }
          }
          __dbg.tableGutters = nGut;
          if (runLen >= 3 && !isListLikePage && nGut >= 2) {
            // A positioned-token TABLE: each token carries its x-fraction as a single PUA position char
            // (U+E200 + permille), tokens concatenated, rows joined by U+E024, whole payload prefixed
            // U+E025. Survives the whitespace collapse; the position chars neutralise to spaces for search.
            // Dropped into the block stream by yTop below. The x-fraction is measured against the PAGE's
            // content bounds (contentMinX..contentMaxX = the body text column), NOT the table's own bbox —
            // so a table that SPANS TWO PAGES (this one does: sums 24→9, then 8→2) keeps identical column
            // positions on both fragments (the continuation page lacks the "The sum of" header, so its own
            // bbox is narrower and would scale/shift its columns out of line with the first page). Both
            // dice pages share the same content column, so the fragments now align exactly.
            __dbg.path = 'geo-rowmajor-table';
            const posChar = (xf: number) => String.fromCharCode(0xE200 + Math.max(0, Math.min(1000, Math.round(xf * 1000))));
            const denom = Math.max(1, contentMaxX - contentMinX);
            const rowsEnc = runRows.map(g => [...g.items].sort((a, b) => a.x - b.x)
              .map(it => { const t = it.str.replace(/\s+/g, ' ').trim(); return t ? posChar((it.x - contentMinX) / denom) + t : ''; })
              .filter(Boolean).join(''));
            const payload = '' + rowsEnc.filter(Boolean).join('');
            const yTop = Math.max(...runRows.flatMap(g => g.items.map(it => it.y)));
            const list = tablesByPage.get(pageNum) || []; list.push({ text: payload, yTop }); tablesByPage.set(pageNum, list);
            flowGroups.forEach((g, idx) => { if (idx >= runStart && idx < runStart + runLen) return; groups.push(g); });
          } else if (runLen >= 3 && !isListLikePage) {
            __dbg.path = 'geo-rowmajor';
            const cs = rowInfo.slice(runStart, runStart + runLen).map(r => r.at).sort((a, b) => a - b);
            const gutterX = cs[cs.length >> 1];
            flowGroups.forEach((g, idx) => {
              if (idx >= runStart && idx < runStart + runLen) {
                const l = rowInfo[idx].its.filter(it => cx(it) < gutterX), r = rowInfo[idx].its.filter(it => cx(it) >= gutterX);
                if (l.length && r.length) { groups.push({ baseY: g.baseY + 0.1, baseH: g.baseH, items: l, col: 0 }, { baseY: g.baseY - 0.1, baseH: g.baseH, items: r, col: 1 }); return; }
              }
              groups.push(g);
            });
          } else {
            groups.push(...flowGroups);
          }
          // A drop cap is an oversized initial spanning several body lines; attach each to the TOP
          // line of its vertical span (the opening line it aligns with), falling back to the nearest.
          // Single-flow pages only — multi-column pages carry no drop caps.
          for (const cap of dropCaps) {
            let target: LineGroup | null = null;
            for (const group of groups) {
              if (group.baseY > cap.y - lineTolerance && group.baseY <= cap.y + cap.h && (!target || group.baseY > target.baseY)) target = group;
            }
            if (!target) {
              let bestDist = Infinity;
              for (const group of groups) { const d = Math.abs(group.baseY - cap.y); if (d < bestDist) { bestDist = d; target = group; } }
            }
            if (target) target.items.push(cap);
          }
        }
        }

        const MARK = { italic: '*', bold: '**' } as const;
        // ── DIAGNOSTIC dump: record every page's column-detection outcome to a global the user can
        // read in the browser console (window.__dbgTwoCol). Also console.log a compact line for pages
        // that either detected columns OR look like an undetected multi-line list (the failure case).
        {
          const colDist = { left: 0, right: 0, full: 0 };
          for (const g of groups) { if (g.col === 0) colDist.left++; else if (g.col === 1) colDist.right++; else colDist.full++; }
          __dbg.cols = colDist;
          __dbg.sample = groups.slice(0, 2).map(g => g.items.map((i: any) => i.str).join('')).join(' ¦ ').slice(0, 70);
          const G: any = globalThis as any;
          (G.__dbgTwoCol = G.__dbgTwoCol || []).push(__dbg);
          const suspect = colDist.right === 0 && colDist.full >= 24; // many lines, no columns found
          if (colDist.right > 0 || __dbg.structKeys >= 2 || suspect) {
          }
        }
        const pageLines = groups
          .map(group => {
            const items = group.items.sort((a, b) => a.x - b.x);
            // The line's representative height, weighted by CHARACTER count — not item count. A body line
            // that clustered a tiny superscript footnote marker ("[11]" h=11) next to a body run (h=15) has
            // two items; an item-count mode ties and picks the marker's height, mislabeling the whole line
            // as small (it then took a tiny size tier and split from its paragraph — Singularity p25). The
            // body run has far more characters, so char-weighting makes it dominate.
            const hWeight = new Map<number, number>();
            for (const it of items) hWeight.set(Math.round(it.h), (hWeight.get(Math.round(it.h)) || 0) + Math.max(1, (it.str || '').trim().length));
            let lineBodyHeight = group.baseH, hBest = 0;
            for (const [k, c] of hWeight) if (c > hBest) { hBest = c; lineBodyHeight = k; }
            const gapThreshold = Math.max(1, lineBodyHeight * 0.12);

            // Pre-scan: a contiguous run of glyphs sharing one internal go-to link
            // annotation is a footnote / cross-reference marker. If the run reads as a 1–3
            // digit number (optionally bracketed) emit it once as a footnote link
            // "[N](#key)" — the same key the note anchor on the destination page carries —
            // catching both raised superscripts and full-size bracketed markers. Otherwise
            // the run is prose that merely carries a link (a cross-reference); drop the
            // link and keep the text.
            const markerEmit: ({ label: string; key: string } | null)[] = items.map(() => null);
            const skip: boolean[] = items.map(() => false);
            for (let i = 0; i < items.length;) {
              const key = items[i].noteKey;
              if (!key) { i++; continue; }
              let j = i, txt = '';
              while (j < items.length && items[j].noteKey === key) { txt += items[j].str.trim(); j++; }
              // Only a forward link (destination on a later page) is a body footnote marker
              // — the chapter-end notes follow the body. A note's own number carries the
              // PDF's backward link (note → marker); leaving that as plain text lets the
              // forward note-anchor be injected onto it, and the reader provides the
              // back-navigation. Cross-references stay text too. The label may be a number or
              // a Roman numeral (this book's chapter-end footnotes are Roman).
              const destPage = Number(key.match(/^pdffn-p(\d+)-/)?.[1] || 0);
              // An index alphabet-nav letter (a standalone single uppercase letter linking to its section):
              // route it as a plain clickable cross-reference. This runs BEFORE markerLabelOf so a roman
              // letter (I=1, V=5, X=10 — value ≤40) isn't mis-classified as a footnote marker and rendered
              // inert. Apply the link only to the LETTER glyph, not the trailing space that shares its run
              // (the space sits inside the letter's link rect), so adjacent letters ("Q R") don't fuse.
              if (isAlphaNavPage && destPage > 0 && /^[A-Z]$/u.test(txt)) {
                // Carry the annotation's Y (from the gotoLink key) in the href so the reader can land at
                // the letter's SECTION, not just the page top — a letter section can start mid-page (U on
                // p651 sits below the tail of T), so page-level navigation misses it.
                const destY = Number(key.match(/-y(\d+)/)?.[1] || 0);
                const href = destY > 0 ? `#pdfref-p${destPage}-y${destY}` : `#pdfref-p${destPage}`;
                for (let k = i; k < j; k++) { if (items[k].str.trim()) items[k].linkUrl = href; items[k].noteKey = undefined; }
                i = j; continue;
              }
              const label = markerLabelOf(txt);
              // A calibre fake-anchor footnote ref (routed to a KEYLESS "#pdfnote-cal-…" key — its
              // named dest doesn't exist so it carries no dest page) is still a body marker. Without
              // this it fails the `destPage > pageNum` gate, falls through to the clear-noteKey else,
              // and renders as flattened plain text ("fn10" in the body). Treat it as markerLike so it
              // emits a clickable superscript ref the reader resolves to the in-chapter note by pattern.
              const isKeylessNote = /^pdfnote-/.test(key);
              const markerLike = (destPage > pageNum || isKeylessNote) && label !== '';
              if (markerLike) { markerEmit[i] = { label, key }; for (let k = i + 1; k < j; k++) skip[k] = true; }
              else if (label === '' && destPage > 0) {
                // A go-to link whose text is PROSE (not a bare footnote number/Roman) is a
                // CROSS-REFERENCE — "(… see Appendix 2 .)". Keep it navigable as a ONE-WAY jump to
                // the destination page (resolved to the target chapter at read time) instead of
                // dropping the annotation and leaving inert text. Reuse the external-link span
                // mechanism (an internal "#pdfref-p{n}" href, so the marker-run logic never fires).
                for (let k = i; k < j; k++) { items[k].linkUrl = `#pdfref-p${destPage}`; items[k].noteKey = undefined; }
              }
              else if (destPage > 0 && destPage < pageNum && label !== '' && (() => {
                // A BACKWARD numeric go-to link sitting MID-LINE after an index term or another page
                // number ("Africa, 388" / "213, 215") is an INDEX page reference — make it the same
                // one-way #pdfref link the ranges ("236–37") already become, so every index page
                // number is consistently clickable. A note BACK-link (a note's own leading number)
                // leads its line, so it fails the mid-line test and stays plain text for anchoring.
                let p = i - 1;
                while (p >= 0 && !items[p].str.trim()) p--;
                // Allow a trailing hyphen/dash too: the SECOND number in a page RANGE ("284-287",
                // "330-332") is a real index link whose previous run is the "-" separator — without
                // this it fails the letter/digit/comma test and its link is dropped.
                if (p >= 0) return /[\p{L}\d,–—-]$/u.test(items[p].str.replace(/\s+$/u, ''));
                // The number LEADS its line. An index entry that wraps can push a page-ref range/list
                // onto its own physical line ("…access control, 194,⏎283–287, 355") — the FIRST number
                // (283) then has no previous glyph on the line and its link was dropped. It is a genuine
                // index ref when it heads a page-number SEQUENCE: the next glyph is a range dash or a
                // comma/number. A note's own leading back-number is followed by the note PROSE (a word
                // or "."), so it still fails this and stays plain text for the note anchor.
                let q = j;
                while (q < items.length && !items[q].str.trim()) q++;
                const nextStr = q < items.length ? items[q].str.trim() : '';
                const leadsPageSeq = /^[–—-]/u.test(nextStr) || /^,\s*\d/u.test(nextStr) || nextStr === ',';
                // ── REF-LINK AUDIT (index leading-line refs) — remove after fix.
                return leadsPageSeq;
              })()) {
                for (let k = i; k < j; k++) { items[k].linkUrl = `#pdfref-p${destPage}`; items[k].noteKey = undefined; }
              }
              else { for (let k = i; k < j; k++) items[k].noteKey = undefined; }
              i = j;
            }

            let out = '';
            let open: 'italic' | 'bold' | null = null;
            let openLink: string | null = null; // open external-URL link span, if any
            items.forEach((it, idx) => {
              if (skip[idx]) return; // glyph already consumed by a footnote-marker run
              const prev = idx > 0 ? items[idx - 1] : null;
              // No space when the horizontal gap to the previous glyph is tiny — rejoins
              // letter-spaced small caps ("C LIVE" -> "CLIVE") without merging real words
              // (body word-gaps are far larger than this threshold).
              const glue = !!prev && (prev.dropCap || (prev.w > 0 && (it.x - (prev.x + prev.w)) <= gapThreshold));
              const trimmed = it.str.trim();

              // Footnote / cross-reference marker backed by a real link annotation.
              const marker = markerEmit[idx];
              if (marker) {
                if (open) { out += MARK[open]; open = null; }
                if (openLink) { out += `](${openLink})`; openLink = null; }
                out += (out === '' ? '' : (glue ? '' : ' ')) + `[${marker.label}](#${marker.key})`;
                emittedMarkerKeys.add(marker.key);
                return;
              }

              // A small-font number not at the line start, with no link annotation, is a
              // flattened superscript footnote marker. Emit the geometry-only #pdfnote key
              // (resolved by chapter scope downstream) for PDFs whose footnotes carry no
              // link annotations.
              // A small-font number immediately after a DIGIT is a math exponent ("10" + raised
              // "20" = 10^20), not a footnote marker — the preceding glyph ends in a digit with
              // no separating punctuation. A real marker follows a word or sentence punctuation.
              const prevEndsDigit = idx > 0 && /\d$/u.test(items[idx - 1].str.replace(/\s+$/u, ''));
              const small = it.h < lineBodyHeight * 0.84;
              const numMarker = !prevEndsDigit && /^\d{1,3}$/.test(trimmed) && Number(trimmed) >= 1;
              // A small-font ROMAN numeral (I, II, iv…) not at line start, attached to a WORD, is a
              // geometry-only footnote marker too — some books (The Sovereign Individual) use Roman
              // chapter-end footnotes with no link annotation ("nomenklaturas,ᴵ"). Require the previous
              // glyph to end in a letter (optionally a comma/period) so a stray small "I"/"V"/"X" that
              // is not a reference isn't caught, and bound the value like the annotation path (≤ 40).
              // UPPERCASE only: footnote markers are uppercase Roman (I, II, …), while a lowercase
              // superscript roman is almost always a MATH INDEX ("layerⁱ", "Nⁱ neurons in layer i") —
              // catching those would break the formula and invent bogus footnotes.
              const prevEndsWord = idx > 0 && /\p{L}[.,;:!?’”")\]]?$/u.test(items[idx - 1].str.replace(/\s+$/u, ''));
              const romMarker = prevEndsWord && /^[IVXLCDM]{1,4}$/.test(trimmed) && ROMAN_MARKER_RE.test(trimmed) && romanValue(trimmed) >= 1 && romanValue(trimmed) <= 40;
              const isMarker = idx > 0 && small && (numMarker || romMarker);
              if (isMarker) {
                if (open) { out += MARK[open]; open = null; }
                if (openLink) { out += `](${openLink})`; openLink = null; }
                const label = romMarker ? trimmed.toUpperCase() : trimmed;
                out += `[${label}](#pdfnote-${pageNum}-${label})`;
                return;
              }
              // A small DIGIT run adjacent to a DIGIT is a MATH super/subscript ("10²⁰", "H₂O"), which the
              // footnote-marker check above deliberately excluded (prevEndsDigit). pdf.js gives no <sup>/<sub>
              // tag, so it otherwise fell through to a flat baseline digit ("1020"), corrupting the value. Map
              // it to the Unicode super/subscript by the sign of its baseline offset from the base glyph:
              // raised → superscript, lowered → subscript. Require a CLEAR offset (>0.12× body) so a same-
              // baseline small digit isn't transformed, and no link (a linked number is a routed marker).
              const mathScript = small && prevEndsDigit && !it.linkUrl && /^\d{1,4}$/.test(trimmed);
              if (mathScript) {
                // Offset from the LINE baseline (group.baseY = the tallest/body glyph's baseline, never raised
                // by a script), not the previous glyph — so a multi-glyph exponent's 2nd+ digit (whose prev is
                // the 1st raised digit) is still measured against the base, not a sibling script.
                const dy = it.y - group.baseY; // PDF y grows upward: >0 raised (super), <0 lowered (sub)
                const thr = lineBodyHeight * 0.12;
                if (dy > thr || dy < -thr) {
                  if (open) { out += MARK[open]; open = null; }
                  if (openLink) { out += `](${wireHref(openLink)})`; openLink = null; }
                  const MAP = dy > 0 ? SUPERSCRIPT_DIGITS : SUBSCRIPT_DIGITS;
                  out += (glue ? '' : (out === '' ? '' : ' ')) + [...trimmed].map(c => MAP[c] || c).join('');
                  return;
                }
              }

              // Wrap maximal runs of one emphasis style / one external link once, so a
              // multi-glyph italic title becomes "*A B C*" and a hyperlink becomes
              // "[A B C](url)" rather than fragmented per glyph.
              const style: 'italic' | 'bold' | null = it.italic ? 'italic' : it.bold ? 'bold' : null;
              const separator = out === '' ? '' : (glue ? '' : ' ');
              const linkChanged = (it.linkUrl || null) !== openLink;
              if (linkChanged || style !== open) {
                if (open) { out += MARK[open]; open = null; }
                if (linkChanged && openLink) { out += `](${wireHref(openLink)})`; openLink = null; }
                out += separator;
                if (linkChanged && it.linkUrl) { out += '['; openLink = it.linkUrl; }
                if (style) { out += MARK[style]; open = style; }
              } else {
                out += separator;
              }
              out += it.str;
            });
            if (open) out += MARK[open];
            if (openLink) out += `](${wireHref(openLink)})`;
            return {
              y: group.baseY,
              pageY: Math.max(...items.map(it => it.y)), // real page position (reflow leaves item.y intact)
              col: group.col, // 0 = left column, 1 = right column, undefined = full-width (for side-by-side render)
              x: Math.min(...items.map(it => it.x)),
              rightX: Math.max(...items.map(it => it.x + (it.w || 0))),
              text: out.replace(/\s+/g, ' ').trim(),
              h: lineBodyHeight,
              // The TALLEST glyph's font size (cap height), EXCLUDING drop caps — for a small-caps line this
              // exceeds the char-weighted `h` (the small caps sit at a reduced em); heading detection + a
              // heading block's size read off this so small-caps heads aren't seen as body / shrunk below it.
              // Tallest LETTER/DIGIT glyph only — PUNCTUATION is excluded. A leading em-dash "—" is drawn
              // full-height but is not a cap; on an all-small-caps line (a wrapped epigraph attribution
              // "—JEREMY BENTHAM, …") it would otherwise inflate capH above the small-caps text, tripping
              // sizeChanged so the attribution splits at its wrap AND its continuation ("AND LEGISLATION")
              // shrinks below its own first line. Fall back to all non-dropcap glyphs for a punctuation-only line.
              capH: (() => { const L = items.filter(it => !it.dropCap && /[\p{L}\p{N}]/u.test(it.str || '')); const src = L.length ? L : items.filter(it => !it.dropCap); return src.length ? Math.max(...src.map(it => it.h)) : group.baseH; })(),
              // The line OPENS with a drop-cap glyph (items are x-sorted, so the leftmost is items[0]): a
              // chapter opener's oversized initial. The block emit tags the paragraph U+E02E so the reader
              // floats the first letter (::first-letter), reproducing the drop cap instead of a normal letter.
              dropCapStart: !!items[0]?.dropCap,
              bold: items.filter(it => it.bold).length > items.length / 2,
              semibold: items.filter(it => it.semibold).length > items.length / 2,
              family: modeStr(items.map(it => it.family)),
              localFont: 0, // set after the document body font is known (see the windowed pass)
              mcRole: modeStr(items.map(it => it.mcRole || '')) || undefined, // tagged-PDF structural role
            };
          })
          .filter(line => line.text)
          .sort((a, b) => b.y - a.y);

        // Phase B: inject note anchors for any markers whose destination is this page. For
        // each target, find the note line whose baseline is the first at/below the
        // destination top (a /XYZ destination's Y is the line top, ~one ascent above the
        // baseline), then turn its leading "N." into the linked marker "[N](#key)" — the
        // same key the body marker carries, so they pair up like EPUB anchors.
        const anchorTargets = noteAnchorTargets.get(pageNum);
        if (anchorTargets) {
          for (const target of anchorTargets) {
            if (!emittedMarkerKeys.has(target.key)) continue; // only real footnote targets
            let noteLine: { y: number; x: number; text: string } | null = null;
            for (const line of pageLines) {
              if (line.y <= target.y + 2 && (!noteLine || line.y > noteLine.y)) noteLine = line;
            }
            if (noteLine && !/^\s*\[/.test(noteLine.text)) {
              // Turn the note entry's leading marker into the linked "[N](#key)". Two forms:
              // a bare number/Roman followed by "."/")" ("3.", "iv)"), or an "fn"-prefixed label
              // whose separator is just a space ("fn3 The journey…") — the latter is how this
              // book labels its chapter-end footnote entries.
              noteLine.text = noteLine.text.replace(
                /^(\s*)(f?n\s*(?:[ivxlcdm]{1,4}|\d{1,3})|(?:[ivxlcdm]{1,4}|\d{1,3})[.)])\s*/iu,
                (m, sp, marker) => markerLabelOf(marker) ? `${sp}[${markerLabelOf(marker)}](#${target.key}) ` : m
              );
            }
          }
        }

        // Phase B′: orphaned chapter-end note entries. When a body ref is a calibre fake-anchor
        // (keyless, registers no forward target), Phase B never links/splits its entry, so it merges
        // into the previous note as run-on prose (Elon "n10"/"n11" glued into fn9). But such an entry
        // still carries a BACKWARD go-to link (entry marker → body ref) — a reliable "this line is a
        // note entry" signal that prose and body number-lists lack. Rewrite the leading marker of any
        // such not-yet-anchored entry into a KEYLESS "#pdfnote-back" marker so startsFootnoteEntry
        // splits it and the reader hangs + pattern-resolves it exactly like a forward-anchored entry.
        for (const l of links) {
          if (!l.key) continue;
          const dp = Number(l.key.match(/^pdffn-p(\d+)-/)?.[1] || 0);
          if (dp === 0 || dp >= pageNum) continue; // only a BACKWARD (entry → earlier body) note link
          const [lx1, ly1, , ly2] = l.rect;
          let noteLine: { y: number; x: number; text: string } | null = null;
          for (const line of pageLines) {
            if (line.y >= ly1 - 2 && line.y <= ly2 + 2 && line.x <= lx1 + 6 && line.x >= lx1 - 24) { noteLine = line; break; }
          }
          if (!noteLine || /^\s*\[/.test(noteLine.text)) continue; // no line, or Phase B already anchored it
          noteLine.text = noteLine.text.replace(
            /^(\s*)(f?n\s*(?:[ivxlcdm]{1,4}|\d{1,3})|(?:[ivxlcdm]{1,4}|\d{1,3})[.)])\s*/iu,
            (m, sp, marker) => markerLabelOf(marker) ? `${sp}[${markerLabelOf(marker)}](#pdfnote-back-p${pageNum}-y${Math.round(noteLine!.y)}) ` : m
          );
        }

        const bodyLeft = mostFrequentLeft(pageLines.map(line => line.x));
        // Record each substantial full-width body line's right edge for the justified/ragged decision.
        // Skip short lines and sentinel-tagged lines (headings/centred/right/columns) — they don't
        // reach the body margin even in justified text and would skew the ragged verdict.
        for (const line of pageLines) {
          if (line.rightX > 0 && line.text.replace(/[-*_`~]/gu, '').trim().length > 45 && !/[-]/u.test(line.text)) {
            lineRightEdges.push(line.rightX);
          }
        }
        // The paragraph margin — where wrapped continuation lines sit — is normally bodyLeft, but a
        // page of rapid one-line dialogue turns makes the first-line INDENT the mode, hiding the true
        // margin (so `x > bodyLeft+8` never fires and a turn that wraps to a full line merges into the
        // previous turn). Take the LEFTMOST frequently-used left as the margin, so an indented turn
        // still registers as a paragraph start. On ordinary pages this equals bodyLeft.
        const leftFreq = new Map<number, number>();
        for (const l of pageLines) leftFreq.set(Math.round(l.x), (leftFreq.get(Math.round(l.x)) || 0) + 1);
        const leftMinCount = Math.max(2, pageLines.length * 0.1);
        const frequentLefts = [...leftFreq].filter(([, c]) => c >= leftMinCount).map(([x]) => x);
        const paraLeftMargin = frequentLefts.length ? Math.min(bodyLeft, ...frequentLefts) : bodyLeft;
        // The list's own top-level margin, from its NUMBERED markers ("1."–"10."). paraLeftMargin is
        // sampled per page and wobbles when a page carries only a couple of top-level openers at the true
        // margin — the page of a hierarchical list where most lines are the continuation/sub-item tiers
        // (Sovereign p338: only "8."/"9." at x=84, so x=84 falls below leftMinCount and the margin collapses
        // to the continuation tier x=102) — which then measures the lettered SUB-items (a.–d. at x=113) as
        // nearly flush, so they lose their nested indent while the same items on the previous page keep it.
        // A numbered marker is an unambiguous top-level list item; the leftmost tier holding ≥2 of them is
        // the list's real margin. Used ONLY to anchor a list item's block indent (below), never the page
        // margin itself. Undefined on non-list pages → no effect.
        const numMarkerLefts = pageLines
          .filter(line => /^\s*\d{1,2}[.)](?:\s|$)/u.test(line.text))
          .map(line => Math.round(line.x));
        // The leftmost tier holding >=2 numbered markers is the list's top-level margin. Scan candidates
        // left-to-right so a lone stray marker further left (a footnote digit, a page-spanning "10.") can't
        // hijack it (Sovereign p338 has a single x=77 token beside the real x=84 top-level tier).
        let listMarginLeft: number | undefined;
        for (const cand of [...numMarkerLefts].sort((a, b) => a - b)) {
          if (numMarkerLefts.filter(x => Math.abs(x - cand) <= 4).length >= 2) { listMarginLeft = cand; break; }
        }
        const lineGap = median(pageLines.slice(1).map((line, index) => pageLines[index].y - line.y).filter(gap => gap > 0));

        // Index/contents pages: encode each entry's left-indent depth as leading
        // non-breaking spaces (4 per level) so the reader can render index sub-entry
        // indentation — a PDF's x-position is otherwise discarded. Only mark pages that
        // look like an index/contents (≥6 lines ending in a page reference), so body
        // prose is never touched. Depth is measured relative to the leftmost *entry*
        // (a line ending in a page reference), so the running heading/intro and one-off
        // centred lines stay at level 0 and the levels are stable across index pages
        // (where only the first carries the heading). Body chapters strip these via the
        // prose cleanup's per-line trim; only the index keeps them.
        // A trailing page number may now be a "[213](#pdfref-p274)" link, so unwrap a trailing link
        // to its label before testing — otherwise the line ends in ")" and index detection misses it.
        // A trailing FOOTNOTE marker ("…FELL 0.01% TODAY!**[1](#pdffn-p449-y671)") is NOT a page
        // reference: unwrapping it to its digit label made a statistics-dense chapter-opening page —
        // every "news" line ends in a footnote — count ≥6 "page-ref" lines and mis-classify as an index
        // LIST page, so its chapter title/section head lost their heading size and the body indents
        // inverted (Singularity ch. 4 "LIFE IS GETTING EXPONENTIALLY BETTER"). A real index/TOC entry
        // ends in a bare page number or a #pdfref PAGE link, never a #pdffn footnote — so exclude a
        // trailing footnote link before the digit test. Notes pages (end in #pdfref back-links) are unaffected.
        const endsWithPageRef = (value: string): boolean => {
          const trimmed = value.trim();
          const tail = trimmed.match(/\[([^\]\n]+)\]\(([^)\n]*)\)\s*$/u);
          if (tail && /#pdffn/i.test(tail[2])) return false;
          const stripped = trimmed.replace(/\[([^\]\n]+)\]\([^)\n]*\)\s*$/u, '$1');
          // A "YYYY: value" chart-data line (a 4-digit YEAR label + a currency/percent/number value —
          // Kurzweil's income & poverty charts, "2010: $154.15" / "1950: ~30%") is a DATA column, NOT an
          // index entry, yet its trailing digit made it count as a page ref → ≥6 of them classified the whole
          // chart page as a LIST/index and merged the column into a run-on. Exclude that exact pattern only,
          // so prose/notes ("129. …") and real index entries ("Topic, 316") are untouched (verified: this
          // flips ONLY the chart-data pages, not the notes/price-history pages the broad decimal test hit).
          if (/^\s*(?:\*\*|\*)?\d{4}:\s*[~<>≈]?\$?[\d.,]+%?\s*$/u.test(trimmed)) return false;
          return /[\d](?:[–—-]\d+)?\s*$/u.test(stripped);
        };
        const isListPage = pageLines.filter(line => endsWithPageRef(line.text)).length >= 6;
        // A GENUINELY two-column index reflowed by band detection keeps each right-column (col 1) entry
        // at the RIGHT column's x. The index indent logic below measures depth against the page margin,
        // so a right entry (x≈260) would render as a deep sub-entry of the left column. Shift every col-1
        // line onto the left column's origin so entryBaseLeft / indentTiers / indentDepthFor are
        // column-relative. GATED on pageTwoColumn: on a single-column TOC the row-major detector
        // false-sets col 1 on some lines (title→page-number gap mistaken for a gutter), and shifting
        // those flattened a sub-entry's indent ("Medium Term" x=100 → flush while "Long Term" x=100 kept
        // its indent). Reading order (baseY: all left, then all right) is untouched.
        if (isListPage && pageTwoColumn) {
          const leftMin = Math.min(...pageLines.filter(l => l.col !== 1).map(l => l.x), Infinity);
          const rightCol = pageLines.filter(l => l.col === 1);
          if (rightCol.length && leftMin !== Infinity) {
            const shift = Math.min(...rightCol.map(l => l.x)) - leftMin;
            if (shift > INDENT_TOL) for (const l of rightCol) { l.x -= shift; l.rightX -= shift; }
          }
        }
        const indentTiers: number[] = [];
        if (isListPage) {
          const entryBaseLeft = Math.min(...pageLines.filter(line => endsWithPageRef(line.text)).map(line => line.x));
          const clusters: { x: number; count: number }[] = [];
          for (const line of pageLines) {
            if (line.x < entryBaseLeft - INDENT_TOL) continue;
            const cluster = clusters.find(c => Math.abs(c.x - line.x) <= INDENT_TOL);
            if (cluster) cluster.count++; else clusters.push({ x: line.x, count: 1 });
          }
          indentTiers.push(...clusters.filter(c => c.count >= 2).map(c => c.x).sort((a, b) => a - b));
        }
        // A footnote marker annotates PRECEDING text, so it never legitimately begins a body line: when
        // one leads a line it WRAPPED from the end of the previous (full) line — "…around 2060." then
        // "[11] But the latest…" (marker+text), or a lone "[12]" on its own line. Left there it splits the
        // one flowing paragraph in two (the leading marker trips startsFootnoteEntry) AND, leading a block,
        // the marker loses its link. Move it back to the end of the previous line so the paragraph stays
        // whole and the marker sits at its sentence end, clickable. Prose pages only — a NOTES page is a
        // list page (its entries genuinely start with "[N] …") and never reaches this branch.
        if (!isListPage) {
          const fnLead = /^(\[[0-9ivxlcdm]{1,8}\]\(#pdffn[^)\n]*\))(?:\s+(?=\S)|\s*$)/iu;
          for (let li = 1; li < pageLines.length; li++) {
            const m = pageLines[li].text.match(fnLead);
            if (!m || !pageLines[li - 1].text.trim()) continue;
            // A NOTE's own anchor marker legitimately BEGINS its entry in the notes section and must NOT
            // be moved (doing so strips every note's marker, so startsFootnoteEntry can't split them and
            // the whole notes section merges into a run-on — INTRODUCTION notes here are on short, <6-entry
            // pages that fall to the PROSE path, past the isListPage gate). A note anchor targets the
            // CURRENT page ("#pdffn-p398" on page 398); only a WRAPPED BODY marker targets a DIFFERENT
            // (later notes) page ("#pdffn-p401" on page 25) — move that one.
            const targetPage = Number(m[1].match(/#pdffn-p(\d+)/i)?.[1] || 0);
            if (targetPage === pageNum) continue;
            pageLines[li - 1].text = pageLines[li - 1].text.replace(/\s+$/u, '') + m[1];
            pageLines[li].text = pageLines[li].text.slice(m[0].length);
          }
        }
        // Retain this page's line geometry (baseline Y + text) when an outline bookmark
        // points at it, so chapter starts can be anchored to the exact heading line.
        if (outlinePages.has(pageNum)) {
          pageLineGeom.set(pageNum, pageLines.map(line => ({ y: line.y, text: line.text })));
        }

        // Buffer the page; prose line heights feed the document-wide body-font estimate.
        if (!isListPage) {
          allLineHeights.push(...pageLines.map(line => line.h).filter(Boolean));
          allRightEdges.push(...pageLines.map(line => line.rightX).filter(Boolean));
        }
        pageBuffers.push({ pageNum, lines: pageLines, bodyLeft, paraLeftMargin, listMarginLeft, lineGap, isListPage, indentTiers, pageHeight, pageTwoColumn, hRules });
      }

      // Running head/footer removal (untagged PDFs; a tagged PDF already dropped its Artifact
      // pagination above). A line in the extreme top/bottom margin band (≤8% of the page height
      // from an edge) that is a bare page number, a "page-number | section" running foot, or whose
      // digit-stripped signature recurs across ≥3 pages is pagination — not content — so drop it.
      // The tight band excludes real headings (a chapter title sits well inside the page), and the
      // page-number/shape/repeat gate excludes body prose that happens to sit near a margin.
      if (!isTaggedPdf) {
        const isPageNum = (t: string): boolean => /^\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*$/iu.test(t);
        const footSig = (t: string): string => t.toLowerCase().replace(/\s+/g, '').replace(/[|·•—–-]+/g, '|').replace(/\d+|[ivxlcdm]{1,7}/giu, '#');
        const runningFootShape = (t: string): boolean => { const parts = t.split(/\s*[|·•\t]\s*/u).filter(Boolean); return t.length <= 70 && parts.length === 2 && parts.some(isPageNum); };
        // The line text carries emphasis/markup (a bold footer is "**xvi | Foreword**"); strip it
        // before the page-number/shape tests or the markers break them.
        const cleanFoot = (t: string): string => t.replace(/[*_~`]/gu, '').replace(/\s+/g, ' ').trim();
        const sigCount = new Map<string, number>();
        const marginLines: PdfLine[] = [];
        for (const buf of pageBuffers) {
          const band = buf.pageHeight * 0.08;
          for (const line of buf.lines) {
            if (buf.pageHeight > 0 && (line.pageY < band || line.pageY > buf.pageHeight - band)) {
              marginLines.push(line);
              const s = footSig(cleanFoot(line.text)); sigCount.set(s, (sigCount.get(s) || 0) + 1);
            }
          }
        }
        const drop = new Set<PdfLine>();
        for (const line of marginLines) {
          const ct = cleanFoot(line.text);
          if (isPageNum(ct) || runningFootShape(ct) || (sigCount.get(footSig(ct)) || 0) >= 3) drop.add(line);
        }
        if (drop.size) for (const buf of pageBuffers) buf.lines = buf.lines.filter(l => !drop.has(l));
        // Cover/barcode metadata (the ISBN and the printed price) is not reading content and, ending
        // in digits, the reader would otherwise glue it onto the next paragraph. These patterns never
        // occur in prose, so drop them book-wide.
        const isCoverMetadata = (t: string): boolean => {
          const s = t.replace(/[*_~`]/gu, '').trim();
          return /^ISBN[\s:-]/i.test(s) || /^US\s*\$[\d,.]+\s*CAN\s*\$[\d,.]+$/i.test(s);
        };
        for (const buf of pageBuffers) buf.lines = buf.lines.filter(l => !isCoverMetadata(l.text));
      }

      // Phase C: the document body font is the most common line height across prose pages;
      // a line whose font is clearly larger is a heading/subtitle. With the baseline known,
      // group each page's lines into blocks and join soft-wrapped lines, so the cleanup and
      // reader classify whole paragraphs/headings instead of per-line fragments (what made
      // a small-caps sentence tail look like a subtitle, split a wrapped quote into a new
      // paragraph, and shattered a multi-line heading).
      const bodyFont = mode(allLineHeights.map(h => Math.round(h))) || median(allLineHeights) || 0;
      // Doc-wide body left margin = the most common per-page paragraph margin. A per-page paraLeftMargin
      // wobbles RIGHT on a list-dominated page (Singularity p36 = 130 vs p35 = 93), so the SAME right-aligned
      // roman sub-list would indent differently across pages and a page-split list ("i./ii./iii." on p35,
      // "iv." on p36) would mismatch. Anchor the roman sub-list re-anchor on this stable value instead.
      const docBodyLeft = mode(pageBuffers.map(b => Math.round(b.paraLeftMargin))) || 0;
      // Heading detection, principled: a heading is text set in the typesetter's HEADING font FAMILY
      // — a display family DISTINCT from the body family. pdf.js exposes the real font name
      // (commonObjs), so we read the family directly; this beats size, which a heading does not
      // reliably have (a notes-section chapter header equals body size; an epigraph/attribution is
      // SMALLER than body yet a size rule would over-fire on a skewed local estimate). The heading
      // family is LEARNED from the contents page — the document's own list of headings, every entry
      // in that family — and the body family is the document's dominant family. Size cannot tell a
      // size-15 notes header from size-15 body; the family can (TradeGothic vs the body serif), and
      // it correctly EXCLUDES epigraphs/quotes/attributions/italic-titles/figure-captions, which all
      // sit in non-heading families. (Falls back to the size rule when there is no contents page or
      // no distinct heading family — e.g. headings that are merely bold body text — so a book
      // without this typographic convention degrades to the old behaviour rather than breaking.)
      const bodyFamily = modeStr(pageBuffers.flatMap(b => b.lines.map(l => l.family)));
      const contentsBuf = pageBuffers.find(b => b.lines.length >= 6 &&
        b.lines.slice(0, 3).some(l => /^(?:contents|table of contents)$/iu.test(l.text.replace(/[*_~]/gu, '').trim())));
      const headingFamily = contentsBuf
        ? modeStr(contentsBuf.lines.filter(l => l.family && l.family !== bodyFamily && l.text.replace(/[*_~\s]/gu, '').length > 3).map(l => l.family))
        : '';
      // LOCAL section body font per line: the dominant line height of the page's section, smoothed
      // over a window of pages and combined with the page's own font (max, so a figure/footnote-
      // heavy page can't drag it below the section body, and a section boundary doesn't bleed a
      // neighbour's smaller font). A heading is judged against the body of its OWN section — the
      // notes header (h15) is large vs the h11 notes, while the callout/dialogue (h15) is NOT large
      // vs the h15 body. Set on every line for isHeadingLine.
      const HEADING_WINDOW = 8;
      const pageHeights = pageBuffers.map(b => b.lines.map(l => Math.round(l.h)));
      pageBuffers.forEach((buf, idx) => {
        const win: number[] = [];
        for (let k = Math.max(0, idx - HEADING_WINDOW); k <= Math.min(pageBuffers.length - 1, idx + HEADING_WINDOW); k++) win.push(...pageHeights[k]);
        const lf = Math.max(mode(pageHeights[idx]) || bodyFont, mode(win) || bodyFont);
        buf.lines.forEach(line => { line.localFont = lf; });
      });
      // Tag the heading lines the OUTLINE names (all levels) — the author's own structure catches
      // section headings the font-family rule misses (a title set in the body font). Among the
      // lines near an entry's destination Y on its page, mark the one whose text prefix-matches the
      // title (either direction, normalised). The title gate is the safety: it rejects page-only
      // bookmarks whose destination lands on non-heading text (a "Copyright" bookmark → the imprint
      // line), so this can only ADD real headings, never mis-tag body.
      if (outlineHeadingTargets.length) {
        const linesByPage = new Map<number, PdfLine[]>();
        for (const buf of pageBuffers) linesByPage.set(buf.pageNum, buf.lines);
        const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/gu, '');
        for (const target of outlineHeadingTargets) {
          const lines = linesByPage.get(target.page);
          const titleN = norm(target.title);
          if (!lines || titleN.length < 4) continue;
          let best: PdfLine | null = null, bestDy = Infinity;
          for (const line of lines) {
            const dy = Math.abs(line.y - target.y);
            if (dy > 50 || dy >= bestDy) continue;
            const lineN = norm(line.text);
            if (lineN.length < 4) continue;
            const short = lineN.length < titleN.length ? lineN : titleN;
            const long = lineN.length < titleN.length ? titleN : lineN;
            if (long.startsWith(short.slice(0, 22))) { bestDy = dy; best = line; }
          }
          if (best) best.outlineHeading = true;
        }
      }
      // Heading detection, principled: a heading is text set in the HEADING font FAMILY (a display
      // family distinct from the body — read from the real font name via commonObjs, learned from
      // the contents page) AND typographically LARGER than the body of its OWN section (the local
      // font above). Family alone over-catches body content typeset in the display family — Chapter
      // 8's dialogue, the "late-breaking news" callout, both at body size; local size alone over-
      // catches body prose on a figure-heavy page (wrong family). TOGETHER: the size-15 notes header
      // (large vs the h11 notes) and the big titles pass; the size-15 callout/dialogue (not large vs
      // the h15 body) do not. (Falls back to the size rule when no contents page / no heading family.)
      // Foundry-suffix normalisation for font-FAMILY comparison: the SAME face is embedded under naming
      // variants that differ only by a PostScript/Monotype suffix — a heading in "TimesNewRomanPSMT" vs a
      // headingFamily learned as "TimesNewRomanPS" is the same font (BHI's Part titles "…and the First…"
      // are PSMT at 27.5 vs body 15 = 1.83×, but the exact-string match rejected them → the title fell to a
      // list line and lost its heading size). Strip a trailing PS/MT/PSMT so same-face variants unify; a
      // genuinely different display family (Helvetica vs Times) stays distinct, and the 1.2× size gate still
      // keeps body text (at 1.0×) out, so this only ADMITS same-face headings, never body.
      const normFam = (f: string | undefined): string => (f || '').replace(/(?:PSMT|PS|MT)$/i, '');
      const isHeadingLine = (line: PdfLine): boolean => {
        const ch = line.capH ?? line.h;
        if (line.mcRole) return /^H[1-6]?$/u.test(line.mcRole);
        if (line.outlineHeading === true) return true;
        const scText = line.text.replace(/[*_~`\s ]+$/u, '');
        const scEndsClause = /[.,;。，；]["')”’\]]?$/u.test(scText);
        // Primary rule: a display-font heading (family learned from the contents page) LARGER than the body
        // of its own section (1.2×); else the plain size rule (no display family learned).
        if (headingFamily
          ? (normFam(line.family) === normFam(headingFamily) && line.localFont > 0 && ch >= line.localFont * 1.2)
          : (bodyFont > 0 && ch >= bodyFont * 1.2)) return true;
        // SUB-HEADING below the 1.2× gate (Transurfing's "Principle"/"Interpretation": bold, 16.9 vs body 15
        // = 1.13×, each on its own short line above its paragraph — otherwise MERGED into the body). These
        // z-lib PDFs collapse every weight to ONE family name (LiberationSerif), so a display-FAMILY test
        // can't see them; key off the WHOLE-LINE-BOLD the extractor already detected, OR a genuinely distinct
        // family. Guard against a body-size bold callout by requiring LARGER than body (>=1.08x), NOT clause-
        // ending, and SHORT (doesn't fill the measure — a wrapped bold body line would).
        const _hRef = line.localFont > 0 ? line.localFont : bodyFont;
        // WHOLE-LINE-BOLD only. (A distinct-FAMILY test over-caught non-headings in books with a real
        // display font — Singularity chart titles + an italic back-matter promo, both a different family;
        // those books' real headings are already caught by the 1.2× primary rule, so family isn't needed.)
        const _wholeBold = /^\*\*[\s\S]+\*\*$/u.test(line.text.trim());
        // A bare-label sub-head ("Principle") has NO terminal punctuation; a full question/utterance
        // (Singularity's bold Q&A prompts "WHAT IS THE MEANING OF LIFE?", already handled via sizeEm)
        // ends in ? or !, so exclude those here — scEndsClause only covers . , ; so add ? ! explicitly.
        const _endsUtterance = /[.,;。，；?!？！]["')”’\]]?$/u.test(scText);
        if (_wholeBold && _hRef > 0
          && ch >= _hRef * 1.08 && !_endsUtterance && !fillsMeasure(line.rightX, bodyRightEdge)) {
          return true;
        }
        // SMALL-CAPS section head set in the BODY font (missed by the family rule — Sovereign's "PREMONITIONS",
        // Transurfing chapter titles): full caps clearly taller than the char-weighted body height AND heading-
        // sized vs body; capH >> h keeps a full-caps body line out. A body phrase ending a clause is prose.
        // Require actual small-caps LETTERS: `ch >= line.h*1.25` (capH >> char-weighted h) genuinely means
        // small caps only when the reduced-height glyphs are letters. A line like "10[111]" (a wrapped chart
        // TITLE's numeric tail + a small footnote MARKER) has the SAME inflated ratio — capH from "10", char-h
        // dragged down by the tiny "[111]" — but it's not a heading; without the letter test it split off as a
        // spurious small-caps head from its title line ("…and 10"). Genuine small-caps heads (PREMONITIONS) pass.
        if (!scEndsClause && bodyFont > 0 && ch >= bodyFont * 1.3 && ch >= line.h * 1.25
          && /[A-Za-zÀ-ɏ]{2,}/u.test(scText.replace(/\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1'))) return true; // visible text only — a footnote MARKER link "[111](#pdffn…)" carries href letters; strip them
        return false;
      };
      // A line "fills the measure" if its right edge reaches the page's text right margin
      // (within ~two characters) — i.e. it wrapped rather than ending. This is the geometric
      // signal for a continuing paragraph, the one a text-only heuristic cannot see.
      const fillsMeasure = (rightX: number, margin: number): boolean => margin > 0 && margin - rightX <= bodyFont * 2;
      // The document's text right margin: a high percentile of body line right edges, where
      // full (justified) prose lines end. Used to spot line-structured data — a catalog/CIP
      // block, an address, a short list — where consecutive lines occupy less than half the
      // measure and so should stay one per line rather than reflow into a run-on paragraph.
      // (pdfminer and layout-aware extractors classify such ragged/short lines as list lines,
      // not paragraph lines, by exactly this line-fill signal.)
      const sortedEdges = [...allRightEdges].sort((a, b) => a - b);
      const bodyRightEdge = sortedEdges.length ? sortedEdges[Math.floor(sortedEdges.length * 0.9)] : 0;
      // (Short-data-line detection is column-aware — see isShortColLine in the per-page loop, which
      // measures a column line against its own column width instead of this document-wide margin.)
      // A footnote entry starts a new block: it sits in the smaller footnote font and opens
      // with a marker — already linked by the note-anchor injection ("[II](#…) Adam Smith…"),
      // or a bare number/Roman ("II. …") for a footnote whose forward marker wasn't found.
      // Without this, two chapter-end footnotes with a small gap join into one paragraph.
      const startsFootnoteEntry = (line: PdfLine): boolean => {
        if (bodyFont > 0 && line.h >= bodyFont * 0.92) return false;
        // A footnote entry opens with a NOTE MARKER — a number or roman numeral — linked to its anchor.
        // The anchor must be that marker, NOT arbitrary descriptive text: a "this page"-style dest link
        // wrapping to a line start ("[page](#pdffn…) FDA photo…") is body text, and without this gate it
        // split the credits paragraph at the wrap.
        const leadLink = line.text.match(/^\s*\[([^\]\n]+)\]\(#[^)\n]*\)/);
        // markerLabelOf accepts a numeric/roman marker AND an "fn"-prefixed one ("fn2"), while still
        // rejecting descriptive dest links ("[page](#…)"). The Elon PDF's in-chapter footnotes use
        // "[fn2](#pdffn…)"; the old numeric-only test missed them, so each footnote failed to start its
        // own block — the whole footnote section merged into the body and fn2 navigation resolved nowhere.
        if (leadLink && markerLabelOf(leadLink[1].trim())) return true;
        const m = line.text.match(/^\s*([ivxlcdm]{1,4}|\d{1,3})[.)]\s/iu);
        return Boolean(m && markerLabelOf(m[1]));
      };

      // Justified vs ragged (computed HERE so the per-page splitter can use it too, not only the reader):
      // full body lines reach a common right margin on a high fraction of lines. In justified text a line
      // that ENDS SHORT of that margin is a block boundary (a paragraph/term/heading end) — the signal the
      // punctuation/first-line-indent heuristics miss on block-paragraph books (e.g. a definition list
      // whose italic term sits flush at the margin and whose description is indented under it).
      let sourceJustified: boolean | undefined;
      if (lineRightEdges.length >= 30) {
        const sortedRE = [...lineRightEdges].sort((a, b) => a - b);
        const topRE = sortedRE.slice(Math.floor(sortedRE.length * 0.6));
        const jMargin = topRE[Math.floor(topRE.length / 2)];
        sourceJustified = sortedRE.filter(e => e >= jMargin - 6).length / sortedRE.length > 0.7;
      }

      // Whether the book uses a typographic FIRST-LINE indent on paragraphs (novels) vs BLOCK paragraphs
      // (flush, separated by space — many technical books). Measured on justified pages from the geometry:
      // a paragraph's first line sitting deeper than its continuation lines. Lets the reader stop forcing
      // its fixed first-line indent on block-style sources (which the source doesn't have). Conservative:
      // only decided with enough samples, else undefined → reader keeps its default.
      let bodyBlkTotal = 0, bodyBlkFirstLineIndented = 0;
      const firstLineIndentEms: number[] = []; // per-block first-line indent (em vs bodyFont) → source magnitude
      // Per-TYPE hanging-indent magnitudes (em vs bodyFont): a multi-line hanging item's continuation
      // lines sit one hang deeper than its marker. Sampled per list type so the reader reproduces the
      // printed hang (bullet vs numbered vs index) instead of fixed 1em/1.5em/1em constants.
      const bulletHangEms: number[] = [], listHangEms: number[] = [], indexHangEms: number[] = [];

      // Each page's blocks are buffered with the geometry the cross-page seam join needs,
      // then assembled into one stream so a paragraph that runs off the bottom of one page
      // and continues at the top of the next is rejoined from the layout, not guessed.
      type EmitBlock = { text: string; role: 'heading' | 'body' | 'list'; firstX: number; firstRightX: number; lastRightX: number; lastText: string; carryover?: boolean; col?: 0 | 1; topY?: number; bodyX?: number; pbBreak?: boolean; dataColumn?: boolean };
      const pageEmit: { pageNum: number; blocks: EmitBlock[]; rightMargin: number; bodyLeft: number; paraLeftMargin: number }[] = [];

      // ── Unify TOC indent tiers across the whole run ──
      // A multi-page TOC carries its "Contents" heading only on the FIRST page; continuation pages are
      // detected as generic list pages and routed through the index emit, whose tiers derive from a
      // per-page ref-ending base (count>=2). A page that starts mid-chapter lacks the outer Part/chapter
      // levels, so the SAME source indent (a subsection at x=100) came out depth 3 on the heading page
      // (contents path, distinct-x tiers) but depth 1 on a continuation. Mark the contiguous TOC run and
      // give every page ONE run-wide contents tier scale, so one source indent = one depth across the TOC.
      const isContentsHeadingPage = (buf: (typeof pageBuffers)[number]): boolean =>
        buf.lines.length >= 6 && buf.lines.slice(0, 3).some(l => /^(?:contents|table of contents)$/iu.test(l.text.replace(/[*_~]/gu, '').trim()));
      // A Contents WITHOUT page-reference numbers (a chapter list only, e.g. "39. Against the Flow" with no
      // trailing page) fails isListPage (which needs ≥6 lines ending in a page number), so its CONTINUATION
      // pages (which carry no "Contents" heading) were dropped from the run and fell to the prose path — a
      // spurious shrink tier + flush that broke the list at the page seam. Recognise a continuation page as a
      // run of SHORT numbered entries that dominate the page. Only consulted for a page FOLLOWING a Contents
      // heading page (the while-loop below), so the blast radius is one book's own contents continuation.
      const looksLikeNumberedListPage = (buf: (typeof pageBuffers)[number]): boolean => {
        const nonEmpty = buf.lines.filter(l => l.text.trim() && !isHeadingLine(l));
        const numberedShort = nonEmpty.filter(l => {
          const t = l.text.replace(/^[*_~\s ]+/u, '');
          // The entry may be a LINK ("[39. Against the Flow](#pdfref-p68)") — page ref lives in the href,
          // not visible trailing text — so tolerate a leading "[" / "**" and measure VISIBLE title length
          // (strip the ](href) target + md syntax), not the raw line with its long href.
          const visible = t.replace(/\]\([^)\n]*\)/gu, ']').replace(/[[\]*_~]/gu, '').replace(/\s+/gu, ' ').trim();
          if (!visible || visible.length >= 70) return false;
          // A TOC-continuation entry is a SHORT line that is EITHER a numbered entry ("39." or, as in this
          // book, a colon chapter "10: The Neural Dark Ages") OR a markdown-LINK entry (its title points at a
          // page-ref href). Counting only "N." numbered entries missed BHI's colon chapters AND its Part/
          // back-matter LINK entries, so the 2nd Contents page fell below the 60% bar → prose path → merged.
          return /^\[?\**\d{1,3}[.):]\s+\S/u.test(t) || /\]\([^)\n]*\)/u.test(t);
        }).length;
        return numberedShort >= 6 && numberedShort >= nonEmpty.length * 0.6;
      };
      for (let i = 0; i < pageBuffers.length; i++) {
        if (!isContentsHeadingPage(pageBuffers[i])) continue;
        let j = i + 1;
        while (j < pageBuffers.length && (pageBuffers[j].isListPage || looksLikeNumberedListPage(pageBuffers[j])) && !isContentsHeadingPage(pageBuffers[j])) j++;
        const freq: { x: number; count: number }[] = [];
        for (let k = i; k < j; k++) for (const l of pageBuffers[k].lines) {
          if (isHeadingLine(l) || !l.text.trim()) continue;
          const c = freq.find(f => Math.abs(f.x - l.x) <= INDENT_TOL);
          if (c) c.count++; else freq.push({ x: l.x, count: 1 });
        }
        const tocTiers = freq.filter(f => f.count >= 2).map(f => f.x).sort((a, b) => a - b);
        for (let k = i; k < j; k++) { (pageBuffers[k] as any).tocTiers = tocTiers; (pageBuffers[k] as any).isTocPage = true; }
        i = j - 1;
      }
      // The current SECTION's body column — the left edge the surrounding flowing text uses. Tracks the
      // most recent multi-line, non-indented body block's left across pages, so a SINGLE-LINE block (a
      // one-word answer like "Love.", which has no continuation of its own to measure firstLineExtra
      // against) is judged flush vs indented against ITS section, not the page-wide paraLeftMargin (which
      // flips when a block-indented section shares a page with a differently-margined one — the "Love."
      // stayed indented on p139). Seeded with the doc body margin; self-corrects at each section start.
      let sectionBodyLeft = docBodyLeft;
      for (const buf of pageBuffers) {
        const { pageNum, lines, bodyLeft, paraLeftMargin, listMarginLeft, lineGap, isListPage, indentTiers, pageTwoColumn } = buf;
        const tocPage = !!(buf as any).isTocPage;
        const tocTiers: number[] = (buf as any).tocTiers || [];
        const proseLines = lines.filter(line => !isHeadingLine(line));
        const rightMargin = proseLines.length ? Math.max(...proseLines.map(line => line.rightX)) : 0;
        // PER-PAGE justification (robust when ONE file mixes justified and ragged sections): a page is
        // justified when its LONG lines share a HARD right margin — several reach the exact max edge. A
        // definition list has many short lines yet its full lines still hit the margin exactly (justified);
        // a ragged page's long lines scatter, so few reach the max. The short-line block-boundary rule is
        // gated on THIS, not the document flag, so a ragged page inside a justified book isn't shattered,
        // and a justified list inside a ragged book is still split.
        const pageMeasure = rightMargin - bodyLeft;
        const longLines = pageMeasure > 0 ? proseLines.filter(l => (l.rightX - l.x) > pageMeasure * 0.55) : [];
        const linesAtMargin = longLines.filter(l => rightMargin - l.rightX <= 3).length;
        const pageJustified = longLines.length >= 5 && linesAtMargin >= Math.max(4, longLines.length * 0.4);
        const indentDepthFor = (x: number): number => {
          const tier = indentTiers.findIndex(t => Math.abs(t - x) <= INDENT_TOL);
          return tier >= 1 ? Math.min(tier, 3) : 0;
        };

        // A table of contents has no page references, so the index/list test (≥6 lines
        // ending in a page number) misses it and its entries reflow into one run-on
        // paragraph. Detect it by a "Contents" heading near the top and emit one entry per
        // line (the entries are short titles, not prose).
        // Every page of the TOC run (heading page + continuations) takes the contents path with the
        // run-wide tier scale, so a source indent maps to one depth across all TOC pages.
        const isContentsPage = tocPage;
        if (isContentsPage) {
          // The TOC has its own structure, already decided by the page geometry and font:
          // KEEP each entry's emphasis (the bold chapter title) and encode its left-indent
          // tier as leading non-breaking spaces (4 per level, like the index), so the reader
          // reproduces the original bold + indentation instead of a flat uniform list.
          const tiers: number[] = tocTiers;
          const tierOf = (x: number): number => { const i = tiers.findIndex(t => Math.abs(t - x) <= INDENT_TOL); return i >= 1 ? Math.min(i, 3) : 0; };
          const blocks = lines
            .filter(line => line.text.replace(/[*_~]/gu, '').trim())
            .map(line => {
              const clean = line.text.replace(/\s+/gu, ' ').trim();
              // The "Contents" heading line (a larger font, or the literal "Contents") is emitted as a HEADING
              // (U+E013), not a flush list entry, so the reader renders it centred + enlarged like the source
              // instead of a small left-aligned row. Everything else stays a list entry with its indent tier.
              if (isHeadingLine(line) || /^(?:table of )?contents$/iu.test(clean.replace(/[*_~]/gu, '').trim())) {
                // + U+E01F size tier (~1.5em): the source sets the Contents heading LARGER than its entries
                // (Elon PDF h≈21 vs body 15 ≈ 1.4×), matching the EPUB's 1.4em <h2>. E013 = heading (centred).
                return { text: String.fromCharCode(0xE013, 0xE01F) + clean, role: 'heading' as const, firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '' };
              }
              return {
                text: ' '.repeat(4 * tierOf(line.x)) + clean,
                role: 'list' as const, firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '',
              };
            });
          pageEmit.push({ pageNum, blocks, rightMargin, bodyLeft, paraLeftMargin });
          continue;
        }

        // Index/contents: the entries are an indented list, but the lines BEFORE the first
        // entry (a "INDEX" heading and a prose intro note at the body margin) are not \u2014 they
        // must be reflowed, not chopped one fragment per line with stray indents.
        if (isListPage) {
          const formattedLines: string[] = [];
          const endsWithPageRef = (value: string): boolean => /[\d](?:[\u2013\u2014-]\d+)?\s*$/u.test(value.replace(/\[([^\]\n]+)\]\([^)\n]*\)\s*$/u, '$1'));
          const refLines = lines.filter(line => endsWithPageRef(line.text));
          const entryBaseLeft = refLines.length ? Math.min(...refLines.map(line => line.x)) : bodyLeft;
          // The first entry is the first line at the entry margin that also ENDS IN A PAGE
          // REFERENCE. An x-only test fails when the intro prose shares the body margin with the
          // entries (many indexes), treating the intro as entry one and chopping its wrapped
          // sentence ("…reference on" / "your e-reader.") into separate lines. The intro never
          // ends in a page number, so this cleanly separates the prose header from the entries.
          const firstEntryIdx = lines.findIndex(line => line.x >= entryBaseLeft - INDENT_TOL && endsWithPageRef(line.text));
          const introLines = firstEntryIdx > 0 ? lines.slice(0, firstEntryIdx) : [];
          const entryLines = firstEntryIdx > 0 ? lines.slice(firstEntryIdx) : lines;

          // Reflow the header/intro: keep a heading on its own line, join the note's wrapped
          // lines into one paragraph. These sit at the body margin, so they carry no indent.
          const introGap = median(introLines.slice(1).map((line, index) => introLines[index].y - line.y).filter(gap => gap > 0));
          let ii = 0;
          while (ii < introLines.length) {
            const groupIsHeading = isHeadingLine(introLines[ii]);
            const group: PdfLine[] = [introLines[ii]];
            let jj = ii + 1;
            while (jj < introLines.length && isHeadingLine(introLines[jj]) === groupIsHeading) {
              const prev = introLines[jj - 1], cur = introLines[jj];
              const verticalGap = prev.y - cur.y;
              const endsBlock = groupIsHeading
                ? verticalGap > Math.max(prev.h, cur.h) * 1.35
                : (introGap > 0 && verticalGap > introGap * 1.35) || (endsWithTerminalPunctuation(prev.text) && cur.x > bodyLeft + 8);
              if (endsBlock) break;
              group.push(cur);
              jj++;
            }
            let text = group[0].text;
            for (let k = 1; k < group.length; k++) text = /[A-Za-z]-$/.test(text) && /^[a-z]/.test(group[k].text) ? text + group[k].text : `${text} ${group[k].text}`;
            text = text.replace(/\s+/g, ' ').trim();
            if (groupIsHeading) text = text.replace(/[*_~]/g, '').trim();
            if (text) formattedLines.push(text);
            ii = jj;
          }

          // The entries themselves: one indented entry per line.
          entryLines.forEach((line, index) => {
            const previous = entryLines[index - 1];
            if (previous) {
              const verticalGap = previous.y - line.y;
              const isIndentedBodyLine = line.x > bodyLeft + 8 && !startsDialogueLine(line.text);
              const startsNewParagraph =
                (lineGap > 0 && verticalGap > lineGap * 1.35) ||
                (endsWithTerminalPunctuation(previous.text) && (isIndentedBodyLine || startsParagraphTransitionLine(line.text)));
              if (startsNewParagraph && formattedLines.length > 0 && formattedLines[formattedLines.length - 1] !== '') formattedLines.push('');
            }
            formattedLines.push('\u00a0'.repeat(4 * indentDepthFor(line.x)) + line.text);
          });
          for (let i = 0; i < formattedLines.length - 1; i++) {
            // Join a hyphenated wrap ("supervi‐" / "sors, 316"): the entry hangs its continuation on the
            // next line. Match ASCII '-' AND the Unicode hyphens the typesetter may use (U+2010 ‐,
            // U+2011 ‑, U+00AD soft hyphen); the continuation carries a leading NBSP indent, so skip it
            // before the lowercase test.
            if (/[A-Za-z][-‐‑­]$/.test(formattedLines[i]) && formattedLines[i + 1] && /^ *[a-z]/.test(formattedLines[i + 1])) {
              formattedLines[i] = formattedLines[i].replace(/[-‐‑­]$/, '') + formattedLines.splice(i + 1, 1)[0].replace(/^ +/, '');
              i--;
            }
          }
          // Mark a genuinely TWO-COLUMN list page (band reflow assigned right-column cells → col 1) with
          // a leading U+E017 sentinel so the reader shows two side-by-side columns ONLY for these; a
          // single-column index/TOC (no col-1 lines: Sovereign, Elon Musk) has no sentinel → one column.
          const isTwoColumnListPage = pageTwoColumn;
          const pageText = (isTwoColumnListPage ? '\uE017' : '') + formattedLines.join('\n').replace(/^[ \t\r\n]+/u, '').replace(/[ \t\r\n]+$/u, '');
          // A list page is never a seam-join candidate (its entries are their own lines).
          pageEmit.push({ pageNum, blocks: pageText ? [{ text: pageText, role: 'list', firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '' }] : [], rightMargin, bodyLeft, paraLeftMargin });
          continue;
        }

        // A right-aligned or centred display block (a title page, an "also by" list, a
        // dedication, an epigraph) is not prose: its lines share a right edge (right-aligned)
        // or a centre (centred) while their LEFT edges vary widely — the opposite of prose,
        // whose lines share the left margin. Emit one item per line, tagged with its
        // alignment via a private-use sentinel the reader strips, so the layout is preserved
        // instead of reflowing into a run-on paragraph. (Left-aligned prose and justified
        // prose both have near-constant left edges, so neither can trigger this.)
        const dispLines = lines.filter(line => line.text.replace(/[*_~]/gu, '').trim());
        if (dispLines.length >= 3) {
          const span = (a: number[]): number => (a.length ? Math.max(...a) - Math.min(...a) : 0);
          const tol = Math.max(6, bodyFont);
          // Alignment is a property of the BODY lines. A centred page heading ("Praise for …")
          // sitting above flush-right body prose has a right edge SHORT of the body's right
          // margin, so including it inflated the right-edge span and defeated the right-aligned
          // detection — the page fell through to the prose splitter, which then mis-split a
          // two-sentence flush-right quote at its internal period (the second sentence's line
          // starts well right of the margin and reads as a first-line indent). Classify from the
          // non-heading lines when there are enough of them; keep the legacy whole-page basis for
          // short display pages (title/dedication/epigraph) so their emission is byte-unchanged.
          const dispBody = dispLines.filter(line => !isHeadingLine(line));
          const useBody = dispBody.length >= 3;
          const alignSrc = useBody ? dispBody : dispLines;
          const leftVaries = span(alignSrc.map(l => l.x)) > bodyFont * 2;
          const rightSpan = span(alignSrc.map(l => l.rightX));
          const centreSpan = span(alignSrc.map(l => (l.x + l.rightX) / 2));
          const align: 'right' | 'center' | null =
            leftVaries && rightSpan <= tol ? 'right'
              : leftVaries && rightSpan > tol && centreSpan <= tol ? 'center'
                : null;
          if (align) {
            const sentinel = align === 'right' ? '\uE011' : '\uE010'; // U+E011 right, U+E010 centre — stripped by the reader
            // A right- OR centre-aligned block can be WRAPPED PROSE (a "Praise for…" page: multi-line
            // quotes set flush-right; a centred promo/notice paragraph like Sovereign p3 "Get a FREE
            // ebook … terms and conditions.") rather than a line-list. Emitting one item per line then
            // shatters the paragraph into its physical source lines (each separately centred/flush-right).
            // If the lines are long (fill most of the measure — i.e. they WRAPPED at the margin), JOIN
            // them into paragraphs (breaking on a larger vertical gap or a credit dash). A genuine
            // line-list — a title page, a centred epigraph/poem, an "also by" list — has SHORT lines
            // (distinct phrases, not wrapped), so median width < 55% of the measure keeps it one-per-line.
            const measure = Math.max(...alignSrc.map(l => l.rightX)) - Math.min(...alignSrc.map(l => l.x));
            // Wrapped prose is TIGHTLY spaced (line gap ≈ 1.2x the line height — the natural leading); a
            // line-LIST (an "Also by" title list, a poem) is spaced WIDER (each entry on its own line, ~1.85x
            // here). Long lines alone mislabelled the "Also by" list as prose (its book titles fill ~71% of
            // the measure > the 55% bar) and JOINED them into run-on paragraphs. Require tight spacing too, so
            // a wide-spaced list stays one-item-per-line even when its lines are long.
            // Measure spacing per CONSECUTIVE PAIR (gap ÷ the pair's taller line height), then take the
            // MEDIAN of those ratios — robust to a mixed-height page (Sovereign p3: a big-font centred head
            // over small-font promo prose) where median-gap ÷ median-height is skewed. Prose pairs sit ~1.2-
            // 1.35x; the "Also by" list is ~1.85x. Default to tight (prose) when unmeasurable, so a page whose
            // spacing can't be read keeps the prior join behaviour.
            const _dispRatios: number[] = [];
            for (let _i = 1; _i < alignSrc.length; _i++) { const _g = alignSrc[_i - 1].y - alignSrc[_i].y; const _hh = Math.max(alignSrc[_i].h, alignSrc[_i - 1].h) || bodyFont; if (_g > 0 && _g < _hh * 5) _dispRatios.push(_g / _hh); }
            const _tightlySpaced = (median(_dispRatios) || 1.2) < 1.5;
            const proseLike = (align === 'right' || align === 'center') && measure > 0 && _tightlySpaced && (median(alignSrc.map(l => l.rightX - l.x)) || 0) > measure * 0.55;
            // Turn a contiguous run of display lines into blocks: JOIN wrapped prose into paragraphs
            // (breaking on a larger vertical gap or a leading credit dash) when proseLike, else one
            // item per line (a genuine line-list).
            const bodyToBlocks = (src: PdfLine[]): EmitBlock[] => {
              if (!src.length) return [];
              if (proseLike) {
                const gaps = src.slice(1).map((l, i) => src[i].y - l.y).filter(g => g > 0 && g < bodyFont * 4);
                const medGap = median(gaps) || bodyFont;
                // Break a paragraph on a larger vertical gap OR before a line that opens with an em/en
                // dash — the reliable "attribution/credit" marker — so a quote and its "—Name, title"
                // become separate right-aligned paragraphs (the credit gap is only slightly wider than
                // the line gap, so the dash carries the split).
                const opensCredit = (t: string): boolean => /^\s*(?:[*_~`]+\s*)?[—–]/u.test(t); // skip a leading italic/bold marker: an italic credit is "*—Name*"
                const groups: PdfLine[][] = [];
                let cur: PdfLine[] = [];
                for (let i = 0; i < src.length; i++) {
                  const gap = i > 0 ? src[i - 1].y - src[i].y : 0;
                  if (i > 0 && cur.length && (gap > medGap * 1.4 || opensCredit(src[i].text))) { groups.push(cur); cur = []; }
                  cur.push(src[i]);
                }
                if (cur.length) groups.push(cur);
                // topY (top-most source-line Y of the group) so a figure injected into a display page lands
                // at its real vertical position among these blocks — else, with no topY, the yTop insertion
                // defaults to index 0 (page top) and the figure is stranded ABOVE the heading, on the wrong
                // side of the chapter boundary (BHI "Breakthrough #2" brain art). Only heading blocks' topY
                // is read downstream, so tagging body/list blocks is inert except for figure placement.
                return groups.map(g => {
                  let t = g[0].text;
                  for (let k = 1; k < g.length; k++) t = /[A-Za-z]-$/.test(t) && /^[a-z]/.test(g[k].text) ? t + g[k].text : `${t} ${g[k].text}`;
                  return { text: sentinel + t.replace(/\s+/gu, ' ').trim(), role: 'body' as const, firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '', topY: Math.max(...g.map(l => l.pageY)) };
                });
              }
              return src.map(line => ({ text: sentinel + line.text.replace(/\s+/gu, ' ').trim(), role: 'list' as const, firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '', topY: line.pageY }));
            };
            let outBlocks: EmitBlock[];
            if (useBody) {
              // Classified from the body: walk the display lines in reading order, emit each maximal run
              // of consecutive HEADING lines as one heading block and each run of body lines through
              // bodyToBlocks. A display page's alignment (centre/right) is a property of ALL its lines,
              // the heading included — but the reader renders a heading flush-left unless it carries an
              // align sentinel. So a centred promo/title heading (Sovereign p3 "Thank you for downloading
              // / this Simon & Schuster / ebook.") lost its centring AND, emitted one-per-line, split into
              // three separate blocks. Join a tight run of heading lines into ONE block and tag it with
              // the page's alignment sentinel when the heading itself shares that alignment (its centre or
              // right edge matches the body's). A heading that doesn't match the page alignment, or a
              // ragged page (align null), stays flush-left as before.
              outBlocks = [];
              let run: PdfLine[] = [];
              let hrun: PdfLine[] = [];
              const flushRun = () => { if (run.length) { outBlocks.push(...bodyToBlocks(run)); run = []; } };
              const bodyCentre = median(alignSrc.map(l => (l.x + l.rightX) / 2));
              const bodyRight = median(alignSrc.map(l => l.rightX));
              const flushHead = () => {
                if (!hrun.length) return;
                let t = hrun[0].text;
                for (let k = 1; k < hrun.length; k++) t = /[A-Za-z]-$/.test(t) && /^[a-z]/.test(hrun[k].text) ? t + hrun[k].text : `${t} ${hrun[k].text}`;
                // A heading the source sets WHOLLY ITALIC (Sovereign's sub-section titles are EBGaramond-
                // BoldItalic — every glyph italic, so the line builder wrapped each run in `*…*`) would lose
                // that when the markers are stripped below (headings are styled as a whole, like the EPUB
                // path). Detect it from the emphasis markers — at least one italic run, no bold `**`, and NO
                // letters left OUTSIDE the italic runs — and emit the U+E026 whole-paragraph-italic sentinel so
                // the reader renders it italic (its own font-bold + fontStyle:italic = bold italic). Mirrors
                // processEpub's wholly-italic <h*> detection; PDF glyph italic comes from the real font name.
                const _hItalicMark = /\*[^*]+\*/u.test(t) && !/\*\*/u.test(t) && !/[A-Za-zÀ-ɏ]/u.test(t.replace(/\*[^*]*\*/gu, '')) ? String.fromCharCode(0xE026) : '';
                t = t.replace(/[*_~]/gu, '').replace(/\s+/gu, ' ').trim();
                const hCentre = (Math.min(...hrun.map(l => l.x)) + Math.max(...hrun.map(l => l.rightX))) / 2;
                const hRight = Math.max(...hrun.map(l => l.rightX));
                const headSentinel = align === 'center' && Math.abs(hCentre - bodyCentre) <= tol ? ''
                  : align === 'right' && Math.abs(hRight - bodyRight) <= tol ? '' : '';
                if (t) outBlocks.push({ text: _hItalicMark + headSentinel + t, role: 'heading', firstX: Math.min(...hrun.map(l => l.x)), firstRightX: hrun[0].rightX, lastRightX: hrun[hrun.length - 1].rightX, lastText: hrun[hrun.length - 1].text, topY: Math.max(...hrun.map(l => l.pageY)) });
                hrun = [];
              };
              for (const line of dispLines) {
                if (isHeadingLine(line)) {
                  flushRun();
                  // A larger vertical gap ends the heading run (a title above a distinct subtitle/author).
                  if (hrun.length && (hrun[hrun.length - 1].y - line.y) > Math.max(hrun[hrun.length - 1].h, line.h) * 1.35) flushHead();
                  hrun.push(line);
                } else {
                  flushHead();
                  run.push(line);
                }
              }
              flushRun();
              flushHead();
            } else {
              outBlocks = bodyToBlocks(dispLines);
            }
            // A DISPLAY page (centred/right — e.g. a Part-divider: centred heading + centred figure caption)
            // can carry a figure too (the brain illustration on BHI's "Breakthrough #2" page). The prose
            // branch injects figures by top-Y below (~5455), but this branch `continue`s before reaching it,
            // so the captured [[FIG]] marker was dropped and the image vanished. Inject here as well: the
            // heading block carries topY, the caption blocks don't (→ -Infinity), so the figure splices in
            // right after the heading and before the caption — matching its physical place on the page.
            const _dispFigs = figuresByPage.get(pageNum);
            if (_dispFigs) for (const f of _dispFigs) {
              const fb: EmitBlock = { text: `[[FIG ${f.id}]]`, role: 'body', firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '', topY: f.yTop, bodyX: bodyLeft };
              let at = outBlocks.findIndex(b => (b.topY ?? -Infinity) < f.yTop);
              if (at < 0) at = outBlocks.length;
              outBlocks.splice(at, 0, fb);
            }
            pageEmit.push({ pageNum, blocks: outBlocks, rightMargin, bodyLeft, paraLeftMargin });
            continue;
          }
        }

        // Prose page: paragraph spacing comes from the BODY lines only (a chapter-start
        // page's page-wide gap is skewed by large heading leading). Walk the lines,
        // gathering a run of one kind, then join it into a single block.
        const bodyLines = lines.filter(line => !isHeadingLine(line));
        const bodyGaps = bodyLines.slice(1).map((line, index) => bodyLines[index].y - line.y).filter(gap => gap > 0 && gap < bodyFont * 3);
        const bodyLineGap = median(bodyGaps) || lineGap;

        // isShortDataLine's "measure" (the page's text width) is DOCUMENT-wide, but on a two-column
        // page a column line spans only its column — so every left/right-column line reads as "short"
        // and bothShort shatters a wrapped bullet/paragraph into one block per line (the back-cover
        // "what you'll learn" bullets split at their wrap: "…agentic mesh" | "and its transformative
        // potential"). For lines the band detector assigned to a column, measure against that COLUMN's
        // own left/right edges instead. col===undefined (single-column) keeps the page-wide measure,
        // so nothing outside a detected two-column band changes.
        const colBounds = new Map<0 | 1, { left: number; right: number }>();
        for (const c of [0, 1] as const) {
          const cl = bodyLines.filter(l => l.col === c && l.text.trim());
          if (cl.length < 3) continue; // a real column, not a stray line the sort tagged
          const rs = cl.map(l => l.rightX).sort((a, b) => a - b);
          const ls = cl.map(l => l.x).sort((a, b) => a - b);
          colBounds.set(c, { left: ls[Math.floor(ls.length * 0.1)], right: rs[Math.floor(rs.length * 0.9)] });
        }
        const isShortColLine = (line: PdfLine): boolean => {
          const b = line.col !== undefined ? colBounds.get(line.col) : undefined;
          // For a single-column line, measure against the DOC body margin, not the per-page bodyLeft: on a
          // sparse figure page (a Part-divider) the only body text is the inset caption/credit, so the page
          // bodyLeft is measured as THEIR indent (BHI Bk#2 fig_35: bodyLeft≈226 vs the true margin ~77). That
          // shrank the measure so an identical-width caption (148.5pt) read as NOT short and merged with its
          // credit — while Bk#1 (caption at 169) stayed short and split. `min` only widens a skewed-high page;
          // a normal page has bodyLeft≈docBodyLeft (unchanged), and a full block-indented line still isn't short.
          const left = b ? b.left : Math.min(bodyLeft, docBodyLeft);
          const right = b ? b.right : bodyRightEdge;
          const measure = right - left;
          return measure > 0 && (line.rightX - line.x) < measure * 0.5;
        };

        // A LABELED HANGING-INDENT list — a dialogue ("CASSANDRA: …" / "RAY: …"), a CIP/cataloging
        // block ("Names: …" / "Title: …"), a glossary: each entry starts at the body margin and its
        // wrapped lines indent to ONE consistent deeper tier. The splitter merges these (a new
        // entry is OUTDENTED, not indented, so it reads as a prose continuation). Detect from the
        // geometry, but require a discriminator prose lacks — most entry lines begin with a short
        // "Label:" (a name/field + colon). v26 used the bare two-tier geometry alone and over-fired
        // book-wide; the label requirement plus ≥3 entries keeps this to genuine labeled lists.
        const labelStart = /^["'“]?[A-Z][^:]{0,24}:(?:\s|$)/u;
        const detectLabeledHangingList = (group: PdfLine[]): boolean => {
          if (group.length < 4) return false;
          const tol = 4;
          // Anchor the entry margin on the group's OWN leftmost tier, not the page's most-frequent
          // left (bodyLeft): in a hanging list the indented continuation lines can OUTNUMBER the
          // entry lines (the Ch 8 dialogue has more wrapped continuations than speaker turns), so
          // mostFrequentLeft picks the CONTINUATION tier and every line reads as "margin", breaking
          // detection. The group's min x is the entry tier (the outdented label/turn start).
          const groupLeft = Math.min(...group.map(l => l.x));
          const margin = group.filter(l => l.x <= groupLeft + tol);
          const indented = group.filter(l => l.x > groupLeft + tol);
          if (margin.length < 3 || indented.length < 1) return false;
          const indentXs = indented.map(l => l.x);
          if (Math.max(...indentXs) - Math.min(...indentXs) > tol * 2) return false; // one consistent tier
          const delta = Math.min(...indentXs) - groupLeft;
          if (delta < 6 || delta > bodyFont * 5) return false;
          for (let k = 0; k < group.length; k++) {
            if (group[k].x > groupLeft + tol) {
              const prev = group[k - 1];
              // An indented line must CONTINUE the line above it, not start a new first-line-indent
              // paragraph. Reject ONLY when the line above is a MARGIN line that ENDED (terminal
              // punctuation) — a genuine paragraph break that would make this a first-line indent.
              // Two cases that ARE still continuations and must NOT bail (they made the detector
              // miss whole dialogue pages): (a) a leading indented line with no prev — a turn that
              // WRAPPED across the previous PAGE break; (b) an indented line after another indented
              // line that ended a sentence mid-entry — a long turn whose wrap fell on a period.
              if (prev && prev.x <= groupLeft + tol && endsWithTerminalPunctuation(prev.text)) return false;
            }
          }
          // Strip emphasis markup before the label test: a BOLD speaker label extracts as
          // "**CASSANDRA: …**" (the dialogue is set bold), and the leading "**" trips labelStart's
          // first-character anchor, so every turn missed and the dialogue emitted as one block.
          const labeled = margin.filter(l => labelStart.test(l.text.replace(/[*_~]/gu, '').trim())).length;
          // A labeled hanging list has SHORT entries (a name/field + a turn/value). When the indented lines
          // vastly outnumber the labels, each "entry" is really a TITLE followed by a multi-line block
          // paragraph — a definition list (Agentic Mesh "Layer N: …" + its description, ind/label ≈ 3.7–5.5),
          // NOT a hanging list (dialogue ≈ 1.3, CIP ≈ 1–2 measured). Excluding it lets the group loop's
          // justified block-split separate the flush term from its indented description instead of joining them.
          if (indented.length > margin.length * 3) {
            // ...UNLESS it's a long-turn DIALOGUE: its label (margin) lines are long speaker TURNS that FILL
            // the measure (Ch.8 CASSANDRA/RAY wraps ~4-5 lines per turn → ratio ≈4.5, all turn-opening lines
            // reach the right margin), whereas a definition list's label is a SHORT FLUSH TERM ("Layer N:")
            // that stops well short. So only treat a high-ratio labeled run as a NON-hanging (definition)
            // block when its labels DON'T fill the measure — otherwise a wordy dialogue fell to the prose
            // path and merged a turn whose last line happened to fill ("…give us meaning? RAY: Well…").
            const labelsFill = rightMargin > 0 ? margin.filter(l => l.rightX >= rightMargin - bodyFont * 1.5).length : 0;
            if (labelsFill < Math.max(2, margin.length / 2)) return false;
          }
          return labeled >= 2 && labeled >= margin.length / 2;
        };

        // A bullet-list item ("• Prompt chaining …") starts a new paragraph — otherwise the items
        // (and their wrapped descriptions) reflow into one run-on block. The lone-bullet de-dup
        // upstream guarantees a single leading bullet per item.
        // A bullet is often BOLD, so the line arrives wrapped as "**•** …"; skip a leading emphasis
        // wrapper (and the bullet may glue to the word, "•Understand") before matching the marker.
        const startsBulletLine = (t: string): boolean => /^\s*(?:[*_~`]+\s*)?[•‣▪●◦⁃∙○■]/u.test(t);
        const blocks: EmitBlock[] = [];
        // Emit a labeled hanging-indent list (dialogue speaker turns, CIP fields, a glossary) as ONE
        // body block per entry — a margin (outdent-tier) line plus its indented continuations, joined
        // with NO block-indent NBSP so a wrapped turn stays whole and no stray indent leaks mid-text.
        // A genuine entry (opens with its own label at the outdent tier) is tagged U+E01A + an NBSP run
        // encoding the source's outdent→continuation gap (the same NBSP→padding scale the reader uses for
        // block indents), so the reader HANGS the label: first line at the outdent, wraps at the indent
        // tier. Only entries from this REGION-gated path are tagged (not arbitrary "Label:" prose). An
        // entry that opens at the indent tier (its label is on the PREVIOUS page) is flagged carryover —
        // it renders flush and the read-time page-seam merge reunites it with its opener.
        const emitHangingEntries = (group: PdfLine[]): void => {
          const groupLeft = Math.min(...group.map(l => l.x));
          const deepXs = group.filter(l => l.x > groupLeft + 4).map(l => l.x);
          const indentDelta = deepXs.length ? Math.min(...deepXs) - groupLeft : 0;
          const hangNbsp = bodyFont > 0 && indentDelta > bodyFont * 0.9 ? Math.min(12, Math.max(4, Math.round((indentDelta / bodyFont) / 1.5 * 4))) : 0;
          let entry: PdfLine[] = [];
          const flushEntry = () => {
            if (!entry.length) return;
            let etext = entry[0].text;
            for (let k = 1; k < entry.length; k++) {
              etext = /[A-Za-z]-$/.test(etext) && /^[a-z]/.test(entry[k].text) ? etext + entry[k].text : `${etext} ${entry[k].text}`;
            }
            etext = etext.replace(/\s+/g, ' ').trim();
            if (etext) {
              const last = entry[entry.length - 1];
              const carryover = entry[0].x > groupLeft + 4;
              const hang = !carryover && hangNbsp > 0 ? '' + ' '.repeat(hangNbsp) : '';
              // Carry the same relative FONT-SIZE tier the prose path applies (sizeSentinel below), so a
              // small-print hanging list — the copyright page's CIP block — matches the size of the
              // surrounding fine print instead of reverting to the default body size.
              const entryH = mode(entry.map(l => Math.round(l.h))) || bodyFont;
              const hangSizeRatio = bodyFont > 0 ? entryH / bodyFont : 1;
              const hangSizeSentinel = hangSizeRatio >= 1.6 ? '' : hangSizeRatio >= 1.25 ? '' : hangSizeRatio > 1.08 ? ''
                : hangSizeRatio < 0.80 ? '' : hangSizeRatio < 0.90 ? '' : '';
              blocks.push({ text: hangSizeSentinel + hang + etext, role: 'body', firstX: entry[0].x, firstRightX: entry[0].rightX, lastRightX: last.rightX, lastText: last.text, carryover, topY: Math.max(...entry.map(l => l.pageY)), bodyX: mode((entry.length > 1 ? entry.slice(1) : entry).map(l => Math.round(l.x))) });
            }
            entry = [];
          };
          for (const line of group) {
            if (line.x <= groupLeft + 4 && entry.length) flushEntry();
            entry.push(line);
          }
          flushEntry();
        };
        // A hanging-list region (a run of dialogue turns / CIP fields) must be kept INTACT as one group
        // so emitHangingEntries splits it per-entry on the LABEL. Otherwise the justified short-line /
        // terminal-indent rules fragment a turn whose continuation sits at the indent tier — that tier
        // reads as a first-line indent against the label margin (Ch 8 "…give us meaning? RAY: Well…"
        // merge, and "…early 2030s. / So the in-between…" truncation). Given a start index, extend the
        // maximal same-column, not-physically-far, non-heading run and return its end IFF that run is a
        // labeled hanging list (detectLabeledHangingList) — the same proven gate, just fed the whole run.
        const hangingRegionEnd = (start: number): number => {
          if (isHeadingLine(lines[start])) return start - 1;
          // A leading NON-LABEL line set off by a LARGER gap above the labeled list is the list's HEADER
          // (e.g. "LIBRARY OF CONGRESS CATALOGING-IN-PUBLICATION DATA" above the CIP fields), not an entry.
          // Absorbing it made it a hanging entry (run-on) instead of a standalone line the reader could set
          // off. Leave it out: return start-1 so it emits on its own, and the region re-detects from start+1.
          if (start + 2 < lines.length
            && !labelStart.test(lines[start].text.replace(/[*_~]/gu, '').trim())
            && labelStart.test(lines[start + 1].text.replace(/[*_~]/gu, '').trim())) {
            const gapHead = lines[start].y - lines[start + 1].y;
            const gapNext = lines[start + 1].y - lines[start + 2].y;
            if (gapNext > 0 && gapHead > gapNext * 1.3) {
              return start - 1;
            }
          }
          let end = start;
          while (end + 1 < lines.length) {
            const a = lines[end], b = lines[end + 1];
            if (isHeadingLine(b)) break;
            if (a.col !== b.col) break;
            if (Math.abs(a.pageY - b.pageY) > Math.max(a.h, b.h) * 3) break; // physically far / column jump
            end++;
          }
          if (end - start + 1 < 4) return start - 1;
          // The region must OPEN with a genuine entry: a labeled line ("Label:") or an indented continuation
          // (a turn wrapped from the previous page). A NON-labeled MARGIN line at the start is INTRO PROSE
          // preceding the list — the labeled entries below outvote it in detectLabeledHangingList, so it'd be
          // swept in as a hanging entry (Agentic Mesh: "Here are the seven layers…" before "Layer 1:…").
          // Leave it out; the main loop advances and re-detects the region from the first real entry.
          const _regLeft = Math.min(...lines.slice(start, end + 1).map(l => l.x));
          if (lines[start].x <= _regLeft + 4 && !labelStart.test(lines[start].text.replace(/[*_~]/gu, '').trim())) return start - 1;
          return detectLabeledHangingList(lines.slice(start, end + 1)) ? end : start - 1;
        };
        // VERSE/POEM run: a stanza of tight SHORT italic lines (Clough's "Say not, the struggle…") — every
        // line is FULLY ITALIC, ends well short of the right margin, and shares a left edge. That's unlike
        // prose (lines fill the measure) or an italic block-quote (which WRAPS to full lines), so a run of
        // >=3 such lines is verse: emit each STANZA (a sub-run at the normal line gap; a larger gap starts a
        // new stanza) as one block whose lines join with U+E024 — the reader renders tight <br> verse lines
        // with a stanza gap (para.verse), the same path the EPUB uses.
        const isVerseLine = (l: PdfLine): boolean => rightMargin > 0 && /^\s*\*[^*]+\*\s*$/.test(l.text) && l.rightX < rightMargin - bodyFont * 4;
        const verseRegionEnd = (start: number): number => {
          if (isHeadingLine(lines[start]) || !isVerseLine(lines[start])) return start - 1;
          const x0 = lines[start].x; let end = start;
          while (end + 1 < lines.length) {
            const b = lines[end + 1];
            if (isHeadingLine(b) || !isVerseLine(b) || Math.abs(b.x - x0) > bodyFont * 1.5) break;
            if (Math.abs(lines[end].pageY - b.pageY) > Math.max(lines[end].h, b.h) * 3) break;
            end++;
          }
          return end - start + 1 >= 3 ? end : start - 1;
        };
        const emitVerseLines = (group: PdfLine[]): void => {
          const VLB = String.fromCharCode(0xE024);
          const gaps = group.slice(1).map((l, k) => group[k].y - l.y).filter(g => g > 0).sort((a, b) => a - b);
          const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : bodyFont * 1.3;
          const stanzas: PdfLine[][] = []; let cur: PdfLine[] = [group[0]];
          for (let k = 1; k < group.length; k++) {
            if (group[k - 1].y - group[k].y > medGap * 1.5) { stanzas.push(cur); cur = []; }
            cur.push(group[k]);
          }
          if (cur.length) stanzas.push(cur);
          for (const st of stanzas) {
            const sizeR = bodyFont > 0 ? (mode(st.map(l => Math.round(l.h))) || bodyFont) / bodyFont : 1;
            const tier = sizeR <= 0.80 ? String.fromCharCode(0xE01B) : sizeR < 0.90 ? String.fromCharCode(0xE01C) : '';
            const last = st[st.length - 1];
            blocks.push({ text: tier + st.map(l => l.text.trim()).join(VLB), role: 'body', firstX: st[0].x, firstRightX: st[0].rightX, lastRightX: last.rightX, lastText: last.text, topY: Math.max(...st.map(l => l.pageY)), bodyX: st[0].x });
          }
        };
        // DATA COLUMN: a chart's "YYYY: value" table (Kurzweil income/poverty charts — "2020: $191.00",
        // "1950: ~30%"), a run of >=3 tight roman lines sharing a left edge, each a bare year label + a
        // currency/percent/number value. Like verse it must render TIGHT (one entry per line, NO blank line
        // between), else the prose grouping's `bothShort` splits every short data line into its own paragraph
        // → blank-line-spaced. Emit the run as ONE block joined with U+E024 (the same tight-<br> path verse
        // uses) so the reader renders a compact left-aligned roman column. The pattern is the exact one
        // endsWithPageRef excludes from the index test, so prose / notes ("129. …") / real index entries
        // ("Topic, 316") never match (value must be purely numeric — a "2020: Smith, J." bibliography line has
        // letters and is left alone).
        const isDataColumnLine = (l: PdfLine): boolean =>
          /^\s*\d{4}:\s*[~<>≈]?\$?[\d.,]+%?\s*$/u.test(l.text.replace(/[*_~`]/gu, '').trim());
        const dataColumnRegionEnd = (start: number): number => {
          if (isHeadingLine(lines[start]) || !isDataColumnLine(lines[start])) return start - 1;
          const x0 = lines[start].x; let end = start;
          while (end + 1 < lines.length) {
            const b = lines[end + 1];
            if (isHeadingLine(b) || !isDataColumnLine(b) || Math.abs(b.x - x0) > bodyFont * 1.5) break;
            if (Math.abs(lines[end].pageY - b.pageY) > Math.max(lines[end].h, b.h) * 3) break;
            end++;
          }
          // >=2 (not 3): the "YYYY: value" pattern is so specific it never fires on prose (swept: only the two
          // Kurzweil chart pages across all test PDFs), and a data column that STRADDLES a PDF page break leaves
          // a short 2-row remnant at the foot of the first page (income: "2020…/2015…" on one page, the rest on
          // the next) — that remnant must render tight too, not as two blank-spaced paragraphs.
          return end - start + 1 >= 2 ? end : start - 1;
        };
        const emitDataColumn = (group: PdfLine[]): void => {
          const VLB = String.fromCharCode(0xE024);
          const last = group[group.length - 1];
          blocks.push({ text: group.map(l => l.text.trim()).join(VLB), role: 'body', firstX: group[0].x, firstRightX: group[0].rightX, lastRightX: last.rightX, lastText: last.text, topY: Math.max(...group.map(l => l.pageY)), bodyX: group[0].x, dataColumn: true });
        };
        let i = 0;
        // Tracks whether the group emitted just before this one was a right-aligned attribution/credit — so a
        // following flush-right line WITHOUT its own dash (a byline's title line under "— Sean Falconer") is
        // recognised as its right-aligned CONTINUATION rather than falling back to stray left-aligned body.
        let prevWasRightAttribution = false;
        while (i < lines.length) {
          const _prevGroupWasRightAttr = prevWasRightAttribution;
          prevWasRightAttribution = false; // reset each group; the right-attribution path below re-sets it true
          // A VERSE run (tight italic short lines) — consume it before the prose rules mangle it.
          if (!isHeadingLine(lines[i])) {
            const vEnd = verseRegionEnd(i);
            if (vEnd >= i) { emitVerseLines(lines.slice(i, vEnd + 1)); i = vEnd + 1; continue; }
          }
          // A DATA COLUMN run ("YYYY: value" chart table) — consume it tight before bothShort blank-splits it.
          if (!isHeadingLine(lines[i])) {
            const dEnd = dataColumnRegionEnd(i);
            if (dEnd >= i) { emitDataColumn(lines.slice(i, dEnd + 1)); i = dEnd + 1; continue; }
          }
          // Consume a whole hanging-list region up front so it isn't fragmented by the prose rules below.
          if (!isHeadingLine(lines[i])) {
            const hEnd = hangingRegionEnd(i);
            if (hEnd >= i) {
              emitHangingEntries(lines.slice(i, hEnd + 1));
              i = hEnd + 1;
              continue;
            }
          }
          const groupIsHeading = isHeadingLine(lines[i]);
          const group: PdfLine[] = [lines[i]];
          // Gap ABOVE this block (measured): the y-distance from the previous block's last line to this
          // block's first line, on the same page/column. Used to reproduce the source's set-off spacing
          // instead of a fixed constant. (`.y` preserves real single-column gaps; a page break / column
          // change reads ~0 → treated as normal, which is correct for a block at a page/column top.)
          const _prevL = i > 0 ? lines[i - 1] : undefined;
          const gapAbove = (_prevL && _prevL.col === lines[i].col && _prevL.y > lines[i].y) ? (_prevL.y - lines[i].y) : 0;
          let j = i + 1;
          while (j < lines.length && isHeadingLine(lines[j]) === groupIsHeading) {
            const previous = lines[j - 1];
            const current = lines[j];
            const verticalGap = previous.y - current.y;
            // Two lines FAR APART on the physical page never belong to one block, whatever their
            // reading-order y says. This is what separates a left column's last line from the right
            // column's first (the reflow stacks them adjacent in reading order but they sit a full
            // page apart), and keeps spine/edge text from gluing onto a column line it happens to
            // reflow next to. `pageY` is the real position; on single-column pages pageY==y so this
            // only ever fires on a genuine large gap, which already broke the block anyway.
            const physicallyFar = Math.abs(previous.pageY - current.pageY) > Math.max(previous.h, current.h) * 3;
            let endsBlock: boolean;
            if (current.col !== undefined && previous.col !== undefined && current.col !== previous.col) {
              // A block never spans two columns — the left cell and the right cell of a row-major table
              // sit on the same baseline, so a column change is the boundary (physicallyFar can't see it).
              endsBlock = true;
            } else if (physicallyFar) {
              endsBlock = true;
            } else if (groupIsHeading) {
              // Wrapped heading lines join; a gap larger than the heading's own leading
              // separates two stacked headings (a chapter title above its subtitle).
              endsBlock = verticalGap > Math.max(previous.h, current.h) * 1.35;
            } else {
              // An indented line after a completed sentence starts a new paragraph — INCLUDING a
              // dialogue turn (a new "…" quote set at the first-line indent). Dialogue was excluded
              // here, which merged consecutive quoted turns whenever one wrapped to a full line (short
              // turns broke via bothShort, long ones didn't). Measured against paraLeftMargin so the
              // indent is detected even when short turns make the indent the modal left. A wrapped
              // continuation sits at the margin, not the indent, so it is never caught.
              // A first-line indent must be deeper than the PREVIOUS line too, not just the page margin:
              // inside a BLOCK-indented paragraph (a "By domain" explanation at x=90 vs margin 72) every
              // line reads as "indented" against the margin, so a sentence that ends exactly at a line
              // boundary would split the block into two paragraphs. Requiring current deeper than previous
              // keeps a same-tier continuation joined while a genuine new indented opener still splits.
              // A BULLET's first line is OUTDENT to its marker ("• " at x=121) while its wrapped
              // continuation sits at the deeper text tier (x=130). That deeper continuation is NOT a
              // new first-line indent — it's just the bullet's body column — so a bullet whose text
              // fits on ONE line and ends with a period ("• The initial synaptic strengths … of each
              // connection.") must NOT split from its next continuation line ("There are a number of
              // possible ways to do this:"). Skip the indent test when the previous line is a bullet;
              // a real new sub-item after the bullet still breaks via introducesListItem below.
              const isIndentedBodyLine = current.x > paraLeftMargin + 8 && current.x > previous.x + 4
                && !startsBulletLine(previous.text);
              // Two consecutive lines that each occupy less than half the measure are
              // line-structured data (a catalog/CIP block, address, code list), not flowing
              // prose — keep them one per line. Prose has at most one short line per
              // paragraph (the last), so this never splits a paragraph. EXCLUDE a line that opens
              // a labeled entry (a dialogue turn "RAY: Right.", a CIP field): a short labeled
              // opener must not break the block here — it belongs to the labeled hanging list that
              // detectLabeledHangingList re-splits, and breaking before it would fragment the
              // dialogue into pieces too small to detect (a one-word turn beside a short wrapped
              // continuation otherwise tripped bothShort and merged that run into one paragraph).
              // A multi-line RIGHT-ALIGNED signature/credit ("— Sean Falconer" / "Head of AI, Confluent")
              // at the end of prose is DELIBERATELY line-broken display (name / title), not one wrapped run —
              // both lines are short and sit FLUSH-RIGHT, so bothShort SPLITS them one-per-line, faithful to
              // the source. The dash-less title line keeps its right alignment via prevWasRightAttribution
              // (isRightAttribution below tags a flush-right line following a right-attribution), so it no
              // longer falls back to stray left body — which is why the old code had to keep them merged.
              // The opener/continuation may be ITALIC (a set-off credit is often italic) so the text starts
              // with an emphasis marker ("*— Sean Falconer*") — skip a leading */_/~/` run before the dash.
              const flushRightEdge = rightMargin - Math.max(6, bodyFont);
              const opensDash = (t: string): boolean => /^\s*(?:[*_~`]+\s*)?[—–]/u.test(t);
              const attributionContinuation =
                rightMargin > 0 &&
                opensDash(group[0].text) && group[0].rightX >= flushRightEdge &&
                current.rightX >= flushRightEdge && !opensDash(current.text);
              const bothShort = isShortColLine(previous) && isShortColLine(current)
                && !labelStart.test(current.text.replace(/[*_~]/gu, '').trim());
              // JUSTIFIED-TEXT block boundary: in justified prose every line is stretched to the right
              // margin EXCEPT the last line of a block, so a previous line that ends short of the margin
              // (doesn't fill the measure) marks a paragraph/term/heading end and the current line begins
              // a new block. Catches block-paragraph layouts the indent/punctuation rules miss — e.g. a
              // definition list whose flush italic term ("Endpoints") and its indented description are
              // otherwise glued into a run-on. Gated to justified sources so ragged text (short lines
              // everywhere) is untouched; not applied across a same-tier continuation attribution.
              // `previous` ends short (a block boundary) only if it doesn't reach the body margin AND it
              // isn't a line of a JUSTIFIED RUN — ≥3 CONSECUTIVE body lines sharing one right edge. A block
              // justified to a NARROWER right margin than the body (an epigraph, a set-off quote) forms
              // such a run at its shorter edge, so its lines aren't "short" and it reflows whole; a
              // paragraph's/note's LAST line ends short and its full neighbours sit at the body margin (no
              // ≥3 run at that short edge), so it still marks a boundary — notes stay one entry per line.
              let runLen = 1;
              for (let k = j - 2; k >= 0 && !isHeadingLine(lines[k]) && lines[k].rightX > 0 && Math.abs(lines[k].rightX - previous.rightX) <= bodyFont; k--) runLen++;
              for (let k = j; k < lines.length && !isHeadingLine(lines[k]) && lines[k].rightX > 0 && Math.abs(lines[k].rightX - previous.rightX) <= bodyFont; k++) runLen++;
              // A short line only marks a justified paragraph boundary when it actually ENDS the paragraph —
              // i.e. it ends with terminal punctuation. A left-aligned RAGGED block on a justified page (a
              // figure caption / source line / address) wraps MID-PHRASE: its short line ends with no
              // terminal punctuation and the next line continues at the SAME left margin (Singularity p165:
              // "…in the Twentieth" / "Century (Princeton…", both at x=77). Treating that wrap as a boundary
              // shatters the caption one line per paragraph so it can no longer reflow. Suppress prevEndsShort
              // for a same-margin mid-phrase wrap. Prose boundaries are unaffected (a paragraph's last line
              // ends with "." / "?" / "!"); a definition term / note marker boundary changes the left margin
              // (indented description, outdented marker), so it still splits.
              // …unless the current line OPENS a new block itself — a numbered/lettered/IF-THEN list item
              // (MYCIN's conditions end mid-clause with "and", no terminal punctuation, at the same margin,
              // so without this they merge into their neighbour and the rule's list collapses), a bullet, or
              // a footnote entry. Those legitimately begin a new paragraph even after a non-terminal line.
              const currentStartsNewBlock =
                /^(?:IF:|THEN:|\d{1,2}[.)]|(?:[a-z]|[ivxlcdm]{2,7})[.)])(?:\s|$)/u.test(current.text.replace(/^[*_~]+/u, '').trimStart())
                || startsBulletLine(current.text) || startsFootnoteEntry(current);
              const raggedWrapSameMargin =
                !endsWithTerminalPunctuation(previous.text) && Math.abs(current.x - previous.x) <= bodyFont * 0.5
                && !currentStartsNewBlock;
              // A CENTRED multi-line block (an epigraph attribution, a centred title/quote) has each line
              // SYMMETRICALLY inset — it ends short of the right margin BY DESIGN, not as a justified-block
              // boundary. attributionContinuation only covers a RIGHT-aligned (flush-right) attribution; a
              // CENTRED one (BHI "—JEREMY BENTHAM, …MORALS" / "AND LEGISLATION") isn't flush-right, so without
              // this prevEndsShort splits the wrapped centred attribution into two paragraphs (blank line
              // between) on a page whose BODY is justified. Justified prose lines start at the margin
              // (leftInset≈0) → not centred, so this can't suppress a real justified-block boundary.
              const _isCentred = (l: PdfLine): boolean => {
                const li = l.x - docBodyLeft, ri = bodyRightEdge - l.rightX;
                return bodyRightEdge > docBodyLeft && li > bodyFont && ri > bodyFont
                  && Math.abs(li - ri) <= bodyFont && Math.abs((l.x + l.rightX) / 2 - (docBodyLeft + bodyRightEdge) / 2) <= bodyFont;
              };
              const centredWrap = _isCentred(previous) && _isCentred(current);
              const prevEndsShort = pageJustified && rightMargin > 0
                && !fillsMeasure(previous.rightX, rightMargin) && runLen < 3 && !attributionContinuation
                && !raggedWrapSameMargin && !centredWrap;
              // A FLUSH labeled list — consecutive lines that BOTH open with a short "Label:" (an email
              // header From:/Date:/To:/Subject:, an address, a spec sheet) — has each entry as its own
              // line, but with no hanging indent detectLabeledHangingList misses it and the splitter
              // merges them into a run-on. Requiring BOTH neighbours to be labels keeps prose (a lone
              // "Note: …" mid-paragraph has no label line before it) from splitting. Validated: 3 splits
              // on the Elon email header, 0 on Elon/Kurzweil prose pages.
              // A REAL header field ("From:", "Date:", "Subject:", "Reply-To:") is a simple capitalised
              // word or two before the colon — no internal punctuation. A figure caption ("Century
              // (Princeton, NJ: Princeton University Press…") also carries an early colon but is prose with
              // parentheses/commas, so the loose labelStart wrongly paired it with the "Principal sources:"
              // line above and split the caption there. Require a CLEAN field name (letters/spaces/hyphens
              // only) for the labelPair split so email headers still separate but a caption stays whole.
              const isFieldLabel = (t: string): boolean =>
                /^["'“]?[A-Z][A-Za-z][A-Za-z \-]{0,22}:(?:\s|$)/u.test(t.replace(/[*_~]/gu, '').trimStart());
              const labelPair = isFieldLabel(previous.text) && isFieldLabel(current.text);
              // (A genuine multi-turn dialogue / CIP is now consumed whole by hangingRegionEnd above and
              // split per-entry by emitHangingEntries; a single-group hanging list still routes through the
              // inline detectLabeledHangingList fallback below. An earlier per-line "label at the outdent
              // tier" break was removed — it false-fired on a wrapped person's name in prose ("…engineer
              // Daniel Feldman:"), the classic v26 over-fire; the region gate is the safe, label-checked path.)
              // A numbered/lettered/IF-THEN list item DOES open a new paragraph after a completed
              // sentence even at the SAME tier as the previous item — the isIndentedBodyLine "deeper than
              // previous" guard would otherwise merge consecutive items (MYCIN "1.…" / "2.…" at x=133).
              const currentOpensListMarker = /^(?:IF:|THEN:|\d{1,2}[.)]|(?:[a-z]|[ivxlcdm]{2,7})[.)])(?:\s|$)/u.test(current.text.replace(/^[*_~]+/u, '').trimStart());
              // The PREVIOUS line also opens with a list marker at (about) the same tier: two adjacent
              // marker lines are consecutive list items, so the current one starts a new item EVEN WHEN the
              // previous item ended with no terminal punctuation (Agentic Mesh p65: "…verified" / "2. Confirm
              // …" — the items carry no full stops, and on this un-justified page prevEndsShort can't split
              // them either, so without this every item after the first merges into item 1).
              const previousOpensListMarker = /^(?:IF:|THEN:|\d{1,2}[.)]|(?:[a-z]|[ivxlcdm]{2,7})[.)])(?:\s|$)/u.test(previous.text.replace(/^[*_~]+/u, '').trimStart());
              const consecutiveListItems = currentOpensListMarker && previousOpensListMarker && Math.abs(current.x - previous.x) < bodyFont;
              // A FONT-SIZE change is a block boundary: a differently-sized line belongs to a different
              // structural element (a figure TITLE above its subtitle, a subhead above body). Without this
              // the group loop merges them, and the per-block size tier washes out to the mode (Singularity
              // p14: title h=21 + subtitle h=15 grouped → mode 15 → the title lost its heading size and the
              // two ran together). EXCEPT a decorative DROP CAP — a very large (≥2.2× body) 1–2 char initial
              // that leads a body paragraph — must stay WITH its paragraph, not split into a standalone giant
              // letter; a real display heading is longer than 2 chars, so the length gate separates them.
              const isDropInitial = (l: PdfLine): boolean =>
                bodyFont > 0 && l.h >= bodyFont * 2.2 && l.text.replace(/[*_~`\s]/gu, '').length <= 2;
              // Compare CAP heights, not the char-weighted `h`: a SMALL-CAPS line ("…the MIDDLE AGES.")
              // has a small `h` (its small caps sit at a reduced em) but its CAPS are body-sized, so it is
              // NOT a real size change — comparing `h` wrongly split it into its own block (→ a shrink tier +
              // reader bolding). A genuine sub-head/caption differs in CAP height too, so it still splits.
              const _chOf = (l: PdfLine) => l.capH ?? l.h;
              const _sizeT = Math.max(2, bodyFont * 0.18);
              // Require BOTH the cap height AND the char-weighted (dominant) height to change. A real size
              // change moves the DOMINANT height of a line; a mere CAPS-PRESENCE difference moves only capH.
              // A wrapped SMALL-CAPS title ("AVERAGE DAILY INCOME … (2023" then "dollars), by year") is set
              // in synthesised small caps — source-UPPERCASE letters draw at the full em (15) and source-
              // lowercase at a reduced em (10.5). Line 1 happens to contain capitals (A, U.S.) so its capH
              // reads 15; the all-lowercase continuation has none, so its capH reads 10.5 — a phantom size
              // drop that capH-alone split, then shrank line 2 (capRatio < 0.92). Both lines' DOMINANT height
              // is 10.5, so requiring l.h to differ too keeps the wrap together. A genuine sub-head/caption
              // differs in dominant height as well (and a short heading is already cut by prevEndsShort), so
              // this only suppresses the phantom small-caps split.
              const sizeChanged = bodyFont > 0 && Math.abs(_chOf(current) - _chOf(group[0])) >= _sizeT
                && Math.abs(current.h - group[0].h) >= _sizeT
                && !isDropInitial(current) && !isDropInitial(group[0]);
              // A list marker (numbered/lettered/roman/IF-THEN) always opens a new list item — after a
              // line that ENDED a sentence OR INTRODUCED the list with a trailing colon ("The output,
              // which can be:" → "i. …"; "There are a number of possible ways to do this:" → "i. …").
              // Kept separate from the terminal-punctuation indent rule because endsWithTerminalPunctuation
              // is .!? only (no colon), and the bullet-outdent guard above removed the side-effect that
              // used to break a colon-introduced sub-list before its first item.
              const introducesListItem = currentOpensListMarker
                && (endsWithTerminalPunctuation(previous.text) || /:$/u.test(previous.text.trim().replace(/[*_~]+$/u, '')));
              // A SET-OFF block (an indented, smaller-font example/quote under an intro line) is a block
              // boundary even when NEITHER signal alone crosses its threshold: the font shrink is sub-2pt
              // (below sizeChanged) AND the intro ends in a colon (not terminal punctuation, so the indent
              // rule below never fires) → the group loop folds the block into the intro (Agentic Mesh p65
              // "I want to open…" / "You are a customer service AI…" merged into their lead-ins, losing
              // indent + size). Split when the line is BOTH clearly indented deeper than the block's start
              // AND set in a smaller cap-height. Same-size first-line indents (ratio ~1) and drop caps
              // (larger) don't qualify, so normal prose and initials are untouched.
              const introEndsColon = /:$/u.test(previous.text.trim().replace(/[*_~"'”’)\]]+$/u, ''));
              const setOffBlock = bodyFont > 0
                && introEndsColon
                && current.x > previous.x + bodyFont * 0.9
                && _chOf(current) <= _chOf(previous) * 0.95
                && current.text.replace(/[\s*_~`]/gu, '').length >= 4 // a real block, not a stray math/superscript fragment
                && !isDropInitial(current);
              // LEAVING a set-off block: the previous line was the indented, smaller-font block and the
              // current line returns to the body margin at body size (Agentic Mesh p65: the "You are a
              // customer service AI…" example → "In a single instruction, the LLM is expected to:"). The
              // mirror of setOffBlock — needed because the block's last line ends with a full stop (not a
              // colon) and the page isn't justified, so neither setOffBlock nor prevEndsShort catches the
              // exit and the following body line merges into the example.
              const exitSetOffBlock = bodyFont > 0
                && group[0].x > current.x + bodyFont * 0.9        // the whole current group is an indented block
                && _chOf(group[0]) < bodyFont * 0.95              // …set BELOW body size (a genuine set-off block)
                && _chOf(group[0]) <= _chOf(current) * 0.95       // …and smaller than the current line
                && _chOf(current) >= bodyFont * 0.95              // current is back at body size
                && paraLeftMargin > 0 && Math.abs(current.x - paraLeftMargin) <= bodyFont * 0.6 // and at the body margin
                && !isDropInitial(current);
              endsBlock =
                bothShort ||
                prevEndsShort ||
                labelPair ||
                sizeChanged ||
                setOffBlock ||
                exitSetOffBlock ||
                consecutiveListItems ||
                startsFootnoteEntry(current) ||
                startsBulletLine(current.text) ||
                introducesListItem ||
                (bodyLineGap > 0 && verticalGap > bodyLineGap * 1.35) ||
                (endsWithTerminalPunctuation(previous.text) && (isIndentedBodyLine || startsParagraphTransitionLine(current.text)));
            }
            if (endsBlock) break;
            group.push(current);
            j++;
          }
          // A labeled hanging-indent list (dialogue, CIP, glossary) that the group loop did NOT already
          // consume as a whole region above (e.g. a short list, or one the region gate just missed):
          // re-split it per-entry via the same helper so speaker turns / fields don't run together.
          if (!groupIsHeading && detectLabeledHangingList(group)) {
            emitHangingEntries(group);
            i = j;
            continue;
          }
          // Join the block into one line. A word split across a line break is rejoined with no space.
          // A TYPOGRAPHIC/soft hyphen before a lowercase continuation (‐ U+2010, U+2011, soft U+00AD) is
          // a hyphenation artifact — DROP it ("esti‐"+"mates" → "estimates"). An ASCII hyphen-minus is a
          // real compound and is KEPT ("AI-"+"related" → "AI-related").
          let text = group[0].text;
          for (let k = 1; k < group.length; k++) {
            const nxt = group[k].text;
            const cont = /^[a-z]/.test(nxt);
            if (cont && /[A-Za-z][‐‑­]$/u.test(text)) text = text.replace(/[‐‑­]$/u, '') + nxt;
            else if (cont && /[A-Za-z]-$/u.test(text)) text = text + nxt;
            else text = `${text} ${nxt}`;
          }
          text = text.replace(/\s+/g, ' ').trim();
          // Sample this block's HANGING-INDENT magnitude by type (see the collector decls). Only a CLEAN
          // hang qualifies: ≥2 lines, the marker (line 0) is the group's leftmost, and every continuation
          // sits at ONE consistent deeper tier — so a normal wrapped paragraph (continuations at the SAME
          // margin, hang≈0) and scattered geometry are excluded. Classified from the leading marker; an
          // entry with no marker on a list page is an index entry.
          if (group.length >= 2 && bodyFont > 0 && !groupIsHeading) {
            const g0x = group[0].x;
            const contXs = group.slice(1).map(l => l.x);
            const contMin = Math.min(...contXs);
            // Divide by the item's OWN font (median line height), not bodyFont, so the em is size-invariant
            // — a smaller-set list (e.g. a back-of-book index) yields the same em applied against its own
            // rendered size, reproducing the printed hang instead of a body-relative one that reads short.
            const blkH = [...group.map(l => l.h)].sort((a, b) => a - b)[Math.floor(group.length / 2)] || bodyFont;
            const hangEm = (contMin - g0x) / blkH;
            if (g0x <= contMin + 1 && hangEm >= 0.4 && hangEm <= 3.5 && Math.max(...contXs) - contMin <= blkH) {
              const lead = text.replace(/^[*_~`\s ]+/u, '');
              if (/^[•‣▪●◦⁃∙○■]/u.test(lead)) bulletHangEms.push(hangEm);
              else if (/^\[?(?:\d{1,2}|[ivxlcdm]{1,4}|[a-z])[.)\]]/iu.test(lead)) listHangEms.push(hangEm);
              else if (isListPage) indexHangEms.push(hangEm);
            }
          }
          // De-hyphenate a word split across a line break even when LINK markup separates the halves —
          // the hyphenated word was a hyperlink, so it came out "esti‐](url) [mates](url)". First, when
          // BOTH halves link to the SAME url, MERGE them into one span so the hover/underline stays
          // continuous ("[esti‐](u) [mates](u)" → "[estimates](u)"). Then drop any remaining typographic/
          // soft hyphen + join space (ASCII "-" compounds are left intact).
          text = text.replace(/([A-Za-z])[‐‑­]\]\(([^)]*)\)\s+\[([a-z][^\]]*)\]\(\2\)/gu, '$1$3]($2)');
          text = text.replace(/([A-Za-z])[‐‑­](\]\([^)]*\))?\s+(\[?)([a-z])/gu, '$1$2$3$4');
          // A custom-text link (anchor is descriptive text, not the URL itself) whose anchor wrapped
          // across a line arrives as TWO adjacent spans to the SAME url, split by the soft-wrap space
          // ("[…COO of Google](u) [DeepMind, writes](u)") — pdf.js emits one link box per wrapped line.
          // Collapse consecutive same-url spans into one so the reader underlines one continuous link
          // instead of two with a gap. Looped, so an anchor wrapping across 3+ lines fully coalesces.
          let mergedSpan: string;
          do { mergedSpan = text; text = text.replace(/\]\(([^)]*)\)(\s+)\[([^\]]*)\]\(\1\)/gu, '$2$3]($1)'); } while (text !== mergedSpan);
          // A heading is styled as a whole by the reader, so inline emphasis inside it is
          // noise. It also actively harms: a bold-only glyph among bold-italic words (e.g.
          // an upright bold chapter number, "Chapter **5.** *The Life…*") leaves a stray
          // "**" that shows literally and breaks the notes "Chapter N" section detection.
          // Drop emphasis markers from heading blocks (footnote links are left intact). But a heading the
          // source sets WHOLLY ITALIC (Sovereign's sub-section titles are EBGaramond-BoldItalic — every glyph
          // italic, so the line builder wrapped each run in `*…*`) would lose that. Detect it from the markers
          // FIRST (≥1 italic run, no bold `**`, no letters OUTSIDE the italic runs) and carry U+E026 so the
          // reader renders the heading italic (its font-bold + fontStyle:italic = bold italic). Mirrors the
          // EPUB wholly-italic <h*> path; the PDF glyph italic comes from the real (loaded) font name.
          let _headItalicMark = '';
          if (groupIsHeading) {
            _headItalicMark = /\*[^*]+\*/u.test(text) && !/\*\*/u.test(text) && !/[A-Za-zÀ-ɏ]/u.test(text.replace(/\*[^*]*\*/gu, '')) ? '' : '';
            text = text.replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim();
          }
          if (text) {
            const last = group[group.length - 1];
            // A set-off epigraph/quote CREDIT ("—NORMAN COHN", "—EMERSON, The Conduct of Life") is
            // right-aligned display, not prose. Tag it right (U+E011) so the reader drops its
            // first-line indent by GEOMETRY, not by a fragile date/name text guess. Gate on the
            // leading em/en dash: right-alignment alone is overloaded here (this book right-aligns
            // chapter titles), the attribution dash is not — so headings/index tails never match.
            const groupMinX = Math.min(...group.map(l => l.x));
            const groupMaxRight = Math.max(...group.map(l => l.rightX));
            const _rightAttrGeom = groupMinX > bodyLeft + bodyFont * 4 && groupMaxRight >= rightMargin - Math.max(6, bodyFont);
            const _dashLed = /^\s*(?:[*_~`]+\s*)?[\u2014\u2013]/u.test(text);
            // A dash-led flush-right line is a right-aligned CREDIT. A following flush-right line with NO new
            // dash is that credit's CONTINUATION (a byline title "Head of AI, Confluent" under "\u2014 Sean
            // Falconer") \u2014 tag it right too so the split byline stays flush-right on both lines instead of the
            // title falling back to stray left body. Restrict it to a SINGLE SHORT line: the next endorsement
            // blurb's multi-line block quote after a credit is NOT a byline title and must stay left/justified.
            const _shortSingle = group.length === 1 && (groupMaxRight - groupMinX) < (rightMargin - bodyLeft) * 0.5;
            const isRightAttribution = !groupIsHeading && _rightAttrGeom
              && (_dashLed || (_prevGroupWasRightAttr && _shortSingle));
            prevWasRightAttribution = isRightAttribution;
            // Geometry-faithful indent (only trusted on justified pages, where a block's lines share one
            // left tier). first-line indent = the FIRST line sits deeper than the block's continuation
            // lines (novels); block left-indent = ALL lines sit deeper than the body margin (a definition
            // description). Carry the block left-indent as leading NBSP (reader \u2192 padding); count first-line
            // indents so the reader can drop its fixed indent on block-style books.
            const firstLineExtra = group[0].x - groupMinX;             // first line vs continuation
            // Measure the block indent against paraLeftMargin (the LEFTMOST frequent left = the true
            // body margin), NOT bodyLeft (the page MODE). On a definition-list page ("Layer 1:" term +
            // its indented explanation) the indented description lines OUTNUMBER the flush term/heading
            // lines, so bodyLeft = the description tier (x=90) and every description measured as flush
            // (0 indent). paraLeftMargin stays at the real margin (x=72), so the +18pt block indent is
            // seen. A multi-line normal paragraph always has a continuation at the true margin (so
            // groupMinX == paraLeftMargin → 0 here); require group.length>=2 so a lone first-line-
            // indented one-liner isn't mistaken for a left-indented block.
            const blockLeftPx = groupMinX - paraLeftMargin;            // whole block vs true body margin
            // Sample ONLY normal body paragraphs (at the true margin) for the first-line-indent ratio.
            // A block-indented paragraph — a block quote/epigraph, a numbered/lettered list — has its
            // first line flush WITHIN its own indented block (firstLineExtra=0), so counting it drags the
            // ratio down as if the book had no first-line indent. The Sovereign Individual is saturated
            // with epigraph block quotes; including them pushed the ratio to 0.39 (<0.40) → the whole
            // book was flagged block-style and EVERY paragraph rendered flush, defeating the per-paragraph
            // first-line indent. Exclude blocks that sit deeper than the margin (blockLeftPx > ~0.9em).
            if (pageJustified && !groupIsHeading && !isRightAttribution && blockLeftPx <= bodyFont * 0.9) {
              bodyBlkTotal++;
              if (firstLineExtra > bodyFont * 0.6) { bodyBlkFirstLineIndented++; if (bodyFont > 0) firstLineIndentEms.push(firstLineExtra / bodyFont); }
            }
            // A block-indented list ITEM (a numbered/lettered rule condition "1. …", an "IF:"/"THEN:"
            // label) can be a SINGLE line — the group.length>=2 guard (which stops a lone first-line-
            // indented paragraph masquerading as a block) then drops its indent, so it renders flush while
            // its multi-line siblings stay indented (the MYCIN rule's one-line conditions 2 & 4). A line
            // that OPENS with a list marker is unambiguously a list item, so allow it single-line too.
            // A single line that FILLS the measure is also a genuine block line, not a stray first-line
            // indent (which is SHORT): keep its indent so one full-width sentence in an indented block
            // ("Some fleets align…, HR, or compliance.") isn't rendered flush while its multi-line
            // sibling stays indented — the inconsistent-indent bug on a labeled explanation block.
            // A marker at END OF LINE (a standalone "IF:" with the rule's conditions on the following
            // lines) counts too — else "IF:" alone gets no block indent while "THEN: …text" does, so a
            // MYCIN rule's IF:/THEN: (both at x=130 in the source) render mis-aligned (IF: flush).
            const opensListMarker = /^(?:IF:|THEN:|\d{1,2}[.)]|(?:[a-z]|[ivxlcdm]{2,7})[.)])(?:\s|$)/u.test(text.replace(/^[*_~]+/u, ''));
            const blockFillsMeasure = rightMargin > 0 && fillsMeasure(Math.max(...group.map(l => l.rightX)), rightMargin);
            // A list item's indent is its depth WITHIN the list, so measure it from the list's own top-level
            // margin (the numbered-marker tier), not the wobbly per-page paraLeftMargin. This keeps a lettered
            // sub-item nested at the SAME depth on every page - even a page where the top-level margin has too
            // few openers to be sampled (Sovereign p338: paraLeftMargin collapses to the continuation tier, so
            // sub-items a.-d. would otherwise measure as flush and de-nest vs the identical items on p337).
            const listAnchoredLeftPx = (opensListMarker && listMarginLeft !== undefined && listMarginLeft < paraLeftMargin)
              ? groupMinX - listMarginLeft
              : blockLeftPx;
            // GEOMETRY-DIRECT indent: reproduce the block's MEASURED left offset for ALL blocks, single- or
            // multi-line — no longer gated on group.length>=2. A single-line definition DESCRIPTION ("Able to
            // make…") sits at the same left tier as its wrapping siblings and must keep it; and a lone
            // indented line is visually identical whether it's a "block indent" or a "first-line indent"
            // (one line shifted right looks the same), so reproducing the measured offset is faithful either
            // way. A single short line no longer becomes a block-quote (see isBlockQuote's group.length gate).
            const blockNbsp = (pageJustified && !groupIsHeading && !isRightAttribution && bodyFont > 0 && listAnchoredLeftPx > bodyFont * 0.9)
              ? Math.min(12, Math.round((listAnchoredLeftPx / bodyFont) / 1.5 * 4)) : 0;
            // Geometry-faithful first-line indent: a paragraph whose FIRST line sits at the body margin
            // (not indented) is FLUSH \u2014 the section's opening paragraph in a first-line-indent book
            // ("Premonitions" \u2192 "The coming of the year 2000\u2026"), a chapter's first paragraph, a cross-
            // page continuation. Tag it with U+E018 so the reader drops its fixed 1.75em first-line
            // indent for THIS paragraph only, reproducing the source instead of indenting every
            // paragraph uniformly. Measured against paraLeftMargin (the true margin) so it works for a
            // one-line paragraph too. Only a normal flowing body block (not a heading, right-attribution,
            // or left-indented definition block) carries it; a book that indents every paragraph has no
            // flush paragraphs \u2192 no tag \u2192 unchanged, and a block-style book (no indent anywhere) ignores it.
            // A top-level LIST item (a numbered/lettered/IF-THEN marker at the margin, blockNbsp===0) is
            // ALWAYS flush — its marker must align at the body margin like the other list items, never take
            // the book's first-line indent. Force flush for it even when the margin test below just misses
            // (a list crossing a page break can shift paraLeftMargin so one item fails the x threshold and
            // renders indented while its siblings stay flush — the inconsistent "1./2." vs "3." indent).
            // The block's SIZE TIER (dominant line height vs body) marks a sub-head/heading regardless of
            // geometry; compute it up front so the first-line-flush decision can use it. (nonDropLines drops
            // decorative drop-cap lines so a large initial doesn't inflate a body paragraph to a display tier.)
            const nonDropLines = group.filter(l => l.h < bodyFont * 2.2);
            // A small-caps HEADING measures small by its char-weighted height (most letters are the small-cap
            // size), but its CAP height (tallest glyph) is the true font size. For a heading block, size off
            // cap height so a small-caps section head ("PREMONITIONS") / chapter label lands on its heading
            // tier instead of a shrink tier below body — matching the EPUB, which reads the <h#> CSS size.
            // Body blocks keep the char-weighted height (a body line's cap height is body-sized anyway).
            const heightOf = (l: PdfLine) => groupIsHeading ? Math.min(l.capH ?? l.h, bodyFont * 2.2) : l.h;
            const blockH = mode((nonDropLines.length ? nonDropLines : group).map(l => Math.round(heightOf(l)))) || bodyFont;
            const sizeRatio = bodyFont > 0 ? blockH / bodyFont : 1;
            // CAP height of the block (tallest non-drop glyph anywhere in it). A small-caps LEAD-IN
            // ("DO YOU THINK I'm insane?") measures SMALL by char-weighted height (the small caps dominate)
            // but its caps are body-sized (the mixed-in regular glyphs) — it is NOT fine print. Gate the
            // SHRINK tiers on this: only shrink when the caps are ALSO small (a genuine caption/footnote),
            // so a small-caps body run isn't shrunk below body. Same principle capH already gives headings.
            const blockCapH = Math.max(...(nonDropLines.length ? nonDropLines : group).map(l => l.capH ?? l.h));
            const capRatio = bodyFont > 0 ? blockCapH / bodyFont : 1;
            const isSizedHead = sizeRatio > 1.08;   // e01d/e01e/e01f — a sub-head or heading
            // FIRST-LINE FLUSH — drop the book's uniform first-line indent for THIS paragraph. A first-line
            // indent is a WITHIN-paragraph property: the first line sits deeper than the paragraph's OWN
            // continuation lines (firstLineExtra). Measure THAT for multi-line blocks — page-margin-
            // independent, so a block-indented section (e.g. the Dad-Bot Q&A at x=93) stays flush even when a
            // new section with a different margin shares the page and drags paraLeftMargin down (the p139
            // bug). A SIZED-UP block (sub-head) is heading-like → always flush; a LIST item is flush at its
            // marker; only a genuinely single-line body paragraph (no continuation to compare) falls back to
            // the flippy page margin. Matches the doc-level first-line-indent COUNTER, which already uses
            // firstLineExtra — the two were inconsistent before.
            const firstLineFlush = !groupIsHeading && !isRightAttribution && blockNbsp === 0 && bodyFont > 0 && (
                 isSizedHead
              // A top-level list marker is flush at the margin — UNLESS the source sets the item as a
              // first-line-INDENTED paragraph (the marker sits deeper than its own wrapped lines, e.g. the
              // Sovereign "1. Direct costs…" enumeration: "1." at x=90, wraps back to the margin x=72).
              // Forcing flush there wrongly HANGS it (marker at margin, wraps indented) — the opposite of the
              // source. Keep flush only when the marker is NOT first-line-indented (a genuine hanging list).
              || (opensListMarker && !(group.length >= 2 && firstLineExtra > bodyFont * 0.6))
              || (group.length >= 2 && firstLineExtra <= bodyFont * 0.6)
              || (group.length < 2 && (group[0].x <= paraLeftMargin + bodyFont * 0.6 || group[0].x <= sectionBodyLeft + bodyFont * 0.6))
            );
            // A TRUE block quote (a set-off quotation) is indented on BOTH margins — its lines end SHORT
            // of the body's right edge, unlike a left-only definition description (which fills the right
            // margin). Detect it (left block indent AND the block's widest line falls short of rightMargin)
            // and tag it U+E019 so the reader adds a matching RIGHT padding (narrower paragraph) and drops
            // the first-line indent, instead of only padding the left.
            const blockMaxRight = Math.max(...group.map(l => l.rightX));
            // Require MULTI-LINE evidence: a true set-off quote is a run of lines that ALL end short of the
            // right margin (a narrow block). A single short line ends short only because it's short (a
            // one-line definition description, a paragraph's ragged last line) — not a narrow block — so it
            // must NOT be tagged a block-quote (which would add the set-off gap + shrink). Now that
            // single-line blocks keep their measured left indent, this gate is what keeps them out of the quote path.
            const isBlockQuote = group.length >= 2 && blockNbsp > 0 && rightMargin > 0 && (rightMargin - blockMaxRight) > bodyFont * 0.9;
            // MEASURED set-off spacing: reproduce the source's gap-above instead of a fixed constant. A
            // block-quote whose gap above is a genuine set-off (>=1.75x the line gap — a real epigraph/callout)
            // carries U+E022 so the reader gives it the full set-off top margin; a quote that FLOWS from its
            // lead-in (e.g. a colon-introduced definition, ~1.5x) omits it and gets only a moderate gap.
            const setoffAbove = bodyLineGap > 0 && gapAbove >= bodyLineGap * 1.75;
            // MEASURED paragraph gap (ANY block, not just block-quotes): reproduce the source's inter-
            // paragraph spacing from the real gap-above instead of assuming. First-line-indent books
            // (Elon 0.2%, Sovereign 0.5% of lines) have ~1.0x gaps → nothing emitted; a block-spaced book
            // (Agentic 13.5%) has >=1.35x gaps → the reader adds a small top margin. Headings keep their own
            // spacing (excluded). U+E028 = a modest measured gap above.
            const measuredGapAbove = !groupIsHeading && bodyLineGap > 0 && gapAbove >= bodyLineGap * 1.35;
            // Relative font-size TIER: the block's dominant line height vs the document body size. Encodes
            // the source's size hierarchy (figure title/subtitle, sub-heads, captions, metadata) so the
            // reader can reproduce it as an em-multiple of the user's base size — orthogonal to bold/heading/
            // align. A deadband around 1.0 leaves ordinary body untagged (~95% of content); drop caps/
            // superscripts don't skew it because line.h is the MODE of a line's glyph heights, not the max.
            // Exclude drop-cap-sized lines (≥2.2× body, the same threshold the drop-cap detector uses) from
            // the block's size so a decorative initial doesn't inflate a body paragraph to a display tier;
            // if the WHOLE block is that large it's a genuine display heading, so keep it.
            // (nonDropLines / blockH / sizeRatio are computed above, before firstLineFlush, so the flush
            // decision can use the size tier.)
            const sizeSentinel = sizeRatio >= 1.6 ? '\uE01F' : sizeRatio >= 1.25 ? '\uE01E' : sizeRatio > 1.08 ? '\uE01D'
              : capRatio < 0.92 ? (sizeRatio < 0.80 ? '\uE01B' : sizeRatio < 0.90 ? '\uE01C' : '') : '';
            // Explicit LEFT-ragged block on a JUSTIFIED doc: its non-last lines all fall short of the
            // right margin (a justified paragraph fills it), so it is a left-aligned block (copyright/
            // dedication front matter) -> tag U+E023 so the reader skips justify and renders it ragged,
            // faithful to the source. Narrow gate (multi-line, at the margin, not a quote/indent/heading/
            // attribution) + validated on the test PDFs: 0 body false positives (justified lines reach it).
            const raggedLeft = sourceJustified === true && !groupIsHeading && !isBlockQuote && !isRightAttribution
              && blockNbsp === 0 && rightMargin > 0 && group.length >= 2
              && group.slice(0, -1).every(l => (rightMargin - l.rightX) > bodyFont * 0.9);
            // A heading-SIZED display block set in a MEDIUM/SEMIBOLD weight (a chart title "UK Life
            // Expectancy…", GillSansNova-Medium at 1.25x body) reads as BOLD vs the body regular, but its
            // weight name isn't "bold" so the glyph bold flag is false. Render it bold — GATED on an ENLARGE
            // size tier (\uE01D-\uE01F) so a SMALL same-font caption ("Source:", body-size) stays regular —
            // when it isn't already bold-marked and it has letters.
            if (/[\uE01D-\uE01F]/u.test(sizeSentinel) && group.some(l => l.semibold) && !/\*\*/u.test(text) && /[A-Za-z]/u.test(text)) {
              text = `**${text}**`;
            }
            // O'Reilly ADMONITION: a body block indented to the RIGHT of a coloured note/tip/warning icon on
            // this page, its top near the icon's top -> tag it a callout carrying the icon id + type. The
            // reader renders the labelled box (warning red-tinted) with the icon; the label word stays in the
            // content for search. Consume the icon so it fires once. Gated on the icon -> can't misfire.
            let _calloutPrefix = '';
            if (!groupIsHeading) {
              const _icons = admonIconsByPage.get(pageNum);
              if (_icons && _icons.length) {
                const _top = Math.max(...group.map(l => l.pageY));
                const _idx = _icons.findIndex(ic => group[0].x > ic.x + ic.w - 6 && _top <= ic.yTop + 12 && _top >= ic.yBot - 12);
                if (_idx >= 0) {
                  const _ic = _icons[_idx]; _icons.splice(_idx, 1);
                  const _mk = _ic.type === 'tip' ? '' : _ic.type === 'warning' ? '' : '';
                  const _lbl = _ic.type === 'tip' ? 'Tip' : _ic.type === 'warning' ? 'Warning' : 'Note';
                  _calloutPrefix = `${_mk}[[FIG ${_ic.id}]]${_lbl} `;
                }
              }
            }
            // The paragraph OPENS with a drop-cap glyph (a chapter opener's oversized initial) -> U+E02E so
            // the reader floats its first letter (::first-letter). Body only, never a block-quote/right-
            // attribution (a set-off block's leading big letter is not a chapter drop cap).
            const _dropCapMark = (group[0].dropCapStart && !groupIsHeading && !isBlockQuote && !isRightAttribution) ? '' : '';
            blocks.push({
              text: _calloutPrefix + _dropCapMark + _headItalicMark + (raggedLeft ? '\uE023' : '') + (isBlockQuote && setoffAbove ? '\uE022' : '') + (measuredGapAbove ? '\uE028' : '') + sizeSentinel + (isRightAttribution ? '\uE011' + text : (firstLineFlush ? '' : '') + (isBlockQuote ? '' : '') + '\u00A0'.repeat(blockNbsp) + text),
              role: groupIsHeading ? 'heading' : 'body',
              firstX: group[0].x,
              firstRightX: group[0].rightX,
              lastRightX: last.rightX,
              lastText: last.text,
              col: group.find(l => l.col !== undefined)?.col,
              topY: Math.max(...group.map(l => l.pageY)),
              // continuation/indent tier (where wraps + a page-continuation sit), for the cross-page seam
              // merge. Use the CONTINUATION lines, not line 1 — a bullet/hanging item's first line sits at
              // the outdent (the "•" at x=90) which would skew the tier off the real text column (x=102).
              bodyX: mode((group.length > 1 ? group.slice(1) : group).map(l => Math.round(l.x))),
            });
            // Advance the section body column from a normal, multi-line, non-indented body paragraph (the
            // flowing text column of the current section), so a following single-line block is judged
            // against it. A heading, block-indented, or right-attribution block is not the text column.
            if (!groupIsHeading && !isRightAttribution && blockNbsp === 0 && group.length >= 2) sectionBodyLeft = groupMinX;
          }
          i = j;
        }

        // Right-aligned-marker sub-list re-anchor. Some lists set the marker with a RIGHT tab so the
        // marker's dot aligns at a tab stop while its LEFT edge varies with the marker's width (roman
        // i./ii./iii./iv. — "i." starts further right than "iii."). The block-indent measured each marker's
        // LEFT edge, which (a) understates the indent — the real content sits at the deeper body tab stop —
        // and (b) varies per item, so the items rendered flush/inconsistent instead of as one hanging
        // sub-list (Singularity p36). Detect a contiguous run of list-marker blocks whose marker lefts VARY
        // (the right-aligned signature; an ordinary left-aligned list has ~0 spread and is left untouched —
        // Sovereign 1–10 / a–d, MYCIN) and re-anchor them all to their shared body tab stop = the deepest
        // continuation tier in the run (where the wrapped lines sit), so every item aligns and hangs together.
        {
          const openRe = /^(?:IF:|THEN:|\d{1,2}[.)]|(?:[a-z]|[ivxlcdm]{2,7})[.)])(?:\s|$)/u;
          const leadRe = /^([\uE010-\uE020\uE023]*)(\u00A0*)([\s\S]*)$/u;
          const listReal = (b: EmitBlock): boolean => { const m = b.text.match(leadRe); return m ? openRe.test(m[3].replace(/^[*_~]+/u, '')) : false; };
          for (let a = 0; a < blocks.length;) {
            if (blocks[a].col !== undefined || !listReal(blocks[a])) { a++; continue; }
            let b = a; while (b < blocks.length && blocks[b].col === undefined && listReal(blocks[b])) b++;
            const run = blocks.slice(a, b);
            // A contiguous marker run can span NESTING LEVELS: the LIVE audit on Sovereign p337 proved the run
            // is [3 4 5 a b c d 6 7 a b] with the OUTER items at firstX≈84 (leadNbsp already 0, flush) and the
            // INNER a/b/c/d at firstX≈114 (leadNbsp already 5, indented) — the base extraction ALREADY tiers
            // them correctly. Judging the whole run as one unit gives spread≈31 (measured ACROSS the two tiers)
            // → the guard fires and OVERWRITES every item to one deep tab (newNbsp 11), destroying the correct
            // base indents (outer dragged in, inner over-indented). Split the run into per-TIER sub-runs by
            // marker-left (firstX, gap-clustered) and apply the right-marker test PER tier: an aligned tier
            // (spread≈0) is LEFT ALONE at its correct base indent, while a genuinely right-tabbed roman list
            // (markers jitter within ONE tier: i.=150…iii.=143) stays one sub-run and still re-anchors. MYCIN
            // (all firstX≈133, one tier, spread 3) never fired and still does not.
            const tiers: EmitBlock[][] = [];
            for (const bl of [...run].sort((x, y) => x.firstX - y.firstX)) {
              const cur = tiers[tiers.length - 1];
              if (cur && bl.firstX - cur[cur.length - 1].firstX <= bodyFont * 1.5) cur.push(bl);
              else tiers.push([bl]);
            }
            for (const tier of tiers) {
              const lefts = tier.map(bl => bl.firstX);
              const spread = Math.max(...lefts) - Math.min(...lefts);
              const tab = Math.max(...tier.map(bl => bl.bodyX ?? bl.firstX));
              // A tier is a right-aligned marker list when the marker lefts VARY (spread) or it holds a MULTI-
              // char roman marker (ii./iii./iv.) — the latter also catches a lone item left on a page by a page
              // break ("iv." alone on p36 while i./ii./iii. sit on p35), which has spread 0.
              const romanRun = tier.some(bl => { const mm = bl.text.match(leadRe); return !!mm && /^[ivxlcdm]{2,7}[.)]/u.test(mm[3].replace(/^[*_~]+/u, '')); });
              // Anchor on the DOC-WIDE body margin (not the wobbly per-page one) so the same list indents the
              // same on every page and a page-split list stays consistent.
              // The re-anchor is a SUB-LIST right-marker gutter — it must NOT fire on a TOP-LEVEL list whose
              // markers sit at the body margin. Sovereign's outer 1-10 right-aligns its numbers, so "10." lands
              // at firstX 77 vs "8."/"9." at 84 → a 7.5px spurious spread that wrongly fired the gutter and
              // nested 8/9/10. A top-level list's marker is ≤~0.8em past docBodyLeft (outdented at the margin);
              // a genuine sub-list's marker is far deeper (Sovereign a/b/c/d ~2.7em, Singularity roman ~4.4em).
              // Require the tier's leftmost marker to be genuinely indented past the doc margin. (Live audit:
              // Sovereign outer excluded; roman/inner still eligible; MYCIN spread never fired anyway.)
              const markerIndented = Math.min(...tier.map(bl => bl.firstX)) - docBodyLeft > bodyFont;
              const fires = markerIndented && (spread > bodyFont * 0.3 || romanRun) && bodyFont > 0 && tab > docBodyLeft + bodyFont * 0.9;
              if (fires) {
                const newNbsp = Math.min(12, Math.round((tab - docBodyLeft) / bodyFont / 1.5 * 4));
                for (const bl of tier) { const m = bl.text.match(leadRe)!; bl.text = '' + m[1] + ' '.repeat(newNbsp) + m[3]; }
              }
            }
            a = b;
          }
        }

        // Drop this page's figures into the block stream by their top-Y, so a figure reads where it
        // physically sits (blocks are in top-to-bottom reflow order). The [[FIG id]] marker becomes
        // its own block; the reader swaps it for the cached image, text consumers strip it.
        const pageFigs = figuresByPage.get(pageNum);
        if (pageFigs) for (const f of pageFigs) {
          const fb: EmitBlock = { text: `[[FIG ${f.id}]]`, role: 'body', firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '', topY: f.yTop, bodyX: bodyLeft };
          let at = blocks.findIndex(b => (b.topY ?? -Infinity) < f.yTop);
          if (at < 0) at = blocks.length;
          blocks.splice(at, 0, fb);
        }
        // A detected row-major DATA TABLE (positioned-token U+E025 payload) drops into the block stream at
        // its top-Y, like a figure. It is one atomic block (its own paragraph); the reader's table branch
        // parses the payload and lays out each token at its x-fraction.
        const pageTables = tablesByPage.get(pageNum);
        if (pageTables) for (const t of pageTables) {
          const tb: EmitBlock = { text: t.text, role: 'body', firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '', topY: t.yTop, bodyX: bodyLeft };
          let at = blocks.findIndex(b => (b.topY ?? -Infinity) < t.yTop);
          if (at < 0) at = blocks.length;
          blocks.splice(at, 0, tb);
        }
        // Decorative horizontal RULES (epigraph/section dividers) drop into the stream at their y the same
        // way figures do. The U+E021 marker becomes its own block; the reader renders a thin grey rule
        // (the attribution colour), and text/search/TTS consumers strip it.
        for (const r of buf.hRules || []) {
          const rb: EmitBlock = { text: r.double ? '' : '', role: 'body', firstX: r.x, firstRightX: r.x + r.w, lastRightX: r.x + r.w, lastText: '', topY: r.y, bodyX: r.x };
          let at = blocks.findIndex(b => (b.topY ?? -Infinity) < r.y);
          if (at < 0) at = blocks.length;
          blocks.splice(at, 0, rb);
        }
        // FIGURE-CAPTION re-join. A caption set in a NARROW column symmetrically inset under the figure
        // (BHI "Figure 2.8: The Roomba…", x≈237 inside a 77..535 body) is shattered one-block-per-line by
        // the short-line test (bothShort measures each line against the PAGE width, not its own narrow
        // column) and then centred one-per-line by the per-line centring below. Re-join it: from a
        // "Figure/Table/Plate/Chart N" opener that is ITSELF inset, absorb the following body blocks in the
        // SAME inset column (same firstX) until a new italic block (the attribution), a new caption, a
        // column change, or a terminal-punctuated line — so the caption renders as ONE left-aligned
        // paragraph (its length then skips the per-line centring). Scoped to an inset caption opener +
        // same-column continuation, so a body "Figure 2 shows…" sentence (at the body margin), the italic
        // attribution, tables/index/TOC and inset blockquotes (no "Figure N" opener) are all untouched —
        // validated across every test PDF by scripts/pdf-caption-audit.mjs (only BHI figure captions match).
        {
          const stripSent = (t: string): string => t.replace(/^[-]+/u, '');
          const capOpener = /^[*_~\s]*(?:Figure|Fig\.|Table|Plate|Chart)\s*\d/i;
          // Join `add` onto `prev` the way the source wrapped it: a trailing hyphen (word split) OR a
          // trailing "/" (a URL split across lines, e.g. ".../wiki/" + "Roomba") continues with NO space;
          // otherwise a single space. Emphasis markers are handled by the callers.
          const joinWrap = (prev: string, add: string): string => {
            const p = prev.replace(/\s+$/u, ''); const a = add.replace(/^\s+/u, '');
            const pv = p.replace(/[*_~]+$/u, '');
            return (/[A-Za-z][-‐‑­]$/u.test(pv) && /^[*_~]*[a-z]/u.test(a)) || /\/$/u.test(pv)
              ? p.replace(/[-‐‑­]([*_~]*)$/u, '$1') + a
              : `${p} ${a}`;
          };
          for (let bi = 0; bi < blocks.length; bi++) {
            const b = blocks[bi];
            if (b.role !== 'body' || b.firstX <= bodyLeft + bodyFont * 1.5 || !capOpener.test(stripSent(b.text))) continue;
            const capX = b.firstX;
            // Phase 1 — the CAPTION (roman): same-column non-italic wrapped lines → one paragraph.
            while (bi + 1 < blocks.length) {
              const nb = blocks[bi + 1];
              const nbare = stripSent(nb.text);
              // The continuation must sit at the caption column. A caption's own wrap lines start at EXACTLY
              // capX (or, when justified, extend rightward — never LEFT of it); a following BODY paragraph
              // starts at its own, SHALLOWER first-line indent, i.e. LEFT of the inset caption column (BHI
              // wide "Figure 2" fig_85: capX≈111, body first line x≈99). The old symmetric `> bodyFont`
              // tolerance let that 11pt offset pass and swallowed the whole body paragraph into the caption.
              if (nb.role !== 'body' || nb.firstX < capX - bodyFont * 0.5 || nb.firstX > capX + bodyFont || /^[*_~]/u.test(nbare) || capOpener.test(nbare)) break;
              b.text = joinWrap(b.text, nbare);
              b.lastRightX = nb.lastRightX; b.lastText = nb.lastText;
              blocks.splice(bi + 1, 1);
              if (endsWithTerminalPunctuation(nbare.replace(/[*_~]+$/u, '').trim())) break;
            }
            // Phase 2 — the ATTRIBUTION (italic): the source sets the credit ("Photograph by Larry D. Moore
            // in 2006…") as ONE short paragraph, but geometry shatters it one-block-per-line. Merge the
            // consecutive same-column ITALIC lines right after the caption into a single italic paragraph so
            // it reflows in its box (matching the caption). Rebuilt as one *…* run (strip the per-line
            // emphasis/sentinels, re-wrap once) so the reader can't break it at the run boundaries.
            const ai = bi + 1;
            if (ai < blocks.length) {
              const first = blocks[ai];
              const fbare = stripSent(first.text);
              if (first.role === 'body' && Math.abs(first.firstX - capX) <= bodyFont && /^[*_~]/u.test(fbare) && !capOpener.test(fbare)) {
                const lead = (first.text.match(/^[-]+/u) || [''])[0].slice(0, 1);
                let joined = fbare.replace(/[*_~]/gu, '').trim();
                while (ai + 1 < blocks.length) {
                  const nb = blocks[ai + 1];
                  const nbare = stripSent(nb.text);
                  // A credit is set ITALIC on every wrapped line, so a continuation must ALSO be italic. Without
                  // this, a ROMAN body paragraph whose first-line indent lands near the (inset) caption column —
                  // a WIDE figure's caption sits close to the body margin (BHI "Figure 2" fig_85, capX≈111 vs the
                  // body's indented first line x≈99, within bodyFont) — got swallowed into the "*…*" attribution.
                  // Requiring italic breaks at the first roman body line; a genuine credit wrap (all italic) stays.
                  if (nb.role !== 'body' || nb.firstX < capX - bodyFont * 0.5 || nb.firstX > capX + bodyFont || capOpener.test(nbare) || !/^[*_~]/u.test(nbare)) break;
                  joined = joinWrap(joined, nbare.replace(/[*_~]/gu, '').trim());
                  first.lastRightX = nb.lastRightX; first.lastText = nb.lastText;
                  const term = endsWithTerminalPunctuation(nbare.replace(/[*_~]+$/u, '').trim());
                  blocks.splice(ai + 1, 1);
                  if (term) break;
                }
                first.text = lead + '*' + joined + '*';
              }
            }
            // Phase 3 — a SHORT caption whose CREDIT sits on the SAME line ("Figure 2.4: The Ediacaran
            // world *Original art by Rebecca Gelernter*") clusters into ONE block, so Phase 2 (which needs a
            // SEPARATE italic block) never split it and it renders merged. The source treats the credit as a
            // distinct element (EPUB has a separate <p class="image_credit">). If the caption block ENDS with
            // an italic run that reads like a credit, split it into its own attribution block so the reader
            // shows caption + credit on two lines (matching EPUB). Gated on a credit KEYWORD so a caption that
            // merely ends in an italic term (a species/book name, e.g. "…nematode *C. elegans*") is untouched.
            {
              const m = b.text.match(/^(.+?\S)\s+(\*[^*\n]+\*|_[^_\n]+_)\s*$/u);
              const creditInner = m ? m[2].replace(/^[*_]|[*_]$/gu, '').trim() : '';
              if (m && !capOpener.test(creditInner) &&
                  /^(?:original art|photograph|photo|illustration|image|drawing|painting|courtesy|source|credit|reprinted|adapted|art by|map by|diagram by|©|copyright|by\s+[A-Z])/i.test(creditInner)) {
                b.text = m[1];
                blocks.splice(bi + 1, 0, { ...b, text: m[2] });
              }
            }
          }
        }
        // ROBUST CENTRING. A line is centred when its LEFT inset ≈ its RIGHT inset (both significant)
        // measured against the DOC body margins, AND its centre ≈ the page centre. This holds for the
        // chapter/part TITLE (a heading; source text-align:center), the chapter NUMBER, and a one-line
        // epigraph/attribution, and EXCLUDES justified prose (insets ≈ 0), left- (insetL ≈ 0) and right-
        // aligned (insetR ≈ 0) lines. It uses the DOC margins, not the per-page ones, so a SPARSE figure
        // page (a Part-divider, whose per-page margin is the caption's inset x) still measures correctly —
        // that skew is why the divider AND chapter titles weren't centred. Applies to HEADINGS too (the old
        // rule was body-only + <=60 chars, so it centred the number but never the title). A multi-line
        // block's first/last line have different widths so its centre test fails — only single-line-centred
        // blocks (title, number, one-line attribution) are tagged, which is exactly what we want.
        {
          const docCentre = (docBodyLeft + bodyRightEdge) / 2;
          if (bodyRightEdge > docBodyLeft) for (const b of blocks) {
            if (b.role === 'list' || b.firstRightX <= b.firstX || b.text.includes('')) continue; // list has its own structure; already right-aligned
            const bare = b.text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[-\uE02A*_~`]/gu, '').trim();
            if (!bare || bare.length > 300) continue; // paranoia cap only; the symmetric-inset test below is the real filter
            // Measure the FIRST LINE's insets (firstX..firstRightX) — valid for a MULTI-LINE block too (a centred
            // epigraph and its wrapped attribution): every line is symmetrically inset, but the block's first-line-x
            // paired with its LAST-line-rightX is off-centre, which LOST the centring once the wrapped attribution
            // merged into one block (→ the reader then fell back to right-aligned/grey/italic attribution styling).
            const left = b.firstX - docBodyLeft, right = bodyRightEdge - b.firstRightX;
            const centre = (b.firstX + b.firstRightX) / 2;
            if (left > bodyFont && right > bodyFont && Math.abs(left - right) <= bodyFont && Math.abs(centre - docCentre) <= bodyFont) {
              b.text = '' + b.text;
            }
          }
        }
        pageEmit.push({ pageNum, blocks, rightMargin, bodyLeft, paraLeftMargin });
      }

      // Geometry-driven cross-page join: a paragraph that runs off the bottom of one page
      // continues at the top of the next when that page's last body line FILLS the right
      // margin (it wrapped, it did not end) and lacks terminal punctuation, and the next
      // page opens with a body block at the left margin (not indented = not a new paragraph)
      // whose own first line also fills the measure (so a short running head is not taken
      // for the continuation). When so, the two blocks are emitted as one paragraph with the
      // page marker inline (stripped at display); otherwise the page starts a new block.
      // ── Section page-break detector ("major structural divisions begin on a new page") ──
      // A PDF has no explicit page-break marks, so recover the rule from geometry: a heading TIER that
      // CONSISTENTLY opens a page (its instance is the page's top block, near the top margin) AND
      // demonstrably follows early-ended pages (the prior page's lowest text sits well above the bottom
      // margin) is using the convention → emit U+E02A before EVERY instance so the paginator opens a fresh
      // page (EC1/EC2 already handle blank-page/lone-heading). Grouping per size-tier lets a chapter tier
      // and a sub-section tier be judged independently; the ≥2 early-prior corroboration blocks a false
      // positive on a book whose few headings only coincidentally open pages (those priors are FULL).
      {
        const _tierRe = new RegExp('[' + String.fromCharCode(0xE01B) + '-' + String.fromCharCode(0xE01F) + ']');
        const _pua = new RegExp('[' + String.fromCharCode(0xE000) + '-' + String.fromCharCode(0xF8FF) + ']', 'g');
        const _pageGeom = new Map<number, { ph: number; low: number }>();
        for (const buf of pageBuffers) if (buf.lines.length) _pageGeom.set(buf.pageNum, { ph: buf.pageHeight, low: Math.min(...buf.lines.map(l => l.pageY)) });
        const _heads: { b: EmitBlock; pageNum: number; tier: string; isOpener: boolean }[] = [];
        for (const pe of pageEmit) {
          const g = _pageGeom.get(pe.pageNum); if (!g) continue;
          const _tops = pe.blocks.map(b => b.topY).filter((v): v is number => v != null);
          const _pageTop = _tops.length ? Math.max(..._tops) : -Infinity;
          for (const b of pe.blocks) {
            if (b.role !== 'heading' || b.topY == null) continue;
            const _tm = b.text.match(_tierRe);
            // Split the tier by CASE: an all-caps (small-caps) heading is a different LEVEL from a mixed-case
            // one at the same size (Sovereign: small-caps "PREMONITIONS" page-break sub-sections vs italic
            // Title-Case "The Information Revolution" run-in sub-headings). Judged as separate convention groups.
            const _let = b.text.replace(_pua, '').replace(/[^A-Za-z]/g, '');
            const _caps = _let.length >= 3 && _let === _let.toUpperCase();
            _heads.push({ b, pageNum: pe.pageNum, tier: (_tm ? _tm[0] : 'none') + (_caps ? '' : '~'), isOpener: b.topY === _pageTop && (g.ph - b.topY) < g.ph * 0.20 });
          }
        }
        const _byTier = new Map<string, typeof _heads>();
        for (const h of _heads) { const a = _byTier.get(h.tier) || []; a.push(h); _byTier.set(h.tier, a); }
        const _fired = new Set<string>();
        for (const [tier, hs] of _byTier) {
          const _openers = hs.filter(h => h.isOpener);
          const _frac = hs.length ? _openers.length / hs.length : 0;
          let _early = 0;
          for (const h of _openers) { const prev = _pageGeom.get(h.pageNum - 1); if (prev && prev.low > prev.ph * 0.25) _early++; }
          // A page-break tier is CONSISTENTLY openers (frac high — the Sovereign's small-caps sub-sections are
          // 0.95; its mixed-case run-in sub-headings are 0.13) AND corroborated by ≥4 early-ended priors (so a
          // book whose headings only coincidentally open pages doesn't fire). Case-split makes frac meaningful.
          if (_frac >= 0.85 && _early >= 4) _fired.add(tier);
        }
        // Mark only the page-OPENERS of a firing tier — precise (no mid-content breaks) and still catches an
        // opener whose prior page coincidentally filled (Sovereign BANDWIDTH). enc() prepends the U+E02A.
        for (const h of _heads) if (_fired.has(h.tier) && h.isOpener) h.b.pbBreak = true;
      }
      let prevBlock: EmitBlock | null = null;
      let prevRightMargin = 0;
      for (const { pageNum, blocks, rightMargin, bodyLeft, paraLeftMargin } of pageEmit) {
        if (blocks.length === 0) continue;
        const marker = `[[PAGE ${pageNum}]]`;
        const first = blocks[0];
        // A prev line can end short NOT because the paragraph ended but because the next word was too long
        // to fit in the trailing space (a forced wrap, e.g. "…humongous green" | "landmass…"). Treat that
        // as a continuation too, so a mid-sentence page-seam wrap isn't split into a new paragraph. Estimate
        // the next word's width from its length; only fires on a modestly-short line (< ~one long word).
        const _seamTrail = prevBlock ? prevRightMargin - prevBlock.lastRightX : 0;
        const _seamNextWord = (first.text || '').replace(/^[\s -*_~`]+/u, '').split(/\s+/)[0] || '';
        const forcedWrapAtSeam = prevBlock !== null && !fillsMeasure(prevBlock.lastRightX, prevRightMargin)
          && _seamTrail > 0 && _seamTrail < bodyFont * 6 && _seamNextWord.length * bodyFont * 0.5 > _seamTrail;
        // A genuine continuation may OPEN with a short line (the wrapped sentence ends soon, or the line
        // just breaks early) — its first line need not fill the measure. Distinguish it from a short
        // running head (which firstFills guards against) by LENGTH: a continuation is a substantial body
        // block; a running head is a few words. Running heads are already stripped upstream, so this is a
        // light belt-and-suspenders relaxation, length-gated.
        const firstIsSubstantialBody = (first.text || '').replace(/[\s -*_~`]/gu, '').length > 60;
        // A FIGURE / TABLE CAPTION is a complete unit — it never "wraps" onto the next page. A caption set in
        // the body font (same size, often italic) reads as role:'body', ends without terminal punctuation
        // ("Figure 1-3. Agentic mesh, an ecosystem of agents"), and sits last on its page, so the geometric
        // seam-join wrongly glued it to the next page's opening body ("Agents—…"). Never continue FROM a
        // caption (leading PUA sentinels / emphasis tolerated before the "Figure N"/"Table N" label).
        const _isCaption = (b: EmitBlock | null): boolean => !!b && /^[\s-*_~]*(?:figure|table|fig\.|plate|exhibit|chart|diagram|scheme|listing)\s+\d/iu.test(b.text);
        const continues =
          prevBlock !== null &&
          pages.length > 0 &&
          !_isCaption(prevBlock) &&
          prevBlock.role === 'body' &&
          first.role === 'body' &&
          // A carryover — the top of this page is a hanging-list entry (dialogue turn / CIP field)
          // whose opener is on the previous page — always continues the previous page's last block,
          // even though a turn can span a page break AT a sentence boundary (so the prev tail ends
          // with terminal punctuation and its last line may be short). Otherwise, ordinary prose:
          // the prev line filled the measure and did not end a sentence, and this page opens at the
          // margin with a filled line (so a short running head is not taken for the continuation).
          (first.carryover ||
            ((fillsMeasure(prevBlock.lastRightX, prevRightMargin) || forcedWrapAtSeam) &&
              !endsWithTerminalPunctuation(prevBlock.lastText) &&
              // The continuation opens EITHER at the body margin (ordinary prose) OR at the previous
              // block's own continuation/indent tier (a bullet or block-indented item that wrapped
              // across the page break — its tail on this page sits at the indent, not the margin, so
              // the bodyLeft test alone dropped it and the tail rendered as a stray indented paragraph).
              (first.firstX <= bodyLeft + 8 ||
                (prevBlock.bodyX !== undefined && Math.abs(first.firstX - prevBlock.bodyX) <= 4)) &&
              (fillsMeasure(first.firstRightX, rightMargin) || firstIsSubstantialBody)));
        // Carry each block's geometry-decided role to the reader as a private-use sentinel
        // (U+E012 list, U+E013 heading; the reader strips them). A run of LEFT-column (col 0) blocks
        // immediately followed by RIGHT-column (col 1) blocks is a side-by-side TWO-COLUMN region:
        // encode it as U+E014 <left \u00B6s joined by U+E016> U+E015 <right \u00B6s> so the reader can lay the
        // two columns out next to each other (stacking on narrow screens). Everything else is normal.
        // pbBreak \u2192 prepend the U+E02A hard-break sentinel FIRST (before the E013 heading sentinel) so the
        // paginator breaks at position 0 and strips only E02A, leaving E013+tier+text intact (else the break
        // strands E013 on the prior page and the heading loses its role \u2192 renders un-bold).
        const enc = (b: EmitBlock): string => (b.pbBreak ? '' : '') + (b.role === 'list' ? '' : b.role === 'heading' ? '' : '') + b.text;
        type EmitUnit = { two: true; left: EmitBlock[]; right: EmitBlock[] } | { two: false; block: EmitBlock };
        const units: EmitUnit[] = [];
        for (let bi = 0; bi < blocks.length;) {
          if (blocks[bi].col === 0) {
            const left: EmitBlock[] = []; while (bi < blocks.length && blocks[bi].col === 0) left.push(blocks[bi++]);
            const right: EmitBlock[] = []; while (bi < blocks.length && blocks[bi].col === 1) right.push(blocks[bi++]);
            if (right.length) units.push({ two: true, left, right });
            else for (const b of left) units.push({ two: false, block: b });
          } else {
            units.push({ two: false, block: blocks[bi++] });
          }
        }
        units.forEach((unit, unitIndex) => {
          if (!('block' in unit)) {
            const text = '\uE014' + unit.left.map(enc).join('\uE016') + '\uE015' + unit.right.map(enc).join('\uE016');
            pages.push(unitIndex === 0 ? `${marker}\n${text}` : text);
            return;
          }
          const text = enc(unit.block);
          if (unitIndex === 0 && pages.length > 0 && prevBlock?.dataColumn && unit.block.dataColumn
            && Math.abs(first.firstX - prevBlock.firstX) <= bodyFont) {
            // A "YYYY: value" data column that STRADDLES a PDF page seam: the short remnant at the foot of the
            // previous page and its continuation opening this page are ONE tight column. The prose seam-merge
            // (`continues`) can't handle it — its gate needs the prev tail to FILL the measure (a data line ends
            // short by design) and its join glues with a SPACE (which would flatten the column into a run-on).
            // Merge into the previous paragraph with the tight U+E024 break instead, keeping the [[PAGE]] marker
            // inline at the seam for page-offset mapping (it's stripped for display like any mid-paragraph marker).
            // Gated on BOTH blocks being data columns at the SAME left edge, so only a genuine split column joins.
            pages[pages.length - 1] = `${pages[pages.length - 1]}${marker}${unit.block.text}`;
          } else if (unitIndex === 0 && continues) {
            // Merged continuation: drop its own leading block-indent NBSP run (it inherits the opener's
            // indent) so an indented item's page-wrapped tail doesn't leak an NBSP gap mid-sentence.
            // A page-spanning FIRST-LINE-INDENT paragraph: its lone first line at the previous page's bottom
            // couldn't be told from a block-indented line, so it got a leading block NBSP. The continuation
            // here opens at the body margin (flush), proving it's a first-line indent, so drop that NBSP from
            // the previous page's tail — the reader re-applies its own default first-line indent.
            // Use the TRUE margin (paraLeftMargin), NOT bodyLeft: on a definition-list page the indented
            // descriptions OUTNUMBER the flush terms so bodyLeft inverts to the description tier (x=90) and the
            // "opens at the margin" test wrongly fired for a block-INDENTED page-spanning desc (Agentic "Layer 3"),
            // stripping its indent NBSP → a spurious first-line indent. paraLeftMargin stays at the real margin (72).
            const _prevTail = first.firstX <= paraLeftMargin + 8
              ? pages[pages.length - 1].replace(/^((?:\[\[PAGE\s+\d+\]\]\n)?[\uE010-\uE019\uE01B-\uE023]*)\u00A0+(?=\S)/u, '$1')
              : pages[pages.length - 1];
            pages[pages.length - 1] = `${_prevTail} ${marker} ${unit.block.text.replace(/^[  \uE018\uE01B-\uE01F]+/u, '')}`;
          } else if (unitIndex === 0) {
            pages.push(`${marker}\n${text}`);
          } else {
            pages.push(text);
          }
        });
        prevBlock = blocks[blocks.length - 1];
        prevRightMargin = rightMargin;
      }

      // Normalise internal-link markup HERE, so the outline offsets below are computed
      // against the exact text that downstream (hydrateFileContext / the source cache) will
      // store. Otherwise sanitizeInternalLinkMarkup runs later, trims whitespace inside link
      // brackets, shifts every following character left, and the chapter offsets land a few
      // characters into each heading ("ACKNOWLEDGMENTS" → "NOWLEDGMENTS"). Idempotent, so the
      // later re-sanitisation is a no-op.
      // Render a link that is displayed AS its URL from the annotation's exact URL — the source
      // of truth pdf.js hands us — instead of rebuilding the visible string from glyphs. The
      // glyph display wraps across lines and pages, picks up justified spaces between pieces,
      // and can drop a leading character; the annotation URL has none of that.
      // (1) Collapse a run of adjacent link spans pointing to the same URL into one — a URL
      //     split across a line, a BLOCK boundary, or a page break (only whitespace and an
      //     optional "[[PAGE n]]" marker between them, so unrelated links can't be merged).
      // (2) Render a span that is the WHOLE URL (only spurious internal spaces differ) as the
      //     clean URL — NOT a fragment, which would otherwise be expanded to the full URL and
      //     duplicate its continuation ("…/HAI_AI-" -> full URL, leaving "Index-Report.pdf").
      // Custom-text links ("click here") and internal links (#anchor) are left untouched.
      const shownAsUrl = (label: string): boolean => /^["'(<]*\s*(?:https?:\/\/|www\.)/iu.test(label) || label.includes('://');
      // Compare on the DECODED form so a literal-paren label matches its %28/%29-encoded href.
      const sameUrl = (label: string, url: string): boolean =>
        showHref(label).replace(/\s+/gu, '').toLowerCase() === showHref(url).replace(/\s+/gu, '').toLowerCase();
      let assembled = pages.join('\n\n');
      let prevAssembled: string;
      do {
        prevAssembled = assembled;
        assembled = assembled.replace(
          // The continuation span can carry a leading block sentinel (e.g. the list marker
          // U+E012 when the URL resumes on a page whose first line is tagged as a list item);
          // tolerate and preserve it so the run still collapses across the page/block break.
          /\[([^\]\n]*)\]\(([^)\n]+)\)\s+(\[\[PAGE \d+\]\]\s+)?([\uE010-\uE013]?)\[([^\]\n]*)\]\(\2\)/gu,
          // Label decoded (literal parens shown), href kept encoded (survives markdown parsing).
          (m, l1: string, url: string, marker: string | undefined, sentinel: string | undefined, l2: string) =>
            (shownAsUrl(l1) || shownAsUrl(l2)) ? `${marker || ''}${sentinel || ''}[${showHref(url)}](${url})` : m,
        );
      } while (assembled !== prevAssembled);
      assembled = assembled.replace(
        /\[([^\]\n]*)\]\(([^)\n]+)\)/gu,
        (m, label: string, url: string) => (sameUrl(label, url) ? `[${showHref(url)}](${url})` : m),
      );
      // Strip piracy watermarks from the CONTENT here (before outline offsets are resolved below), so the
      // stored text — and thus SEARCH, TTS, translation, and any page-seam-glued case — is clean, not just
      // the render. Page markers are preserved, so offsets/pagination are unaffected in structure.
      let fullText = stripPiracyWatermarks(sanitizeInternalLinkMarkup(assembled));
      if (!fullText) throw new Error('No selectable text found in PDF.');

      // Re-attach a paragraph-LEADING footnote marker to the previous sentence. When a superscript
      // marker wraps to the start of the next line, extraction can leave it alone at a paragraph
      // start ("…created.\n\n[58](#pdffn-p443-y) Likewise…"), where the reader can't tell it from a
      // note-ENTRY label and renders it inert (unclickable). Move only a FORWARD marker — its dest
      // page is LATER than the marker's own page, so it's a genuine body reference — never a note
      // entry, whose injected link points at its own page (dest == current page). Done before the
      // outline offsets are computed, so no offset drifts. (Runs on the last "[[PAGE n]]" before the
      // marker to read the marker's page.)
      fullText = fullText.replace(
        /([.!?…”"’)])\n\n(\[(?:fn\s*)?[\divxlcdm]{1,4}\]\(#pdffn-p(\d+)-y[^)\n]*\))(\s+)/giu,
        (m, punct: string, link: string, destStr: string, _sp: string, offset: number, str: string) => {
          const before = str.slice(0, offset);
          const pages = before.match(/\[\[PAGE (\d+)\]\]/g);
          const markerPage = pages ? Number(pages[pages.length - 1].match(/\d+/)![0]) : 0;
          return Number(destStr) > markerPage ? `${punct}${link}\n\n` : m;
        },
      );

      // Anchor each outline entry to its exact heading offset: pick the line on the
      // destination page whose baseline Y is closest to the bookmark's Y, then locate that
      // line's text within the page's block in the extracted content. This separates
      // multiple bookmarks on one page and starts chapters at the heading rather than the
      // page top. When the heading can't be located (corrupt/short text), `offset` is left
      // undefined and the chapter falls back to the page-start marker downstream.
      // The start of the next FIGURE CLUSTER after `from` — a run of figures close together, i.e.
      // a photo-plate section. A lone figure inside prose (a chapter illustration) is not a
      // cluster, so this only fires on genuine plate sections. Returns undefined if none.
      const findFigureClusterStart = (from: number): number | undefined => {
        let idx = fullText.indexOf('[[FIG ', from);
        while (idx >= 0) {
          const next = fullText.indexOf('[[FIG ', idx + 6);
          if (next >= 0 && next - idx < 1500) return idx; // two figures within ~1.5k chars = a plate run
          idx = next;
        }
        return undefined;
      };

      // Pass 1: resolve each entry by its bookmark destination (trusted only when the heading there
      // matches the title) or, for broken bookmarks, by searching the content for the title itself.
      let lastResolvedOffset = 0; // outline entries are in reading order; re-anchor searches forward from here
      // The Contents/TOC region (its detected pages' offset span). A title-match landing HERE is a TOC LIST
      // ENTRY, not the real opener — reject it for an entry that doesn't itself live on a TOC page, so a
      // front-matter entry whose real target is an IMAGE (the title page has no heading text to match) isn't
      // pinned to its TOC line (which chopped the Contents chapter right after it, e.g. "Contents"+"Cover"
      // alone). Structural (page-based), so it also catches a Title-Case TOC the case-based prose gate can't.
      const _tocPageNums = new Set(pageBuffers.filter(b => (b as any).isTocPage).map(b => b.pageNum));
      let _tocStart = Infinity, _tocEnd = -Infinity;
      for (const pn of _tocPageNums) {
        const s = fullText.indexOf(`[[PAGE ${pn}]]`);
        if (s < 0) continue;
        _tocStart = Math.min(_tocStart, s);
        const e = fullText.indexOf('[[PAGE ', s + 1);
        _tocEnd = Math.max(_tocEnd, e < 0 ? fullText.length : e);
      }
      const prelim = outlineEntries.map(entry => {
        // (1) Destination-based resolution: find the heading on the bookmark's destination
        // page and locate it in the content. Reliable when the PDF carries proper /XYZ
        // destinations (e.g. Agentic Mesh) — separates same-page bookmarks by Y.
        let destOffset: number | undefined;
        let destHeadingText = '';
        const geom = pageLineGeom.get(entry.page);
        const blockStart = fullText.indexOf(`[[PAGE ${entry.page}]]`);
        if (geom && geom.length && blockStart >= 0) {
          // A /XYZ destination's Y is the line TOP (~one ascent above the baseline), so the
          // heading is the first line whose baseline sits at/just below it — not the
          // nearest baseline, which would pick the line above.
          const heading = entry.y == null
            ? geom[0]
            : (geom.reduce<{ y: number; text: string } | null>(
                (best, line) => (line.y <= entry.y! + 2 && (!best || line.y > best.y)) ? line : best,
                null,
              ) || geom[0]);
          // pageLineGeom captured the RAW line text, which carries emphasis markers (a bold heading is
          // stored as "**Title**"), but the assembled content STRIPS emphasis from heading blocks — so
          // an exact match failed for EVERY bold heading, all offsets fell back to the page-start
          // marker, and same-page bookmarks collapsed into one chapter (a section and its first topics
          // sharing a page merged). Match on the marker-stripped heading text.
          const needle = heading.text.replace(/[*_`~]/gu, '').trim();
          if (needle.length >= 3) {
            const nextBlock = fullText.indexOf('[[PAGE ', blockStart + 1);
            const within = fullText.indexOf(needle, blockStart);
            if (within >= 0 && (nextBlock < 0 || within < nextBlock)) {
              // `needle` is the MARKER-STRIPPED heading, so indexOf lands on the first title letter — AFTER
              // the block's leading run of role/size PUA sentinels + opening emphasis (`‹E013›‹E01F›**`) and
              // any link `[`. Anchoring there makes the chapter START mid-heading: the reader loses the
              // heading/size sentinels and the opening `**`, so the title renders as small un-bold body
              // ("INTRODUCTION**"). Snap the offset back over that leading markup to the true block start.
              const _lineFloor = Math.max(blockStart, fullText.lastIndexOf('\n', within - 1) + 1);
              let snap = within;
              while (snap > _lineFloor && /[*_~`\u00A0\uE000-\uF8FF[]/u.test(fullText[snap - 1])) snap--;
              destOffset = snap; destHeadingText = needle;
            }
          }
        }
        // (2) Title re-anchoring: trust the destination ONLY when the heading it points at actually
        // matches THIS entry's title. Broken bookmarks (z-library PDFs use /Fit destinations with no
        // Y, pointing at the wrong pages) resolve to a different chapter's heading — detect that
        // mismatch and locate the real opener by searching the content for the title itself, forward
        // from the previous entry (outline order is reliable even when the destinations are not).
        let offset: number | undefined;
        if (destOffset != null && headingMatchesTitle(destHeadingText, entry.title)) {
          offset = destOffset;
        } else {
          offset = findHeadingOffsetByTitle(fullText, entry.title, lastResolvedOffset);
          // A title-match landing in the Contents/TOC region is a TOC LIST ENTRY, not the real opener — drop
          // it for an entry that doesn't itself live on a TOC page; pass 2 places it by its own page marker.
          if (offset != null && offset >= _tocStart && offset < _tocEnd && !_tocPageNums.has(entry.page)) offset = undefined;
          // Only a FORWARD match (from the previous entry) is accepted — outline entries are in
          // reading order, so a title that only appears BEFORE the previous entry is a Contents/TOC
          // false match (the TOC lists every title once, and the tail entries are immediately followed
          // by front-matter prose that fools the prose gate). E.g. "Copyright" appears only in the TOC
          // here; refusing the backward match leaves it unresolved (dropped) rather than pinned to the
          // top of the book. No destOffset fallback either: a mismatched destination is an unreliable
          // /Fit pointer. Truly unresolved entries are handled in pass 2 (image-only plate sections).
        }
        if (offset != null) lastResolvedOffset = Math.max(lastResolvedOffset, offset);
        return { entry, offset };
      });

      // A RELIABLE outline has destination pages in non-decreasing reading order (proper /XYZ
      // destinations, e.g. Agentic Mesh / Singularity). A BROKEN one (z-library /Fit bookmarks, e.g.
      // Elon Musk) has pages that jump around — Title Page/Dedication/Ch1 all point at the same wrong
      // page. Only trust a bookmark's own PAGE destination for an unresolved entry when the whole
      // outline is monotonic; otherwise a broken pointer would drop the entry onto the wrong page.
      const outlineMonotonic =
        outlineEntries.length > 0 &&
        outlineEntries.every((e, i) => i === 0 || e.page >= outlineEntries[i - 1].page);
      // Pass 2: an entry still unresolved has no findable title. If it is an image-only plate section,
      // anchor it — in reading order — to the figure cluster that falls in its GAP between the nearest
      // resolved neighbours (so "Picture Section" lands with the plates before Appendix 1). Otherwise,
      // when the outline is reliable (monotonic pages), front matter whose title is NOT a heading
      // (Cover, Copyright, Title Page, Dedication) is anchored at its OWN bookmark page marker when
      // that offset falls inside the gap — so it survives as its own catalogue chapter instead of
      // dissolving into the next one (the first survivor's start is pulled to 0). A broken /Fit
      // bookmark (non-monotonic outline, or a page pointing OUTSIDE the gap) is still dropped, which
      // keeps it from splitting a real chapter. Bounding to the gap also stops an unanchorable entry
      // from greedily grabbing the one plate cluster 600k chars away.
      const outline: PdfOutlineItem[] = prelim.map((item, i) => {
        let offset = item.offset;
        if (offset == null) {
          let prevOff = 0;
          for (let j = 0; j < i; j++) { const o = prelim[j].offset; if (o != null && o > prevOff) prevOff = o; }
          let nextOff = fullText.length;
          for (let j = i + 1; j < prelim.length; j++) { const o = prelim[j].offset; if (o != null && o > prevOff && o < nextOff) nextOff = o; }
          const cluster = findFigureClusterStart(prevOff + 1);
          if (cluster != null && cluster < nextOff) offset = cluster;
          else if (outlineMonotonic) {
            let pageOff: number | null = null;
            for (let p = item.entry.page; p < item.entry.page + 12; p++) {
              const idx = fullText.indexOf(`[[PAGE ${p}]]`);
              if (idx >= 0) { pageOff = idx; break; }
            }
            if (pageOff != null && pageOff >= prevOff && pageOff < nextOff) offset = pageOff;
          }
        }
        // The resolved offset (a bookmark Y-destination or a page marker) lands on the heading's first
        // GLYPH — just AFTER the extractor's injected role/size sentinels (U+E013 heading + U+E01x tier)
        // that attach directly to the text with no newline between. That dropped the chapter's FIRST
        // heading line (e.g. the "CHAPTER 1" number) to body size while later heading lines kept their tier.
        // Snap the offset back over any immediately-preceding PUA sentinels so the opening heading keeps its
        // role + size. (Chapters are [offset[i], offset[i+1]) with shared boundaries, so this just moves the
        // boundary back onto the sentinels — no gap, overlap, or bleed into the previous chapter.)
        if (offset != null) { while (offset > 0) { const c = fullText.charCodeAt(offset - 1); if (c >= 0xE000 && c <= 0xF8FF) offset--; else break; } }
        return { title: item.entry.title, page: item.entry.page, level: item.entry.level, offset };
      });

      // Drop entries the passes could not place at all (broken bookmark, non-monotonic outline, page
      // outside the gap). Their offset stays undefined so buildChaptersFromOutline's own
      // `offset ?? offsetForPage(page)` fallback can't drop them onto a WRONG bookmark page and split a
      // real chapter. Every surviving entry now carries a real offset (a resolved heading, a figure
      // cluster, or — for reliable monotonic outlines — its in-gap page marker).
      const resolvedOutline = outline.filter(o => o.offset != null);

      // Caption-based missing-figure check (best-effort, never throws). Every "Figure N" / "Table N"
      // caption should have a captured [[FIG]] image on its page; a page with more such captions than
      // figures means the figure gate dropped an image (e.g. a pure-vector diagram the raster path
      // can't see, or a size just under the gate). Log it so missing figures surface during testing
      // instead of by eye. A mid-sentence reference ("…as shown in Figure 3-1.") is inside a prose
      // block, so the line-start anchor keeps it from counting as a caption.
      try {
        const pageMarks: { page: number; at: number }[] = [];
        for (const m of fullText.matchAll(/\[\[PAGE (\d+)\]\]/g)) pageMarks.push({ page: Number(m[1]), at: m.index ?? 0 });
        const capRe = /(?:^|\n)[ \t]*[-]?\*{0,2}(?:Figure|Table|Fig\.)\s+\d+(?:[-–.]\d+)?\s*[.:]/giu;
        const missing: string[] = [];
        for (let i = 0; i < pageMarks.length; i++) {
          const slice = fullText.slice(pageMarks[i].at, pageMarks[i + 1]?.at ?? fullText.length);
          const caps: string[] = [];
          for (const cm of slice.matchAll(capRe)) {
            const at = cm.index ?? 0;
            const lineEnd = slice.indexOf('\n', at + 1);
            const line = slice.slice(at, lineEnd < 0 ? undefined : lineEnd).replace(/[-*]/g, '').replace(/\s+/g, ' ').trim();
            // A real caption is a SHORT standalone line; a prose sentence that merely BEGINS "Figure
            // N." (a forward reference at a block start) is a long block line — skip it so it isn't
            // miscounted as a caption without an image.
            if (line.length <= 160) caps.push(line.slice(0, 60));
          }
          const figCount = (slice.match(/\[\[FIG /g) || []).length;
          if (caps.length > figCount) missing.push(`p${pageMarks[i].page}: ${caps.length} caption(s) [${caps.join(' | ')}] vs ${figCount} image(s)`);
        }
        if (missing.length) console.warn(`[DecodEbook figure-check] ${missing.length} page(s) have a figure/table caption with no captured image:\n${missing.join('\n')}`);
      } catch { /* diagnostic only — never block extraction */ }

      // Justified vs ragged is computed earlier (before the per-page splitter) so both the splitter and
      // the reader use the same verdict; sourceJustified holds it. Justified books fill the margin on
      // ~85–98% of lines; a ragged-left book (e.g. Elon Musk) on ~40%; too few samples → undefined.
      // First-line-indent vs block style (from justified-page paragraph geometry). CONSERVATIVE: only
      // 'false' (block style → reader renders flush) fires, and only with a clear majority of flush
      // paragraphs over enough samples; anything ragged/uncertain stays undefined so the reader keeps its
      // default first-line indent (a real first-line-indent novel is never mis-flagged as block style).
      const sourceFirstLineIndent = bodyBlkTotal >= 20
        ? bodyBlkFirstLineIndented / bodyBlkTotal > 0.4
        : undefined;
      // Calculated first-line-indent MAGNITUDE (em, vs body font): the MEDIAN measured indent so the
      // reader reproduces the printed indent instead of a fixed 1.75em (this book prints 1.0em — the
      // reader default read ~2x too deep, most visibly on the small chapter-end notes). Applied as em by
      // the reader, one value scales to body AND note text. Clamped to a sane band; undefined (too few
      // samples) → reader keeps its 1.75em default.
      const _medEm = (arr: number[], lo: number, hi: number, min: number): number | undefined => {
        const s = [...arr].sort((a, b) => a - b);
        return s.length >= min ? Math.min(hi, Math.max(lo, s[Math.floor(s.length / 2)])) : undefined;
      };
      const sourceFirstLineIndentEm = _medEm(firstLineIndentEms, 0.6, 2.5, 8);
      // Per-type hanging-indent magnitudes (median measured, clamped, enough samples) — undefined falls
      // back to the reader's constant (bullet 1em, numbered 1.5em, index 1em).
      const _hangs = {
        bullet: _medEm(bulletHangEms, 0.4, 2.0, 5),
        list: _medEm(listHangEms, 0.6, 3.0, 6),
        index: _medEm(indexHangEms, 0.4, 2.5, 6),
      };
      const sourceHangs = (_hangs.bullet ?? _hangs.list ?? _hangs.index) !== undefined ? _hangs : undefined;
      return { content: fullText, outline: resolvedOutline, title: metaTitle, figures: allFigures, justified: sourceJustified, firstLineIndent: sourceFirstLineIndent, firstLineIndentEm: sourceFirstLineIndentEm, hangs: sourceHangs };
    } catch (e) {
      console.error('PDF processing error', e);
      throw new Error('Could not extract text from this PDF. Scanned/image-only PDFs need OCR before upload.');
    }
  };

  const reextractingRef = useRef<Set<string>>(new Set()); // book ids currently auto-re-extracting (dedupe)
  const [reextractFailedId, setReextractFailedId] = useState<string | null>(null); // active book with no stored original

  // Re-extract a book from its stored ORIGINAL file when its extraction engine is stale — no manual
  // re-upload. Preserves the book id (reading position + derived caches). Returns the fresh item, or null
  // to fall back to the re-upload prompt (no stored original, or extraction threw). Mirrors the pdf/epub
  // branches of handleFileUpload + finalizeUpload's chapter build (kept in sync deliberately).
  const reextractBook = async (item: LibraryItem): Promise<LibraryItem | null> => {
    const kind = item.fileContext.sourceKind;
    if (kind !== 'pdf' && kind !== 'epub') return null;
    let orig: Awaited<ReturnType<typeof getFile>> = null;
    try { orig = await getFile(originalFileKey(item.book.id)); } catch { orig = null; }
    if (!orig?.blob) return null; // no stored original → A fallback (prompt)
    try {
      const meta = orig.metadata as any;
      const file = new File([orig.blob], meta?.filename || `book.${kind}`, { type: meta?.mimeType || '' });
      let context: FileContext;
      let figures: ExtractedFigure[] | undefined;
      if (kind === 'epub') {
        const { content, outline, title, figures: f, anchors, justified, firstLineIndent, firstLineIndentEm } = await processEpub(file);
        context = { content, mimeType: 'text/plain', isText: true, sourceKind: 'epub', sourceExtractorVersion: EPUB_TEXT_EXTRACTION_VERSION, pdfOutline: outline.length ? outline : undefined, epubAnchors: Object.keys(anchors).length ? anchors : undefined, docTitle: title, sourceJustified: justified, sourceFirstLineIndent: firstLineIndent, sourceFirstLineIndentEm: firstLineIndentEm };
        figures = f.length ? f : undefined;
      } else {
        const { content, outline, title, figures: f, justified, firstLineIndent, firstLineIndentEm, hangs } = await processPdf(file);
        context = { content, mimeType: 'text/plain', isText: true, sourceKind: 'pdf', sourceExtractorVersion: PDF_TEXT_EXTRACTION_VERSION, pdfOutline: outline, docTitle: title, sourceJustified: justified, sourceFirstLineIndent: firstLineIndent, sourceFirstLineIndentEm: firstLineIndentEm, sourceHangs: hangs };
        figures = f.length ? f : undefined;
      }
      if (figures?.length) context = { ...context, pdfFigures: figures.map(({ blob, ...m }) => m) };
      const preparedContext = hydrateFileContext(context);
      const structure = await analyzeBookStructure(preparedContext);
      structure.id = item.book.id;                              // PRESERVE id → keep reading position + caches
      structure.title = context.docTitle || item.book.title;    // keep the established title (avoid drift)
      const useOutline =
        (preparedContext.sourceKind === 'pdf' && isUsablePdfOutline(preparedContext.content, preparedContext.pdfOutline)) ||
        (preparedContext.sourceKind === 'epub' && isUsableEpubOutline(preparedContext.pdfOutline));
      const indexedChapters = useOutline
        ? buildChaptersFromOutline(preparedContext.content, preparedContext.pdfOutline!)
        : preparedContext.isText
        ? splitDetectedBackMatter(preparedContext.content, buildSourceIndexedChapters(preparedContext.content, expandTopicSectionsIntoChapters(preparedContext.content, buildSourceIndexedChapters(preparedContext.content, structure.chapters), 10)))
        : structure.chapters;
      if (figures?.length) {
        const ts = Date.now();
        await Promise.all(figures.map(f => saveFile(buildCacheKey(structure.id, 0, 'figure-image', f.id), f.blob, { filename: `${f.id}.jpg`, mimeType: f.mimeType, timestamp: ts, bookId: structure.id, chapterId: 0, componentSource: 'Reextract', fileType: 'figure-image' }).catch(() => {})));
      }
      const newItem: LibraryItem = { book: { ...structure, chapters: indexedChapters }, fileContext: preparedContext, uploadDate: item.uploadDate };
      await saveSourceToCache(newItem).catch(() => {});
      console.log('[reextract] ok', kind, JSON.stringify(item.book.title), '->', newItem.book.chapters.length, 'chapters, ver', context.sourceExtractorVersion);
      return newItem;
    } catch (e) {
      console.warn('[reextract] failed', e);
      return null;
    }
  };

  // Open a book — auto-re-extracting first if its engine is stale and we still hold its original file
  // (B). If re-extraction isn't possible (no original / failure), open as-is so the render path surfaces
  // the re-upload prompt (A fallback).
  const openBook = async (item: LibraryItem) => {
    let target = item;
    if (isStaleExtraction(item.fileContext.sourceKind, item.fileContext.sourceExtractorVersion)) {
      setIsProcessing(true);
      const fresh = await reextractBook(item);
      setIsProcessing(false);
      if (fresh) { setLibrary(prev => prev.map(b => b.book.id === item.book.id ? fresh : b)); target = fresh; }
    }
    setActiveBookId(target.book.id);
    if (target.book.chapters.length > 0) { setActiveChapterPageTarget('first'); setActiveChapterId(target.book.chapters[0].id); }
    setShowLibraryList(false);
  };

  // Auto re-extract the ACTIVE book when its content was dropped as stale (covers the on-reload restore
  // path, which doesn't go through openBook) — from the stored original, fresh content in place. If there's
  // no original (re-extract returns null), flag it so the reader shows a re-upload hint, not an endless spinner.
  useEffect(() => {
    if (!activeBookId) return;
    const item = library.find(b => b.book.id === activeBookId);
    if (!item || item.fileContext.content) return;
    if (!isStaleExtraction(item.fileContext.sourceKind, item.fileContext.sourceExtractorVersion)) return;
    if (reextractingRef.current.has(activeBookId)) return;
    reextractingRef.current.add(activeBookId);
    (async () => {
      const fresh = await reextractBook(item);
      if (fresh) setLibrary(prev => prev.map(b => b.book.id === item.book.id ? fresh : b));
      else setReextractFailedId(item.book.id);
      reextractingRef.current.delete(item.book.id);
    })();
  }, [activeBookId, library]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const allowedExtensions = ['.pdf', '.txt', '.md', '.html', '.xml', '.epub'];
    const hasAllowedExt = allowedExtensions.some(ext => file.name.toLowerCase().endsWith(ext));

    if (!hasAllowedExt) {
      setError("Supported formats: PDF, EPUB, TXT, MD, HTML.");
      return;
    }

    if (!file.type.startsWith('text/') && !file.name.toLowerCase().endsWith('.epub') && file.size > 50 * 1024 * 1024) {
       setError("PDF too large (>50MB). Please optimize or split the file.");
       return;
    }

    setIsProcessing(true);
    setError(null);

    const isEpub = file.name.toLowerCase().endsWith('.epub');
    const isTextBased = file.type.startsWith('text/') ||
                        ['.txt', '.md', '.html', '.xml'].some(ext => file.name.toLowerCase().endsWith(ext));

    const finalizeUpload = async (context: FileContext, pdfFigures?: ExtractedFigure[]) => {
        try {
            // Carry the figure MANIFEST (no bytes) on the context so the reader can find them; the
            // bytes are cached below once the book id exists.
            if (pdfFigures?.length) context = { ...context, pdfFigures: pdfFigures.map(({ blob, ...meta }) => meta) };
            // Record the uploaded file's NAME so re-upload dedup has a stable identity even if the extracted
            // title later shifts (a metadata/inference tweak) — the same file always replaces its own entry.
            context = { ...context, sourceFileName: context.sourceFileName || file.name };
            const preparedContext = hydrateFileContext(context);
            const structure = await analyzeBookStructure(preparedContext);
            // Prefer the PDF's own metadata Title over the one inferred from the first content
            // line. Set on `structure` so the display title AND the re-upload dedup (which matches
            // by structure.title) stay consistent.
            if (context.docTitle) structure.title = context.docTitle;
            // Phase A (PDF only): when the PDF carries a usable outline (bookmarks), build
            // chapters directly from it — the page destinations are authoritative, so no
            // heuristic title-to-offset scoring is needed. Any PDF without a usable outline,
            // and all EPUB/text sources, keep the existing pipeline unchanged.
            // EPUB carries the same authoritative outline (nav/NCX, offsets pre-resolved) → same builder.
            const useOutline =
              (preparedContext.sourceKind === 'pdf' && isUsablePdfOutline(preparedContext.content, preparedContext.pdfOutline)) ||
              (preparedContext.sourceKind === 'epub' && isUsableEpubOutline(preparedContext.pdfOutline));
            const indexedChapters = useOutline
              ? buildChaptersFromOutline(preparedContext.content, preparedContext.pdfOutline!)
              : preparedContext.isText
              ? splitDetectedBackMatter(
                  preparedContext.content,
                  buildSourceIndexedChapters(
                    preparedContext.content,
                    expandTopicSectionsIntoChapters(
                      preparedContext.content,
                      buildSourceIndexedChapters(preparedContext.content, structure.chapters),
                      10
                    )
                  )
                )
              : structure.chapters;
            // DEV capture for the chapter-boundary regression harness (scripts/regression-chapters.mjs):
            // localStorage.dbgCaptureChapters='1' downloads {mode, content, outline?, llmChapters?} so a REAL
            // book becomes a golden fixture (tests/fixtures/chapters/). Off by default; never affects users.
            try {
              if (typeof localStorage !== 'undefined' && localStorage.getItem('dbgCaptureChapters') === '1') {
                const fx = useOutline
                  ? { mode: 'outline', content: preparedContext.content, outline: preparedContext.pdfOutline }
                  : { mode: 'llm', content: preparedContext.content, llmChapters: structure.chapters };
                const url = URL.createObjectURL(new Blob([JSON.stringify(fx)], { type: 'application/json' }));
                const a = document.createElement('a');
                a.href = url; a.download = `${(structure.title || 'book').replace(/\W+/g, '_').slice(0, 30)}.chapters.json`;
                a.click(); URL.revokeObjectURL(url);
              }
            } catch { /* capture is best-effort */ }
            const newItem: LibraryItem = {
                book: { ...structure, chapters: indexedChapters },
                fileContext: preparedContext,
                uploadDate: Date.now()
            };
            // Persist the extracted figure images to the file cache, keyed by bookId + figure id, so
            // the reader can load each [[FIG id]] on demand. Best-effort: a cache miss just hides a
            // figure, it never blocks the upload.
            if (pdfFigures?.length) {
              const ts = Date.now();
              await Promise.all(pdfFigures.map(f =>
                saveFile(buildCacheKey(structure.id, 0, 'figure-image', f.id), f.blob, {
                  filename: `${f.id}.jpg`, mimeType: f.mimeType, timestamp: ts, bookId: structure.id,
                  chapterId: 0, componentSource: 'PDF_Extraction', fileType: 'figure-image',
                }).catch(() => {})
              ));
            }
            // Re-upload replaces any existing copy of the same book (matched by title AND source
            // format) so a stale entry — chapters built by an older extraction engine — can't linger
            // beside the fresh one. (structure.id is a random UUID per upload, so it can't match;
            // title+format is the stable identity across re-uploads.) The format is part of the
            // identity so a PDF and an EPUB of the same title are DIFFERENT files that coexist —
            // re-uploading the PDF replaces the PDF, uploading the EPUB adds a second entry. Purge the
            // superseded copy's cache and cloud rows too, not just the in-memory list.
            const bookIdentity = (title?: string, kind?: string) =>
              `${(title || '').trim().toLowerCase()} ${kind || ''}`;
            const newBookTitle = (structure.title || '').trim().toLowerCase();
            const newBookIdentity = bookIdentity(structure.title, preparedContext.sourceKind);
            const newFileName = (preparedContext.sourceFileName || '').trim().toLowerCase();
            const newKind = preparedContext.sourceKind || '';
            // A re-upload REPLACES the same book. Either matcher supersedes: (1) title+format — the stable
            // identity; (2) uploaded FILENAME+format — so the same file replaces its own entry even when a
            // later title-extraction tweak shifts the title (which title-only dedup misses, piling up dupes).
            // A PDF and an EPUB of one book stay separate (format differs).
            const sameBook = (item: LibraryItem): boolean =>
              (!!newBookTitle && bookIdentity(item.book.title, item.fileContext.sourceKind) === newBookIdentity)
              || (!!newFileName && (item.fileContext.sourceFileName || '').trim().toLowerCase() === newFileName && (item.fileContext.sourceKind || '') === newKind);
            if (newBookTitle || newFileName) {
              library
                .filter(sameBook)
                .forEach(superseded => {
                  if (currentUser) deleteBookFromCloud(currentUser.id, superseded.book.id).catch(() => {});
                  // Purge the WHOLE superseded copy's cache — not just its source file. Otherwise its derived
                  // files (translations, audio, podcasts, …) orphan under a new bookId on every re-upload and
                  // pile up as duplicate rows in the Generated Files panel.
                  clearBook(superseded.book.id).catch(() => {});
                });
            }
            await saveSourceToCache(newItem);
            // Keep the ORIGINAL uploaded file so a future extractor bump can auto-re-extract without a manual
            // re-upload. Best-effort: a save failure (e.g. IndexedDB quota) just leaves this book on the
            // re-upload-prompt fallback. Only pdf/epub carry a structured extractor that can go stale.
            if (preparedContext.sourceKind === 'pdf' || preparedContext.sourceKind === 'epub') {
              saveFile(originalFileKey(structure.id), file, {
                filename: file.name,
                mimeType: file.type || (preparedContext.sourceKind === 'epub' ? 'application/epub+zip' : 'application/pdf'),
                timestamp: Date.now(), bookId: structure.id, chapterId: SOURCE_CACHE_CHAPTER_ID,
                componentSource: 'OriginalFile', fileType: 'original-file',
              }).catch(() => {});
            }
            setLibrary(prev => [newItem, ...prev.filter(item => !sameBook(item))]);
            setActiveBookId(structure.id);
            if (structure.chapters.length > 0) {
              setActiveChapterPageTarget('first');
              setActiveChapterId(structure.chapters[0].id);
            }
            setPendingLanguagePromptBookId(structure.id);
            setShowLibraryList(false);
            trackBookAction('upload', { title: structure.title, chapter_count: structure.chapters.length, file_size: file.size, format: file.name.split('.').pop() }, structure.id);
            if (currentUser) saveBookToCloud(currentUser.id, newItem).catch(() => {});
        } catch (err: any) {
            console.error("Analysis Error:", err);
            setError("Decoding failed. " + (err.message || "The file might be too complex or the model is busy."));
        } finally {
            setIsProcessing(false);
        }
    };

    if (isEpub) {
       try {
         const { content: textContent, outline: epubOutline, title: epubDocTitle, figures: epubFigures, anchors: epubAnchors, justified: epubJustified, firstLineIndent: epubFirstLineIndent, firstLineIndentEm: epubFirstLineIndentEm } = await processEpub(file);
         await finalizeUpload({
            content: textContent,
            mimeType: 'text/plain',
            isText: true,
            sourceKind: 'epub',
            sourceExtractorVersion: EPUB_TEXT_EXTRACTION_VERSION,
            pdfOutline: epubOutline.length ? epubOutline : undefined,
            epubAnchors: Object.keys(epubAnchors).length ? epubAnchors : undefined,
            docTitle: epubDocTitle,
            sourceJustified: epubJustified,
            sourceFirstLineIndent: epubFirstLineIndent,
            sourceFirstLineIndentEm: epubFirstLineIndentEm,
         }, epubFigures.length ? epubFigures : undefined);
       } catch (err: any) {
         setError(err.message || "Failed to process EPUB.");
         setIsProcessing(false);
       }
       return;
    }

    if (file.name.toLowerCase().endsWith('.pdf')) {
	       try {
	         const { content: textContent, outline: pdfOutline, title: docTitle, figures, justified, firstLineIndent, firstLineIndentEm, hangs } = await processPdf(file);
	         await finalizeUpload({
            content: textContent,
            mimeType: 'text/plain',
            isText: true,
            sourceKind: 'pdf',
            sourceExtractorVersion: PDF_TEXT_EXTRACTION_VERSION,
            pdfOutline,
            docTitle,
            sourceJustified: justified,
            sourceFirstLineIndent: firstLineIndent,
            sourceFirstLineIndentEm: firstLineIndentEm,
            sourceHangs: hangs,
         }, figures);
       } catch (err: any) {
         setError(err.message || "Failed to process PDF.");
         setIsProcessing(false);
       }
       return;
    }

    const reader = new FileReader();

    reader.onerror = () => {
      console.error("FileReader error:", reader.error);
      setError("Failed to read file. It may be too large for this device.");
      setIsProcessing(false);
    };

    if (isTextBased) {
      reader.onload = async (e) => {
        const content = e.target?.result as string;
        await finalizeUpload({ content, mimeType: 'text/plain', isText: true, sourceKind: 'text' });
      };
      reader.readAsText(file);
    } else {
      reader.onload = async (e) => {
        try {
          const buffer = e.target?.result as ArrayBuffer;
          const bytes = new Uint8Array(buffer);
          let binary = '';
          const CHUNK = 8192;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any);
          }
          const base64 = btoa(binary);
          await finalizeUpload({ content: base64, mimeType: 'application/pdf', isText: false });
        } catch (err: any) {
          console.error("PDF encoding error:", err);
          setError("Failed to encode PDF. Try a smaller file or convert to EPUB/TXT.");
          setIsProcessing(false);
        }
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const toggleBookmark = (chapterId: number) => {
    if (!activeBookId) return;
    setLibrary(prev => {
      const updated = prev.map(item => {
        if (item.book.id === activeBookId) {
            const bookmarks = item.book.bookmarks || [];
            const isBookmarked = bookmarks.includes(chapterId);
            const newBookmarks = isBookmarked
                ? bookmarks.filter(id => id !== chapterId)
                : [...bookmarks, chapterId];
            const newItem = { ...item, book: { ...item.book, bookmarks: newBookmarks } };
            if (currentUser) saveBookToCloud(currentUser.id, newItem).catch(() => {});
            return newItem;
        }
        return item;
      });
      return updated;
    });
  };

  const renderContent = () => {
    // GEN_FILES is no longer a main-content tab — it opens as a modal (isFilesOpen) from the sidebar.
    if (activeTab === Tab.NOTEBOOK) {
        return (
            <Notebook
                items={notebook}
                onDelete={handleDeleteNotebookItem}
                onBulkDelete={handleBulkDeleteNotebookItems}
                onUpdateComment={handleUpdateNotebookComment}
                onBatchUpdateDefinitions={handleBatchUpdateDefinitions}
                settings={settings}
                activeChapter={activeChapter}
                bookTitle={activeBook?.title}
                bookId={activeBookId || undefined}
            />
        );
    }

    if (!activeChapter || !activeFileContext) return null;
    // A stale book's content was dropped pending auto re-extraction (see the effect above). Never render a
    // reader with no content — it reads content.length and crashes. Show a spinner while re-extracting from
    // the stored original, or a re-upload hint if there's no original (re-extract flagged it failed).
    if (!activeFileContext.content) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-6 text-zinc-400 px-6 text-center">
          {reextractFailedId === activeBookId ? (
            <>
              <p className="text-sm">This book was extracted by an older engine and its original file isn't stored. Re-upload it to refresh — it replaces this copy, no need to delete anything first.</p>
              <button onClick={() => { setActiveBookId(null); setShowLibraryList(false); setView(AppView.UPLOAD); }} className="px-4 py-2 rounded-lg border border-neon-cyan/40 hover:bg-neon-cyan/10 text-neon-cyan text-sm">Re-upload this book</button>
            </>
          ) : (
            <Loader text="PREPARING_BOOK..." />
          )}
        </div>
      );
    }

    let content;
    switch (activeTab) {
      case Tab.AUDIOBOOK:
        content = <AudioBook chapter={activeChapter} allChapters={activeBook?.chapters || []} fileContext={activeFileContext} settings={settings} onSettingsUpdate={setSettings} bookId={activeBookId!} bookTitle={activeBook?.title} initialPageTarget={activeChapterPageTarget} onPageSizeComputed={reportReaderSize} onReadingPositionChange={handleReadingPositionChange} onChapterChange={(chapterId, pageTarget = 'first') => { setActiveChapterPageTarget(pageTarget); setActiveChapterId(chapterId); if (currentUser && activeBookId) debouncedReadingSync(currentUser.id, activeBookId, chapterId); }} />;
        break;
      case Tab.PODCAST:
        content = <PodcastPlayer chapter={activeChapter} allChapters={activeBook?.chapters || []} fileContext={activeFileContext} settings={settings} bookId={activeBookId!} bookTitle={activeBook?.title} />;
        break;
      case Tab.CONCEPTS:
        content = <Visualizer chapter={activeChapter} allChapters={activeBook?.chapters || []} fileContext={activeFileContext} bookId={activeBookId!} bookTitle={activeBook?.title} />;
        break;
      case Tab.ANIMATION:
        content = <VideoSummary chapter={activeChapter} allChapters={activeBook?.chapters || []} fileContext={activeFileContext} bookId={activeBookId!} bookTitle={activeBook?.title} />;
        break;
      default:
        content = null;
    }

    return (
      <div key={`${activeBookId}-${activeChapter.id}-${activeTab}`} className="h-full animate-fade-in">
        <ErrorBoundary>
            <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader text="LOADING_MODULE..." /></div>}>
                {content}
            </Suspense>
        </ErrorBoundary>
      </div>
    );
  };

  const closeSidebarMobile = () => { if (window.innerWidth < 768) setSidebarOpen(false); };

  const handleReadingPositionChange = useCallback((target: ReaderPageTarget) => {
    if (activeBookId && activeChapterId != null) readingPositionRef.current.set(`${activeBookId}:${activeChapterId}`, target);
  }, [activeBookId, activeChapterId]);

  const switchTab = (tab: Tab) => {
    trackNavigation('module_switch', { from_module: activeTab, to_module: tab });
    // Returning to the reader: restore the page we were reading (the reader remounts on tab switch, so
    // its internal page state is otherwise lost and it would reopen at page 1).
    if (tab === Tab.AUDIOBOOK && activeBookId && activeChapterId != null) {
      const stored = readingPositionRef.current.get(`${activeBookId}:${activeChapterId}`);
      if (stored) setActiveChapterPageTarget(stored);
    }
    setActiveTab(tab);
  };
  const continueAfterLanguagePrompt = () => {
    setPendingLanguagePromptBookId(null);
    setView(AppView.DASHBOARD);
  };

  if (!configReady) {
    return (
      <div className="min-h-screen bg-void-0 flex items-center justify-center">
        <div className="text-neon-cyan font-tech text-xs tracking-[0.3em] animate-pulse uppercase">Initializing_System...</div>
      </div>
    );
  }

  if (isSupabaseConfigured() && !authGatePassed) {
    return (
      <ErrorBoundary>
        <AuthGate
          onAuthChange={(user) => { if (user) { setCurrentUser(user); setAuthGatePassed(true); } }}
          onSkip={() => { setAuthGatePassed(true); localStorage.setItem('auth_gate_skipped', '1'); }}
        />
      </ErrorBoundary>
    );
  }

  if (view === AppView.LANDING) {
    return (
      <>
        <LandingPage
          variant={landingVariant}
          onEnterApp={() => setView(AppView.UPLOAD)}
          onSignIn={() => setIsAccountOpen(true)}
        />
        <AccountPanel
          isOpen={isAccountOpen}
          onClose={() => setIsAccountOpen(false)}
          user={currentUser}
          onAuthChange={setCurrentUser}
          proPriceId={localStorage.getItem('stripe_pro_price_id') || ''}
          proAnnualPriceId={localStorage.getItem('stripe_pro_annual_price_id') || ''}
        />
      </>
    );
  }

  if (view === AppView.UPLOAD) {
    return (
      <div className="min-h-screen bg-void-0 bg-grid flex flex-col items-center justify-center p-4 md:p-6 relative overflow-hidden font-tech text-left">
        <div className="absolute top-8 left-8 w-24 h-24 border-l border-t border-zinc-800 rounded-tl-lg pointer-events-none hidden md:block"></div>
        <div className="absolute bottom-8 right-8 w-24 h-24 border-r border-b border-zinc-800 rounded-br-lg pointer-events-none hidden md:block"></div>

        <div className="z-10 max-w-lg w-full text-center space-y-8 md:space-y-12">
          <div className="space-y-2 animate-fade-in-up text-center">
             <div className="flex items-center justify-center gap-2 mb-4">
                <Terminal size={28} className="text-neon-cyan md:w-8 md:h-8" />
             </div>
            <h1 className="text-4xl md:text-7xl font-bold tracking-tighter text-white drop-shadow-[0_0_25px_rgba(0,243,255,0.3)]">
              Decod<span className="text-neon-cyan">Ebook</span>
            </h1>
            <p className="text-zinc-500 tracking-[0.2em] text-[10px] md:text-xs uppercase">
              V.4.2 // Neural Text Decoding Interface
            </p>
          </div>

          <div className="relative group animate-fade-in-up hud-border bg-void-1 p-6 md:p-10 transition-all duration-300 hover:shadow-[0_0_30px_rgba(0,243,255,0.1)]" style={{ animationDelay: '0.1s' }}>
              {isProcessing ? (
                <Loader text="DECODING_SOURCE..." />
              ) : (
                <div className="relative flex flex-col items-center justify-center space-y-8">
                  <div className="relative">
                    <div className="w-32 h-32 content-panel rounded-full flex items-center justify-center group-hover:border-neon-cyan transition-all duration-300">
                        <Upload className="w-12 h-12 text-zinc-600 group-hover:text-neon-cyan transition-colors" />
                    </div>
                    <div className="absolute -inset-2 border border-dashed border-zinc-800 rounded-full animate-spin-slow pointer-events-none group-hover:border-neon-cyan/30"></div>
                  </div>
                  <div className="space-y-2 text-center">
                    <p className="text-neon-cyan font-bold uppercase tracking-widest text-sm animate-pulse">Initialize Upload</p>
                    <p className="text-[10px] text-zinc-600 font-mono">SUPPORTED PROTOCOLS: PDF / EPUB / TXT / MD</p>
                  </div>
                  <input
                    id="book-upload"
                    name="book-upload"
                    type="file"
                    accept=".pdf,.txt,.md,.html,.xml,.epub"
                    onChange={handleFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                </div>
              )}
          </div>

          {library.length > 0 && (
             <button 
                onClick={() => setView(AppView.DASHBOARD)}
                className="text-zinc-500 hover:text-neon-cyan text-xs font-mono uppercase tracking-widest transition-colors flex items-center gap-2 mx-auto border border-transparent hover:border-neon-cyan/30 px-4 py-2 rounded-sm"
             >
                <LibraryIcon size={14} />
                Access_Data_Bank [{library.length}]
             </button>
          )}
          {error && <p className="text-neon-red text-xs font-mono border border-neon-red/30 p-2 bg-neon-red/5">{error}</p>}
        </div>
        {pendingLanguagePromptBookId && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in">
            <div className="w-full max-w-md bg-void-1 border border-zinc-800 rounded-lg shadow-[0_0_50px_rgba(0,243,255,0.08)] overflow-hidden text-left">
              <div className="h-[2px] bg-gradient-to-r from-neon-cyan to-neon-red" />
              <div className="p-6 space-y-5">
                <div className="space-y-2">
                  <div className="text-[10px] font-mono text-neon-cyan uppercase tracking-[0.3em]">Translation_Default</div>
                  <h2 className="text-2xl font-black text-white uppercase tracking-tight">Choose Target Language</h2>
                  <p className="text-xs text-zinc-500 leading-relaxed font-mono">
                    This becomes the default translated layer for this and future books until you change it again.
                  </p>
                </div>
                <select
                  value={settings.targetLanguage}
                  onChange={(e) => setSettings(prev => ({ ...prev, targetLanguage: e.target.value }))}
                  className="w-full bg-void-0 border border-zinc-800 text-neon-cyan font-mono text-xs uppercase focus:border-neon-cyan outline-none rounded-sm px-4 py-3 transition-all cursor-pointer"
                >
                  {TARGET_LANGUAGES.map(language => (
                    <option key={language} value={language}>{language}</option>
                  ))}
                </select>
                <button
                  onClick={continueAfterLanguagePrompt}
                  className="w-full py-3 bg-neon-cyan text-black font-black uppercase tracking-[0.25em] text-xs rounded-sm hover:bg-white transition-colors"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-void-0 bg-grid text-zinc-300 overflow-hidden font-sans relative text-left" style={{ '--content-font': settings.font ? `"${settings.font}", sans-serif` : 'inherit' } as React.CSSProperties}>
      <GlobalContextLayer onAddToNotebook={handleAddToNotebook} activeLanguage={settings.targetLanguage} />
      <AIAssistant
        fileContext={activeFileContext}
        bookTitle={activeBook?.title}
        bookId={activeBook?.id}
      />
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdate={setSettings}
      />
      <AccountPanel
        isOpen={isAccountOpen}
        onClose={() => setIsAccountOpen(false)}
        user={currentUser}
        onAuthChange={setCurrentUser}
        proPriceId={localStorage.getItem('stripe_pro_price_id') || ''}
        proAnnualPriceId={localStorage.getItem('stripe_pro_annual_price_id') || ''}
        key={isAccountOpen ? 'open' : 'closed'}
      />
      {isFilesOpen && (
        <div role="dialog" aria-modal="true" aria-label="Generated Files" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in font-sans" onClick={() => setIsFilesOpen(false)}>
          <div className="bg-void-1 border border-zinc-800 rounded-lg w-full max-w-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden animate-fade-in-up scale-in relative" onClick={(e) => e.stopPropagation()}>
            <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-neon-cyan to-neon-red"></div>
            <div className="p-6 border-b border-zinc-800 flex items-center justify-between shrink-0">
              <h2 className="text-xl font-black text-white uppercase tracking-widest font-mono">Gen_Files</h2>
              <button onClick={() => setIsFilesOpen(false)} aria-label="Close" className="text-zinc-500 hover:text-white transition-colors"><X size={24} /></button>
            </div>
            <div className="h-[calc(70vh+69px)] p-6 flex flex-col">
              <ErrorBoundary>
                <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader text="LOADING_MODULE..." /></div>}>
                  <GeneratedFilesPanel library={library} />
                </Suspense>
              </ErrorBoundary>
            </div>
          </div>
        </div>
      )}

      {isSidebarOpen && <div className="fixed inset-0 bg-black/60 z-30 md:hidden" onClick={() => setSidebarOpen(false)} />}

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:static md:z-20 md:translate-x-0 md:transition-all ${isSidebarOpen ? 'md:w-64' : 'md:w-0'} bg-void-1 flex flex-col overflow-hidden border-r border-zinc-900`}
      >
        <div className="shrink-0 bg-black/80 backdrop-blur-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-[1px] bg-neon-cyan opacity-20"></div>
            {/* Brand header — its own block, aligned to the module bar height (h-12 md:h-14),
                closed off by the same grey rule used under the sidebar toggle. The `>_` glyph is
                now the DATA_BANKS entrance: click toggles the library list ↔ catalogue.
                Colour states: no book in app → `>_` white; reading the active book → `>_` neon-blue;
                bank open → `>` neon-blue + `_` white (blinking, terminal-caret style). */}
            <div className="border-b border-zinc-900">
              <div className="h-12 md:h-14 px-4 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={() => setShowLibraryList(!showLibraryList)}
                        aria-label={showLibraryList ? "Close data banks" : "Open data banks"}
                        title={showLibraryList ? "SESSION_DATA — back to catalogue" : "DATA_BANKS — browse library"}
                        className="font-tech font-bold text-lg leading-none tracking-tight transition active:scale-90 cursor-pointer"
                    >
                        <span className={library.length > 0 ? 'text-neon-cyan' : 'text-white'}>{'>'}</span>
                        <span className={`relative -top-[0.14em] ${library.length === 0 ? 'text-white' : (showLibraryList ? 'text-white animate-blink' : 'text-neon-cyan')}`}>{'_'}</span>
                    </button>
                    <span className="text-lg font-tech font-bold tracking-[0.06em] leading-none">
                        <span className="text-white">Decod</span><span className="text-neon-cyan">Ebook</span>
                    </span>
                </div>
                <button
                    onClick={() => setView(AppView.UPLOAD)}
                    className="p-1.5 rounded-sm hover:bg-zinc-900 text-zinc-600 hover:text-neon-cyan transition active:scale-90"
                    title="Upload New"
                >
                    <Upload size={14} />
                </button>
              </div>
            </div>
            {/* Active-book info block — plain, function-less (the >_ owns the toggle now). */}
            {!showLibraryList && activeBook && (
                <div className="px-4 py-3">
                    <div className="h-[53px] px-2 flex flex-col justify-center border border-zinc-800 bg-zinc-900/20 rounded-sm hud-border cursor-default">
                        <h1 className="font-bold text-xs text-white truncate leading-tight mb-0.5 font-tech uppercase tracking-wide">{activeBook.title}</h1>
                        <p className="text-[9px] text-zinc-500 truncate font-mono uppercase">{activeBook.author}</p>
                    </div>
                </div>
            )}
        </div>
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {showLibraryList ? (
             <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col animate-fade-in">
                {library.map((item, i) => (
                    <div
                        key={item.book.id}
                        style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
                        className={`w-full flex items-center gap-3 p-4 border-b border-zinc-900 transition-all group animate-fade-in-up ${
                            activeBookId === item.book.id
                            ? 'bg-neon-cyan/5'
                            : 'hover:bg-zinc-900 active:bg-zinc-800/70'
                        }`}
                    >
                        <button
                            onClick={() => {
                                // openBook auto-re-extracts a stale book from its stored original (B) before
                                // opening, or falls back to the re-upload prompt (A). setActiveChapterId etc.
                                // happen inside openBook after any re-extraction rebuilds the chapters.
                                void openBook(item);
                                closeSidebarMobile();
                            }}
                            // Hover tooltip: the complete uploaded FILE NAME (like the chapter list's title=),
                            // so identically-titled formats (a PDF vs an EPUB of one book) are distinguishable
                            // by their extension. Fall back to "Title (FORMAT)" for items uploaded before the
                            // filename was recorded.
                            title={item.fileContext.sourceFileName || `${item.book.title} (${(item.fileContext.sourceKind || 'file').toUpperCase()})`}
                            className="flex items-center gap-3 flex-1 min-w-0"
                        >
                            <div className={`w-1 h-8 shrink-0 ${activeBookId === item.book.id ? 'bg-neon-cyan' : 'bg-zinc-800'}`}></div>
                            <div className="text-left min-w-0">
                                <h4 className={`text-[10px] font-bold truncate font-tech uppercase tracking-wide ${activeBookId === item.book.id ? 'text-neon-cyan' : 'text-zinc-400'}`}>
                                    {item.book.title}
                                </h4>
                                <p className="text-[9px] text-zinc-600 truncate font-mono">{item.book.chapters.length} DATA_BLOCKS</p>
                            </div>
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteBook(item.book.id); }}
                            className="p-1.5 text-zinc-500 hover:text-neon-red opacity-0 group-hover:opacity-100 transition-all shrink-0 active:scale-90"
                            title="Delete"
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>
                ))}
             </div>
          ) : (
             <div className="flex-1 min-h-0 flex flex-col">
                {/* Full-text search */}
                <div className="shrink-0 px-4 min-h-[61px] flex flex-col justify-center border-b border-zinc-900 bg-black/40">
                  <div className="relative flex items-center">
                    <Search size={12} className="absolute left-2 text-zinc-600 pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="SEARCH_FULLTEXT"
                      className="w-full bg-zinc-900/60 border border-zinc-800 focus:border-neon-cyan/50 rounded-sm pl-7 pr-7 py-1.5 text-[11px] font-mono text-zinc-200 placeholder:text-zinc-500 focus:outline-none tracking-wide"
                    />
                    {searchQuery && (
                      <button onClick={clearSearch} className="absolute right-2 text-zinc-600 hover:text-neon-red transition-colors" title="Clear search">
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  {searchActive && (
                    <div className="mt-1.5 flex items-center text-[8px] font-mono uppercase tracking-widest text-zinc-600">
                      <span>{isIndexing ? 'INDEXING…' : `${searchResults.length} MATCH${searchResults.length === 1 ? '' : 'ES'}`}</span>
                    </div>
                  )}
                </div>
                {/* Results — bounded + independently scrollable, persist until cleared */}
                {searchActive && (
                  <div className="shrink-0 max-h-[45%] overflow-y-auto custom-scrollbar border-b border-zinc-900/70 bg-black/20">
                    {!isIndexing && searchResults.length === 0 ? (
                      <div className="px-4 py-4 text-[9px] font-mono uppercase tracking-widest text-zinc-500">No matches found</div>
                    ) : (
                      searchResults.map((hit, i) => (
                        <button
                          key={`${hit.chapterId}-${hit.pageIndex}-${i}`}
                          onClick={() => handleSearchResultClick(hit)}
                          style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
                          className="w-full text-left px-4 py-2.5 border-b border-zinc-900/50 hover:bg-neon-cyan/5 group transition-colors animate-fade-in-up"
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-[8px] font-mono uppercase tracking-wider text-neon-cyan truncate">
                              {String(hit.chapterNumber).padStart(2, '0')} · {hit.chapterTitle}
                            </span>
                            <span className="text-[8px] font-mono text-zinc-600 shrink-0">PG.{String(hit.pageNumber).padStart(2, '0')}{hit.occurrences > 1 ? ` ×${hit.occurrences}` : ''}</span>
                          </div>
                          <p
                            className="text-[10px] leading-snug text-zinc-500 group-hover:text-zinc-300 break-words overflow-hidden"
                            style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', height: '2.75em' } as React.CSSProperties}
                          >
                            {hit.snippet.slice(0, hit.matchStart)}
                            <mark className="bg-transparent text-neon-cyan font-semibold">{hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)}</mark>
                            {hit.snippet.slice(hit.matchStart + hit.matchLength)}
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                )}
                {/* Chapter list (TOC) */}
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar py-2">
                {(() => {
                  const chaptersArr = activeBook?.chapters ?? [];
                  // A Part is any chapter that other chapters point at as parent; a hierarchical book
                  // has at least one nested (level > 0) chapter. Flat books hit neither and render
                  // exactly as before (numbered, no indent, no chevrons).
                  const parentIds = new Set(chaptersArr.filter(c => c.parentId != null).map(c => c.parentId as number));
                  const hasHierarchy = chaptersArr.some(c => (c.level ?? 0) > 0);
                  return chaptersArr.map((chapter, idx) => {
                    const isBookmarked = activeBook?.bookmarks?.includes(chapter.id);
                    // Hide a nested chapter whose Part is collapsed.
                    if (chapter.parentId != null && collapsedParts.has(chapter.parentId)) return null;
                    const level = chapter.level ?? 0;
                    const isPart = parentIds.has(chapter.id);
                    const collapsed = collapsedParts.has(chapter.id);
                    return (
                        <div key={chapter.id} ref={activeChapterId === chapter.id ? activeChapterItemRef : undefined} className="relative group flex items-center justify-between px-4 py-2 hover:bg-zinc-900/50">
                            <button
                                title={chapter.title}
                                onClick={() => { trackBookAction('chapter_navigate', { from_chapter: activeChapterId, to_chapter: chapter.id }, activeBookId || undefined); setActiveChapterPageTarget('first'); setActiveChapterId(chapter.id); if (currentUser && activeBookId) debouncedReadingSync(currentUser.id, activeBookId, chapter.id); closeSidebarMobile(); }}
                                className={`flex-1 text-left flex items-center gap-2 border-l-2 py-1 transition-all min-w-0 pr-2 ${level > 0 ? 'pl-5' : ''} ${
                                    activeChapterId === chapter.id
                                    ? 'border-neon-cyan'
                                    : 'border-transparent'
                                }`}
                            >
                                {isPart ? (
                                    <span
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => { e.stopPropagation(); setCollapsedParts(prev => { const n = new Set(prev); if (n.has(chapter.id)) n.delete(chapter.id); else n.add(chapter.id); return n; }); }}
                                        className="shrink-0 p-0.5 text-zinc-600 hover:text-neon-cyan cursor-pointer"
                                        title={collapsed ? 'Expand' : 'Collapse'}
                                    >
                                        <ChevronRight size={12} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
                                    </span>
                                ) : hasHierarchy ? (
                                    <span className="w-3 shrink-0" />
                                ) : (
                                    <span className={`text-[9px] font-mono w-6 text-right shrink-0 ${activeChapterId === chapter.id ? 'text-neon-cyan' : 'text-zinc-500'}`}>
                                        {String(idx + 1).padStart(2, '0')}
                                    </span>
                                )}
                                <div className="min-w-0 flex-1 text-left">
                                    <p className={`font-medium truncate font-tech uppercase tracking-tight text-xs ${activeChapterId === chapter.id ? 'text-white' : (isPart ? 'text-zinc-300' : 'text-zinc-500')}`}>
                                        {chapter.title}
                                    </p>
                                </div>
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); toggleBookmark(chapter.id); }}
                                className={`p-1.5 transition-colors shrink-0 ${isBookmarked ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-500'}`}
                                title={isBookmarked ? "Remove Bookmark" : "Add Bookmark"}
                            >
                                <Tag size={12} fill={isBookmarked ? "currentColor" : "none"} />
                            </button>
                        </div>
                    );
                  });
                })()}
                </div>
             </div>
          )}
        </div>
        <div className="p-0 border-t border-zinc-900 bg-black flex flex-col shrink-0">
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="w-full flex items-center gap-3 p-4 hover:bg-zinc-900 text-zinc-500 hover:text-neon-cyan transition-colors text-[10px] font-bold font-tech uppercase tracking-widest"
          >
            <SettingsIcon size={14} />
            <span>SYS_CONFIG</span>
          </button>
          <button
            onClick={() => setIsFilesOpen(true)}
            className="w-full flex items-center gap-3 p-4 hover:bg-zinc-900 text-zinc-500 hover:text-neon-cyan transition-colors text-[10px] font-bold font-tech uppercase tracking-widest"
          >
            <HardDrive size={14} />
            <span>GEN_FILES</span>
          </button>
          <button
            onClick={() => setIsAccountOpen(true)}
            className={`w-full flex items-center gap-3 p-4 hover:bg-zinc-900 transition-colors text-[10px] font-bold font-tech uppercase tracking-widest ${currentUser ? 'text-neon-cyan hover:text-white' : 'text-zinc-500 hover:text-neon-cyan'}`}
          >
            <UserIcon size={14} />
            <span>MY_ACCOUNT</span>
            {userTier && userTier.tier !== 'free' && (
              <span className={`ml-auto text-[8px] px-1.5 py-0.5 rounded ${
                userTier.tier === 'pro' ? 'bg-neon-cyan/10 text-neon-cyan' :
                'bg-neon-cyan/10 text-neon-cyan'
              }`}>
                {userTier.tier.toUpperCase()}
              </span>
            )}
          </button>
        </div>
      </aside>

      <main id="main-content" tabIndex={-1} className="flex-1 flex flex-col min-w-0 relative bg-transparent z-10 text-left">
        <header className="border-b border-zinc-900 bg-black/90 backdrop-blur-md sticky top-0 z-30 shrink-0">
          <div className="h-12 md:h-14 flex items-center justify-between px-3 md:px-4">
            <div className="flex items-center gap-2 md:gap-4 min-w-0">
              <button aria-label={isSidebarOpen ? "Close menu" : "Open menu"} onClick={() => setSidebarOpen(!isSidebarOpen)} className="text-zinc-500 hover:text-neon-cyan transition-colors shrink-0">
                {isSidebarOpen ? <X size={18} /> : <Menu size={18} />}
              </button>
              <div className="h-4 w-[1px] bg-zinc-800 shrink-0"></div>
              {activeChapterId ? (
                  <div className="flex items-center gap-1.5 md:gap-2 min-w-0">
                      <span className="text-[8px] md:text-[9px] font-mono text-zinc-600 bg-zinc-900 border border-zinc-800 px-1 md:px-1.5 py-0.5 shrink-0">
                          SEC.{String(activeChapterId || 0).padStart(2, '0')}
                      </span>
                      <ChevronRight size={10} className="text-zinc-500 shrink-0 hidden sm:block" />
                      <span className="text-[10px] md:text-xs font-bold text-neon-cyan font-tech tracking-wide truncate">
                          {activeChapter?.title.toUpperCase()}
                      </span>
                  </div>
              ) : (
                  <span className="text-[10px] md:text-xs font-tech text-zinc-500 tracking-widest">AWAITING_INPUT</span>
              )}
            </div>

            <div className="hidden md:flex items-center bg-zinc-950 border border-zinc-900 p-0.5 rounded-sm">
              {[
                { id: Tab.AUDIOBOOK, icon: Headphones, label: "VOICE_SYNTH" },
                { id: Tab.PODCAST, icon: Mic2, label: "NET_CAST" },
                { id: Tab.CONCEPTS, icon: ImageIcon, label: "VISUAL_CORE" },
                { id: Tab.ANIMATION, icon: Film, label: "CINE_RENDER" },
                { id: Tab.NOTEBOOK, icon: NotebookIcon, label: "MEM_LOG" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  aria-label={tab.label}
                  onClick={() => { switchTab(tab.id as Tab); }}
                  className={`flex items-center justify-center gap-2 w-[120px] py-1.5 transition-all active:scale-[0.97] text-[9px] font-bold uppercase tracking-wider font-tech ${
                    activeTab === tab.id
                      ? 'bg-neon-cyan/10 text-neon-cyan shadow-[0_0_10px_rgba(0,243,255,0.1)]'
                      : 'text-zinc-600 hover:text-zinc-300 hover:bg-zinc-900'
                  }`}
                >
                  <tab.icon size={12} className={activeTab === tab.id ? 'text-neon-cyan' : ''} />
                  <span className="hidden xl:inline">{tab.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex md:hidden overflow-x-auto border-t border-zinc-900/50 bg-black/80">
            {[
              { id: Tab.AUDIOBOOK, icon: Headphones, label: "VOICE" },
              { id: Tab.PODCAST, icon: Mic2, label: "CAST" },
              { id: Tab.CONCEPTS, icon: ImageIcon, label: "IMAGE" },
              { id: Tab.ANIMATION, icon: Film, label: "VIDEO" },
              { id: Tab.NOTEBOOK, icon: NotebookIcon, label: "NOTES" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => { switchTab(tab.id as Tab); }}
                className={`flex flex-col items-center justify-center flex-1 min-w-[52px] py-1.5 gap-0.5 transition-all active:scale-95 ${
                  activeTab === tab.id
                    ? 'text-neon-cyan bg-neon-cyan/10 border-b-2 border-neon-cyan'
                    : 'text-zinc-600 border-b-2 border-transparent'
                }`}
              >
                <tab.icon size={14} className={activeTab === tab.id ? 'text-neon-cyan' : ''} />
                <span className="text-[7px] font-bold font-tech tracking-wide">{tab.label}</span>
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 p-0 overflow-hidden relative">
          <div className="h-full w-full p-2 overflow-y-scroll overflow-x-hidden custom-scrollbar">
             {renderContent()}
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
