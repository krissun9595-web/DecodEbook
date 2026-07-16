import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, X, Send, Cpu, Loader2, Minimize2, Maximize2, Zap, Minus, Mic, Square, StopCircle } from 'lucide-react';
import { Engine } from './ui/glyphs';
import { createChatSession, sendMessageToChat } from '../services/gemini';
import { FileContext } from '../types';
import { Chat, Content } from "@google/genai";
import { fetchUserTier, getAvailableCredits, CREDIT_COSTS, TIER_CREDITS } from '../services/stripe';

interface Props {
  fileContext: FileContext | null;
  bookTitle?: string;
  bookId?: string;
}

interface Message {
  role: 'user' | 'model';
  text: string;
}

export const AIAssistant: React.FC<Props> = ({ fileContext, bookTitle, bookId }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  // Default position
  const [position, setPosition] = useState({ x: window.innerWidth - 100, y: window.innerHeight - 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragStartPosition, setDragStartPosition] = useState({ x: 0, y: 0 });
  
  const [chatSession, setChatSession] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const [lowCredits, setLowCredits] = useState(false);

  const checkChatQuota = async (): Promise<boolean> => {
    try {
      const tier = await fetchUserTier();
      const available = getAvailableCredits(tier);
      const monthly = TIER_CREDITS[tier.tier] || 100;
      if (monthly !== Infinity) setLowCredits(available < monthly * 0.2);
      const cost = CREDIT_COSTS['chat'] || 1;
      if (available !== Infinity && available < cost) {
        setQuotaError(`Insufficient credits (${available} available, ${cost} needed). Upgrade or buy a credit pack.`);
        return false;
      }
      setQuotaError('');
      return true;
    } catch {
      return true;
    }
  };

  // Voice Input State
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const historyCache = useRef<Record<string, Message[]>>({});
  const prevBookId = useRef<string | null>(null);

  const sphereRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Constants for dimensions to help with boundary checks
  const EXPANDED_WIDTH = 384; 
  const EXPANDED_HEIGHT = 450;
  const SPHERE_SIZE = 64;

  useEffect(() => {
    if (!fileContext || !bookId) {
       setChatSession(null);
       setMessages([]);
       return;
    }

    if (prevBookId.current && prevBookId.current !== bookId) {
        historyCache.current[prevBookId.current] = messages;
    }

    const cachedMessages = historyCache.current[bookId];

    const apiHistory: Content[] = cachedMessages
        ? cachedMessages.map(m => ({
            role: m.role,
            parts: [{ text: m.text }]
        }))
        : [];

    (async () => {
      const session = await createChatSession(fileContext, apiHistory);
      setChatSession(session);
    })();

    if (cachedMessages && cachedMessages.length > 0) {
        setMessages(cachedMessages);
    } else {
        setMessages([{ role: 'model', text: `Neural Link Established: "${bookTitle || 'Unknown Source'}". \nReady for query.` }]);
    }

    prevBookId.current = bookId;
  }, [bookId, fileContext]);

  // Dragging Logic (mouse + touch)
  useEffect(() => {
    const clampPosition = (clientX: number, clientY: number) => {
      let newX = clientX - dragOffset.x;
      let newY = clientY - dragOffset.y;
      const currentWidth = isOpen ? EXPANDED_WIDTH : SPHERE_SIZE;
      const currentHeight = isOpen ? EXPANDED_HEIGHT : SPHERE_SIZE;
      if (newX < 0) newX = 0;
      if (newY < 0) newY = 0;
      if (newX + currentWidth > window.innerWidth) newX = window.innerWidth - currentWidth;
      if (newY + currentHeight > window.innerHeight) newY = window.innerHeight - currentHeight;
      return { x: newX, y: newY };
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging && !isFullScreen) setPosition(clampPosition(e.clientX, e.clientY));
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (isDragging && !isFullScreen && e.touches.length === 1) {
        e.preventDefault();
        setPosition(clampPosition(e.touches[0].clientX, e.touches[0].clientY));
      }
    };
    const handleEnd = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleTouchMove, { passive: false });
      window.addEventListener('touchend', handleEnd);
      window.addEventListener('touchcancel', handleEnd);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleEnd);
      window.removeEventListener('touchcancel', handleEnd);
    };
  }, [isDragging, dragOffset, isOpen, isFullScreen]);

  const startDrag = (clientX: number, clientY: number) => {
    if (isFullScreen) return;
    setIsDragging(true);
    setDragStartPosition({ x: clientX, y: clientY });
    setDragOffset({ x: clientX - position.x, y: clientY - position.y });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    startDrag(e.clientX, e.clientY);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
      const dist = Math.sqrt(
          Math.pow(e.clientX - dragStartPosition.x, 2) +
          Math.pow(e.clientY - dragStartPosition.y, 2)
      );
      if (dist < 5) {
          if (!isOpen) setIsOpen(true);
      }
  };

  const handleQuickExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(true);
    setIsFullScreen(true);
  };

  const abortControllerRef = useRef<AbortController | null>(null);

  // ... (existing refs)

  const handleStop = () => {
      if (isLoading) {
          if (abortControllerRef.current) {
              abortControllerRef.current.abort();
              abortControllerRef.current = null;
          }
          setIsLoading(false);
          if (isRecording) {
            mediaRecorderRef.current?.stop();
            // Tracks are cleaned up in onstop
            setIsRecording(false);
          }
      }
  };

  const handleRecordToggle = async () => {
    if (isRecording) {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
    } else {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream);
            const chunks: BlobPart[] = [];
            
            recorder.ondataavailable = (e) => chunks.push(e.data);
            recorder.onstop = async () => {
                // Release tracks
                stream.getTracks().forEach(track => track.stop());

                const blob = new Blob(chunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.readAsDataURL(blob);
                reader.onloadend = async () => {
                    const base64data = reader.result as string;
                    const parts = base64data.split(',');
                    const mimeType = parts[0].split(':')[1].split(';')[0];
                    const base64Content = parts[1];
                    
                    if (!chatSession) return;

                    const allowed = await checkChatQuota();
                    if (!allowed) return;

                    setMessages(prev => [...prev, { role: 'user', text: '[Audio Input]' }]);
                    setIsLoading(true);
                    
                    // Create new AbortController
                    const controller = new AbortController();
                    abortControllerRef.current = controller;

                    try {
                        const messagePayload = [
                            { inlineData: { mimeType, data: base64Content } },
                            { text: "Respond to this audio input." }
                        ];
                        
                        const response = await sendMessageToChat(chatSession, messagePayload as any, controller.signal);
                        setMessages(prev => [...prev, { role: 'model', text: response }]);
                    } catch(e: any) {
                         if (e.name !== 'AbortError') {
                            setMessages(prev => [...prev, { role: 'model', text: "ERR: Audio transmission failed." }]);
                         }
                    } finally {
                        setIsLoading(false);
                        abortControllerRef.current = null;
                    }
                };
            };
            
            mediaRecorderRef.current = recorder;
            recorder.start();
            setIsRecording(true);
        } catch (e) {
            console.error("Mic permission denied or error", e);
            alert("Could not access microphone.");
        }
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !chatSession) return;

    const allowed = await checkChatQuota();
    if (!allowed) return;

    const userMsg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setIsLoading(true);

    // Create new AbortController
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
        const response = await sendMessageToChat(chatSession, userMsg, controller.signal);
        setMessages(prev => [...prev, { role: 'model', text: response }]);
    } catch (e: any) {
        if (e.name !== 'AbortError') {
            setMessages(prev => [...prev, { role: 'model', text: "ERR: Neural connection severed." }]);
        }
    } finally {
        setIsLoading(false);
        abortControllerRef.current = null;
    }
  };

  useEffect(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isOpen, isLoading]);

  if (!fileContext) return null;

  // Use fixed layouts for specific states to avoid transitions
  const currentLeft = isFullScreen ? '20px' : `${position.x}px`;
  const currentTop = isFullScreen ? '20px' : `${position.y}px`;
  const currentWidth = isFullScreen ? 'calc(100vw - 40px)' : (isOpen ? '24rem' : '4rem');
  const currentHeight = isFullScreen ? 'calc(100vh - 40px)' : (isOpen ? `${EXPANDED_HEIGHT}px` : '4rem');

  return (
    <div 
        className={`fixed z-[9999]`}
        style={{ left: currentLeft, top: currentTop, width: currentWidth, height: currentHeight }}
    >
        {/* Levitating Sphere */}
        {!isOpen && (
            <div 
                ref={sphereRef}
                onMouseDown={handleMouseDown}
                onTouchStart={handleTouchStart}
                onClick={handleClick}
                className="w-16 h-16 rounded-full bg-black/80 backdrop-blur-sm border-2 border-neon-cyan shadow-[0_0_25px_rgba(0,243,255,0.6)] flex items-center justify-center cursor-grab active:cursor-grabbing group relative overflow-visible transition-transform hover:scale-110 animate-float touch-none"
            >
                <div className="absolute inset-0 bg-gradient-to-tr from-neon-cyan/40 to-transparent rounded-full animate-pulse-slow"></div>
                <Engine className="text-neon-cyan relative z-10 w-8 h-8 drop-shadow-[0_0_5px_rgba(0,243,255,1)]" />
                <div className="absolute -inset-2 border border-dashed border-neon-cyan/30 rounded-full animate-spin-slow pointer-events-none"></div>
                
                {/* Expand Button on Sphere */}
                <button 
                  onClick={handleQuickExpand}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="absolute -top-2 -right-2 w-6 h-6 bg-neon-cyan text-black rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg hover:scale-125 z-50 border border-white/20"
                  title="Expand to Full View"
                >
                  <Maximize2 size={12} />
                </button>

                <div className="absolute -inset-1 border border-dotted border-neon-red/30 rounded-full animate-reverse-spin pointer-events-none opacity-50"></div>
                <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap bg-black border border-neon-cyan/50 px-2 py-0.5 rounded text-[9px] font-mono text-neon-cyan opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    AI_CORE_ACTIVE
                </div>
            </div>
        )}

        {/* Chat Interface - Expanded */}
        {isOpen && (
            <div 
                ref={chatRef}
                className="w-full h-full bg-void-1/95 backdrop-blur-xl border border-neon-cyan/30 rounded-lg shadow-[0_0_50px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden origin-center"
            >
                {/* Header - Draggable unless full screen */}
                <div 
                    onMouseDown={handleMouseDown}
                    onTouchStart={handleTouchStart}
                    className={`p-3 bg-zinc-900/90 border-b border-neon-cyan/20 flex items-center justify-between select-none shrink-0 ${isFullScreen ? 'cursor-default' : 'cursor-grab active:cursor-grabbing touch-none'}`}
                >
                    <div className="flex items-center gap-2 text-neon-cyan">
                        <Zap size={16} className="fill-current" />
                        <span className="text-xs font-bold font-tech uppercase tracking-widest text-shadow-neon">Neural_Assistant</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <button 
                            onClick={(e) => { e.stopPropagation(); setIsFullScreen(!isFullScreen); }}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="p-1 hover:bg-neon-cyan/10 text-zinc-500 hover:text-neon-cyan transition-colors rounded"
                            title={isFullScreen ? "Exit Full Window" : "Full Window View"}
                        >
                            {isFullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                        </button>
                        <button 
                            onClick={() => { setIsOpen(false); setIsFullScreen(false); }}
                            className="p-1 hover:bg-neon-cyan/10 text-zinc-500 hover:text-neon-cyan transition-colors rounded"
                            title="Minimize to Sphere"
                            onMouseDown={(e) => e.stopPropagation()} 
                        >
                            <Minus size={14} />
                        </button>
                    </div>
                </div>

                {/* Messages Area */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-black/40 relative">
                    <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.1)_50%),linear-gradient(90deg,rgba(255,0,0,0.03),rgba(0,255,0,0.01),rgba(0,0,255,0.03))] z-0 pointer-events-none bg-[length:100%_4px,3px_100%]"></div>
                    {messages.map((msg, idx) => (
                        <div key={idx} className={`flex relative z-10 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`
                                max-w-[85%] p-3 text-[11px] leading-relaxed content-font tracking-wide shadow-lg
                                ${msg.role === 'user'
                                    ? 'bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/40 rounded-t-lg rounded-bl-lg'
                                    : 'bg-[#1a1a1c] text-zinc-300 border border-zinc-700 rounded-t-lg rounded-br-lg'
                                }
                            `}>
                                {msg.text}
                            </div>
                        </div>
                    ))}
                    {isLoading && (
                        <div className="flex justify-start relative z-10">
                            <div className="bg-[#1a1a1c] p-2 rounded rounded-bl-none flex items-center gap-2 border border-zinc-700">
                                <Loader2 size={12} className="animate-spin text-neon-cyan" />
                                <span className="text-[10px] text-zinc-500 font-mono animate-pulse">PROCESSING_DATA...</span>
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Input Area */}
                <div 
                    className={`p-3 bg-zinc-900/90 border-t border-neon-cyan/20 flex gap-2 shrink-0 ${isFullScreen ? 'cursor-default' : 'cursor-grab active:cursor-grabbing touch-none'}`}
                    onMouseDown={handleMouseDown}
                    onTouchStart={handleTouchStart}
                >
                    <button 
                        onClick={(e) => { e.stopPropagation(); handleStop(); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className={`p-2 border rounded-sm transition-all active:scale-95 ${isLoading ? 'bg-neon-red border-neon-red text-white hover:bg-neon-red/80' : 'bg-zinc-900 border-zinc-700 text-zinc-500 cursor-not-allowed opacity-50'}`}
                        disabled={!isLoading}
                        title="Stop Generation"
                    >
                        <StopCircle size={16} fill="currentColor" />
                    </button>

                    <button 
                        onClick={(e) => { e.stopPropagation(); handleRecordToggle(); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className={`p-2 border rounded-sm transition-all active:scale-95 ${isRecording ? 'bg-neon-red border-neon-red text-white animate-pulse' : 'bg-neon-cyan/10 border-neon-cyan text-neon-cyan hover:bg-neon-cyan hover:text-black'}`}
                        title={isRecording ? "Stop Recording" : "Voice Input"}
                    >
                        {isRecording ? <Square size={16} fill="currentColor" /> : <Mic size={16} />}
                    </button>

                    <div className="flex-1 relative">
                        {quotaError && <div className="absolute -top-7 left-0 right-0 text-[9px] text-rose-400 font-mono truncate">{quotaError}</div>}
                        {!quotaError && lowCredits && <div className="absolute -top-7 left-0 right-0 text-[9px] text-amber-400/70 font-mono truncate">Running low? Invite a friend for +100 credits.</div>}
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => { setInput(e.target.value); if (quotaError) setQuotaError(''); }}
                            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                            onMouseDown={(e) => e.stopPropagation()}
                            placeholder={isRecording ? "Listening..." : "Input command..."}
                            className="w-full bg-void-1 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-neon-cyan focus:border-neon-cyan focus:outline-none font-mono placeholder:text-zinc-500 disabled:opacity-50"
                            disabled={isRecording || isLoading}
                        />
                    </div>
                    <button 
                        onClick={(e) => { e.stopPropagation(); handleSend(); }}
                        disabled={isLoading || !input.trim() || isRecording}
                        onMouseDown={(e) => e.stopPropagation()}
                        aria-label="Send message"
                        className="p-2 bg-neon-cyan/10 border border-neon-cyan text-neon-cyan rounded-sm hover:bg-neon-cyan hover:text-black disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-95"
                    >
                        <Send size={16} />
                    </button>
                </div>
            </div>
        )}
    </div>
  );
};