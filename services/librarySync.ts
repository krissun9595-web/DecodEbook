
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

export function mergeLibrary(local: LibraryItem[], cloud: LibraryItem[]): { merged: LibraryItem[]; toUpload: LibraryItem[] } {
  const cloudMap = new Map(cloud.map(item => [item.book.id, item]));
  const localMap = new Map(local.map(item => [item.book.id, item]));
  const merged: LibraryItem[] = [];
  const toUpload: LibraryItem[] = [];

  for (const [id, cloudItem] of cloudMap) {
    const localItem = localMap.get(id);
    if (!localItem) {
      merged.push(cloudItem);
    } else {
      // Cloud has full content; local may have content stripped to ''
      if (cloudItem.fileContext.content && !localItem.fileContext.content) {
        // Prefer cloud for content, but keep local bookmarks if newer
        const item: LibraryItem = {
          ...cloudItem,
          fileContext: mergeFileContextMetadata(cloudItem.fileContext, localItem.fileContext),
        };
        if (localItem.book.bookmarks?.length > (cloudItem.book.bookmarks?.length || 0)) {
          item.book = { ...item.book, bookmarks: localItem.book.bookmarks };
        }
        merged.push(item);
      } else {
        merged.push(localItem);
      }
    }
    localMap.delete(id);
  }

  // Items only in local — need to upload to cloud
  for (const [, localItem] of localMap) {
    merged.push(localItem);
    toUpload.push(localItem);
  }

  merged.sort((a, b) => b.uploadDate - a.uploadDate);
  return { merged, toUpload };
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
