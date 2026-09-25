import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, X, Send, Cpu, Loader2, Minimize2, Maximize2, Minus, Mic, Square, StopCircle, AlertTriangle, Pencil, Copy, Check, RefreshCw, Share2, Volume2, Clock, MessageSquarePlus, MoreHorizontal, Pin, Trash2 } from 'lucide-react';
import { createChatSession, sendMessageToChat, ChatSession } from '../services/gemini';
import { FileContext } from '../types';
import { Content } from "@google/genai";
import { ensureCredits, isInsufficientCreditsError, getCachedTier, openAccount } from '../services/credits';

interface Props {
  fileContext: FileContext | null;
  bookTitle?: string;
  bookId?: string;
}

interface Message {
  role: 'user' | 'model';
  text: string;
}

// Chat history persists per book in localStorage so it survives a page refresh (it was memory-only
// in a useRef before, which is why the conversation vanished on reload). Capped to the last 100 turns.
const chatKey = (bookId: string) => `decode_chat_${bookId}`;
const loadChatHistory = (bookId: string): Message[] => {
  try { const raw = localStorage.getItem(chatKey(bookId)); const a = raw ? JSON.parse(raw) : null; return Array.isArray(a) ? a : []; } catch { return []; }
};
const saveChatHistory = (bookId: string, msgs: Message[]) => {
  try { localStorage.setItem(chatKey(bookId), JSON.stringify(msgs.slice(-100))); } catch {}
};

// Multiple conversations per book (history list). Each session is one conversation.
interface ChatSessionRecord {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}
// Compact relative timestamp for the history list (DeepSeek-style): now / 5m / 3h / 2d / Mar 3.
const relativeTime = (ts: number): string => {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return `${days}d`; }
};
const sessionsKey = (bookId: string) => `decode_chats_${bookId}`;
const greeting = (bookTitle?: string): Message => ({ role: 'model', text: `Neural Link Established: "${bookTitle || 'Unknown Source'}". \nReady for query.` });
const newSessionId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const deriveTitle = (msgs: Message[]): string => {
  const firstUser = msgs.find(m => m.role === 'user');
  if (!firstUser) return 'New chat';
  const t = firstUser.text.trim().replace(/\s+/g, ' ');
  return !t ? 'New chat' : (t.length > 36 ? `${t.slice(0, 36)}…` : t);
};
const makeSession = (bookTitle?: string): ChatSessionRecord => {
  const now = Date.now();
  return { id: newSessionId(), title: 'New chat', messages: [greeting(bookTitle)], createdAt: now, updatedAt: now };
};
// Loads the per-book session list; migrates the old single-conversation key on first read.
const loadSessions = (bookId: string): ChatSessionRecord[] => {
  try {
    const raw = localStorage.getItem(sessionsKey(bookId));
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) return a; }
    const old = loadChatHistory(bookId);
    if (old.length > 0) { const now = Date.now(); return [{ id: newSessionId(), title: deriveTitle(old), messages: old, createdAt: now, updatedAt: now }]; }
  } catch {}
  return [];
};
const saveSessions = (bookId: string, list: ChatSessionRecord[]) => {
  try { localStorage.setItem(sessionsKey(bookId), JSON.stringify(list.slice(-50))); } catch {}
};

