
import React, { useState, useEffect, useRef } from 'react';
import { Lightbulb, Image as ImageIcon, Download, RefreshCw, Settings2, Hexagon, Globe, Archive, PlayCircle, Play, Square, Maximize, ChevronLeft, ChevronRight, Copy, Share2 } from 'lucide-react';
import { Concept, Chapter, FileContext } from '../types';
import { extractConcepts, generateConceptImage, logGenerationPartial, beginUsageSession, endUsageSession, estimateImageCredits } from '../services/gemini';
import { Loader } from './ui/Loader';
import { EmptyState } from './ui/EmptyState';
import { CreditNotice } from './ui/CreditNotice';
import { StatusMessage } from './ui/StatusMessage';
import { ensureCredits, isInsufficientCreditsError, getCachedTier } from '../services/credits';
import { shareFile } from '../utils/share';
import { titleCase, chapterFileLabel } from '../utils/filename';
import { trackGeneration, trackShare, trackError } from '../utils/analytics';
import JSZip from 'jszip';
import { saveFile, getFile, buildCacheKey, slugify } from '../services/fileCache';
import { getFileOrCloud } from '../services/figureSync';
import { GEN_STYLES } from '../utils/genStyles';

interface Props {
  chapter: Chapter;
  allChapters?: Chapter[];
  fileContext: FileContext;
  bookId: string;
  bookTitle?: string;
}

const STYLES = GEN_STYLES;
const RATIOS = ['1:1', '16:9', '4:3', '3:2', '9:16', '3:4', '2:3'];

