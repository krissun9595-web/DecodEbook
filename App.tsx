
import React, { useState, useEffect, Suspense } from 'react';
import { Upload, BookOpen, Headphones, Image as ImageIcon, BookA, Film, Menu, X, ChevronRight, FileText, Mic2, Settings as SettingsIcon, Library as LibraryIcon, Tag, Bookmark, Cpu, Notebook as NotebookIcon, Terminal, Activity, Database, Shield, HardDrive } from 'lucide-react';
import JSZip from 'jszip';
import { BookStructure, Chapter, AppView, Tab, FileContext, AppSettings, LibraryItem, NotebookItem } from './types';
import { analyzeBookStructure, getQuickDefinition } from './services/gemini';
import { SettingsModal } from './components/SettingsModal';
import { GlobalContextLayer } from './components/GlobalContextLayer';
import { Loader } from './components/ui/Loader';
import { AIAssistant } from './components/AIAssistant';
import { ErrorBoundary } from './components/ui/ErrorBoundary';

const PodcastPlayer = React.lazy(() => import('./components/PodcastPlayer').then(module => ({ default: module.PodcastPlayer })));
const Visualizer = React.lazy(() => import('./components/Visualizer').then(module => ({ default: module.Visualizer })));
const VideoSummary = React.lazy(() => import('./components/VideoSummary').then(module => ({ default: module.VideoSummary })));
const AudioBook = React.lazy(() => import('./components/AudioBook').then(module => ({ default: module.AudioBook })));
const Notebook = React.lazy(() => import('./components/Notebook').then(module => ({ default: module.Notebook })));
const GeneratedFilesPanel = React.lazy(() => import('./components/GeneratedFilesPanel').then(module => ({ default: module.GeneratedFilesPanel })));

