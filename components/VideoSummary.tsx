

import React, { useState, useRef, useEffect } from 'react';
import { Film, Download, RotateCcw, Settings2, MonitorPlay, Globe, Square, RefreshCw, Play, Pause, RotateCw, Volume2, VolumeX, Maximize2, Minimize2, Gauge, Share2 } from 'lucide-react';
import { Chapter, FileContext } from '../types';
import { generateSummaryVideo, generateSeedanceVideo, hasValidKeyForVeo, requestVeoKey, getVideoModel } from '../services/gemini';
import { Loader } from './ui/Loader';
import { shareFile } from '../utils/share';
import { titleCase, chapterFileLabel } from '../utils/filename';
import { trackGeneration, trackShare, trackError } from '../utils/analytics';
import { saveFile, getFile, buildCacheKey } from '../services/fileCache';

interface Props {
  chapter: Chapter;
  allChapters?: Chapter[];
  fileContext: FileContext;
  bookId: string;
  bookTitle?: string;
}

const STYLES = [
  'Cinematic', 'Anime', 'Photorealistic', 'Cartoon', 'Cyberpunk', 
  'Vaporwave', 'Noir', 'Documentary', 'Surreal'
];

const RESOLUTIONS: ('720p' | '1080p')[] = ['720p', '1080p'];
const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

