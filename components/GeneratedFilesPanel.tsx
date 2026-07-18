
import React, { useState, useEffect, useCallback } from 'react';
import { HardDrive, Headphones, Mic2, Film, Image as ImageIcon, Download, Trash2, AlertTriangle, FileText, Notebook as NotebookIcon, Map, FileDown, Save, Share2, Languages, File as FileIcon } from 'lucide-react';
import { CachedFileMetadata, LibraryItem } from '../types';
import { EmptyState } from './ui/EmptyState';
import { listFiles, deleteFile, getFile, clearAll, clearBook } from '../services/fileCache';
import { shareFile } from '../utils/share';
import { titleCase } from '../utils/filename';
import JSZip from 'jszip';

interface Props {
  library: LibraryItem[];
}

type FilterType = 'all' | 'audio' | 'podcast-audio' | 'podcast-script' | 'video' | 'concept-image' | 'notebook' | 'chapter-text' | 'translation';

// Each of the 7 generated-file types is coloured by its position in the Highlight_Hue palette
// (SettingsModal COLORS): 1 indigo/neon-cyan, 2 emerald, 3 rose/neon-red, 4 amber, 5 violet,
// 6 pink/neon-pink, 7 yellow/neon-yellow — in the type order Translation, Audio, Podcast,
// Scripts, Images, Video, Notebook. Notebook's sub-types all share hue 7.
const FILE_TYPE_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  'translation': { icon: <Languages size={14} />, label: 'TRANSLATION', color: 'text-neon-cyan' },
  'audio': { icon: <Headphones size={14} />, label: 'VOICE_SYNTH', color: 'text-emerald-400' },
  'podcast-audio': { icon: <Mic2 size={14} />, label: 'NET_CAST', color: 'text-neon-red' },
  'podcast-script': { icon: <FileText size={14} />, label: 'NET_SCRIPT', color: 'text-amber-400' },
  'concept-image': { icon: <ImageIcon size={14} />, label: 'VISUAL_CORE', color: 'text-violet-400' },
  'video': { icon: <Film size={14} />, label: 'CINE_RENDER', color: 'text-neon-pink' },
  'sticky-note': { icon: <NotebookIcon size={14} />, label: 'MEM_LOG', color: 'text-neon-yellow' },
  'notebook-figure': { icon: <ImageIcon size={14} />, label: 'FIGURE', color: 'text-neon-yellow' },
  'mind-map-pdf': { icon: <Map size={14} />, label: 'MAP_PDF', color: 'text-neon-yellow' },
  'mind-map-docx': { icon: <FileDown size={14} />, label: 'MAP_DOCX', color: 'text-neon-yellow' },
  'mind-map-xmind': { icon: <Map size={14} />, label: 'MAP_XMIND', color: 'text-neon-yellow' },
};

// Fallback for any type without a config — a generic file glyph, NOT the audio headphones.
const DEFAULT_FILE_CONFIG = { icon: <FileIcon size={14} />, label: 'FILE', color: 'text-zinc-400' };

// Internal caches/extractions, not user-generated outputs — hidden from the panel (the reader's
// per-chapter extracted text, the uploaded source blob, and auto-extracted source figure images).
const HIDDEN_TYPES = ['chapter-text', 'source-file', 'figure-image'];

// The badge on each item names the MODULE that produced the file (its componentSource), not the file
// type — e.g. a translation JSON made inside the reader shows VOICE_SYNTH, not TRANSLATION. The file
// type is already conveyed by the icon (colour + glyph) and the type filter.
const MODULE_LABELS: Record<string, string> = {
  'audiobook': 'VOICE_SYNTH',
  'Reader_Figure': 'VOICE_SYNTH',   // figures translated/redrawn inside the reader
  'podcast': 'NET_CAST',
  'video': 'CINE_RENDER',
  'visualizer': 'VISUAL_CORE',
  'notebook': 'MEM_LOG',
  'PDF_Extraction': 'SOURCE',
  'source-cache': 'SOURCE',
};
const moduleLabel = (src?: string) => (src && MODULE_LABELS[src]) || (src || 'FILE').toUpperCase();

const FILTER_OPTIONS: { value: FilterType; label: string }[] = [
  { value: 'all', label: 'ALL' },
  { value: 'translation', label: 'TRANSLATION' },
  { value: 'audio', label: 'AUDIO' },
  { value: 'podcast-audio', label: 'PODCAST' },
  { value: 'podcast-script', label: 'SCRIPTS' },
  { value: 'concept-image', label: 'IMAGES' },
  { value: 'video', label: 'VIDEO' },
  { value: 'notebook', label: 'NOTEBOOK' },
];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

