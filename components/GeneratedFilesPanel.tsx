
import React, { useState, useEffect, useCallback } from 'react';
import { HardDrive, Headphones, Mic2, Film, Image as ImageIcon, Download, Trash2, AlertTriangle, FileText, Notebook as NotebookIcon, Map, FileDown, Save, Share2, Languages, File as FileIcon, Check, Minus, FileType2, Archive } from 'lucide-react';
import { CachedFileMetadata, LibraryItem } from '../types';
import { EmptyState } from './ui/EmptyState';
import { listFiles, deleteFile, getFile } from '../services/fileCache';
import { shareFile } from '../utils/share';
import { titleCase, formatDateTime } from '../utils/filename';
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
const HIDDEN_TYPES = ['chapter-text', 'source-file', 'original-file', 'figure-image'];

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


export const GeneratedFilesPanel: React.FC<Props> = ({ library }) => {
  const [files, setFiles] = useState<CachedFileMetadata[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [filterBook, setFilterBook] = useState<string>('all');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [filterFormat, setFilterFormat] = useState<string>('all');
  // Checked file keys. Batch save/delete act on THIS, never on the whole filtered view — and it is
  // cleared whenever the filter or the underlying file set changes (see below), so a "delete selected"
  // can only ever touch files the user currently sees AND ticked (no invisible deletion).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);

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
      setSelected(new Set()); // fileset changed → drop any stale selection
    } catch (e) {
      console.error('Failed to load cached files:', e);
    }
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);
  // Any filter change resets the selection — the safe WYSIWYG rule (checked ⊆ what's visible now).
  useEffect(() => { setSelected(new Set()); setConfirmClear(false); }, [filterBook, filterType, filterFormat]);

  // File FORMAT = the lowercased trailing extension of its filename (wav/png/json/pdf/…). The Format
  // filter options are derived from the files actually present, so the list never offers a dead format
  // or misses one (e.g. figure translations are .jpg AND .png; mind-maps .pdf/.docx/.xmind).
  const formatOf = (filename: string): string => { const m = /\.([A-Za-z0-9]+)$/.exec(filename || ''); return m ? m[1].toLowerCase() : ''; };
  const formatOptions = Array.from(new Set(files.map(f => formatOf(f.filename)).filter(Boolean))).sort();

  const NOTEBOOK_TYPES = ['sticky-note', 'notebook-figure', 'mind-map-pdf', 'mind-map-docx', 'mind-map-xmind'];
  const filteredFiles = files.filter(f => {
    if (filterBook !== 'all' && f.bookId !== filterBook) return false;
    if (filterFormat !== 'all' && formatOf(f.filename) !== filterFormat) return false;
    if (filterType === 'all') return true;
    if (filterType === 'notebook') return NOTEBOOK_TYPES.includes(f.fileType);
    return f.fileType === filterType;
  });

  // Selection derived from the CURRENT filtered view (selection is cleared on filter change, so this is
  // always a subset of what's visible). Drives the tri-state overall checkbox + the batch actions.
  const selectedFiles = filteredFiles.filter(f => selected.has(f.key));
  const allSelected = filteredFiles.length > 0 && selectedFiles.length === filteredFiles.length;
  const someSelected = selectedFiles.length > 0 && !allSelected;
  const toggleOne = (key: string) => setSelected(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleAll = () => { setSelected(allSelected ? new Set() : new Set(filteredFiles.map(f => f.key))); setConfirmClear(false); };

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

  // DELETE the CHECKED files (2-click confirm: first click arms, second within 3s deletes). Only ever
  // touches selectedFiles (⊆ current filtered view), never the whole store.
  const handleDeleteSelected = async () => {
    if (selectedFiles.length === 0) return;
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    try {
      await Promise.all(selectedFiles.map(f => deleteFile(f.key)));
      setConfirmClear(false);
      await loadFiles(); // also clears the selection
    } catch (e) {
      console.error('Delete failed:', e);
    }
  };

  // SAVE the CHECKED files as one .zip on the user's machine (same JSZip path as before, scoped to selection).
  const handleSaveSelected = async () => {
    if (selectedFiles.length === 0) return;
    try {
      const zip = new JSZip();
      for (const file of selectedFiles) {
        const cached = await getFile(file.key);
        if (cached) zip.file(file.filename, cached.blob);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const bookLabel = filterBook !== 'all' ? titleCase(getBookTitle(filterBook)) : 'AllBooks';
      a.download = `archive-${selectedFiles.length}files-${bookLabel}.zip`;
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
    <div className="h-full min-h-0 flex flex-col animate-fade-in font-sans text-left overflow-hidden">
      {/* FILES_SCOPE — narrow the list by book / type / format. Vertical, mirroring SettingsModal LLM_Engines. */}
      <div className="shrink-0 space-y-3 mb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-neon-cyan">
            <HardDrive size={18} />
            <label className="text-xs font-bold uppercase tracking-widest font-mono">Files_Scope</label>
          </div>
          <span className="text-[10px] font-mono text-zinc-600 uppercase">{formatFileSize(totalSize)} // {files.length} files</span>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-zinc-500">
              <HardDrive size={12} />
              <span className="text-[9px] font-mono uppercase">Book_Scope</span>
            </div>
            <select
              value={filterBook}
              onChange={(e) => setFilterBook(e.target.value)}
              className="w-full bg-void-1 border border-zinc-800 text-neon-cyan font-mono text-xs uppercase focus:border-neon-cyan outline-none rounded-sm px-3 py-2 transition-all cursor-pointer"
            >
              <option value="all">ALL BOOKS</option>
              {library.map(item => (
                <option key={item.book.id} value={item.book.id}>{item.book.title.substring(0, 44)}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-zinc-500">
              <FileText size={12} />
              <span className="text-[9px] font-mono uppercase">Type_Scope</span>
            </div>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as FilterType)}
              className="w-full bg-void-1 border border-zinc-800 text-neon-cyan font-mono text-xs uppercase focus:border-neon-cyan outline-none rounded-sm px-3 py-2 transition-all cursor-pointer"
            >
              {FILTER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-zinc-500">
              <FileType2 size={12} />
              <span className="text-[9px] font-mono uppercase">Format_Scope</span>
            </div>
            <select
              value={filterFormat}
              onChange={(e) => setFilterFormat(e.target.value)}
              className="w-full bg-void-1 border border-zinc-800 text-neon-cyan font-mono text-xs uppercase focus:border-neon-cyan outline-none rounded-sm px-3 py-2 transition-all cursor-pointer"
            >
              <option value="all">ALL FORMATS</option>
              {formatOptions.map(fmt => (
                <option key={fmt} value={fmt}>.{fmt.toUpperCase()}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* FILE_LIST header — mirrors the FILES_SCOPE header (Archive icon + label) */}
      <div className="flex items-center gap-2 text-neon-cyan shrink-0 mb-2 pt-3 border-t border-zinc-900">
        <Archive size={18} />
        <label className="text-xs font-bold uppercase tracking-widest font-mono">File_List</label>
      </div>

      {/* Batch bar — overall (tri-state) checkbox + save / delete on the CHECKED items */}
      <div className="mb-1.5 md:mb-2 flex items-center justify-between shrink-0 w-full gap-2 px-1">
        <button
          onClick={toggleAll}
          disabled={filteredFiles.length === 0}
          className="flex items-center gap-2 text-[10px] md:text-[11px] font-mono uppercase text-zinc-400 hover:text-neon-cyan transition-colors disabled:opacity-40"
          title={allSelected ? 'Deselect all in view' : 'Select all in view'}
        >
          <span className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-colors ${allSelected || someSelected ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan' : 'border-zinc-700'}`}>
            {allSelected ? <Check size={11} /> : someSelected ? <Minus size={11} /> : null}
          </span>
          <span>{selectedFiles.length > 0 ? `${selectedFiles.length} selected` : 'select all'}</span>
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSaveSelected}
            disabled={selectedFiles.length === 0}
            className="flex items-center gap-1.5 px-2.5 md:px-3.5 py-1 rounded-sm text-[10px] md:text-[11px] font-bold font-mono uppercase transition-all justify-center min-w-[96px] border text-neon-cyan border-neon-cyan/30 hover:bg-neon-cyan/10 disabled:opacity-40 disabled:hover:bg-transparent"
            title="Save the checked files as one .zip"
          >
            <Save size={13} /> SAVE
          </button>
          <button
            onClick={handleDeleteSelected}
            disabled={selectedFiles.length === 0}
            className={`flex items-center gap-1.5 px-2.5 md:px-3.5 py-1 rounded-sm text-[10px] md:text-[11px] font-bold font-mono uppercase transition-all justify-center min-w-[96px] border disabled:opacity-40 disabled:hover:bg-transparent ${
              confirmClear ? 'bg-neon-red text-white border-neon-red animate-pulse hover:bg-rose-600' : 'text-neon-red border-neon-red/30 hover:bg-neon-red/10'
            }`}
            title="Delete the checked files (click twice to confirm)"
          >
            <Trash2 size={13} /> {confirmClear ? 'CONFIRM' : 'DELETE'}
          </button>
        </div>
      </div>

      {/* File List — scrolls independently; FILES_SCOPE + FILE_LIST header + batch bar stay fixed above */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-2 custom-scrollbar">
        {filteredFiles.length === 0 ? (
          <EmptyState icon={HardDrive} label="Cache_Empty" sublabel="Generated files will appear here after creation" className="h-full" />
        ) : (
          filteredFiles.map((file, i) => {
            const config = FILE_TYPE_CONFIG[file.fileType] || DEFAULT_FILE_CONFIG;
            return (
              <div
                key={file.key}
                style={{ animationDelay: `${Math.min(i * 12, 120)}ms` }}
                className={`content-panel rounded-lg px-3 py-1.5 flex items-center gap-3 hover:border-zinc-700 hover:bg-zinc-900/40 active:border-zinc-600 transition-all group animate-fade-in-up ${selected.has(file.key) ? 'border-neon-cyan/40 bg-neon-cyan/[0.03]' : ''}`}
              >
                {/* Checkbox */}
                <button
                  onClick={() => toggleOne(file.key)}
                  className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-colors ${selected.has(file.key) ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan' : 'border-zinc-700 hover:border-zinc-500'}`}
                  title={selected.has(file.key) ? 'Deselect' : 'Select'}
                  aria-label={selected.has(file.key) ? 'Deselect file' : 'Select file'}
                >
                  {selected.has(file.key) ? <Check size={11} /> : null}
                </button>

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
                    <span className="truncate max-w-[100px] md:max-w-[150px]">{file.bookTitle || getBookTitle(file.bookId)}</span>
                    <span className="hidden md:inline text-zinc-500">|</span>
                    <span>{formatDateTime(file.timestamp)}</span>
                    <span className="hidden md:inline text-zinc-500">|</span>
                    <span>{formatFileSize(file.size)}</span>
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
