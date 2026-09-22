
import { createClient, SupabaseClient, User, Session } from '@supabase/supabase-js';

// These will be set by the user in the app's connection settings.
// Default to empty strings — the app works offline without Supabase.
const SUPABASE_URL = (typeof process !== 'undefined' && process.env?.SUPABASE_URL) || '';
const SUPABASE_ANON_KEY = (typeof process !== 'undefined' && process.env?.SUPABASE_ANON_KEY) || '';

let supabase: SupabaseClient | null = null;

// Visitor country (ISO code) from Cloudflare geo-IP via /api/config, for model routing.
let _detectedCountry: string | null = null;
export const getDetectedCountry = () => _detectedCountry;

export function getSupabase(): SupabaseClient | null {
  if (supabase) return supabase;

  // Try env vars first, then localStorage for user-provided config
  const url = SUPABASE_URL || localStorage.getItem('supabase_url') || '';
  const key = SUPABASE_ANON_KEY || localStorage.getItem('supabase_anon_key') || '';

  if (!url || !key) return null;

  supabase = createClient(url, key, {
    // OAuth callbacks are exchanged explicitly by handleOAuthCallback() during app bootstrap.
    // Leaving detectSessionInUrl enabled makes GoTrue auto-exchange the code as the client
    // initializes, then our explicit exchange races it and reports "PKCE code verifier not found".
    auth: { detectSessionInUrl: false, flowType: 'pkce' },
  });
  return supabase;
}

export function configureSupabase(url: string, anonKey: string) {
  localStorage.setItem('supabase_url', url);
  localStorage.setItem('supabase_anon_key', anonKey);
  supabase = createClient(url, anonKey, {
    auth: { detectSessionInUrl: false, flowType: 'pkce' },
  });
  return supabase;
}

export function isSupabaseConfigured(): boolean {
  return getSupabase() !== null;
}

export async function bootstrapSupabase(): Promise<boolean> {
  const alreadyConfigured = isSupabaseConfigured();
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return alreadyConfigured;
    const data = await res.json();
    if (data.country) _detectedCountry = data.country;
    if (data.stripeProPriceId) localStorage.setItem('stripe_pro_price_id', data.stripeProPriceId);
    if (data.stripeProAnnualPriceId) localStorage.setItem('stripe_pro_annual_price_id', data.stripeProAnnualPriceId);
    if (data.stripePackSPriceId) localStorage.setItem('stripe_pack_s_price_id', data.stripePackSPriceId);
    if (data.stripePackMPriceId) localStorage.setItem('stripe_pack_m_price_id', data.stripePackMPriceId);
    if (data.stripePackLPriceId) localStorage.setItem('stripe_pack_l_price_id', data.stripePackLPriceId);
    if (data.supabaseUrl && data.supabaseAnonKey) {
      // /api/config is authoritative per environment. If it differs from what this
      // browser cached (e.g. it previously used a different env), re-point — otherwise
      // a browser that visited prod keeps using prod's config on staging (and vice
      // versa), so logins hit the wrong database.
      if (data.supabaseUrl !== localStorage.getItem('supabase_url') ||
          data.supabaseAnonKey !== localStorage.getItem('supabase_anon_key')) {
        configureSupabase(data.supabaseUrl, data.supabaseAnonKey);
      }
      return true;
    }
    // No server-provided config (e.g. self-hosted with user-set localStorage) — keep
    // whatever was already configured.
    if (alreadyConfigured) return true;
  } catch {}
  finally { if (isSupabaseConfigured()) flushPendingUsage(); }
  return alreadyConfigured;
}

export async function handleOAuthCallback(): Promise<Session | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return null;

  const client = getSupabase();
  if (!client) return null;

  try {
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    window.history.replaceState({}, '', window.location.pathname);
    if (error) {
      console.error('[Supabase] OAuth code exchange failed:', error.message);
      return null;
    }
    return data.session;
  } catch (e) {
    console.error('[Supabase] OAuth code exchange error:', e);
    return null;
  }
}

export async function testConnection(): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  try {
    // A lightweight call that verifies the URL and key are valid
    const { error } = await client.auth.getSession();
    return !error;
  } catch {
    return false;
  }
}

