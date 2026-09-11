
import React, { useState, useEffect, useCallback } from 'react';
import { HardDrive, Headphones, Mic2, Film, Image as ImageIcon, Download, Trash2, AlertTriangle, FileText, Notebook as NotebookIcon, Map, FileDown, Save, Share2, Languages, File as FileIcon, Check, Minus, Archive, Cloud, RefreshCw, Database, CloudDownload, Filter, BookOpen, Folders } from 'lucide-react';
import { CachedFileMetadata, LibraryItem } from '../types';
import { EmptyState } from './ui/EmptyState';
import { listFiles, deleteFile, getFile, saveFile, buildCacheKey } from '../services/fileCache';
import { uploadGenFileToCloud, removeGenFileFromCloud, fetchGenFileFromCloud, listSyncedFileIndex, reconcileCloudFiles, SyncedFileRow, STORAGE_QUOTA_BYTES } from '../services/supabase';
import { syncSidecarFor } from '../services/figureSync';
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
const HIDDEN_TYPES = ['chapter-text', 'source-file', 'original-file', 'figure-image', 'translation-mem', 'audio-batch'];

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
  { value: 'all', label: 'ALL TYPES' },
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

// Storage-bar colour, mirroring the MY_ACCOUNT credit bars: red ≥95%, amber ≥60%, else cyan.
const barBg = (p: number) => p >= 95 ? 'bg-neon-red' : p >= 60 ? 'bg-neon-amber' : 'bg-neon-cyan';
const barText = (p: number) => p >= 95 ? 'text-neon-red' : p >= 60 ? 'text-neon-amber' : 'text-neon-cyan';
const barBorder = (p: number) => p >= 95 ? 'border-neon-red' : p >= 60 ? 'border-neon-amber' : 'border-neon-cyan';
// The same red/amber/cyan threshold as a raw CSS colour, for the hazard slash-stripe gradient.
const barColorVar = (p: number) => p >= 95 ? 'var(--neon-red)' : p >= 60 ? 'var(--neon-amber)' : 'var(--neon-cyan)';

// A podcast is ONE deliverable split across two files — the audio (.wav) and its script (.txt) —
// whose cache keys are IDENTICAL except the type token (podcast-audio ↔ podcast-script). They must
// travel together: a device that pulls only the audio can't reopen the podcast from cache (the player
// needs the script too), so syncing / unsyncing either one carries its sibling.
const podcastSiblingKey = (key: string): string | null => {
  const parts = key.split(':');
  if (parts[2] === 'podcast-audio') { parts[2] = 'podcast-script'; return parts.join(':'); }
  if (parts[2] === 'podcast-script') { parts[2] = 'podcast-audio'; return parts.join(':'); }
  return null;
};

// Reconcile the cloud index vs bucket ONCE per session (the first time the panel opens).
let _cloudReconciled = false;


