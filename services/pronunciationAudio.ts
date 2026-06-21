import { generateSpeech } from './gemini';
import { pcmToWav } from '../utils/audio';

const DB_NAME = 'DecodEbookPronunciation';
const STORE_NAME = 'audio';
const DB_VERSION = 1;
const CACHE_VERSION = 'v1';
const MAX_ENTRIES = 180;
const DEFAULT_VOICE = 'Puck';

interface PronunciationRecord {
  key: string;
  blob: Blob;
  timestamp: number;
  lastUsed: number;
}

const memoryCache = new Map<string, Blob>();
const inflight = new Map<string, Promise<Blob>>();
let sharedAudio: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;
let speechFallbackActive = false;
let activePlaybackKey: string | null = null;
let activePlaybackResolve: (() => void) | null = null;

const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim();

const hashText = (text: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const cacheKeyFor = (text: string, voice: string): string => {
  const normalized = normalizeText(text).toLowerCase();
  return [CACHE_VERSION, voice, normalized.length.toString(36), hashText(normalized)].join(':');
};

const openDB = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('lastUsed', 'lastUsed', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
};

const readBlob = async (key: string): Promise<Blob | null> => {
  const cached = memoryCache.get(key);
  if (cached) return cached;

  const db = await openDB();
  if (!db) return null;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => {
      const record = request.result as PronunciationRecord | undefined;
      if (record?.blob) {
        memoryCache.set(key, record.blob);
        store.put({ ...record, lastUsed: Date.now() });
        resolve(record.blob);
      } else {
        resolve(null);
      }
    };
    request.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
};

const trimCache = async (store: IDBObjectStore): Promise<void> => {
  const countRequest = store.count();
  const count = await new Promise<number>((resolve) => {
    countRequest.onsuccess = () => resolve(countRequest.result);
    countRequest.onerror = () => resolve(0);
  });
  if (count <= MAX_ENTRIES) return;

  const excess = count - MAX_ENTRIES;
  const index = store.index('lastUsed');
  const cursorRequest = index.openCursor();
  let removed = 0;
  await new Promise<void>((resolve) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || removed >= excess) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      removed++;
      cursor.continue();
    };
    cursorRequest.onerror = () => resolve();
  });
};

const writeBlob = async (key: string, blob: Blob): Promise<void> => {
  memoryCache.set(key, blob);
  const db = await openDB();
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const now = Date.now();
    store.put({ key, blob, timestamp: now, lastUsed: now } satisfies PronunciationRecord);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
    trimCache(store).catch(() => undefined);
  });
};

const base64PcmToWavBlob = (base64: string): Blob => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return pcmToWav(bytes.buffer, 24000);
};

export const getPronunciationBlob = async (text: string, voice: string = DEFAULT_VOICE): Promise<Blob> => {
  const normalized = normalizeText(text);
  if (!normalized) throw new Error('No pronunciation text provided');

  const key = cacheKeyFor(normalized, voice);
  const cached = await readBlob(key);
  if (cached) return cached;

  const existing = inflight.get(key);
  if (existing) return existing;

  const job = (async () => {
    const audioBase64 = await generateSpeech(normalized, voice);
    const blob = base64PcmToWavBlob(audioBase64);
    await writeBlob(key, blob);
    return blob;
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
};

const finishActivePlayback = (): void => {
  const resolve = activePlaybackResolve;
  activePlaybackResolve = null;
  activePlaybackKey = null;
  speechFallbackActive = false;
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = null;
  if (resolve) resolve();
};

export const stopPronunciationAudio = (text?: string, voice: string = DEFAULT_VOICE): boolean => {
  const normalized = text ? normalizeText(text) : '';
  const targetKey = normalized ? cacheKeyFor(normalized, voice) : null;
  if (targetKey && activePlaybackKey !== targetKey) return false;

  const hadAudio = Boolean(sharedAudio && !sharedAudio.paused);
  const hadSpeech = speechFallbackActive;
  const hadPlayback = Boolean(activePlaybackKey || activePlaybackResolve || hadAudio || hadSpeech);
  if (!hadPlayback) return false;

  if (sharedAudio) {
    sharedAudio.pause();
    sharedAudio.currentTime = 0;
    sharedAudio.removeAttribute('src');
  }
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  finishActivePlayback();
  return true;
};

const playBlob = async (blob: Blob, key: string): Promise<void> => {
  if (!sharedAudio) sharedAudio = new Audio();

  if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.cancel();
    speechFallbackActive = false;
  }

  stopPronunciationAudio();
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = URL.createObjectURL(blob);
  activePlaybackKey = key;
  sharedAudio.src = activeObjectUrl;
  await new Promise<void>((resolve, reject) => {
    activePlaybackResolve = resolve;
    sharedAudio!.onended = finishActivePlayback;
    sharedAudio!.onerror = () => {
      finishActivePlayback();
      reject(new Error('Pronunciation playback failed.'));
    };
    sharedAudio!.play().catch(error => {
      finishActivePlayback();
      reject(error);
    });
  });
};

const speakWithWebSpeech = (text: string, key: string): Promise<boolean> => {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return Promise.resolve(false);
  const normalized = normalizeText(text);
  if (!normalized) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    try {
      stopPronunciationAudio();
      const utterance = new SpeechSynthesisUtterance(normalized);
      utterance.rate = 0.92;
      utterance.pitch = 1;
      activePlaybackKey = key;
      speechFallbackActive = true;
      activePlaybackResolve = () => resolve(true);
      utterance.onend = finishActivePlayback;
      utterance.onerror = finishActivePlayback;
      speechSynthesis.speak(utterance);
    } catch {
      finishActivePlayback();
      resolve(false);
    }
  });
};

export const prefetchPronunciation = (text: string, voice: string = DEFAULT_VOICE): void => {
  if (!normalizeText(text)) return;
  getPronunciationBlob(text, voice).catch(error => {
    console.warn('Pronunciation prefetch failed:', error);
  });
};

export const playPronunciationAudio = async (text: string, voice: string = DEFAULT_VOICE): Promise<void> => {
  const normalized = normalizeText(text);
  if (!normalized) throw new Error('No pronunciation text provided');

  const key = cacheKeyFor(normalized, voice);
  const cached = await readBlob(key);
  if (cached) {
    await playBlob(cached, key);
    return;
  }

  let fallbackPromise: Promise<boolean> | null = null;
  let settled = false;
  const fallbackTimer = window.setTimeout(() => {
    if (settled) return;
    fallbackPromise = speakWithWebSpeech(normalized, key);
  }, 700);

  try {
    const blob = await getPronunciationBlob(normalized, voice);
    settled = true;
    window.clearTimeout(fallbackTimer);
    if (fallbackPromise || speechFallbackActive) {
      if (fallbackPromise) await fallbackPromise;
      return;
    }
    await playBlob(blob, key);
  } catch (error) {
    settled = true;
    window.clearTimeout(fallbackTimer);
    if (!fallbackPromise) {
      fallbackPromise = speakWithWebSpeech(normalized, key);
    }
    const fallbackStarted = await fallbackPromise;
    if (fallbackStarted) return;
    throw error;
  }
};
