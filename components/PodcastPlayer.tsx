
import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, RotateCw, Mic2, Download, FileDown, Settings2, Activity, Radio, Globe, Square, Loader as LoaderIcon, AlertCircle, RefreshCw, Minimize2, Maximize2, Zap, Share2 } from 'lucide-react';
import { generatePodcastAudio } from '../services/gemini';
import { Chapter, FileContext, AppSettings } from '../types';
import { Loader } from './ui/Loader';
import { saveFile, getFile, buildCacheKey } from '../services/fileCache';
import { shareFile } from '../utils/share';
import { titleCase } from '../utils/filename';
import { trackGeneration, trackShare, trackError } from '../utils/analytics';

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
// Last playback position per podcast (cache key), so leaving and returning to the
// net_cast resumes where the user left off instead of resetting the progress bar.
const podcastPlaybackPositions = new Map<string, number>();

// Persist user selections across unmount/remount
let lastPodcastTone: string | null = null;
let lastPodcastLanguage: string | null = null;
let lastEpisodeTitle: string | null = null;
let lastPodcastPlayerMinimized: boolean | null = null;

const readStoredValue = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStoredValue = (key: string, value: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures; in-memory defaults still work for this session.
  }
};

const initialPodcastLanguage = (): string => {
  if (lastPodcastLanguage) return lastPodcastLanguage;
  const stored = readStoredValue('podcast_language');
  lastPodcastLanguage = stored || 'Original';
  return lastPodcastLanguage;
};

const initialPodcastPlayerMinimized = (): boolean => {
  if (lastPodcastPlayerMinimized !== null) return lastPodcastPlayerMinimized;
  const stored = readStoredValue('podcast_player_minimized');
  lastPodcastPlayerMinimized = stored === null ? true : stored !== 'false';
  return lastPodcastPlayerMinimized;
};

const HOST_CONFIG: Record<string, { host1: string, voice1: string, desc1: string, host2: string, voice2: string, desc2: string }> = {
  'Engaging': { host1: 'Alex', voice1: 'Puck', desc1: 'warm male narrator, curious and enthusiastic', host2: 'Jordan', voice2: 'Kore', desc2: 'sharp female analyst, adds depth and counterpoints' },
  'Aggressive': { host1: 'Titan', voice1: 'Fenrir', desc1: 'intense male commander, speaks with raw energy', host2: 'Viper', voice2: 'Kore', desc2: 'calculating female operative, cold precision in every word' },
  'Incisive': { host1: 'Cipher', voice1: 'Puck', desc1: 'quick-witted male investigator, asks piercing questions', host2: 'Oracle', voice2: 'Kore', desc2: 'all-knowing female oracle, delivers insights melodically' },
  'Humorous': { host1: 'Jester', voice1: 'Fenrir', desc1: 'bold male comedian, delivers punchlines with gravel voice', host2: 'Pixel', voice2: 'Kore', desc2: 'witty female sidekick, quick comebacks and wordplay' },
  'Instructive': { host1: 'Professor', voice1: 'Charon', desc1: 'authoritative male professor, explains with deep resonant voice', host2: 'Student', voice2: 'Zephyr', desc2: 'eager female learner, asks thoughtful questions softly' },
  'Cyber-Noir': { host1: 'Detective', voice1: 'Fenrir', desc1: 'gruff male private eye, speaks in short hard-boiled sentences', host2: 'Client', voice2: 'Kore', desc2: 'mysterious female informant, speaks smoothly with hidden motives' },
  'Sarcastic': { host1: 'Glitch', voice1: 'Puck', desc1: 'sardonic male hacker, dripping with irony', host2: 'System', voice2: 'Kore', desc2: 'deadpan female AI, responds literally to sarcasm' },
  'Philosophical': { host1: 'Sage', voice1: 'Charon', desc1: 'deep-voiced male elder, speaks in measured profound statements', host2: 'Seeker', voice2: 'Zephyr', desc2: 'gentle female questioner, probes with calm curiosity' },
  'Debate': { host1: 'Pro', voice1: 'Puck', desc1: 'confident male advocate, builds arguments persuasively', host2: 'Con', voice2: 'Kore', desc2: 'fierce female challenger, dismantles arguments with eloquence' },
  'Street-Samurai': { host1: 'Ronin', voice1: 'Fenrir', desc1: 'battle-hardened male warrior, speaks with gruff authority', host2: 'Katana', voice2: 'Kore', desc2: 'elegant female strategist, precise and melodic' },
  'Corpo-Rat': { host1: 'Exec', voice1: 'Charon', desc1: 'deep-voiced male executive, speaks with boardroom authority', host2: 'Assistant', voice2: 'Kore', desc2: 'sharp female corporate climber, energetic and agreeable' },
  'Netrunner': { host1: 'Zero', voice1: 'Puck', desc1: 'fast-talking male hacker, excited about data', host2: 'One', voice2: 'Kore', desc2: 'cool female AI companion, responds with smooth precision' },
};

