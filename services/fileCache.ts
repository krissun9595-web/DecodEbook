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
    tx.oncomplete = () => { db.close(); resolve(); };
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
