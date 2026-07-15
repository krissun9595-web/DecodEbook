
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { NotebookItem, AppSettings, Chapter, MindMapNode } from '../types';
import { Trash2, Quote, Book, BookOpen, Clock, ImageDown, Volume2, Settings2, Type, Loader2, Network, Download, FileText, Share2, ZoomIn, ZoomOut, RefreshCw, Zap, X, Notebook as NotebookIcon, Play, Square, ChevronRight, ChevronDown, Minus, Plus, LogOut, FileDown, Scan, Move } from 'lucide-react';
import JSZip from 'jszip';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import jsPDF from 'jspdf';

import { Loader } from './ui/Loader';
import { EmptyState } from './ui/EmptyState';
import { saveFile, buildCacheKey } from '../services/fileCache';
import { playPronunciationAudio, prefetchPronunciation } from '../services/pronunciationAudio';
import { shareFile } from '../utils/share';
import { titleCase } from '../utils/filename';
import { trackNotebook } from '../utils/analytics';
import { inkLineStyle } from '../utils/inkLine';

// Raw ink-line colours (match the reader's INK_LINE_COLORS) so the notebook's inked underline uses
// the SAME full/curvy/dotted style + colour as the reader instead of a hardcoded solid line.
const INK_LINE_COLORS: Record<AppSettings['highlightColor'], string> = {
  indigo: '#00f3ff',
  emerald: '#34d399',
  rose: '#ff003c',
  amber: '#fbbf24',
  violet: '#a78bfa',
  pink: '#ff4fd8',
};

interface Props {
  items: NotebookItem[];
  onDelete: (id: string) => void;
  onBulkDelete: (ids: string[]) => void;
  onUpdateComment: (id: string, comment: string) => void;
  onBatchUpdateDefinitions?: (updates: Record<string, string>) => void;
  settings: AppSettings;
  activeChapter?: Chapter | null;
  bookTitle?: string;
  bookId?: string;
}

type FilterType = 'all' | 'word' | 'phrase' | 'sentence';

const INK_BADGE_STYLES: Record<AppSettings['highlightColor'], string> = {
  indigo: 'bg-neon-cyan/10 border-neon-cyan/30 text-neon-cyan',
  emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
  rose: 'bg-neon-red/10 border-neon-red/30 text-neon-red',
  amber: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
  violet: 'bg-violet-500/10 border-violet-500/30 text-violet-400',
  pink: 'bg-neon-pink/10 border-neon-pink/30 text-neon-pink',
};

interface LayoutNode {
    id: string;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    depth: number;
    branchIndex: number;
    data: MindMapNode;
    isCollapsed: boolean;
    hasChildren: boolean;
    lines: string[];
}

interface LayoutLink {
    id: string;
    source: { x: number, y: number };
    target: { x: number, y: number };
    branchIndex: number;
    depth: number;
}

