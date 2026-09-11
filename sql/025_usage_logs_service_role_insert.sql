-- Phase B of server-authoritative metering: make the WORKER the sole writer of
-- credit-bearing usage_logs rows, closing H2 (a malicious client skipping or forging
-- its own charges). See docs/METERING_DESIGN.md.
--
-- BACKGROUND
--   Phase A had the worker DUAL-WRITE every charged path (idempotent on usage_id),
--   deduping against the client's write. Now that every path is worker-covered and
--   soak-verified, we revoke the client's ability to insert REAL (credit-bearing) rows.
--   service_role (the worker) BYPASSES RLS, so its writes are unaffected by this policy.
--
-- DECISION 2 (locked): keep a NARROW client exception for 0-credit rows only, so the
--   client can still write its "generation stopped part-way" partial markers
--   (logGenerationPartial → credits_cost = 0, model = '__partial__'). Anything with
--   credits_cost > 0 must come from the worker.
--
-- COMPANION CODE (ships in the SAME deploy — do NOT apply this SQL against a build that
--   predates it): services/supabase.ts insertUsageRow now treats an RLS/permission
--   denial (Postgres 42501) on a credit-bearing client write as EXPECTED (the worker owns
--   it) and drops it from the durable retry queue, instead of looping forever.
--
-- ACCEPTED TRADE-OFFS
--   * Decision 4: if the worker's fire-and-forget write rarely fails, the charge is lost
--     (user-favoring) — the client can no longer back it up. Accepted.
--   * BYOK / direct-key users bypass the worker AND the credit gate; their self-funded
--     usage simply stops being logged. Benign (they were never gated) and arguably correct.

alter table public.usage_logs enable row level security;

-- Replace the permissive client INSERT (any own-id row) with a 0-credit-only exception.
-- Idempotent: drop BOTH the old permissive policy and this one (if a prior run created it).
drop policy if exists "Users insert own logs" on public.usage_logs;
drop policy if exists "Users insert own zero-credit logs" on public.usage_logs;
create policy "Users insert own zero-credit logs" on public.usage_logs
  for insert
  with check (auth.uid() = user_id and credits_cost = 0);

-- SELECT policy is unchanged (users still read their own history). The worker writes via
-- service_role, which bypasses RLS, so no INSERT policy is needed for it.

-- ------------------------------------------------------------------------------------
-- VERIFY (run as an authenticated end-user, e.g. from the app's supabase client):
--   -- should SUCCEED (0-credit partial marker):
--   insert into usage_logs (user_id, action, credits_cost, model) values (auth.uid(), 'chat', 0, '__partial__');
--   -- should FAIL with 42501 (new row violates row-level security policy):
--   insert into usage_logs (user_id, action, credits_cost, model) values (auth.uid(), 'chat', 5, 'gemini-3.1-pro-preview');
-- ------------------------------------------------------------------------------------