export const PodcastPlayer: React.FC<Props> = ({ chapter, fileContext, bookId }) => {
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [episodeTitle, setEpisodeTitle] = useState<string>(lastEpisodeTitle || '');
  const [script, setScript] = useState<string | null>(null);
  const [segments, setSegments] = useState<ScriptSegment[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [hasInitiated, setHasInitiated] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTone, setSelectedTone] = useState(lastPodcastTone || 'Engaging');
  const [selectedLanguage, setSelectedLanguage] = useState(initialPodcastLanguage);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isPlayerMinimized, setIsPlayerMinimized] = useState(initialPodcastPlayerMinimized);
  
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
    const h1 = hosts.host1;
    const h2 = hosts.host2;
    const speakerPattern = new RegExp(`(?:^|\\n)\\s*\\**(?:${h1}|${h2})\\**\\s*:`, 'gi');

    let validLines: { speaker: string; text: string }[] = [];
    const matches = [...script.matchAll(new RegExp(`(?:^|\\n)\\s*\\**(?:(${h1})|(${h2}))\\**\\s*:\\s*`, 'gi'))];

    if (matches.length > 0) {
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const speaker = (m[1] || m[2]).trim();
        const start = m.index! + m[0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index! : script.length;
        const text = script.substring(start, end).replace(/^\*\*|\*\*$/g, '').replace(/\n/g, ' ').trim();
        if (text) validLines.push({ speaker, text });
      }
    } else {
      // Fallback: parse any "Name: text" lines and map first two unique speakers to h1/h2
      const lines = script.split('\n').map(l => l.replace(/^\*\*|\*\*$/g, '').trim()).filter(l => l.length > 0);
      const speakerSet = new Set<string>();
      const rawLines: { speaker: string; text: string }[] = [];
      for (const line of lines) {
        const splitIdx = line.indexOf(':');
        if (splitIdx === -1 || splitIdx > 30) continue;
        const speaker = line.substring(0, splitIdx).trim();
        const text = line.substring(splitIdx + 1).trim();
        if (!text) continue;
        speakerSet.add(speaker.toUpperCase());
        rawLines.push({ speaker, text });
      }
      // Map detected speakers to current host names for alignment
      const uniqueSpeakers = [...speakerSet];
      const speakerMap = new Map<string, string>();
      if (uniqueSpeakers.length >= 2) {
        speakerMap.set(uniqueSpeakers[0], h1);
        speakerMap.set(uniqueSpeakers[1], h2);
      }
      validLines = rawLines.map(l => ({
        speaker: speakerMap.get(l.speaker.toUpperCase()) || l.speaker,
        text: l.text,
      }));
    }

    const parsed: ScriptSegment[] = [];
    let accumulatedChars = 0;
    const totalChars = validLines.reduce((acc, l) => acc + l.text.length, 0);
    validLines.forEach(l => {
      const startPct = accumulatedChars / (totalChars || 1);
      accumulatedChars += l.text.length;
      const endPct = accumulatedChars / (totalChars || 1);
      parsed.push({ speaker: l.speaker, text: l.text, startPct, endPct });
    });
    setSegments(parsed);
  }, [script, hosts.host1, hosts.host2]);

  const pcmToWavBlob = (base64: string): Blob => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;

    // Decode 16-bit PCM samples, find peak, and normalize
    const sampleCount = Math.floor(len / 2);
    const samples = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = binaryString.charCodeAt(i * 2) | (binaryString.charCodeAt(i * 2 + 1) << 8);
    }
    let peak = 0;
    for (let i = 0; i < sampleCount; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > peak) peak = abs;
    }
    // Normalize to 90% of max if peak is too low (below 50% of max)
    if (peak > 0 && peak < 16384) {
      const gain = (32767 * 0.9) / peak;
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * gain)));
      }
    }

    const normalizedLen = sampleCount * 2;
    const buffer = new ArrayBuffer(44 + normalizedLen);
    const view = new DataView(buffer);
    const writeString = (v: DataView, o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + normalizedLen, true);
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
    view.setUint32(40, normalizedLen, true);
    const outBytes = new Uint8Array(buffer, 44);
    const sampleBytes = new Uint8Array(samples.buffer);
    outBytes.set(sampleBytes);
    return new Blob([buffer], { type: 'audio/wav' });
  };

  // On mount: check cache, then check for in-flight generation
  useEffect(() => {
    let cancelled = false;
    const key = buildCacheKey(bookId, chapter.id, 'podcast-audio', selectedTone, selectedLanguage);
    podcastGenKeyRef.current = key;

    // Clear previous state so old script with different host names doesn't linger
    setScript(null);
    setSegments([]);
    setActiveIndex(-1);
    if (audioSrc) { URL.revokeObjectURL(audioSrc); setAudioSrc(null); }

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
            setEpisodeTitle(result.episodeTitle); lastEpisodeTitle = result.episodeTitle;
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
          filename: `podcast-ch${capturedChapter.id}-${titleCase(capturedTone, 20)}-${capturedHosts.host1}&${capturedHosts.host2}-${titleCase(capturedChapter.title)}.wav`,
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
          filename: `script-ch${capturedChapter.id}-${titleCase(capturedTone, 20)}-${capturedHosts.host1}&${capturedHosts.host2}-${titleCase(capturedChapter.title)}.txt`,
          mimeType: 'text/plain',
          timestamp: Date.now(),
          bookId: capturedBookId,
          chapterId: capturedChapter.id,
          componentSource: 'podcast',
          fileType: 'podcast-script',
        }).catch(e => console.warn('Cache save failed:', e));

        trackGeneration({ bookId: capturedBookId, chapterIndex: capturedChapter.id, module: 'podcast', provider: 'gemini', inputChars: capturedChapter.content?.length || 0 });
        return { audioBlob, script: result.script, episodeTitle: result.episodeTitle || capturedChapter.title };
      } catch (e: any) {
        console.error(e);
        trackGeneration({ bookId: capturedBookId, chapterIndex: capturedChapter.id, module: 'podcast', status: 'failed', errorMessage: e?.message });
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
        setEpisodeTitle(result.episodeTitle); lastEpisodeTitle = result.episodeTitle;
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
      if (podcastGenKeyRef.current && audio.currentTime > 0.1) {
        podcastPlaybackPositions.set(podcastGenKeyRef.current, audio.currentTime);
      }
    }
  };

  // Restore the saved position when the audio (re)loads, so returning to the net_cast
  // doesn't lose progress.
  const handleLoadedMetadata = () => {
    if (!audioRef.current) return;
    const d = audioRef.current.duration || 0;
    const saved = podcastGenKeyRef.current ? podcastPlaybackPositions.get(podcastGenKeyRef.current) : undefined;
    if (saved !== undefined && saved > 0.1 && saved < d - 0.1) {
      audioRef.current.currentTime = saved;
    }
    handleTimeUpdate();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (audioRef.current && duration) {
      audioRef.current.currentTime = (val / 100) * duration;
    }
  };

  const seekToSegment = async (idx: number) => {
    if (!audioRef.current || !duration || idx < 0 || idx >= segments.length) return;
    const targetTime = segments[idx].startPct * duration;
    audioRef.current.currentTime = targetTime;
    setActiveIndex(idx);
    if (!isPlaying) {
      if (!audioContextRef.current) initAudioVisualizer();
      if (audioContextRef.current?.state === 'suspended') audioContextRef.current.resume();
      try { await audioRef.current.play(); setIsPlaying(true); } catch (e) { /* ignore */ }
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
    const fn = `script-ch${chapter.id}-${titleCase(selectedTone, 20)}-${hosts.host1}&${hosts.host2}-${titleCase(chapter.title)}.txt`;
    a.download = fn;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col font-sans text-zinc-100 overflow-hidden text-left">
       <div className="hud-panel mb-1.5 md:mb-2 flex items-center justify-between shrink-0 w-full flex-wrap gap-2">
          <div className="hidden md:flex items-center gap-4">
              <div className="flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-[11px]">
                 <Mic2 size={16} className="text-neon-cyan" />
                 <span>Neural_Podcast</span>
              </div>
          </div>
          <div className="flex items-center gap-2 md:gap-3 flex-1 md:flex-none justify-between md:justify-end">
              <div className="select-group">
                 <div className="p-1 md:p-1.5 text-zinc-500"><Settings2 size={13} /></div>
                 <select value={selectedTone} onChange={(e) => { setSelectedTone(e.target.value); lastPodcastTone = e.target.value; }} className="bg-transparent text-[10px] md:text-[11px] text-neon-cyan outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[112px] bg-void-1">{TONES.map(t => <option key={t} value={t}>{t}</option>)}</select>
                 <div className="w-[1px] h-3.5 bg-zinc-700"></div>
                 <div className="p-1 md:p-1.5 text-zinc-500"><Globe size={13} /></div>
                 <select value={selectedLanguage} onChange={(e) => { setSelectedLanguage(e.target.value); lastPodcastLanguage = e.target.value; writeStoredValue('podcast_language', e.target.value); }} className="bg-transparent text-[10px] md:text-[11px] text-neon-cyan outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[112px] bg-void-1">{LANGUAGES.map(lang => <option key={lang} value={lang}>{lang}</option>)}</select>
              </div>
              <button
                onClick={handleToggleGeneration}
                className={`btn-action ${isLoading ? 'btn-stop' : 'btn-go'}`}
              >
                 {isLoading ? <Square size={13} fill="currentColor" /> : hasInitiated ? <RefreshCw size={13} /> : <Play size={13} fill="currentColor" />}
                 {isLoading ? "STOP" : hasInitiated ? "REGENERATE" : "INITIATE"}
              </button>
          </div>
       </div>

       <div className="flex-1 flex flex-col gap-2 overflow-hidden w-full">
           <div className={`content-panel rounded-lg p-0 relative overflow-hidden shrink-0 flex flex-col shadow-2xl transition-all duration-300 ease-in-out ${isPlayerMinimized ? 'h-auto' : 'h-[277px]'}`}>
               {!isPlayerMinimized && (
                   <div className="flex-1 bg-[#010102] w-full flex items-center justify-center overflow-hidden relative group border-b border-zinc-900">
                      <div className="absolute inset-0 bg-[linear-gradient(rgba(0,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(0,255,255,0.02)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none"></div>
                      
                      {audioSrc && !isLoading && episodeTitle && (
                        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none animate-fade-in">
                            <div className="relative max-w-[90%] px-8 py-4 overflow-hidden">
                               <span className="content-font font-black text-neon-red uppercase drop-shadow-glow-red italic flex items-center gap-4 justify-center text-center leading-tight whitespace-nowrap" style={{ fontSize: 'clamp(10px, 2.5vw, 16px)', letterSpacing: '0.2em' }}>
                                  <div className="w-3 h-3 rounded-full bg-neon-red shadow-[0_0_10px_#ff003c] animate-pulse shrink-0"></div>
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
                        <div className="flex flex-col items-center gap-2 text-zinc-500 font-mono text-xs">
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
                        <div className="h-full bg-neon-cyan relative transition-none shadow-[0_0_10px_#00f3ff]" style={{ width: `${playbackProgress}%` }} />
                      </div>
                   </div>
               )}
               <div className="bg-void-0 p-1.5 md:p-2 flex items-center overflow-hidden min-w-0 gap-1">
                   <div className="flex-1 flex items-center gap-1 min-w-0">
                       <select value={playbackRate} onChange={(e) => setPlaybackRate(Number(e.target.value))} className="md:hidden bg-void-1 text-[10px] text-neon-cyan font-mono uppercase outline-none border border-zinc-800 rounded-sm px-1.5 py-1 w-[56px] shrink-0">{SPEEDS.map(s => <option key={s} value={s}>{s.toFixed(2)}x</option>)}</select>
                       <span className="md:hidden text-[8px] font-mono text-zinc-600 shrink-0">{formatTime(currentTime)}/{formatTime(duration)}</span>
                       <div className="hidden md:flex items-center gap-3 text-[10px] font-mono uppercase overflow-hidden">
                            {SPEEDS.map(s => (
                              <button
                                key={s}
                                onClick={() => setPlaybackRate(s)}
                                className={`transition-colors font-mono ${playbackRate === s ? 'text-neon-cyan font-bold underline underline-offset-4' : 'text-zinc-600 hover:text-zinc-400'}`}
                              >
                                {s.toFixed(2)}x
                              </button>
                            ))}
                       </div>
                   </div>
                   <div className="flex items-center justify-center gap-2 md:gap-5 shrink-0">
                       <button onClick={() => { if(audioRef.current) audioRef.current.currentTime -= 15; }} disabled={!audioSrc} aria-label="Rewind 15 seconds" className="p-1 md:p-1.5 text-zinc-500 hover:text-cyan-400 transition hover:bg-zinc-900 rounded-full disabled:opacity-30 active:scale-90"><RotateCcw size={14} /></button>
                       <button onClick={togglePlay} disabled={!audioSrc} aria-label="Play/pause" className={`w-8 h-8 md:w-9 md:h-9 rounded-full transition-all flex items-center justify-center border-2 shrink-0 active:scale-95 ${isPlaying ? 'bg-transparent border-neon-cyan text-neon-cyan shadow-glow-cyan' : 'bg-neon-cyan border-neon-cyan text-black shadow-glow-press hover:scale-105'}`}>{isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="ml-0.5" />}</button>
                       <button onClick={() => { if(audioRef.current) audioRef.current.currentTime += 15; }} disabled={!audioSrc} aria-label="Forward 15 seconds" className="p-1 md:p-1.5 text-zinc-500 hover:text-cyan-400 transition hover:bg-zinc-900 rounded-full disabled:opacity-30 active:scale-90"><RotateCw size={14} /></button>
                   </div>
                   <div className="flex-1 flex items-center justify-end gap-0.5 md:gap-2 min-w-0">
                       <span className="hidden md:inline text-[10px] font-mono text-zinc-600 shrink-0">{formatTime(currentTime)}/{formatTime(duration)}</span>
                       <button onClick={downloadScript} disabled={!script} className={`p-1 md:p-2 text-zinc-600 transition rounded-full shrink-0 active:scale-90 ${script ? 'hover:text-neon-cyan hover:bg-zinc-900' : 'opacity-30'}`} title="Download Script"><FileDown size={14} /></button>
                       <a href={audioSrc || '#'} download={`podcast-ch${chapter.id}-${titleCase(selectedTone, 20)}-${hosts.host1}&${hosts.host2}-${titleCase(chapter.title)}.wav`} className={`p-1 md:p-2 text-zinc-600 transition rounded-full shrink-0 active:scale-90 ${audioSrc ? 'hover:text-neon-red hover:bg-zinc-900' : 'opacity-30'}`} onClick={(e) => !audioSrc && e.preventDefault()} title="Download Audio"><Download size={14} /></a>
                       <button onClick={async () => { if (!audioSrc) return; const r = await fetch(audioSrc); const b = await r.blob(); const fn = `podcast-ch${chapter.id}-${titleCase(selectedTone, 20)}-${hosts.host1}&${hosts.host2}-${titleCase(chapter.title)}.wav`; shareFile(b, fn, `${chapter.title} - ${selectedTone} Podcast`); }} disabled={!audioSrc} className={`p-1 md:p-2 text-zinc-600 transition rounded-full shrink-0 active:scale-90 ${audioSrc ? 'hover:text-neon-cyan hover:bg-zinc-900' : 'opacity-30'}`} title="Share"><Share2 size={14} /></button>
                       <button onClick={() => {
                         const nextMinimized = !isPlayerMinimized;
                         setIsPlayerMinimized(nextMinimized);
                         lastPodcastPlayerMinimized = nextMinimized;
                         writeStoredValue('podcast_player_minimized', String(nextMinimized));
                       }} className="p-1 md:p-2 text-zinc-600 hover:text-neon-cyan transition rounded-full bg-zinc-900/50 shrink-0 active:scale-90" title={isPlayerMinimized ? "Expand Player" : "Minimize Player"}>{isPlayerMinimized ? <Maximize2 size={14} /> : <Minimize2 size={14} />}</button>
                   </div>
               </div>
           </div>
           <audio 
             ref={audioRef} 
             src={audioSrc || undefined} 
             onEnded={() => setIsPlaying(false)} 
             onPlay={() => { if(audioRef.current) audioRef.current.playbackRate = playbackRate; }}
             onTimeUpdate={handleTimeUpdate}
             onLoadedMetadata={handleLoadedMetadata}
             className="hidden" 
           />
           {segments.length > 0 ? (
               <div className="flex-1 min-h-0 content-panel rounded-lg overflow-hidden flex flex-col shadow-lg">
                  <div ref={scriptContainerRef} className="flex-1 overflow-y-auto p-6 space-y-8 scroll-smooth custom-scrollbar content-font text-sm">
                    {segments.map((seg, idx) => {
                      const isActive = idx === activeIndex;
                      const h1 = hosts.host1.toUpperCase();
                      const h2 = hosts.host2.toUpperCase();
                      const cur = seg.speaker.toUpperCase();
                      const leftAligned = cur === h1 || cur.includes(h1);
                      return (
                        <div key={idx} ref={el => { segmentRefs.current[idx] = el; }} className={`flex w-full ${leftAligned ? 'justify-start' : 'justify-end'} animate-fade-in`}>
                            <div onClick={() => seekToSegment(idx)} className={`relative max-w-[85%] rounded-sm p-4 pt-5 border transition-all duration-300 cursor-pointer ${isActive ? (leftAligned ? 'bg-cyan-950/20 border-cyan-500 shadow-[0_0_20px_rgba(6,182,212,0.3)] scale-[1.02]' : 'bg-rose-950/20 border-neon-red shadow-[0_0_20px_rgba(255,0,60,0.3)] scale-[1.02]') : 'bg-zinc-900/30 border-zinc-800 hover:border-zinc-700'}`}>
                                <div className={`absolute -top-2.5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border ${leftAligned ? 'left-4 bg-cyan-900 border-cyan-500/50 text-cyan-200' : 'right-4 bg-rose-900 border-neon-red/50 text-rose-200'}`}>{seg.speaker}</div>
                                <p className={`leading-relaxed transition-colors duration-300 ${isActive ? 'text-white font-medium' : 'text-zinc-400'}`}>{seg.text}</p>
                                {isActive && <div className={`absolute top-1/2 -translate-y-1/2 w-1.5 h-1/2 rounded-full ${leftAligned ? '-left-0.5 bg-cyan-500 shadow-[0_0_10px_#00f3ff]' : '-right-0.5 bg-neon-red shadow-[0_0_10px_#ff003c]'}`}></div>}
                            </div>
                        </div>
                      );
                    })}
                  </div>
               </div>
           ) : !isLoading && !error && (
               <div className="flex-1 content-panel rounded-lg shadow-lg flex flex-col items-center justify-center text-zinc-600 gap-4 font-mono min-h-[200px]">
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
