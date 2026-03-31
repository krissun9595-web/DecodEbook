
import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, RotateCw, Mic2, Download, FileDown, Settings2, Activity, Radio, Globe, Square, Loader as LoaderIcon, AlertCircle, RefreshCw, Minimize2, Maximize2, Zap, Share2 } from 'lucide-react';
import { generatePodcastAudio } from '../services/gemini';
import { Chapter, FileContext, AppSettings } from '../types';
import { Loader } from './ui/Loader';
import { saveFile, getFile, buildCacheKey } from '../services/fileCache';

interface Props {
  chapter: Chapter;
  fileContext: FileContext;
  settings: AppSettings;
  bookId: string;
}

interface ScriptSegment {
  speaker: string;
  text: string;
  startPct: number;
  endPct: number;
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

const TONES = ['Engaging', 'Aggressive', 'Incisive', 'Humorous', 'Instructive', 'Cyber-Noir', 'Sarcastic', 'Philosophical', 'Debate', 'Street-Samurai', 'Corpo-Rat', 'Netrunner'];

const LANGUAGES = [
  'Original', 'Arabic', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Dutch', 'English', 'French', 'German', 'Hindi', 'Indonesian', 'Italian', 'Japanese', 'Korean', 'Polish', 'Portuguese', 'Russian', 'Spanish', 'Swedish', 'Thai', 'Turkish', 'Vietnamese'
];

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

// Module-level store for in-flight podcast generation.
// Survives component unmount/remount so generation isn't lost on tab switch.
interface InFlightPodcast {
  promise: Promise<{ audioBlob: Blob; script: string; episodeTitle: string } | null>;
  abort: () => void;
}
const inflightPodcastMap = new Map<string, InFlightPodcast>();

const HOST_CONFIG: Record<string, { host1: string, voice1: string, host2: string, voice2: string }> = {
  'Engaging': { host1: 'Alex', voice1: 'Puck', host2: 'Jordan', voice2: 'Kore' },
  'Aggressive': { host1: 'Titan', voice1: 'Fenrir', host2: 'Viper', voice2: 'Charon' },
  'Incisive': { host1: 'Cipher', voice1: 'Puck', host2: 'Oracle', voice2: 'Kore' },
  'Humorous': { host1: 'Jester', voice1: 'Fenrir', host2: 'Pixel', voice2: 'Puck' },
  'Instructive': { host1: 'Professor', voice1: 'Kore', host2: 'Student', voice2: 'Zephyr' },
  'Cyber-Noir': { host1: 'Detective', voice1: 'Fenrir', host2: 'Client', voice2: 'Kore' },
  'Sarcastic': { host1: 'Glitch', voice1: 'Puck', host2: 'System', voice2: 'Kore' },
  'Philosophical': { host1: 'Sage', voice1: 'Charon', host2: 'Seeker', voice2: 'Zephyr' },
  'Debate': { host1: 'Pro', voice1: 'Puck', host2: 'Con', voice2: 'Fenrir' },
  'Street-Samurai': { host1: 'Ronin', voice1: 'Fenrir', host2: 'Katana', voice2: 'Kore' },
  'Corpo-Rat': { host1: 'Exec', voice1: 'Charon', host2: 'Assistant', voice2: 'Puck' },
  'Netrunner': { host1: 'Zero', voice1: 'Puck', host2: 'One', voice2: 'Kore' },
};

export const PodcastPlayer: React.FC<Props> = ({ chapter, fileContext, settings, bookId }) => {
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [episodeTitle, setEpisodeTitle] = useState<string>('');
  const [script, setScript] = useState<string | null>(null);
  const [segments, setSegments] = useState<ScriptSegment[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [hasInitiated, setHasInitiated] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTone, setSelectedTone] = useState('Engaging');
  const [selectedLanguage, setSelectedLanguage] = useState(settings.targetLanguage);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isPlayerMinimized, setIsPlayerMinimized] = useState(false);
  
