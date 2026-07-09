
import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { Upload, BookOpen, Headphones, Image as ImageIcon, BookA, Film, Menu, X, ChevronRight, FileText, Mic2, Settings as SettingsIcon, Library as LibraryIcon, Tag, Bookmark, Cpu, Notebook as NotebookIcon, Terminal, Activity, Database, Shield, HardDrive, User as UserIcon, Trash2, Search } from 'lucide-react';
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
import { saveFile, getFile, deleteFile, listFiles, buildCacheKey } from './services/fileCache';
import { buildChaptersFromOutline, buildSourceIndexedChapters, computeSourceHash, expandTopicSectionsIntoChapters, isUsablePdfOutline, splitDetectedBackMatter } from './utils/sourceIndex';
import { PDF_TEXT_EXTRACTION_VERSION, isStalePdfExtraction } from './utils/sourceVersion';
import { isReadableChapterTitle } from './utils/structureAnalysis';
import { buildBookPageIndex, searchBookIndex, ChapterPageIndex, SearchHit } from './utils/searchIndex';
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
  if (isStalePdfExtraction(item.fileContext.sourceKind, item.fileContext.sourceExtractorVersion)) {
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
  const useOutline =
    fileContext.sourceKind === 'pdf' &&
    isUsablePdfOutline(fileContext.content, fileContext.pdfOutline);
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
  const files = await listFiles(item.book.id);
  await Promise.all(files
    .filter(file => file.key !== currentSourceKey)
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
    if (isStalePdfExtraction(item.fileContext.sourceKind, item.fileContext.sourceExtractorVersion)) {
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
  const [landingVariant, setLandingVariant] = useState<'A' | 'B' | 'C' | 'D' | 'E'>('A');
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
  const activeChapter = activeBook?.chapters.find(c => c.id === activeChapterId) || null;

  // --- Full-text search (sidebar) ---------------------------------------------
  // Self-contained: indexes the active book's reader text and navigates via the
  // same chapter/page primitives the TOC already uses, so it never touches the
  // reader/audio/translation modules.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchActive, setSearchActive] = useState(false); // a query has been run
  const [isIndexing, setIsIndexing] = useState(false);
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
    setActiveChapterPageTarget({ type: 'page', pageIndex: hit.pageIndex });
    setActiveChapterId(hit.chapterId);
    if (currentUser && activeBookId) debouncedReadingSync(currentUser.id, activeBookId, hit.chapterId);
    closeSidebarMobile();
    // Keep the result list — the user can jump to other results at any time.
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
        let index = searchIndexCache.current.get(activeBook.id);
        if (!index) {
          index = buildBookPageIndex(activeFileContext.content, activeBook.chapters);
          searchIndexCache.current.set(activeBook.id, index);
        }
        if (cancelled) return;
        setSearchResults(searchBookIndex(index, query));
        setSearchActive(true);
      } finally {
        if (!cancelled) setIsIndexing(false);
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [searchQuery, activeBook, activeFileContext]);

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

  const processEpub = async (file: File): Promise<string> => {
    try {
      const zip = await JSZip.loadAsync(file);
      
      // Attempt to find the OPF file to determine reading order
      const opfPath = Object.keys(zip.files).find(f => f.toLowerCase().endsWith('.opf'));
      let sortedFiles: string[] = [];
      const parser = new DOMParser();

      if (opfPath) {
          // Robust EPUB Parsing via OPF Spine
          const opfContent = await zip.files[opfPath].async("string");
          const opfDoc = parser.parseFromString(opfContent, "text/xml");
          
          // 1. Map id -> href (Manifest)
          const manifest: Record<string, { href: string; properties: string }> = {};
          Array.from(opfDoc.getElementsByTagName("item")).forEach(item => {
              const id = item.getAttribute("id");
              const href = item.getAttribute("href");
              if (id && href) {
                  manifest[id] = {
                    href,
                    properties: item.getAttribute("properties") || '',
                  };
              }
          });

          // 2. Get spine order (idref)
          const spineIds = Array.from(opfDoc.getElementsByTagName("itemref"))
              .map(item => item.getAttribute("idref"))
              .filter(id => id !== null) as string[];

          // 3. Resolve file paths
          const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);
          
          spineIds.forEach(id => {
              if (manifest[id]) {
                  const entry = manifest[id];
                  const href = entry.href;
                  const decodedHref = decodeURIComponent(href);
                  const isNavDoc = /\bnav\b/i.test(entry.properties) || /(?:^|\/)(?:toc|nav)(?:[._-]|$)/i.test(decodedHref);
                  if (isNavDoc) return;
                  const fullPath = opfDir + decodedHref;
                  
                  if (zip.files[fullPath]) {
                      sortedFiles.push(fullPath);
                  } else {
                      const found = Object.keys(zip.files).find(k => k.endsWith(decodedHref));
                      if (found) sortedFiles.push(found);
                  }
              }
          });
      }

      if (sortedFiles.length === 0) {
          sortedFiles = Object.keys(zip.files).filter(filename => 
            filename.match(/\.(html|xhtml|htm)$/i) &&
            !filename.includes('__MACOSX') &&
            !/(?:^|\/)(?:toc|nav)(?:[._-]|$)/i.test(filename)
          );
          sortedFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      }

      const nodeToMarkedText = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const element = node as HTMLElement;
        const tag = element.tagName.toLowerCase();
        if (['script', 'style', 'nav', 'svg', 'math'].includes(tag)) return '';
        if (tag === 'br') return '\n';

        const childText = Array.from(element.childNodes).map(nodeToMarkedText).join('');
        const trimmed = childText.trim();
        if (!trimmed) return '';

        if (tag === 'blockquote') return `\n\n*${trimmed}*\n\n`;
        if (tag === 'cite') return `\n—— ${trimmed.replace(/^(?:——|--|—|–|-)\s*/u, '')}\n`;
        if (tag === 'strong' || tag === 'b') return `**${trimmed}**`;
        if (tag === 'em' || tag === 'i') return `*${trimmed}*`;
        if (tag === 'u') return `__${trimmed}__`;
        if (tag === 's' || tag === 'strike' || tag === 'del') return `~~${trimmed}~~`;
        if (tag === 'a') {
          const href = element.getAttribute('href') || '';
          const label = trimmed.replace(/\s+/g, ' ').trim();
          return href ? `[${label}](${href})` : label;
        }
        if (/^h[1-6]$/.test(tag) || ['p', 'div', 'section', 'article'].includes(tag)) {
          return `\n\n${trimmed}\n\n`;
        }
        if (tag === 'li') {
          const liClass = (element.getAttribute('class') || '').toLowerCase();
          // Index entries are a structured list: emit each as its own paragraph so
          // downstream prose-reflow can't merge them, and prefix sub-entries with
          // non-breaking spaces (which survive whitespace collapsing) to preserve
          // their indentation under the parent term.
          if (liClass.includes('indexsub')) return `\n\n    ${trimmed}\n\n`;
          if (liClass.includes('indexmain')) return `\n\n${trimmed}\n\n`;
          // Reveal list structure: bullets for <ul>, numbers for <ol>. Skip when the
          // item already carries its own marker (e.g. endnote backlinks "[2](...)"),
          // so notes aren't double-numbered.
          const parentTag = element.parentElement?.tagName.toLowerCase();
          const alreadyMarked = /^\[?\s*[0-9ivxlcdm]{1,8}[.)\]]/i.test(trimmed);
          if (!alreadyMarked) {
            if (parentTag === 'ol') {
              const items = Array.from(element.parentElement!.children).filter(c => c.tagName.toLowerCase() === 'li');
              return `\n${items.indexOf(element) + 1}. ${trimmed}\n`;
            }
            if (parentTag === 'ul') {
              return `\n• ${trimmed}\n`;
            }
          }
          return `\n${trimmed}\n`;
        }
        return childText;
      };

      let fullText = "";
      for (const filename of sortedFiles) {
        const content = await zip.files[filename].async("string");
        const processedContent = content
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/h[1-6]>/gi, '\n\n')
            .replace(/<\/li>/gi, '\n');

        const doc = parser.parseFromString(processedContent, "text/html");
        const text = nodeToMarkedText(doc.body)
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n[ \t]+/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]{2,}/g, ' ');
        fullText += text.trim() + "\n\n";
      }

      if (!fullText) throw new Error("No readable text found in EPUB.");
      return fullText;

    } catch (e) {
      console.error("EPUB processing error", e);
      throw new Error("Could not parse EPUB file. Structure may be corrupted.");
    }
  };

  type ExtractedFigure = { id: string; page: number; wPts: number; hPts: number; wPx: number; hPx: number; mimeType: string; colFrac?: number; blob: Blob };
  const processPdf = async (file: File): Promise<{ content: string; outline: PdfOutlineItem[]; title?: string; figures: ExtractedFigure[] }> => {
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
      const figuresByPage = new Map<number, { id: string; yTop: number }[]>();
      const FIG_MIN_PT = 90;      // ignore anything smaller than this on either side (icons/rules)
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

      // Resolve the PDF's outline (bookmarks) up front: each entry's destination gives a
      // page and a Y position. Capturing it now lets us anchor each chapter to its exact
      // heading line (by page + Y) while the per-page glyph geometry is still in scope —
      // which also separates multiple bookmarks that share one page. Failures are
      // non-fatal; unresolved entries are dropped and the caller falls back to heuristics.
      const outlineEntries: { title: string; page: number; y: number | null }[] = [];
      // Every outline entry at EVERY level (chapters + nested section headings) with a resolved
      // Y — the author's own heading structure, used below to tag headings the font-family rule
      // misses (a nested section title set in the body font). Chapters still come from the
      // top-level entries only (outlineEntries), so navigation is unchanged.
      const outlineHeadingTargets: { title: string; page: number; y: number }[] = [];
      try {
        const rawOutline = await pdf.getOutline();
        const collectOutline = async (items: typeof rawOutline, depth: number): Promise<void> => {
          for (const item of items || []) {
            try {
              const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
              if (dest && dest[0]) {
                const page = (await pdf.getPageIndex(dest[0])) + 1;
                const y = typeof dest[3] === 'number' ? dest[3] : null;
                const title = (item.title || '').replace(/\s+/g, ' ').trim();
                if (page && title) {
                  if (depth === 0) outlineEntries.push({ title, page, y });
                  if (y != null) outlineHeadingTargets.push({ title, page, y });
                }
              }
            } catch { /* skip unresolvable entry */ }
            if (item.items && item.items.length) await collectOutline(item.items, depth + 1);
          }
        };
        await collectOutline(rawOutline || [], 0);
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
      const fontEmphasisFor = (page: any, fontName: string, cache: Map<string, { italic: boolean; bold: boolean; family: string }>) => {
        const cached = cache.get(fontName);
        if (cached) return cached;
        let italic = false, bold = false, family = '';
        try {
          if (page.commonObjs?.has?.(fontName)) {
            const rawName = String(page.commonObjs.get(fontName)?.name || '');
            const realName = rawName.toLowerCase();
            // Match full weight/style words AND the abbreviated tokens many subset fonts use
            // after a separator (e.g. "TradeGothicNextLTPro-BdCn" = Bold Condensed, "-It" =
            // Italic). The separator prefix keeps "bd"/"it" from matching mid-word.
            italic = /italic|oblique|[-_ ](?:it|ita|obl)/.test(realName);
            bold = /bold|black|heavy|semibold|demi|[-_ ](?:bd|blk|hvy?|sb|smbd|xbd?|extrab)/.test(realName);
            // Font FAMILY: subset prefix ("ABCDEF+") stripped, weight/style suffix dropped. This is
            // the typesetter's family choice — the principled signal for a heading: a heading is set
            // in a display family DISTINCT from the body family (identified from the contents page
            // below), which size cannot capture (a notes-section header equals body size; an
            // epigraph is smaller than body).
            family = rawName.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0].trim();
          }
        } catch { /* font flags unavailable — fall back to plain text */ }
        const style = { italic, bold, family };
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
      const romanValue = (s: string): number => {
        const r: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
        let total = 0, prev = 0;
        for (let k = s.length - 1; k >= 0; k--) { const v = r[s[k].toLowerCase()] || 0; total += v < prev ? -v : v; prev = Math.max(prev, v); }
        return total;
      };
      // The marker label for a candidate run ("14" / "[14]" / "II" / "ii."), or '' if it
      // isn't a valid 1–3 digit number or small Roman numeral.
      const markerLabelOf = (raw: string): string => {
        const bare = raw.replace(/^[[(\s]+/u, '').replace(/[\].)\s]+$/u, '');
        if (/^\d{1,3}$/.test(bare)) return Number(bare) >= 1 ? bare : ''; // footnotes are 1-indexed
        if (bare.length >= 1 && ROMAN_MARKER_RE.test(bare)) { const v = romanValue(bare); if (v >= 1 && v <= 40) return bare.toUpperCase(); }
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
      type PdfLine = { y: number; pageY: number; col?: 0 | 1; x: number; rightX: number; text: string; h: number; bold: boolean; family: string; localFont: number; outlineHeading?: boolean; mcRole?: string };
      const pageBuffers: { pageNum: number; lines: PdfLine[]; bodyLeft: number; paraLeftMargin: number; lineGap: number; isListPage: boolean; indentTiers: number[]; pageHeight: number }[] = [];
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

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const pageHeight = page.getViewport({ scale: 1 }).height;
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
            let ctm = [1, 0, 0, 1, 0, 0]; const gstack: number[][] = []; let n = 0;
            for (let i = 0; i < opList.fnArray.length; i++) {
              const fn = opList.fnArray[i]; const a = opList.argsArray[i];
              if (fn === OPS.save) gstack.push(ctm.slice());
              else if (fn === OPS.restore) { const s = gstack.pop(); if (s) ctm = s; }
              else if (fn === OPS.transform) ctm = mulMat(ctm, a);
              else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
                const wPts = Math.abs(ctm[0]), hPts = Math.abs(ctm[3]);
                if (wPts < FIG_MIN_PT || hPts < FIG_MIN_PT) continue; // icon / rule / logo
                const yTop = Math.max(ctm[5], ctm[5] + ctm[3]);
                const img = await getImageObj(page, a[0]);
                const enc = img ? await encodeFigure(img) : null;
                if (!enc) continue;
                const id = `p${pageNum}n${++n}`;
                allFigures.push({ id, page: pageNum, wPts, hPts, wPx: enc.wPx, hPx: enc.hPx, mimeType: 'image/jpeg', colFrac: colW > 0 ? Math.min(1, wPts / colW) : undefined, blob: enc.blob });
                const list = figuresByPage.get(pageNum) || []; list.push({ id, yTop }); figuresByPage.set(pageNum, list);
              }
            }
          } catch { /* figure extraction is best-effort — never block text extraction */ }
        }
        const fontCache = new Map<string, { italic: boolean; bold: boolean; family: string }>();

        // Link annotations on this page: external URLs (rendered as hyperlinks) and
        // internal go-to destinations (footnote/cross-reference markers). For each go-to
        // marker, resolve its destination to a page + Y and stash a note-anchor target so
        // the destination page can be anchored with the same key (see noteAnchorTargets).
        const uriLinks: { rect: number[]; url: string }[] = [];
        const gotoLinks: { rect: number[]; key: string }[] = [];
        for (const a of (annotations as any[]) || []) {
          if (a?.subtype !== 'Link' || !a.rect) continue;
          if (a.url) { uriLinks.push({ rect: a.rect, url: a.url }); continue; }
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
          } catch { /* op-list parse failed — fall back to the uniform estimate below */ }
        }
        type PdfGlyph = { x: number; y: number; h: number; w: number; str: string; italic: boolean; bold: boolean; family: string; linkUrl?: string; noteKey?: string; dropCap?: boolean; mcRole?: string; paraOrder?: number };
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
            glyphs.push({ x, y, h, w, str, italic: emphasis.italic, bold: emphasis.bold, family: emphasis.family, mcRole, paraOrder });
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
          let anchorIdx = -1, anchorPos = 0;
          for (let i = 0; i < gs.length; i++) {
            const lo = gs[i].str.toLowerCase().replace(/^[^a-z0-9]+/u, '').replace(/[.,;:!?)\]"'»]+$/u, '');
            if (/^https?:\/\//u.test(lo) || /^www\./u.test(lo)) { anchorIdx = i; anchorPos = Math.max(0, nurl.indexOf(lo.slice(0, 10))); break; }
            if (anchorIdx < 0 && lo.length >= 12) {
              let at = nurl.indexOf(lo);
              // A URL that CONTINUED from the previous page can arrive as ONE text item with a
              // trailing citation glued on ("…data.pdf; Lawrence H. Officer,") — the whole glyph
              // isn't in the URL, so anchor on the longest ≥12-char PREFIX the URL does contain
              // and let the per-glyph walk below split off the citation tail.
              if (at < 0) { for (let len = lo.length - 1; len >= 12; len--) { const p = nurl.indexOf(lo.slice(0, len)); if (p >= 0) { at = p; break; } } }
              if (at >= 0) { anchorIdx = i; anchorPos = at; }
            }
          }
          if (anchorIdx < 0) continue; // custom-text link (display doesn't spell the URL) — leave untouched
          for (let i = 0; i < anchorIdx; i++) urlKeep.set(gs[i], 0); // citation before the URL on this page
          let pos = anchorPos;
          for (let i = anchorIdx; i < gs.length; i++) {
            const lower = gs[i].str.toLowerCase();
            let m = 0;
            while (pos + m < nurl.length && m < lower.length && nurl[pos + m] === lower[m]) m++;
            urlKeep.set(gs[i], m);
            pos += m;
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
        if (glyphs.length === 0) continue;

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
        const clusterLines = (gs: PdfGlyph[]): LineGroup[] => {
          const out: LineGroup[] = [];
          for (const g of [...gs].sort((a, b) => b.y - a.y || a.x - b.x)) {
            let best: LineGroup | null = null;
            let bestDist = Infinity;
            for (const group of out) {
              const dist = Math.abs(group.baseY - g.y);
              if (dist <= lineTolerance && dist < bestDist) { bestDist = dist; best = group; }
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
        const structKeys = [...new Set(bodyGlyphs.map(g => g.paraOrder).filter((v): v is number => v !== undefined))].sort((a, b) => a - b);
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
        const sortedGroups = clusterLines(bodyGlyphs).sort((a, b) => b.baseY - a.baseY); // top → bottom
        // The RIGHT column's left edge (if any): the leftmost x of lines starting well right of centre,
        // taken as a robust low percentile so an outlier doesn't move it. Classifying against THIS, not
        // the page midpoint, keeps a long left-column bullet (which can extend past mid) as LEFT rather
        // than full-width — the misclassification that stopped the band from ever being detected.
        const rightStarts = sortedGroups.map(gMinX).filter(x => x > pageMid + span * 0.05).sort((a, b) => a - b);
        const gut0 = rightStarts.length >= 3 ? rightStarts[Math.floor(rightStarts.length * 0.15)] - 4 : pageMid;
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
        if (bStart >= 0) {
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
          if (runLen >= 3) {
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
        const pageLines = groups
          .map(group => {
            const items = group.items.sort((a, b) => a.x - b.x);
            const lineBodyHeight = mode(items.map(it => Math.round(it.h))) || group.baseH;
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
              const label = markerLabelOf(txt);
              const markerLike = destPage > pageNum && label !== '';
              if (markerLike) { markerEmit[i] = { label, key }; for (let k = i + 1; k < j; k++) skip[k] = true; }
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
              const isMarker = idx > 0 && !prevEndsDigit && /^\d{1,3}$/.test(trimmed) && Number(trimmed) >= 1 && it.h < lineBodyHeight * 0.84;
              if (isMarker) {
                if (open) { out += MARK[open]; open = null; }
                if (openLink) { out += `](${openLink})`; openLink = null; }
                out += `[${trimmed}](#pdfnote-${pageNum}-${trimmed})`;
                return;
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
              bold: items.filter(it => it.bold).length > items.length / 2,
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
              noteLine.text = noteLine.text.replace(
                /^(\s*)([ivxlcdm]{1,4}|\d{1,3})([.)])\s*/iu,
                (m, sp, marker, _p) => markerLabelOf(marker) ? `${sp}[${markerLabelOf(marker)}](#${target.key}) ` : m
              );
            }
          }
        }

        const bodyLeft = mostFrequentLeft(pageLines.map(line => line.x));
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
        const endsWithPageRef = (value: string): boolean => /[\d](?:[–—-]\d+)?\s*$/u.test(value);
        const isListPage = pageLines.filter(line => endsWithPageRef(line.text)).length >= 6;
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
        pageBuffers.push({ pageNum, lines: pageLines, bodyLeft, paraLeftMargin, lineGap, isListPage, indentTiers, pageHeight });
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
      const isHeadingLine = (line: PdfLine): boolean =>
        // Tagged PDF: the marked-content role is authoritative — H1–H6 is a heading, anything else
        // (P, Caption, …) is NOT, regardless of font. Only fall to geometry/outline when untagged.
        line.mcRole ? /^H[1-6]?$/u.test(line.mcRole)
          : line.outlineHeading === true || (headingFamily
            ? line.family === headingFamily && line.localFont > 0 && line.h >= line.localFont * 1.2
            : (bodyFont > 0 && line.h >= bodyFont * 1.2));
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
      const isShortDataLine = (line: PdfLine, bodyLeft: number): boolean => {
        const measure = bodyRightEdge - bodyLeft;
        return measure > 0 && (line.rightX - line.x) < measure * 0.5;
      };
      // A footnote entry starts a new block: it sits in the smaller footnote font and opens
      // with a marker — already linked by the note-anchor injection ("[II](#…) Adam Smith…"),
      // or a bare number/Roman ("II. …") for a footnote whose forward marker wasn't found.
      // Without this, two chapter-end footnotes with a small gap join into one paragraph.
      const startsFootnoteEntry = (line: PdfLine): boolean => {
        if (bodyFont > 0 && line.h >= bodyFont * 0.92) return false;
        if (/^\s*\[[^\]\n]+\]\(#[^)\n]*\)/.test(line.text)) return true;
        const m = line.text.match(/^\s*([ivxlcdm]{1,4}|\d{1,3})[.)]\s/iu);
        return Boolean(m && markerLabelOf(m[1]));
      };

      // Each page's blocks are buffered with the geometry the cross-page seam join needs,
      // then assembled into one stream so a paragraph that runs off the bottom of one page
      // and continues at the top of the next is rejoined from the layout, not guessed.
      type EmitBlock = { text: string; role: 'heading' | 'body' | 'list'; firstX: number; firstRightX: number; lastRightX: number; lastText: string; carryover?: boolean; col?: 0 | 1; topY?: number };
      const pageEmit: { pageNum: number; blocks: EmitBlock[]; rightMargin: number; bodyLeft: number }[] = [];

      for (const buf of pageBuffers) {
        const { pageNum, lines, bodyLeft, paraLeftMargin, lineGap, isListPage, indentTiers } = buf;
        const proseLines = lines.filter(line => !isHeadingLine(line));
        const rightMargin = proseLines.length ? Math.max(...proseLines.map(line => line.rightX)) : 0;
        const indentDepthFor = (x: number): number => {
          const tier = indentTiers.findIndex(t => Math.abs(t - x) <= INDENT_TOL);
          return tier >= 1 ? Math.min(tier, 3) : 0;
        };

        // A table of contents has no page references, so the index/list test (≥6 lines
        // ending in a page number) misses it and its entries reflow into one run-on
        // paragraph. Detect it by a "Contents" heading near the top and emit one entry per
        // line (the entries are short titles, not prose).
        const isContentsPage = lines.length >= 6 &&
          lines.slice(0, 3).some(line => /^(?:contents|table of contents)$/iu.test(line.text.replace(/[*_~]/gu, '').trim()));
        if (isContentsPage) {
          // The TOC has its own structure, already decided by the page geometry and font:
          // KEEP each entry's emphasis (the bold chapter title) and encode its left-indent
          // tier as leading non-breaking spaces (4 per level, like the index), so the reader
          // reproduces the original bold + indentation instead of a flat uniform list.
          const entryLefts = lines.filter(line => !isHeadingLine(line) && line.text.trim()).map(line => line.x).sort((a, b) => a - b);
          const tiers: number[] = [];
          for (const x of entryLefts) { if (!tiers.some(t => Math.abs(t - x) <= INDENT_TOL)) tiers.push(x); }
          tiers.sort((a, b) => a - b);
          const tierOf = (x: number): number => { const i = tiers.findIndex(t => Math.abs(t - x) <= INDENT_TOL); return i >= 1 ? Math.min(i, 3) : 0; };
          const blocks = lines
            .filter(line => line.text.replace(/[*_~]/gu, '').trim())
            .map(line => ({
              text: '\u00a0'.repeat(4 * tierOf(line.x)) + line.text.replace(/\s+/gu, ' ').trim(),
              role: 'list' as const, firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '',
            }));
          pageEmit.push({ pageNum, blocks, rightMargin, bodyLeft });
          continue;
        }

        // Index/contents: the entries are an indented list, but the lines BEFORE the first
        // entry (a "INDEX" heading and a prose intro note at the body margin) are not \u2014 they
        // must be reflowed, not chopped one fragment per line with stray indents.
        if (isListPage) {
          const formattedLines: string[] = [];
          const endsWithPageRef = (value: string): boolean => /[\d](?:[\u2013\u2014-]\d+)?\s*$/u.test(value);
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
            if (/[A-Za-z]-$/.test(formattedLines[i]) && formattedLines[i + 1] && /^[a-z]/.test(formattedLines[i + 1])) {
              formattedLines[i] = formattedLines[i] + formattedLines.splice(i + 1, 1)[0];
              i--;
            }
          }
          const pageText = formattedLines.join('\n').trim();
          // A list page is never a seam-join candidate (its entries are their own lines).
          pageEmit.push({ pageNum, blocks: pageText ? [{ text: pageText, role: 'list', firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '' }] : [], rightMargin, bodyLeft });
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
          const leftVaries = span(dispLines.map(l => l.x)) > bodyFont * 2;
          const rightSpan = span(dispLines.map(l => l.rightX));
          const centreSpan = span(dispLines.map(l => (l.x + l.rightX) / 2));
          const align: 'right' | 'center' | null =
            leftVaries && rightSpan <= tol ? 'right'
              : leftVaries && rightSpan > tol && centreSpan <= tol ? 'center'
                : null;
          if (align) {
            const sentinel = align === 'right' ? '\uE011' : '\uE010'; // U+E011 right, U+E010 centre — stripped by the reader
            // A right-aligned block can be WRAPPED PROSE (a "Praise for…" page: multi-line quotes each
            // set flush-right) rather than a line-list. Emitting one item per line then shatters every
            // quote/attribution into separate lines and — since a long right-aligned line starts near
            // the left — reads as chaotic mixed alignment. If the lines are long (fill most of the
            // measure), JOIN the wrapped lines into paragraphs (breaking on a larger vertical gap) so
            // each quote and its attribution is one right-aligned paragraph. (Centre stays one-per-line
            // — title pages are genuine line-lists.)
            const measure = Math.max(...dispLines.map(l => l.rightX)) - Math.min(...dispLines.map(l => l.x));
            const proseLike = align === 'right' && measure > 0 && (median(dispLines.map(l => l.rightX - l.x)) || 0) > measure * 0.55;
            let outBlocks: EmitBlock[];
            if (proseLike) {
              const gaps = dispLines.slice(1).map((l, i) => dispLines[i].y - l.y).filter(g => g > 0 && g < bodyFont * 4);
              const medGap = median(gaps) || bodyFont;
              // Break a paragraph on a larger vertical gap OR before a line that opens with an em/en
              // dash — the reliable "attribution/credit" marker — so a quote and its "—Name, title"
              // become separate right-aligned paragraphs (the credit gap is only slightly wider than
              // the line gap, so the dash carries the split).
              const opensCredit = (t: string): boolean => /^\s*(?:[*_~`]+\s*)?[—–]/u.test(t); // skip a leading italic/bold marker: an italic credit is "*—Name*"
              const groups: PdfLine[][] = [];
              let cur: PdfLine[] = [];
              for (let i = 0; i < dispLines.length; i++) {
                const gap = i > 0 ? dispLines[i - 1].y - dispLines[i].y : 0;
                if (i > 0 && cur.length && (gap > medGap * 1.4 || opensCredit(dispLines[i].text))) { groups.push(cur); cur = []; }
                cur.push(dispLines[i]);
              }
              if (cur.length) groups.push(cur);
              outBlocks = groups.map(g => {
                let t = g[0].text;
                for (let k = 1; k < g.length; k++) t = /[A-Za-z]-$/.test(t) && /^[a-z]/.test(g[k].text) ? t + g[k].text : `${t} ${g[k].text}`;
                return { text: sentinel + t.replace(/\s+/gu, ' ').trim(), role: 'body' as const, firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '' };
              });
            } else {
              outBlocks = dispLines.map(line => ({ text: sentinel + line.text.replace(/\s+/gu, ' ').trim(), role: 'list' as const, firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '' }));
            }
            pageEmit.push({ pageNum, blocks: outBlocks, rightMargin, bodyLeft });
            continue;
          }
        }

        // Prose page: paragraph spacing comes from the BODY lines only (a chapter-start
        // page's page-wide gap is skewed by large heading leading). Walk the lines,
        // gathering a run of one kind, then join it into a single block.
        const bodyLines = lines.filter(line => !isHeadingLine(line));
        const bodyGaps = bodyLines.slice(1).map((line, index) => bodyLines[index].y - line.y).filter(gap => gap > 0 && gap < bodyFont * 3);
        const bodyLineGap = median(bodyGaps) || lineGap;

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
          return labeled >= 2 && labeled >= margin.length / 2;
        };

        // A bullet-list item ("• Prompt chaining …") starts a new paragraph — otherwise the items
        // (and their wrapped descriptions) reflow into one run-on block. The lone-bullet de-dup
        // upstream guarantees a single leading bullet per item.
        // A bullet is often BOLD, so the line arrives wrapped as "**•** …"; skip a leading emphasis
        // wrapper (and the bullet may glue to the word, "•Understand") before matching the marker.
        const startsBulletLine = (t: string): boolean => /^\s*(?:[*_~`]+\s*)?[•‣▪●◦⁃∙○■]/u.test(t);
        const blocks: EmitBlock[] = [];
        let i = 0;
        while (i < lines.length) {
          const groupIsHeading = isHeadingLine(lines[i]);
          const group: PdfLine[] = [lines[i]];
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
              const isIndentedBodyLine = current.x > paraLeftMargin + 8;
              // Two consecutive lines that each occupy less than half the measure are
              // line-structured data (a catalog/CIP block, address, code list), not flowing
              // prose — keep them one per line. Prose has at most one short line per
              // paragraph (the last), so this never splits a paragraph. EXCLUDE a line that opens
              // a labeled entry (a dialogue turn "RAY: Right.", a CIP field): a short labeled
              // opener must not break the block here — it belongs to the labeled hanging list that
              // detectLabeledHangingList re-splits, and breaking before it would fragment the
              // dialogue into pieces too small to detect (a one-word turn beside a short wrapped
              // continuation otherwise tripped bothShort and merged that run into one paragraph).
              const bothShort = isShortDataLine(previous, bodyLeft) && isShortDataLine(current, bodyLeft)
                && !labelStart.test(current.text.replace(/[*_~]/gu, '').trim());
              endsBlock =
                bothShort ||
                startsFootnoteEntry(current) ||
                startsBulletLine(current.text) ||
                (bodyLineGap > 0 && verticalGap > bodyLineGap * 1.35) ||
                (endsWithTerminalPunctuation(previous.text) && (isIndentedBodyLine || startsParagraphTransitionLine(current.text)));
            }
            if (endsBlock) break;
            group.push(current);
            j++;
          }
          // A labeled hanging-indent list (dialogue, CIP, glossary): the splitter merged its
          // entries (each entry-start sits at the margin, reading as a prose continuation).
          // Re-split into ONE body paragraph per entry — a margin line plus its indented
          // continuations — so speaker turns / fields don't run together. (Plain body blocks;
          // no hanging-indent visual, to keep the change small and safe.)
          if (!groupIsHeading && detectLabeledHangingList(group)) {
            const groupLeft = Math.min(...group.map(l => l.x));
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
                // An entry that OPENS at the indented (continuation) tier — not the entry margin —
                // is a turn/field whose start is on the PREVIOUS page: a hanging-list entry (dialogue
                // turn, CIP field) that wrapped across the page break. Flag it so the cross-page join
                // reunites it with its opener even though the previous page's tail ends a sentence.
                blocks.push({ text: etext, role: 'body', firstX: entry[0].x, firstRightX: entry[0].rightX, lastRightX: last.rightX, lastText: last.text, carryover: entry[0].x > groupLeft + 4, topY: Math.max(...entry.map(l => l.pageY)) });
              }
              entry = [];
            };
            for (const line of group) {
              if (line.x <= groupLeft + 4 && entry.length) flushEntry();
              entry.push(line);
            }
            flushEntry();
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
          // De-hyphenate a word split across a line break even when LINK markup separates the halves —
          // the hyphenated word was a hyperlink, so it came out "esti‐](url) [mates](url)". First, when
          // BOTH halves link to the SAME url, MERGE them into one span so the hover/underline stays
          // continuous ("[esti‐](u) [mates](u)" → "[estimates](u)"). Then drop any remaining typographic/
          // soft hyphen + join space (ASCII "-" compounds are left intact).
          text = text.replace(/([A-Za-z])[‐‑­]\]\(([^)]*)\)\s+\[([a-z][^\]]*)\]\(\2\)/gu, '$1$3]($2)');
          text = text.replace(/([A-Za-z])[‐‑­](\]\([^)]*\))?\s+(\[?)([a-z])/gu, '$1$2$3$4');
          // A heading is styled as a whole by the reader, so inline emphasis inside it is
          // noise. It also actively harms: a bold-only glyph among bold-italic words (e.g.
          // an upright bold chapter number, "Chapter **5.** *The Life…*") leaves a stray
          // "**" that shows literally and breaks the notes "Chapter N" section detection.
          // Drop emphasis markers from heading blocks (footnote links are left intact).
          if (groupIsHeading) text = text.replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim();
          if (text) {
            const last = group[group.length - 1];
            // A set-off epigraph/quote CREDIT ("—NORMAN COHN", "—EMERSON, The Conduct of Life") is
            // right-aligned display, not prose. Tag it right (U+E011) so the reader drops its
            // first-line indent by GEOMETRY, not by a fragile date/name text guess. Gate on the
            // leading em/en dash: right-alignment alone is overloaded here (this book right-aligns
            // chapter titles), the attribution dash is not — so headings/index tails never match.
            const groupMinX = Math.min(...group.map(l => l.x));
            const groupMaxRight = Math.max(...group.map(l => l.rightX));
            const isRightAttribution = !groupIsHeading && /^\s*[\u2014\u2013]/u.test(text)
              && groupMinX > bodyLeft + bodyFont * 4 && groupMaxRight >= rightMargin - Math.max(6, bodyFont);
            blocks.push({
              text: isRightAttribution ? '\uE011' + text : text,
              role: groupIsHeading ? 'heading' : 'body',
              firstX: group[0].x,
              firstRightX: group[0].rightX,
              lastRightX: last.rightX,
              lastText: last.text,
              col: group.find(l => l.col !== undefined)?.col,
              topY: Math.max(...group.map(l => l.pageY)),
            });
          }
          i = j;
        }

        // Drop this page's figures into the block stream by their top-Y, so a figure reads where it
        // physically sits (blocks are in top-to-bottom reflow order). The [[FIG id]] marker becomes
        // its own block; the reader swaps it for the cached image, text consumers strip it.
        const pageFigs = figuresByPage.get(pageNum);
        if (pageFigs) for (const f of pageFigs) {
          const fb: EmitBlock = { text: `[[FIG ${f.id}]]`, role: 'body', firstX: bodyLeft, firstRightX: 0, lastRightX: 0, lastText: '', topY: f.yTop };
          let at = blocks.findIndex(b => (b.topY ?? -Infinity) < f.yTop);
          if (at < 0) at = blocks.length;
          blocks.splice(at, 0, fb);
        }

        pageEmit.push({ pageNum, blocks, rightMargin, bodyLeft });
      }

      // Geometry-driven cross-page join: a paragraph that runs off the bottom of one page
      // continues at the top of the next when that page's last body line FILLS the right
      // margin (it wrapped, it did not end) and lacks terminal punctuation, and the next
      // page opens with a body block at the left margin (not indented = not a new paragraph)
      // whose own first line also fills the measure (so a short running head is not taken
      // for the continuation). When so, the two blocks are emitted as one paragraph with the
      // page marker inline (stripped at display); otherwise the page starts a new block.
      let prevBlock: EmitBlock | null = null;
      let prevRightMargin = 0;
      for (const { pageNum, blocks, rightMargin, bodyLeft } of pageEmit) {
        if (blocks.length === 0) continue;
        const marker = `[[PAGE ${pageNum}]]`;
        const first = blocks[0];
        const continues =
          prevBlock !== null &&
          pages.length > 0 &&
          prevBlock.role === 'body' &&
          first.role === 'body' &&
          // A carryover — the top of this page is a hanging-list entry (dialogue turn / CIP field)
          // whose opener is on the previous page — always continues the previous page's last block,
          // even though a turn can span a page break AT a sentence boundary (so the prev tail ends
          // with terminal punctuation and its last line may be short). Otherwise, ordinary prose:
          // the prev line filled the measure and did not end a sentence, and this page opens at the
          // margin with a filled line (so a short running head is not taken for the continuation).
          (first.carryover ||
            (fillsMeasure(prevBlock.lastRightX, prevRightMargin) &&
              !endsWithTerminalPunctuation(prevBlock.lastText) &&
              first.firstX <= bodyLeft + 8 &&
              fillsMeasure(first.firstRightX, rightMargin)));
        // Carry each block's geometry-decided role to the reader as a private-use sentinel
        // (U+E012 list, U+E013 heading; the reader strips them). A run of LEFT-column (col 0) blocks
        // immediately followed by RIGHT-column (col 1) blocks is a side-by-side TWO-COLUMN region:
        // encode it as U+E014 <left \u00B6s joined by U+E016> U+E015 <right \u00B6s> so the reader can lay the
        // two columns out next to each other (stacking on narrow screens). Everything else is normal.
        const enc = (b: EmitBlock): string => (b.role === 'list' ? '\uE012' : b.role === 'heading' ? '\uE013' : '') + b.text;
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
          if (unitIndex === 0 && continues) {
            pages[pages.length - 1] = `${pages[pages.length - 1]} ${marker} ${unit.block.text}`;
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
      const fullText = sanitizeInternalLinkMarkup(assembled);
      if (!fullText) throw new Error('No selectable text found in PDF.');

      // Anchor each outline entry to its exact heading offset: pick the line on the
      // destination page whose baseline Y is closest to the bookmark's Y, then locate that
      // line's text within the page's block in the extracted content. This separates
      // multiple bookmarks on one page and starts chapters at the heading rather than the
      // page top. When the heading can't be located (corrupt/short text), `offset` is left
      // undefined and the chapter falls back to the page-start marker downstream.
      const outline: PdfOutlineItem[] = outlineEntries.map(entry => {
        let offset: number | undefined;
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
            if (within >= 0 && (nextBlock < 0 || within < nextBlock)) offset = within;
          }
        }
        return { title: entry.title, page: entry.page, level: 0, offset };
      });

      return { content: fullText, outline, title: metaTitle, figures: allFigures };
    } catch (e) {
      console.error('PDF processing error', e);
      throw new Error('Could not extract text from this PDF. Scanned/image-only PDFs need OCR before upload.');
    }
  };

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
            const useOutline =
              preparedContext.sourceKind === 'pdf' &&
              isUsablePdfOutline(preparedContext.content, preparedContext.pdfOutline);
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
            // Re-upload replaces any existing copy of the same book (matched by title) so a
            // stale entry — chapters built by an older extraction engine — can't linger
            // beside the fresh one. (structure.id is a random UUID per upload, so it can't
            // match; title is the stable identity across re-uploads.) Purge the superseded
            // copy's cache and cloud rows too, not just the in-memory list.
            const sameBookTitle = (title?: string) => (title || '').trim().toLowerCase();
            const newBookTitle = sameBookTitle(structure.title);
            if (newBookTitle) {
              library
                .filter(item => sameBookTitle(item.book.title) === newBookTitle)
                .forEach(superseded => {
                  if (currentUser) deleteBookFromCloud(currentUser.id, superseded.book.id).catch(() => {});
                  deleteFile(sourceCacheKey(superseded.book.id)).catch(() => {});
                });
            }
            await saveSourceToCache(newItem);
            setLibrary(prev => [newItem, ...prev.filter(item => !newBookTitle || sameBookTitle(item.book.title) !== newBookTitle)]);
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
         const textContent = await processEpub(file);
         await finalizeUpload({
            content: textContent,
            mimeType: 'text/plain',
            isText: true,
            sourceKind: 'epub',
         });
       } catch (err: any) {
         setError(err.message || "Failed to process EPUB.");
         setIsProcessing(false);
       }
       return;
    }

    if (file.name.toLowerCase().endsWith('.pdf')) {
       try {
         const { content: textContent, outline: pdfOutline, title: docTitle, figures } = await processPdf(file);
         await finalizeUpload({
            content: textContent,
            mimeType: 'text/plain',
            isText: true,
            sourceKind: 'pdf',
            sourceExtractorVersion: PDF_TEXT_EXTRACTION_VERSION,
            pdfOutline,
            docTitle,
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
    if (activeTab === Tab.GEN_FILES) {
      return (
        <div className="h-full animate-fade-in">
          <ErrorBoundary>
            <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader text="LOADING_MODULE..." /></div>}>
              <GeneratedFilesPanel library={library} />
            </Suspense>
          </ErrorBoundary>
        </div>
      );
    }

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

    let content;
    switch (activeTab) {
      case Tab.AUDIOBOOK:
        content = <AudioBook chapter={activeChapter} allChapters={activeBook?.chapters || []} fileContext={activeFileContext} settings={settings} onSettingsUpdate={setSettings} bookId={activeBookId!} initialPageTarget={activeChapterPageTarget} onChapterChange={(chapterId, pageTarget = 'first') => { setActiveChapterPageTarget(pageTarget); setActiveChapterId(chapterId); if (currentUser && activeBookId) debouncedReadingSync(currentUser.id, activeBookId, chapterId); }} />;
        break;
      case Tab.PODCAST:
        content = <PodcastPlayer chapter={activeChapter} fileContext={activeFileContext} settings={settings} bookId={activeBookId!} />;
        break;
      case Tab.CONCEPTS:
        content = <Visualizer chapter={activeChapter} fileContext={activeFileContext} bookId={activeBookId!} />;
        break;
      case Tab.ANIMATION:
        content = <VideoSummary chapter={activeChapter} fileContext={activeFileContext} bookId={activeBookId!} />;
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
  const switchTab = (tab: Tab) => { trackNavigation('module_switch', { from_module: activeTab, to_module: tab }); setActiveTab(tab); };
  const continueAfterLanguagePrompt = () => {
    setPendingLanguagePromptBookId(null);
    setView(AppView.DASHBOARD);
  };

  if (!configReady) {
    return (
      <div className="min-h-screen bg-[#020202] flex items-center justify-center">
        <div className="text-[#00f3ff] font-tech text-xs tracking-[0.3em] animate-pulse uppercase">Initializing_System...</div>
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
      <div className="min-h-screen bg-[#020202] bg-grid flex flex-col items-center justify-center p-4 md:p-6 relative overflow-hidden font-tech text-left">
        <div className="absolute top-8 left-8 w-24 h-24 border-l border-t border-zinc-800 rounded-tl-lg pointer-events-none hidden md:block"></div>
        <div className="absolute bottom-8 right-8 w-24 h-24 border-r border-b border-zinc-800 rounded-br-lg pointer-events-none hidden md:block"></div>

        <div className="z-10 max-w-lg w-full text-center space-y-8 md:space-y-12">
          <div className="space-y-2 animate-fade-in-up text-center">
             <div className="flex items-center justify-center gap-2 mb-4">
                <Terminal size={28} className="text-[#00f3ff] md:w-8 md:h-8" />
             </div>
            <h1 className="text-4xl md:text-7xl font-bold tracking-tighter text-white drop-shadow-[0_0_25px_rgba(0,243,255,0.3)]">
              Decod<span className="text-[#00f3ff]">Ebook</span>
            </h1>
            <p className="text-zinc-500 tracking-[0.2em] text-[10px] md:text-xs uppercase">
              V.4.2 // Neural Text Decoding Interface
            </p>
          </div>

          <div className="relative group animate-fade-in-up hud-border bg-[#050505] p-6 md:p-10 transition-all duration-500 hover:shadow-[0_0_30px_rgba(0,243,255,0.1)]" style={{ animationDelay: '0.1s' }}>
              {isProcessing ? (
                <Loader text="DECODING_SOURCE..." />
              ) : (
                <div className="relative flex flex-col items-center justify-center space-y-8">
                  <div className="relative">
                    <div className="w-32 h-32 bg-[#0a0a0c] border border-zinc-800 rounded-full flex items-center justify-center group-hover:border-[#00f3ff] transition-all duration-500">
                        <Upload className="w-12 h-12 text-zinc-600 group-hover:text-[#00f3ff] transition-colors" />
                    </div>
                    <div className="absolute -inset-2 border border-dashed border-zinc-800 rounded-full animate-spin-slow pointer-events-none group-hover:border-[#00f3ff]/30"></div>
                  </div>
                  <div className="space-y-2 text-center">
                    <p className="text-[#00f3ff] font-bold uppercase tracking-widest text-sm animate-pulse">Initialize Upload</p>
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
                className="text-zinc-500 hover:text-[#00f3ff] text-xs font-mono uppercase tracking-widest transition-colors flex items-center gap-2 mx-auto border border-transparent hover:border-[#00f3ff]/30 px-4 py-2 rounded-sm"
             >
                <LibraryIcon size={14} />
                Access_Data_Bank [{library.length}]
             </button>
          )}
          {error && <p className="text-[#ff003c] text-xs font-mono border border-[#ff003c]/30 p-2 bg-[#ff003c]/5">{error}</p>}
        </div>
        {pendingLanguagePromptBookId && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in">
            <div className="w-full max-w-md bg-[#050505] border border-zinc-800 rounded-lg shadow-[0_0_50px_rgba(0,243,255,0.08)] overflow-hidden text-left">
              <div className="h-[2px] bg-gradient-to-r from-[#00f3ff] to-[#ff003c]" />
              <div className="p-6 space-y-5">
                <div className="space-y-2">
                  <div className="text-[10px] font-mono text-[#00f3ff] uppercase tracking-[0.3em]">Translation_Default</div>
                  <h2 className="text-2xl font-black text-white uppercase tracking-tight">Choose Target Language</h2>
                  <p className="text-xs text-zinc-500 leading-relaxed font-mono">
                    This becomes the default translated layer for this and future books until you change it again.
                  </p>
                </div>
                <select
                  value={settings.targetLanguage}
                  onChange={(e) => setSettings(prev => ({ ...prev, targetLanguage: e.target.value }))}
                  className="w-full bg-[#020202] border border-zinc-800 text-[#00f3ff] font-mono text-xs uppercase focus:border-[#00f3ff] outline-none rounded-sm px-4 py-3 transition-all cursor-pointer"
                >
                  {TARGET_LANGUAGES.map(language => (
                    <option key={language} value={language}>{language}</option>
                  ))}
                </select>
                <button
                  onClick={continueAfterLanguagePrompt}
                  className="w-full py-3 bg-[#00f3ff] text-black font-black uppercase tracking-[0.25em] text-xs rounded-sm hover:bg-white transition-colors"
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
    <div className="flex h-screen bg-[#020202] bg-grid text-zinc-300 overflow-hidden font-sans relative text-left" style={{ '--content-font': settings.font ? `"${settings.font}", sans-serif` : 'inherit' } as React.CSSProperties}>
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

      {isSidebarOpen && <div className="fixed inset-0 bg-black/60 z-30 md:hidden" onClick={() => setSidebarOpen(false)} />}

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 md:w-80 transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:static md:z-20 md:translate-x-0 md:transition-all ${isSidebarOpen ? 'md:w-80' : 'md:w-0'} bg-[#050505] flex flex-col overflow-hidden border-r border-zinc-900`}
      >
        <div className="p-4 border-b border-zinc-900 shrink-0 bg-black/80 backdrop-blur-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-[1px] bg-[#00f3ff] opacity-20"></div>
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                    <Cpu size={16} className="text-[#00f3ff]" />
                    <span className="text-xs font-tech font-bold text-white tracking-[0.2em]">DECOD.EBOOK</span>
                </div>
                <button 
                    onClick={() => setView(AppView.UPLOAD)} 
                    className="p-1.5 rounded-sm hover:bg-zinc-900 text-zinc-600 hover:text-[#00f3ff] transition-colors"
                    title="Upload New"
                >
                    <Upload size={14} />
                </button>
            </div>
            {!showLibraryList && activeBook && (
                <div className="mt-4 p-3 border border-zinc-800 bg-zinc-900/20 rounded-sm relative group cursor-default">
                    <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[#00f3ff]"></div>
                    <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[#00f3ff]"></div>
                    <h1 className="font-bold text-xs text-white truncate leading-tight mb-1 font-tech uppercase tracking-wide">{activeBook.title}</h1>
                    <p className="text-[9px] text-zinc-500 truncate font-mono uppercase">{activeBook.author}</p>
                    <div className="mt-2 text-[9px] text-[#00f3ff] font-mono flex items-center gap-1">
                        <Activity size={10} /> SYS.ACTIVE
                    </div>
                </div>
            )}
        </div>
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {showLibraryList ? (
             <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col animate-fade-in">
                {library.map(item => (
                    <div
                        key={item.book.id}
                        className={`w-full flex items-center gap-3 p-4 border-b border-zinc-900 transition-all group ${
                            activeBookId === item.book.id
                            ? 'bg-[#00f3ff]/5'
                            : 'hover:bg-zinc-900'
                        }`}
                    >
                        <button
                            onClick={() => {
                                setActiveBookId(item.book.id);
                                if(item.book.chapters.length > 0) {
                                  setActiveChapterPageTarget('first');
                                  setActiveChapterId(item.book.chapters[0].id);
                                }
                                setShowLibraryList(false);
                                closeSidebarMobile();
                            }}
                            className="flex items-center gap-3 flex-1 min-w-0"
                        >
                            <div className={`w-1 h-8 shrink-0 ${activeBookId === item.book.id ? 'bg-[#00f3ff]' : 'bg-zinc-800'}`}></div>
                            <div className="text-left min-w-0">
                                <h4 className={`text-[10px] font-bold truncate font-tech uppercase tracking-wide ${activeBookId === item.book.id ? 'text-[#00f3ff]' : 'text-zinc-400'}`}>
                                    {item.book.title}
                                </h4>
                                <p className="text-[9px] text-zinc-600 truncate font-mono">{item.book.chapters.length} DATA_BLOCKS</p>
                            </div>
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteBook(item.book.id); }}
                            className="p-1.5 text-zinc-700 hover:text-[#ff003c] opacity-0 group-hover:opacity-100 transition-all shrink-0"
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
                <div className="shrink-0 px-4 pt-3 pb-3 border-b border-zinc-900 bg-black/40">
                  <div className="relative flex items-center">
                    <Search size={12} className="absolute left-2 text-zinc-600 pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="SEARCH_FULLTEXT"
                      className="w-full bg-zinc-900/60 border border-zinc-800 focus:border-[#00f3ff]/50 rounded-sm pl-7 pr-7 py-1.5 text-[11px] font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none tracking-wide"
                    />
                    {searchQuery && (
                      <button onClick={clearSearch} className="absolute right-2 text-zinc-600 hover:text-[#ff003c] transition-colors" title="Clear search">
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  {searchActive && (
                    <div className="mt-1.5 flex items-center justify-between text-[8px] font-mono uppercase tracking-widest text-zinc-600">
                      <span>{isIndexing ? 'INDEXING…' : `${searchResults.length} MATCH${searchResults.length === 1 ? '' : 'ES'}`}</span>
                      <button onClick={clearSearch} className="text-zinc-600 hover:text-[#00f3ff] transition-colors">CLEAR</button>
                    </div>
                  )}
                </div>
                {/* Results — bounded + independently scrollable, persist until cleared */}
                {searchActive && (
                  <div className="shrink-0 max-h-[45%] overflow-y-auto custom-scrollbar border-b border-zinc-900/70 bg-black/20">
                    {!isIndexing && searchResults.length === 0 ? (
                      <div className="px-4 py-4 text-[9px] font-mono uppercase tracking-widest text-zinc-700">No matches found</div>
                    ) : (
                      searchResults.map((hit, i) => (
                        <button
                          key={`${hit.chapterId}-${hit.pageIndex}-${i}`}
                          onClick={() => handleSearchResultClick(hit)}
                          className="w-full text-left px-4 py-2.5 border-b border-zinc-900/50 hover:bg-[#00f3ff]/5 group transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-[8px] font-mono uppercase tracking-wider text-[#00f3ff] truncate">
                              {String(hit.chapterNumber).padStart(2, '0')} · {hit.chapterTitle}
                            </span>
                            <span className="text-[8px] font-mono text-zinc-600 shrink-0">PG.{String(hit.pageNumber).padStart(2, '0')}{hit.occurrences > 1 ? ` ×${hit.occurrences}` : ''}</span>
                          </div>
                          <p
                            className="text-[10px] leading-snug text-zinc-500 group-hover:text-zinc-300 break-words overflow-hidden"
                            style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', height: '2.75em' } as React.CSSProperties}
                          >
                            {hit.snippet.slice(0, hit.matchStart)}
                            <mark className="bg-transparent text-[#00f3ff] font-semibold">{hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)}</mark>
                            {hit.snippet.slice(hit.matchStart + hit.matchLength)}
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                )}
                {/* Chapter list (TOC) */}
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar py-2">
                {activeBook?.chapters.map((chapter, idx) => {
                    const isBookmarked = activeBook.bookmarks?.includes(chapter.id);
                    return (
                        <div key={chapter.id} ref={activeChapterId === chapter.id ? activeChapterItemRef : undefined} className="relative group flex items-center justify-between px-4 py-2 hover:bg-zinc-900/50">
                            <button
                                title={chapter.title}
                                onClick={() => { trackBookAction('chapter_navigate', { from_chapter: activeChapterId, to_chapter: chapter.id }, activeBookId || undefined); setActiveChapterPageTarget('first'); setActiveChapterId(chapter.id); if (currentUser && activeBookId) debouncedReadingSync(currentUser.id, activeBookId, chapter.id); closeSidebarMobile(); }}
                                className={`flex-1 text-left flex items-center gap-3 border-l-2 py-1 transition-all min-w-0 pr-2 ${
                                    activeChapterId === chapter.id 
                                    ? 'border-[#00f3ff]' 
                                    : 'border-transparent'
                                }`}
                            >
                                <span className={`text-[9px] font-mono w-6 text-right shrink-0 ${activeChapterId === chapter.id ? 'text-[#00f3ff]' : 'text-zinc-700'}`}>
                                    {String(idx + 1).padStart(2, '0')}
                                </span>
                                <div className="min-w-0 flex-1 text-left">
                                    <p className={`font-medium truncate font-tech uppercase tracking-tight text-xs ${activeChapterId === chapter.id ? 'text-white' : 'text-zinc-500'}`}>
                                        {chapter.title}
                                    </p>
                                </div>
                            </button>
                            <button 
                                onClick={(e) => { e.stopPropagation(); toggleBookmark(chapter.id); }}
                                className={`p-1.5 transition-colors shrink-0 ${isBookmarked ? 'text-amber-400' : 'text-zinc-800 hover:text-zinc-500'}`}
                                title={isBookmarked ? "Remove Bookmark" : "Add Bookmark"}
                            >
                                <Tag size={12} fill={isBookmarked ? "currentColor" : "none"} />
                            </button>
                        </div>
                    );
                })}
                </div>
             </div>
          )}
        </div>
        <div className="p-0 border-t border-zinc-900 bg-black flex flex-col shrink-0">
          <button 
            onClick={() => setShowLibraryList(!showLibraryList)}
            className={`w-full flex items-center justify-between p-4 transition-all text-[10px] font-bold font-tech uppercase tracking-widest border-b border-zinc-900/30 ${
                showLibraryList ? 'text-[#00f3ff] bg-[#00f3ff]/5' : 'text-zinc-500 hover:bg-zinc-900 hover:text-[#00f3ff]'
            }`}
          >
             <div className="flex items-center gap-3">
                <Database size={14} />
                <span>{showLibraryList ? "SESSION_DATA" : "DATA_BANKS"}</span>
             </div>
             <span className={`text-[8px] animate-pulse ${showLibraryList ? 'text-[#00f3ff]' : 'text-zinc-700'}`}>●</span>
          </button>
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="w-full flex items-center gap-3 p-4 hover:bg-zinc-900 text-zinc-500 hover:text-[#00f3ff] transition-colors text-[10px] font-bold font-tech uppercase tracking-widest"
          >
            <SettingsIcon size={14} />
            <span>SYS_CONFIG</span>
          </button>
          <button
            onClick={() => setIsAccountOpen(true)}
            className={`w-full flex items-center gap-3 p-4 hover:bg-zinc-900 transition-colors text-[10px] font-bold font-tech uppercase tracking-widest ${currentUser ? 'text-emerald-500 hover:text-emerald-400' : 'text-zinc-500 hover:text-[#00f3ff]'}`}
          >
            <UserIcon size={14} />
            <span>MY_ACCOUNT</span>
            {userTier && userTier.tier !== 'free' && (
              <span className={`ml-auto text-[8px] px-1.5 py-0.5 rounded ${
                userTier.tier === 'pro' ? 'bg-[#00f3ff]/10 text-[#00f3ff]' :
                'bg-amber-500/10 text-amber-400'
              }`}>
                {userTier.tier.toUpperCase()}
              </span>
            )}
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 relative bg-transparent z-10 text-left">
        <header className="border-b border-zinc-900 bg-black/90 backdrop-blur-md sticky top-0 z-30 shrink-0">
          <div className="h-12 md:h-14 flex items-center justify-between px-3 md:px-4">
            <div className="flex items-center gap-2 md:gap-4 min-w-0">
              <button onClick={() => setSidebarOpen(!isSidebarOpen)} className="text-zinc-500 hover:text-[#00f3ff] transition-colors shrink-0">
                {isSidebarOpen ? <X size={18} /> : <Menu size={18} />}
              </button>
              <div className="h-4 w-[1px] bg-zinc-800 shrink-0"></div>
              {activeChapterId ? (
                  <div className="flex items-center gap-1.5 md:gap-2 min-w-0">
                      <span className="text-[8px] md:text-[9px] font-mono text-zinc-600 bg-zinc-900 border border-zinc-800 px-1 md:px-1.5 py-0.5 shrink-0">
                          SEC.{String(activeChapterId || 0).padStart(2, '0')}
                      </span>
                      <ChevronRight size={10} className="text-zinc-700 shrink-0 hidden sm:block" />
                      <span className="text-[10px] md:text-xs font-bold text-[#00f3ff] font-tech tracking-wide truncate">
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
                { id: Tab.GEN_FILES, icon: HardDrive, label: "GEN_FILES" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => { switchTab(tab.id as Tab); }}
                  className={`flex items-center justify-center gap-2 w-[120px] py-1.5 transition-all text-[9px] font-bold uppercase tracking-wider font-tech ${
                    activeTab === tab.id
                      ? 'bg-[#00f3ff]/10 text-[#00f3ff] shadow-[0_0_10px_rgba(0,243,255,0.1)]'
                      : 'text-zinc-600 hover:text-zinc-300 hover:bg-zinc-900'
                  }`}
                >
                  <tab.icon size={12} className={activeTab === tab.id ? 'text-[#00f3ff]' : ''} />
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
              { id: Tab.GEN_FILES, icon: HardDrive, label: "FILES" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => { switchTab(tab.id as Tab); }}
                className={`flex flex-col items-center justify-center flex-1 min-w-[52px] py-1.5 gap-0.5 transition-all ${
                  activeTab === tab.id
                    ? 'text-[#00f3ff] bg-[#00f3ff]/10 border-b-2 border-[#00f3ff]'
                    : 'text-zinc-600 border-b-2 border-transparent'
                }`}
              >
                <tab.icon size={14} className={activeTab === tab.id ? 'text-[#00f3ff]' : ''} />
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