export const Notebook: React.FC<Props> = ({ items, onDelete, onBulkDelete, onUpdateComment, onBatchUpdateDefinitions, settings, activeChapter, bookTitle, bookId }) => {
  const fontStyle = {}; // Font now applied globally via CSS --content-font variable
  const [playingId, setPlayingId] = useState<string | null>(null);
  const pronunciationPrefetchTimer = useRef<number | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [activeBookFilter, setActiveBookFilter] = useState<string>('all');
  const bookTitles = useMemo(() => [...new Set(items.map(i => i.bookTitle).filter(Boolean) as string[])], [items]);
  
  // Mind Map State
  const [isMindMapMode, setIsMindMapMode] = useState(false);
  const [mindMapData, setMindMapData] = useState<MindMapNode | null>(null);
  const [isGeneratingMap, setIsGeneratingMap] = useState(false);
  const [hasInitiatedMap, setHasInitiatedMap] = useState(false);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(new Set());
  const [mapZoom, setMapZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const abortMapRef = useRef<boolean>(false);

  const NEON_BLUE = '#00f3ff';
  const NEON_YELLOW = '#facc15';
  const NEON_RED = '#ff003c';
  const NEON_GREEN = '#39ff14';

  const filteredItems = useMemo(() => {
      let result = [...items];
      if (activeBookFilter !== 'all') {
          result = result.filter(item => item.bookTitle === activeBookFilter);
      }
      if (activeFilter !== 'all') {
          result = result.filter(item => item.type === activeFilter);
      }
      result.sort((a, b) => b.timestamp - a.timestamp);
      return result;
  }, [items, activeFilter, activeBookFilter]);

  useEffect(() => () => {
    if (pronunciationPrefetchTimer.current !== null) window.clearTimeout(pronunciationPrefetchTimer.current);
  }, []);

  const playPronunciation = async (id: string, text: string) => {
     if (playingId) return;
     setPlayingId(id);
     try {
          await playPronunciationAudio(text, "Puck");
      } catch (e) {
          console.error("Playback failed:", e);
      } finally {
          setPlayingId(null);
      }
  };

  const prefetchNotebookPronunciation = (text: string, immediate = false) => {
    if (!text || playingId) return;
    if (pronunciationPrefetchTimer.current !== null) window.clearTimeout(pronunciationPrefetchTimer.current);
    if (immediate) {
      prefetchPronunciation(text, "Puck");
      return;
    }
    pronunciationPrefetchTimer.current = window.setTimeout(() => {
      prefetchPronunciation(text, "Puck");
    }, 120);
  };

  const buildStickyNoteCanvas = (item: NotebookItem): HTMLCanvasElement | null => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const W = 800;
      const H = 800;
      const margin = 50;
      const contentWidth = W - (margin * 2);
      const mainFont = settings.font ? `"${settings.font}", sans-serif` : 'Georgia';
      const FOOTER_HEIGHT = 60;
      const footerTop = H - FOOTER_HEIGHT;
      const bodyBottom = footerTop - 28;

      const wrapLines = (text: string, font: string, width = contentWidth): string[] => {
        ctx.font = font;
        const ws = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
        const result: string[] = [];
        let cur = '';
        const pushToken = (token: string) => {
          let remaining = token;
          while (ctx.measureText(remaining).width > width && remaining.length > 1) {
            let cut = remaining.length;
            while (cut > 1 && ctx.measureText(remaining.slice(0, cut)).width > width) cut--;
            if (cur.trim()) {
              result.push(cur.trim());
              cur = '';
            }
            result.push(remaining.slice(0, cut));
            remaining = remaining.slice(cut);
          }
          const test = cur ? `${cur} ${remaining}` : remaining;
          if (ctx.measureText(test).width > width && cur) {
            result.push(cur.trim());
            cur = remaining;
          } else {
            cur = test;
          }
        };
        ws.forEach(pushToken);
        if (cur.trim()) result.push(cur.trim());
        return result.length ? result : [''];
      };

      const clampLines = (value: string[], maxLines: number): string[] => {
        if (value.length <= maxLines) return value;
        const next = value.slice(0, maxLines);
        let last = next[next.length - 1].replace(/\s+$/g, '');
        while (last.length > 1 && ctx.measureText(`${last}...`).width > contentWidth) {
          last = last.slice(0, -1);
        }
        next[next.length - 1] = `${last}...`;
        return next;
      };

      let fontSize = 34;
      let lineHeight = fontSize * 1.35;
      let lines: string[] = [];
      do {
        ctx.font = `${fontSize}px ${mainFont}`;
        lines = wrapLines(item.text, `${fontSize}px ${mainFont}`);
        lineHeight = fontSize * 1.35;
        if (lines.length * lineHeight <= 250 || fontSize <= 18) break;
        fontSize -= 2;
      } while (fontSize > 18);
      lines = clampLines(lines, Math.max(3, Math.floor(250 / lineHeight)));

      let defLines: string[] = [];
      if (item.definition) {
        defLines = clampLines(wrapLines(item.definition, '14px "Courier New", monospace'), 7);
      }
      let commentLines: string[] = [];
      if (item.comment) {
        commentLines = clampLines(wrapLines(item.comment, 'italic 14px "Courier New", monospace'), 5);
      }

      // --- Pass 2: draw ---
      canvas.width = W;
      canvas.height = H;
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1;
      for (let i = 0; i < W; i += 40) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, H); ctx.stroke(); }
      for (let i = 0; i < H; i += 40) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(W, i); ctx.stroke(); }

      ctx.fillStyle = '#00f3ff';
      const cs = 8;
      ctx.fillRect(margin, margin, cs, cs);
      ctx.fillRect(W - margin - cs, margin, cs, cs);
      ctx.fillRect(margin, H - margin - cs, cs, cs);
      ctx.fillRect(W - margin - cs, H - margin - cs, cs, cs);

      let y = margin + 40;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ff003c'; ctx.font = 'bold 16px "Courier New", monospace';
      ctx.fillText(`// LOG_DATE: ${new Date(item.timestamp).toISOString().split('T')[0]}`, margin, y);
      y += 25;
      if (item.bookTitle) {
          ctx.fillStyle = '#00f3ff'; ctx.font = 'bold 20px "Courier New", monospace';
          const authorText = item.bookAuthor ? ` | ${item.bookAuthor}` : '';
          const bookLines = clampLines(wrapLines(`BOOK: ${item.bookTitle.toUpperCase()}${authorText}`, 'bold 20px "Courier New", monospace'), 2);
          for (const bookLine of bookLines) {
            ctx.fillText(bookLine, margin, y);
            y += 24;
          }
      }
      ctx.strokeStyle = '#334155'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(margin, y); ctx.lineTo(W - margin, y); ctx.stroke();
      y += 40;

      ctx.fillStyle = '#334155'; ctx.font = `${fontSize * 3}px ${mainFont}`;
      ctx.fillText('"', margin - 20, y + fontSize);
      ctx.fillStyle = '#e2e8f0'; ctx.font = `${fontSize}px ${mainFont}`;
      for (let i = 0; i < lines.length && y < bodyBottom; i++) { ctx.fillText(lines[i], margin, y); y += lineHeight; }
      y += 30;

      if (item.definition && y < bodyBottom - 40) {
          ctx.fillStyle = '#22d3ee'; ctx.font = 'bold 14px "Courier New", monospace';
          ctx.fillText(">> ANALYSIS_OUTPUT:", margin, y); y += 20;
          ctx.fillStyle = '#94a3b8'; ctx.font = '14px "Courier New", monospace';
          for (const dl of defLines) {
            if (y > bodyBottom) break;
            ctx.fillText(dl, margin, y);
            y += 18;
          }
          y += 35;
      }
      if (item.comment && y < bodyBottom - 40) {
          ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 14px "Courier New", monospace';
          ctx.fillText(">> USER_ANNOTATION:", margin, y); y += 20;
          ctx.fillStyle = '#b45309'; ctx.font = 'italic 14px "Courier New", monospace';
          for (const cl of commentLines) {
            if (y > bodyBottom) break;
            ctx.fillText(cl, margin, y);
            y += 18;
          }
          y += 35;
      }

      // Branding footer
      ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(margin, H - FOOTER_HEIGHT); ctx.lineTo(W - margin, H - FOOTER_HEIGHT); ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = '#00f3ff'; ctx.font = 'bold 13px "Courier New", monospace';
      ctx.fillText('DecodEbook', margin, H - 30);
      ctx.fillStyle = '#4a4a5a'; ctx.font = '11px "Courier New", monospace';
      ctx.fillText('decodebook.app', margin, H - 14);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#4a4a5a'; ctx.font = '11px "Courier New", monospace';
      ctx.fillText('Made with DecodEbook', W - margin, H - 22);

      return canvas;
  };

  const generateStickyNote = (item: NotebookItem) => {
      const canvas = buildStickyNoteCanvas(item);
      if (!canvas) return;
      const filename = `note-${item.type}-${titleCase(item.text.substring(0, 40), 30)}.png`;
      const link = document.createElement('a');
      link.download = filename;
      link.href = canvas.toDataURL();
      link.click();
      if (bookId) {
        canvas.toBlob((blob) => {
          if (blob) {
            const key = buildCacheKey(bookId, activeChapter?.id || 0, 'sticky-note', item.id);
            saveFile(key, blob, {
              filename,
              mimeType: 'image/png',
              timestamp: Date.now(),
              bookId,
              chapterId: activeChapter?.id || 0,
              componentSource: 'notebook',
              fileType: 'sticky-note',
            }).catch(e => console.warn('Cache save failed:', e));
          }
        }, 'image/png');
      }
  };

  const handleInitiateMindMap = async () => {
    if (isGeneratingMap) {
        abortMapRef.current = true;
        setIsGeneratingMap(false);
        return;
    }
    setIsGeneratingMap(true);
    setHasInitiatedMap(true);
    setMapZoom(1);
    setPan({ x: 0, y: 0 });
    setCollapsedNodeIds(new Set());
    abortMapRef.current = false;
    
    await new Promise(resolve => setTimeout(resolve, 800));
    
    try {
        const rootLabel = activeChapter?.title || bookTitle || "CATALOG_INDEX";

        const groups = {
            word: filteredItems.filter(i => i.type === 'word'),
            phrase: filteredItems.filter(i => i.type === 'phrase'),
            sentence: filteredItems.filter(i => i.type === 'sentence')
        };
        
        // Depth 4: Note Node (5th Layer)
        const createNoteNode = (item: NotebookItem): MindMapNode[] => {
            if (!item.comment) return [];
            return [{
                id: `${item.id}-note`,
                label: item.comment,
                note: null as any,
                type: 'detail',
                children: [] // Leaf
            }];
        };

        // Depth 3: Definition Node (4th Layer)
        const createDefinitionNode = (item: NotebookItem): MindMapNode => ({
            id: `${item.id}-def`,
            label: item.definition || "Analysis Pending...", // Body
            note: null as any, 
            type: 'detail',
            children: createNoteNode(item) // Nest note here as child
        });
        
        // Depth 2: Item Node (3rd Layer)
        const createCategoryNode = (label: string, items: NotebookItem[], catId: string): MindMapNode => ({
            id: catId,
            label: label,
            type: 'category',
            children: items.map(item => ({
                id: item.id,
                label: item.text,
                type: 'item',
                children: [createDefinitionNode(item)]
            }))
        });

        const children: MindMapNode[] = [];
        if (groups.word.length > 0) children.push(createCategoryNode('WORDS', groups.word, 'cat-word'));
        if (groups.phrase.length > 0) children.push(createCategoryNode('PHRASES', groups.phrase, 'cat-phrase'));
        if (groups.sentence.length > 0) children.push(createCategoryNode('SENTENCES', groups.sentence, 'cat-sentence'));

        const structure: MindMapNode = {
            id: 'root',
            label: rootLabel,
            type: 'root',
            children: children
        };

        if (abortMapRef.current) return;
        setMindMapData(structure);
        setIsMindMapMode(true);
    } catch (e) {
        if (!abortMapRef.current) console.error("Failed to generate mind map:", e);
    } finally {
        if (!abortMapRef.current) setIsGeneratingMap(false);
    }
  };

  const toggleNodeCollapse = (id: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      setCollapsedNodeIds(prev => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
      });
  };

  const layoutMap = useMemo(() => {
    if (!mindMapData) return { nodes: [], links: [] };
    
    // Increased gaps for better card visibility
    const GAP_X = 280;
    const GAP_Y = 40;

    // 1. Measure phase
    const measure = (node: MindMapNode, depth: number): any => {
        const fontSize = Math.max(10, 16 - depth * 1.5);
        const padding = 24;
        
        let width = 0;
        let height = 0;
        let lines: string[] = [];
        
        const isContainer = depth >= 2;
        const text = node.label || '';

        if (isContainer) {
             const maxWidth = 320; 
             
             // Estimation for Wrapping including CJK support
             let currentLine = '';
             let currentLineWidth = 0;
             lines = [];
             
             for (let i = 0; i < text.length; i++) {
                 const char = text[i];
                 // CJK chars are roughly 1em wide, latin roughly 0.6em
                 const charW = /[^\u0000-\u00ff]/.test(char) ? fontSize : fontSize * 0.6;
                 
                 if (currentLineWidth + charW > maxWidth - padding * 2) {
                     lines.push(currentLine);
                     currentLine = char;
                     currentLineWidth = charW;
                 } else {
                     currentLine += char;
                     currentLineWidth += charW;
                 }
             }
             if (currentLine) lines.push(currentLine);

             width = maxWidth;
             // Calculate height based on lines + padding + metadata space
             // Metadata (badge) ~ 20px, Spacing ~ 10px, Buffer ~ 30px
             height = (lines.length * (fontSize * 1.5)) + 80; 
        } else {
             // Text Nodes (Root & Categories)
             // Simple estimation
             let estimatedWidth = 0;
             for (let i = 0; i < text.length; i++) {
                estimatedWidth += /[^\u0000-\u00ff]/.test(text[i]) ? fontSize : fontSize * 0.65;
             }
             width = Math.max(100, estimatedWidth + padding * 2);
             if (width > 400) width = 400; // Cap width for very long root labels
             
             // Wrap if needed (simple)
             if (text.length > 50) {
                 lines = [text]; // Keep simple for root/category
             } else {
                 lines = [text];
             }
             height = (lines.length * (fontSize * 1.4)) + 20;
        }

        const isCollapsed = collapsedNodeIds.has(node.id);
        
        if (!node.children || node.children.length === 0 || isCollapsed) {
            return { node, width, height, outerHeight: height, children: [], lines };
        }

        const children = node.children.map(c => measure(c, depth + 1));
        const childrenTotalHeight = children.reduce((acc, c) => acc + c.outerHeight, 0) + (children.length - 1) * GAP_Y;
        
        return { 
            node, 
            width, 
            height, 
            outerHeight: Math.max(height, childrenTotalHeight), 
            children,
            lines
        };
    };

    const rootMetrics = measure(mindMapData, 0);

    // 2. Uniform Width per Layer Pass
    const depthMaxWidths = new Map<number, number>();
    const collectWidths = (metric: any, depth: number) => {
        const current = depthMaxWidths.get(depth) || 0;
        depthMaxWidths.set(depth, Math.max(current, metric.width));
        if (metric.children) metric.children.forEach((c: any) => collectWidths(c, depth + 1));
    };
    collectWidths(rootMetrics, 0);

    const applyWidths = (metric: any, depth: number) => {
        // Only apply uniform width for depths < 2 (Root & Categories)
        if (depth < 2) {
             metric.width = depthMaxWidths.get(depth) || metric.width;
        }
        if (metric.children) metric.children.forEach((c: any) => applyWidths(c, depth + 1));
    };
    applyWidths(rootMetrics, 0);

    // 3. Position phase
    const nodes: LayoutNode[] = [];
    const links: LayoutLink[] = [];

    const position = (item: any, x: number, y: number, depth: number, branchIndex: number) => {
        nodes.push({
            id: item.node.id,
            label: item.node.label,
            x,
            y,
            width: item.width,
            height: item.height,
            depth,
            branchIndex,
            data: item.node,
            isCollapsed: collapsedNodeIds.has(item.node.id),
            hasChildren: item.node.children && item.node.children.length > 0,
            lines: item.lines
        });

        if (item.children.length > 0) {
            let currentY = y - (item.outerHeight / 2);
            // Re-center children block if it's smaller than parent
            if (item.outerHeight < item.height) {
                 currentY = y - (item.outerHeight / 2);
            } else {
                 // Standard tree alignment: centers children block relative to parent center Y
                 currentY = y - (item.children.reduce((acc:number, c:any) => acc + c.outerHeight, 0) + (item.children.length - 1) * GAP_Y) / 2;
            }
            
            item.children.forEach((child: any, idx: number) => {
                const nextBranchIndex = depth === 0 ? idx : branchIndex;
                const childY = currentY + (child.outerHeight / 2);
                
                // Link Generation
                links.push({
                    id: `${item.node.id}-${child.node.id}`,
                    source: { x: x + item.width, y },
                    target: { x: x + item.width + GAP_X, y: childY },
                    branchIndex: nextBranchIndex,
                    depth
                });

                position(child, x + item.width + GAP_X, childY, depth + 1, nextBranchIndex);
                currentY += child.outerHeight + GAP_Y;
            });
        }
    };

    position(rootMetrics, 0, 0, 0, 0);

    return { nodes, links };
  }, [mindMapData, collapsedNodeIds]);

  const handleFitView = () => {
    if (layoutMap.nodes.length === 0) return;
    if (mapContainerRef.current) {
         setPan({ x: -100, y: 0 });
         setMapZoom(0.8);
    }
  };
  
  useEffect(() => {
     if (mindMapData) {
        setPan({ x: -50, y: 0 });
        setMapZoom(0.8);
     }
  }, [mindMapData]);

  const handleMapMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMapMouseMove = (e: React.MouseEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - lastMousePos.current.x;
    const dy = e.clientY - lastMousePos.current.y;
    setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMapMouseUp = () => {
    setIsPanning(false);
  };

  const exportToDocx = async () => {
    if (!mindMapData) return;
    
    const childrenToParagraphs = (node: MindMapNode, level: number): Paragraph[] => {
        const paras = [
             new Paragraph({
                text: node.label,
                heading: level === 0 ? HeadingLevel.TITLE : level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : undefined,
                bullet: level > 2 ? { level: 0 } : undefined,
             })
        ];
        if (node.children) {
            node.children.forEach(child => {
                paras.push(...childrenToParagraphs(child, level + 1));
            });
        }
        return paras;
    };

    const doc = new Document({
        sections: [{
            properties: {},
            children: childrenToParagraphs(mindMapData, 0),
        }],
    });

    const blob = await Packer.toBlob(doc);
    const filename = `mindmap-${titleCase(activeChapter?.title || bookTitle || 'export')}.docx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    if (bookId) {
      const key = buildCacheKey(bookId, activeChapter?.id || 0, 'mind-map-docx', String(Date.now()));
      saveFile(key, blob, {
        filename,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        timestamp: Date.now(),
        bookId,
        chapterId: activeChapter?.id || 0,
        componentSource: 'notebook',
        fileType: 'mind-map-docx',
      }).catch(e => console.warn('Cache save failed:', e));
    }
  };

  const exportToXmind = async () => {
    if (!mindMapData) return;
    
    const zip = new JSZip();
    const mapNodeToTopic = (node: MindMapNode): any => {
        const topic: any = {
            "id": node.id,
            "title": node.label,
            "structureClass": "org.xmind.ui.map.unbalanced"
        };
        if (node.children && node.children.length > 0) {
            topic["children"] = {
                "attached": node.children.map(mapNodeToTopic)
            };
        }
        return topic;
    };

    const content = [
        {
            "id": "sheet-1",
            "class": "sheet",
            "title": "Sheet 1",
            "rootTopic": mapNodeToTopic(mindMapData)
        }
    ];

    zip.file("content.json", JSON.stringify(content));
    zip.file("manifest.json", JSON.stringify({
        "file-entries": { "content.json": {}, "metadata.json": {} }
    }));
    zip.file("metadata.json", "{}");

    const blob = await zip.generateAsync({ type: "blob" });
    const filename = `mindmap-${titleCase(activeChapter?.title || bookTitle || 'export')}.xmind`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    if (bookId) {
      const key = buildCacheKey(bookId, activeChapter?.id || 0, 'mind-map-xmind', String(Date.now()));
      saveFile(key, blob, {
        filename,
        mimeType: 'application/x-xmind',
        timestamp: Date.now(),
        bookId,
        chapterId: activeChapter?.id || 0,
        componentSource: 'notebook',
        fileType: 'mind-map-xmind',
      }).catch(e => console.warn('Cache save failed:', e));
    }
  };

  const buildMindMapPdfBlob = async (): Promise<{ blob: Blob; filename: string } | null> => {
    if (!layoutMap.nodes.length) return null;

    try {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const node of layoutMap.nodes) {
            minX = Math.min(minX, node.x - 20);
            minY = Math.min(minY, node.y - node.height / 2 - 20);
            maxX = Math.max(maxX, node.x + node.width + 30);
            maxY = Math.max(maxY, node.y + node.height / 2 + 20);
        }
        for (const node of layoutMap.nodes) {
            if (node.hasChildren) {
                maxX = Math.max(maxX, node.x + node.width + 20);
            }
        }

        const NEON_BLUE_VAL = '#00f3ff';
        const NEON_GREEN_VAL = '#39ff14';
        const NEON_YELLOW_VAL = '#facc15';
        const NEON_RED_VAL = '#ff003c';

        const padding = 40;
        const fullW = maxX - minX + padding * 2;
        const fullH = maxY - minY + padding * 2;

        let svgParts: string[] = [];
        svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${fullW}" height="${fullH}" viewBox="${minX - padding} ${minY - padding} ${fullW} ${fullH}">`);
        svgParts.push(`<rect x="${minX - padding}" y="${minY - padding}" width="${fullW}" height="${fullH}" fill="#050505"/>`);
        svgParts.push(`<defs><filter id="neon-glow-pdf" x="-10000" y="-10000" width="20000" height="20000" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="3" result="coloredBlur"/><feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`);

        for (const link of layoutMap.links) {
            const pathD = `M ${link.source.x} ${link.source.y} C ${link.source.x + 80} ${link.source.y}, ${link.target.x - 80} ${link.target.y}, ${link.target.x} ${link.target.y}`;
            svgParts.push(`<path d="${pathD}" fill="none" stroke="${NEON_BLUE_VAL}" stroke-width="2" stroke-opacity="0.8" stroke-linecap="round" filter="url(#neon-glow-pdf)"/>`);
        }

        for (const node of layoutMap.nodes) {
            const isRoot = node.depth === 0;
            const fontSize = Math.max(12, 18 - node.depth * 2);
            const isContainer = node.depth >= 2;
            const ty = node.y - node.height / 2;

            let badgeColor = NEON_BLUE_VAL;
            let badgeText = "";
            if (node.depth === 2) { badgeText = "// ENTRY"; badgeColor = NEON_GREEN_VAL; }
            else if (node.depth === 3) { badgeText = "// DEFINITION"; badgeColor = NEON_YELLOW_VAL; }
            else if (node.depth === 4) { badgeText = "// USER_NOTE"; badgeColor = NEON_RED_VAL; }

            if (isContainer) {
                svgParts.push(`<rect x="${node.x}" y="${ty}" width="${node.width}" height="${node.height}" rx="8" ry="8" fill="#0a0a0c" stroke="${NEON_BLUE_VAL}50" stroke-width="1"/>`);
                svgParts.push(`<rect x="${node.x}" y="${ty}" width="4" height="${node.height}" rx="2" fill="${NEON_BLUE_VAL}"/>`);
                if (badgeText) {
                    svgParts.push(`<text x="${node.x + 16}" y="${ty + 20}" font-size="10" font-family="monospace" fill="${badgeColor}" letter-spacing="0.1em">${badgeText}</text>`);
                }
                const escapedLines = node.lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
                svgParts.push(`<text x="${node.x + 16}" y="${ty + 40}" font-size="13" font-family="sans-serif" fill="#d4d4d8">`);
                escapedLines.forEach((line, i) => {
                    svgParts.push(`<tspan x="${node.x + 16}" dy="${i === 0 ? 0 : '1.6em'}">${line}</tspan>`);
                });
                svgParts.push(`</text>`);
            } else {
                const escapedLines = node.lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
                svgParts.push(`<text x="${node.x + node.width / 2}" y="${ty + node.height / 2 + fontSize / 3}" text-anchor="middle" fill="${NEON_BLUE_VAL}" font-size="${fontSize}" font-family="monospace" font-weight="${isRoot ? '900' : 'bold'}">`);
                escapedLines.forEach((line, i) => {
                    svgParts.push(`<tspan x="${node.x + node.width / 2}" dy="${i === 0 ? 0 : '1.2em'}">${line}</tspan>`);
                });
                svgParts.push(`</text>`);
                if (!isRoot) {
                    svgParts.push(`<line x1="${node.x}" y1="${ty + node.height}" x2="${node.x + node.width}" y2="${ty + node.height}" stroke="${NEON_BLUE_VAL}" stroke-width="1" stroke-opacity="0.5"/>`);
                }
                if (node.hasChildren) {
                    const cx = node.x + node.width + 12;
                    const cy = node.y;
                    svgParts.push(`<circle cx="${cx}" cy="${cy}" r="4" fill="#050505" stroke="${NEON_BLUE_VAL}" stroke-width="1.5"/>`);
                    if (node.isCollapsed) {
                        svgParts.push(`<path d="M ${cx - 2} ${cy} L ${cx + 2} ${cy} M ${cx} ${cy - 2} L ${cx} ${cy + 2}" stroke="${NEON_BLUE_VAL}" stroke-width="1.5" stroke-linecap="round"/>`);
                    } else {
                        svgParts.push(`<path d="M ${cx - 2} ${cy} L ${cx + 2} ${cy}" stroke="${NEON_BLUE_VAL}" stroke-width="1.5" stroke-linecap="round"/>`);
                    }
                }
            }
        }

        svgParts.push(`</svg>`);
        const svgString = svgParts.join('');

        const scaleFactor = 3;
        const canvas = document.createElement('canvas');
        canvas.width = fullW * scaleFactor;
        canvas.height = fullH * scaleFactor;
        const ctx = canvas.getContext('2d')!;

        const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const svgUrl = URL.createObjectURL(svgBlob);
        const img = new Image();
        img.src = svgUrl;
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = reject;
        });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(svgUrl);

        const dataUrl = canvas.toDataURL('image/png');

        const isLandscape = fullW >= fullH;
        const doc = new jsPDF({
            orientation: isLandscape ? 'landscape' : 'portrait',
            unit: 'pt',
            format: [fullW, fullH],
        });

        doc.addImage(dataUrl, 'PNG', 0, 0, fullW, fullH);
        const filename = `mindmap-${titleCase(activeChapter?.title || bookTitle || 'export')}.pdf`;
        const pdfBlob = doc.output('blob');
        return { blob: pdfBlob, filename };
    } catch (e) {
        console.error("PDF generation failed:", e);
        return null;
    }
  };

  const exportToPdf = async () => {
    const result = await buildMindMapPdfBlob();
    if (!result) return;
    const { blob, filename } = result;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    if (bookId) {
        const key = buildCacheKey(bookId, activeChapter?.id || 0, 'mind-map-pdf', String(Date.now()));
        saveFile(key, blob, {
            filename,
            mimeType: 'application/pdf',
            timestamp: Date.now(),
            bookId,
            chapterId: activeChapter?.id || 0,
            componentSource: 'notebook',
            fileType: 'mind-map-pdf',
        }).catch(e => console.warn('Cache save failed:', e));
    }
  };

  return (
    <div className="h-full flex flex-col font-sans text-zinc-100 text-left relative overflow-hidden" style={fontStyle}>
       {/* Inject scrollbar hide styles for cleaner container look */}
       <style>{`
          .hide-scrollbar::-webkit-scrollbar { width: 4px; background: transparent; }
          .hide-scrollbar:hover::-webkit-scrollbar { background: rgba(255, 255, 255, 0.05); }
          .hide-scrollbar::-webkit-scrollbar-thumb { background: transparent; border-radius: 4px; }
          .hide-scrollbar:hover::-webkit-scrollbar-thumb { background: rgba(0, 243, 255, 0.3); }
       `}</style>

       <div className="hud-panel mb-1.5 md:mb-2 flex items-center justify-between shrink-0 w-full flex-wrap gap-2 z-20">
           <div className="hidden md:flex items-center gap-4">
               <div className="flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-[11px]">
                   <NotebookIcon size={16} className="text-neon-cyan" />
                   <span>Mem_Log</span>
               </div>
           </div>
           <div className="flex items-center gap-2 md:gap-3 flex-1 md:flex-none justify-between md:justify-end">
               <div className="select-group">
                    <div className="flex items-center gap-1 md:gap-1.5">
                        <div className="p-1 md:p-1.5 text-zinc-500"><BookOpen size={13} /></div>
                        <select
                            value={activeBookFilter}
                            onChange={(e) => setActiveBookFilter(e.target.value)}
                            className="bg-transparent text-[10px] md:text-[11px] text-neon-cyan outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[112px] bg-void-1"
                        >
                            <option value="all">ALL BOOKS</option>
                            {bookTitles.map(t => <option key={t} value={t}>{t.length > 15 ? t.substring(0, 15) + '...' : t}</option>)}
                        </select>
                    </div>
                    <div className="w-[1px] h-3.5 bg-zinc-700"></div>
                    <div className="flex items-center gap-1 md:gap-1.5">
                        <div className="p-1 md:p-1.5 text-zinc-500"><Settings2 size={13} /></div>
                        <select
                            value={activeFilter}
                            onChange={(e) => setActiveFilter(e.target.value as FilterType)}
                            className="bg-transparent text-[10px] md:text-[11px] text-neon-cyan outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[112px] bg-void-1"
                        >
                            <option value="all">ALL ITEMS</option>
                            <option value="word">WORDS</option>
                            <option value="phrase">PHRASES</option>
                            <option value="sentence">SENTENCES</option>
                        </select>
                    </div>
               </div>

               <button
                  onClick={handleInitiateMindMap}
                  disabled={filteredItems.length === 0}
                  className={`btn-action ${isGeneratingMap ? 'btn-stop' : 'btn-go'}`}
               >
                   {isGeneratingMap ? <Square size={13} fill="currentColor" /> : hasInitiatedMap ? <RefreshCw size={13} /> : <Play size={13} fill="currentColor" />}
                   {isGeneratingMap ? "STOP" : hasInitiatedMap ? "REGENERATE" : "INITIATE"}
               </button>
           </div>
       </div>

       {isMindMapMode ? (
           <div 
             className="flex-1 bg-void-1 border border-zinc-800 rounded-lg relative overflow-hidden flex flex-col items-center justify-center animate-fade-in group" 
             ref={mapContainerRef}
             onMouseDown={handleMapMouseDown}
             onMouseMove={handleMapMouseMove}
             onMouseUp={handleMapMouseUp}
             onMouseLeave={handleMapMouseUp}
             onWheel={(e) => setMapZoom(z => Math.max(0.2, Math.min(3, z - e.deltaY * 0.001)))}
           >
               {/* Background Grid */}
               <div className="absolute inset-0 bg-[linear-gradient(rgba(0,243,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(0,243,255,0.05)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none"></div>
               
               {/* Floating Controls in Top Right */}
               <div className="absolute top-2 right-2 md:top-4 md:right-4 flex flex-wrap justify-end gap-1.5 md:gap-2 z-50 max-w-[calc(100%-16px)] md:max-w-none">
                    <button onClick={handleFitView} className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center bg-void-1 border border-zinc-800 hover:border-neon-cyan text-zinc-400 hover:text-neon-cyan rounded-full transition-colors shadow-lg shrink-0" title="Fit View"><Scan size={14}/></button>
                    <button onClick={() => setMapZoom(z => Math.max(0.2, z - 0.1))} aria-label="Zoom out" className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center bg-void-1 border border-zinc-800 hover:border-neon-cyan text-zinc-400 hover:text-neon-cyan rounded-full transition-colors shadow-lg shrink-0"><ZoomOut size={14}/></button>
                    <button onClick={() => setMapZoom(z => Math.min(3, z + 0.1))} aria-label="Zoom in" className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center bg-void-1 border border-zinc-800 hover:border-neon-cyan text-zinc-400 hover:text-neon-cyan rounded-full transition-colors shadow-lg shrink-0"><ZoomIn size={14}/></button>
                    <div className="hidden md:block w-[1px] h-10 bg-zinc-800 mx-0.5"></div>
                    <button onClick={exportToXmind} className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center bg-void-1 border border-zinc-800 hover:border-neon-cyan text-zinc-400 hover:text-neon-cyan rounded-full transition-colors shadow-lg shrink-0" title="Export to Xmind"><Network size={14}/></button>
                    <button onClick={exportToDocx} className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center bg-void-1 border border-zinc-800 hover:border-neon-cyan text-zinc-400 hover:text-neon-cyan rounded-full transition-colors shadow-lg shrink-0" title="Export to Docx"><FileText size={14}/></button>
                    <button onClick={exportToPdf} className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center bg-void-1 border border-zinc-800 hover:border-neon-cyan text-zinc-400 hover:text-neon-cyan rounded-full transition-colors shadow-lg shrink-0" title="Export to PDF"><FileDown size={14}/></button>
                    <button onClick={async () => { const result = await buildMindMapPdfBlob(); if (result) shareFile(result.blob, result.filename, `Mind Map - ${activeChapter?.title || bookTitle || 'DecodEbook'}`); }} className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center bg-void-1 border border-zinc-800 hover:border-neon-cyan text-zinc-400 hover:text-neon-cyan rounded-full transition-colors shadow-lg shrink-0" title="Share"><Share2 size={14}/></button>
                    <button onClick={() => setIsMindMapMode(false)} className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center bg-void-1 border border-zinc-800 hover:border-neon-red text-neon-red rounded-full transition-colors shadow-lg shrink-0" title="Exit Map"><X size={14}/></button>
               </div>

               {isGeneratingMap ? (
                   <div className="flex flex-col items-center gap-4 z-10">
                       <Loader2 size={48} className="text-neon-cyan animate-spin" />
                       <p className="text-sm font-mono text-neon-cyan uppercase tracking-widest animate-pulse">Analyzing Neural Structures...</p>
                   </div>
               ) : mindMapData ? (
                   <div className="w-full h-full overflow-hidden flex items-center justify-center cursor-grab active:cursor-grabbing">
                       <svg 
                        width="100%" 
                        height="100%"
                        style={{ pointerEvents: 'none' }}
                       >
                         <defs>
                            <filter id="neon-glow" x="-10000" y="-10000" width="20000" height="20000" filterUnits="userSpaceOnUse">
                                <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
                                <feMerge>
                                    <feMergeNode in="coloredBlur"/>
                                    <feMergeNode in="SourceGraphic"/>
                                </feMerge>
                            </filter>
                         </defs>
                         <g 
                            style={{ 
                                transform: `translate(${pan.x}px, ${pan.y}px) scale(${mapZoom})`, 
                                transition: isPanning ? 'none' : 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                                transformOrigin: 'center',
                                pointerEvents: 'auto',
                                willChange: 'transform'
                            }}
                         >
                            {/* Render Links First */}
                            {layoutMap.links.map(link => {
                                const pathD = `M ${link.source.x} ${link.source.y} C ${link.source.x + 80} ${link.source.y}, ${link.target.x - 80} ${link.target.y}, ${link.target.x} ${link.target.y}`;
                                return (
                                    <path 
                                        key={link.id}
                                        d={pathD}
                                        fill="none"
                                        stroke={NEON_BLUE}
                                        strokeWidth={2}
                                        strokeOpacity="0.8"
                                        strokeLinecap="round"
                                        filter="url(#neon-glow)"
                                    />
                                );
                            })}

                            {/* Render Nodes */}
                            {layoutMap.nodes.map(node => {
                                const isRoot = node.depth === 0;
                                const fontSize = Math.max(12, 18 - node.depth * 2);
                                
                                const isContainer = node.depth >= 2;
                                
                                let badgeColor = NEON_BLUE;
                                let badgeText = "";
                                if (node.depth === 2) { badgeText = "// ENTRY"; badgeColor = NEON_GREEN; }
                                else if (node.depth === 3) { badgeText = "// DEFINITION"; badgeColor = NEON_YELLOW; }
                                else if (node.depth === 4) { badgeText = "// USER_NOTE"; badgeColor = NEON_RED; }

                                return (
                                    <g 
                                        key={node.id} 
                                        transform={`translate(${node.x},${node.y - node.height / 2})`}
                                        className="cursor-pointer"
                                        onClick={(e) => node.hasChildren ? toggleNodeCollapse(node.id, e) : null}
                                    >
                                        {isContainer ? (
                                            <>
                                                {/* Card background */}
                                                <rect
                                                    x={0} y={0}
                                                    width={node.width} height={node.height}
                                                    rx={8} ry={8}
                                                    fill="#0a0a0c"
                                                    stroke={`${NEON_BLUE}50`}
                                                    strokeWidth={1}
                                                />
                                                {/* Left accent bar */}
                                                <rect x={0} y={0} width={4} height={node.height} rx={2} fill={NEON_BLUE} />
                                                {/* Badge */}
                                                <text
                                                    x={16} y={20}
                                                    fontSize={10}
                                                    fontFamily="Share Tech Mono, monospace"
                                                    fill={badgeColor}
                                                    letterSpacing="0.1em"
                                                >
                                                    {badgeText}
                                                </text>
                                                {/* Body text */}
                                                <text
                                                    x={16} y={40}
                                                    fontSize={13}
                                                    fontFamily="sans-serif"
                                                    fill="#d4d4d8"
                                                >
                                                    {node.lines.map((line, i) => (
                                                        <tspan x={16} dy={i === 0 ? 0 : '1.6em'} key={i}>{line}</tspan>
                                                    ))}
                                                </text>
                                            </>
                                        ) : (
                                            <>
                                                {/* Invisible Hit Area */}
                                                <rect 
                                                    x={-10} 
                                                    y={-5} 
                                                    width={node.width + 20} 
                                                    height={node.height + 10} 
                                                    fill="transparent" 
                                                />
                                                
                                                <text 
                                                    x={node.width / 2} 
                                                    y={node.height / 2 + fontSize / 3} 
                                                    textAnchor="middle"
                                                    fill={NEON_BLUE} 
                                                    fontSize={fontSize} 
                                                    fontFamily="Share Tech Mono, monospace"
                                                    fontWeight={isRoot ? '900' : 'bold'}
                                                    pointerEvents="none"
                                                >
                                                    {node.lines.map((line, i) => (
                                                        <tspan x={node.width / 2} dy={i === 0 ? 0 : '1.2em'} key={i}>{line}</tspan>
                                                    ))}
                                                </text>

                                                {!isRoot && (
                                                    <line 
                                                        x1={0} y1={node.height} 
                                                        x2={node.width} y2={node.height} 
                                                        stroke={NEON_BLUE} 
                                                        strokeWidth={1}
                                                        strokeOpacity={0.5}
                                                    />
                                                )}
                                                
                                                {/* Expansion Indicator */}
                                                {node.hasChildren && (
                                                    <g transform={`translate(${node.width + 12}, ${node.height / 2})`}>
                                                        <circle r="4" fill="#050505" stroke={NEON_BLUE} strokeWidth="1.5" />
                                                        {node.isCollapsed ? (
                                                            <path d="M -2 0 L 2 0 M 0 -2 L 0 2" stroke={NEON_BLUE} strokeWidth="1.5" strokeLinecap="round" />
                                                        ) : (
                                                             <path d="M -2 0 L 2 0" stroke={NEON_BLUE} strokeWidth="1.5" strokeLinecap="round" />
                                                        )}
                                                    </g>
                                                )}
                                            </>
                                        )}
                                    </g>
                                );
                            })}
                         </g>
                       </svg>
                   </div>
               ) : (
                   <div className="text-zinc-500 font-mono text-sm">FAILED_TO_RENDER_MAP</div>
               )}
           </div>
       ) : (
           <>
               {isGeneratingMap ? (
                   <div className="flex-1 flex flex-col items-center justify-center animate-fade-in">
                       <Loader text="GENERATING_MAP..." />
                   </div>
               ) : items.length === 0 ? (
                   <EmptyState icon={Book} label="NO_DATA_LOGGED" sublabel="Right-click text selection in reader to populate your lexicon." className="flex-1 animate-fade-in" />
               ) : filteredItems.length === 0 ? (
                   <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 font-mono gap-2 animate-fade-in"><p className="text-xs uppercase tracking-widest opacity-50">BUFFER_EMPTY_FOR_{activeFilter === 'all' ? 'ALL_ITEMS' : activeFilter.toUpperCase() + 'S'}</p></div>
               ) : (
                   <div className="flex-1 overflow-y-auto pr-2 pb-10 custom-scrollbar space-y-4 content-font">
                       {filteredItems.map((item, idx) => {
                           const typeColor = item.type === 'phrase' ? 'text-neon-red' : item.type === 'word' ? 'text-cyan-400' : 'text-neon-cyan';
                           const inkBadgeClass = INK_BADGE_STYLES[settings.highlightColor] || INK_BADGE_STYLES.indigo;
                           return (
                           <div key={item.id} className="bg-void-2 border rounded-lg p-5 relative group transition-all animate-fade-in-up pr-14 border-zinc-800 hover:border-zinc-700" style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}>
                               <div className="absolute top-2 right-2 flex flex-col gap-1 z-20">
	                                   <button onClick={() => playPronunciation(item.id, item.text)} onPointerEnter={() => prefetchNotebookPronunciation(item.text, false)} onFocus={() => prefetchNotebookPronunciation(item.text, false)} onPointerDown={(e) => { if (e.pointerType === 'touch') prefetchNotebookPronunciation(item.text, true); }} disabled={!!playingId} className={`p-1.5 rounded border border-transparent transition-all mb-1 ${playingId === item.id ? 'text-neon-cyan bg-neon-cyan/10 animate-pulse' : 'text-zinc-600 hover:text-neon-cyan bg-zinc-900/50 hover:bg-neon-cyan/10'}`} title="Pronounce"><Volume2 size={14} /></button>
                                   <button onClick={() => generateStickyNote(item)} className="p-1.5 text-zinc-600 hover:text-neon-cyan bg-zinc-900/50 hover:bg-neon-cyan/10 rounded border border-transparent hover:border-neon-cyan/20 transition-all" title="Download Visual"><ImageDown size={14} /></button>
                                   <button onClick={() => { const canvas = buildStickyNoteCanvas(item); if (!canvas) return; canvas.toBlob((blob) => { if (blob) { const fn = `note-${item.type}-${titleCase(item.text.substring(0, 40), 30)}.png`; shareFile(blob, fn, item.text.substring(0, 50)); } }, 'image/png'); }} className="p-1.5 text-zinc-600 hover:text-neon-cyan bg-zinc-900/50 hover:bg-neon-cyan/10 rounded border border-transparent hover:border-neon-cyan/20 transition-all" title="Share"><Share2 size={14} /></button>
                                   <button onClick={() => onDelete(item.id)} className="p-1.5 text-zinc-600 hover:text-neon-red bg-zinc-900/50 hover:bg-neon-red/10 rounded border border-transparent hover:border-neon-red/20 transition-all" title="Purge Entry"><Trash2 size={14} /></button>
                               </div>
                               <div className="flex items-start gap-4">
                                   <div className="mt-1 shrink-0">{item.type === 'sentence' ? <Quote size={16} className="text-neon-cyan" /> : item.type === 'phrase' ? <Zap size={16} className="text-neon-red" /> : <Type size={16} className="text-cyan-400" />}</div>
                                   <div className="flex-1 min-w-0 space-y-3">
                                       <div><p className="text-white text-base font-medium leading-relaxed font-serif break-words"><span style={item.inked ? inkLineStyle(settings.inkLine || 'full', INK_LINE_COLORS[settings.highlightColor] || INK_LINE_COLORS.indigo) : undefined}>{item.text}</span></p>
                                           <div className="flex items-center gap-3 mt-2 flex-wrap">
                                               <span className={`text-[9px] font-mono uppercase tracking-wide bg-zinc-900 px-1.5 py-0.5 rounded border border-zinc-800 ${typeColor}`}>{item.type}</span>
                                               {item.inked && <span className={`text-[9px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border ${inkBadgeClass}`}>INKED</span>}
                                               {item.bookTitle && <span className="text-[10px] font-mono text-cyan-500/60 truncate max-w-[150px]">{item.bookTitle}</span>}
                                               {item.sourceChapter && <span className="text-[10px] font-mono text-zinc-600 truncate max-w-[200px]">CH: {item.sourceChapter}</span>}
                                               <span className="text-[10px] font-mono text-zinc-500 flex items-center gap-1"><Clock size={10} />{new Date(item.timestamp).toLocaleDateString()}</span>
                                           </div>
                                       </div>
                                       {item.definition && (
                                           <div className="bg-black/50 p-3 rounded border border-zinc-900"><p className="text-sm text-zinc-500 italic font-mono leading-relaxed">{item.definition}</p></div>
                                       )}
                                       <div className="mt-2"><textarea placeholder="Add neural annotations..." value={item.comment || ''} onChange={(e) => onUpdateComment(item.id, e.target.value)} className="w-full bg-void-1 border border-zinc-800 rounded p-2 text-xs text-zinc-400 focus:border-neon-cyan focus:outline-none transition-colors min-h-[50px] font-mono" /></div>
                                   </div>
                               </div>
                           </div>
                           );
                       })}
                   </div>
               )}
           </>
       )}
    </div>
  );
};
