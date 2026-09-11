import { listFiles, getFile, saveFile } from './fileCache';
import { uploadFigureToCloud, fetchGenFileFromCloud, getSyncedFileMeta, uploadSidecar, fetchSidecar } from './supabase';
import { CachedFile } from '../types';

// localStorage keys for the client-side sidecar data (must match the reader's own keys).
const TIMINGS_LS = (audioKey: string) => `decodebook_audio_timings:${audioKey}`;
const PODCAST_TITLE_LS = (key: string) => `decodebook_podcast_title:${key}`;

// Upload the sidecar (read-aloud timings / podcast episode title) that goes with an audio/podcast
// file but isn't in its blob. Called by the panel right after that file is synced to the cloud.
export async function syncSidecarFor(key: string): Promise<void> {
  try {
    const type = key.split(':')[2];
    if (type === 'audio') {
      const raw = localStorage.getItem(TIMINGS_LS(key));
      if (raw) await uploadSidecar(key, { timings: JSON.parse(raw) });
    } else if (type === 'podcast-audio') {
      const title = localStorage.getItem(PODCAST_TITLE_LS(key));
      if (title) await uploadSidecar(key, { episodeTitle: title });
    }
  } catch { /* best-effort */ }
}

// Pull an audio/podcast file's sidecar from the cloud and write it to localStorage so the reader's
// existing readStoredTimings / episode-title lookups find it (→ sentence sync + title cross-device).
async function restoreSidecar(key: string): Promise<void> {
  try {
    const type = key.split(':')[2];
    if (type !== 'audio' && type !== 'podcast-audio') return;
    const side = await fetchSidecar(key);
    if (!side) return;
    if (side.timings) localStorage.setItem(TIMINGS_LS(key), JSON.stringify(side.timings));
    if (side.episodeTitle) localStorage.setItem(PODCAST_TITLE_LS(key), side.episodeTitle);
  } catch { /* best-effort */ }
}

// Reader-side auto-pull: return a cached file, transparently fetching it from the cloud on a LOCAL
// miss (so a SYNCED generated file — audio / video / podcast / image — plays on a device that never
// generated it). The pulled blob is written to the local cache so later loads are instant + offline.
// A non-synced key just misses in the cloud (returns null) → identical to a plain getFile miss, at
// the cost of one extra request; callers use this only for genuinely syncable generated media.
export async function getFileOrCloud(key: string): Promise<CachedFile | null> {
  const local = await getFile(key);
  if (local) return local;
  const blob = await fetchGenFileFromCloud(key);
  if (!blob) return null;
  await restoreSidecar(key); // pull timings / episode title so highlighting + podcast title work here
  // Prefer the REAL metadata from the index row so the cached file keeps its proper name / type /
  // book; fall back to parsing the buildCacheKey layout `bookId:chapterId:fileType:...segments`.
  const parts = key.split(':');
  const meta = await getSyncedFileMeta(key);
  const filename = meta?.filename || parts.slice(2).join('-') || 'file';
  const fileType = (meta?.file_type || parts[2] || 'translation') as any;
  const bookId = meta?.book_id || parts[0] || '';
  const bookTitle = meta?.book_title || '';
  const mimeType = blob.type || 'application/octet-stream';
  const timestamp = meta?.synced_at || Date.now(); // keep the ORIGINAL time, not the pull time
  try {
    await saveFile(key, blob, { filename, mimeType, timestamp, bookId, bookTitle, chapterId: Number(parts[1]) || 0, componentSource: 'CloudSync', fileType });
    const cached = await getFile(key);
    if (cached) return cached;
  } catch { /* cache write best-effort */ }
  return { metadata: { key, filename, mimeType, size: blob.size, timestamp, bookId, bookTitle, chapterId: Number(parts[1]) || 0, componentSource: 'CloudSync', fileType }, blob };
}

// One-per-session guard so re-opening a book (or switching chapters, which remounts the reader)
// doesn't re-sweep. uploadFigureToCloud is itself idempotent, but this avoids the extra work.
const _sweptBooks = new Set<string>();

// Mirror ALL of a book's locally-cached figures to the cloud, not just the ones the user happens to
// view. The reader's per-figure upload only fires on a render (a cache HIT), so a book opened on the
// upload device but only partly read leaves most figures cloud-missing → "figure unavailable" on
// other devices. This sweeps the whole book once per session. Best-effort and safe on every device:
// a device that only received the synced text has no local figures here, so it uploads nothing.
export async function syncBookFiguresToCloud(bookId: string): Promise<void> {
  if (!bookId || _sweptBooks.has(bookId)) return;
  _sweptBooks.add(bookId);
  try {
    const figs = (await listFiles(bookId)).filter(f => f.fileType === 'figure-image');
    for (const f of figs) {
      // key layout: `${bookId}:0:figure-image:${figId}` — everything after the type is the figure id.
      const figId = f.key.split(':').slice(3).join(':');
      if (!figId) continue;
      const rec = await getFile(f.key);
      if (rec?.blob) await uploadFigureToCloud(bookId, figId, rec.blob);
    }
  } catch { /* best-effort — a sync failure must never disrupt reading */ }
}