export const GeneratedFilesPanel: React.FC<Props> = ({ library }) => {
  const [files, setFiles] = useState<CachedFileMetadata[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [filterBook, setFilterBook] = useState<string>('all');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const [actionMode, setActionMode] = useState<'clear' | 'save'>('save');

  const loadFiles = useCallback(async () => {
    try {
      // Load ALL files ONCE (a single cursor); book + type filtering happens client-side below, so
      // switching either scope is instant with no re-query. Also derive the total size from the list
      // instead of a SECOND full-store cursor (getTotalSize) — together these were reading every record
      // (blobs and all) twice per load, which made the panel sit empty for seconds.
      const allFiles = await listFiles();
      const visible = allFiles.filter(f => !HIDDEN_TYPES.includes(f.fileType));
      setFiles(visible.sort((a, b) => b.timestamp - a.timestamp));
      setTotalSize(visible.reduce((s, f) => s + (f.size || 0), 0));
    } catch (e) {
      console.error('Failed to load cached files:', e);
    }
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const NOTEBOOK_TYPES = ['sticky-note', 'notebook-figure', 'mind-map-pdf', 'mind-map-docx', 'mind-map-xmind'];
  const filteredFiles = files.filter(f => {
    if (filterBook !== 'all' && f.bookId !== filterBook) return false;
    if (filterType === 'all') return true;
    if (filterType === 'notebook') return NOTEBOOK_TYPES.includes(f.fileType);
    return f.fileType === filterType;
  });

  const handleDownload = async (file: CachedFileMetadata) => {
    try {
      const cached = await getFile(file.key);
      if (!cached) return;
      const url = URL.createObjectURL(cached.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Download failed:', e);
    }
  };

  const handleDelete = async (key: string) => {
    try {
      await deleteFile(key);
      await loadFiles();
    } catch (e) {
      console.error('Delete failed:', e);
    }
  };

  const handleClearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    try {
      if (filterBook !== 'all') {
        await clearBook(filterBook);
      } else {
        await clearAll();
      }
      setConfirmClear(false);
      await loadFiles();
    } catch (e) {
      console.error('Clear failed:', e);
    }
  };

  const handleSaveAll = async () => {
    if (filteredFiles.length === 0) return;
    try {
      const zip = new JSZip();
      for (const file of filteredFiles) {
        const cached = await getFile(file.key);
        if (cached) zip.file(file.filename, cached.blob);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const bookLabel = filterBook !== 'all' ? titleCase(getBookTitle(filterBook)) : 'AllBooks';
      const typeLabel = filterType !== 'all' ? titleCase(filterType, 20) : 'AllTypes';
      a.download = `archive-${typeLabel}-${bookLabel}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Save all failed:', e);
    }
  };

  const getBookTitle = (bookId: string) => {
    const item = library.find(l => l.book.id === bookId);
    return item?.book.title || bookId.substring(0, 8);
  };

  return (
    <div className="h-full flex flex-col animate-fade-in font-sans text-left overflow-hidden">
      {/* Controller */}
      <div className="hud-panel mb-1.5 md:mb-2 flex items-center justify-between shrink-0 w-full flex-wrap gap-2 z-20">
        <div className="hidden md:flex items-center gap-4">
          <div className="flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-[11px]">
            <HardDrive size={16} className="text-neon-cyan" />
            <span>Generated_Files</span>
          </div>
          <span className="text-[10px] font-mono text-zinc-600 uppercase">{formatFileSize(totalSize)} // {files.length} files</span>
        </div>
        <div className="flex items-center gap-2 md:gap-3 flex-1 md:flex-none justify-between md:justify-end">
          <div className="select-group">
            <div className="p-1 md:p-1.5 text-zinc-500"><HardDrive size={13} /></div>
            <select
              value={filterBook}
              onChange={(e) => setFilterBook(e.target.value)}
              className="bg-transparent text-[10px] md:text-[11px] text-neon-cyan outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[112px] bg-void-1"
            >
              <option value="all">ALL BOOKS</option>
              {library.map(item => (
                <option key={item.book.id} value={item.book.id}>
                  {item.book.title.substring(0, 15)}
                </option>
              ))}
            </select>
            <div className="w-[1px] h-3.5 bg-zinc-700"></div>
            <div className="p-1 md:p-1.5 text-zinc-500"><FileText size={13} /></div>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as FilterType)}
              className="bg-transparent text-[10px] md:text-[11px] text-neon-cyan outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[112px] bg-void-1"
            >
              {FILTER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => {
              if (actionMode === 'clear') {
                if (confirmClear) { handleClearAll(); }
                else { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 3000); }
              } else {
                handleSaveAll();
              }
            }}
            onContextMenu={(e) => { e.preventDefault(); setActionMode(actionMode === 'save' ? 'clear' : 'save'); setConfirmClear(false); }}
            disabled={actionMode === 'save' && filteredFiles.length === 0}
            className={`flex items-center gap-1.5 md:gap-2 px-2.5 md:px-3.5 py-1 rounded-sm text-[10px] md:text-[11px] font-bold font-mono uppercase transition-all justify-center min-w-[104px] md:min-w-[122px] border disabled:opacity-50 ${
              actionMode === 'clear'
                ? confirmClear
                  ? 'bg-neon-red text-white border-neon-red animate-pulse hover:bg-rose-600'
                  : 'text-neon-red border-neon-red/30 hover:bg-neon-red/10'
                : 'text-neon-cyan border-neon-cyan/30 hover:bg-neon-cyan/10'
            }`}
            title="Right-click to switch between Save and Clear mode"
          >
            {actionMode === 'clear' ? <Trash2 size={13} /> : <Save size={13} />}
            {actionMode === 'clear' ? (confirmClear ? 'CONFIRM?' : 'CLEAR_ALL') : 'SAVE_ALL'}
          </button>
        </div>
      </div>

      {/* File List */}
      <div className="flex-1 overflow-y-auto space-y-1 custom-scrollbar">
        {filteredFiles.length === 0 ? (
          <EmptyState icon={HardDrive} label="Cache_Empty" sublabel="Generated files will appear here after creation" className="h-full" />
        ) : (
          filteredFiles.map((file, i) => {
            const config = FILE_TYPE_CONFIG[file.fileType] || DEFAULT_FILE_CONFIG;
            return (
              <div
                key={file.key}
                style={{ animationDelay: `${Math.min(i * 12, 120)}ms` }}
                className="content-panel rounded-sm px-3 py-1.5 flex items-center gap-3 hover:border-zinc-700 hover:bg-zinc-900/40 active:border-zinc-600 transition-all group animate-fade-in-up"
              >
                {/* Icon */}
                <div className={`w-7 h-7 rounded-sm bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 ${config.color}`}>
                  {config.icon}
                </div>

                {/* File Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs md:text-sm text-zinc-200 font-medium truncate">{file.filename}</span>
                    <span className={`hidden md:inline text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-full border border-zinc-800 shrink-0 ${config.color}`}>
                      {moduleLabel(file.componentSource)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] md:text-[10px] font-mono text-zinc-600">
                    <span className={`md:hidden ${config.color}`}>{moduleLabel(file.componentSource)}</span>
                    <span>{formatFileSize(file.size)}</span>
                    <span className="hidden md:inline text-zinc-500">|</span>
                    <span className="truncate max-w-[100px] md:max-w-[150px]">{getBookTitle(file.bookId)}</span>
                    <span className="hidden md:inline text-zinc-500">|</span>
                    <span>{formatDate(file.timestamp)}</span>
                  </div>
                </div>

                {/* Actions — always visible on mobile */}
                <div className="flex items-center gap-0.5 md:gap-1 shrink-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleDownload(file)}
                    className="p-1.5 md:p-2 text-zinc-600 hover:text-neon-cyan hover:bg-zinc-900 rounded-sm transition-all"
                    title="Download"
                  >
                    <Download size={14} />
                  </button>
                  <button
                    onClick={async () => { const cached = await getFile(file.key); if (cached) shareFile(cached.blob, file.filename, file.filename); }}
                    className="p-1.5 md:p-2 text-zinc-600 hover:text-neon-cyan hover:bg-zinc-900 rounded-sm transition-all"
                    title="Share"
                  >
                    <Share2 size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(file.key)}
                    className="p-1.5 md:p-2 text-zinc-600 hover:text-neon-red hover:bg-zinc-900 rounded-sm transition-all"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