// ---- Auth helpers ----

// Version of the Terms of Service / Privacy Policy the user agrees to at sign-up. Bump this when the
// legal docs change materially; the recorded value + timestamp is our proof-of-consent and lets us
// re-prompt users whose accepted version is older than the current one.
export const TERMS_VERSION = '2026-09-18';

export async function signUp(email: string, password: string) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured. Check supabase_url and supabase_anon_key in localStorage.');
  console.log('[Supabase] signUp attempt:', email);
  // Record consent to the Terms/Privacy at sign-up (the UI requires the agree checkbox before this
  // runs). Stored in auth user_metadata so it's captured atomically with the account, survives the
  // email-confirmation flow, and is queryable/tamper-evident.
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() } },
  });
  if (error) {
    console.error('[Supabase] signUp error:', error.message, error.status, error);
    throw error;
  }
  console.log('[Supabase] signUp success:', data.user?.id, 'confirmed:', data.user?.confirmed_at ? 'yes' : 'no (email confirmation required)');
  return data;
}

export async function signIn(email: string, password: string) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured. Check supabase_url and supabase_anon_key in localStorage.');
  console.log('[Supabase] signIn attempt:', email);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    console.error('[Supabase] signIn error:', error.message, error.status, error);
    throw error;
  }
  console.log('[Supabase] signIn success:', data.user?.id);
  return data;
}

export async function signInWithOAuth(provider: 'google' | 'github' | 'x' | 'discord') {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured');
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const client = getSupabase();
  if (!client) return;
  await client.auth.signOut();
}

// Permanently delete the signed-in user's account and all associated data. The worker
// (service role) deletes the non-cascading rows, the user's Storage folder, and the auth
// user (which cascades the rest); we then sign out locally.
export async function deleteAccount(): Promise<void> {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured.');
  const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw new Error('You must be signed in to delete your account.');
  const res = await fetch(`${window.location.origin}/api/account/delete`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as any));
    throw new Error((body as any).error || 'Failed to delete account. Please try again or contact support@decodebook.app.');
  }
  await client.auth.signOut().catch(() => {});
}

// ---- Identity (account) linking ----
// Requires "Manual linking" enabled in Supabase Auth settings.
export async function linkProvider(provider: string) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured');
  const { data, error } = await (client.auth as any).linkIdentity({ provider, options: { redirectTo: window.location.origin } });
  if (error) throw error;
  return data;
}

export async function unlinkProvider(identity: any) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured');
  const { error } = await (client.auth as any).unlinkIdentity(identity);
  if (error) throw error;
}

export async function getIdentities(): Promise<any[]> {
  const client = getSupabase();
  if (!client) return [];
  const { data } = await (client.auth as any).getUserIdentities();
  return data?.identities || [];
}

export async function resetPassword(email: string) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured');
  const { error } = await client.auth.resetPasswordForEmail(email);
  if (error) throw error;
}

export async function getSession(): Promise<Session | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session;
}

export async function getUser(): Promise<User | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data } = await client.auth.getUser();
  return data.user;
}

export function onAuthStateChange(callback: (user: User | null) => void): (() => void) | null {
  const client = getSupabase();
  if (!client) return null;
  const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
    const user = session?.user ?? null;
    // Record consent for sign-ins that didn't go through the email signUp path (OAuth: Google/GitHub/
    // X/Discord — and any legacy account created before consent was recorded). The AuthGate shows the
    // "By continuing you agree to the Terms/Privacy" notice, so an authenticated session implies consent.
    // Idempotent: only writes when terms_version is missing; the resulting USER_UPDATED event no-ops.
    if (user && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && !(user.user_metadata as any)?.terms_version) {
      client.auth.updateUser({ data: { terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() } }).catch(() => {});
    }
    callback(user);
  });
  return () => subscription.unsubscribe();
}

// ---- Settings sync ----

export interface UserSettings {
  gemini_key?: string;
  openrouter_key?: string;
  target_language?: string;
  highlight_color?: string;
  text_size?: string;
  line_height?: string;
  letter_spacing?: string;
  font?: string;
  llm_model?: string;
  tts_model?: string;
  image_model?: string;
  video_model?: string;
}

