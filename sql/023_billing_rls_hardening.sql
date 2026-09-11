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
