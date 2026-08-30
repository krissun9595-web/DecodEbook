-- 016: add usage_logs.book_title — source book for each usage row, shown in the
-- account Credit history "Source" column. Additive + idempotent. Staging first, then prod.

alter table public.usage_logs add column if not exists book_title text;