export async function loadUserSettings(userId: string): Promise<UserSettings | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data, error } = await client
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data as UserSettings;
}

export async function saveUserSettings(userId: string, settings: UserSettings) {
  const client = getSupabase();
  if (!client) return;
  const { error } = await client
    .from('user_settings')
    .upsert({ user_id: userId, ...settings, updated_at: new Date().toISOString() });
  if (error) console.warn('[Supabase] Failed to save settings:', error.message);
}

// ---- Usage logging (durable + idempotent) ----
//
// Every computed charge is stashed to a durable local queue the instant it's computed, BEFORE
// the network write — so a closed tab, a crash, or a dropped request can no longer make us
// silently eat the cost. flushPendingUsage() (on boot + after each write) retries leftovers.
// usage_id (migration 022) makes a re-send a no-op via ON CONFLICT DO NOTHING, so retries
// never double-charge and never double-fire the pack/referral AFTER-INSERT triggers. If the
// columns aren't there yet (pre-migration) it falls back to a plain insert — exactly the old
// behaviour, and it stops retrying that keyless row so it can't duplicate.

const PENDING_USAGE_KEY = 'decode_pending_usage';
const PENDING_USAGE_CAP = 200; // bound local growth if the network stays down for a long time

type UsageRow = Record<string, any>;

function readPending(): UsageRow[] {
  try { const raw = localStorage.getItem(PENDING_USAGE_KEY); const a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a : []; } catch { return []; }
}
function writePending(rows: UsageRow[]) {
  try { localStorage.setItem(PENDING_USAGE_KEY, JSON.stringify(rows.slice(-PENDING_USAGE_CAP))); } catch {}
}
function enqueuePending(row: UsageRow) {
  if (!row.usage_id) return; // durability needs the idempotency key; without it, behave as before
  try { const rows = readPending().filter(r => r.usage_id !== row.usage_id); rows.push(row); writePending(rows); } catch {}
}
function dequeuePending(usageId?: string | null) {
  if (!usageId) return;
  try { writePending(readPending().filter(r => r.usage_id !== usageId)); } catch {}
}

// Insert one usage row. Idempotent when usage_id is present (ON CONFLICT DO NOTHING). Returns
// true when the row is durably recorded (or provably a duplicate) → safe to drop from the queue;
// false on a transient error → keep it queued for the next flush (idempotency makes retry safe).
async function insertUsageRow(client: SupabaseClient, row: UsageRow): Promise<boolean> {
  if (row.usage_id) {
    const { error } = await client.from('usage_logs').upsert(row, { onConflict: 'usage_id', ignoreDuplicates: true });
    if (!error) return true;
    // Schema not migrated yet — either the usage_id column is missing OR its unique index isn't
    // there so PostgREST rejects the ON CONFLICT ("no unique or exclusion constraint", 42P10).
    // Fall back to a plain insert ONCE (records the charge, no retry → no dupe), exactly the old
    // behaviour. Transient errors (network / 5xx) DON'T match → return false so the durable queue
    // retries idempotently once the schema is in place.
    const emsg = `${error.message || ''} ${(error as any).code || ''} ${(error as any).details || ''}`;
    // Phase B: the worker (service_role) is the sole writer of credit-bearing rows; RLS now
    // REJECTS a client insert of a row with credits_cost > 0 (Postgres 42501 / "row-level
    // security"). That's expected, not transient — the worker already recorded (or will record)
    // this charge on the same usage_id. Drop it so the durable queue doesn't retry forever.
    if (/42501|row-level security|violates row-level|permission denied/i.test(emsg)) return true;
    if (/usage_id|on conflict|unique or exclusion|no unique|42P10|does not exist/i.test(emsg)) {
      const { usage_id, ...noId } = row;
      const { error: e2 } = await client.from('usage_logs').insert(noId);
      if (e2 && /session_id/i.test(e2.message || '') && noId.session_id) {
        const { session_id, ...noSess } = noId;
        await client.from('usage_logs').insert(noSess);
      }
      return true;
    }
    return false; // transient → retry later
  }
  // legacy path (no key) — exactly the previous behaviour
  const { error } = await client.from('usage_logs').insert(row);
  if (error && row.session_id) { const { session_id, ...base } = row; await client.from('usage_logs').insert(base); }
  return true;
}