export const VideoSummary: React.FC<Props> = ({ chapter, allChapters, fileContext, bookId, bookTitle }) => {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStyle, setSelectedStyle] = useState('Cinematic');
  const [selectedLanguage, setSelectedLanguage] = useState('Original');
  const [selectedResolution, setSelectedResolution] = useState<'720p' | '1080p' | '4K'>('720p');
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);

  const abortRef = useRef<boolean>(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controlsTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  useEffect(() => {
    let cancelled = false;
    const loadCached = async () => {
      const key = buildCacheKey(bookId, chapter.id, 'video', selectedStyle, selectedResolution);
      try {
        const cached = await getFile(key);
        if (cached && !cancelled) {
          const url = URL.createObjectURL(cached.blob);
          setVideoUrl(url);
        }
      } catch (e) { /* cache miss */ }
    };
    if (!isGenerating && !videoUrl) loadCached();
    return () => { cancelled = true; };
  }, [bookId, chapter.id, selectedStyle, selectedResolution]);

  const handleToggleGeneration = async () => {
    if (isGenerating) {
        abortRef.current = true;
        setIsGenerating(false);
        setStatus("");
        return;
    }
    setError(null);
    setIsGenerating(true);
    abortRef.current = false;
    setStatus("Authenticating & Generating...");
    try {
      const videoModel = getVideoModel();
      const useSeedance = videoModel.startsWith('dreamina-') || videoModel.startsWith('doubao-seedance');

      if (!useSeedance) {
        const hasKey = await hasValidKeyForVeo();
        if (!hasKey) {
          setStatus("Waiting for Access Key...");
          await requestVeoKey();
        }
      }
      if (abortRef.current) return;

      const targetLang = selectedLanguage === 'Original' ? 'the source language of the document' : selectedLanguage;
      const videoBlob = useSeedance
        ? await generateSeedanceVideo(fileContext, chapter, setStatus, selectedStyle, targetLang, selectedResolution as any)
        : await generateSummaryVideo(fileContext, chapter, setStatus, selectedStyle, targetLang, selectedResolution as any);

      if (!abortRef.current) {
        if (videoUrl) URL.revokeObjectURL(videoUrl);
        const url = URL.createObjectURL(videoBlob);
        setVideoUrl(url);
        setIsPlaying(false);
        trackGeneration({ bookId, chapterIndex: chapter.id, module: 'video', provider: useSeedance ? 'seedance' : 'google', model: videoModel, inputChars: chapter.content?.length || 0 });
        const cacheKey = buildCacheKey(bookId, chapter.id, 'video', selectedStyle, selectedResolution);
        saveFile(cacheKey, videoBlob, {
          filename: `video-${chapterFileLabel(chapter, allChapters)}-${titleCase(selectedStyle, 20)}-${selectedResolution}.mp4`,
          mimeType: 'video/mp4',
          timestamp: Date.now(),
          bookId,
          bookTitle,
          chapterId: chapter.id,
          componentSource: 'video',
          fileType: 'video',
        }).catch(e => console.warn('Cache save failed:', e));
      }
    } catch (e: any) {
      if (!abortRef.current) {
        console.error(e);
        trackGeneration({ bookId, chapterIndex: chapter.id, module: 'video', status: 'failed', errorMessage: e.message });
        let msg = "Generation failed.";
        if (e.message?.includes("Requested entity was not found")) {
            msg = "Key Invalid. Paid project key required.";
            await requestVeoKey();
        } else if (e.message) msg = e.message;
        setError(msg);
      }
    } finally {
      if (!abortRef.current) {
        setIsGenerating(false);
        setStatus("");
      }
    }
  };

  const togglePlay = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!videoRef.current || !videoUrl) return;
    
    try {
      if (isPlaying) {
        videoRef.current.pause();
        setIsPlaying(false);
      } else {
        const playPromise = videoRef.current.play();
        if (playPromise !== undefined) {
          await playPromise;
          setIsPlaying(true);
        }
      }
    } catch (err) {
      console.warn("Playback interrupted or failed:", err);
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (videoRef.current && duration) {
       videoRef.current.currentTime = (val / 100) * duration;
    }
  };

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoRef.current) {
        videoRef.current.muted = !isMuted;
        setIsMuted(!isMuted);
    }
  };

  const toggleFullScreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
        containerRef.current.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable full-screen mode: ${err.message}`);
        });
    } else {
        document.exitFullscreen();
    }
  };

  const resetControlsTimeout = () => {
    setControlsVisible(true);
    if (controlsTimeoutRef.current) {
      window.clearTimeout(controlsTimeoutRef.current);
    }
    if (isPlaying) {
      controlsTimeoutRef.current = window.setTimeout(() => {
        setControlsVisible(false);
      }, 3000);
    }
  };

  useEffect(() => {
    const handleFsChange = () => {
      const isFs = !!document.fullscreenElement;
      setIsFullScreen(isFs);
      if (!isFs) setControlsVisible(true);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const formatTime = (seconds: number): string => {
    if (!seconds || isNaN(seconds)) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const updateProgress = () => {
    if (videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
        setDuration(videoRef.current.duration || 0);
        setPlaybackProgress((videoRef.current.currentTime / (videoRef.current.duration || 1)) * 100);
    }
  };

  useEffect(() => {
    if (videoRef.current) {
        videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, videoUrl]);

  const currentStatusLabel = isGenerating ? "STOP" : videoUrl ? "REGENERATE" : "INITIATE";
  const currentStatusIcon = isGenerating ? <Square size={13} fill="currentColor" /> : videoUrl ? <RefreshCw size={13} /> : <Play size={13} fill="currentColor" />;

  return (
    <div className="h-full flex flex-col font-sans text-zinc-100 text-left overflow-hidden">
      <div className="hud-panel mb-1.5 md:mb-2 flex items-center justify-between shrink-0 w-full flex-wrap gap-2 z-20">
          <div className="hidden md:flex items-center gap-4">
              <div className="flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-[11px]">
                 <Film size={16} className="text-neon-cyan" />
                 <span>Cine_Render</span>
              </div>
          </div>
          <div className="flex items-center gap-2 md:gap-3 flex-1 md:flex-none justify-between md:justify-end">
              <div className="select-group">
                 <div className="flex items-center gap-1 md:gap-1.5">
                    <div className="p-1 md:p-1.5 text-zinc-500"><Settings2 size={13} /></div>
                    <select value={selectedStyle} onChange={(e) => setSelectedStyle(e.target.value)} className="bg-transparent text-[10px] md:text-[11px] text-neon-cyan outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[112px] bg-void-1">{STYLES.map(t => <option key={t} value={t}>{t}</option>)}</select>
                 </div>
                 <div className="w-[1px] h-3.5 bg-zinc-700"></div>
                 <div className="flex items-center gap-1 md:gap-1.5">
                    <div className="p-1 md:p-1.5 text-zinc-500"><Maximize2 size={13} /></div>
                    <select value={selectedResolution} onChange={(e) => setSelectedResolution(e.target.value as any)} className="bg-transparent text-[10px] md:text-[11px] text-neon-cyan outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[112px] bg-void-1">{RESOLUTIONS.map(res => <option key={res} value={res}>{res}</option>)}</select>
                 </div>
              </div>
              <button onClick={handleToggleGeneration} className={`btn-action ${isGenerating ? 'btn-stop' : 'btn-go'}`}>
                {currentStatusIcon}
                {currentStatusLabel}
              </button>
          </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-start relative min-h-0 bg-void-0 rounded-lg border border-zinc-900 shadow-inner overflow-hidden">
        <div className="absolute inset-0 bg-grid opacity-[0.05] pointer-events-none"></div>

        <div 
          ref={containerRef} 
          onMouseMove={resetControlsTimeout}
          className="relative w-full h-full flex flex-col bg-black shadow-2xl transition-all duration-500 group overflow-hidden shrink-0"
        >
            <div className="flex-1 relative flex items-center justify-center overflow-hidden border-b border-zinc-900" onClick={() => videoUrl && togglePlay()}>
                {!videoUrl && !isGenerating && (
                    <div className="z-10 text-center space-y-4 p-8">
                        <div className="w-16 h-16 bg-zinc-900/50 rounded-full flex items-center justify-center mx-auto border border-zinc-800">
                             <Film className="text-zinc-500 w-6 h-6" />
                        </div>
                        <p className="text-zinc-600 font-mono text-[10px] uppercase tracking-widest">Awaiting Render Signal</p>
                        {error && <p className="text-neon-red text-[9px] font-mono mt-2 border border-neon-red/20 p-2 bg-neon-red/5">ERROR: {error}</p>}
                    </div>
                )}

                {isGenerating && (
                    <div className="z-20 scale-75">
                         <Loader text={status} />
                    </div>
                )}

                {videoUrl && !isGenerating && (
                    <>
                        <video 
                            key={videoUrl}
                            ref={videoRef}
                            src={videoUrl ? `${videoUrl}#t=0.001` : undefined}
                            onTimeUpdate={updateProgress}
                            onLoadedMetadata={updateProgress}
                            onPlay={() => { 
                                setIsPlaying(true);
                                if(videoRef.current) videoRef.current.playbackRate = playbackRate;
                            }}
                            onPause={() => setIsPlaying(false)}
                            className="w-full h-full object-contain pointer-events-none"
                            playsInline
                        />
                        <div className={`absolute top-3 left-3 z-30 flex gap-2 transition-opacity duration-500 ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}>
                             <div className="bg-black/60 backdrop-blur-md px-2 py-0.5 border border-cyan-500/30 rounded-sm text-[8px] font-mono text-cyan-400 uppercase tracking-widest">Live_Playback</div>
                             <div className="bg-black/60 backdrop-blur-md px-2 py-0.5 border border-zinc-800 rounded-sm text-[8px] font-mono text-zinc-500 uppercase tracking-widest">{selectedResolution}</div>
                        </div>
                    </>
                )}
            </div>

            <div className={`w-full bg-void-0 relative z-40 shrink-0 transition-all duration-500 ${videoUrl && controlsVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-full pointer-events-none'}`}>
                <div className="absolute top-0 left-0 w-full h-1 bg-zinc-800 hover:h-2 transition-all cursor-pointer z-50 group/progress">
                    <input 
                        type="range" 
                        min="0" max="100" step="0.1" 
                        value={playbackProgress} 
                        onChange={handleSeek} 
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    <div className="h-full bg-cyan-500 relative pointer-events-none" style={{ width: `${playbackProgress}%` }}>
                        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-cyan-100 rounded-full shadow-[0_0_10px_#00f3ff] opacity-0 group-hover/progress:opacity-100 transition-opacity"></div>
                    </div>
                </div>

                <div className="flex items-center p-1.5 md:p-2 overflow-hidden min-w-0 gap-1">
                    <div className="flex-1 flex items-center gap-1 min-w-0">
                        <select value={playbackRate} onChange={(e) => { setPlaybackRate(Number(e.target.value)); if(videoRef.current) videoRef.current.playbackRate = Number(e.target.value); }} className="md:hidden bg-void-1 text-[10px] text-neon-cyan font-mono uppercase outline-none border border-zinc-800 rounded-sm px-1.5 py-1 w-[56px] shrink-0">{SPEEDS.map(s => <option key={s} value={s}>{s}x</option>)}</select>
                        <span className="md:hidden text-[8px] font-mono text-zinc-600 shrink-0">{formatTime(currentTime)}/{formatTime(duration)}</span>
                        <div className="hidden md:flex items-center gap-3 text-[10px] font-mono uppercase overflow-hidden">
                            {SPEEDS.map(s => (
                                <button
                                    key={s}
                                    onClick={(e) => { e.stopPropagation(); setPlaybackRate(s); }}
                                    className={`transition-colors font-mono font-bold ${playbackRate === s ? 'text-neon-cyan underline underline-offset-4' : 'text-zinc-600 hover:text-zinc-400'}`}
                                >
                                    {s}x
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex items-center justify-center gap-2 md:gap-5 shrink-0">
                        <button aria-label="Rewind 5 seconds" onClick={(e) => { e.stopPropagation(); if(videoRef.current) videoRef.current.currentTime -= 5; }} className="p-1 md:p-0 text-zinc-500 hover:text-cyan-400 transition active:scale-90"><RotateCcw size={14} /></button>
                        <button aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlay} className={`w-8 h-8 md:w-9 md:h-9 rounded-full flex items-center justify-center transition-all shrink-0 border-2 active:scale-95 ${isPlaying ? 'bg-transparent border-neon-cyan text-neon-cyan shadow-glow-cyan' : 'bg-neon-cyan border-neon-cyan text-black shadow-glow-press hover:scale-105'}`}>
                            {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="ml-0.5" />}
                        </button>
                        <button aria-label="Forward 5 seconds" onClick={(e) => { e.stopPropagation(); if(videoRef.current) videoRef.current.currentTime += 5; }} className="p-1 md:p-0 text-zinc-500 hover:text-cyan-400 transition active:scale-90"><RotateCw size={14} /></button>
                    </div>

                    <div className="flex-1 flex items-center justify-end gap-0.5 md:gap-2 min-w-0">
                        <span className="hidden md:inline text-[10px] font-mono text-zinc-600 shrink-0">{formatTime(currentTime)}/{formatTime(duration)}</span>
                        <button aria-label={isMuted ? "Unmute" : "Mute"} onClick={toggleMute} className="p-1 md:p-0 text-zinc-600 hover:text-cyan-400 transition shrink-0 active:scale-90">
                            {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                        </button>
                        <a aria-label="Download video" href={videoUrl || '#'} download={`video-ch${chapter.id}-${titleCase(selectedStyle, 20)}-${selectedResolution}-${titleCase(chapter.title)}.mp4`} onClick={(e) => e.stopPropagation()} className="p-1 md:p-0 text-zinc-600 hover:text-cyan-400 transition shrink-0 active:scale-90">
                            <Download size={14} />
                        </a>
                        <button onClick={async (e) => { e.stopPropagation(); if (!videoUrl) return; const r = await fetch(videoUrl); const b = await r.blob(); const fn = `video-ch${chapter.id}-${titleCase(selectedStyle, 20)}-${selectedResolution}-${titleCase(chapter.title)}.mp4`; shareFile(b, fn, `${chapter.title} - ${selectedStyle}`); }} className="p-1 md:p-0 text-zinc-600 hover:text-cyan-400 transition shrink-0 active:scale-90" title="Share"><Share2 size={14} /></button>
                        <button aria-label={isFullScreen ? "Exit full screen" : "Enter full screen"} onClick={toggleFullScreen} className="p-1 md:p-0 text-zinc-600 hover:text-cyan-400 transition shrink-0 active:scale-90">
                            {isFullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                        </button>
                    </div>
                </div>
            </div>
        </div>
      </div>
    </div>
  );
};
