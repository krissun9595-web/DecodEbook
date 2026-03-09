
import React, { useState, useEffect, useRef } from 'react';
import { Book, Copy, Search, Loader2, BookOpen, FilePlus, Volume2, Languages } from 'lucide-react';
import { getQuickDefinition, generateSpeech, translateText } from '../services/gemini';
import { NotebookItem } from '../types';
import { pcmToWav } from '../utils/audio';

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
  
  const menuRef = useRef<HTMLDivElement>(null);
  const defRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();

      if (text && text.length > 0) {
        e.preventDefault();
        let x = e.clientX;
        let y = e.clientY;
        if (x + 200 > window.innerWidth) x = window.innerWidth - 210;
        if (y + 150 > window.innerHeight) y = window.innerHeight - 160;

        let source = "Input_Stream";
        let node = selection.anchorNode;
        while(node && node !== document.body) {
            if (node instanceof Element && node.getAttribute('data-source')) {
                source = node.getAttribute('data-source') || "Input_Stream";
                break;
            }
            node = node.parentElement;
        }

        setMenu({ visible: true, x, y, text, source });
        setDefinition(prev => ({ ...prev, visible: false }));
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

  const handleDefine = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();

    // Dimensions based on max-h-[400px] + shadow/borders
    const POPUP_WIDTH = 320; 
    const MAX_HEIGHT = 400; 
    const MARGIN = 16;

    let x = menu.x;
    let y = menu.y;

    // Intelligent X positioning
    // 1. Try placing to the right of cursor (default x)
    // 2. If overflow, shift left just enough to fit (slide)
    if (x + POPUP_WIDTH + MARGIN > window.innerWidth) {
        x = window.innerWidth - POPUP_WIDTH - MARGIN;
    }
    // Safety clamp left
    x = Math.max(MARGIN, x);

    // Intelligent Y positioning
    // 1. Try placing below cursor (default y)
    // 2. If overflow, shift up just enough to fit (slide) 
    // This ensures the bottom (Save button) is always visible without jumping too far up
    if (y + MAX_HEIGHT + MARGIN > window.innerHeight) {
        y = window.innerHeight - MAX_HEIGHT - MARGIN;
    }
    // Safety clamp top
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

    try {
        // Fetch definition in its source language as per requirements
        const def = await getQuickDefinition(menu.text, "the same language as the provided text");
        setDefinition(prev => ({ 
            ...prev, 
            loading: false, 
            text: def,
            originalText: def 
        }));
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
                  
                  // If source is already translated layer, we translate explanation BACK to English/Original
                  if (menu.source === 'Translated_Layer') {
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
      if (isPlaying || !menu.text) return;
      setIsPlaying(true);
      let audioUrl: string | null = null;
      try {
          const b64 = await generateSpeech(menu.text, "Puck");
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

  const handleAddToNotebook = () => {
     // Default add: NO definition included
     onAddToNotebook({
         text: menu.text,
         type: menu.text.includes(' ') && menu.text.length > 30 ? 'sentence' : 'word',
         definition: undefined,
         contextSource: menu.source
     });
     setMenu(prev => ({ ...prev, visible: false }));
  };
  
  const handleSaveWithDefinition = () => {
      // Save WITH definition: captures the currently visible text (original or translated)
      onAddToNotebook({
         text: menu.text,
         type: menu.text.includes(' ') && menu.text.length > 30 ? 'sentence' : 'word',
         definition: definition.text || undefined,
         contextSource: menu.source
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
                    <button onClick={handleDefine} className="w-full text-left px-3 py-2 text-zinc-300 hover:bg-[#00f3ff]/10 hover:text-[#00f3ff] text-xs font-mono uppercase flex items-center gap-2 transition-colors rounded-sm"><Search size={14} />Explain / Define</button>
                    <button onClick={handleAddToNotebook} className="w-full text-left px-3 py-2 text-zinc-300 hover:bg-[#00f3ff]/10 hover:text-[#00f3ff] text-xs font-mono uppercase flex items-center gap-2 transition-colors rounded-sm"><FilePlus size={14} />Add to Notebook</button>
                    <button onClick={() => { navigator.clipboard.writeText(menu.text); setMenu(prev => ({ ...prev, visible: false })); }} className="w-full text-left px-3 py-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 text-xs font-mono uppercase flex items-center gap-2 transition-colors rounded-sm"><Copy size={14} />Copy Text</button>
                </div>
            </div>
        )}

        {definition.visible && (
             <div 
                ref={defRef}
                className="absolute bg-[#050505]/95 backdrop-blur-md border border-[#00f3ff]/30 shadow-[0_0_30px_rgba(0,0,0,0.9)] rounded-lg p-5 w-80 pointer-events-auto animate-fade-in-up origin-top-left z-[102] max-h-[400px] flex flex-col"
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
                         <div className="leading-relaxed font-serif border-l-2 border-zinc-800 pl-3 animate-fade-in">
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
    </div>
  );
};