// Retry any usage rows a previous session (or a failed write) left behind. Safe to call anytime.
export async function flushPendingUsage(): Promise<void> {
  const client = getSupabase();
  if (!client) return;
  const rows = readPending();
  if (!rows.length) return;
  for (const row of rows) {
    try { if (await insertUsageRow(client, row)) dequeuePending(row.usage_id); } catch {}
  }
}

export async function logUsage(userId: string, action: string, tokensUsed: number = 0, costCents: number = 0, inputTokens: number = 0, outputTokens: number = 0, creditsCost: number = 0, model: string | null = null, book: string | null = null, sessionId: string | null = null, usageId: string | null = null) {
  const client = getSupabase();
  if (!client) return;
  const row: UsageRow = { user_id: userId, action, tokens_used: tokensUsed, cost_cents: costCents, input_tokens: inputTokens, output_tokens: outputTokens, credits_cost: creditsCost, model, book_title: book };
  if (sessionId) row.session_id = sessionId;
  if (usageId) row.usage_id = usageId;
  enqueuePending(row);   // durable stash first (best-effort; survives tab-close / crash)
  try { if (await insertUsageRow(client, row)) dequeuePending(usageId); } catch {}
}

// ============================================================================
// Cross-device media sync (Supabase Storage). Extracted figure images live only in the local
// IndexedDB file cache (services/fileCache.ts) — librarySync carries a book's TEXT, never its
// binary blobs — so a book opened on a SECOND device shows empty figure boxes. These helpers
// mirror figure blobs to a per-user Storage bucket so any device can pull them on demand.
//
// The bucket is PRIVATE; RLS (sql/026) scopes every object to the caller's own {user_id}/ folder,
// so a user can only read/write their own media. Path: {user_id}/{bookId}/figure-image/{figId}.
// Both calls are best-effort and never throw — a Storage outage must not break reading.
// ============================================================================
const MEDIA_BUCKET = 'book-media';
const _uploadedFigs = new Set<string>(); // in-session de-dupe so a re-view doesn't re-upload

function figureStoragePath(userId: string, bookId: string, figId: string): string {
  // figId is model/extractor-generated; encode so a stray slash/space can't escape the folder.
  return `${userId}/${encodeURIComponent(bookId)}/figure-image/${encodeURIComponent(figId)}`;
}

// Mirror one figure blob to the cloud (upsert). Called on a LOCAL cache HIT so simply opening a
// book on the device that extracted it backfills the cloud copy — no separate migration pass.
export async function uploadFigureToCloud(bookId: string, figId: string, blob: Blob): Promise<void> {
  const client = getSupabase();
  if (!client || !bookId || !figId || !blob || blob.size === 0) return;
  const dedupeKey = `${bookId}:${figId}`;
  if (_uploadedFigs.has(dedupeKey)) return;
  try {
    const user = await getUser();
    if (!user) return;
    const path = figureStoragePath(user.id, bookId, figId);
    const { error } = await client.storage.from(MEDIA_BUCKET)
      .upload(path, blob, { upsert: true, contentType: blob.type || 'image/jpeg' });
    if (!error) {
      _uploadedFigs.add(dedupeKey); // mark done only on success; a fail retries next view
      // Index figures too (type 'figure-image') so they count toward the cloud storage total. They're
      // a HIDDEN type, so they never appear as a row in the GEN_FILES list — just in the meter.
      await client.from('user_synced_files').upsert({
        user_id: user.id, file_key: `${bookId}:0:figure-image:${figId}`,
        filename: `${figId}.jpg`, file_type: 'figure-image', size: blob.size,
        book_id: bookId, book_title: '', synced_at: Date.now(),
      }, { onConflict: 'user_id,file_key' }).then(() => {}, () => {});
    }
  } catch { /* best-effort */ }
}

