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
