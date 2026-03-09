
import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, ChevronLeft, ChevronRight, Eye, Headphones, Download, RotateCcw, RotateCw, Columns, Globe, Settings2, Square, RefreshCw, Volume2, Minimize2, Maximize2, Activity, Share2 } from 'lucide-react';
import { Chapter, FileContext, AppSettings, ThemeColor } from '../types';
import { extractChapterText, generateSpeech, translateSentences, cleanGenAiText } from '../services/gemini';
import { Loader } from './ui/Loader';
import { pcmToWav } from '../utils/audio';

interface Props {
  chapter: Chapter;
  fileContext: FileContext;
  settings: AppSettings;
  onSettingsUpdate: (settings: AppSettings) => void;
}

interface QuantumParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  hue: number;
  alpha: number;
  targetSize: number;
  intensity: number;
  angle: number;
  type: 'pixel' | 'data' | 'shimmer';
  life: number;
}

const VOICES = [
  { name: 'Puck', label: 'Puck (Male)', tone: 'NARRATIVE' },
  { name: 'Charon', label: 'Charon (Male)', tone: 'RESONANT' },
  { name: 'Kore', label: 'Kore (Female)', tone: 'MELODIC' },
  { name: 'Fenrir', label: 'Fenrir (Male)', tone: 'RUGGED' },
  { name: 'Zephyr', label: 'Zephyr (Female)', tone: 'SERENE' }
];

const LANGUAGES = [
  'Original', 'Arabic', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Dutch', 'English', 'French', 'German', 'Hindi', 'Indonesian', 'Italian', 'Japanese', 'Korean', 'Polish', 'Portuguese', 'Russian', 'Spanish', 'Swedish', 'Thai', 'Turkish', 'Vietnamese'
];

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const PAGE_TARGET_SIZE = 1600; 
const CONCURRENCY_LIMIT = 1; 
const TTS_BATCH_SIZE = 4; 

interface ChunkTiming {
  text: string;
  start: number;
  end: number;
  isWhitespace: boolean;
}

interface SentenceMap {
    pIndex: number;
    sIndex: number;
    globalIndex: number;
    text: string;
}

interface ParagraphData {
    original: string[]; 
    translated: string[]; 
}

const HIGHLIGHT_STYLES: Record<ThemeColor, string> = {
  indigo: 'text-[#00f3ff] drop-shadow-[0_0_2px_rgba(0,243,255,0.8)] decoration-[#00f3ff]/30 underline decoration-2 underline-offset-4',
  emerald: 'text-emerald-400 drop-shadow-[0_0_2px_rgba(52,211,153,0.8)] decoration-emerald-500/30 underline decoration-2 underline-offset-4',
  rose: 'text-[#ff003c] drop-shadow-[0_0_2px_rgba(255,0,60,0.8)] decoration-[#ff003c]/30 underline decoration-2 underline-offset-4',
  amber: 'text-amber-400 drop-shadow-[0_0_2px_rgba(251,191,36,0.8)] decoration-amber-500/30 underline decoration-2 underline-offset-4',
  cyan: 'text-cyan-300 drop-shadow-[0_0_2px_rgba(34,211,238,0.8)] decoration-cyan-500/30 underline decoration-2 underline-offset-4',
};

const TEXT_SIZES: Record<string, string> = {
  sm: 'text-[14px]',
  base: 'text-[16px]',
  lg: 'text-[18px]',
  xl: 'text-[22px]',
};

const LINE_HEIGHTS: Record<string, string> = {
  tight: 'leading-tight',
  normal: 'leading-normal',
  relaxed: 'leading-relaxed',
  loose: 'leading-loose',
};

const LETTER_SPACINGS: Record<string, string> = {
  tighter: 'tracking-tighter',
  normal: 'tracking-normal',
  wide: 'tracking-wide',
  wider: 'tracking-wider',
};

