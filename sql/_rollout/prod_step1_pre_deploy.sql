-- ============================================================
-- PROD ROLLOUT · STEP 1 (run in prod Supabase SQL editor BEFORE deploying the worker)
-- Additive only: idempotent, zero impact on the currently-running prod code.
-- ============================================================

-- ---------- sql/022_usage_idempotency.sql ----------
-- 022: idempotency key for usage_logs.
--
-- Purpose: let a usage row be safely RE-SENT without double-charging. The client now
-- persists each computed charge to a durable local queue the instant it's computed and
-- flushes it (on next load, after a transient failure, etc.), so a closed tab or a dropped
-- network request can no longer make us silently eat the cost. Re-sending the same row must
-- be a no-op — this unique key makes it one.
--
-- credits_used = SUM(usage_logs.credits_cost) and the AFTER INSERT triggers (018 pack
-- overflow, 019 referral reward) all key off a real INSERT, so ON CONFLICT DO NOTHING on
-- usage_id guarantees each charge is counted and each trigger fires EXACTLY once.
--
-- Plain (non-partial) unique index: Postgres treats NULLs as DISTINCT, so every legacy row
-- (usage_id NULL) stays valid and only real uuids dedupe. Non-partial so PostgREST can infer it
-- for the client's `upsert(..., { onConflict: 'usage_id', ignoreDuplicates: true })`.
alter table public.usage_logs add column if not exists usage_id uuid;

create unique index if not exists usage_logs_usage_id_key
  on public.usage_logs (usage_id);


-- ---------- sql/026_book_media_storage.sql ----------
-- Cross-device figure sync: a private Supabase Storage bucket for per-user book media.
--
-- WHY: extracted figure images live only in each device's local IndexedDB file cache; a book's
-- TEXT syncs via user_books but its binary figures never do, so the same book on a second device
-- shows empty figure boxes. services/supabase.ts now mirrors figure blobs here (upload on a local
-- cache hit, download on a miss) under the path {user_id}/{bookId}/figure-image/{figId}.
--
-- SECURITY: the bucket is PRIVATE and RLS on storage.objects scopes every object to the caller's
-- own top-level {user_id}/ folder, so a user can only read/write their own media. Mirrors the
-- per-user isolation already enforced on usage_logs / user_books.

-- 1) Private bucket (id == name). Idempotent.
insert into storage.buckets (id, name, public)
values ('book-media', 'book-media', false)
on conflict (id) do nothing;

-- 2) Per-user object policies. storage.foldername(name) splits the object path into segments;
--    segment [1] is the first folder, which we require to equal the caller's uid. upsert (used by
--    the client) needs BOTH insert and update.
drop policy if exists "Users read own book media"   on storage.objects;
drop policy if exists "Users insert own book media" on storage.objects;
drop policy if exists "Users update own book media" on storage.objects;
drop policy if exists "Users delete own book media" on storage.objects;

create policy "Users read own book media" on storage.objects
  for select
  using (bucket_id = 'book-media' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users insert own book media" on storage.objects
  for insert
  with check (bucket_id = 'book-media' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users update own book media" on storage.objects
  for update
  using (bucket_id = 'book-media' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'book-media' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users delete own book media" on storage.objects
  for delete
  using (bucket_id = 'book-media' and (storage.foldername(name))[1] = auth.uid()::text);

-- ------------------------------------------------------------------------------------
-- VERIFY (as an authenticated end-user, e.g. from the app's supabase client):
--   * client.storage.from('book-media').upload('<your-uid>/book1/figure-image/f1', blob)   -> ok
--   * client.storage.from('book-media').download('<your-uid>/book1/figure-image/f1')        -> ok
--   * download/upload under a DIFFERENT uid's folder                                         -> denied
-- ------------------------------------------------------------------------------------


-- ---------- sql/027_user_books_pdf_figures.sql ----------
-- Sync the PDF figure MANIFEST across devices.
--
-- WHY: figure image bytes now sync (Storage, sql/026), but the manifest — each figure's pixel
-- dimensions (aspect) and column-width fraction — did not. So a figure pulled on a second device
-- had no size info and the reader fell back to a 4/3 box at full column width, rendering it
-- letterboxed and wider than the source. This column carries that lightweight metadata (NO image
-- bytes) so a synced figure matches the original exactly. See services/librarySync.ts.

alter table public.user_books add column if not exists pdf_figures jsonb;


-- ---------- sql/028_user_synced_files.sql ----------
-- Cloud file index for the GEN_FILES panel's CLOUD mode.
--
-- WHY: synced blobs live in Storage keyed only by their cache-key, so a device that never held a
-- file can't render a rich row for it (no filename / type / size / book). This lightweight table is
-- the queryable index: one row per synced generated file, written on sync and removed on
-- unsync/cloud-delete. It holds METADATA only — the bytes stay in the 'book-media' bucket (sql/026).
--
-- Not a billing path, so (unlike usage_logs) the client may manage its own rows directly; RLS scopes
-- every row to its owner.

create table if not exists public.user_synced_files (
  user_id     uuid   not null references auth.users(id) on delete cascade,
  file_key    text   not null,           -- the fileCache cache-key (also the Storage object name)
  filename    text,
  file_type   text,
  size        bigint default 0,
  book_id     text,
  book_title  text,
  synced_at   bigint,
  primary key (user_id, file_key)
);

alter table public.user_synced_files enable row level security;
drop policy if exists "Users manage own synced files" on public.user_synced_files;
create policy "Users manage own synced files" on public.user_synced_files
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


