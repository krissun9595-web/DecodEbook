
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
import { PDF_TEXT_EXTRACTION_VERSION } from './utils/sourceVersion';
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

  const fileContext = hydrateFileContext(item.fileContext);
  const readableChapters = item.book.chapters.filter(chapter =>
    isReadableChapterTitle(chapter.title) &&
    isReadableChapterTitle(chapter.sourceHeading || chapter.title)
  );
  const chapters = fileContext.isText
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

  const processPdf = async (file: File): Promise<{ content: string; outline: PdfOutlineItem[] }> => {
    try {
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      const pages: string[] = [];

      // Resolve the PDF's outline (bookmarks) up front: each entry's destination gives a
      // page and a Y position. Capturing it now lets us anchor each chapter to its exact
      // heading line (by page + Y) while the per-page glyph geometry is still in scope —
      // which also separates multiple bookmarks that share one page. Failures are
      // non-fatal; unresolved entries are dropped and the caller falls back to heuristics.
      const outlineEntries: { title: string; page: number; y: number | null }[] = [];
      try {
        const rawOutline = await pdf.getOutline();
        for (const item of rawOutline || []) {
          try {
            const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
            if (!dest || !dest[0]) continue;
            const page = (await pdf.getPageIndex(dest[0])) + 1;
            const y = typeof dest[3] === 'number' ? dest[3] : null;
            const title = (item.title || '').replace(/\s+/g, ' ').trim();
            if (page && title) outlineEntries.push({ title, page, y });
          } catch { /* skip unresolvable entry */ }
        }
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
      // Resolve a font subset to italic/bold from its real descriptor name. PDF text
      // extraction reports opaque subset names (e.g. "g_d0_f3"), but the loaded font
      // object exposes the real name ("EBGaramond-Italic") — the only reliable emphasis
      // signal. Requires getOperatorList() to have loaded the page's fonts first.
      const fontEmphasisFor = (page: any, fontName: string, cache: Map<string, { italic: boolean; bold: boolean }>) => {
        const cached = cache.get(fontName);
        if (cached) return cached;
        let italic = false, bold = false;
        try {
          if (page.commonObjs?.has?.(fontName)) {
            const realName = String(page.commonObjs.get(fontName)?.name || '').toLowerCase();
            italic = /italic|oblique/.test(realName);
            bold = /bold|black|heavy|semibold|demi/.test(realName);
          }
        } catch { /* font flags unavailable — fall back to plain text */ }
        const style = { italic, bold };
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

      // Phase C: structure is decided from the page geometry, not guessed from the text
      // downstream. Each page's classified lines are buffered, then — once the whole
      // document's body font size is known (a chapter-start page is heading-heavy and would
      // skew a per-page estimate) — grouped into blocks and emitted. INDENT_TOL is shared
      // with the per-page index-indent logic.
      const INDENT_TOL = 4;
      type PdfLine = { y: number; x: number; text: string; h: number; bold: boolean };
      const pageBuffers: { pageNum: number; lines: PdfLine[]; bodyLeft: number; lineGap: number; isListPage: boolean; indentTiers: number[] }[] = [];
      const allLineHeights: number[] = [];

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        // getOperatorList loads the page's fonts (so their real italic/bold names are
        // resolvable); getTextContent gives the glyph runs. Run both together.
        const [, textContent, annotations] = await Promise.all([
          page.getOperatorList().catch(() => null),
          page.getTextContent(),
          page.getAnnotations().catch(() => [] as any[]),
        ]);
        const fontCache = new Map<string, { italic: boolean; bold: boolean }>();

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
        const coveringLink = (gx: number, gw: number, gy: number): { url?: string; noteKey?: string } | null => {
          const cx = gx + (gw || 0) / 2;
          for (const u of uriLinks) { const [x1, y1, x2, y2] = u.rect; if (cx >= x1 - 1 && cx <= x2 + 1 && gy >= y1 - 2 && gy <= y2 + 2) return { url: u.url }; }
          for (const gl of gotoLinks) { const [x1, y1, x2, y2] = gl.rect; if (cx >= x1 - 1 && cx <= x2 + 1 && gy >= y1 - 2 && gy <= y2 + 2) return { noteKey: gl.key }; }
          return null;
        };

        type PdfGlyph = { x: number; y: number; h: number; w: number; str: string; italic: boolean; bold: boolean; linkUrl?: string; noteKey?: string };
        const glyphs: PdfGlyph[] = [];
        for (const item of textContent.items as any[]) {
          if (!('str' in item) || !item.str.trim()) continue;
          const tr = item.transform || [];
          const emphasis = fontEmphasisFor(page, item.fontName, fontCache);
          const x = tr[4] || 0, y = tr[5] || 0, w = item.width || 0;
          const link = coveringLink(x, w, y);
          glyphs.push({
            x, y,
            h: Math.hypot(tr[0] || 0, tr[1] || 0) || item.height || 0,
            w,
            str: item.str,
            italic: emphasis.italic,
            bold: emphasis.bold,
            linkUrl: link?.url,
            noteKey: link?.noteKey,
          });
        }
        if (glyphs.length === 0) continue;

        // Cluster glyphs into visual lines by baseline with a tolerance, so a raised
        // superscript footnote marker (smaller font, a few points above the baseline)
        // joins its own line instead of becoming a detached digit on its own line.
        const bodyHeight = mode(glyphs.map(g => Math.round(g.h))) || median(glyphs.map(g => g.h));
        const lineTolerance = Math.max(2, bodyHeight * 0.5);
        glyphs.sort((a, b) => b.y - a.y || a.x - b.x);
        const groups: { baseY: number; baseH: number; items: PdfGlyph[] }[] = [];
        for (const g of glyphs) {
          let best: { baseY: number; baseH: number; items: PdfGlyph[] } | null = null;
          let bestDist = Infinity;
          for (const group of groups) {
            const dist = Math.abs(group.baseY - g.y);
            if (dist <= lineTolerance && dist < bestDist) { bestDist = dist; best = group; }
          }
          if (!best) { best = { baseY: g.y, baseH: g.h, items: [] }; groups.push(best); }
          best.items.push(g);
          // Anchor the line on its tallest glyph (the body baseline), not a superscript.
          if (g.h > best.baseH * 1.05) { best.baseY = g.y; best.baseH = g.h; }
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
              const digits = txt.replace(/\D+/g, '');
              // Only a forward link (destination on a later page) is a body footnote marker.
              // A note's number often carries the PDF's own backward link (note → marker);
              // leaving that as plain text lets the forward note-anchor be injected onto it,
              // and the reader provides the back-navigation. Cross-references stay text too.
              const destPage = Number(key.match(/^pdffn-p(\d+)-/)?.[1] || 0);
              const markerLike = destPage > pageNum && digits.length >= 1 && digits.length <= 3 && /^[\[(]?\d{1,3}[.)\]]?$/.test(txt);
              if (markerLike) { markerEmit[i] = { label: digits, key }; for (let k = i + 1; k < j; k++) skip[k] = true; }
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
              const glue = !!prev && prev.w > 0 && (it.x - (prev.x + prev.w)) <= gapThreshold;
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
              const isMarker = idx > 0 && /^\d{1,3}$/.test(trimmed) && it.h < lineBodyHeight * 0.84;
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
                if (linkChanged && openLink) { out += `](${openLink})`; openLink = null; }
                out += separator;
                if (linkChanged && it.linkUrl) { out += '['; openLink = it.linkUrl; }
                if (style) { out += MARK[style]; open = style; }
              } else {
                out += separator;
              }
              out += it.str;
            });
            if (open) out += MARK[open];
            if (openLink) out += `](${openLink})`;
            return {
              y: group.baseY,
              x: Math.min(...items.map(it => it.x)),
              text: out.replace(/\s+/g, ' ').trim(),
              h: lineBodyHeight,
              bold: items.filter(it => it.bold).length > items.length / 2,
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
                /^(\s*)(\d{1,3})[.)]\s*/,
                (_m, sp, n) => `${sp}[${n}](#${target.key}) `
              );
            }
          }
        }

        const bodyLeft = mostFrequentLeft(pageLines.map(line => line.x));
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
        if (!isListPage) allLineHeights.push(...pageLines.map(line => line.h).filter(Boolean));
        pageBuffers.push({ pageNum, lines: pageLines, bodyLeft, lineGap, isListPage, indentTiers });
      }

      // Phase C: the document body font is the most common line height across prose pages;
      // a line whose font is clearly larger is a heading/subtitle. With the baseline known,
      // group each page's lines into blocks and join soft-wrapped lines, so the cleanup and
      // reader classify whole paragraphs/headings instead of per-line fragments (what made
      // a small-caps sentence tail look like a subtitle, split a wrapped quote into a new
      // paragraph, and shattered a multi-line heading).
      const bodyFont = mode(allLineHeights.map(h => Math.round(h))) || median(allLineHeights) || 0;
      const isHeadingLine = (line: PdfLine): boolean => bodyFont > 0 && line.h >= bodyFont * 1.2;

      for (const buf of pageBuffers) {
        const { pageNum, lines, bodyLeft, lineGap, isListPage, indentTiers } = buf;
        const indentDepthFor = (x: number): number => {
          const tier = indentTiers.findIndex(t => Math.abs(t - x) <= INDENT_TOL);
          return tier >= 1 ? Math.min(tier, 3) : 0;
        };

        // Index/contents: one indented entry per line (a list, not prose \u2014 never joined).
        if (isListPage) {
          const formattedLines: string[] = [];
          lines.forEach((line, index) => {
            const previous = lines[index - 1];
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
          if (pageText) pages.push(`[[PAGE ${pageNum}]]\n${pageText}`);
          continue;
        }

        // Prose page: paragraph spacing comes from the BODY lines only (a chapter-start
        // page's page-wide gap is skewed by large heading leading). Walk the lines,
        // gathering a run of one kind, then join it into a single block.
        const bodyLines = lines.filter(line => !isHeadingLine(line));
        const bodyGaps = bodyLines.slice(1).map((line, index) => bodyLines[index].y - line.y).filter(gap => gap > 0 && gap < bodyFont * 3);
        const bodyLineGap = median(bodyGaps) || lineGap;

        const blocks: string[] = [];
        let i = 0;
        while (i < lines.length) {
          const groupIsHeading = isHeadingLine(lines[i]);
          const group: PdfLine[] = [lines[i]];
          let j = i + 1;
          while (j < lines.length && isHeadingLine(lines[j]) === groupIsHeading) {
            const previous = lines[j - 1];
            const current = lines[j];
            const verticalGap = previous.y - current.y;
            let endsBlock: boolean;
            if (groupIsHeading) {
              // Wrapped heading lines join; a gap larger than the heading's own leading
              // separates two stacked headings (a chapter title above its subtitle).
              endsBlock = verticalGap > Math.max(previous.h, current.h) * 1.35;
            } else {
              const isIndentedBodyLine = current.x > bodyLeft + 8 && !startsDialogueLine(current.text);
              endsBlock =
                (bodyLineGap > 0 && verticalGap > bodyLineGap * 1.35) ||
                (endsWithTerminalPunctuation(previous.text) && (isIndentedBodyLine || startsParagraphTransitionLine(current.text)));
            }
            if (endsBlock) break;
            group.push(current);
            j++;
          }
          // Join the block into one line, keeping a word hyphenated across a line break.
          let text = group[0].text;
          for (let k = 1; k < group.length; k++) {
            text = /[A-Za-z]-$/.test(text) && /^[a-z]/.test(group[k].text)
              ? text + group[k].text
              : `${text} ${group[k].text}`;
          }
          text = text.replace(/\s+/g, ' ').trim();
          // A heading is styled as a whole by the reader, so inline emphasis inside it is
          // noise. It also actively harms: a bold-only glyph among bold-italic words (e.g.
          // an upright bold chapter number, "Chapter **5.** *The Life…*") leaves a stray
          // "**" that shows literally and breaks the notes "Chapter N" section detection.
          // Drop emphasis markers from heading blocks (footnote links are left intact).
          if (groupIsHeading) text = text.replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim();
          if (text) blocks.push(text);
          i = j;
        }

        const pageText = blocks.join('\n\n').trim();
        if (pageText) pages.push(`[[PAGE ${pageNum}]]\n${pageText}`);
      }

      const fullText = pages.join('\n\n');
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
          if (heading.text && heading.text.length >= 3) {
            const nextBlock = fullText.indexOf('[[PAGE ', blockStart + 1);
            const within = fullText.indexOf(heading.text, blockStart);
            if (within >= 0 && (nextBlock < 0 || within < nextBlock)) offset = within;
          }
        }
        return { title: entry.title, page: entry.page, level: 0, offset };
      });

      return { content: fullText, outline };
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

    const finalizeUpload = async (context: FileContext) => {
        try {
            const preparedContext = hydrateFileContext(context);
            const structure = await analyzeBookStructure(preparedContext);
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
            await saveSourceToCache(newItem);
            setLibrary(prev => [newItem, ...prev]);
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
         const { content: textContent, outline: pdfOutline } = await processPdf(file);
         await finalizeUpload({
            content: textContent,
            mimeType: 'text/plain',
            isText: true,
            sourceKind: 'pdf',
            sourceExtractorVersion: PDF_TEXT_EXTRACTION_VERSION,
            pdfOutline,
         });
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
