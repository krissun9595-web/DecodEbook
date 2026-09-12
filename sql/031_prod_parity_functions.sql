-- 031: PROD PARITY (Tier 2 — credit/referral FUNCTIONS). Run AFTER 030.
--
-- Brings prod's billing functions to staging's current versions. Prod was on an older baseline:
--   * missing entirely: tier_monthly_credits, credit_period_start, deplete_wallet_on_usage (+trigger),
--     trg_referral_engagement (+trigger);
--   * present but STALE bodies: add_bonus_credits (no ledger row), add_pack_credits (no purchased/ledger),
--     get_user_credits (no monthly cap, missing pack_purchased/bonus fields the app reads).
-- Definitions are copied verbatim from sql/015 (add_bonus_credits), sql/018 (add_pack_credits,
-- credit_period_start, deplete_wallet_on_usage, get_user_credits) and sql/019 (tier_monthly_credits FINAL,
-- trg_referral_engagement). award_referral_on_engagement is intentionally LEFT ALONE — prod already has
-- the newer sql/024 (email-normalization) version. All CREATE OR REPLACE / DROP TRIGGER IF EXISTS →
-- idempotent. Helpers are defined before the trigger fn that calls them.

-- add_bonus_credits (015): also writes a credit_ledger 'bonus' row.
create or replace function public.add_bonus_credits(p_user_id uuid, p_credits int)
returns void language plpgsql security definer as $$
begin
  insert into public.bonus_credits (user_id, balance, updated_at)
  values (p_user_id, p_credits, now())
  on conflict (user_id) do update set balance = bonus_credits.balance + p_credits, updated_at = now();
  insert into public.credit_ledger (user_id, delta, type, reason)
  values (p_user_id, p_credits, 'bonus', 'Referral / bonus credits');
end; $$;

-- add_pack_credits (018): bump remaining balance + cumulative purchased + ledger 'purchase' row.
create or replace function add_pack_credits(p_user_id uuid, p_credits int)
returns void language plpgsql security definer as $$
begin
  update subscriptions
     set pack_credits_balance   = coalesce(pack_credits_balance, 0)   + p_credits,
         pack_credits_purchased = coalesce(pack_credits_purchased, 0) + p_credits,
         updated_at = now()
   where user_id = p_user_id and status in ('active', 'trialing');
  insert into public.credit_ledger (user_id, delta, type, reason)
  values (p_user_id, p_credits, 'purchase', 'Credit pack');
end; $$;

-- tier_monthly_credits (019 FINAL): pro = 1000, every other/legacy tier = 100 (metered, none unlimited).
create or replace function tier_monthly_credits(p_tier text)
returns int language sql immutable as $$
  select case p_tier when 'pro' then 1000 else 100 end;
$$;

-- credit_period_start (018): free = usage since signup (first_seen_at); paid = current billing period.
create or replace function credit_period_start(p_user_id uuid, p_tier text, p_sub_start timestamptz)
returns timestamptz language plpgsql security definer as $$
declare v timestamptz;
begin
  if p_tier = 'free' then
    select first_seen_at into v from profiles where id = p_user_id;
    return coalesce(v, '1970-01-01'::timestamptz);
  end if;
  return coalesce(p_sub_start, date_trunc('month', now()));
end; $$;

-- deplete_wallet_on_usage (018): AFTER-INSERT trigger draws each charge's over-monthly overflow from
-- bonus first, then packs (waterfall: monthly allowance → bonus → packs).
create or replace function deplete_wallet_on_usage()
returns trigger language plpgsql security definer as $$
declare
  v_tier         text := 'free';
  v_sub_start    timestamptz;
  v_monthly      int;
  v_period_start timestamptz;
  v_prior_used   int;
  v_from_monthly int;
  v_overflow     int;
  v_pack         int := 0;
  v_bonus        int := 0;
  v_take         int;