const App: React.FC = () => {
  const [view, setView] = useState<AppView>(AppView.UPLOAD);
  
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  
  // Notebook State
  const [notebook, setNotebook] = useState<NotebookItem[]>([]);

  const activeBook = library.find(item => item.book.id === activeBookId)?.book || null;
  const activeFileContext = library.find(item => item.book.id === activeBookId)?.fileContext || null;

  const [activeChapterId, setActiveChapterId] = useState<number | null>(null);
  const activeChapter = activeBook?.chapters.find(c => c.id === activeChapterId) || null;

  const [activeTab, setActiveTab] = useState<Tab>(Tab.AUDIOBOOK);
  const [isSidebarOpen, setSidebarOpen] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLibraryList, setShowLibraryList] = useState(false);
  
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showGeneratedFiles, setShowGeneratedFiles] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    targetLanguage: 'Spanish',
    highlightColor: 'indigo',
    textSize: 'base',
    lineHeight: 'normal',
    letterSpacing: 'normal',
    font: 'Inter'
  });

  useEffect(() => {
      const savedNotebook = localStorage.getItem('notebook');
      if (savedNotebook) setNotebook(JSON.parse(savedNotebook));
      
      const savedLibrary = localStorage.getItem('library');
      if (savedLibrary) setLibrary(JSON.parse(savedLibrary));
  }, []);

  useEffect(() => {
      localStorage.setItem('notebook', JSON.stringify(notebook));
  }, [notebook]);

  useEffect(() => {
      localStorage.setItem('library', JSON.stringify(library));
  }, [library]);

  const handleAddToNotebook = (item: Omit<NotebookItem, 'id' | 'timestamp'>) => {
      // Clean text: remove ** characters and trim whitespace
      const cleanText = item.text.replace(/\*\*/g, '').trim();

      // Duplicate check: if item already exists, do not add it
      if (notebook.some(n => n.text === cleanText)) {
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
          const manifest: Record<string, string> = {};
          Array.from(opfDoc.getElementsByTagName("item")).forEach(item => {
              const id = item.getAttribute("id");
              const href = item.getAttribute("href");
              if (id && href) manifest[id] = href;
          });

          // 2. Get spine order (idref)
          const spineIds = Array.from(opfDoc.getElementsByTagName("itemref"))
              .map(item => item.getAttribute("idref"))
              .filter(id => id !== null) as string[];

          // 3. Resolve file paths
          const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);
          
          spineIds.forEach(id => {
              if (manifest[id]) {
                  const href = manifest[id];
                  const decodedHref = decodeURIComponent(href);
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
            filename.match(/\.(html|xhtml|htm)$/i) && !filename.includes('__MACOSX')
          );
          sortedFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      }

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
        const text = doc.body.textContent || "";
        fullText += text.trim() + "\n\n";
      }

      if (!fullText) throw new Error("No readable text found in EPUB.");
      if (fullText.length > 5000000) {
          return fullText.substring(0, 5000000) + "\n\n[...Content truncated due to excessive size...]";
      }
      return fullText;

    } catch (e) {
      console.error("EPUB processing error", e);
      throw new Error("Could not parse EPUB file. Structure may be corrupted.");
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

    const reader = new FileReader();
    const isEpub = file.name.toLowerCase().endsWith('.epub');
    const isTextBased = file.type.startsWith('text/') || 
                        ['.txt', '.md', '.html', '.xml'].some(ext => file.name.toLowerCase().endsWith(ext));

    const finalizeUpload = async (context: FileContext) => {
        try {
            const structure = await analyzeBookStructure(context);
            const newItem: LibraryItem = {
                book: structure,
                fileContext: context,
                uploadDate: Date.now()
            };
            setLibrary(prev => [newItem, ...prev]);
            setActiveBookId(structure.id);
            if (structure.chapters.length > 0) setActiveChapterId(structure.chapters[0].id);
            setView(AppView.DASHBOARD);
            setShowLibraryList(false);
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
            isText: true
         });
       } catch (err: any) {
         setError(err.message || "Failed to process EPUB.");
         setIsProcessing(false);
       }
       return;
    }

    reader.onload = async (e) => {
      let context: FileContext;
      if (isTextBased) {
          let content = e.target?.result as string;
          if (content.length > 2000000) content = content.substring(0, 2000000) + "... [Truncated]";
          context = { content, mimeType: 'text/plain', isText: true };
      } else {
          const rawBase64 = (e.target?.result as string).split(',')[1];
          // Strip newlines and whitespace which are common in base64 output and break API calls
          const cleanBase64 = rawBase64.replace(/[\r\n\s]+/g, '');
          context = { content: cleanBase64, mimeType: 'application/pdf', isText: false };
      }
      await finalizeUpload(context);
    };

    if (isTextBased) reader.readAsText(file);
    else reader.readAsDataURL(file);
  };

  const toggleBookmark = (chapterId: number) => {
    if (!activeBookId) return;
    setLibrary(prev => prev.map(item => {
        if (item.book.id === activeBookId) {
            const bookmarks = item.book.bookmarks || [];
            const isBookmarked = bookmarks.includes(chapterId);
            const newBookmarks = isBookmarked 
                ? bookmarks.filter(id => id !== chapterId)
                : [...bookmarks, chapterId];
            return { ...item, book: { ...item.book, bookmarks: newBookmarks } };
        }
        return item;
    }));
  };

  const renderContent = () => {
    if (showGeneratedFiles) {
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
        content = <AudioBook chapter={activeChapter} fileContext={activeFileContext} settings={settings} onSettingsUpdate={setSettings} bookId={activeBookId!} />;
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

  if (view === AppView.UPLOAD) {
    return (
      <div className="min-h-screen bg-[#020202] bg-grid flex flex-col items-center justify-center p-6 relative overflow-hidden font-tech text-left">
        <div className="absolute top-8 left-8 w-24 h-24 border-l border-t border-zinc-800 rounded-tl-lg pointer-events-none"></div>
        <div className="absolute bottom-8 right-8 w-24 h-24 border-r border-b border-zinc-800 rounded-br-lg pointer-events-none"></div>

        <div className="z-10 max-w-lg w-full text-center space-y-12">
          <div className="space-y-2 animate-fade-in-up text-center">
             <div className="flex items-center justify-center gap-2 mb-4">
                <Terminal size={32} className="text-[#00f3ff]" />
             </div>
            <h1 className="text-7xl font-bold tracking-tighter text-white drop-shadow-[0_0_25px_rgba(0,243,255,0.3)]">
              Decod<span className="text-[#00f3ff]">Ebook</span>
            </h1>
            <p className="text-zinc-500 tracking-[0.2em] text-xs uppercase">
              V.4.2 // Neural Text Decoding Interface
            </p>
          </div>

          <div className="relative group animate-fade-in-up hud-border bg-[#050505] p-10 transition-all duration-500 hover:shadow-[0_0_30px_rgba(0,243,255,0.1)]" style={{ animationDelay: '0.1s' }}>
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

      <aside 
        className={`${isSidebarOpen ? 'w-80' : 'w-0'} bg-[#050505] flex flex-col overflow-hidden relative z-20 transition-all duration-300 border-r border-zinc-900`}
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
        <div className="flex-1 overflow-y-auto p-0 custom-scrollbar">
          {showLibraryList ? (
             <div className="flex flex-col animate-fade-in">
                {library.map(item => (
                    <button
                        key={item.book.id}
                        onClick={() => {
                            setActiveBookId(item.book.id);
                            if(item.book.chapters.length > 0) setActiveChapterId(item.book.chapters[0].id);
                            setShowLibraryList(false);
                        }}
                        className={`w-full flex items-center gap-3 p-4 border-b border-zinc-900 transition-all group ${
                            activeBookId === item.book.id 
                            ? 'bg-[#00f3ff]/5' 
                            : 'hover:bg-zinc-900'
                        }`}
                    >
                        <div className={`w-1 h-8 ${activeBookId === item.book.id ? 'bg-[#00f3ff]' : 'bg-zinc-800'}`}></div>
                        <div className="text-left min-w-0">
                            <h4 className={`text-[10px] font-bold truncate font-tech uppercase tracking-wide ${activeBookId === item.book.id ? 'text-[#00f3ff]' : 'text-zinc-400'}`}>
                                {item.book.title}
                            </h4>
                            <p className="text-[9px] text-zinc-600 truncate font-mono">{item.book.chapters.length} DATA_BLOCKS</p>
                        </div>
                    </button>
                ))}
             </div>
          ) : (
             <div className="py-2 animate-fade-in">
                {activeBook?.chapters.map((chapter, idx) => {
                    const isBookmarked = activeBook.bookmarks?.includes(chapter.id);
                    return (
                        <div key={chapter.id} className="relative group flex items-center justify-between px-4 py-2 hover:bg-zinc-900/50">
                            <button
                                onClick={() => setActiveChapterId(chapter.id)}
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
            onClick={() => setShowGeneratedFiles(!showGeneratedFiles)}
            className={`w-full flex items-center justify-between p-4 transition-all text-[10px] font-bold font-tech uppercase tracking-widest border-b border-zinc-900/30 ${
              showGeneratedFiles ? 'text-[#00f3ff] bg-[#00f3ff]/5' : 'text-zinc-500 hover:bg-zinc-900 hover:text-[#00f3ff]'
            }`}
          >
            <div className="flex items-center gap-3">
              <HardDrive size={14} />
              <span>GEN_FILES</span>
            </div>
            <span className={`text-[8px] animate-pulse ${showGeneratedFiles ? 'text-[#00f3ff]' : 'text-zinc-700'}`}>●</span>
          </button>
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="w-full flex items-center gap-3 p-4 hover:bg-zinc-900 text-zinc-500 hover:text-[#00f3ff] transition-colors text-[10px] font-bold font-tech uppercase tracking-widest"
          >
            <SettingsIcon size={14} />
            <span>SYS_CONFIG</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 relative bg-transparent z-10 text-left">
        <header className="h-14 border-b border-zinc-900 flex items-center justify-between px-4 bg-black/90 backdrop-blur-md sticky top-0 z-30 shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setSidebarOpen(!isSidebarOpen)} className="text-zinc-500 hover:text-[#00f3ff] transition-colors">
              {isSidebarOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
            <div className="h-4 w-[1px] bg-zinc-800 mx-1"></div>
            {activeChapterId ? (
                <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-zinc-600 bg-zinc-900 border border-zinc-800 px-1.5 py-0.5">
                        SEC.{String(activeChapterId || 0).padStart(2, '0')}
                    </span>
                    <ChevronRight size={12} className="text-zinc-700" />
                    <span className="text-xs font-bold text-[#00f3ff] font-tech tracking-wide truncate max-w-[200px]">
                        {activeChapter?.title.toUpperCase()}
                    </span>
                </div>
            ) : (
                <span className="text-xs font-tech text-zinc-500 tracking-widest">AWAITING_INPUT</span>
            )}
          </div>

          <div className="flex items-center bg-zinc-950 border border-zinc-900 p-0.5 rounded-sm">
            {[
              { id: Tab.AUDIOBOOK, icon: Headphones, label: "VOICE_SYNTH" },
              { id: Tab.PODCAST, icon: Mic2, label: "NET_CAST" },
              { id: Tab.CONCEPTS, icon: ImageIcon, label: "VISUAL_CORE" },
              { id: Tab.ANIMATION, icon: Film, label: "CINE_RENDER" },
              { id: Tab.NOTEBOOK, icon: NotebookIcon, label: "MEM_LOG" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id as Tab); setShowGeneratedFiles(false); }}
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
        </header>

        <div className="flex-1 p-0 overflow-hidden relative">
          <div className="h-full w-full p-2 overflow-y-scroll custom-scrollbar">
             {renderContent()}
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
