import { CachedFileMetadata, CachedFile, CachedFileType } from '../types';

const DB_NAME = 'DecodEbook';
const STORE_NAME = 'files';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('bookId', 'bookId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('componentSource', 'componentSource', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- Size-cap + LRU eviction ---------------------------------------------
// IndexedDB has no built-in quota management; without this the 'files' store grows
// unbounded (audio/video/images/translations) until the browser quota is hit and
// writes start failing silently. enforceCacheBudget() is called fire-and-forget
// after each saveFile, mirroring how pronunciationAudio.ts self-trims.
const MAX_CACHE_BYTES = 1_000_000_000; // 1 GB soft cap
const EVICT_TO_BYTES  =   800_000_000; // low-water mark after an eviction pass
// NEVER evict these — losing them forces a full re-extraction / re-upload:
const PROTECTED_TYPES: CachedFileType[] = ['source-file', 'original-file'];

export async function enforceCacheBudget(): Promise<void> {
  const db = await openDB();
  const entries: { key: string; size: number; timestamp: number; fileType: CachedFileType }[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const cursorRequest = tx.objectStore(STORE_NAME).openCursor();
    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const v = cursor.value;
        const size = v.size || 0;
        total += size;
        entries.push({ key: v.key, size, timestamp: v.timestamp || 0, fileType: v.fileType });
        cursor.continue();
      } else resolve();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });

  if (total <= MAX_CACHE_BYTES) { db.close(); return; }

  // Evict oldest-created first among non-protected entries until under the low-water mark.
  const toDelete: string[] = [];
  for (const e of entries
    .filter(e => !PROTECTED_TYPES.includes(e.fileType))
    .sort((a, b) => a.timestamp - b.timestamp)) {
    if (total <= EVICT_TO_BYTES) break;
    toDelete.push(e.key);
    total -= e.size;
  }
  if (!toDelete.length) { db.close(); return; }

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const k of toDelete) store.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function buildCacheKey(bookId: string, chapterId: number, ...segments: string[]): string {
  return [bookId, String(chapterId), ...segments].join(':');
}

export function slugify(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function saveFile(
  key: string,
  blob: Blob,
  metadata: Omit<CachedFileMetadata, 'key' | 'size'>
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ ...metadata, key, size: blob.size, blob });
    tx.oncomplete = () => { db.close(); enforceCacheBudget().catch(() => {}); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getFile(key: string): Promise<CachedFile | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => {
      db.close();
      const record = request.result;
      if (!record) return resolve(null);
      const { blob, ...rest } = record;
      resolve({ metadata: rest as CachedFileMetadata, blob });
    };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function listFiles(bookId?: string): Promise<CachedFileMetadata[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results: CachedFileMetadata[] = [];
    let cursorRequest: IDBRequest;

    if (bookId) {
      const index = store.index('bookId');
      cursorRequest = index.openCursor(IDBKeyRange.only(bookId));
    } else {
      cursorRequest = store.openCursor();
    }

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const { blob, ...meta } = cursor.value;
        results.push(meta as CachedFileMetadata);
        cursor.continue();
      } else {
        db.close();
        resolve(results);
      }
    };
    cursorRequest.onerror = () => { db.close(); reject(cursorRequest.error); };
  });
}

export async function deleteFile(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// Delete every record whose key satisfies `match`, iterating with a KEY cursor so record VALUES (blobs)
// are never cloned — cheap even over a large cache. Used to drop a page's stale audio (keyed by the OLD
// page text) when that page's audio is regenerated, so the panel doesn't accumulate same-filename copies.
export async function deleteMatchingKeys(match: (key: string) => boolean): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const cursorRequest = store.openKeyCursor();
    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursor>).result;
      if (cursor) {
        if (typeof cursor.key === 'string' && match(cursor.key)) store.delete(cursor.key);
        cursor.continue();
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function clearBook(bookId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('bookId');
    const cursorRequest = index.openCursor(IDBKeyRange.only(bookId));

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getTotalSize(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const cursorRequest = store.openCursor();
    let total = 0;

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        total += cursor.value.size || 0;
        cursor.continue();
      } else {
        db.close();
        resolve(total);
      }
    };
    cursorRequest.onerror = () => { db.close(); reject(cursorRequest.error); };
  });
}
