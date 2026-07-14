
import React, { useState, useEffect, useRef } from 'react';
import { Search, Loader2, BookOpen, Volume2, PenLine, MessageSquare } from 'lucide-react';
import { getQuickDefinition } from '../services/gemini';
import { NotebookItem } from '../types';
import { playPronunciationAudio, prefetchPronunciation, stopPronunciationAudio } from '../services/pronunciationAudio';
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
  sentenceIndex?: number;
  startOffset?: number;
  isInked?: boolean;
  selectionFragments?: SelectionFragment[];
}

interface CommentComposerState {
  visible: boolean;
  x: number;
  y: number;
  text: string;
  source: string;
  sentenceIndex?: number;
  startOffset?: number;
  draft: string;
}

interface DefinitionState {
  visible: boolean;
  loading: boolean;
  text: string | null;
  originalText: string | null;
  translatedText: string | null;
  selectionText: string | null;
  source: string;
  isTranslated: boolean;
  position: { x: number; y: number };
}

interface SelectionFragment {
  text: string;
  sentenceIndex: number;
  startOffset?: number;
}

let lastInputWasTouch = false;
if (typeof window !== 'undefined') {
  window.addEventListener('touchstart', () => { lastInputWasTouch = true; }, { capture: true, passive: true });
  window.addEventListener('mousedown', (e) => { if (e.detail > 0) lastInputWasTouch = false; }, { capture: true });
}
const isMobile = () => lastInputWasTouch;

const FOOTNOTE_SELECTION_MARKER_PATTERN = /([.!?。！？,;:][”"’")\]]?|[”"’")\]]|[\p{Ll}])\d{1,3}(?=(?:\s|$|(?:——|--|—|–|-)))/gu;
const stripSelectionFootnoteMarkers = (value: string): string =>
  value.replace(FOOTNOTE_SELECTION_MARKER_PATTERN, '$1');
const cleanSelectionText = (value: string): string =>
  stripSelectionFootnoteMarkers(value).replace(/\s+/g, ' ').trim();

const getSelectionMetadata = (selection: Selection): { source: string; sentenceIndex?: number; startOffset?: number; isInked?: boolean } => {
  let source = "Input_Stream";
  let sentenceIndex: number | undefined;
  let startOffset: number | undefined;
  let isInked = false;
  let sentenceElement: Element | null = null;

  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const startNode = range?.startContainer || selection.anchorNode || selection.focusNode;
  const startElement = startNode instanceof Element ? startNode : startNode?.parentElement || null;

  isInked = Boolean(startElement?.closest('[data-inked-selection="true"]'));
  sentenceElement = startElement?.closest('[data-source][data-sentence-index]') || null;

  if (sentenceElement) {
    source = sentenceElement.getAttribute('data-source') || "Input_Stream";
    const rawSentenceIndex = sentenceElement.getAttribute('data-sentence-index');
    if (rawSentenceIndex !== null) {
      const parsed = Number(rawSentenceIndex);
      if (Number.isFinite(parsed) && parsed >= 0) sentenceIndex = parsed;
    }
  }

  if (sentenceElement && selection.rangeCount > 0) {
    try {
      const range = selection.getRangeAt(0);
      const prefix = document.createRange();
      prefix.selectNodeContents(sentenceElement);
      prefix.setEnd(range.startContainer, range.startOffset);
      startOffset = stripSelectionFootnoteMarkers(prefix.toString()).length;
      prefix.detach();
    } catch {
      startOffset = undefined;
    }
  }
  return { source, sentenceIndex, startOffset, isInked };
};

const cssEscape = (value: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
};

