
import React, { useState, useEffect, useCallback } from 'react';
import { HardDrive, Headphones, Mic2, Film, Image as ImageIcon, Download, Trash2, AlertTriangle, FileText, StickyNote, Map, FileDown } from 'lucide-react';
import { CachedFileMetadata, LibraryItem } from '../types';
import { listFiles, deleteFile, getFile, clearAll, clearBook, getTotalSize } from '../services/fileCache';

interface Props {
  library: LibraryItem[];
}

type FilterType = 'all' | 'audio' | 'podcast-audio' | 'podcast-script' | 'video' | 'concept-image' | 'notebook';

const FILE_TYPE_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  'audio': { icon: <Headphones size={14} />, label: 'VOICE_SYNTH', color: 'text-cyan-400' },
  'podcast-audio': { icon: <Mic2 size={14} />, label: 'NET_CAST', color: 'text-purple-400' },
  'podcast-script': { icon: <FileText size={14} />, label: 'NET_SCRIPT', color: 'text-purple-300' },
  'video': { icon: <Film size={14} />, label: 'CINE_RENDER', color: 'text-rose-400' },
  'concept-image': { icon: <ImageIcon size={14} />, label: 'VISUAL_CORE', color: 'text-amber-400' },
  'sticky-note': { icon: <StickyNote size={14} />, label: 'MEM_LOG', color: 'text-green-400' },
  'mind-map-pdf': { icon: <Map size={14} />, label: 'MAP_PDF', color: 'text-sky-400' },
  'mind-map-docx': { icon: <FileDown size={14} />, label: 'MAP_DOCX', color: 'text-blue-400' },
  'mind-map-xmind': { icon: <Map size={14} />, label: 'MAP_XMIND', color: 'text-teal-400' },
};

const FILTER_OPTIONS: { value: FilterType; label: string }[] = [
  { value: 'all', label: 'ALL' },
  { value: 'audio', label: 'AUDIO' },
  { value: 'podcast-audio', label: 'PODCAST' },
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

  const NOTEBOOK_TYPES = ['sticky-note', 'mind-map-pdf', 'mind-map-docx', 'mind-map-xmind'];
  const filteredFiles = filterType === 'all'
    ? files
    : filterType === 'notebook'
      ? files.filter(f => NOTEBOOK_TYPES.includes(f.fileType))
      : files.filter(f => f.fileType === filterType || (filterType === 'podcast-audio' && f.fileType === 'podcast-script'));

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

  const getBookTitle = (bookId: string) => {
    const item = library.find(l => l.book.id === bookId);
    return item?.book.title || bookId.substring(0, 8);
  };

  return (
    <div className="h-full flex flex-col animate-fade-in font-sans text-left">
      {/* Controller */}
      <div className="bg-zinc-950/80 p-3 rounded-lg border border-cyan-900/40 mb-4 flex items-center justify-between shrink-0 shadow-[0_0_15px_rgba(0,243,255,0.05)] w-full flex-wrap gap-2 z-20">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-xs">
            <HardDrive size={18} className="text-[#00f3ff]" />
            <span>Generated_Files</span>
          </div>
          <span className="text-[10px] font-mono text-zinc-600 uppercase">{formatFileSize(totalSize)} // {files.length} files</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-black/50 p-1 rounded-sm border border-zinc-800">
            <div className="p-1.5 text-zinc-500"><HardDrive size={16} /></div>
            <select
              value={filterBook}
              onChange={(e) => setFilterBook(e.target.value)}
              className="bg-transparent text-xs text-[#00f3ff] outline-none cursor-pointer font-mono uppercase w-[120px] bg-[#050505]"
            >
              <option value="all">ALL BOOKS</option>
              {library.map(item => (
                <option key={item.book.id} value={item.book.id}>
                  {item.book.title.substring(0, 15)}
                </option>
              ))}
            </select>
            <div className="w-[1px] h-4 bg-zinc-700"></div>
            <div className="p-1.5 text-zinc-500"><FileText size={16} /></div>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as FilterType)}
              className="bg-transparent text-xs text-[#00f3ff] outline-none cursor-pointer font-mono uppercase w-[120px] bg-[#050505]"
            >
              {FILTER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleClearAll}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-sm text-xs font-bold font-mono uppercase transition-all min-w-[120px] justify-center ${
              confirmClear
                ? 'bg-[#ff003c] text-white hover:bg-rose-600 animate-pulse'
                : 'text-[#ff003c] border border-[#ff003c]/30 hover:bg-[#ff003c]/10'
            }`}
          >
            <Trash2 size={14} />
            {confirmClear ? 'CONFIRM' : filterBook !== 'all' ? 'CLEAR_BOOK' : 'CLEAR_ALL'}
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
                className="bg-[#0a0a0c] border border-zinc-800 rounded-lg p-4 flex items-center gap-4 hover:border-zinc-700 transition-all group"
              >
                {/* Icon */}
                <div className={`w-10 h-10 rounded-sm bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 ${config.color}`}>
                  {config.icon}
                </div>

                {/* File Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm text-zinc-200 font-medium truncate">{file.filename}</span>
                    <span className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-full border border-zinc-800 ${config.color}`}>
                      {config.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] font-mono text-zinc-600">
                    <span>{formatFileSize(file.size)}</span>
                    <span className="text-zinc-800">|</span>
                    <span className="truncate max-w-[150px]">{getBookTitle(file.bookId)}</span>
                    <span className="text-zinc-800">|</span>
                    <span>CH.{String(file.chapterId).padStart(2, '0')}</span>
                    <span className="text-zinc-800">|</span>
                    <span>{formatRelativeTime(file.timestamp)}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleDownload(file)}
                    className="p-2 text-zinc-600 hover:text-[#00f3ff] hover:bg-zinc-900 rounded-sm transition-all"
                    title="Download"
                  >
                    <Download size={16} />
                  </button>
                  <button
                    onClick={() => handleDelete(file.key)}
                    className="p-2 text-zinc-600 hover:text-[#ff003c] hover:bg-zinc-900 rounded-sm transition-all"
                    title="Delete"
                  >
                    <Trash2 size={16} />
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
