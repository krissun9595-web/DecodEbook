-- ============================================================================
-- 014: add usage_logs.model — record which model served each call, so per-model
-- cost/credit margin can be audited empirically (the cost-derived credit model).
-- Additive + idempotent. Run on the staging project first, then prod.
-- ============================================================================

alter table public.usage_logs add column if not exists model text;

-- (optional) index for per-model rollups if the table grows large:
-- create index if not exists idx_usage_logs_model on public.usage_logs(model);