const getSelectionLayerText = (selection: Selection, source: string): string => {
  if (!selection.rangeCount || !source || source === 'Input_Stream') return cleanSelectionText(selection.toString());
  const range = selection.getRangeAt(0);
  const elements = Array.from(document.querySelectorAll<HTMLElement>(`[data-source="${cssEscape(source)}"]`));
  const parts: string[] = [];

  for (const element of elements) {
    try {
      if (!range.intersectsNode(element)) continue;
      const elementRange = document.createRange();
      elementRange.selectNodeContents(element);
      const part = range.cloneRange();
      if (part.compareBoundaryPoints(Range.START_TO_START, elementRange) < 0) {
        part.setStart(elementRange.startContainer, elementRange.startOffset);
      }
      if (part.compareBoundaryPoints(Range.END_TO_END, elementRange) > 0) {
        part.setEnd(elementRange.endContainer, elementRange.endOffset);
      }
      const text = cleanSelectionText(part.toString());
      if (text) parts.push(text);
      elementRange.detach();
      part.detach();
    } catch {
      // Ignore rare Range boundary errors from transient selections.
    }
  }

  return cleanSelectionText(parts.join(' ')) || cleanSelectionText(selection.toString());
};

const getSelectionSentenceFragments = (selection: Selection, source: string): SelectionFragment[] => {
  if (!selection.rangeCount || !source || source === 'Input_Stream') return [];
  const range = selection.getRangeAt(0);
  const elements = Array.from(document.querySelectorAll<HTMLElement>(`[data-source="${cssEscape(source)}"][data-sentence-index]`));
  const fragments: SelectionFragment[] = [];

  for (const element of elements) {
    try {
      if (!range.intersectsNode(element)) continue;
      const rawSentenceIndex = element.getAttribute('data-sentence-index');
      const sentenceIndex = rawSentenceIndex === null ? NaN : Number(rawSentenceIndex);
      if (!Number.isFinite(sentenceIndex) || sentenceIndex < 0) continue;

      const elementRange = document.createRange();
      elementRange.selectNodeContents(element);
      const part = range.cloneRange();
      if (part.compareBoundaryPoints(Range.START_TO_START, elementRange) < 0) {
        part.setStart(elementRange.startContainer, elementRange.startOffset);
      }
      if (part.compareBoundaryPoints(Range.END_TO_END, elementRange) > 0) {
        part.setEnd(elementRange.endContainer, elementRange.endOffset);
      }

      const text = cleanSelectionText(part.toString());
      if (text) {
        const prefix = document.createRange();
        prefix.selectNodeContents(element);
        prefix.setEnd(part.startContainer, part.startOffset);
        fragments.push({
          text,
          sentenceIndex,
          startOffset: stripSelectionFootnoteMarkers(prefix.toString()).length,
        });
        prefix.detach();
      }

      elementRange.detach();
      part.detach();
    } catch {
      // Ignore transient Range boundary errors while the user is adjusting selection.
    }
  }

  return fragments;
};

const setActiveSelectionSource = (source: string | null): void => {
  if (typeof document === 'undefined') return;
  if (source && source !== 'Input_Stream') {
    document.body.dataset.decodebookSelectionSource = source;
  } else {
    delete document.body.dataset.decodebookSelectionSource;
  }
};

const getSelectionPosition = (selection: Selection): { x: number; y: number } => {
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const TOOLBAR_WIDTH = isMobile() ? Math.min(360, window.innerWidth - 16) : 200;
  let x = rect.left + rect.width / 2 - TOOLBAR_WIDTH / 2;
  let y = rect.top - 52;
  if (x < 8) x = 8;
  if (x + TOOLBAR_WIDTH > window.innerWidth) x = window.innerWidth - TOOLBAR_WIDTH - 8;
  if (y < 8) y = rect.bottom + 8;
  return { x, y };
};