export const Visualizer: React.FC<Props> = ({ chapter, allChapters, fileContext, bookId, bookTitle }) => {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [loadingImages, setLoadingImages] = useState<Record<string, boolean>>({});
  const [isInitializing, setIsInitializing] = useState(false);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [hasInitiated, setHasInitiated] = useState(false);

  // Restore the last-used style/ratio so re-opening lands where you left off (and cache keys match).
  const [selectedStyle, setSelectedStyle] = useState(() => { try { return localStorage.getItem('visualizer_style') || 'Cyberpunk'; } catch { return 'Cyberpunk'; } });
  const [selectedRatio, setSelectedRatio] = useState(() => { try { return localStorage.getItem('visualizer_ratio') || '1:1'; } catch { return '1:1'; } });
  const [currentIndex, setCurrentIndex] = useState(0);
  useEffect(() => { try { localStorage.setItem('visualizer_style', selectedStyle); } catch {} }, [selectedStyle]);
  useEffect(() => { try { localStorage.setItem('visualizer_ratio', selectedRatio); } catch {} }, [selectedRatio]);

  const abortRef = useRef<boolean>(false);
  const generatingRef = useRef<boolean>(false); // true during an INITIATE/generate cycle — pauses the cache-load effect so it can't clobber in-progress results
  // Non-null → the user ran out of credits; render the HAZARD notice instead of charging.
  const [creditTier, setCreditTier] = useState<'free' | 'pro' | null>(null);
  // Non-null → a non-credit image failure (transient); shown in the viewer.
  const [imgError, setImgError] = useState<string | null>(null);
  const outOfCredits = () => setCreditTier(getCachedTier()?.tier === 'pro' ? 'pro' : 'free');

  const mountedRef = useRef(true);
  const conceptsKey = () => buildCacheKey(bookId, chapter.id, 'concepts', 'v1');

  useEffect(() => {
    mountedRef.current = true;
    setConcepts([]);
    setImages({});
    setHasInitiated(false);
    setCurrentIndex(0);
    let cancelled = false;
    // Load previously-extracted concepts for this chapter so extractConcepts is never re-charged.
    (async () => {
      try {
        const file = await getFileOrCloud(conceptsKey());
        if (!file || cancelled) return;
        const parsed = JSON.parse(await file.blob.text());
        if (Array.isArray(parsed) && parsed.length) setConcepts(parsed); // hasInitiated is set by the image cache-load effect (per current style)
      } catch { /* no cached concepts — will extract on Initiate */ }
    })();
    return () => { mountedRef.current = false; cancelled = true; };
  }, [chapter, fileContext, bookId]);

  useEffect(() => {
    if (generatingRef.current) return; // don't clear/reload while a generate cycle is populating images
    setCreditTier(null); // switching look is a fresh state — drop any out-of-credits notice
    if (concepts.length === 0) { setImages({}); setHasInitiated(false); return; }
    let cancelled = false;
    // Changing style/ratio must CLEAR the viewer (don't keep showing the old style's images),
    // then load only THIS style+ratio's cached images. If none exist, images stay empty and
    // hasInitiated=false → the idle "Click INITIATE" tip shows for the newly-selected look.
    setImages({});
    const loadCachedImages = async () => {
      const cached: Record<string, string> = {};
      for (const concept of concepts) {
        const key = buildCacheKey(bookId, chapter.id, 'concept-image', slugify(concept.term), selectedStyle, selectedRatio);
        try {
          const file = await getFileOrCloud(key);
          if (file && !cancelled) {
            cached[concept.term] = URL.createObjectURL(file.blob);
          }
        } catch (e) { /* skip */ }
      }
      if (!cancelled) {
        setImages(cached);
        setHasInitiated(Object.keys(cached).length > 0);
      }
    };
    loadCachedImages();
    return () => { cancelled = true; };
  }, [concepts, bookId, chapter.id, selectedStyle, selectedRatio]);

  const handleGenerateImage = async (concept: Concept, forceRegenerate = false, preChecked = false) => {
    if (loadingImages[concept.term] && !forceRegenerate) return;
    const key = buildCacheKey(bookId, chapter.id, 'concept-image', slugify(concept.term), selectedStyle, selectedRatio);
    // Never re-charge for an image already generated at this style+ratio — load the cached one.
    if (!forceRegenerate) {
      try {
        const file = await getFileOrCloud(key);
        if (file) { setImages(prev => ({ ...prev, [concept.term]: URL.createObjectURL(file.blob) })); return; }
      } catch { /* not cached — fall through to generate */ }
    }
    // Cache miss → this will cost credits. Pre-check so a 0-balance user sees the
    // HAZARD notice instead of a failed call (batch path pre-checks once → preChecked).
    if (!preChecked) {
      const gate = await ensureCredits('generateImage', estimateImageCredits());
      if (!gate.ok) { setCreditTier(gate.tier); return; }
    }
    setLoadingImages(prev => ({ ...prev, [concept.term]: true }));
    setImgError(null);
    try {
      const imgUrl = await generateConceptImage(concept.visualPrompt, selectedStyle, selectedRatio);
      setImages(prev => ({ ...prev, [concept.term]: imgUrl }));
      trackGeneration({ bookId, chapterIndex: chapter.id, module: 'visualizer', provider: 'gemini', inputChars: concept.visualPrompt.length });
      try {
        const imgResp = await fetch(imgUrl);
        const imgBlob = await imgResp.blob();
        saveFile(key, imgBlob, {
          filename: `concept-${chapterFileLabel(chapter, allChapters)}-${titleCase(concept.term)}-${titleCase(selectedStyle, 20)}-${selectedRatio}.png`,
          mimeType: 'image/png',
          timestamp: Date.now(),
          bookId,
          bookTitle,
          chapterId: chapter.id,
          componentSource: 'visualizer',
          fileType: 'concept-image',
        }).catch(e => console.warn('Cache save failed:', e));
      } catch (e) { /* caching is best-effort */ }
    } catch (e: any) {
      console.error("Image gen failed", e);
      if (isInsufficientCreditsError(e)) { outOfCredits(); abortRef.current = true; }
      else setImgError("Failed to generate image, try again later.");
      trackGeneration({ bookId, chapterIndex: chapter.id, module: 'visualizer', status: 'failed', errorMessage: e?.message });
    } finally {
      setLoadingImages(prev => ({ ...prev, [concept.term]: false }));
    }
  };

  const handleToggleInitiate = async () => {
    if (isGeneratingAll) {
      abortRef.current = true;
      generatingRef.current = false;
      setIsGeneratingAll(false);
      logGenerationPartial('generateImage'); // stopped part-way → tag delivered images "(Partial)"
      return;
    }

    abortRef.current = false;
    generatingRef.current = true;
    beginUsageSession('Image generation'); // fold concept-extraction + all images into ONE history line
    try {
    setCreditTier(null); // fresh attempt — clear any prior out-of-credits notice
    let activeConcepts = concepts;

    if (activeConcepts.length === 0) {
      setIsInitializing(true);
      try {
        // Reuse cached concepts if present (a click before the mount-load finished) — never re-charge.
        let extracted: Concept[] | null = null;
        try {
          const file = await getFileOrCloud(conceptsKey());
          if (file) { const p = JSON.parse(await file.blob.text()); if (Array.isArray(p) && p.length) extracted = p; }
        } catch {}
        if (!extracted) {
          // Concept extraction costs credits — gate before the call.
          const gate = await ensureCredits('extractConcepts');
          if (!gate.ok) { setCreditTier(gate.tier); setIsInitializing(false); generatingRef.current = false; return; }
          extracted = await extractConcepts(fileContext, chapter);
          saveFile(conceptsKey(), new Blob([JSON.stringify(extracted)], { type: 'application/json' }), {
            filename: `concepts-${chapterFileLabel(chapter, allChapters)}.json`, mimeType: 'application/json', timestamp: Date.now(),
            bookId, bookTitle, chapterId: chapter.id, componentSource: 'visualizer', fileType: 'concepts',
          }).catch(() => {});
        }
        if (!mountedRef.current) return;
        setConcepts(extracted);
        setCurrentIndex(0);
        activeConcepts = extracted;
      } catch (err) {
        console.error(err);
        setIsInitializing(false);
        generatingRef.current = false;
        return;
      } finally {
        if (mountedRef.current) setIsInitializing(false);
      }
    }

    if (activeConcepts.length === 0) { generatingRef.current = false; return; }

    setIsGeneratingAll(true);
    setHasInitiated(true);
    const pendingConcepts = activeConcepts.filter(c => !images[c.term]);
    const targets = pendingConcepts.length > 0 ? pendingConcepts : activeConcepts;
    const forceRegen = pendingConcepts.length === 0;

    // Gate once for the batch (each image is cache-first; a 0-balance user is
    // stopped here rather than firing N failing calls).
    const gate = await ensureCredits('generateImage', estimateImageCredits());
    if (!gate.ok) { setCreditTier(gate.tier); setIsGeneratingAll(false); generatingRef.current = false; return; }

    const BATCH_SIZE = 3;
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        if (abortRef.current) break;
        const batch = targets.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(concept => {
            if (abortRef.current) return Promise.resolve();
            return handleGenerateImage(concept, forceRegen, true);
        }));
    }
    setIsGeneratingAll(false);
    generatingRef.current = false;
    // Reflect the just-generated images for the current style/ratio (the effect was paused).
    setHasInitiated(true);
    } finally {
      endUsageSession();
    }
  };

  const handleNext = () => {
    if (concepts.length === 0) return;
    setCurrentIndex((prev) => (prev + 1) % concepts.length);
  };

  const handlePrev = () => {
    if (concepts.length === 0) return;
    setCurrentIndex((prev) => (prev - 1 + concepts.length) % concepts.length);
  };

  const handleCopyPrompt = () => {
      if (currentConcept) {
          navigator.clipboard.writeText(currentConcept.visualPrompt);
      }
  };

  const allImagesGenerated = concepts.length > 0 && concepts.every(c => images[c.term]);
  const renderButtonLabel = () => {
    if (isGeneratingAll) return "STOP";
    if (allImagesGenerated || hasInitiated) return "REGENERATE";
    return "INITIATE";
  };
  const renderButtonIcon = () => {
    if (isGeneratingAll) return <Square size={13} fill="currentColor" />;
    if (allImagesGenerated || hasInitiated) return <RefreshCw size={13} />;
    return <Play size={13} fill="currentColor" />;
  };

  const currentConcept = concepts[currentIndex];

  return (
    <div className="h-full flex flex-col font-sans text-zinc-100 text-left overflow-hidden">
       <div className="hud-panel mb-1.5 md:mb-2 flex items-center justify-between shrink-0 animate-fade-in w-full flex-wrap gap-2 z-20">
          <div className="hidden md:flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-[11px]">
             <ImageIcon size={16} className="text-neon-cyan" />
             <span>Visual_Matrix</span>
          </div>
          <div className="flex items-center gap-2 md:gap-3 flex-1 md:flex-none justify-between md:justify-end">
              <div className="select-group">
                  <div className="p-1 md:p-1.5 text-zinc-500"><Settings2 size={13} /></div>
                  <select value={selectedStyle} onChange={(e) => setSelectedStyle(e.target.value)} disabled={isInitializing} className={`bg-transparent text-[10px] md:text-[11px] text-neon-cyan outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[112px] bg-void-1 ${isInitializing ? 'opacity-50 cursor-not-allowed' : ''}`}>{STYLES.map(s => <option key={s} value={s}>{s}</option>)}</select>
                  <div className="w-[1px] h-3.5 bg-zinc-700"></div>
                  <div className="p-1 md:p-1.5 text-zinc-500"><Maximize size={13} /></div>
                  <select value={selectedRatio} onChange={(e) => setSelectedRatio(e.target.value)} disabled={isInitializing} className={`bg-transparent text-[10px] md:text-[11px] text-neon-cyan outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[112px] bg-void-1 ${isInitializing ? 'opacity-50 cursor-not-allowed' : ''}`}>{RATIOS.map(r => <option key={r} value={r}>{r}</option>)}</select>
              </div>
              <button onClick={handleToggleInitiate} disabled={isInitializing} className={`btn-action ${isGeneratingAll ? 'btn-stop' : 'btn-go'} ${isInitializing ? 'opacity-50 cursor-not-allowed' : ''}`}>{renderButtonIcon()}{renderButtonLabel()}</button>
          </div>
       </div>
       <div className="flex-1 min-h-0 flex flex-col relative w-full">
            {isInitializing ? (
                <div className="absolute inset-0 flex items-center justify-center">
                    <Loader text="Extracting neural concepts..." />
                </div>
            ) : creditTier ? (
                <div className="flex-1 h-full w-full relative content-panel rounded-lg overflow-hidden flex items-center justify-center bg-void-2">
                    <CreditNotice tier={creditTier} />
                </div>
            ) : (concepts.length === 0 || !hasInitiated) ? (
                <div className="flex-1 h-full w-full relative content-panel rounded-lg overflow-hidden flex flex-col shadow-lg">
                    <EmptyState icon={ImageIcon} label="Visual_Core_Idle" sublabel="Click INITIATE to extract and visualize concepts" className="flex-1 min-h-0 bg-void-2" />
                </div>
            ) : currentConcept ? (
                <div className="flex-1 h-full w-full relative group/container content-panel rounded-lg overflow-hidden flex flex-col shadow-lg transition-all">
                    
                    <div className="relative bg-void-2 group/image flex-1 min-h-0 flex items-center justify-center w-full overflow-hidden">
                        
                        {/* Information Overlay: Top Center (Title + Definition) */}
                        <div className="absolute top-6 left-0 w-full flex flex-col items-center gap-2 z-30 pointer-events-none px-4">
                            {/* Title */}
                            <div className="bg-black/60 backdrop-blur-md border border-white/10 px-6 py-2 rounded-full shadow-[0_4px_20px_rgba(0,0,0,0.5)]">
                                <h3 className="text-xs font-bold text-neon-red content-font uppercase tracking-widest flex items-center gap-3 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                                    <span className="w-1.5 h-1.5 bg-neon-red rounded-full shadow-[0_0_8px_#ff003c]"></span>
                                    {currentConcept.term}
                                    <span className="w-1.5 h-1.5 bg-neon-red rounded-full shadow-[0_0_8px_#ff003c]"></span>
                                </h3>
                            </div>
                            {/* Definition */}
                            <div className="max-w-[90%] text-center p-2">
                                <p className="text-xs text-zinc-100 leading-relaxed content-font drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] font-medium">
                                    {currentConcept.definition}
                                </p>
                            </div>
                        </div>

                        {/* Overlay Navigation Buttons */}
                        <button
                            aria-label="Previous concept"
                            onClick={handlePrev}
                            className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full border border-zinc-800 bg-black/60 backdrop-blur-sm text-zinc-500 hover:text-neon-cyan hover:border-neon-cyan flex items-center justify-center transition-all z-40 shadow-[0_0_20px_rgba(0,0,0,0.5)] group/btn hover:scale-110"
                        >
                            <ChevronLeft size={24} className="group-hover/btn:-translate-x-0.5 transition-transform" />
                        </button>

                        <button
                            aria-label="Next concept"
                            onClick={handleNext}
                            className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full border border-zinc-800 bg-black/60 backdrop-blur-sm text-zinc-500 hover:text-neon-cyan hover:border-neon-cyan flex items-center justify-center transition-all z-40 shadow-[0_0_20px_rgba(0,0,0,0.5)] group/btn hover:scale-110"
                        >
                            <ChevronRight size={24} className="group-hover/btn:translate-x-0.5 transition-transform" />
                        </button>

                        {images[currentConcept.term] ? (
                            <>
                            <img src={images[currentConcept.term]} alt={currentConcept.term} className="w-full h-full object-contain animate-fade-in" />
                            <div className="absolute inset-0 bg-black/70 opacity-0 group-hover/image:opacity-100 transition-all duration-300 flex items-center justify-center gap-3 backdrop-blur-sm z-20 pointer-events-none">
                                <div className="pointer-events-auto flex gap-3">
                                    <a href={images[currentConcept.term]} download={`concept-ch${chapter.id}-${titleCase(currentConcept.term)}.png`} className="p-3 bg-zinc-900 text-cyan-400 rounded-sm hover:bg-cyan-500 hover:text-black transition-all border border-cyan-500/30" title="Download"><Download size={20} /></a>
                                    <button onClick={async () => { const r = await fetch(images[currentConcept.term]); const b = await r.blob(); const fn = `concept-ch${chapter.id}-${titleCase(currentConcept.term)}.png`; shareFile(b, fn, `${chapter.title} - ${currentConcept.term}`); }} className="p-3 bg-zinc-900 text-cyan-400 rounded-sm hover:bg-cyan-500 hover:text-black transition-all border border-cyan-500/30" title="Share"><Share2 size={20} /></button>
                                    <button onClick={handleCopyPrompt} className="p-3 bg-zinc-900 text-cyan-400 rounded-sm hover:bg-cyan-500 hover:text-black transition-all border border-cyan-500/30" title="Copy Prompt"><Copy size={20} /></button>
                                    <button onClick={() => handleGenerateImage(currentConcept, true)} className="p-3 bg-zinc-900 text-neon-red rounded-sm hover:bg-neon-red hover:text-white transition-all border border-neon-red/30" title="Regenerate"><RefreshCw size={20} /></button>
                                </div>
                            </div>
                            </>
                        ) : (
                            <div className="text-center p-6 w-full h-full flex items-center justify-center relative overflow-hidden">
                                <div className="absolute inset-0 bg-[linear-gradient(to_right,#1f2937_1px,transparent_1px),linear-gradient(to_bottom,#1f2937_1px,transparent_1px)] bg-[size:16px_16px] opacity-10 pointer-events-none"></div>
                                {loadingImages[currentConcept.term] ? (
                                    <div className="flex flex-col items-center gap-2 text-zinc-500 animate-fade-in z-10"><Loader text="Rendering..." /></div>
                                ) : imgError ? (
                                    <div className="z-10 animate-fade-in"><StatusMessage variant="error" title={imgError} action={{ label: 'Retry', onClick: () => handleGenerateImage(currentConcept, true) }} /></div>
                                ) : (
                                    <button onClick={() => handleGenerateImage(currentConcept)} className="flex flex-col items-center gap-3 text-zinc-600 hover:text-neon-cyan transition-colors group-hover:scale-105 transform duration-300 w-full h-full justify-center z-10"><ImageIcon size={32} /><span className="text-xs font-bold font-mono uppercase tracking-widest">Generate_Visual</span></button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="flex items-center justify-center h-full text-zinc-500 font-mono text-xs">
                    NO_CONCEPTS_DETECTED
                </div>
            )}
       </div>
    </div>
  );
};
