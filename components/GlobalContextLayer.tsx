
import React, { useState, useEffect, useRef } from 'react';
import { Book, Copy, Search, Loader2, BookOpen, FilePlus, Volume2, Languages } from 'lucide-react';
import { getQuickDefinition, generateSpeech, translateText } from '../services/gemini';
import { NotebookItem } from '../types';
import { pcmToWav } from '../utils/audio';
import { trackEvent, trackNotebook } from '../utils/analytics';

interface Props {
  onAddToNotebook: (item: Omit<NotebookItem, 'id' | 'timestamp'>) => void;
  activeLanguage: string;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  text: string;
  source: string; // New field for context source
}

interface DefinitionState {
  visible: boolean;
  loading: boolean;
  text: string | null;
  originalText: string | null;
  translatedText: string | null;
  isTranslated: boolean;
  position: { x: number; y: number };
}

const isMobile = () => 'ontouchstart' in window || navigator.maxTouchPoints > 0;

const getSelectionSource = (selection: Selection): string => {
  let source = "Input_Stream";
  let node: Node | null = selection.anchorNode;
  while (node && node !== document.body) {
    if (node instanceof Element && node.getAttribute('data-source')) {
      source = node.getAttribute('data-source') || "Input_Stream";
      break;
    }
    node = node.parentElement;
  }
  return source;
};

const getSelectionPosition = (selection: Selection): { x: number; y: number } => {
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const TOOLBAR_WIDTH = 200;
  let x = rect.left + rect.width / 2 - TOOLBAR_WIDTH / 2;
  let y = rect.top - 52;
  if (x < 8) x = 8;
  if (x + TOOLBAR_WIDTH > window.innerWidth) x = window.innerWidth - TOOLBAR_WIDTH - 8;
  if (y < 8) y = rect.bottom + 8;
  return { x, y };
};