// Pull one figure blob from the cloud. Called on a LOCAL cache MISS (e.g. a second device that
// only received the synced text). Returns null when absent so the caller can show 'missing'.
export async function fetchFigureFromCloud(bookId: string, figId: string): Promise<Blob | null> {
  const client = getSupabase();
  if (!client || !bookId || !figId) return null;
  try {
    const user = await getUser();
    if (!user) return null;
    const path = figureStoragePath(user.id, bookId, figId);
    const { data, error } = await client.storage.from(MEDIA_BUCKET).download(path);
    if (error || !data) return null;
    _uploadedFigs.add(`${bookId}:${figId}`); // it's already in the cloud — don't re-upload it
    return data;
  } catch { return null; }
}

// --- Generated-file cloud sync (opt-in, quota-bounded) --------------------------------------
// The GEN_FILES panel lets a user mirror selected generated deliverables (translations, audio,
// podcasts, images, videos, mind-maps) to the same private 'book-media' bucket so they're
// available on every device. Path {user_id}/genfile/{encoded fileCache key}; RLS (sql/026)
// already scopes it to the caller's own folder. Bounded by a per-user quota (1 GB for now).
export const STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GB
const GENFILE_PREFIX = 'genfile';
function genFilePath(userId: string, key: string): string {
  return `${userId}/${GENFILE_PREFIX}/${encodeURIComponent(key)}`;
}

// Which of the user's generated files are already in the cloud + how many bytes they occupy
// (drives the per-file synced state and the "X MB of 1 GB" quota meter).
export async function listSyncedGenFiles(): Promise<{ keys: Set<string>; bytes: number }> {
  const empty = { keys: new Set<string>(), bytes: 0 };
  const client = getSupabase();
  if (!client) return empty;
  try {
    const user = await getUser();
    if (!user) return empty;
    const { data, error } = await client.storage.from(MEDIA_BUCKET)
      .list(`${user.id}/${GENFILE_PREFIX}`, { limit: 2000 });
    if (error || !data) return empty;
    const keys = new Set<string>();
    let bytes = 0;
    for (const obj of data) {
      if (!obj.name) continue;
      try { keys.add(decodeURIComponent(obj.name)); } catch { keys.add(obj.name); }
      bytes += (obj.metadata as any)?.size || 0;
    }
    return { keys, bytes };
  } catch { return empty; }
}

// A synced file's metadata, written to the index (user_synced_files) on sync so CLOUD mode can
// render a rich row on ANY device — even one that never held the blob.
// `timestamp` is the file's own GENERATION time (from the local cache record), stored so CLOUD mode +
// any auto-pulled copy show the SAME "when it was made" time the origin device shows — not the moment
// it happened to be uploaded. It's written into the synced_at column (which thus means "the file's
// timestamp", not the sync instant).
export interface SyncedFileMeta { filename?: string; fileType?: string; size?: number; bookId?: string; bookTitle?: string; timestamp?: number; }
export interface SyncedFileRow { file_key: string; filename: string; file_type: string; size: number; book_id: string; book_title: string; synced_at: number; }

export async function uploadGenFileToCloud(key: string, blob: Blob, meta?: SyncedFileMeta): Promise<boolean> {
  const client = getSupabase();
  if (!client || !key || !blob) return false;
  try {
    const user = await getUser();
    if (!user) return false;
    const { error } = await client.storage.from(MEDIA_BUCKET)
      .upload(genFilePath(user.id, key), blob, { upsert: true, contentType: blob.type || 'application/octet-stream' });
    if (error) return false;
    // Index the file so CLOUD mode can list it with real metadata (best-effort — the blob is the
    // source of truth; a missing index row just hides it from CLOUD mode until re-synced).
    if (meta) {
      await client.from('user_synced_files').upsert({
        user_id: user.id, file_key: key,
        filename: meta.filename ?? key, file_type: meta.fileType ?? '', size: meta.size ?? blob.size,
        book_id: meta.bookId ?? '', book_title: meta.bookTitle ?? '', synced_at: meta.timestamp ?? Date.now(),
      }, { onConflict: 'user_id,file_key' }).then(() => {}, () => {});
    }
    return true;
  } catch { return false; }
}

export async function removeGenFileFromCloud(key: string): Promise<boolean> {
  const client = getSupabase();
  if (!client || !key) return false;
  try {
    const user = await getUser();
    if (!user) return false;
    const { error } = await client.storage.from(MEDIA_BUCKET).remove([genFilePath(user.id, key)]);
    // Drop the index row too (so it leaves CLOUD mode). Best-effort.
    await client.from('user_synced_files').delete().eq('user_id', user.id).eq('file_key', key).then(() => {}, () => {});
    return !error;
  } catch { return false; }
}

