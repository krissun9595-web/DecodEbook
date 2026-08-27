-- ============================================================================
-- 012: Database consolidation cleanup  (Phase 1 of the DB establishment review)
-- ============================================================================
-- Verified against the live schema dump (2026-08-26):
--   * public.books has 0 rows and is never written by the app (it uses user_books).
--   * Only v_user_funnel referenced books (books.uploaded_at) — and since books is
--     empty, that metric was always NULL.
--   * handle_new_user() inserts only (id,email,display_name,avatar_url), so the
--     three profiles columns dropped below are never written or read anywhere.
--
-- Transactional + idempotent: safe to re-run, rolls back cleanly on any error.
-- Run in the Supabase SQL editor (ideally on a branch first, then prod).
-- ============================================================================

begin;

-- 1. Re-point v_user_funnel off the (empty) books table onto user_books, the real
--    per-user upload record. MUST run before dropping books. This revives a metric
--    that was permanently NULL (books never populated).
drop view if exists public.v_user_funnel;
create view public.v_user_funnel as
  select
    p.id                                       as user_id,
    p.first_seen_at                            as signed_up_at,
    ( select min(to_timestamp(ub.upload_date / 1000.0))
        from public.user_books ub
       where ub.user_id = p.id )               as first_upload_at,
    ( select min(g.created_at)
        from public.generations g
       where g.user_id = p.id and g.status = 'success' ) as first_generation_at,
    ( select min(e.created_at)
        from public.events e
       where e.user_id = p.id and e.event_type = 'share' ) as first_share_at
  from public.profiles p;

-- 2. Drop the empty, app-unused analytics stub. Its triggers (on_book_uploaded,
--    on_book_deleted), RLS policies, and idx_books_user all drop with the table.
drop table if exists public.books;

-- 3. Drop the now-orphaned trigger functions (only books used them). NOTE: this
--    freezes profiles.total_books_uploaded at its current value (already 0 for all
--    users, since books was never populated). The column is kept because
--    v_user_engagement reads it; re-wiring upload counts to user_books is a
--    separate, optional follow-up.
drop function if exists public.increment_book_count();
drop function if exists public.decrement_book_count();

-- 4. Drop three profiles columns that are defined but never written or read.
alter table public.profiles
  drop column if exists locale,
  drop column if exists timezone,
  drop column if exists device_fingerprint;

commit;