export const GeneratedFilesPanel: React.FC<Props> = ({ library }) => {
  // LOCAL vs CLOUD inventory. The whole panel (list + filters + buttons) operates on the active side.
  const [mode, setMode] = useState<'local' | 'cloud'>('local');
  const [files, setFiles] = useState<CachedFileMetadata[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [localBytes, setLocalBytes] = useState(0); // ALL cached bytes (incl. hidden) → local-storage meter
  const [localKeys, setLocalKeys] = useState<Set<string>>(new Set()); // every local cache key (cross-presence)
  const [cloudRows, setCloudRows] = useState<SyncedFileRow[]>([]);    // the cloud index (CLOUD-mode rows)
  const [filterBook, setFilterBook] = useState<string>('all');
  const [filterType, setFilterType] = useState<FilterType>('all');
  // Checked file keys. Batch save/delete act on THIS, never on the whole filtered view — and it is
  // cleared whenever the filter or the underlying file set changes (see below), so a "delete selected"
  // can only ever touch files the user currently sees AND ticked (no invisible deletion).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  // Cloud-sync state: which file keys are mirrored to the cloud, how many bytes they occupy
  // (the quota meter), which are uploading right now, and the "over quota" notice.
  const [syncedKeys, setSyncedKeys] = useState<Set<string>>(new Set());
  const [cloudBytes, setCloudBytes] = useState(0);
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [limitNotice, setLimitNotice] = useState(false);
  const [saving, setSaving] = useState(false);   // zip export in progress
  const [deleting, setDeleting] = useState(false); // batch delete in progress
  // At most ONE batch operation runs at a time. While a sync/unsync upload, a zip export, or a delete
  // is in flight, every mutating control (all three toggles + per-file sync/delete) is disabled so a
  // mis-click can't overlap operations (e.g. deleting a file while it's still uploading).
  const busy = syncing.size > 0 || saving || deleting;

  const loadFiles = useCallback(async () => {
    try {
      // Load ALL files ONCE (a single cursor); book + type filtering happens client-side below, so
      // switching either scope is instant with no re-query. Also derive the total size from the list
      // instead of a SECOND full-store cursor (getTotalSize) — together these were reading every record
      // (blobs and all) twice per load, which made the panel sit empty for seconds.
      const allFiles = await listFiles();
      // Hide internal caches: HIDDEN_TYPES, plus the per-page translation JSON (fileType 'translation'
      // + application/json) — those are reader cache fragments, not user deliverables. Figure
      // translations share the 'translation' type but are images, so they stay visible.
      const visible = allFiles.filter(f =>
        !HIDDEN_TYPES.includes(f.fileType) &&
        !(f.fileType === 'translation' && f.mimeType === 'application/json')
      );
      setFiles(visible.sort((a, b) => b.timestamp - a.timestamp));
      setTotalSize(visible.reduce((s, f) => s + (f.size || 0), 0));
      setLocalBytes(allFiles.reduce((s, f) => s + (f.size || 0), 0)); // every cached file counts toward local storage
      setLocalKeys(new Set(allFiles.map(f => f.key)));
      setSelected(new Set()); // fileset changed → drop any stale selection
      // Cloud index: rows for CLOUD mode + synced badges + cloud meter.
      const cloud = await listSyncedFileIndex();
      setCloudRows(cloud.rows);
      setSyncedKeys(new Set(cloud.rows.map(r => r.file_key)));
      setCloudBytes(cloud.bytes);
    } catch (e) {
      console.error('Failed to load cached files:', e);
    }
  }, []);

  // Re-read the cloud INDEX only (rows + synced badges + cloud meter) WITHOUT reloading local files or
  // clearing the selection — used after a sync / unsync (so CLOUD mode + the cloud badges reflect the
  // change at once, incl. the paired podcast sibling) and whenever CLOUD mode is opened (so its list is
  // never the stale snapshot from when the panel first mounted).
  const refreshCloudIndex = useCallback(async () => {
    try {
      const cloud = await listSyncedFileIndex();
      setCloudRows(cloud.rows);
      setSyncedKeys(new Set(cloud.rows.map(r => r.file_key)));
      setCloudBytes(cloud.bytes);
    } catch { /* best-effort — the optimistic in-flight state stands until the next load */ }
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);
  // Switching to CLOUD mode re-reads the index so it shows files synced since the panel opened.
  useEffect(() => { if (mode === 'cloud') refreshCloudIndex(); }, [mode, refreshCloudIndex]);
  // Once per session, reconcile the cloud index with the actual bucket (recover invisible orphan
  // blobs into Cloud mode, drop dead rows); reload if it changed anything.
  useEffect(() => {
    if (_cloudReconciled) return;
    _cloudReconciled = true;
    reconcileCloudFiles().then(r => { if (r.backfilled || r.removed) loadFiles(); }).catch(() => {});
  }, [loadFiles]);
  // Any filter OR mode change resets the selection — the safe WYSIWYG rule (checked ⊆ what's visible now).
  useEffect(() => { setSelected(new Set()); setConfirmClear(false); }, [filterBook, filterType, mode]);

  // CLOUD-mode rows come from the index, mapped to the same shape the list renders. Hidden types
  // (e.g. figures) count toward the cloud TOTAL but never show as a row.
  const cloudAsMeta: CachedFileMetadata[] = cloudRows
    .filter(r => !HIDDEN_TYPES.includes(r.file_type))
    .map(r => ({
      key: r.file_key, filename: r.filename || r.file_key, fileType: (r.file_type || 'translation') as any,
      size: r.size || 0, bookId: r.book_id || '', bookTitle: r.book_title || '',
      timestamp: r.synced_at || 0, mimeType: '', componentSource: 'Cloud',
    } as CachedFileMetadata))
    .sort((a, b) => b.timestamp - a.timestamp); // newest first, same order as LOCAL mode
  const cloudVisibleBytes = cloudAsMeta.reduce((s, f) => s + (f.size || 0), 0);
  const sourceFiles = mode === 'cloud' ? cloudAsMeta : files;
  // Does this file also exist on the OTHER side? (LOCAL mode → also on cloud; CLOUD mode → also local.)
  const onOtherSide = (key: string) => mode === 'cloud' ? localKeys.has(key) : syncedKeys.has(key);

  const NOTEBOOK_TYPES = ['sticky-note', 'notebook-figure', 'mind-map-pdf', 'mind-map-docx', 'mind-map-xmind'];
  const filteredFiles = sourceFiles.filter(f => {
    if (filterBook !== 'all' && f.bookId !== filterBook) return false;
    if (filterType === 'all') return true;
    if (filterType === 'notebook') return NOTEBOOK_TYPES.includes(f.fileType);
    return f.fileType === filterType;
  });

  // Selection derived from the CURRENT filtered view (selection is cleared on filter change, so this is
  // always a subset of what's visible). Drives the tri-state overall checkbox + the batch actions.
  const selectedFiles = filteredFiles.filter(f => selected.has(f.key));
  const allSelected = filteredFiles.length > 0 && selectedFiles.length === filteredFiles.length;
  const someSelected = selectedFiles.length > 0 && !allSelected;
  const sumSelected = selectedFiles.reduce((s, f) => s + (f.size || 0), 0);
  const localPct = Math.min((localBytes / STORAGE_QUOTA_BYTES) * 100, 100);
  const cloudPct = Math.min((cloudBytes / STORAGE_QUOTA_BYTES) * 100, 100);
  const activeBytes = mode === 'cloud' ? cloudBytes : localBytes;
  const activePct = mode === 'cloud' ? cloudPct : localPct;
  // gen-file portion of the active side (LOCAL: the listed gen files vs the whole device cache;
  // CLOUD: the synced gen files, which are the whole cloud total for now).
  const genBytes = mode === 'cloud' ? cloudVisibleBytes : totalSize;
  const genPct = Math.min((genBytes / STORAGE_QUOTA_BYTES) * 100, 100);
  // Batch buttons appear only for a MULTI-selection (or select-all); a single file is acted on via its
  // own always-visible row icons.
  const showBatch = selectedFiles.length > 1 || allSelected;
  const toggleOne = (key: string) => setSelected(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleAll = () => { setSelected(allSelected ? new Set() : new Set(filteredFiles.map(f => f.key))); setConfirmClear(false); };

  const syncMeta = (f: CachedFileMetadata) => ({ filename: f.filename, fileType: f.fileType, size: f.size, bookId: f.bookId, bookTitle: f.bookTitle, timestamp: f.timestamp });
  // Get a file's blob — local if present, else pulled from the cloud (needed in CLOUD mode).
  const getBlob = async (file: CachedFileMetadata): Promise<Blob | null> => {
    const local = await getFile(file.key);
    if (local?.blob) return local.blob;
    return await fetchGenFileFromCloud(file.key);
  };
  // Whether the current DELETE would be permanent (a selected file has no copy on the other side).
  const deletePermanent = selectedFiles.some(f => !onOtherSide(f.key));

  const handleDownload = async (file: CachedFileMetadata) => {
    try {
      const blob = await getBlob(file);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Download failed:', e);
    }
  };

  // DELETE removes from the CURRENT side ONLY (LOCAL mode → device cache; CLOUD mode → cloud), so a
  // file that also lives on the other side survives — that's the dual protection.
  const removeFromCurrentSide = async (file: CachedFileMetadata) => {
    if (mode === 'cloud') { await removeGenFileFromCloud(file.key); }
    else { await deleteFile(file.key); }
  };

  const handleDelete = async (file: CachedFileMetadata) => {
    if (busy) return;
    try { await removeFromCurrentSide(file); await loadFiles(); }
    catch (e) { console.error('Delete failed:', e); }
  };

  // DELETE the CHECKED files (2-click confirm). Only touches selectedFiles (⊆ current view), on the
  // current side only.
  const handleDeleteSelected = async () => {
    if (selectedFiles.length === 0 || busy) return;
    if (!confirmClear) {
      setConfirmClear(true);
      setConfirmUnsync(false); // arming one 2-click action disarms the other
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    setDeleting(true);
    try {
      await Promise.all(selectedFiles.map(removeFromCurrentSide));
      await loadFiles(); // also clears the selection
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setDeleting(false);
    }
  };

  // SAVE the CHECKED files as one .zip on the user's machine (pulls from cloud if not local, so it
  // works in CLOUD mode too). Purpose: open them in native players / PDF readers.
  const handleSaveSelected = async () => {
    if (selectedFiles.length === 0 || busy) return;
    setSaving(true);
    try {
      const zip = new JSZip();
      for (const file of selectedFiles) {
        const blob = await getBlob(file);
        if (blob) zip.file(file.filename, blob);
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
    } finally {
      setSaving(false);
    }
  };

  const cacheCloudBlob = async (file: CachedFileMetadata, blob: Blob) =>
    saveFile(file.key, blob, { filename: file.filename, mimeType: blob.type || 'application/octet-stream', timestamp: Date.now(), bookId: file.bookId, bookTitle: file.bookTitle, chapterId: 0, componentSource: 'CloudSync', fileType: file.fileType }).catch(() => {});

  // LOCAL mode, per file: PUSH (or refresh) this file to the cloud. A podcast's audio + script are
  // paired (podcastSiblingKey) so it's never half-synced. This NEVER removes a cloud copy — to take a
  // file off the cloud, switch to CLOUD mode and delete it there (single, unambiguous removal path).
  // Re-syncing an already-synced file re-uploads it (refreshing its blob + sidecar + timestamp).
  const syncOne = async (file: CachedFileMetadata) => {
    if (busy || syncing.has(file.key)) return;
    const sib = podcastSiblingKey(file.key);
    const sibFile = sib ? files.find(f => f.key === sib) : undefined; // only if it's on THIS device
    const group = [file, ...(sibFile ? [sibFile] : [])];
    const addBytes = group.filter(f => !syncedKeys.has(f.key)).reduce((s, f) => s + (f.size || 0), 0);
    if (cloudBytes + addBytes > STORAGE_QUOTA_BYTES) { setLimitNotice(true); return; }
    setSyncing(prev => { const n = new Set(prev); group.forEach(f => n.add(f.key)); return n; });
    try {
      for (const f of group) {
        const cached = await getFile(f.key);
        if (cached && await uploadGenFileToCloud(f.key, cached.blob, syncMeta(f))) {
          syncSidecarFor(f.key); // upload timings / episode title alongside audio/podcast
        }
      }
      await refreshCloudIndex(); // reconcile badges + CLOUD-mode rows + meter (covers the sibling)
    } finally {
      setSyncing(prev => { const n = new Set(prev); group.forEach(f => n.delete(f.key)); return n; });
    }
  };

  // CLOUD mode, per file: pull down to THIS device (creates a local copy so it opens across the app).
  const downloadOne = async (file: CachedFileMetadata) => {
    if (busy || syncing.has(file.key) || localKeys.has(file.key)) return;
    setSyncing(prev => new Set(prev).add(file.key));
    try {
      const blob = await fetchGenFileFromCloud(file.key);
      if (blob) { await cacheCloudBlob(file, blob); setLocalKeys(prev => new Set(prev).add(file.key)); }
    } finally {
      setSyncing(prev => { const n = new Set(prev); n.delete(file.key); return n; });
    }
  };

  // LOCAL batch SYNC = push the checked files to the cloud (upload new ones, refresh already-synced
  // ones). It NEVER removes — to take a file off the cloud, switch to CLOUD mode and DELETE it there.
  // Each checked podcast file drags in its local sibling (audio+script travel together). Quota counts
  // only the NOT-yet-synced bytes; if they'd exceed 1 GB, upload NONE.
  const handleSyncSelected = async () => {
    if (busy) return;
    const wanted = new Map<string, CachedFileMetadata>();
    for (const f of selectedFiles) {
      wanted.set(f.key, f);
      const sib = podcastSiblingKey(f.key);
      const sibFile = sib ? files.find(x => x.key === sib) : undefined;
      if (sibFile) wanted.set(sibFile.key, sibFile);
    }
    const toSync = [...wanted.values()];
    if (toSync.length === 0) return;
    const addBytes = toSync.filter(f => !syncedKeys.has(f.key)).reduce((s, f) => s + (f.size || 0), 0);
    if (cloudBytes + addBytes > STORAGE_QUOTA_BYTES) { setLimitNotice(true); return; }
    setConfirmClear(false); // starting a batch op clears any pending delete arm
    setSyncing(prev => { const n = new Set(prev); toSync.forEach(f => n.add(f.key)); return n; });
    for (const f of toSync) {
      try {
        const cached = await getFile(f.key);
        if (cached && await uploadGenFileToCloud(f.key, cached.blob, syncMeta(f))) {
          syncSidecarFor(f.key); // upload timings / episode title alongside audio/podcast
        }
      } catch {}
      setSyncing(prev => { const n = new Set(prev); n.delete(f.key); return n; });
    }
    await refreshCloudIndex();
  };

  // CLOUD batch DOWNLOAD (pull the checked files to this device).
  const handleDownloadSelected = async () => {
    if (busy) return;
    const toGet = selectedFiles.filter(f => !localKeys.has(f.key));
    if (toGet.length === 0) return;
    setSyncing(prev => { const n = new Set(prev); toGet.forEach(f => n.add(f.key)); return n; });
    for (const f of toGet) {
      try { const blob = await fetchGenFileFromCloud(f.key); if (blob) { await cacheCloudBlob(f, blob); setLocalKeys(prev => new Set(prev).add(f.key)); } } catch {}
      setSyncing(prev => { const n = new Set(prev); n.delete(f.key); return n; });
    }
    await loadFiles();
  };

  const getBookTitle = (bookId: string) => {
    const item = library.find(l => l.book.id === bookId);
    return item?.book.title || bookId.substring(0, 8);
  };

  return (
    <div className="relative h-full min-h-0 flex flex-col animate-fade-in font-sans text-left overflow-hidden">
      {/* Scrolling content is padded (px-6 pt-6); NO bottom padding so the list runs flush to the
          full-bleed footer (a pb here left a black band that clipped the last file frame). */}
      <div className="flex-1 min-h-0 flex flex-col px-6 pt-6 pb-1">
      {/* FILE_STORAGE — local device cache + cloud sync usage, each against its 1 GB quota. Bars mirror
          the MY_ACCOUNT credit bars (same fill + red/amber/cyan colour thresholds). */}
      <div className="shrink-0 space-y-3 mb-[1.6rem]">
        <div className="flex items-center gap-2 text-neon-cyan">
          <Database size={18} />
          <label className="text-xs font-bold uppercase tracking-widest font-mono">File_Storage</label>
        </div>
        <div className="flex flex-col gap-2 px-1">
          {/* LOCAL / CLOUD toggle (mirrors the Active_Mode switch). The whole panel operates on the
              side shown here. */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-neon-cyan font-mono font-bold">{mode === 'cloud' ? 'Cloud' : 'Local'}</span>
            <button
              role="switch" aria-checked={mode === 'cloud'} aria-label="Toggle local / cloud storage"
              onClick={() => setMode(m => m === 'cloud' ? 'local' : 'cloud')}
              className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${mode === 'cloud' ? 'bg-neon-cyan/30' : 'bg-zinc-700'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-neon-cyan transition-transform ${mode === 'cloud' ? 'translate-x-4' : ''}`} />
            </button>
          </div>
          {/* Left: generated-files portion / total used. Right: total used / quota. */}
          <div className="flex items-center justify-between text-xs">
            <span className={`font-mono font-bold ${barText(activePct)}`}>{formatFileSize(genBytes)} / {formatFileSize(activeBytes)}</span>
            <span className="font-mono font-bold text-zinc-400">{formatFileSize(activeBytes)} / 1 GB</span>
          </div>
          {/* Bar: proposal "03 · Hazard" SLASH-STRIPE pattern, but in the theme threshold colour (cyan →
              amber → red). TOTAL USED = diagonal stripes; the GENERATED-FILES sub-portion = a SOLID fill
              on top. Hover any part for its size. */}
          <div
            className="relative h-2 bg-zinc-800 rounded-full overflow-hidden"
            title={`Free: ${formatFileSize(Math.max(0, STORAGE_QUOTA_BYTES - activeBytes))}`}
          >
            <div
              className="absolute inset-y-0 left-0 transition-all"
              style={{ width: `${activePct}%`, background: `repeating-linear-gradient(-45deg, ${barColorVar(activePct)} 0 5px, transparent 5px 10px)` }}
              title={`Other files (source books, caches, figures): ${formatFileSize(Math.max(0, activeBytes - genBytes))}`}
            />
            {genPct > 0 && (
              <div className={`absolute inset-y-0 left-0 transition-all ${barBg(activePct)}`} style={{ width: `${genPct}%` }} title={`Generated files: ${formatFileSize(genBytes)}`} />
            )}
          </div>
        </div>
      </div>

      {/* FILES_SCOPE — narrow the list by book / type / format. Vertical, mirroring SettingsModal LLM_Engines. */}
      <div className="shrink-0 space-y-3 mb-[1.6rem]">
        <div className="flex items-center gap-2 text-neon-cyan">
          <Filter size={18} />
          <label className="text-xs font-bold uppercase tracking-widest font-mono">Files_Scope</label>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-zinc-500">
              <BookOpen size={14} />
              <span className="text-[10px] font-mono uppercase">Book_Scope</span>
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
            <div className="flex items-center gap-2 text-zinc-500">
              <Folders size={14} />
              <span className="text-[10px] font-mono uppercase">Type_Scope</span>
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
        </div>
      </div>

      {/* FILE_LIST header + batch controls in ONE row: the label and the select-all/sum stacked on the
          left, the three action toggles on the right and vertically CENTRED against that combined
          block. pl-1 lines the select-all box up under the item checkboxes; pr-2 right-aligns DELETE
          with the item frames (which are inset by the 4px scrollbar). */}
      <div className="flex items-center justify-between gap-2 shrink-0 mb-2 pl-1 pr-2">
        <div className="flex flex-col gap-3 min-w-0 flex-1">
          <div className="flex items-center gap-2 text-neon-cyan">
            <Archive size={18} />
            <label className="text-xs font-bold uppercase tracking-widest font-mono">File_List</label>
          </div>
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={toggleAll}
              disabled={filteredFiles.length === 0}
              className="flex items-center gap-2 text-[10px] md:text-[11px] font-mono uppercase text-zinc-400 hover:text-neon-cyan transition-colors disabled:opacity-40"
              title={allSelected ? 'Deselect all in view' : 'Select all in view'}
            >
              <span className={`w-[13px] h-[13px] rounded-sm border flex items-center justify-center shrink-0 transition-colors ${allSelected || someSelected ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan' : 'border-zinc-700'}`}>
                {allSelected ? <Check size={9} /> : someSelected ? <Minus size={9} /> : null}
              </span>
              <span>{selectedFiles.length > 0 ? `${selectedFiles.length} selected` : 'select all'}</span>
            </button>
            {selectedFiles.length > 0 && (
              <span className="text-[9px] font-mono uppercase text-zinc-500 whitespace-nowrap">{formatFileSize(sumSelected)} in total</span>
            )}
          </div>
        </div>
      </div>

      {/* File List — scrolls independently; FILES_SCOPE + FILE_LIST header + batch bar stay fixed above.
          px-1 matches the batch bar so each row's checkbox aligns under the select-all checkbox. */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-2 custom-scrollbar px-1">
        {filteredFiles.length === 0 ? (
          <EmptyState icon={mode === 'cloud' ? Cloud : HardDrive} label={mode === 'cloud' ? 'Cloud_Empty' : 'Cache_Empty'} sublabel={mode === 'cloud' ? 'Synced files will appear here — sync from Local to add them' : 'Generated files will appear here after creation'} className="h-full" />
        ) : (
          filteredFiles.map((file, i) => {
            const config = FILE_TYPE_CONFIG[file.fileType] || DEFAULT_FILE_CONFIG;
            return (
              <div key={file.key} style={{ animationDelay: `${Math.min(i * 12, 120)}ms` }} className="flex items-center gap-2 animate-fade-in-up">
                {/* Checkbox — OUTSIDE the item frame so it aligns under the select-all checkbox */}
                <button
                  onClick={() => toggleOne(file.key)}
                  className={`w-[13px] h-[13px] rounded-sm border flex items-center justify-center shrink-0 transition-colors ${selected.has(file.key) ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan' : 'border-zinc-700 hover:border-zinc-500'}`}
                  title={selected.has(file.key) ? 'Deselect' : 'Select'}
                  aria-label={selected.has(file.key) ? 'Deselect file' : 'Select file'}
                >
                  {selected.has(file.key) ? <Check size={9} /> : null}
                </button>

                <div
                  className={`flex-1 min-w-0 content-panel rounded-sm px-4 py-2 flex items-center gap-3 hover:border-zinc-700 hover:bg-zinc-900/40 active:border-zinc-600 transition-all group ${selected.has(file.key) ? 'border-neon-cyan/40 bg-neon-cyan/[0.03]' : ''}`}
                >
                {/* Icon */}
                <div className={`w-7 h-7 rounded-sm bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 ${config.color}`}>
                  {config.icon}
                </div>

                {/* File Info — filename on top (truncates), then a SINGLE metadata line (book | date | size). */}
                <div className="flex-1 min-w-0">
                  <div className="mb-0.5">
                    <span title={file.filename} className="text-xs text-zinc-200 font-medium truncate block">{file.filename}</span>
                  </div>
                  <div className="flex items-center gap-x-2 text-[9px] font-mono text-zinc-500 whitespace-nowrap min-w-0">
                    <span className="truncate min-w-0">{file.bookTitle || getBookTitle(file.bookId)}</span>
                    <span className="text-zinc-500 shrink-0">|</span>
                    <span className="shrink-0">{formatDateTime(file.timestamp)}</span>
                    <span className="text-zinc-500 shrink-0">|</span>
                    <span className="shrink-0">{formatFileSize(file.size)}</span>
                  </div>
                </div>

                {/* Actions. The first icon is the CROSS-SIDE presence indicator: in LOCAL mode a cloud icon
                    (cyan = also on cloud; click pushes/refreshes to cloud, never removes); in CLOUD mode a
                    download icon (cyan = also on this device; click pulls it down). Then save-to-disk,
                    share, delete-this-side (device in LOCAL, cloud in CLOUD). */}
                <div className="flex items-center gap-0.5 md:gap-1 shrink-0">
                  {mode === 'local' ? (
                    <button
                      onClick={() => syncOne(file)}
                      disabled={busy && !syncing.has(file.key)}
                      className={`p-1.5 md:p-2 hover:bg-zinc-900 rounded-sm transition-all disabled:opacity-40 disabled:hover:bg-transparent ${onOtherSide(file.key) ? 'text-neon-cyan' : 'text-zinc-600 hover:text-neon-cyan'}`}
                      title={onOtherSide(file.key) ? 'On cloud — click to re-sync (refresh). To remove, use Cloud mode.' : 'Local only — click to sync to cloud'}
                    >
                      {syncing.has(file.key) ? <RefreshCw size={14} className="animate-spin" /> : <Cloud size={14} />}
                    </button>
                  ) : (
                    <button
                      onClick={() => downloadOne(file)}
                      disabled={(busy && !syncing.has(file.key)) || onOtherSide(file.key)}
                      className={`p-1.5 md:p-2 hover:bg-zinc-900 rounded-sm transition-all disabled:opacity-40 disabled:hover:bg-transparent ${onOtherSide(file.key) ? 'text-neon-cyan' : 'text-zinc-600 hover:text-neon-cyan'}`}
                      title={onOtherSide(file.key) ? 'Also on this device' : 'Cloud only — click to download to this device'}
                    >
                      {syncing.has(file.key) ? <RefreshCw size={14} className="animate-spin" /> : <CloudDownload size={14} />}
                    </button>
                  )}
                  <button
                    onClick={() => handleDownload(file)}
                    className="p-1.5 md:p-2 text-zinc-600 hover:text-neon-cyan hover:bg-zinc-900 rounded-sm transition-all"
                    title="Export to your file system"
                  >
                    <Save size={14} />
                  </button>
                  <button
                    onClick={async () => { const blob = await getBlob(file); if (blob) shareFile(blob, file.filename, file.filename); }}
                    className="p-1.5 md:p-2 text-zinc-600 hover:text-neon-cyan hover:bg-zinc-900 rounded-sm transition-all"
                    title="Share"
                  >
                    <Share2 size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(file)}
                    disabled={busy}
                    className="p-1.5 md:p-2 text-zinc-600 hover:text-neon-red hover:bg-zinc-900 rounded-sm transition-all disabled:opacity-40 disabled:hover:bg-transparent"
                    title={mode === 'cloud' ? 'Remove from cloud' : 'Delete from this device'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      </div>

      {/* Action footer — ALWAYS shown at the bottom (full-bleed bg-zinc-900 bar, same as the SYS_CONFIG
          Apply bar); the buttons are only enabled for a multi-selection (showBatch). */}
      <div className="shrink-0 flex items-center justify-end gap-2 px-6 py-4 bg-zinc-900 border-t border-zinc-800">
        {mode === 'local' ? (
          <button
            onClick={handleSyncSelected}
            disabled={!showBatch || busy}
            className="btn-action btn-go disabled:opacity-40"
            title="Sync the checked files to the cloud (1 GB quota). To take a file off the cloud, switch to Cloud mode and delete it there."
          >
            {syncing.size > 0 ? <RefreshCw size={13} className="animate-spin" /> : <Cloud size={13} />} SYNC
          </button>
        ) : (
          <button
            onClick={handleDownloadSelected}
            disabled={!showBatch || busy || selectedFiles.every(f => localKeys.has(f.key))}
            className="btn-action btn-go disabled:opacity-40"
            title="Download the checked files to this device (available offline / in the reader)"
          >
            {syncing.size > 0 ? <RefreshCw size={13} className="animate-spin" /> : <CloudDownload size={13} />} DOWNLOAD
          </button>
        )}
        <button
          onClick={handleSaveSelected}
          disabled={!showBatch || busy}
          className="btn-action btn-go disabled:opacity-40"
          title="Export the checked files to your device's file system, to open in native players / readers"
        >
          {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />} EXPORT
        </button>
        <button
          onClick={handleDeleteSelected}
          disabled={!showBatch || busy}
          className={`btn-action btn-stop disabled:opacity-40 ${confirmClear ? 'animate-pulse' : ''}`}
          title={mode === 'cloud' ? 'Remove the checked files from the cloud (click twice to confirm)' : 'Delete the checked files from this device (click twice to confirm)'}
        >
          {deleting ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />} {confirmClear ? (deletePermanent ? 'PERMANENT!' : 'CONFIRM') : (mode === 'cloud' ? 'REMOVE' : 'DELETE')}
        </button>
      </div>

      {/* Over-quota notice — shown when a sync selection would exceed the 1 GB storage limit. */}
      {limitNotice && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in" onClick={() => setLimitNotice(false)}>
          <div className="max-w-xs mx-4 bg-void-1 border border-neon-red/40 rounded-lg p-5 text-center shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-center mb-3 text-neon-red"><AlertTriangle size={28} /></div>
            <p className="text-sm text-zinc-200 font-mono mb-1">Storage limit reached</p>
            <p className="text-xs text-zinc-500 mb-4">Your file exceeds the storage limit, please re-select.</p>
            <button onClick={() => setLimitNotice(false)} className="px-5 py-1.5 rounded-sm text-[11px] font-bold font-mono uppercase border text-neon-cyan border-neon-cyan/30 hover:bg-neon-cyan/10 transition-all">OK</button>
          </div>
        </div>
      )}
    </div>
  );
};