// Pull one synced generated file's blob from the cloud (CLOUD-mode download / save).
export async function fetchGenFileFromCloud(key: string): Promise<Blob | null> {
  const client = getSupabase();
  if (!client || !key) return null;
  try {
    const user = await getUser();
    if (!user) return null;
    const { data, error } = await client.storage.from(MEDIA_BUCKET).download(genFilePath(user.id, key));
    if (error || !data) return null;
    return data;
  } catch { return null; }
}

// The cloud file INDEX (rich rows for CLOUD mode) + total synced bytes (the cloud meter).
export async function listSyncedFileIndex(): Promise<{ rows: SyncedFileRow[]; bytes: number }> {
  const empty = { rows: [] as SyncedFileRow[], bytes: 0 };
  const client = getSupabase();
  if (!client) return empty;
  try {
    const user = await getUser();
    if (!user) return empty;
    const { data, error } = await client.from('user_synced_files').select('*').eq('user_id', user.id);
    if (error || !data) return empty;
    const rows = data as SyncedFileRow[];
    return { rows, bytes: rows.reduce((s, r) => s + (r.size || 0), 0) };
  } catch { return empty; }
}

// Sidecar = a small JSON companion stored beside a synced file for client-side data that isn't in
// the blob (read-aloud sentence TIMINGS, podcast episode TITLE). Separate 'sidecar' prefix so it
// never shows in the genfile list / reconcile. Travels with the file: uploaded on sync, restored on
// auto-pull, so sentence-highlighting + the podcast title work cross-device.
const SIDECAR_PREFIX = 'sidecar';
function sidecarPath(userId: string, key: string): string { return `${userId}/${SIDECAR_PREFIX}/${encodeURIComponent(key)}`; }

export async function uploadSidecar(key: string, data: any): Promise<boolean> {
  const client = getSupabase();
  if (!client || !key) return false;
  try {
    const user = await getUser();
    if (!user) return false;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const { error } = await client.storage.from(MEDIA_BUCKET).upload(sidecarPath(user.id, key), blob, { upsert: true, contentType: 'application/json' });
    return !error;
  } catch { return false; }
}

export async function fetchSidecar(key: string): Promise<any | null> {
  const client = getSupabase();
  if (!client || !key) return null;
  try {
    const user = await getUser();
    if (!user) return null;
    const { data, error } = await client.storage.from(MEDIA_BUCKET).download(sidecarPath(user.id, key));
    if (error || !data) return null;
    return JSON.parse(await data.text());
  } catch { return null; }
}

// One synced file's index row (its real filename / type / book) — so a reader auto-pull can cache
// the blob under its PROPER metadata instead of a name synthesised from the cache key.
export async function getSyncedFileMeta(key: string): Promise<SyncedFileRow | null> {
  const client = getSupabase();
  if (!client || !key) return null;
  try {
    const user = await getUser();
    if (!user) return null;
    const { data, error } = await client.from('user_synced_files').select('*').eq('user_id', user.id).eq('file_key', key).maybeSingle();
    if (error || !data) return null;
    return data as SyncedFileRow;
  } catch { return null; }
}

