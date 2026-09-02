
import { getSupabase } from './supabase';
import type { FileContext, LibraryItem, NotebookItem } from '../types';

function sb() {
  return getSupabase();
}

const encodeMimeType = (fileContext: FileContext): string => {
  const parts = [fileContext.mimeType || 'text/plain'];
  if (fileContext.sourceKind) parts.push(`sourceKind=${fileContext.sourceKind}`);
  if (fileContext.sourceExtractorVersion) parts.push(`sourceExtractorVersion=${fileContext.sourceExtractorVersion}`);
  if (fileContext.sourceJustified != null) parts.push(`sourceJustified=${fileContext.sourceJustified ? 1 : 0}`);
  return parts.join(';');
};

const decodeMimeType = (value: string): Pick<FileContext, 'mimeType' | 'sourceKind' | 'sourceExtractorVersion' | 'sourceJustified'> => {
  const [base, ...params] = (value || 'text/plain').split(';').map(part => part.trim()).filter(Boolean);
  const decoded: Pick<FileContext, 'mimeType' | 'sourceKind' | 'sourceExtractorVersion' | 'sourceJustified'> = {
    mimeType: base || 'text/plain',
  };
  params.forEach(param => {
    const [key, rawValue] = param.split('=');
    const decodedValue = rawValue?.trim();
    if (key === 'sourceKind' && /^(pdf|epub|text)$/.test(decodedValue || '')) {
      decoded.sourceKind = decodedValue as FileContext['sourceKind'];
    }
    if (key === 'sourceExtractorVersion' && decodedValue) {
      decoded.sourceExtractorVersion = decodedValue;
    }
    if (key === 'sourceJustified' && (decodedValue === '0' || decodedValue === '1')) {
      decoded.sourceJustified = decodedValue === '1';
    }
  });
  return decoded;
};

const mergeFileContextMetadata = (contentOwner: FileContext, metadataOwner: FileContext): FileContext => ({
  ...contentOwner,
  sourceKind: contentOwner.sourceKind || metadataOwner.sourceKind,
  sourceExtractorVersion: contentOwner.sourceExtractorVersion || metadataOwner.sourceExtractorVersion,
  sourceJustified: contentOwner.sourceJustified ?? metadataOwner.sourceJustified,
});

// --- Books ---

export async function saveBookToCloud(userId: string, item: LibraryItem): Promise<void> {
  const client = sb();
  if (!client) return;
  const canSyncContent = item.fileContext.isText;
  const { error } = await client.from('user_books').upsert({
    id: item.book.id,
    user_id: userId,
    title: item.book.title,
    author: item.book.author,
    chapters: item.book.chapters,
    bookmarks: item.book.bookmarks || [],
    content: canSyncContent ? item.fileContext.content : null,
    mime_type: encodeMimeType(item.fileContext),
    is_text: item.fileContext.isText,
    // The outline drives correct chapter re-derivation on reload/other devices; without it hydrate
    // falls back to a lossy heuristic (fewer, mis-split chapters). Sync it so every device rebuilds
    // the same chapters the upload produced.
    pdf_outline: item.fileContext.pdfOutline ?? null,
    upload_date: item.uploadDate,
  }, { onConflict: 'id,user_id' });
  if (error) console.warn('[sync] saveBook failed:', error.message);
}

export async function deleteBookFromCloud(userId: string, bookId: string): Promise<void> {
  const client = sb();
  if (!client) return;
  await client.from('user_books').delete().eq('id', bookId).eq('user_id', userId);
  await client.from('user_reading_state').delete().eq('book_id', bookId).eq('user_id', userId);
}

export async function loadLibraryFromCloud(userId: string): Promise<LibraryItem[]> {
  const client = sb();
  if (!client) return [];
  const { data, error } = await client
    .from('user_books')
    .select('*')
    .eq('user_id', userId)
    .order('upload_date', { ascending: false });
  if (error || !data) { console.warn('[sync] loadLibrary failed:', error?.message); return []; }
  return data.map((row: any) => ({
    book: {
      id: row.id,
      title: row.title,
      author: row.author,
      chapters: row.chapters || [],
      bookmarks: row.bookmarks || [],
    },
    fileContext: {
      content: row.content || '',
      ...decodeMimeType(row.mime_type),
      isText: row.is_text,
      pdfOutline: row.pdf_outline ?? undefined,
    },
    uploadDate: row.upload_date,
  }));
}

// --- Notebook ---

export async function saveNotebookToCloud(userId: string, items: NotebookItem[]): Promise<void> {
  const client = sb();
  if (!client) return;
  const rows = items.map(item => ({
    id: item.id,
    user_id: userId,
    text: item.text,
    type: item.type,
    definition: item.definition || null,
    timestamp: item.timestamp,
    source_chapter: item.sourceChapter || null,
    book_title: item.bookTitle || null,
    book_author: item.bookAuthor || null,
    comment: item.comment || null,
    context_source: item.inked && item.contextSource && !/inked/i.test(item.contextSource)
      ? `${item.contextSource}:INKED`
      : item.contextSource || null,
  }));
  await client.from('user_notebook').delete().eq('user_id', userId);
  if (rows.length > 0) {
    const { error } = await client.from('user_notebook').insert(rows);
    if (error) console.warn('[sync] saveNotebook failed:', error.message);
  }
}

