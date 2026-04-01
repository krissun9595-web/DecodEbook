
import React, { useState, useEffect, useRef } from 'react';
import { Lightbulb, Image as ImageIcon, Download, RefreshCw, Settings2, Hexagon, Globe, Archive, PlayCircle, Play, Square, Maximize, ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { Concept, Chapter, FileContext } from '../types';
import { extractConcepts, generateConceptImage } from '../services/gemini';
import { Loader } from './ui/Loader';
import JSZip from 'jszip';
import { saveFile, getFile, buildCacheKey, slugify } from '../services/fileCache';

interface Props {
  chapter: Chapter;
  fileContext: FileContext;
  bookId: string;
}

const STYLES = [
  'Digital Art', 'Cinematic', 'Anime', 'Photorealistic', 'Cartoon', 'Sketch', 
  'Cyberpunk', 'Vaporwave', 'Neon', 'Line Art', 'Low Poly', 'Isometric',
  '3D Render', 'Pixel Art'
];
const RATIOS = ['1:1', '16:9', '4:3', '3:2', '9:16', '3:4', '2:3'];

export const Visualizer: React.FC<Props> = ({ chapter, fileContext, bookId }) => {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [loadingImages, setLoadingImages] = useState<Record<string, boolean>>({});
  const [isInitializing, setIsInitializing] = useState(false);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [hasInitiated, setHasInitiated] = useState(false);

  const [selectedStyle, setSelectedStyle] = useState('Cyberpunk');
  const [selectedRatio, setSelectedRatio] = useState('1:1');
  const [currentIndex, setCurrentIndex] = useState(0);

  const abortRef = useRef<boolean>(false);

  useEffect(() => {
    let mounted = true;
    const loadConcepts = async () => {
      setIsInitializing(true);
      try {
        const extracted = await extractConcepts(fileContext, chapter);
        if (mounted) {
            setConcepts(extracted);
            setCurrentIndex(0);
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (mounted) setIsInitializing(false);
      }
    };
    loadConcepts();
    return () => { mounted = false; };
  }, [chapter, fileContext]);

  useEffect(() => {
    if (concepts.length === 0) return;
    let cancelled = false;
    const loadCachedImages = async () => {
      const cached: Record<string, string> = {};
      for (const concept of concepts) {
        const key = buildCacheKey(bookId, chapter.id, 'concept-image', slugify(concept.term), selectedStyle, selectedRatio);
        try {
          const file = await getFile(key);
          if (file && !cancelled) {
            cached[concept.term] = URL.createObjectURL(file.blob);
          }
        } catch (e) { /* skip */ }
      }
      if (!cancelled && Object.keys(cached).length > 0) {
        setImages(prev => ({ ...cached, ...prev }));
        setHasInitiated(true);
      }
    };
    loadCachedImages();
    return () => { cancelled = true; };
  }, [concepts, bookId, chapter.id, selectedStyle, selectedRatio]);

  const handleGenerateImage = async (concept: Concept, forceRegenerate = false) => {
    if (loadingImages[concept.term] && !forceRegenerate) return;
    setLoadingImages(prev => ({ ...prev, [concept.term]: true }));
    try {
      const imgUrl = await generateConceptImage(concept.visualPrompt, selectedStyle, selectedRatio);
      setImages(prev => ({ ...prev, [concept.term]: imgUrl }));
      try {
        const imgResp = await fetch(imgUrl);
        const imgBlob = await imgResp.blob();
        const key = buildCacheKey(bookId, chapter.id, 'concept-image', slugify(concept.term), selectedStyle, selectedRatio);
        saveFile(key, imgBlob, {
          filename: `concept-${slugify(concept.term)}.png`,
          mimeType: 'image/png',
          timestamp: Date.now(),
          bookId,
          chapterId: chapter.id,
          componentSource: 'visualizer',
          fileType: 'concept-image',
        }).catch(e => console.warn('Cache save failed:', e));
      } catch (e) { /* caching is best-effort */ }
    } catch (e) {
      console.error("Image gen failed", e);
    } finally {
      setLoadingImages(prev => ({ ...prev, [concept.term]: false }));
    }
  };

  const handleToggleInitiate = async () => {
    if (isGeneratingAll) {
      abortRef.current = true;
      setIsGeneratingAll(false);
      return;
    }
    setIsGeneratingAll(true);
    setHasInitiated(true);
    abortRef.current = false;
    const pendingConcepts = concepts.filter(c => !images[c.term]);
    const targets = pendingConcepts.length > 0 ? pendingConcepts : concepts;
    const forceRegen = pendingConcepts.length === 0;

    // Generate images in parallel batches of 3
    const BATCH_SIZE = 3;
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        if (abortRef.current) break;
        const batch = targets.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(concept => {
            if (abortRef.current) return Promise.resolve();
            return handleGenerateImage(concept, forceRegen);
        }));
    }
    setIsGeneratingAll(false);
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
    if (isGeneratingAll) return <Square size={14} fill="currentColor" />;
    if (allImagesGenerated || hasInitiated) return <RefreshCw size={14} />;
    return <Play size={14} fill="currentColor" />;
  };

  const currentConcept = concepts[currentIndex];

  return (
    <div className="h-full flex flex-col font-sans text-zinc-100 text-left overflow-hidden">
       <div className="bg-zinc-950/80 p-3 rounded-lg border border-cyan-900/40 mb-4 flex items-center justify-between shrink-0 animate-fade-in shadow-[0_0_15px_rgba(0,243,255,0.05)] flex-nowrap gap-2 z-10">
          <div className="flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-xs">
             <ImageIcon size={18} className="text-[#00f3ff]" />
             <span>Visual_Matrix</span>
          </div>
          <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 bg-black/50 p-1 rounded-sm border border-zinc-800">
                  <div className="p-1.5 text-zinc-500"><Settings2 size={16} /></div>
                  <select value={selectedStyle} onChange={(e) => setSelectedStyle(e.target.value)} disabled={isInitializing} className={`bg-transparent text-xs text-[#00f3ff] outline-none cursor-pointer font-mono uppercase w-[120px] bg-[#050505] ${isInitializing ? 'opacity-50 cursor-not-allowed' : ''}`}>{STYLES.map(s => <option key={s} value={s}>{s}</option>)}</select>
                  <div className="w-[1px] h-4 bg-zinc-700"></div>
                  <div className="p-1.5 text-zinc-500"><Maximize size={16} /></div>
                  <select value={selectedRatio} onChange={(e) => setSelectedRatio(e.target.value)} disabled={isInitializing} className={`bg-transparent text-xs text-[#00f3ff] outline-none cursor-pointer font-mono uppercase w-[120px] bg-[#050505] ${isInitializing ? 'opacity-50 cursor-not-allowed' : ''}`}>{RATIOS.map(r => <option key={r} value={r}>{r}</option>)}</select>
              </div>
              <button onClick={handleToggleInitiate} disabled={isInitializing} className={`flex items-center gap-2 px-4 py-1.5 rounded-sm text-xs font-bold font-mono uppercase transition-all shadow-[0_0_10px_rgba(0,243,255,0.3)] min-w-[120px] justify-center ${isGeneratingAll ? 'bg-[#ff003c] text-white hover:bg-rose-600' : 'bg-[#00f3ff] text-black hover:bg-[#00c2cc]'} ${isInitializing ? 'opacity-50 cursor-not-allowed' : ''}`}>{renderButtonIcon()}{renderButtonLabel()}</button>
          </div>
       </div>
       <div className="flex-1 min-h-0 flex flex-col relative w-full">
            {isInitializing ? (
                <div className="absolute inset-0 flex items-center justify-center">
                    <Loader text="Extracting neural concepts..." />
                </div>
            ) : concepts.length > 0 && currentConcept ? (
                <div className="flex-1 h-full w-full relative group/container bg-[#0a0a0c] border border-zinc-800 rounded-lg overflow-hidden flex flex-col shadow-lg transition-all">
                    
                    <div className="relative bg-black group/image flex-1 min-h-0 flex items-center justify-center w-full overflow-hidden">
                        
                        {/* Information Overlay: Top Center (Title + Definition) */}
                        <div className="absolute top-6 left-0 w-full flex flex-col items-center gap-2 z-30 pointer-events-none px-4">
                            {/* Title */}
                            <div className="bg-black/60 backdrop-blur-md border border-white/10 px-6 py-2 rounded-full shadow-[0_4px_20px_rgba(0,0,0,0.5)]">
                                <h3 className="text-xs font-bold text-[#ff003c] content-font uppercase tracking-widest flex items-center gap-3 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                                    <span className="w-1.5 h-1.5 bg-[#ff003c] rounded-full shadow-[0_0_8px_#ff003c]"></span>
                                    {currentConcept.term}
                                    <span className="w-1.5 h-1.5 bg-[#ff003c] rounded-full shadow-[0_0_8px_#ff003c]"></span>
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
                            onClick={handlePrev} 
                            className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full border border-zinc-800 bg-black/60 backdrop-blur-sm text-zinc-500 hover:text-[#00f3ff] hover:border-[#00f3ff] flex items-center justify-center transition-all z-40 shadow-[0_0_20px_rgba(0,0,0,0.5)] group/btn hover:scale-110"
                        >
                            <ChevronLeft size={24} className="group-hover/btn:-translate-x-0.5 transition-transform" />
                        </button>

                        <button 
                            onClick={handleNext} 
                            className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full border border-zinc-800 bg-black/60 backdrop-blur-sm text-zinc-500 hover:text-[#00f3ff] hover:border-[#00f3ff] flex items-center justify-center transition-all z-40 shadow-[0_0_20px_rgba(0,0,0,0.5)] group/btn hover:scale-110"
                        >
                            <ChevronRight size={24} className="group-hover/btn:translate-x-0.5 transition-transform" />
                        </button>

                        {images[currentConcept.term] ? (
                            <>
                            <img src={images[currentConcept.term]} alt={currentConcept.term} className="w-full h-full object-contain animate-fade-in" />
                            <div className="absolute inset-0 bg-black/70 opacity-0 group-hover/image:opacity-100 transition-all duration-300 flex items-center justify-center gap-3 backdrop-blur-sm z-20 pointer-events-none">
                                <div className="pointer-events-auto flex gap-3">
                                    <a href={images[currentConcept.term]} download={`lumina-concept-${currentConcept.term}.png`} className="p-3 bg-zinc-900 text-cyan-400 rounded-sm hover:bg-cyan-500 hover:text-black transition-all border border-cyan-500/30" title="Download"><Download size={20} /></a>
                                    <button onClick={handleCopyPrompt} className="p-3 bg-zinc-900 text-cyan-400 rounded-sm hover:bg-cyan-500 hover:text-black transition-all border border-cyan-500/30" title="Copy Prompt"><Copy size={20} /></button>
                                    <button onClick={() => handleGenerateImage(currentConcept, true)} className="p-3 bg-zinc-900 text-[#ff003c] rounded-sm hover:bg-[#ff003c] hover:text-white transition-all border border-[#ff003c]/30" title="Regenerate"><RefreshCw size={20} /></button>
                                </div>
                            </div>
                            </>
                        ) : (
                            <div className="text-center p-6 w-full h-full flex items-center justify-center relative overflow-hidden">
                                <div className="absolute inset-0 bg-[linear-gradient(to_right,#1f2937_1px,transparent_1px),linear-gradient(to_bottom,#1f2937_1px,transparent_1px)] bg-[size:16px_16px] opacity-10 pointer-events-none"></div>
                                {loadingImages[currentConcept.term] ? (
                                    <div className="flex flex-col items-center gap-2 text-zinc-500 animate-fade-in z-10"><Loader text="Rendering..." /></div>
                                ) : (
                                    <button onClick={() => handleGenerateImage(currentConcept)} className="flex flex-col items-center gap-3 text-zinc-600 hover:text-[#00f3ff] transition-colors group-hover:scale-105 transform duration-300 w-full h-full justify-center z-10"><ImageIcon size={32} /><span className="text-xs font-bold font-mono uppercase tracking-widest">Generate_Visual</span></button>
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
