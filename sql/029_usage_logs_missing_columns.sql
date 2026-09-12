-- 029: HOTFIX — restore usage_logs columns that PROD was missing.
--
-- Prod's usage_logs never received migrations 014 (model), 016 (book_title), 021 (session_id) — the
-- prod-rollout batch started at 022 and wrongly assumed those were already applied. The metering
-- writers ALWAYS send `model` (worker/index.ts:620; services/gemini.ts logUsage), so on prod every
-- insert was rejected with `column "model" does not exist`. The worker swallows that in a catch{} and
-- the client (post-025) is locked out of credit rows — so charges vanished silently and generations
-- ran unmetered.
--
-- These three columns are exactly what 014/016/021 add (all nullable text, no backfill). Idempotent.

alter table public.usage_logs add column if not exists model      text;
alter table public.usage_logs add column if not exists book_title text;
alter table public.usage_logs add column if not exists session_id text;

-- Optional (matches 014's commented index) — helps the credit-history model grouping. Safe to skip.
-- create index if not exists idx_usage_logs_model on public.usage_logs(model);