begin
  if coalesce(NEW.credits_cost, 0) <= 0 then return NEW; end if;

  select tier, current_period_start, coalesce(pack_credits_balance, 0)
    into v_tier, v_sub_start, v_pack
    from subscriptions
   where user_id = NEW.user_id and status in ('active', 'trialing')
   order by created_at desc
   limit 1;
  if v_tier is null then v_tier := 'free'; end if;

  v_monthly := tier_monthly_credits(v_tier);
  if v_monthly is null then return NEW; end if;

  v_period_start := credit_period_start(NEW.user_id, v_tier, v_sub_start);

  select coalesce(sum(credits_cost), 0) - NEW.credits_cost
    into v_prior_used
    from usage_logs
   where user_id = NEW.user_id and created_at >= v_period_start;
  if v_prior_used < 0 then v_prior_used := 0; end if;

  v_from_monthly := least(NEW.credits_cost, greatest(0, v_monthly - v_prior_used));
  v_overflow := NEW.credits_cost - v_from_monthly;
  if v_overflow <= 0 then return NEW; end if;

  select coalesce(balance, 0) into v_bonus from bonus_credits where user_id = NEW.user_id;
  if v_bonus > 0 then
    v_take := least(v_overflow, v_bonus);
    update bonus_credits set balance = balance - v_take, updated_at = now() where user_id = NEW.user_id;
    v_overflow := v_overflow - v_take;
  end if;

  if v_overflow > 0 and v_pack > 0 then
    v_take := least(v_overflow, v_pack);
    update subscriptions
       set pack_credits_balance = coalesce(pack_credits_balance, 0) - v_take, updated_at = now()
     where user_id = NEW.user_id and status in ('active', 'trialing');
    v_overflow := v_overflow - v_take;
  end if;

  return NEW;
end; $$;

drop trigger if exists trg_deplete_wallet on usage_logs;
create trigger trg_deplete_wallet
  after insert on usage_logs
  for each row execute function deplete_wallet_on_usage();

-- trg_referral_engagement (019): fire the referral check on each charge; swallow errors so referral
-- logic can never break usage logging. Calls the EXISTING (024) award_referral_on_engagement.
create or replace function trg_referral_engagement()
returns trigger language plpgsql security definer as $$
begin
  begin
    perform award_referral_on_engagement(NEW.user_id);
  exception when others then
    null;
  end;
  return NEW;
end; $$;

drop trigger if exists trg_referral_engagement on usage_logs;
create trigger trg_referral_engagement
  after insert on usage_logs
  for each row execute function trg_referral_engagement();

-- get_user_credits (018): cap monthly usage at the allowance (overflow lives in the wallets) and expose
-- pack_purchased + bonus_credits, which the app reads.
create or replace function get_user_credits(p_user_id uuid)
returns json language plpgsql security definer as $$
declare
  v_tier         text := 'free';
  v_period_start timestamptz;
  v_period_end   timestamptz;
  v_cancel       boolean := false;
  v_pack_balance int := 0;
  v_pack_bought  int := 0;
  v_bonus        int := 0;
  v_credits_used int;
  v_monthly      int;
begin
  select tier, current_period_start, current_period_end, cancel_at_period_end,
         coalesce(pack_credits_balance, 0), coalesce(pack_credits_purchased, 0)
    into v_tier, v_period_start, v_period_end, v_cancel, v_pack_balance, v_pack_bought
    from public.subscriptions
   where user_id = p_user_id and status in ('active', 'trialing')
   order by created_at desc
   limit 1;

  if v_tier is null then v_tier := 'free'; end if;

  if v_tier = 'free' then
    select first_seen_at into v_period_start from public.profiles where id = p_user_id;
    v_period_start := coalesce(v_period_start, '1970-01-01'::timestamptz);
    v_period_end := null;
  elsif v_period_start is null then
    v_period_start := date_trunc('month', now());
  end if;

  select coalesce(balance, 0) into v_bonus from public.bonus_credits where user_id = p_user_id;

  select coalesce(sum(credits_cost), 0) into v_credits_used
    from public.usage_logs
   where user_id = p_user_id and created_at >= v_period_start;

  v_monthly := tier_monthly_credits(v_tier);
  if v_monthly is not null and v_credits_used > v_monthly then
    v_credits_used := v_monthly;
  end if;

  return json_build_object(
    'tier', v_tier,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'cancel_at_period_end', v_cancel,
    'credits_used', v_credits_used,
    'pack_credits', v_pack_balance,
    'pack_purchased', v_pack_bought,
    'bonus_credits', coalesce(v_bonus, 0)
  );
end; $$;

-- Re-apply sql/023 hardening. The new functions didn't exist when 023 first ran on prod (so they were
-- skipped), and CREATE OR REPLACE above dropped the search_path pin on get_user_credits / add_pack_credits.
-- (1) lock the callable money RPCs to service_role; (2) pin search_path on every SECURITY DEFINER money fn.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'add_bonus_credits','add_pack_credits','award_referral_on_engagement',
      'get_user_credits','get_user_tier_and_usage','get_or_create_referral_code','get_referral_stats')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.proname in (
      'add_bonus_credits','add_pack_credits','award_referral_on_engagement',
      'get_user_credits','get_user_tier_and_usage','get_or_create_referral_code','get_referral_stats',
      'trg_referral_engagement','deplete_wallet_on_usage','credit_period_start')
  loop
    execute format('alter function %s set search_path = public, pg_temp', r.sig);
  end loop;
end $$;