const formatTime = (seconds: number): string => {
  if (!seconds || isNaN(seconds)) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const rearrangeAndCleanText = (text: string): string => {
  if (!text) return "";
  let cleaned = cleanGenAiText(text);
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
};

const paginateText = (text: string, targetSize: number): string[] => {
  const pages: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= targetSize) {
      pages.push(remaining.trim());
      break;
    }
    let splitIdx = targetSize;
    const paragraphBreak = remaining.lastIndexOf('\n\n', targetSize);
    if (paragraphBreak > targetSize * 0.7) {
      splitIdx = paragraphBreak;
    } else {
      const sentenceBreak = Math.max(
          remaining.lastIndexOf('. ', targetSize),
          remaining.lastIndexOf('? ', targetSize),
          remaining.lastIndexOf('! ', targetSize)
      );
      if (sentenceBreak > targetSize * 0.5) splitIdx = sentenceBreak + 1;
      else {
          const spaceBreak = remaining.lastIndexOf(' ', targetSize);
          if (spaceBreak > 0) splitIdx = spaceBreak;
      }
    }
    pages.push(remaining.substring(0, splitIdx).trim());
    remaining = remaining.substring(splitIdx).trim();
  }
  return pages;
};

const splitIntoSentences = (text: string): string[] => {
  if (!text) return [];
  const sentences = text.match(/[^.!?]+[.!?]+["'”’]?\s*|.+$/g) || [text];
  return sentences.map(s => s.trim()).filter(s => s.length > 0);
};

const processQueue = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  checkAbort?: () => boolean
): Promise<(R | null)[]> => {
  const results: (R | null)[] = new Array(items.length).fill(null);
  const queue = items.map((item, index) => ({ item, index }));
  const worker = async () => {
    while (queue.length > 0) {
      if (checkAbort && checkAbort()) break;
      const task = queue.shift();
      if (!task) break; 
      const { item, index } = task;
      try {
        const result = await fn(item, index);
        results[index] = result;
      } catch (e: any) {
        results[index] = null;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  };
  const workers = Array.from({ length: concurrency }).map(() => worker());
  await Promise.all(workers);
  return results;
};

export const AudioBook: React.FC<Props> = ({ chapter, fileContext, settings, onSettingsUpdate }) => {
  const [pages, setPages] = useState<string[]>([]);
  const [paragraphData, setParagraphData] = useState<ParagraphData[]>([]);
  const [flatSentenceMap, setFlatSentenceMap] = useState<SentenceMap[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [isLoadingText, setIsLoadingText] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [viewMode, setViewMode] = useState<'single' | 'split'>('single');
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [timings, setTimings] = useState<ChunkTiming[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasInitiated, setHasInitiated] = useState(false);
  const [generationProgress, setGenerationProgress] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedVoice, setSelectedVoice] = useState('Puck');
  const [audioLanguage, setAudioLanguage] = useState(settings.targetLanguage);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeSentenceIndex, setActiveSentenceIndex] = useState<number>(-1);
  const [isModuleMinimized, setIsModuleMinimized] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const abortGenerationRef = useRef<boolean>(false);
  const animationRef = useRef<number | null>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const particlesRef = useRef<QuantumParticle[]>([]);

  const resetAudioState = () => {
    if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current.playbackRate = 1.0;
    }
    
    if (audioSrc) URL.revokeObjectURL(audioSrc);
    setAudioSrc(null);
    setTimings([]);
    setIsPlaying(false);
    setPlaybackProgress(0);
    setCurrentTime(0);
    setDuration(0);
    setPlaybackRate(1.0);
    setActiveSentenceIndex(-1);
    setGenerationProgress("");
    setHasInitiated(false);
  };

  // Fix: Added missing changePage function to navigate between pages
  const changePage = (next: boolean) => {
    if (next && currentPage < pages.length - 1) {
      setCurrentPage(prev => prev + 1);
    } else if (!next && currentPage > 0) {
      setCurrentPage(prev => prev - 1);
    }
  };

  useEffect(() => {
    return () => { if (audioSrc) URL.revokeObjectURL(audioSrc); };
  }, [audioSrc]);

  const loadContent = async () => {
    setIsLoadingText(true);
    setPages([]);
    setCurrentPage(0);
    resetAudioState();
    try {
      const rawText = await extractChapterText(fileContext, chapter);
      const cleanText = rearrangeAndCleanText(rawText);
      setPages(paginateText(cleanText, PAGE_TARGET_SIZE));
    } catch (err: any) {
      console.error(err);
    } finally {
      setIsLoadingText(false);
    }
  };

  useEffect(() => { loadContent(); }, [chapter, fileContext]);

  useEffect(() => {
     if (!pages[currentPage]) return;
     const pageText = pages[currentPage];
     const rawParagraphs = pageText.split(/\n\s*\n/).filter(p => p.trim().length > 0);
     const newParagraphData: ParagraphData[] = [];
     const newSentenceMap: SentenceMap[] = [];
     let globalIdx = 0;
     rawParagraphs.forEach((pText, pIndex) => {
         const sentences = splitIntoSentences(pText);
         sentences.forEach((s, sIndex) => {
             newSentenceMap.push({ pIndex, sIndex, globalIndex: globalIdx, text: s });
             globalIdx++;
         });
         newParagraphData.push({ original: sentences, translated: [] });
     });
     
     setParagraphData(newParagraphData);
     setFlatSentenceMap(newSentenceMap);
     resetAudioState();
     setActiveSentenceIndex(-1);
     abortGenerationRef.current = true;
     setIsTranslating(false); 
  }, [currentPage, pages]);

  useEffect(() => {
    let ignore = false;
    const loadTranslation = async () => {
      if (settings.targetLanguage === 'Original' || flatSentenceMap.length === 0) {
        setIsTranslating(false);
        return;
      }

      const allSentences = flatSentenceMap.map(m => m.text);
      if (allSentences.length === 0) return;

      setIsTranslating(true);
      try {
        const translations = await translateSentences(allSentences, settings.targetLanguage);
        if (ignore) return;
        
        setParagraphData(prev => {
            if (prev.length === 0) return prev;
            let transPointer = 0;
            return prev.map((p) => {
                const count = p.original.length;
                const pTrans = translations.slice(transPointer, transPointer + count);
                transPointer += count;
                while (pTrans.length < count) pTrans.push("");
                return { ...p, translated: pTrans };
            });
        });
      } catch(e) { 
        console.error("Translation error", e); 
      } finally { 
        if (!ignore) setIsTranslating(false); 
      }
    };

    loadTranslation();
    return () => { ignore = true; };
  }, [currentPage, settings.targetLanguage, flatSentenceMap]);

  const initAudioVisualizer = () => {
    if (!audioRef.current || audioContextRef.current) return;
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512; 
      const source = ctx.createMediaElementSource(audioRef.current);
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;

      const particles: QuantumParticle[] = [];
      const particleCount = 200;
      for (let i = 0; i < particleCount; i++) {
        const typeRand = Math.random();
        particles.push({
          x: Math.random() * 1800,
          y: Math.random() * 250,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          size: Math.random() * 2 + 0.5,
          targetSize: 1,
          hue: 180 + Math.random() * 40,
          alpha: Math.random() * 0.4 + 0.1,
          intensity: 0,
          angle: Math.random() * Math.PI * 2,
          type: typeRand > 0.9 ? 'data' : typeRand > 0.7 ? 'shimmer' : 'pixel',
          life: Math.random()
        });
      }
      particlesRef.current = particles;
    } catch (e) { console.warn("Visualizer failed", e); }
  };

  useEffect(() => {
    if (audioRef.current) {
        audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, audioSrc]);

  // Synchronize state with audio element clock
  const handleTimeUpdate = () => {
    if (audioRef.current) {
      const audio = audioRef.current;
      const t = audio.currentTime;
      setCurrentTime(t);
      const d = audio.duration || 0;
      setDuration(d);
      setPlaybackProgress(d > 0 ? (t / d) * 100 : 0);
      
      const activeIdx = timings.findIndex(chunk => !chunk.isWhitespace && t >= chunk.start && t < chunk.end);
      if (activeIdx !== -1 && activeIdx !== activeSentenceIndex) {
          setActiveSentenceIndex(activeIdx);
      }
    }
  };

  // Dedicated visualizer loop
  useEffect(() => {
    if (!isPlaying) return;
    
    const draw = () => {
        if (canvasRef.current && analyserRef.current && !isModuleMinimized) {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                const bufferLength = analyserRef.current.frequencyBinCount;
                const dataArray = new Uint8Array(bufferLength);
                analyserRef.current.getByteFrequencyData(dataArray);
                
                let bass = 0; 
                let mid = 0;
                let high = 0;
                const split1 = Math.floor(bufferLength * 0.1);
                const split2 = Math.floor(bufferLength * 0.4);

                for (let i = 0; i < split1; i++) bass += dataArray[i];
                for (let i = split1; i < split2; i++) mid += dataArray[i];
                for (let i = split2; i < bufferLength; i++) high += dataArray[i];

                bass = (bass / split1) / 255;
                mid = (mid / (split2 - split1)) / 255;
                high = (high / (bufferLength - split2)) / 255;

                ctx.fillStyle = 'rgba(2, 4, 8, 0.2)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                const centerX = canvas.width / 2;
                const centerY = canvas.height / 2;

                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                for (let w = 0; w < 3; w++) {
                    ctx.beginPath();
                    ctx.lineWidth = 1.5 + (w * 0.5);
                    ctx.strokeStyle = `hsla(${180 + w * 20}, 100%, 70%, ${0.2 + mid * 0.5})`;
                    const amplitude = (60 + w * 20) * (bass + mid * 0.5);
                    const freq = 0.005 + (w * 0.002);
                    const offset = Date.now() * 0.002 + (w * Math.PI);
                    ctx.moveTo(0, centerY);
                    for (let x = 0; x < canvas.width; x += 10) {
                        const y = centerY + Math.sin(x * freq + offset) * amplitude * Math.sin(x / canvas.width * Math.PI);
                        ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                }
                ctx.restore();

                const barWidth = (canvas.width / bufferLength) * 2.5;
                let barX = 0;
                ctx.save();
                ctx.globalCompositeOperation = 'screen';
                for (let i = 0; i < bufferLength / 2; i++) {
                    const barHeight = (dataArray[i] / 255) * 120;
                    const hue = 180 + (i / bufferLength) * 100;
                    const drawBar = (x: number) => {
                        const grad = ctx.createLinearGradient(x, centerY - barHeight/2, x, centerY + barHeight/2);
                        grad.addColorStop(0, `hsla(${hue}, 100%, 50%, 0)`);
                        grad.addColorStop(0.5, `hsla(${hue}, 100%, 70%, ${0.6 * mid})`);
                        grad.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
                        ctx.fillStyle = grad;
                        ctx.fillRect(x, centerY - barHeight/2, barWidth - 1, barHeight);
                    };
                    drawBar(centerX + barX);
                    drawBar(centerX - barX - barWidth);
                    barX += barWidth;
                }
                ctx.restore();
                
                particlesRef.current.forEach((p) => {
                    p.life -= 0.002;
                    if (p.life <= 0) { p.life = 1; p.x = Math.random() * canvas.width; p.y = Math.random() * canvas.height; }
                    const driftForce = (mid * 1.5) + 0.2;
                    p.vx += (Math.random() - 0.5) * driftForce; p.vy += (Math.random() - 0.5) * driftForce;
                    p.vx *= 0.98; p.vy *= 0.98; p.x += p.vx; p.y += p.vy;
                    const alpha = p.life * (0.1 + high * 0.8);
                    ctx.fillStyle = `hsla(${p.hue}, 100%, 80%, ${alpha})`;
                    if (p.type === 'data') { ctx.font = '6px monospace'; ctx.fillText(Math.random() > 0.5 ? '1' : '0', p.x, p.y); }
                    else { ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); }
                });
            }
        }
        animationRef.current = requestAnimationFrame(draw);
    };
    animationRef.current = requestAnimationFrame(draw);
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); };
  }, [isPlaying, isModuleMinimized]);

  useEffect(() => {
    if (!autoScroll) return;
    if (activeSentenceIndex !== -1 && flatSentenceMap[activeSentenceIndex]) {
        const sentenceEl = document.getElementById(`original-sent-${activeSentenceIndex}`);
        if (sentenceEl) sentenceEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  }, [activeSentenceIndex, autoScroll, flatSentenceMap]); 

  const handleInitiateToggle = async () => {
    if (isGenerating) {
        abortGenerationRef.current = true;
        setIsGenerating(false);
        setHasInitiated(true);
        return;
    }
    generatePageAudio();
  };

  const generatePageAudio = async () => {
    if (isGenerating || !flatSentenceMap.length) return;
    abortGenerationRef.current = false;
    setIsGenerating(true);
    setHasInitiated(true);
    setGenerationProgress("INIT_VOICE_CORE...");
    try {
      let sentencesToSpeak: string[] = [];
      if (audioLanguage === 'Original') {
          sentencesToSpeak = flatSentenceMap.map(m => m.text);
      } else {
          if (audioLanguage === settings.targetLanguage && paragraphData.every(p => p.translated.length > 0)) {
              sentencesToSpeak = paragraphData.flatMap(p => p.translated);
          } else {
              setGenerationProgress("AUDIO_TRANS...");
              sentencesToSpeak = await translateSentences(flatSentenceMap.map(m => m.text), audioLanguage);
          }
      }

      const batchedSentences: string[] = [];
      for (let i = 0; i < sentencesToSpeak.length; i += TTS_BATCH_SIZE) {
          batchedSentences.push(sentencesToSpeak.slice(i, i + TTS_BATCH_SIZE).join(' '));
      }

      const audioResults = await processQueue<string, string | null>(
        batchedSentences, 
        CONCURRENCY_LIMIT, 
        async (batchText, idx) => {
           if (abortGenerationRef.current) return null;
           setGenerationProgress(`PACKET_${idx + 1}_OF_${batchedSentences.length}`);
           return await generateSpeech(batchText, selectedVoice);
        },
        () => abortGenerationRef.current
      );

      if (abortGenerationRef.current) return;
      
      const audioBuffers: Uint8Array[] = [];
      const newTimings: ChunkTiming[] = [];
      let currentByteOffset = 0;
      const BYTES_PER_SEC = 48000; 

      for (let i = 0; i < audioResults.length; i++) {
        const b64 = audioResults[i];
        const startIndex = i * TTS_BATCH_SIZE;
        const endIndex = Math.min(startIndex + TTS_BATCH_SIZE, sentencesToSpeak.length);
        const batchSentencesSubset = sentencesToSpeak.slice(startIndex, endIndex);
        const sentenceCount = batchSentencesSubset.length;

        if (!b64) {
          for(let k = 0; k < sentenceCount; k++) {
              newTimings.push({ text: sentencesToSpeak[startIndex + k], start: currentByteOffset / BYTES_PER_SEC, end: currentByteOffset / BYTES_PER_SEC, isWhitespace: true });
          }
          continue;
        }

        const binaryString = atob(b64);
        const bytes = new Uint8Array(binaryString.length);
        for (let k = 0; k < binaryString.length; k++) bytes[k] = binaryString.charCodeAt(k);
        audioBuffers.push(bytes);
        
        const durationSec = bytes.length / BYTES_PER_SEC;
        const totalCharsInBatch = batchSentencesSubset.reduce((acc, s) => acc + s.length, 0);
        let batchOffset = 0;
        for (let k = 0; k < sentenceCount; k++) {
            const sText = batchSentencesSubset[k];
            const sDuration = (sText.length / (totalCharsInBatch || 1)) * durationSec;
            const startSec = (currentByteOffset / BYTES_PER_SEC) + batchOffset;
            newTimings.push({ text: sText, start: startSec, end: startSec + sDuration, isWhitespace: false });
            batchOffset += sDuration;
        }
        currentByteOffset += bytes.length;
      }
      
      const mergedBuffer = new Uint8Array(currentByteOffset);
      let offset = 0;
      for (const buf of audioBuffers) { mergedBuffer.set(buf, offset); offset += buf.length; }
      
      const blob = pcmToWav(mergedBuffer.buffer, 24000);
      const url = URL.createObjectURL(blob);
      setTimings(newTimings); 
      setAudioSrc(url); 
    } catch(e) {
      console.error(e);
      setGenerationProgress("ERR_LINK_FAILED");
    } finally { setIsGenerating(false); }
  };

  const togglePlay = async () => {
    if (!audioSrc || !audioRef.current) return;
    try {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        if (!audioContextRef.current) initAudioVisualizer();
        if (audioContextRef.current?.state === 'suspended') audioContextRef.current.resume();
        const playPromise = audioRef.current.play();
        if (playPromise !== undefined) {
          await playPromise.catch(e => { if (e.name !== 'AbortError') throw e; });
          setIsPlaying(true);
        }
      }
    } catch (err) {
      console.warn("Playback interrupted:", err);
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (audioRef.current && duration) {
       audioRef.current.currentTime = (val / 100) * duration;
    }
  };

  return (
    <div className="h-full flex flex-col gap-4 animate-fade-in relative font-sans text-zinc-100 text-left" style={{ fontFamily: settings.font ? `"${settings.font}", sans-serif` : 'inherit' }}>
      <audio 
        ref={audioRef} 
        src={audioSrc || undefined} 
        onEnded={() => setIsPlaying(false)} 
        onTimeUpdate={handleTimeUpdate}
        onPlay={() => { if(audioRef.current) audioRef.current.playbackRate = playbackRate; }}
        className="hidden" 
      />

      {/* Controller Toolbar */}
      <div className="bg-zinc-950/80 p-3 rounded-lg border border-cyan-900/40 flex items-center justify-between shrink-0 shadow-[0_0_15px_rgba(0,243,255,0.05)] w-full flex-wrap gap-2 z-20">
          <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-xs">
                 <Headphones size={18} className="text-[#00f3ff]" />
                 <span>Voice_Synth</span>
              </div>
          </div>
          <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 bg-black/50 p-1 rounded-sm border border-zinc-800">
                 <div className="p-1.5 text-zinc-500"><Settings2 size={16} /></div>
                 <select value={selectedVoice} onChange={(e) => { setSelectedVoice(e.target.value); resetAudioState(); }} className="bg-transparent text-xs text-[#00f3ff] outline-none cursor-pointer font-mono uppercase w-[120px] bg-[#050505]">
                    {VOICES.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
                 </select>
                 <div className="w-[1px] h-4 bg-zinc-700"></div>
                 <div className="p-1.5 text-zinc-500"><Globe size={16} /></div>
                 <select value={audioLanguage} onChange={(e) => { setAudioLanguage(e.target.value); resetAudioState(); }} className="bg-transparent text-xs text-[#00f3ff] outline-none font-mono uppercase w-[120px] bg-[#050505] cursor-pointer">
                    {LANGUAGES.map(lang => <option key={lang} value={lang}>{lang}</option>)}
                 </select>
              </div>
              <button 
                onClick={handleInitiateToggle} 
                className={`flex items-center gap-2 px-4 py-1.5 rounded-sm text-xs font-bold font-mono uppercase transition-all shadow-[0_0_10px_rgba(0,243,255,0.3)] min-w-[120px] justify-center ${isGenerating ? 'bg-[#ff003c] text-white hover:bg-rose-600' : 'bg-[#00f3ff] text-black hover:bg-[#00c2cc]'}`}
              >
                 {isGenerating ? <Square size={14} fill="currentColor" /> : hasInitiated ? <RefreshCw size={14} /> : <Play size={14} fill="currentColor" />}
                 {isGenerating ? "STOP" : hasInitiated ? "REGENERATE" : "INITIATE"}
              </button>
          </div>
      </div>

      {/* Advanced Visualizer Module */}
      <div className={`bg-[#0a0a0c] border border-zinc-800 rounded-lg p-0 relative overflow-hidden shrink-0 flex flex-col shadow-2xl transition-all duration-300 ease-in-out ${isModuleMinimized ? 'h-auto' : 'h-[277px]'}`}>
          {!isModuleMinimized && (
              <div className="flex-1 bg-[#010102] w-full flex items-center justify-center overflow-hidden relative group border-b border-zinc-900">
                 <div className="absolute inset-0 bg-[linear-gradient(rgba(0,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(0,255,255,0.02)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none"></div>
                 {isGenerating ? (
                    <div className="z-20 scale-75 animate-fade-in"><Loader text={generationProgress} /></div>
                 ) : audioSrc ? (
                    <>
                        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none animate-fade-in">
                            <div className="relative max-w-[85%] px-8 py-4">
                                <span className="text-sm md:text-base font-black text-[#ff003c] font-tech uppercase tracking-[0.4em] drop-shadow-[0_0_12px_rgba(255,0,60,0.8)] italic flex items-center gap-4 justify-center text-center leading-tight">
                                    <div className="w-3 h-3 rounded-full bg-[#ff003c] shadow-[0_0_10px_#ff003c] animate-pulse shrink-0"></div>
                                    AUDIO_SYNTH: PG.{String(currentPage + 1).padStart(2,'0')}
                                </span>
                            </div>
                        </div>
                        <canvas ref={canvasRef} width={1800} height={250} className="w-full h-full opacity-100" />
                    </>
                 ) : (
                    <div className="flex flex-col items-center gap-2 text-zinc-700 font-mono text-xs">
                        <Activity size={32} className="opacity-20" />
                        <span>AWAITING_HOLOGRAPHIC_DATA</span>
                    </div>
                 )}
                 <div className="absolute bottom-0 left-0 w-full h-1 bg-zinc-900 z-30 group cursor-pointer">
                    <input type="range" min="0" max="100" step="0.01" value={playbackProgress} onChange={handleSeek} disabled={!audioSrc} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-40" />
                    <div className="h-full bg-[#00f3ff] relative transition-none shadow-[0_0_10px_#00f3ff]" style={{ width: `${playbackProgress}%` }} />
                 </div>
              </div>
          )}

          <div className="bg-[#020202] p-3 flex items-center justify-between">
              <div className="flex-1 flex items-center gap-3 text-[10px] font-mono uppercase overflow-hidden">
                   {RATES.map(s => (
                     <button key={s} onClick={() => setPlaybackRate(s)} className={`transition-colors font-mono ${playbackRate === s ? 'text-[#00f3ff] font-bold underline underline-offset-4' : 'text-zinc-600 hover:text-zinc-400'}`}>{s.toFixed(2)}x</button>
                   ))}
              </div>
              <div className="flex-2 flex items-center justify-center gap-6">
                  <button onClick={() => { if(audioRef.current) audioRef.current.currentTime -= 15; }} disabled={!audioSrc} className="p-2 text-zinc-500 hover:text-cyan-400 transition-colors hover:bg-zinc-900 rounded-full disabled:opacity-30"><RotateCcw size={20} /></button>
                  <button onClick={togglePlay} disabled={!audioSrc} className={`w-10 h-10 rounded-full flex items-center justify-center border-2 ${isPlaying ? 'bg-transparent border-[#00f3ff] text-[#00f3ff] shadow-[0_0_15px_rgba(0,243,255,0.3)]' : 'bg-[#00f3ff] border-[#00f3ff] text-black shadow-[0_0_20px_rgba(0,243,255,0.6)] hover:scale-105'}`}>
                    {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-1" />}
                  </button>
                  <button onClick={() => { if(audioRef.current) audioRef.current.currentTime += 15; }} disabled={!audioSrc} className="p-2 text-zinc-500 hover:text-cyan-400 transition-colors hover:bg-zinc-900 rounded-full disabled:opacity-30"><RotateCw size={20} /></button>
              </div>
              <div className="flex-1 flex justify-end gap-2 items-center">
                  <span className="text-[10px] font-mono text-zinc-600 mr-2">{formatTime(currentTime)} / {formatTime(duration)}</span>
                  <a href={audioSrc || '#'} download={`voice-synth-pg${currentPage + 1}.wav`} className={`p-2 text-zinc-600 transition-colors rounded-full ${audioSrc ? 'hover:text-[#00f3ff] hover:bg-zinc-900' : 'opacity-30'}`} onClick={(e) => !audioSrc && e.preventDefault()}><Download size={20} /></a>
                  <button onClick={() => setIsModuleMinimized(!isModuleMinimized)} className="p-2 text-zinc-600 hover:text-[#00f3ff] transition-colors rounded-full bg-zinc-900/50">{isModuleMinimized ? <Maximize2 size={20} /> : <Minimize2 size={20} />}</button>
              </div>
          </div>
      </div>

      {isLoadingText ? (
        <div className="flex-1 flex items-center justify-center min-h-[200px]">
           <Loader text="DECODING_TEXT_BLOCK..." />
        </div>
      ) : (
        <>
           {/* Reader Mode Controls */}
           <div className="flex shrink-0 border border-zinc-800 bg-[#0a0a0c]/90 backdrop-blur-md rounded-sm z-10 w-full flex-col overflow-hidden">
              <div className="flex items-center justify-between p-2">
                   <div className="flex items-center gap-2">
                      <button onClick={() => changePage(false)} disabled={currentPage === 0} className="flex items-center justify-center w-10 py-1.5 rounded-sm bg-zinc-900 border border-zinc-800 hover:border-[#00f3ff] text-zinc-400 disabled:opacity-30 transition-all"><ChevronLeft size={14} /></button>
                      <h3 className="text-[10px] font-bold text-[#00f3ff] font-tech uppercase tracking-widest px-4">PG.{String(currentPage + 1).padStart(2,'0')}</h3>
                      <button onClick={() => changePage(true)} disabled={currentPage === pages.length - 1} className="flex items-center justify-center w-10 py-1.5 rounded-sm bg-zinc-900 border border-zinc-800 hover:border-[#00f3ff] text-zinc-400 disabled:opacity-30 transition-all"><ChevronRight size={14} /></button>
                  </div>
                  <div className="flex items-center gap-2">
                      <button onClick={() => setViewMode(viewMode === 'split' ? 'single' : 'split')} className={`flex items-center gap-2 px-4 py-1.5 rounded-sm text-[10px] font-bold font-mono uppercase transition-all min-w-[120px] justify-center ${viewMode === 'split' ? 'text-[#00f3ff] bg-[#00f3ff]/5' : 'text-zinc-500 hover:text-zinc-300'}`}><Columns size={12} /> SPLIT_VIEW</button>
                      <button onClick={() => setAutoScroll(!autoScroll)} className={`flex items-center gap-2 px-4 py-1.5 rounded-sm text-[10px] font-bold font-mono uppercase transition-all min-w-[120px] justify-center ${autoScroll ? 'text-[#00f3ff] bg-[#00f3ff]/5' : 'text-zinc-500 hover:text-zinc-300'}`}><Eye size={12} /> SYNC_TRACK</button>
                   </div>
              </div>
          </div>

          <div className="flex-1 overflow-hidden rounded-sm border border-zinc-800 bg-[#050505] relative flex flex-col hud-border text-left">
             <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-8 pb-32">
                {paragraphData.map((para, pIdx) => (
                    <div key={pIdx} className={`w-full flex ${viewMode === 'split' ? '' : 'justify-center'}`}>
                        <div className={`${viewMode === 'split' ? 'w-1/2 pr-6 border-r border-zinc-800/20' : 'w-full max-w-3xl'} ${TEXT_SIZES[settings.textSize]} ${LINE_HEIGHTS[settings.lineHeight]} ${LETTER_SPACINGS[settings.letterSpacing]} text-zinc-400 font-medium`}>
                            {para.original.map((sentence, sIdx) => {
                                const mapping = flatSentenceMap.find(m => m.pIndex === pIdx && m.sIndex === sIdx);
                                const globalIdx = mapping?.globalIndex ?? -1;
                                const isActive = autoScroll && globalIdx === activeSentenceIndex;
                                return (
                                    <span key={sIdx} id={`original-sent-${globalIdx}`} data-source="Original_Layer" className={`transition-all duration-300 px-[2px] ${isActive ? HIGHLIGHT_STYLES[settings.highlightColor] : 'hover:text-zinc-200 cursor-pointer'}`} onClick={() => { if(audioRef.current && timings[globalIdx]) { audioRef.current.currentTime = timings[globalIdx].start; togglePlay(); } }}>
                                        {sentence}{' '}
                                    </span>
                                );
                            })}
                        </div>
                        {viewMode === 'split' && (
                            <div className={`w-1/2 pl-6 ${TEXT_SIZES[settings.textSize]} ${LINE_HEIGHTS[settings.lineHeight]} ${LETTER_SPACINGS[settings.letterSpacing]} text-zinc-500 font-medium`}>
                                {isTranslating && para.translated.length === 0 ? (
                                    <span className="animate-pulse text-[10px] font-mono text-zinc-700 uppercase">Decrypting_Matrix...</span>
                                ) : (
                                    para.original.map((_, sIdx) => {
                                        const mapping = flatSentenceMap.find(m => m.pIndex === pIdx && m.sIndex === sIdx);
                                        const globalIdx = mapping?.globalIndex ?? -1;
                                        const isActive = autoScroll && globalIdx === activeSentenceIndex;
                                        const tText = para.translated[sIdx] || "";
                                        return (
                                            <span key={sIdx} data-source="Translated_Layer" className={`transition-all duration-500 px-[2px] ${isActive ? HIGHLIGHT_STYLES[settings.highlightColor] : ''}`}>
                                                {tText}{' '}
                                            </span>
                                        );
                                    })
                                )}
                            </div>
                        )}
                    </div>
                ))}
             </div>
          </div>
        </>
      )}
    </div>
  );
};