  // Progress State
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackProgress, setPlaybackProgress] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scriptContainerRef = useRef<HTMLDivElement | null>(null);
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);
  const animationRef = useRef<number | null>(null);
  const abortRef = useRef<boolean>(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const particlesRef = useRef<QuantumParticle[]>([]);

  const hosts = HOST_CONFIG[selectedTone] || HOST_CONFIG['Engaging'];
  const podcastGenKeyRef = useRef('');

  useEffect(() => {
    if (!script) {
      setSegments([]);
      return;
    }
    const lines = script.split('\n').map(l => l.replace(/^\*\*|\*\*$/g, '').trim()).filter(line => line.length > 0);
    const parsed: ScriptSegment[] = [];
    let accumulatedChars = 0;
    const validLines = lines.map(line => {
      const splitIdx = line.indexOf(':');
      if (splitIdx === -1) return null;
      const speaker = line.substring(0, splitIdx).trim();
      const text = line.substring(splitIdx + 1).trim();
      return { speaker, text };
    }).filter(l => l !== null) as { speaker: string, text: string }[];
    const totalChars = validLines.reduce((acc, l) => acc + l.text.length, 0);
    validLines.forEach(l => {
      const startPct = accumulatedChars / (totalChars || 1);
      accumulatedChars += l.text.length;
      const endPct = accumulatedChars / (totalChars || 1);
      parsed.push({ speaker: l.speaker, text: l.text, startPct, endPct });
    });
    setSegments(parsed);
  }, [script]);

  const pcmToWavBlob = (base64: string): Blob => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const buffer = new ArrayBuffer(44 + len);
    const view = new DataView(buffer);
    const writeString = (v: DataView, o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + len, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 24000, true);
    view.setUint32(28, 48000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, len, true);
    const bytes = new Uint8Array(buffer, 44);
    for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
    return new Blob([buffer], { type: 'audio/wav' });
  };

  // On mount: check cache, then check for in-flight generation
  useEffect(() => {
    let cancelled = false;
    const key = buildCacheKey(bookId, chapter.id, 'podcast-audio', selectedTone, selectedLanguage);
    podcastGenKeyRef.current = key;

    const load = async () => {
      // 1. Try loading from cache
      const audioKey = key;
      const scriptKey = buildCacheKey(bookId, chapter.id, 'podcast-script', selectedTone, selectedLanguage);
      try {
        const [cachedAudio, cachedScript] = await Promise.all([getFile(audioKey), getFile(scriptKey)]);
        if (cachedAudio && cachedScript && !cancelled) {
          setAudioSrc(URL.createObjectURL(cachedAudio.blob));
          setScript(await cachedScript.blob.text());
          setHasInitiated(true);
          return;
        }
      } catch (e) { /* cache miss */ }

      // 2. Re-attach to in-flight generation if one exists
      const inflight = inflightPodcastMap.get(key);
      if (inflight && !cancelled) {
        setIsLoading(true);
        setHasInitiated(true);
        try {
          const result = await inflight.promise;
          if (cancelled || podcastGenKeyRef.current !== key) return;
          if (result) {
            setAudioSrc(URL.createObjectURL(result.audioBlob));
            setScript(result.script);
            setEpisodeTitle(result.episodeTitle);
            setActiveIndex(-1);
          }
        } catch (e: any) {
          if (!cancelled) setError(e.message || "Failed to generate podcast.");
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      }
    };

    if (!isLoading && !audioSrc) load();
    return () => { cancelled = true; };
  }, [bookId, chapter.id, selectedTone, selectedLanguage]);

  const handleToggleGeneration = async () => {
    if (isLoading) {
      abortRef.current = true;
      const key = podcastGenKeyRef.current;
      const inflight = inflightPodcastMap.get(key);
      if (inflight) inflight.abort();
      inflightPodcastMap.delete(key);
      setIsLoading(false);
      setHasInitiated(true);
      return;
    }

    const genKey = buildCacheKey(bookId, chapter.id, 'podcast-audio', selectedTone, selectedLanguage);
    podcastGenKeyRef.current = genKey;

    // If already in-flight, don't start another
    if (inflightPodcastMap.has(genKey)) return;

    setIsLoading(true);
    setHasInitiated(true);
    setError(null);
    abortRef.current = false;

    // Capture values for the closure (survives unmount)
    const capturedFileContext = fileContext;
    const capturedChapter = chapter;
    const capturedTone = selectedTone;
    const capturedHosts = hosts;
    const capturedLanguage = selectedLanguage;
    const capturedBookId = bookId;

    const genPromise = (async (): Promise<{ audioBlob: Blob; script: string; episodeTitle: string } | null> => {
      try {
        const targetLang = capturedLanguage === 'Original' ? 'the source language of the document' : capturedLanguage;
        const result = await generatePodcastAudio(capturedFileContext, capturedChapter, capturedTone, capturedHosts, targetLang);
        if (abortRef.current) return null;
        const audioBlob = pcmToWavBlob(result.audio);

        // Cache results (runs even if component is unmounted)
        const audioCacheKey = buildCacheKey(capturedBookId, capturedChapter.id, 'podcast-audio', capturedTone, capturedLanguage);
        saveFile(audioCacheKey, audioBlob, {
          filename: `podcast-${capturedChapter.id}.wav`,
          mimeType: 'audio/wav',
          timestamp: Date.now(),
          bookId: capturedBookId,
          chapterId: capturedChapter.id,
          componentSource: 'podcast',
          fileType: 'podcast-audio',
        }).catch(e => console.warn('Cache save failed:', e));
        const scriptBlob = new Blob([result.script], { type: 'text/plain' });
        const scriptCacheKey = buildCacheKey(capturedBookId, capturedChapter.id, 'podcast-script', capturedTone, capturedLanguage);
        saveFile(scriptCacheKey, scriptBlob, {
          filename: `podcast-script-${capturedChapter.id}.txt`,
          mimeType: 'text/plain',
          timestamp: Date.now(),
          bookId: capturedBookId,
          chapterId: capturedChapter.id,
          componentSource: 'podcast',
          fileType: 'podcast-script',
        }).catch(e => console.warn('Cache save failed:', e));

        return { audioBlob, script: result.script, episodeTitle: result.episodeTitle || capturedChapter.title };
      } catch (e) {
        console.error(e);
        throw e;
      } finally {
        inflightPodcastMap.delete(genKey);
      }
    })();

    inflightPodcastMap.set(genKey, { promise: genPromise, abort: () => { abortRef.current = true; } });

    try {
      const result = await genPromise;
      if (podcastGenKeyRef.current === genKey && result) {
        setAudioSrc(URL.createObjectURL(result.audioBlob));
        setScript(result.script);
        setEpisodeTitle(result.episodeTitle);
        setActiveIndex(-1);
      }
    } catch (e: any) {
      if (!abortRef.current) {
        setError(e.message || "Failed to generate podcast.");
      }
    } finally {
      if (!abortRef.current && podcastGenKeyRef.current === genKey) {
        setIsLoading(false);
      }
    }
  };

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      if (!audioContextRef.current) initAudioVisualizer();
      if (audioContextRef.current?.state === 'suspended') audioContextRef.current.resume();
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

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
      const particleCount = 250;
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

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      const audio = audioRef.current;
      setCurrentTime(audio.currentTime);
      setDuration(audio.duration || 0);
      setPlaybackProgress(audio.duration > 0 ? (audio.currentTime / audio.duration) * 100 : 0);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (audioRef.current && duration) {
      audioRef.current.currentTime = (val / 100) * duration;
    }
  };

  const formatTime = (seconds: number): string => {
    if (!seconds || isNaN(seconds)) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, audioSrc]);

  useEffect(() => {
    if (!isPlaying || !audioRef.current) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      return;
    }
    const audio = audioRef.current;
    
    const draw = () => {
      if (audio && audio.duration) {
        const currentPct = audio.currentTime / audio.duration;
        const index = segments.findIndex(s => currentPct >= s.startPct && currentPct < s.endPct);
        if (index !== -1 && index !== activeIndex) {
          setActiveIndex(index);
          segmentRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
      
      if (canvasRef.current && analyserRef.current && !isPlayerMinimized) {
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
          const waveCount = 3;
          for (let w = 0; w < waveCount; w++) {
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
            ctx.shadowBlur = 10 * bass;
            ctx.shadowColor = `rgba(0, 243, 255, 0.8)`;
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
          
          particlesRef.current.forEach((p, i) => {
            p.life -= 0.002;
            if (p.life <= 0) {
                p.life = 1;
                p.x = Math.random() * canvas.width;
                p.y = Math.random() * canvas.height;
            }
            const driftForce = (mid * 1.5) + 0.2;
            p.vx += (Math.random() - 0.5) * driftForce;
            p.vy += (Math.random() - 0.5) * driftForce;
            p.vx *= 0.98;
            p.vy *= 0.98;
            p.x += p.vx;
            p.y += p.vy;
            const alpha = p.life * (0.1 + high * 0.8);
            ctx.fillStyle = `hsla(${p.hue}, 100%, 80%, ${alpha})`;
            if (p.type === 'data') {
                ctx.font = '6px monospace';
                ctx.fillText(Math.random() > 0.5 ? '1' : '0', p.x, p.y);
            } else if (p.type === 'shimmer') {
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * (1 + high * 4), 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
            }
          });
          const coreSize = 30 + (bass * 60);
          const coreGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, coreSize);
          coreGradient.addColorStop(0, `rgba(255, 255, 255, ${0.4 * bass})`);
          coreGradient.addColorStop(0.3, `rgba(0, 243, 255, ${0.2 * mid})`);
          coreGradient.addColorStop(1, 'transparent');
          ctx.fillStyle = coreGradient;
          ctx.beginPath();
          ctx.arc(centerX, centerY, coreSize, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      animationRef.current = requestAnimationFrame(draw);
    };
    draw();
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); };
  }, [isPlaying, segments, activeIndex, isPlayerMinimized]);

  const downloadScript = () => {
    if (!script) return;
    const blob = new Blob([script], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `podcast-script-${chapter.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col font-sans text-zinc-100 overflow-hidden text-left">
       <div className="bg-zinc-950/80 p-3 rounded-lg border border-cyan-900/40 mb-4 flex items-center justify-between shrink-0 shadow-[0_0_15px_rgba(0,243,255,0.05)] w-full flex-wrap gap-2">
          <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-xs">
                 <Mic2 size={18} className="text-[#00f3ff]" />
                 <span>Neural_Podcast</span>
              </div>
          </div>
          <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 bg-black/50 p-1 rounded-sm border border-zinc-800">
                 <div className="p-1.5 text-zinc-500"><Settings2 size={16} /></div>
                 <select value={selectedTone} onChange={(e) => setSelectedTone(e.target.value)} className="bg-transparent text-xs text-[#00f3ff] outline-none cursor-pointer font-mono uppercase w-[120px] bg-[#050505]">{TONES.map(t => <option key={t} value={t}>{t}</option>)}</select>
                 <div className="w-[1px] h-4 bg-zinc-700"></div>
                 <div className="p-1.5 text-zinc-500"><Globe size={16} /></div>
                 <select value={selectedLanguage} onChange={(e) => setSelectedLanguage(e.target.value)} className="bg-transparent text-xs text-[#00f3ff] outline-none cursor-pointer font-mono uppercase w-[120px] bg-[#050505]">{LANGUAGES.map(lang => <option key={lang} value={lang}>{lang}</option>)}</select>
              </div>
              <button 
                onClick={handleToggleGeneration} 
                className={`flex items-center gap-2 px-4 py-1.5 rounded-sm text-xs font-bold font-mono uppercase transition-all shadow-[0_0_10px_rgba(0,243,255,0.3)] min-w-[120px] justify-center ${isLoading ? 'bg-[#ff003c] text-white hover:bg-rose-600' : 'bg-[#00f3ff] text-black hover:bg-[#00c2cc]'}`}
              >
                 {isLoading ? <Square size={14} fill="currentColor" /> : hasInitiated ? <RefreshCw size={14} /> : <Play size={14} fill="currentColor" />}
                 {isLoading ? "STOP" : hasInitiated ? "REGENERATE" : "INITIATE"}
              </button>
          </div>
       </div>

       <div className="flex-1 flex flex-col gap-4 overflow-hidden w-full">
           <div className={`bg-[#0a0a0c] border border-zinc-800 rounded-lg p-0 relative overflow-hidden shrink-0 flex flex-col shadow-2xl transition-all duration-300 ease-in-out ${isPlayerMinimized ? 'h-auto' : 'h-[277px]'}`}>
               {!isPlayerMinimized && (
                   <div className="flex-1 bg-[#010102] w-full flex items-center justify-center overflow-hidden relative group border-b border-zinc-900">
                      <div className="absolute inset-0 bg-[linear-gradient(rgba(0,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(0,255,255,0.02)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none"></div>
                      
                      {audioSrc && !isLoading && episodeTitle && (
                        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none animate-fade-in">
                            <div className="relative max-w-[85%] px-8 py-4">
                               <span className="text-sm md:text-base font-black text-[#ff003c] font-tech uppercase tracking-[0.4em] drop-shadow-[0_0_12px_rgba(255,0,60,0.8)] italic flex items-center gap-4 justify-center text-center leading-tight">
                                  <div className="w-3 h-3 rounded-full bg-[#ff003c] shadow-[0_0_10px_#ff003c] animate-pulse shrink-0"></div>
                                  {episodeTitle.toUpperCase()}
                               </span>
                            </div>
                        </div>
                      )}

                      {isLoading ? (
                        <div className="z-20 scale-75 animate-fade-in">
                          <Loader text="DECODING_NEURAL_STREAM..." />
                        </div>
                      ) : audioSrc ? (
                        <canvas ref={canvasRef} width={1800} height={250} className="w-full h-full opacity-100" />
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-zinc-700 font-mono text-xs">
                          <Activity size={32} className="opacity-20" />
                          <span>AWAITING_HOLOGRAPHIC_DATA</span>
                        </div>
                      )}

                      {/* Progress Bar Overlay */}
                      <div className="absolute bottom-0 left-0 w-full h-1 bg-zinc-900 z-30 group cursor-pointer">
                        <input 
                          type="range" min="0" max="100" step="0.01" 
                          value={playbackProgress} onChange={handleSeek} 
                          disabled={!audioSrc} 
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-40" 
                        />
                        <div className="h-full bg-[#00f3ff] relative transition-none shadow-[0_0_10px_#00f3ff]" style={{ width: `${playbackProgress}%` }} />
                      </div>
                   </div>
               )}
               <div className="bg-[#020202] p-3 flex items-center justify-between">
                   <div className="flex-1 flex items-center gap-3 text-[10px] font-mono uppercase overflow-hidden">
                        {SPEEDS.map(s => (
                          <button 
                            key={s} 
                            onClick={() => setPlaybackRate(s)} 
                            className={`transition-colors font-mono ${playbackRate === s ? 'text-[#00f3ff] font-bold underline underline-offset-4' : 'text-zinc-600 hover:text-zinc-400'}`}
                          >
                            {s.toFixed(2)}x
                          </button>
                        ))}
                   </div>
                   <div className="flex-2 flex items-center justify-center gap-6">
                       <button onClick={() => { if(audioRef.current) audioRef.current.currentTime -= 15; }} disabled={!audioSrc} className="p-2 text-zinc-500 hover:text-cyan-400 transition-colors hover:bg-zinc-900 rounded-full disabled:opacity-30"><RotateCcw size={20} /></button>
                       <button onClick={togglePlay} disabled={!audioSrc} className={`w-10 h-10 rounded-full transition-all flex items-center justify-center border-2 ${isPlaying ? 'bg-transparent border-[#00f3ff] text-[#00f3ff] shadow-[0_0_15px_rgba(0,243,255,0.3)]' : 'bg-[#00f3ff] border-[#00f3ff] text-black shadow-[0_0_20px_rgba(0,243,255,0.6)] hover:scale-105'}`}>{isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-1" />}</button>
                       <button onClick={() => { if(audioRef.current) audioRef.current.currentTime += 15; }} disabled={!audioSrc} className="p-2 text-zinc-500 hover:text-cyan-400 transition-colors hover:bg-zinc-900 rounded-full disabled:opacity-30"><RotateCw size={20} /></button>
                   </div>
                   <div className="flex-1 flex justify-end gap-2 items-center">
                       <span className="text-[10px] font-mono text-zinc-600 mr-2">{formatTime(currentTime)} / {formatTime(duration)}</span>
                       <button onClick={downloadScript} disabled={!script} className={`p-2 text-zinc-600 transition-colors rounded-full ${script ? 'hover:text-[#00f3ff] hover:bg-zinc-900' : 'opacity-30'}`} title="Download Script"><FileDown size={20} /></button>
                       <a href={audioSrc || '#'} download={`podcast-${chapter.id}.wav`} className={`p-2 text-zinc-600 transition-colors rounded-full ${audioSrc ? 'hover:text-[#ff003c] hover:bg-zinc-900' : 'opacity-30'}`} onClick={(e) => !audioSrc && e.preventDefault()} title="Download Audio"><Download size={20} /></a>
                       <button onClick={() => setIsPlayerMinimized(!isPlayerMinimized)} className="p-2 text-zinc-600 hover:text-[#00f3ff] transition-colors rounded-full bg-zinc-900/50" title={isPlayerMinimized ? "Expand Player" : "Minimize Player"}>{isPlayerMinimized ? <Maximize2 size={20} /> : <Minimize2 size={20} />}</button>
                   </div>
               </div>
           </div>
           <audio 
             ref={audioRef} 
             src={audioSrc || undefined} 
             onEnded={() => setIsPlaying(false)} 
             onPlay={() => { if(audioRef.current) audioRef.current.playbackRate = playbackRate; }}
             onTimeUpdate={handleTimeUpdate}
             onLoadedMetadata={handleTimeUpdate}
             className="hidden" 
           />
           {segments.length > 0 ? (
               <div className="flex-1 min-h-0 bg-black/40 border border-zinc-800 rounded-lg overflow-hidden flex flex-col shadow-inner">
                  <div ref={scriptContainerRef} className="flex-1 overflow-y-auto p-6 space-y-8 scroll-smooth custom-scrollbar font-mono text-sm">
                    {segments.map((seg, idx) => {
                      const isActive = idx === activeIndex;
                      const h1 = hosts.host1.toUpperCase();
                      const h2 = hosts.host2.toUpperCase();
                      const cur = seg.speaker.toUpperCase();
                      const leftAligned = cur === h1 || cur.includes(h1);
                      return (
                        <div key={idx} ref={el => { segmentRefs.current[idx] = el; }} className={`flex w-full ${leftAligned ? 'justify-start' : 'justify-end'} animate-fade-in`}>
                            <div className={`relative max-w-[85%] rounded-sm p-4 pt-5 border transition-all duration-300 ${isActive ? (leftAligned ? 'bg-cyan-950/20 border-cyan-500 shadow-[0_0_20px_rgba(6,182,212,0.3)] scale-[1.02]' : 'bg-rose-950/20 border-[#ff003c] shadow-[0_0_20px_rgba(255,0,60,0.3)] scale-[1.02]') : 'bg-zinc-900/30 border-zinc-800 hover:border-zinc-700'}`}>
                                <div className={`absolute -top-2.5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border ${leftAligned ? 'left-4 bg-cyan-900 border-cyan-500/50 text-cyan-200' : 'right-4 bg-rose-900 border-[#ff003c]/50 text-rose-200'}`}>{seg.speaker}</div>
                                <p className={`leading-relaxed transition-colors duration-300 ${isActive ? 'text-white font-medium' : 'text-zinc-400'}`}>{seg.text}</p>
                                {isActive && <div className={`absolute top-1/2 -translate-y-1/2 w-1.5 h-1/2 rounded-full ${leftAligned ? '-left-0.5 bg-cyan-500 shadow-[0_0_10px_#00f3ff]' : '-right-0.5 bg-[#ff003c] shadow-[0_0_10px_#ff003c]'}`}></div>}
                            </div>
                        </div>
                      );
                    })}
                  </div>
               </div>
           ) : !isLoading && !error && (
               <div className="flex-1 bg-black/40 border border-dashed border-zinc-800 rounded-lg flex flex-col items-center justify-center text-zinc-600 gap-4 font-mono min-h-[200px]">
                   <Radio size={48} className="opacity-20 animate-pulse" />
                   <div className="text-center space-y-1">
                      <p className="text-xs uppercase tracking-[0.3em]">Ready_to_Stream</p>
                      <p className="text-[10px] opacity-50">Select tone and language above to begin decoding</p>
                   </div>
               </div>
           )}
           {error && (
               <div className="flex-1 bg-rose-950/10 border border-rose-900/30 rounded-lg flex flex-col items-center justify-center text-rose-500 p-8 text-center font-mono min-h-[200px]">
                   <AlertCircle size={32} className="mb-4" />
                   <p className="text-xs font-bold uppercase mb-2">Signal_Lost</p>
                   <p className="text-[10px] max-w-sm mb-6">{error}</p>
                   <button onClick={handleToggleGeneration} className="px-6 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-sm text-xs font-bold transition-all uppercase tracking-widest">Retry_Connection</button>
               </div>
           )}
       </div>
    </div>
  );
};