// Reconcile the cloud so the index (user_synced_files) matches the actual Storage bucket. Two writes
// (blob + index) aren't transactional, so they drift: blobs synced before the index existed have no
// row (invisible orphans eating space); a failed blob upload leaves a row pointing at nothing. This
// non-destructive pass BACKFILLS index rows for orphan blobs (so they show in Cloud mode and can be
// deleted from the UI) and DROPS index rows whose blob is gone. Only touches the genfile prefix;
// figures live at a different path and are skipped. Returns counts for a summary.
export async function reconcileCloudFiles(): Promise<{ backfilled: number; removed: number }> {
  const client = getSupabase();
  if (!client) return { backfilled: 0, removed: 0 };
  try {
    const user = await getUser();
    if (!user) return { backfilled: 0, removed: 0 };
    const { data: objs, error: e1 } = await client.storage.from(MEDIA_BUCKET).list(`${user.id}/${GENFILE_PREFIX}`, { limit: 2000 });
    if (e1) return { backfilled: 0, removed: 0 };
    const bucket = new Map<string, number>(); // decoded key -> size
    for (const o of objs || []) {
      if (!o.name) continue;
      let k: string; try { k = decodeURIComponent(o.name); } catch { k = o.name; }
      bucket.set(k, (o.metadata as any)?.size || 0);
    }
    const { data: rows, error: e2 } = await client.from('user_synced_files').select('file_key,file_type').eq('user_id', user.id);
    if (e2) return { backfilled: 0, removed: 0 };
    const indexed = new Set<string>();          // genfile index keys (figures excluded — different path)
    for (const r of rows || []) if ((r as any).file_type !== 'figure-image') indexed.add((r as any).file_key);

    // Orphan blobs (in bucket, no row) → backfill a row with metadata derived from the key.
    const toInsert: any[] = [];
    for (const [key, size] of bucket) {
      if (indexed.has(key)) continue;
      const parts = key.split(':');
      toInsert.push({ user_id: user.id, file_key: key, filename: parts.slice(2).join('-') || 'file', file_type: parts[2] || 'translation', size, book_id: parts[0] || '', book_title: '', synced_at: Date.now() });
    }
    if (toInsert.length) await client.from('user_synced_files').upsert(toInsert, { onConflict: 'user_id,file_key' });
    // Dead rows (genfile index key, no blob) → delete.
    const dead = [...indexed].filter(k => !bucket.has(k));
    if (dead.length) await client.from('user_synced_files').delete().eq('user_id', user.id).in('file_key', dead);
    return { backfilled: toInsert.length, removed: dead.length };
  } catch { return { backfilled: 0, removed: 0 }; }
}

export interface CreditHistoryEntry {
  delta: number;      // negative = consumed, positive = added
  type: string;       // 'consume' | 'earn' | 'purchase' | 'bonus' | 'renewal' | 'partial-marker'
  reason: string;     // action name or description
  book?: string;      // source book title (consumption only)
  created_at: string;
  session?: string;   // per-execution id ("<Label>#<uuid>") — groups one generation's rows into one line
  model?: string;     // served model (consumption only) — used to show Balanced/Premium mode
}

// Unified credit history: consumption from usage_logs + additions from credit_ledger.
// Degrades gracefully if credit_ledger doesn't exist yet (returns just consumption).
export async function fetchCreditHistory(userId: string, limit = 50): Promise<CreditHistoryEntry[]> {
  const client = getSupabase();
  if (!client) return [];
  const fetchUsage = async () => {
    let res = await client.from('usage_logs').select('action, credits_cost, created_at, book_title, model, session_id')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
    // session_id column may not exist yet (migration 021 not run) → retry without it.
    if (res.error) res = await client.from('usage_logs').select('action, credits_cost, created_at, book_title, model')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
    return res;
  };
  const [usage, ledger] = await Promise.all([
    fetchUsage(),
    client.from('credit_ledger').select('delta, type, reason, created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit),
  ]);
  const usageRows = (usage.data || []) as any[];
  const consume: CreditHistoryEntry[] = usageRows
    .filter(r => (r.credits_cost || 0) !== 0)
    .map(r => ({ delta: -(r.credits_cost || 0), type: 'consume', reason: r.action, book: r.book_title || undefined, created_at: r.created_at, session: r.session_id || undefined, model: r.model || undefined }));
  // Zero-credit "generation stopped part-way" markers → let the UI tag the delivered work "(Partial)".
  const markers: CreditHistoryEntry[] = usageRows
    .filter(r => (r.credits_cost || 0) === 0 && r.model === '__partial__')
    .map(r => ({ delta: 0, type: 'partial-marker', reason: r.action, book: r.book_title || undefined, created_at: r.created_at, session: r.session_id || undefined }));
  const adds: CreditHistoryEntry[] = (ledger.data || [])
    .map((r: any) => ({ delta: r.delta || 0, type: r.type, reason: r.reason || r.type, created_at: r.created_at }));
  return [...consume, ...markers, ...adds]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit);
}
