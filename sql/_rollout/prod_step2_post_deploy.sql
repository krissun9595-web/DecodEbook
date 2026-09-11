-- ============================================================
-- PROD ROLLOUT · STEP 2 (run in prod Supabase SQL editor AFTER the new worker is deployed)
-- 025 locks clients out of writing credit-bearing rows — the new worker MUST be live first.
-- ============================================================

-- ---------- sql/023_billing_rls_hardening.sql ----------
-- 023: billing & RLS hardening (security audit step 1) — zero app-behavior change.
--
-- The client never calls any RPC directly (all rpc/ calls go through the Worker with the
-- service-role key), so locking these functions to service_role, and tightening two policies +
-- one column constraint, closes the worst tamper vectors without touching the app:
--
--   * add_bonus_credits / add_pack_credits          — were callable by ANY authenticated user
--     with an arbitrary (p_user_id, p_credits) → mint unlimited credits. (CRITICAL)
--   * award_referral_on_engagement                  — forge referral payouts. (CRITICAL)
--   * get_user_credits / get_user_tier_and_usage /  — IDOR: read ANY user's balance/tier/
--     get_referral_stats / get_or_create_referral_code   referral data by uuid. (HIGH)
--   * usage_logs.credits_cost had no CHECK          — insert a NEGATIVE cost → manufacture
--                                                     balance (SUM goes negative). (CRITICAL)
--   * user_settings "FOR ALL" had USING but no      — INSERT a row under another user's id and
--     WITH CHECK                                       plant/clobber their BYOK api key. (HIGH)
--   * profiles UPDATE had no WITH CHECK. (MEDIUM)
--   * money/referral SECURITY DEFINER funcs had no  — search_path-hijack privilege escalation.
--     pinned search_path. (MEDIUM)
--
-- All idempotent; safe to re-run.

-- 1) Lock the credit/referral RPCs to service_role only (the Worker). The engagement trigger
--    (trg_referral_engagement) is SECURITY DEFINER and calls award_referral_on_engagement as its
--    OWNER, so revoking it from end users does NOT break the reward path. regprocedure resolves
--    each function's exact signature (and any overloads) so we don't hand-encode arg types.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'add_bonus_credits', 'add_pack_credits', 'award_referral_on_engagement',
        'get_user_credits', 'get_user_tier_and_usage',
        'get_or_create_referral_code', 'get_referral_stats'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- 2) A usage charge can never be negative. Kills the "insert credits_cost:-100000 → invented
--    balance" trick. (Skipping/zeroing a charge still needs the server-metering rework — step 3.)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'usage_logs_credits_cost_nonneg') then
    alter table public.usage_logs
      add constraint usage_logs_credits_cost_nonneg check (credits_cost >= 0);
  end if;
end $$;

-- 3) user_settings: a FOR ALL policy with USING but no WITH CHECK lets a user INSERT a row with
--    ANOTHER user's user_id (this table stores gemini_key / openrouter_key). Add WITH CHECK so the
--    NEW row must belong to the caller — mirrors the correct user_books policy.
drop policy if exists "Users manage own settings" on public.user_settings;
create policy "Users manage own settings" on public.user_settings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 4) profiles UPDATE: add WITH CHECK so an update can't move a row to another id.
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- 5) Pin search_path on every SECURITY DEFINER money/referral function (incl. the trigger fns),
--    so a shadowing object on the caller's search_path can't hijack execution as the owner.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef                                   -- SECURITY DEFINER only
      and p.proname in (
        'add_bonus_credits', 'add_pack_credits', 'award_referral_on_engagement',
        'get_user_credits', 'get_user_tier_and_usage',
        'get_or_create_referral_code', 'get_referral_stats',
        'trg_referral_engagement', 'deplete_wallet_on_usage', 'credit_period_start'
      )
  loop
    execute format('alter function %s set search_path = public, pg_temp', r.sig);
  end loop;
end $$;