export const GlobalContextLayer: React.FC<Props> = ({ onAddToNotebook, activeLanguage }) => {
  const [menu, setMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, text: '', source: 'Input_Stream' });
  const [definition, setDefinition] = useState<DefinitionState>({
      visible: false,
      loading: false,
      text: null,
      originalText: null,
      translatedText: null,
      isTranslated: false,
      position: { x: 0, y: 0 }
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [mobileBar, setMobileBar] = useState<{ visible: boolean; x: number; y: number; text: string; source: string }>({ visible: false, x: 0, y: 0, text: '', source: 'Input_Stream' });

  const menuRef = useRef<HTMLDivElement>(null);
  const defRef = useRef<HTMLDivElement>(null);
  const mobileBarRef = useRef<HTMLDivElement>(null);

  // Desktop: right-click context menu
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      if (isMobile()) return;
      const selection = window.getSelection();
      const text = selection?.toString().trim();

      if (text && text.length > 0) {
        e.preventDefault();
        let x = e.clientX;
        let y = e.clientY;
        if (x + 200 > window.innerWidth) x = window.innerWidth - 210;
        if (y + 150 > window.innerHeight) y = window.innerHeight - 160;

        const source = getSelectionSource(selection);
        setMenu({ visible: true, x, y, text, source });
        setDefinition(prev => ({ ...prev, visible: false }));
        setMobileBar(prev => ({ ...prev, visible: false }));
      }
    };

    const handleClick = (e: MouseEvent) => {
      if (menu.visible && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(prev => ({ ...prev, visible: false }));
      }
      if (definition.visible && defRef.current && !defRef.current.contains(e.target as Node)) {
          setDefinition(prev => ({ ...prev, visible: false }));
      }
    };

    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [menu.visible, definition.visible]);

  // Mobile: selection change detection
  useEffect(() => {
    if (!isMobile()) return;

    let checkTimer: ReturnType<typeof setTimeout>;
    const handleSelectionChange = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        const selection = window.getSelection();
        const text = selection?.toString().trim();
        if (text && text.length > 0 && selection!.rangeCount > 0) {
          const source = getSelectionSource(selection!);
          const pos = getSelectionPosition(selection!);
          setMobileBar({ visible: true, x: pos.x, y: pos.y, text, source });
        } else {
          setMobileBar(prev => ({ ...prev, visible: false }));
        }
      }, 300);
    };

    const handleTouchEnd = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        const selection = window.getSelection();
        const text = selection?.toString().trim();
        if (text && text.length > 0 && selection!.rangeCount > 0) {
          const source = getSelectionSource(selection!);
          const pos = getSelectionPosition(selection!);
          setMobileBar({ visible: true, x: pos.x, y: pos.y, text, source });
        }
      }, 200);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (mobileBarRef.current && !mobileBarRef.current.contains(e.target as Node) &&
          defRef.current && !defRef.current.contains(e.target as Node)) {
        setMobileBar(prev => prev.visible ? { ...prev, visible: false } : prev);
      }
      if (defRef.current && !defRef.current.contains(e.target as Node)) {
        setDefinition(prev => prev.visible ? { ...prev, visible: false } : prev);
      }
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchstart', handleTouchStart);
    return () => {
      clearTimeout(checkTimer);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchstart', handleTouchStart);
    };
  }, []);

  const activeText = menu.visible ? menu.text : mobileBar.text;
  const activeSource = menu.visible ? menu.source : mobileBar.source;

  const handleDefine = async (e: React.MouseEvent, fromMobile = false) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();

    const srcX = fromMobile ? mobileBar.x : menu.x;
    const srcY = fromMobile ? mobileBar.y : menu.y;
    const text = fromMobile ? mobileBar.text : menu.text;

    const POPUP_WIDTH = isMobile() ? Math.min(320, window.innerWidth - 32) : 320;
    const MAX_HEIGHT = 400;
    const MARGIN = 16;

    let x = srcX;
    let y = srcY;

    if (x + POPUP_WIDTH + MARGIN > window.innerWidth) {
        x = window.innerWidth - POPUP_WIDTH - MARGIN;
    }
    x = Math.max(MARGIN, x);

    if (y + MAX_HEIGHT + MARGIN > window.innerHeight) {
        y = window.innerHeight - MAX_HEIGHT - MARGIN;
    }
    y = Math.max(MARGIN, y);

    setDefinition({
        visible: true,
        loading: true,
        text: null,
        originalText: null,
        translatedText: null,
        isTranslated: false,
        position: { x, y }
    });
    setMenu(prev => ({ ...prev, visible: false }));
    setMobileBar(prev => ({ ...prev, visible: false }));
    window.getSelection()?.removeAllRanges();

    try {
        const def = await getQuickDefinition(text, "the same language as the provided text");
        setDefinition(prev => ({
            ...prev,
            loading: false,
            text: def,
            originalText: def
        }));
        trackEvent('ai', 'define_word', { word: text, source: fromMobile ? 'mobile_toolbar' : 'context_menu' });
    } catch (e) {
        setDefinition(prev => ({ ...prev, loading: false, text: "Could not retrieve definition." }));
    }
  };

  const handleTranslateToggle = async () => {
      if (isTranslating || definition.loading || !definition.originalText) return;
      
      if (definition.isTranslated) {
           setDefinition(prev => ({
              ...prev,
              text: prev.originalText,
              isTranslated: false
          }));
      } else {
          if (definition.translatedText) {
              setDefinition(prev => ({
                  ...prev,
                  text: prev.translatedText,
                  isTranslated: true
              }));
          } else {
              setIsTranslating(true);
              setDefinition(prev => ({ ...prev, loading: true }));
              try {
                  let targetLang = activeLanguage === 'Original' ? 'English' : activeLanguage;
                  
                  if (activeSource === 'Translated_Layer') {
                      targetLang = 'English';
                  }

                  const trans = await translateText(definition.originalText, targetLang);
                  setDefinition(prev => ({ 
                      ...prev, 
                      loading: false, 
                      text: trans,
                      translatedText: trans,
                      isTranslated: true
                  }));
              } catch(e) {
                  setDefinition(prev => ({ ...prev, loading: false }));
              } finally {
                  setIsTranslating(false);
              }
          }
      }
  };

  const handlePronounce = async () => {
      if (isPlaying || !activeText) return;
      setIsPlaying(true);
      let audioUrl: string | null = null;
      try {
          const b64 = await generateSpeech(activeText, "Puck");
          if(b64) {
             const binaryString = atob(b64);
             const len = binaryString.length;
             const buffer = new Uint8Array(len);
             for (let i = 0; i < len; i++) buffer[i] = binaryString.charCodeAt(i);
             const blob = pcmToWav(buffer.buffer, 24000);
             audioUrl = URL.createObjectURL(blob);
             const audio = new Audio(audioUrl);
             audio.onended = () => {
                 setIsPlaying(false);
                 if (audioUrl) URL.revokeObjectURL(audioUrl);
             };
             await audio.play();
          } else {
             setIsPlaying(false);
          }
      } catch (e) {
          console.error(e);
          setIsPlaying(false);
          if (audioUrl) URL.revokeObjectURL(audioUrl);
      }
  };

  const handleAddToNotebook = (fromMobile = false) => {
     const text = fromMobile ? mobileBar.text : menu.text;
     const source = fromMobile ? mobileBar.source : menu.source;
     onAddToNotebook({
         text,
         type: text.includes(' ') && text.length > 30 ? 'sentence' : 'word',
         definition: undefined,
         contextSource: source
     });
     trackNotebook('add_note', { source: fromMobile ? 'mobile_toolbar' : 'context_menu', word_count: text.split(/\s+/).length });
     setMenu(prev => ({ ...prev, visible: false }));
     setMobileBar(prev => ({ ...prev, visible: false }));
     window.getSelection()?.removeAllRanges();
  };

  const handleSaveWithDefinition = () => {
      onAddToNotebook({
         text: activeText,
         type: activeText.includes(' ') && activeText.length > 30 ? 'sentence' : 'word',
         definition: definition.text || undefined,
         contextSource: activeSource
      });
      setDefinition(prev => ({ ...prev, visible: false }));
  };

  const formatDefinition = (text: string) => {
      if (!text) return null;
      return text.split('\n\n').map((section, idx) => {
          const parts = section.split(':');
          if (parts.length > 1 && parts[0].length < 25) {
             return (
                 <div key={idx} className="mb-3">
                     <span className="text-[#00f3ff] font-bold uppercase text-[10px] tracking-widest">{parts[0]}:</span>
                     <p className="mt-1 text-zinc-300">{parts.slice(1).join(':').trim()}</p>
                 </div>
             );
          }
          return <p key={idx} className="mb-3 text-zinc-300">{section}</p>;
      });
  };

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none font-sans text-left">
        {menu.visible && (
            <div 
                ref={menuRef}
                className="absolute bg-[#0a0a0c] border border-cyan-900/50 shadow-[0_0_20px_rgba(0,0,0,0.8)] rounded-sm overflow-hidden min-w-[180px] pointer-events-auto animate-fade-in origin-top-left z-[101]"
                style={{ top: menu.y, left: menu.x }}
            >
                <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 text-[10px] text-zinc-500 font-mono uppercase truncate max-w-[200px]">
                    {menu.text.length > 20 ? menu.text.substring(0, 20) + '...' : menu.text}
                </div>
                <div className="p-1">
                    <button onClick={(e) => handleDefine(e)} className="w-full text-left px-3 py-2 text-zinc-300 hover:bg-[#00f3ff]/10 hover:text-[#00f3ff] text-xs font-mono uppercase flex items-center gap-2 transition-colors rounded-sm"><Search size={14} />Explain / Define</button>
                    <button onClick={() => handleAddToNotebook()} className="w-full text-left px-3 py-2 text-zinc-300 hover:bg-[#00f3ff]/10 hover:text-[#00f3ff] text-xs font-mono uppercase flex items-center gap-2 transition-colors rounded-sm"><FilePlus size={14} />Add to Notebook</button>
                    <button onClick={() => { navigator.clipboard.writeText(menu.text); setMenu(prev => ({ ...prev, visible: false })); }} className="w-full text-left px-3 py-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 text-xs font-mono uppercase flex items-center gap-2 transition-colors rounded-sm"><Copy size={14} />Copy Text</button>
                </div>
            </div>
        )}

        {definition.visible && (
             <div 
                ref={defRef}
                className="absolute bg-[#050505]/95 backdrop-blur-md border border-[#00f3ff]/30 shadow-[0_0_30px_rgba(0,0,0,0.9)] rounded-lg p-4 md:p-5 w-[calc(100vw-32px)] md:w-80 pointer-events-auto animate-fade-in-up origin-top-left z-[102] max-h-[400px] flex flex-col"
                style={{ top: definition.position.y, left: definition.position.x }}
             >
                 <div className="flex items-start justify-between mb-3 shrink-0">
                     <h3 className="text-[#00f3ff] font-bold font-mono text-sm uppercase tracking-wider flex items-center gap-2">
                         <BookOpen size={16} />
                         {definition.isTranslated ? 'Translation' : 'Analysis'}
                     </h3>
                     <div className="flex items-center gap-2">
                         <button
                           onClick={handleTranslateToggle}
                           disabled={isTranslating || definition.loading || !definition.text}
                           className={`transition-colors p-1.5 rounded-sm hover:bg-zinc-900 ${definition.isTranslated || isTranslating ? 'text-[#00f3ff] bg-[#00f3ff]/10' : 'text-zinc-400 hover:text-[#00f3ff]'}`}
                           title={definition.isTranslated ? "Show Source Explanation" : `Translate Explanation to ${activeLanguage}`}
                         >
                            <Languages size={16} />
                         </button>
                         <button
                           onClick={handlePronounce}
                           disabled={isPlaying || definition.loading}
                           className={`text-zinc-400 hover:text-[#00f3ff] transition-colors p-1.5 rounded-sm hover:bg-zinc-900 ${isPlaying ? 'animate-pulse text-[#00f3ff] bg-[#00f3ff]/10' : ''}`}
                           title="Pronounce Selection"
                         >
                            <Volume2 size={16} />
                         </button>
                         <button onClick={() => setDefinition(prev => ({ ...prev, visible: false }))} className="text-zinc-600 hover:text-white transition-colors text-xl p-1">×</button>
                     </div>
                 </div>
                 
                 <div className="mb-4 overflow-y-auto custom-scrollbar flex-1 text-sm">
                     {definition.loading ? (
                         <div className="flex items-center gap-2 text-zinc-500 text-xs font-mono py-2">
                             <Loader2 size={14} className="animate-spin" />
                             Decrypting Neural Data...
                         </div>
                     ) : (
                         <div className="leading-relaxed content-font border-l-2 border-zinc-800 pl-3 animate-fade-in">
                             {formatDefinition(definition.text || "")}
                         </div>
                     )}
                 </div>

                 <button
                    onClick={handleSaveWithDefinition}
                    className="w-full py-2 bg-zinc-900 hover:bg-[#00f3ff]/20 text-zinc-400 hover:text-[#00f3ff] border border-zinc-800 hover:border-[#00f3ff]/50 rounded-sm text-xs font-mono uppercase transition-all flex items-center justify-center gap-2 shrink-0"
                 >
                     <FilePlus size={14} />
                     Save Analysis to Log
                 </button>
             </div>
        )}

        {mobileBar.visible && !definition.visible && (
            <div
                ref={mobileBarRef}
                className="absolute pointer-events-auto animate-fade-in z-[101] flex items-center gap-0.5 bg-[#0a0a0c] border border-cyan-900/50 shadow-[0_0_20px_rgba(0,0,0,0.8)] rounded-full px-1 py-1"
                style={{ top: mobileBar.y, left: mobileBar.x }}
            >
                <button
                    onTouchEnd={(e) => { e.preventDefault(); handleDefine(e as any, true); }}
                    className="flex items-center gap-1.5 px-3 py-2 text-zinc-300 active:text-[#00f3ff] active:bg-[#00f3ff]/10 text-[11px] font-mono uppercase rounded-full transition-colors"
                >
                    <Search size={14} />
                    Define
                </button>
                <div className="w-[1px] h-5 bg-zinc-700" />
                <button
                    onTouchEnd={(e) => { e.preventDefault(); handleAddToNotebook(true); }}
                    className="flex items-center gap-1.5 px-3 py-2 text-zinc-300 active:text-[#00f3ff] active:bg-[#00f3ff]/10 text-[11px] font-mono uppercase rounded-full transition-colors"
                >
                    <FilePlus size={14} />
                    Note
                </button>
                <div className="w-[1px] h-5 bg-zinc-700" />
                <button
                    onTouchEnd={(e) => {
                        e.preventDefault();
                        navigator.clipboard.writeText(mobileBar.text);
                        setMobileBar(prev => ({ ...prev, visible: false }));
                        window.getSelection()?.removeAllRanges();
                    }}
                    className="flex items-center gap-1.5 px-3 py-2 text-zinc-500 active:text-zinc-300 active:bg-zinc-800 text-[11px] font-mono uppercase rounded-full transition-colors"
                >
                    <Copy size={14} />
                </button>
            </div>
        )}
    </div>
  );
};
