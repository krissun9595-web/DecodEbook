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