export const GlobalContextLayer: React.FC<Props> = ({ onAddToNotebook, activeLanguage }) => {
  const [menu, setMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, text: '', source: 'Input_Stream' });
  const [commentComposer, setCommentComposer] = useState<CommentComposerState>({ visible: false, x: 0, y: 0, text: '', source: 'Input_Stream', draft: '' });
  const [definition, setDefinition] = useState<DefinitionState>({
      visible: false,
      loading: false,
      text: null,
      originalText: null,
      translatedText: null,
      selectionText: null,
      source: 'Input_Stream',
      isTranslated: false,
      position: { x: 0, y: 0 }
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [mobileBar, setMobileBar] = useState<{ visible: boolean; x: number; y: number; text: string; source: string; sentenceIndex?: number; startOffset?: number; isInked?: boolean; selectionFragments?: SelectionFragment[] }>({ visible: false, x: 0, y: 0, text: '', source: 'Input_Stream' });

  const menuRef = useRef<HTMLDivElement>(null);
  const defRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLDivElement>(null);
  const mobileBarRef = useRef<HTMLDivElement>(null);
  const pronunciationPrefetchTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (pronunciationPrefetchTimer.current !== null) window.clearTimeout(pronunciationPrefetchTimer.current);
  }, []);

  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.decodebookSelectionLayerStyle = 'true';
    style.textContent = `
      body[data-decodebook-selection-source="Original_Layer"] [data-source="Translated_Layer"],
      body[data-decodebook-selection-source="Original_Layer"] [data-source="Translated_Layer"] * {
        -webkit-user-select: none;
        user-select: none;
      }
      body[data-decodebook-selection-source="Translated_Layer"] [data-source="Original_Layer"],
      body[data-decodebook-selection-source="Translated_Layer"] [data-source="Original_Layer"] * {
        -webkit-user-select: none;
        user-select: none;
      }
      body[data-decodebook-selection-source="Original_Layer"] [data-source="Translated_Layer"]::selection,
      body[data-decodebook-selection-source="Original_Layer"] [data-source="Translated_Layer"] *::selection,
      body[data-decodebook-selection-source="Translated_Layer"] [data-source="Original_Layer"]::selection,
      body[data-decodebook-selection-source="Translated_Layer"] [data-source="Original_Layer"] *::selection {
        background: transparent;
        color: inherit;
      }
    `;
    document.head.appendChild(style);

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const source = target?.closest('[data-source]')?.getAttribute('data-source') || null;
      setActiveSelectionSource(source);
    };
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || !selection.toString().trim()) {
        setActiveSelectionSource(null);
        return;
      }
      const metadata = getSelectionMetadata(selection);
      setActiveSelectionSource(metadata.source);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('selectionchange', handleSelectionChange);
      style.remove();
      setActiveSelectionSource(null);
    };
  }, []);

  // Desktop: right-click context menu
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      if (isMobile()) return;
      const selection = window.getSelection();
      const rawText = selection?.toString().trim();

      if (rawText && rawText.length > 0) {
        e.preventDefault();
        let x = e.clientX;
        let y = e.clientY;
        if (x + 200 > window.innerWidth) x = window.innerWidth - 210;
        if (y + 150 > window.innerHeight) y = window.innerHeight - 160;

        const metadata = getSelectionMetadata(selection);
        const text = getSelectionLayerText(selection, metadata.source);
        const selectionFragments = getSelectionSentenceFragments(selection, metadata.source);
        setMenu({ visible: true, x, y, text, source: metadata.source, sentenceIndex: metadata.sentenceIndex, startOffset: metadata.startOffset, isInked: metadata.isInked, selectionFragments });
        setDefinition(prev => ({ ...prev, visible: false }));
        setCommentComposer(prev => ({ ...prev, visible: false }));
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
      if (commentComposer.visible && commentRef.current && !commentRef.current.contains(e.target as Node)) {
          setCommentComposer(prev => ({ ...prev, visible: false }));
      }
    };

    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [menu.visible, definition.visible, commentComposer.visible]);

  // Mobile: selection change detection
  useEffect(() => {
    if (!isMobile()) return;

    let checkTimer: ReturnType<typeof setTimeout>;
    const handleSelectionChange = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        const selection = window.getSelection();
        const rawText = selection?.toString().trim();
        if (rawText && rawText.length > 0 && selection!.rangeCount > 0) {
          const metadata = getSelectionMetadata(selection!);
          const text = getSelectionLayerText(selection!, metadata.source);
          const selectionFragments = getSelectionSentenceFragments(selection!, metadata.source);
          const pos = getSelectionPosition(selection!);
          setMobileBar({ visible: true, x: pos.x, y: pos.y, text, source: metadata.source, sentenceIndex: metadata.sentenceIndex, startOffset: metadata.startOffset, isInked: metadata.isInked, selectionFragments });
        } else {
          setMobileBar(prev => ({ ...prev, visible: false }));
        }
      }, 300);
    };

    const handleTouchEnd = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        const selection = window.getSelection();
          const rawText = selection?.toString().trim();
          if (rawText && rawText.length > 0 && selection!.rangeCount > 0) {
            const metadata = getSelectionMetadata(selection!);
            const text = getSelectionLayerText(selection!, metadata.source);
            const selectionFragments = getSelectionSentenceFragments(selection!, metadata.source);
            const pos = getSelectionPosition(selection!);
            setMobileBar({ visible: true, x: pos.x, y: pos.y, text, source: metadata.source, sentenceIndex: metadata.sentenceIndex, startOffset: metadata.startOffset, isInked: metadata.isInked, selectionFragments });
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
      if (commentRef.current && !commentRef.current.contains(e.target as Node)) {
        setCommentComposer(prev => prev.visible ? { ...prev, visible: false } : prev);
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

  useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      const selection = window.getSelection();
      const rawText = selection?.toString().trim();
      if (!selection || !rawText || selection.rangeCount === 0) return;

      const metadata = getSelectionMetadata(selection);
      if (metadata.source === 'Input_Stream') return;

      const layerText = getSelectionLayerText(selection, metadata.source);
      if (!layerText || layerText === rawText) return;

      event.preventDefault();
      event.clipboardData?.setData('text/plain', layerText);
    };

    document.addEventListener('copy', handleCopy);
    return () => document.removeEventListener('copy', handleCopy);
  }, []);

  const activeText = menu.visible ? menu.text : mobileBar.text;

  const handleDefine = async (e: React.MouseEvent, fromMobile = false) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();

    const srcX = fromMobile ? mobileBar.x : menu.x;
    const srcY = fromMobile ? mobileBar.y : menu.y;
    const text = fromMobile ? mobileBar.text : menu.text;
    const source = fromMobile ? mobileBar.source : menu.source;

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
        selectionText: text,
        source,
        isTranslated: false,
        position: { x, y }
    });
    setMenu(prev => ({ ...prev, visible: false }));
    setMobileBar(prev => ({ ...prev, visible: false }));
    window.getSelection()?.removeAllRanges();

    try {
        const targetLanguage = activeLanguage === 'Original' ? null : activeLanguage;
        const [sourceResult, targetResult] = await Promise.allSettled([
            getQuickDefinition(text, "the same language as the provided text"),
            targetLanguage ? getQuickDefinition(text, targetLanguage) : Promise.resolve(null),
        ]);
        if (sourceResult.status === 'rejected') throw sourceResult.reason;

        const sourceDef = sourceResult.value;
        const targetDef = targetResult.status === 'fulfilled' ? targetResult.value : null;
        const combinedDef = [
            `Original:\n${sourceDef}`,
            targetLanguage && targetDef ? `${targetLanguage}:\n${targetDef}` : null,
        ].filter(Boolean).join('\n\n');

        setDefinition(prev => ({
            ...prev,
            loading: false,
            text: combinedDef,
            originalText: sourceDef,
            translatedText: targetDef || null,
            isTranslated: false,
        }));
        onAddToNotebook({
            text,
            type: selectionTypeFor(text),
            definition: combinedDef,
            contextSource: source
        });
        trackNotebook('auto_save_definition', { source: fromMobile ? 'mobile_toolbar' : 'context_menu', word_count: text.split(/\s+/).length });
        trackEvent('ai', 'define_word', { word: text, source: fromMobile ? 'mobile_toolbar' : 'context_menu' });
    } catch (e) {
        setDefinition(prev => ({ ...prev, loading: false, text: "Could not retrieve definition." }));
    }
  };

  const handlePronounce = async (fromMobile = false) => {
      const textToSpeak = fromMobile ? mobileBar.text : (menu.visible ? menu.text : definition.selectionText || activeText);
      if (!textToSpeak) return;
      if (isPlaying) {
          if (stopPronunciationAudio(textToSpeak, "Puck")) setIsPlaying(false);
          return;
      }
      setIsPlaying(true);
      try {
          await playPronunciationAudio(textToSpeak, "Puck");
      } catch (e) {
          console.error(e);
      } finally {
          setIsPlaying(false);
      }
  };

  const prefetchActivePronunciation = (immediate = false) => {
      const textToSpeak = definition.selectionText || activeText;
      if (!textToSpeak || isPlaying) return;
      if (pronunciationPrefetchTimer.current !== null) window.clearTimeout(pronunciationPrefetchTimer.current);
      if (immediate) {
          prefetchPronunciation(textToSpeak, "Puck");
          return;
      }
      pronunciationPrefetchTimer.current = window.setTimeout(() => {
          prefetchPronunciation(textToSpeak, "Puck");
      }, 120);
  };

  const selectionTypeFor = (text: string): 'word' | 'phrase' | 'sentence' => {
     const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
     if (wordCount === 1 || text.trim().length < 15) return 'word';
     if (wordCount <= 6 && text.trim().length < 50) return 'phrase';
     return 'sentence';
  };

  const handleInk = (fromMobile = false) => {
     const text = fromMobile ? mobileBar.text : menu.text;
     const source = fromMobile ? mobileBar.source : menu.source;
     const sentenceIndex = fromMobile ? mobileBar.sentenceIndex : menu.sentenceIndex;
     const startOffset = fromMobile ? mobileBar.startOffset : menu.startOffset;
     const selectionFragments = fromMobile ? mobileBar.selectionFragments : menu.selectionFragments;
     const nextInked = !(fromMobile ? mobileBar.isInked : menu.isInked);
     if (!text.trim()) return;

     const inkTargets = selectionFragments && selectionFragments.length > 0
       ? selectionFragments
       : [{ text, sentenceIndex, startOffset }].filter((target): target is SelectionFragment => typeof target.sentenceIndex === 'number');

     inkTargets.forEach(target => {
       window.dispatchEvent(new CustomEvent('decodebook:ink-selection', {
         detail: {
           text: target.text,
           source,
           sentenceIndex: target.sentenceIndex,
           startOffset: target.startOffset,
           inked: nextInked
         }
       }));
     });

     onAddToNotebook({
         text,
         type: selectionTypeFor(text),
         definition: undefined,
         contextSource: source,
         inked: nextInked
     });
     trackNotebook(nextInked ? 'ink_selection' : 'remove_ink_selection', { source: fromMobile ? 'mobile_toolbar' : 'context_menu', word_count: text.split(/\s+/).length });
     setMenu(prev => ({ ...prev, visible: false }));
     setMobileBar(prev => ({ ...prev, visible: false }));
     window.getSelection()?.removeAllRanges();
  };

  const openCommentComposer = (fromMobile = false) => {
     const text = fromMobile ? mobileBar.text : menu.text;
     const source = fromMobile ? mobileBar.source : menu.source;
     const sentenceIndex = fromMobile ? mobileBar.sentenceIndex : menu.sentenceIndex;
     const startOffset = fromMobile ? mobileBar.startOffset : menu.startOffset;
     const srcX = fromMobile ? mobileBar.x : menu.x;
     const srcY = fromMobile ? mobileBar.y : menu.y;
     const width = isMobile() ? Math.min(320, window.innerWidth - 32) : 300;
     const margin = 16;
     let x = srcX;
     let y = srcY;
     if (x + width + margin > window.innerWidth) x = window.innerWidth - width - margin;
     if (y + 230 + margin > window.innerHeight) y = window.innerHeight - 230 - margin;
     setCommentComposer({
       visible: true,
       x: Math.max(margin, x),
       y: Math.max(margin, y),
       text,
       source,
       sentenceIndex,
       startOffset,
       draft: ''
     });
     setMenu(prev => ({ ...prev, visible: false }));
     setMobileBar(prev => ({ ...prev, visible: false }));
     setDefinition(prev => ({ ...prev, visible: false }));
  };

  const saveComment = () => {
     const comment = commentComposer.draft.trim();
     if (!comment || !commentComposer.text.trim()) return;
     onAddToNotebook({
         text: commentComposer.text,
         type: selectionTypeFor(commentComposer.text),
         definition: undefined,
         contextSource: commentComposer.source,
         comment
     });
     trackNotebook('comment_selection', { source: 'context_menu', word_count: commentComposer.text.split(/\s+/).length });
     setCommentComposer(prev => ({ ...prev, visible: false, draft: '' }));
     window.getSelection()?.removeAllRanges();
  };

  const formatDefinition = (text: string) => {
      if (!text) return null;
      return text.split('\n\n').map((section, idx) => {
          const parts = section.split(':');
          if (parts.length > 1 && parts[0].length < 25) {
             return (
                 <div key={idx} className="mb-3">
                     <span className="text-neon-cyan font-bold uppercase text-[10px] tracking-widest">{parts[0]}:</span>
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
                className="absolute bg-void-2 border border-cyan-900/50 shadow-[0_0_20px_rgba(0,0,0,0.8)] rounded-sm overflow-hidden min-w-[180px] pointer-events-auto animate-fade-in origin-top-left z-[101]"
                style={{ top: menu.y, left: menu.x }}
            >
                <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 text-[10px] text-zinc-500 font-mono uppercase truncate max-w-[200px]">
                    {menu.text.length > 20 ? menu.text.substring(0, 20) + '...' : menu.text}
	                </div>
	                <div className="p-1">
	                    <button onClick={(e) => handleDefine(e)} className="w-full text-left px-3 py-2 text-zinc-300 hover:bg-neon-cyan/10 hover:text-neon-cyan text-xs font-mono uppercase flex items-center gap-2 transition-colors rounded-sm"><Search size={14} />Defination</button>
	                    <button onClick={() => handlePronounce(false)} onPointerEnter={() => prefetchActivePronunciation(false)} onFocus={() => prefetchActivePronunciation(false)} className={`w-full text-left px-3 py-2 hover:bg-neon-cyan/10 hover:text-neon-cyan text-xs font-mono uppercase flex items-center gap-2 transition-colors rounded-sm ${isPlaying ? 'text-neon-cyan bg-neon-cyan/10 animate-pulse' : 'text-zinc-300'}`}><Volume2 size={14} />{isPlaying ? 'Stop Pronunciation' : 'Pronunciation'}</button>
	                    <button onClick={() => handleInk()} className="w-full text-left px-3 py-2 text-zinc-300 hover:bg-neon-cyan/10 hover:text-neon-cyan text-xs font-mono uppercase flex items-center gap-2 transition-colors rounded-sm"><PenLine size={14} />{menu.isInked ? 'Remove Ink' : 'Ink'}</button>
	                    <button onClick={() => openCommentComposer()} className="w-full text-left px-3 py-2 text-zinc-300 hover:bg-neon-cyan/10 hover:text-neon-cyan text-xs font-mono uppercase flex items-center gap-2 transition-colors rounded-sm"><MessageSquare size={14} />Comment</button>
	                </div>
            </div>
        )}

        {commentComposer.visible && (
            <div
                ref={commentRef}
                className="absolute bg-void-1/95 backdrop-blur-md border border-neon-cyan/30 shadow-[0_0_30px_rgba(0,0,0,0.9)] rounded-lg p-4 w-[calc(100vw-32px)] md:w-[300px] pointer-events-auto animate-fade-in-up origin-top-left z-[102]"
                style={{ top: commentComposer.y, left: commentComposer.x }}
            >
                <div className="mb-3">
                    <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-neon-cyan flex items-center gap-2">
                        <MessageSquare size={14} />
                        Neural Annotation
                    </div>
                    <p className="mt-2 text-[10px] text-zinc-600 font-mono truncate">{commentComposer.text}</p>
                </div>
                <textarea
                    autoFocus
                    value={commentComposer.draft}
                    onChange={(e) => setCommentComposer(prev => ({ ...prev, draft: e.target.value }))}
                    placeholder="Add neural annotations..."
                    className="w-full min-h-[90px] bg-void-0 border border-zinc-800 rounded-sm p-2 text-xs text-zinc-300 focus:border-neon-cyan focus:outline-none transition-colors font-mono resize-none"
                />
                <div className="flex items-center justify-end gap-2 mt-3">
                    <button onClick={() => setCommentComposer(prev => ({ ...prev, visible: false }))} className="px-3 py-2 text-[10px] font-mono uppercase text-zinc-600 hover:text-zinc-300 transition-colors">Cancel</button>
                    <button onClick={saveComment} disabled={!commentComposer.draft.trim()} className="px-3 py-2 text-[10px] font-mono uppercase bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30 rounded-sm hover:bg-neon-cyan/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all">Save</button>
                </div>
            </div>
        )}

        {definition.visible && (
             <div 
                ref={defRef}
                className="absolute bg-void-1/95 backdrop-blur-md border border-neon-cyan/30 shadow-[0_0_30px_rgba(0,0,0,0.9)] rounded-lg p-4 md:p-5 w-[calc(100vw-32px)] md:w-80 pointer-events-auto animate-fade-in-up origin-top-left z-[102] max-h-[400px] flex flex-col"
                style={{ top: definition.position.y, left: definition.position.x }}
             >
	                 <div className="flex items-start justify-between mb-3 shrink-0">
	                     <h3 className="text-neon-cyan font-bold font-mono text-sm uppercase tracking-wider flex items-center gap-2">
	                         <BookOpen size={16} />
	                         Defination
	                     </h3>
	                     <button onClick={() => setDefinition(prev => ({ ...prev, visible: false }))} className="text-zinc-600 hover:text-white transition-colors text-xl p-1">×</button>
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
             </div>
        )}

        {mobileBar.visible && !definition.visible && (
            <div
                ref={mobileBarRef}
                className="absolute pointer-events-auto animate-fade-in z-[101] flex items-center gap-0.5 bg-void-2 border border-cyan-900/50 shadow-[0_0_20px_rgba(0,0,0,0.8)] rounded-full px-1 py-1 max-w-[calc(100vw-16px)] overflow-x-auto"
                style={{ top: mobileBar.y, left: mobileBar.x }}
            >
                <button
                    onTouchEnd={(e) => { e.preventDefault(); handleDefine(e as any, true); }}
                    className="flex items-center gap-1.5 px-2.5 py-2 text-zinc-300 active:text-neon-cyan active:bg-neon-cyan/10 text-[10px] font-mono uppercase rounded-full transition-colors"
	                >
	                    <Search size={14} />
	                    Defination
	                </button>
	                <div className="w-[1px] h-5 bg-zinc-700" />
	                <button
	                    onTouchStart={() => prefetchActivePronunciation(true)}
	                    onTouchEnd={(e) => { e.preventDefault(); handlePronounce(true); }}
	                    className="flex items-center gap-1.5 px-2.5 py-2 text-zinc-300 active:text-neon-cyan active:bg-neon-cyan/10 text-[10px] font-mono uppercase rounded-full transition-colors"
	                >
	                    <Volume2 size={14} />
	                    {isPlaying ? 'Stop' : 'Pronunciation'}
	                </button>
	                <div className="w-[1px] h-5 bg-zinc-700" />
	                <button
	                    onTouchEnd={(e) => { e.preventDefault(); handleInk(true); }}
	                    className="flex items-center gap-1.5 px-2.5 py-2 text-zinc-300 active:text-neon-cyan active:bg-neon-cyan/10 text-[10px] font-mono uppercase rounded-full transition-colors"
	                >
                    <PenLine size={14} />
                    {mobileBar.isInked ? 'Unink' : 'Ink'}
                </button>
                <div className="w-[1px] h-5 bg-zinc-700" />
                <button
                    onTouchEnd={(e) => { e.preventDefault(); openCommentComposer(true); }}
                    className="flex items-center gap-1.5 px-2.5 py-2 text-zinc-300 active:text-neon-cyan active:bg-neon-cyan/10 text-[10px] font-mono uppercase rounded-full transition-colors"
                >
                    <MessageSquare size={14} />
                    Comment
                </button>
            </div>
        )}
    </div>
  );
};