// Lightweight markdown → React renderer for assistant replies (paragraphs, bullet/numbered lists,
// bold, inline code). Everything is React elements — NO dangerouslySetInnerHTML — so it keeps the
// app's no-HTML-injection posture even though the content is model output.
const renderInline = (s: string): React.ReactNode[] => {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, k = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={k++} className="font-semibold text-zinc-100">{t.slice(2, -2)}</strong>);
    else out.push(<code key={k++} className="px-1 py-0.5 rounded bg-black/50 text-neon-cyan">{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
};

const MarkdownText: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.replace(/\r/g, '').split('\n');
  const bullet = (l: string) => /^\s*[-*•]\s+/.test(l);
  const numbered = (l: string) => /^\s*\d+[.)]\s+/.test(l);
  const blocks: React.ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^\s*#{1,6}\s+(.*)/);
    if (h) { blocks.push(<p key={k++} className="font-bold text-zinc-100">{renderInline(h[1])}</p>); i++; continue; }
    if (bullet(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && bullet(lines[i])) { items.push(<li key={items.length}>{renderInline(lines[i].replace(/^\s*[-*•]\s+/, ''))}</li>); i++; }
      blocks.push(<ul key={k++} className="list-disc pl-4 space-y-1">{items}</ul>);
      continue;
    }
    if (numbered(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && numbered(lines[i])) { items.push(<li key={items.length}>{renderInline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>); i++; }
      blocks.push(<ol key={k++} className="list-decimal pl-4 space-y-1">{items}</ol>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !bullet(lines[i]) && !numbered(lines[i]) && !/^\s*#{1,6}\s+/.test(lines[i])) { para.push(lines[i]); i++; }
    blocks.push(<p key={k++}>{renderInline(para.join(' '))}</p>);
  }
  return <div className="space-y-2">{blocks}</div>;
};

export const AIAssistant: React.FC<Props> = ({ fileContext, bookTitle, bookId }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  // Default position
  const [position, setPosition] = useState({ x: window.innerWidth - 100, y: window.innerHeight - 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragStartPosition, setDragStartPosition] = useState({ x: 0, y: 0 });
  
  const [chatSession, setChatSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [creditTier, setCreditTier] = useState<'free' | 'pro' | null>(null);

  const checkChatQuota = async (): Promise<boolean> => {
    try {
      const check = await ensureCredits('chat');
      if (!check.ok) { setCreditTier(check.tier); return false; }
      setCreditTier(null);
      return true;
    } catch {
      return true;
    }
  };

  // Voice Input State
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<any>(null);

  // Per-message edit (user) / copy (tutor) state — DeepSeek-style message actions.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);

  // Per-book conversation history (list of sessions), the active one, and the history-panel toggle.
  const [sessions, setSessions] = useState<ChatSessionRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
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
       setSessions([]);
       setActiveId(null);
       return;
    }

    let list = loadSessions(bookId);
    if (list.length === 0) list = [makeSession(bookTitle)];
    const active = list[list.length - 1];   // most recently updated conversation

    setSessions(list);
    setActiveId(active.id);
    setMessages(active.messages);
    setShowHistory(false);
    setMenuOpenId(null);

    (async () => {
      const session = await createChatSession(fileContext, active.messages.map(m => ({ role: m.role, parts: [{ text: m.text }] })));
      setChatSession(session);
    })();

    prevBookId.current = bookId;
  }, [bookId, fileContext]);

  // Persist the active conversation back into the per-book session list on every change.
  useEffect(() => {
    if (!bookId || !activeId || messages.length === 0) return;
    setSessions(prev => {
      const next = prev.map(s => (s.id === activeId ? { ...s, messages, title: deriveTitle(messages), updatedAt: Date.now() } : s));
      saveSessions(bookId, next);
      return next;
    });
  }, [messages, bookId, activeId]);

  // Dragging Logic (mouse + touch)
  useEffect(() => {
    const clampPosition = (clientX: number, clientY: number) => {
      let newX = clientX - dragOffset.x;
      let newY = clientY - dragOffset.y;
      // Match the rendered caps: the panel never exceeds viewport-24px.
      const curW = isOpen ? Math.min(EXPANDED_WIDTH, window.innerWidth - 24) : SPHERE_SIZE;
      const curH = isOpen ? Math.min(EXPANDED_HEIGHT, window.innerHeight - 24) : SPHERE_SIZE;
      if (newX < 0) newX = 0;
      if (newY < 0) newY = 0;
      if (newX + curW > window.innerWidth) newX = window.innerWidth - curW;
      if (newY + curH > window.innerHeight) newY = window.innerHeight - curH;
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

  // Track small viewports so the widget can adapt (full-screen default, history overlay).
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 640px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // On phones the floating 24rem panel is the wrong mode — open straight into full-screen.
  useEffect(() => {
    if (isOpen && isMobile) setIsFullScreen(true);
  }, [isOpen, isMobile]);

  // Keep the widget fully on-screen when it opens, the viewport resizes, or the device rotates —
  // the drag clamp only runs mid-drag, so without this an expanded panel could sit partly offscreen
  // (unreachable header/close) on small phones.
  useEffect(() => {
    if (isFullScreen) return;
    const reclamp = () => {
      const effW = isOpen ? Math.min(EXPANDED_WIDTH, window.innerWidth - 24) : SPHERE_SIZE;
      const effH = isOpen ? Math.min(EXPANDED_HEIGHT, window.innerHeight - 24) : SPHERE_SIZE;
      setPosition(p => ({
        x: Math.max(0, Math.min(p.x, window.innerWidth - effW)),
        y: Math.max(0, Math.min(p.y, window.innerHeight - effH)),
      }));
    };
    reclamp();
    window.addEventListener('resize', reclamp);
    window.addEventListener('orientationchange', reclamp);
    return () => {
      window.removeEventListener('resize', reclamp);
      window.removeEventListener('orientationchange', reclamp);
    };
  }, [isOpen, isFullScreen]);

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
            recognitionRef.current?.stop();
            mediaRecorderRef.current?.stop();
            // Tracks are cleaned up in onstop
            setIsRecording(false);
          }
      }
  };

  const handleRecordToggle = async () => {
    // Primary: browser Speech-to-Text. Transcribes speech into the input box (editable before
    // sending) with no extra model call. Falls back to MediaRecorder + Gemini for browsers without it.
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (isRecording) {
        recognitionRef.current?.stop();
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
        return;
    }

    if (SR) {
        try {
            const rec = new SR();
            rec.lang = navigator.language || 'en-US';
            rec.interimResults = true;
            rec.continuous = false;
            let settled = input.trim() ? input.trim() + ' ' : '';
            rec.onresult = (e: any) => {
                let interim = '';
                for (let i = e.resultIndex; i < e.results.length; i++) {
                    const t = e.results[i][0].transcript;
                    if (e.results[i].isFinal) settled += t; else interim += t;
                }
                setInput((settled + interim).replace(/\s+/g, ' ').trimStart());
                if (creditTier) setCreditTier(null);
            };
            rec.onerror = () => { setIsRecording(false); recognitionRef.current = null; };
            rec.onend = () => { setIsRecording(false); recognitionRef.current = null; };
            recognitionRef.current = rec;
            rec.start();
            setIsRecording(true);
        } catch (e) {
            console.error('SpeechRecognition failed', e);
            setIsRecording(false);
        }
        return;
    }

    {
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
                         if (isInsufficientCreditsError(e)) {
                            setCreditTier(getCachedTier()?.tier === 'pro' ? 'pro' : 'free');
                         } else if (controller.signal.aborted) {
                            setMessages(prev => [...prev, { role: 'model', text: "Request cancelled — what can I help you with?" }]);
                         } else {
                            setMessages(prev => [...prev, { role: 'model', text: "Couldn't process the audio. Please try again." }]);
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
        if (isInsufficientCreditsError(e)) {
            setCreditTier(getCachedTier()?.tier === 'pro' ? 'pro' : 'free');
        } else if (controller.signal.aborted) {
            setMessages(prev => [...prev, { role: 'model', text: "Request cancelled — what can I help you with?" }]);
        } else {
            setMessages(prev => [...prev, { role: 'model', text: "Something went wrong. Please try again." }]);
        }
    } finally {
        setIsLoading(false);
        abortControllerRef.current = null;
    }
  };

  const startEdit = (idx: number) => {
    setEditingIndex(idx);
    setEditText(messages[idx]?.text ?? '');
  };
  const cancelEdit = () => { setEditingIndex(null); setEditText(''); };

  // Rebuild the chat session from a truncated prefix and re-ask `userText` — the shared core of
  // both "edit a message" and "regenerate a reply" (DeepSeek-style: everything after is dropped).
  const runFromPrefix = async (prefix: Message[], userText: string) => {
    if (!fileContext) return;
    const apiHistory: Content[] = prefix.map(m => ({ role: m.role, parts: [{ text: m.text }] }));
    setMessages([...prefix, { role: 'user', text: userText }]);
    setIsLoading(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
        const session = await createChatSession(fileContext, apiHistory);
        setChatSession(session);
        const response = await sendMessageToChat(session, userText, controller.signal);
        setMessages(prev => [...prev, { role: 'model', text: response }]);
    } catch (e: any) {
        if (isInsufficientCreditsError(e)) {
            setCreditTier(getCachedTier()?.tier === 'pro' ? 'pro' : 'free');
        } else if (controller.signal.aborted) {
            setMessages(prev => [...prev, { role: 'model', text: "Request cancelled — what can I help you with?" }]);
        } else {
            setMessages(prev => [...prev, { role: 'model', text: "Something went wrong. Please try again." }]);
        }
    } finally {
        setIsLoading(false);
        abortControllerRef.current = null;
    }
  };

  // Edit a previous user message and regenerate from that point.
  const submitEdit = async (idx: number) => {
    const newText = editText.trim();
    if (!newText || !fileContext || isLoading) return;
    const allowed = await checkChatQuota();
    if (!allowed) return;
    const prefix = messages.slice(0, idx);
    setEditingIndex(null);
    setEditText('');
    await runFromPrefix(prefix, newText);
  };

  // Regenerate a tutor reply: re-ask the user message that preceded it.
  const regenerate = async (modelIdx: number) => {
    if (!fileContext || isLoading) return;
    let userIdx = modelIdx - 1;
    while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) return;
    const allowed = await checkChatQuota();
    if (!allowed) return;
    await runFromPrefix(messages.slice(0, userIdx), messages[userIdx].text);
  };

  const handleCopy = async (idx: number, text: string) => {
    try {
        await navigator.clipboard.writeText(text);
        setCopiedIndex(idx);
        setTimeout(() => setCopiedIndex(c => (c === idx ? null : c)), 1500);
    } catch { /* clipboard blocked — ignore */ }
  };

  const handleShare = async (text: string) => {
    try {
        if (navigator.share) await navigator.share({ text });
        else await navigator.clipboard.writeText(text);
    } catch { /* share cancelled — ignore */ }
  };

  // Read a tutor reply aloud via the browser's speech synthesis (free, no model call). Toggles.
  const handleReadAloud = (idx: number, text: string) => {
    try {
        const synth = window.speechSynthesis;
        if (!synth) return;
        if (speakingIndex === idx) { synth.cancel(); setSpeakingIndex(null); return; }
        synth.cancel();
        const utter = new SpeechSynthesisUtterance(text.replace(/[*_`#>]/g, ''));
        utter.lang = navigator.language || 'en-US';
        utter.onend = () => setSpeakingIndex(c => (c === idx ? null : c));
        utter.onerror = () => setSpeakingIndex(c => (c === idx ? null : c));
        setSpeakingIndex(idx);
        synth.speak(utter);
    } catch { /* speech unavailable — ignore */ }
  };

  // Start a fresh conversation (added to the history list). Stays put if the current chat is
  // still empty (greeting only) so repeated clicks don't stack blank sessions.
  const newChat = () => {
    if (!bookId) return;
    setShowHistory(false);
    setEditingIndex(null);
    if (!messages.some(m => m.role === 'user')) return;
    const rec = makeSession(bookTitle);
    setSessions(prev => { const next = [...prev, rec]; saveSessions(bookId, next); return next; });
    setActiveId(rec.id);
    setMessages(rec.messages);
    if (fileContext) (async () => { const s = await createChatSession(fileContext, []); setChatSession(s); })();
  };

  // Open a past conversation from the history list into the chat window.
  const openSession = (id: string) => {
    const rec = sessions.find(s => s.id === id);
    if (!rec) return;
    setShowHistory(false);
    setEditingIndex(null);
    setActiveId(id);
    setMessages(rec.messages);
    if (fileContext) (async () => { const s = await createChatSession(fileContext, rec.messages.map(m => ({ role: m.role, parts: [{ text: m.text }] }))); setChatSession(s); })();
  };

  // Share the WHOLE conversation as a plain-text transcript.
  const shareSession = (rec: ChatSessionRecord) => {
    setMenuOpenId(null);
    const transcript = rec.messages.map(m => `${m.role === 'user' ? 'You' : 'Tutor'}: ${m.text}`).join('\n\n');
    handleShare(transcript);
  };

  const togglePin = (id: string) => {
    if (!bookId) return;
    setMenuOpenId(null);
    setSessions(prev => { const next = prev.map(s => (s.id === id ? { ...s, pinned: !s.pinned } : s)); saveSessions(bookId, next); return next; });
  };

  const deleteSession = (id: string) => {
    if (!bookId) return;
    setMenuOpenId(null);
    const next = sessions.filter(s => s.id !== id);
    if (id === activeId) {
      // Deleting the open chat — fall back to the next most recent, or a fresh one.
      const fallback = next[next.length - 1] ?? null;
      if (fallback) {
        setActiveId(fallback.id);
        setMessages(fallback.messages);
        if (fileContext) (async () => { const s = await createChatSession(fileContext, fallback.messages.map(m => ({ role: m.role, parts: [{ text: m.text }] }))); setChatSession(s); })();
      } else {
        const rec = makeSession(bookTitle);
        next.push(rec);
        setActiveId(rec.id);
        setMessages(rec.messages);
        if (fileContext) (async () => { const s = await createChatSession(fileContext, []); setChatSession(s); })();
      }
    }
    setSessions(next);
    saveSessions(bookId, next);
  };

  useEffect(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isOpen, isLoading]);

  if (!fileContext) return null;

  // Use fixed layouts for specific states to avoid transitions
  const currentLeft = isFullScreen ? '20px' : `${position.x}px`;
  const currentTop = isFullScreen ? '20px' : `${position.y}px`;
  const currentWidth = isFullScreen ? 'calc(100vw - 40px)' : (isOpen ? 'min(24rem, calc(100vw - 24px))' : '4rem');
  const currentHeight = isFullScreen ? 'calc(100dvh - 40px)' : (isOpen ? `min(${EXPANDED_HEIGHT}px, calc(100dvh - 24px))` : '4rem');

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
                <Cpu className="text-neon-cyan relative z-10 w-8 h-8 drop-shadow-[0_0_5px_rgba(0,243,255,1)]" />
                <div className="absolute -inset-2 border border-dashed border-neon-cyan/30 rounded-full animate-spin-slow pointer-events-none"></div>
                <div className="absolute -inset-1 border border-dotted border-neon-red/30 rounded-full animate-reverse-spin pointer-events-none opacity-50"></div>
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
                    <div className="flex items-center gap-1.5 text-neon-cyan">
                        <span className="text-xs font-bold font-tech uppercase tracking-widest text-shadow-neon">Neural_Assistant</span>
                        <button
                            onClick={(e) => { e.stopPropagation(); setShowHistory(v => !v); }}
                            onMouseDown={(e) => e.stopPropagation()}
                            className={`p-2 rounded transition-colors ${showHistory ? 'text-neon-cyan bg-neon-cyan/10' : 'text-zinc-500 hover:text-neon-cyan hover:bg-neon-cyan/10'}`}
                            title="Chat history"
                        >
                            <Clock size={14} />
                        </button>
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={(e) => { e.stopPropagation(); newChat(); }}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="p-2 hover:bg-neon-cyan/10 text-zinc-500 hover:text-neon-cyan transition-colors rounded"
                            title="New chat"
                        >
                            <MessageSquarePlus size={14} />
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsFullScreen(!isFullScreen); }}
                            onMouseDown={(e) => e.stopPropagation()}
                            className={`p-2 hover:bg-neon-cyan/10 text-zinc-500 hover:text-neon-cyan transition-colors rounded ${isMobile ? 'hidden' : ''}`}
                            title={isFullScreen ? "Exit Full Window" : "Full Window View"}
                        >
                            {isFullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                        </button>
                        <button 
                            onClick={() => { setIsOpen(false); setIsFullScreen(false); }}
                            className="p-2 hover:bg-neon-cyan/10 text-zinc-500 hover:text-neon-cyan transition-colors rounded"
                            title="Minimize to Sphere"
                            onMouseDown={(e) => e.stopPropagation()} 
                        >
                            <Minus size={14} />
                        </button>
                    </div>
                </div>

                <div className="relative flex-1 flex min-h-0 overflow-hidden">
                {menuOpenId && <div className="absolute inset-0 z-20" onMouseDown={(e) => { e.stopPropagation(); setMenuOpenId(null); }} />}
                {/* History sidebar (DeepSeek-style) — narrows the chat column while open */}
                {showHistory && (
                    <div className={`flex flex-col border-neon-cyan/20 bg-zinc-900/70 ${isMobile ? 'absolute inset-0 z-30 w-full' : 'w-2/5 max-w-[220px] shrink-0 border-r'}`}>
                        <div className="shrink-0 border-b border-zinc-800 px-2 py-2 font-mono text-[9px] uppercase tracking-widest text-zinc-500">History</div>
                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {sessions.length === 0 ? (
                                <div className="p-2 font-mono text-[10px] text-zinc-600">No chats yet</div>
                            ) : [...sessions].sort((a, b) => (!!a.pinned !== !!b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt)).map((s, i, arr) => {
                                const nearBottom = arr.length > 3 && i >= arr.length - 2;
                                return (
                                <div key={s.id} className={`group relative ${menuOpenId === s.id ? 'z-30' : ''}`}>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); openSession(s.id); }}
                                        onMouseDown={(e) => e.stopPropagation()}
                                        title={s.title}
                                        className={`block w-full border-b border-zinc-800/50 px-2 py-2 pr-6 text-left transition-colors ${s.id === activeId ? 'bg-neon-cyan/5' : 'hover:bg-neon-cyan/5'}`}
                                    >
                                        <div className="flex items-center gap-1">
                                            {s.pinned && <Pin size={9} className="shrink-0 text-neon-cyan/70" fill="currentColor" />}
                                            <span className={`truncate text-[10px] leading-snug content-font ${s.id === activeId ? 'text-neon-cyan' : 'text-zinc-300'}`}>{s.title || 'New chat'}</span>
                                        </div>
                                        <span className="mt-0.5 block font-mono text-[8px] text-zinc-600">{relativeTime(s.updatedAt)}</span>
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === s.id ? null : s.id); }}
                                        onMouseDown={(e) => e.stopPropagation()}
                                        title="More"
                                        className={`absolute right-1 top-1.5 rounded p-0.5 text-zinc-500 transition hover:bg-neon-cyan/10 hover:text-neon-cyan ${menuOpenId === s.id ? 'text-neon-cyan opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                                    >
                                        <MoreHorizontal size={13} />
                                    </button>
                                    {menuOpenId === s.id && (
                                        <div className={`absolute right-1 z-30 w-max rounded-sm border border-zinc-700 bg-zinc-900 py-1 shadow-lg ${nearBottom ? 'bottom-7' : 'top-7'}`} onMouseDown={(e) => e.stopPropagation()}>
                                            <button onClick={(e) => { e.stopPropagation(); shareSession(s); }} className="flex w-full items-center gap-2 px-2 py-1 text-left text-[10px] text-zinc-300 hover:bg-neon-cyan/10 hover:text-neon-cyan"><Share2 size={11} /> Share</button>
                                            <button onClick={(e) => { e.stopPropagation(); togglePin(s.id); }} className="flex w-full items-center gap-2 px-2 py-1 text-left text-[10px] text-zinc-300 hover:bg-neon-cyan/10 hover:text-neon-cyan"><Pin size={11} /> {s.pinned ? 'Unpin' : 'Pin'}</button>
                                            <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }} className="flex w-full items-center gap-2 px-2 py-1 text-left text-[10px] text-neon-red hover:bg-neon-red/10"><Trash2 size={11} /> Delete</button>
                                        </div>
                                    )}
                                </div>
                                );
                            })}
                        </div>
                    </div>
                )}
                <div className="flex flex-1 flex-col min-w-0">
                {/* Messages Area */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-black/40 relative">
                    <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.1)_50%),linear-gradient(90deg,rgba(255,0,0,0.03),rgba(0,255,0,0.01),rgba(0,0,255,0.03))] z-0 pointer-events-none bg-[length:100%_4px,3px_100%]"></div>
                    {messages.map((msg, idx) => {
                        const isUser = msg.role === 'user';
                        const isEditing = editingIndex === idx;
                        return (
                        <div key={idx} className={`flex relative z-10 ${isUser ? 'justify-end' : 'justify-start'}`}>
                            <div className={`flex flex-col max-w-[85%] ${isEditing ? 'w-full' : ''} ${isUser ? 'items-end' : 'items-start'}`}>
                                {isEditing ? (
                                    <>
                                        <div className="w-full p-3 text-[11px] leading-relaxed content-font tracking-wide shadow-lg bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/40 rounded-t-lg rounded-bl-lg">
                                            <textarea
                                                ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                                                value={editText}
                                                onChange={(e) => { setEditText(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`; }}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(idx); }
                                                    if (e.key === 'Escape') { cancelEdit(); }
                                                }}
                                                autoFocus
                                                rows={1}
                                                className="block w-full bg-transparent text-[11px] leading-relaxed content-font tracking-wide text-neon-cyan resize-none border-0 outline-none focus:outline-none focus:ring-0 overflow-hidden"
                                            />
                                        </div>
                                        <div className="flex items-center justify-end gap-3 mt-1 px-1 h-7">
                                            <button onClick={cancelEdit} className="text-[10px] font-mono text-zinc-400 hover:text-white transition-colors">Cancel</button>
                                            <button onClick={() => submitEdit(idx)} disabled={!editText.trim() || isLoading} className="text-[10px] font-mono text-neon-cyan hover:text-white transition-colors disabled:opacity-40">Send</button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className={`
                                            p-3 text-[11px] leading-relaxed content-font tracking-wide shadow-lg
                                            ${isUser
                                                ? 'bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/40 rounded-t-lg rounded-bl-lg'
                                                : 'bg-[#1a1a1c] text-zinc-300 border border-zinc-700 rounded-t-lg rounded-br-lg'
                                            }
                                        `}>
                                            {msg.role === 'model' ? <MarkdownText text={msg.text} /> : msg.text}
                                        </div>
                                        <div className={`flex items-center gap-3 mt-1 px-1 h-7 ${isUser ? 'justify-end' : 'justify-start'}`}>
                                            {isUser ? (
                                                <button onClick={() => startEdit(idx)} disabled={isLoading} title="Edit" className="p-1.5 text-zinc-500 hover:text-neon-cyan transition-colors disabled:opacity-30">
                                                    <Pencil size={12} />
                                                </button>
                                            ) : (idx !== 0 && (
                                                <>
                                                    <button onClick={() => regenerate(idx)} disabled={isLoading} title="Regenerate" className="p-1.5 text-zinc-500 hover:text-neon-cyan transition-colors disabled:opacity-30">
                                                        <RefreshCw size={12} />
                                                    </button>
                                                    <button onClick={() => handleCopy(idx, msg.text)} title="Copy" className="p-1.5 text-zinc-500 hover:text-neon-cyan transition-colors">
                                                        {copiedIndex === idx ? <Check size={12} /> : <Copy size={12} />}
                                                    </button>
                                                    <button onClick={() => handleShare(msg.text)} title="Share" className="p-1.5 text-zinc-500 hover:text-neon-cyan transition-colors">
                                                        <Share2 size={12} />
                                                    </button>
                                                    <button onClick={() => handleReadAloud(idx, msg.text)} title="Read aloud" className={`p-1.5 transition-colors ${speakingIndex === idx ? 'text-neon-cyan' : 'text-zinc-500 hover:text-neon-cyan'}`}>
                                                        <Volume2 size={12} />
                                                    </button>
                                                </>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                        );
                    })}
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

                {/* Input Area — not a drag handle (dragging is header-only) so touch typing works */}
                <div className="p-3 bg-zinc-900/90 border-t border-neon-cyan/20 flex gap-2 shrink-0">
                    <button
                        onClick={(e) => { e.stopPropagation(); handleRecordToggle(); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className={`p-2 border rounded-sm transition-all active:scale-95 ${isRecording ? 'bg-neon-red border-neon-red text-white animate-pulse' : 'bg-neon-cyan/10 border-neon-cyan text-neon-cyan hover:bg-neon-cyan hover:text-black'}`}
                        title={isRecording ? "Stop Recording" : "Voice Input"}
                    >
                        {isRecording ? <Square size={16} fill="currentColor" /> : <Mic size={16} />}
                    </button>

                    <div className="flex-1 relative">
                        {creditTier && (
                          <div className="absolute -top-7 left-0 right-0 text-[10px] font-mono text-neon-yellow truncate flex items-center gap-1">
                            <AlertTriangle size={11} className="shrink-0" /> Not enough credits —
                            <button onClick={() => openAccount(creditTier === 'free' ? 'upgrade' : 'packs')} className="underline hover:text-white">
                              {creditTier === 'free' ? 'Upgrade' : 'Buy Credits'}
                            </button>
                          </div>
                        )}
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => { setInput(e.target.value); if (creditTier) setCreditTier(null); }}
                            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                            onMouseDown={(e) => e.stopPropagation()}
                            placeholder={isRecording ? "Listening..." : "Input command..."}
                            className="w-full bg-void-1 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-neon-cyan focus:border-neon-cyan focus:outline-none font-mono placeholder:text-zinc-500 disabled:opacity-50"
                            disabled={isRecording || isLoading}
                        />
                    </div>
                    <button
                        onClick={(e) => { e.stopPropagation(); if (isLoading) handleStop(); else handleSend(); }}
                        disabled={isLoading ? false : (!input.trim() || isRecording)}
                        onMouseDown={(e) => e.stopPropagation()}
                        aria-label={isLoading ? "Stop generation" : "Send message"}
                        title={isLoading ? "Stop Generation" : "Send"}
                        className={`p-2 border rounded-sm transition-all active:scale-95 ${isLoading
                            ? 'bg-neon-red border-neon-red text-white hover:bg-neon-red/80'
                            : 'bg-neon-cyan/10 border-neon-cyan text-neon-cyan hover:bg-neon-cyan hover:text-black disabled:opacity-50 disabled:cursor-not-allowed'}`}
                    >
                        {isLoading ? <StopCircle size={16} fill="currentColor" /> : <Send size={16} />}
                    </button>
                </div>
                </div>
                </div>
            </div>
        )}
    </div>
  );
};