export async function loadNotebookFromCloud(userId: string): Promise<NotebookItem[]> {
  const client = sb();
  if (!client) return [];
  const { data, error } = await client
    .from('user_notebook')
    .select('*')
    .eq('user_id', userId)
    .order('timestamp', { ascending: false });
  if (error || !data) { console.warn('[sync] loadNotebook failed:', error?.message); return []; }
  return data.map((row: any) => ({
    id: row.id,
    text: row.text,
    type: row.type,
    definition: row.definition || undefined,
    timestamp: row.timestamp,
    sourceChapter: row.source_chapter || undefined,
    bookTitle: row.book_title || undefined,
    bookAuthor: row.book_author || undefined,
    comment: row.comment || undefined,
    contextSource: row.context_source || undefined,
    inked: /inked/i.test(row.context_source || ''),
  }));
}

// --- Reading position ---

export async function saveReadingPosition(userId: string, bookId: string, chapterId: number): Promise<void> {
  const client = sb();
  if (!client) return;
  const { error } = await client.from('user_reading_state').upsert({
    user_id: userId,
    book_id: bookId,
    active_chapter_id: chapterId,
  }, { onConflict: 'user_id,book_id' });
  if (error) console.warn('[sync] saveReadingPosition failed:', error.message);
}

export async function loadReadingPositions(userId: string): Promise<Record<string, number>> {
  const client = sb();
  if (!client) return {};
  const { data, error } = await client
    .from('user_reading_state')
    .select('book_id, active_chapter_id')
    .eq('user_id', userId);
  if (error || !data) return {};
  const map: Record<string, number> = {};
  data.forEach((row: any) => { if (row.active_chapter_id != null) map[row.book_id] = row.active_chapter_id; });
  return map;
}

// --- Merge logic (called once on login) ---

// Stable book identity for dedup. book.id is a random UUID minted per upload/extraction,
// so it CANNOT identify a book across devices or extractor versions — merging by it let the
// same book pile up as duplicate copies. Two items are the SAME book if they share
// (title+format) OR (filename+format) — mirrors the upload-path `sameBook` dedup.
function bookIdKeys(item: LibraryItem): { title: string; file: string } {
  const kind = item.fileContext?.sourceKind || '';
  const title = (item.book?.title || '').trim().toLowerCase();
  const file = (item.fileContext?.sourceFileName || '').trim().toLowerCase();
  return { title: title ? `${title}|${kind}` : '', file: file ? `${file}|${kind}` : '' };
}
function sameBookIdentity(a: LibraryItem, b: LibraryItem): boolean {
  const ka = bookIdKeys(a), kb = bookIdKeys(b);
  return (!!ka.title && ka.title === kb.title) || (!!ka.file && ka.file === kb.file);
}
// Winner among duplicate copies: highest extractor version → has inline content → newest upload.
function extractorVersionNum(item: LibraryItem): number {
  const m = /v(\d+)/.exec(item.fileContext?.sourceExtractorVersion || '');
  return m ? parseInt(m[1], 10) : 0;
}
function rankGreater(a: LibraryItem, b: LibraryItem): boolean {
  const va = extractorVersionNum(a), vb = extractorVersionNum(b);
  if (va !== vb) return va > vb;
  const ca = a.fileContext?.content ? 1 : 0, cb = b.fileContext?.content ? 1 : 0;
  if (ca !== cb) return ca > cb;
  return (a.uploadDate || 0) > (b.uploadDate || 0);
}

export function mergeLibrary(local: LibraryItem[], cloud: LibraryItem[]): { merged: LibraryItem[]; toUpload: LibraryItem[]; toDelete: LibraryItem[] } {
  const cloudIds = new Set(cloud.map(i => i.book.id));
  const entries = [
    ...cloud.map(item => ({ item, origin: 'cloud' as const })),
    ...local.map(item => ({ item, origin: 'local' as const })),
  ];
  // Group every copy (local + cloud) by stable identity.
  const groups: (typeof entries)[] = [];
  for (const e of entries) {
    const g = groups.find(grp => grp.some(x => sameBookIdentity(x.item, e.item)));
    if (g) g.push(e); else groups.push([e]);
  }

  const merged: LibraryItem[] = [];
  const toUpload: LibraryItem[] = [];
  const toDelete: LibraryItem[] = [];

  for (const g of groups) {
    // Pick the winner (best extraction copy).
    let winner = g[0].item;
    for (const e of g) if (rankGreater(e.item, winner)) winner = e.item;
    // Preserve the most bookmarks across all copies of this book.
    const bestBookmarks = g.reduce<any[]>((best, e) => {
      const bm = e.item.book?.bookmarks || [];
      return bm.length > best.length ? bm : best;
    }, winner.book?.bookmarks || []);
    const win: LibraryItem = { ...winner, book: { ...winner.book, bookmarks: bestBookmarks } };
    merged.push(win);

    // Every other copy in the group is a duplicate to purge (cloud row + cache).
    for (const e of g) {
      if (e.item.book.id !== winner.book.id) toDelete.push(e.item);
    }
    // Upload the winner if the cloud doesn't already hold this exact copy.
    if (!cloudIds.has(win.book.id)) toUpload.push(win);
  }

  merged.sort((a, b) => b.uploadDate - a.uploadDate);
  return { merged, toUpload, toDelete };
}

export function mergeNotebook(local: NotebookItem[], cloud: NotebookItem[]): NotebookItem[] {
  const map = new Map<string, NotebookItem>();
  for (const item of cloud) map.set(item.id, item);
  for (const item of local) {
    const existing = map.get(item.id);
    if (!existing || item.timestamp > existing.timestamp) {
      map.set(item.id, item);
    }
  }
  // Dedup by text content
  const seen = new Set<string>();
  const result: NotebookItem[] = [];
  const sorted = [...map.values()].sort((a, b) => b.timestamp - a.timestamp);
  for (const item of sorted) {
    if (!seen.has(item.text)) {
      seen.add(item.text);
      result.push(item);
    }
  }
  return result;
}

// --- Debounce helper ---

export function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as any;
}
