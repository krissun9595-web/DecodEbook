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
