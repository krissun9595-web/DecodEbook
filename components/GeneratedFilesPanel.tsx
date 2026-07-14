
import React, { useState, useEffect, useCallback } from 'react';
import { HardDrive, Headphones, Mic2, Film, Image as ImageIcon, Download, Trash2, AlertTriangle, FileText, StickyNote, Map, FileDown, Save, Share2 } from 'lucide-react';
import { CachedFileMetadata, LibraryItem } from '../types';
import { listFiles, deleteFile, getFile, clearAll, clearBook, getTotalSize } from '../services/fileCache';
import { shareFile } from '../utils/share';
import { titleCase } from '../utils/filename';
import JSZip from 'jszip';

interface Props {
  library: LibraryItem[];
}

type FilterType = 'all' | 'audio' | 'podcast-audio' | 'podcast-script' | 'video' | 'concept-image' | 'notebook' | 'chapter-text' | 'translation';

const FILE_TYPE_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  'audio': { icon: <Headphones size={14} />, label: 'VOICE_SYNTH', color: 'text-cyan-400' },
  'podcast-audio': { icon: <Mic2 size={14} />, label: 'NET_CAST', color: 'text-purple-400' },
  'podcast-script': { icon: <FileText size={14} />, label: 'NET_SCRIPT', color: 'text-purple-300' },
  'video': { icon: <Film size={14} />, label: 'CINE_RENDER', color: 'text-rose-400' },
  'concept-image': { icon: <ImageIcon size={14} />, label: 'VISUAL_CORE', color: 'text-amber-400' },
  'sticky-note': { icon: <StickyNote size={14} />, label: 'MEM_LOG', color: 'text-green-400' },
  'notebook-figure': { icon: <ImageIcon size={14} />, label: 'FIGURE', color: 'text-green-300' },
  'mind-map-pdf': { icon: <Map size={14} />, label: 'MAP_PDF', color: 'text-sky-400' },
  'mind-map-docx': { icon: <FileDown size={14} />, label: 'MAP_DOCX', color: 'text-blue-400' },
  'mind-map-xmind': { icon: <Map size={14} />, label: 'MAP_XMIND', color: 'text-teal-400' },
};

const FILTER_OPTIONS: { value: FilterType; label: string }[] = [
  { value: 'all', label: 'ALL' },
  { value: 'audio', label: 'AUDIO' },
  { value: 'podcast-audio', label: 'PODCAST' },
  { value: 'podcast-script', label: 'SCRIPTS' },
  { value: 'video', label: 'VIDEO' },
  { value: 'concept-image', label: 'IMAGES' },
  { value: 'notebook', label: 'NOTEBOOK' },
];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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
      const bookId = filterBook === 'all' ? undefined : filterBook;
      const allFiles = await listFiles(bookId);
      setFiles(allFiles.sort((a, b) => b.timestamp - a.timestamp));
      setTotalSize(await getTotalSize());
    } catch (e) {
      console.error('Failed to load cached files:', e);
    }
  }, [filterBook]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const NOTEBOOK_TYPES = ['sticky-note', 'notebook-figure', 'mind-map-pdf', 'mind-map-docx', 'mind-map-xmind'];
  const filteredFiles = filterType === 'all'
    ? files
    : filterType === 'notebook'
      ? files.filter(f => NOTEBOOK_TYPES.includes(f.fileType))
      : files.filter(f => f.fileType === filterType);

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
      <div className="bg-zinc-950/80 p-1.5 md:p-2 rounded-lg border border-cyan-900/40 mb-1.5 md:mb-2 flex items-center justify-between shrink-0 shadow-glow-ambient w-full flex-wrap gap-2 z-20">
        <div className="hidden md:flex items-center gap-4">
          <div className="flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-[11px]">
            <HardDrive size={16} className="text-neon-cyan" />
            <span>Generated_Files</span>
          </div>
          <span className="text-[10px] font-mono text-zinc-600 uppercase">{formatFileSize(totalSize)} // {files.length} files</span>
        </div>
        <div className="flex items-center gap-2 md:gap-3 flex-1 md:flex-none justify-between md:justify-end">
          <div className="flex items-center gap-1 md:gap-1.5 bg-black/50 p-1 rounded-sm border border-zinc-800">
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
            className={`flex items-center gap-1.5 md:gap-2 px-2.5 md:px-3.5 py-1 rounded-sm text-[10px] md:text-[11px] font-bold font-mono uppercase transition-all justify-center border disabled:opacity-50 ${
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
      <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar">
        {filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-600 gap-4 font-mono">
            <HardDrive size={48} className="opacity-20" />
            <div className="text-center space-y-1">
              <p className="text-xs uppercase tracking-[0.3em]">Cache_Empty</p>
              <p className="text-[10px] opacity-50">Generated files will appear here after creation</p>
            </div>
          </div>
        ) : (
          filteredFiles.map(file => {
            const config = FILE_TYPE_CONFIG[file.fileType] || FILE_TYPE_CONFIG['audio'];
            return (
              <div
                key={file.key}
                className="bg-void-2 border border-zinc-800 rounded-lg p-3 md:p-4 flex items-start md:items-center gap-3 md:gap-4 hover:border-zinc-700 transition-all group"
              >
                {/* Icon */}
                <div className={`w-8 h-8 md:w-10 md:h-10 rounded-sm bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 ${config.color}`}>
                  {config.icon}
                </div>

                {/* File Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs md:text-sm text-zinc-200 font-medium truncate">{file.filename}</span>
                    <span className={`hidden md:inline text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-full border border-zinc-800 shrink-0 ${config.color}`}>
                      {config.label}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] md:text-[10px] font-mono text-zinc-600">
                    <span className={`md:hidden ${config.color}`}>{config.label}</span>
                    <span>{formatFileSize(file.size)}</span>
                    <span className="hidden md:inline text-zinc-500">|</span>
                    <span className="truncate max-w-[100px] md:max-w-[150px]">{getBookTitle(file.bookId)}</span>
                    <span className="hidden md:inline text-zinc-500">|</span>
                    <span>CH.{String(file.chapterId).padStart(2, '0')}</span>
                    <span className="hidden md:inline text-zinc-500">|</span>
                    <span>{formatRelativeTime(file.timestamp)}</span>
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