-- ---------- sql/024_referral_email_hardening.sql ----------
-- ============================================================================
-- 024: referral hardening — treat one PERSON as one referred user, by normalized email.
--
-- Context: bound OAuth identities already share one user_id (so they can't multiply a reward),
-- and unverified accounts are already blocked (sql/019 requires email_confirmed_at). The gap is
-- SEPARATE verified accounts controlled by one person — cheapest via email aliases that hit the
-- same inbox (Gmail ignores dots and +tags; googlemail.com == gmail.com). Those read as distinct
-- users today. This migration:
--   (a) normalizes emails to a canonical inbox, and
--   (b) refuses the 100-credit reward when the referred user's canonical email matches the
--       REFERRER's (self-referral via a second account) or an ALREADY-credited referral of the
--       same referrer (same person, second account).
-- Everything else in award_referral_on_engagement (019) is preserved verbatim.
--
-- Run on STAGING first, verify, then prod. Idempotent.
-- ============================================================================

-- Canonical inbox for an email: lowercase, drop +tag; for gmail/googlemail also drop dots and
-- fold to gmail.com. (Conservative — only the well-known Gmail rules; other providers keep dots.)
CREATE OR REPLACE FUNCTION normalize_email(e text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN e IS NULL OR position('@' in e) = 0 THEN NULL
    ELSE (
      WITH p AS (
        SELECT split_part(lower(trim(e)), '@', 1) AS loc,
               split_part(lower(trim(e)), '@', 2) AS dom
      )
      SELECT CASE
        WHEN dom IN ('gmail.com', 'googlemail.com')
          THEN regexp_replace(split_part(loc, '+', 1), '\.', '', 'g') || '@gmail.com'
        ELSE split_part(loc, '+', 1) || '@' || dom
      END
      FROM p
    )
  END;
$$;

REVOKE EXECUTE ON FUNCTION normalize_email(text) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION award_referral_on_engagement(p_referred uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id            bigint;
  v_referrer      uuid;
  v_ip_hash       text;
  v_email_ok      timestamptz;
  v_used          int;
  v_credited      int;
  v_referred_norm text;
  v_referrer_norm text;
  threshold constant int := 20;   -- free credits the referred user must spend to qualify (tunable)
BEGIN
  -- Pending (not-yet-processed) referral for this user?
  SELECT id, referrer_id, referred_ip_hash
    INTO v_id, v_referrer, v_ip_hash
    FROM referral_signups
   WHERE referred_user_id = p_referred AND activated = false
   LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  -- (1) email verified
  SELECT email_confirmed_at INTO v_email_ok FROM auth.users WHERE id = p_referred;
  IF v_email_ok IS NULL THEN RETURN; END IF;   -- not yet verified; try again on later usage

  -- (2) genuine free-credit usage
  SELECT COALESCE(SUM(credits_cost), 0) INTO v_used FROM usage_logs WHERE user_id = p_referred;
  IF v_used < threshold THEN RETURN; END IF;    -- not engaged enough yet; try again later

  -- (NEW) one PERSON per canonical inbox: block self-referral-by-email and a second account whose
  -- normalized email matches an already-credited referral of the same referrer.
  SELECT normalize_email(email) INTO v_referred_norm FROM auth.users WHERE id = p_referred;
  SELECT normalize_email(email) INTO v_referrer_norm FROM auth.users WHERE id = v_referrer;
  IF v_referred_norm IS NOT NULL AND (
        v_referred_norm = v_referrer_norm
     OR EXISTS (
          SELECT 1 FROM referral_signups s2
            JOIN auth.users u2 ON u2.id = s2.referred_user_id
           WHERE s2.referrer_id = v_referrer
             AND s2.referred_user_id <> p_referred
             AND s2.referrer_credited = true
             AND normalize_email(u2.email) = v_referred_norm
        )
  ) THEN
    UPDATE referral_signups SET activated = true, referrer_credited = false WHERE id = v_id;
    RETURN;
  END IF;

  -- (6) same-IP self-farm guard: another already-credited referral by this referrer shares this IP
  IF v_ip_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM referral_signups s2
     WHERE s2.referrer_id = v_referrer
       AND s2.referred_user_id <> p_referred
       AND s2.referred_ip_hash = v_ip_hash
       AND s2.referrer_credited = true
  ) THEN
    UPDATE referral_signups SET activated = true, referrer_credited = false WHERE id = v_id;
    RETURN;
  END IF;

  -- (4) per-referrer cap: 1,000 credits = 10 x 100
  SELECT count(*) INTO v_credited FROM referral_signups
   WHERE referrer_id = v_referrer AND referrer_credited = true;

  -- Mark processed once; credit only under the cap.
  UPDATE referral_signups
     SET activated = true, referrer_credited = (v_credited < 10)
   WHERE id = v_id;

  IF v_credited < 10 THEN
    PERFORM add_bonus_credits(v_referrer, 100);   -- also writes a credit_ledger 'bonus' row (015)
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION award_referral_on_engagement(uuid) FROM public, anon, authenticated;


-- ---------- sql/025_usage_logs_service_role_insert.sql ----------
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


