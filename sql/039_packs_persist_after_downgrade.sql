-- ============================================================================
-- 039: Purchased credit packs persist after downgrade ("never expire", as the
--      product promises). Previously get_user_credits and the depletion trigger
--      read pack balances ONLY from an active/trialing subscription row, so once
--      a user canceled, their paid pack credits became invisible AND unspendable
--      until they re-subscribed. With one row per user (sql/038) we can read the
--      pack from that row regardless of status, and derive the EFFECTIVE tier
--      (Pro only while live; otherwise Free) separately.
--
--      Net effect: a downgraded user keeps seeing + spending purchased packs.
--      Granted/subscription + free credits are unchanged (they still reset/forfeit).
-- Run on STAGING first, verify, then prod.
-- ============================================================================

-- get_user_credits: read the user's (single, post-038) row regardless of status; Pro only when it's
-- actually live; packs always kept.
create or replace function public.get_user_credits(p_user_id uuid)
returns json
language plpgsql
security definer
as $$
declare
  v_tier         text := 'free';
  v_row_tier     text;
  v_status       text;
  v_period_start timestamptz;
  v_period_end   timestamptz;
  v_cancel       boolean := false;
  v_pack_balance int := 0;
  v_pack_bought  int := 0;
  v_bonus        int := 0;
  v_credits_used int;
  v_monthly      int;
begin
  select tier, status, current_period_start, current_period_end, cancel_at_period_end,
         coalesce(pack_credits_balance, 0), coalesce(pack_credits_purchased, 0)
    into v_row_tier, v_status, v_period_start, v_period_end, v_cancel, v_pack_balance, v_pack_bought
    from public.subscriptions
   where user_id = p_user_id
   order by created_at desc
   limit 1;

  -- Effective tier: Pro ONLY while the subscription is live. Canceled/past_due/none ⇒ Free, but the
  -- purchased pack balance (v_pack_balance) is KEPT either way.
  if v_row_tier = 'pro' and v_status in ('active', 'trialing') then
    v_tier := 'pro';
  else
    v_tier := 'free';
  end if;

  if v_tier = 'free' then
    select first_seen_at into v_period_start from public.profiles where id = p_user_id;
    v_period_start := coalesce(v_period_start, '1970-01-01'::timestamptz);
    v_period_end := null;
    v_cancel := false;                       -- not meaningful on free
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
end;
$$;

-- deplete_wallet_on_usage: same effective-tier rule for the monthly allowance, and drain packs from the
-- user's row regardless of status (so a downgraded user's overflow still draws down their paid packs).
create or replace function public.deplete_wallet_on_usage()
returns trigger
language plpgsql
security definer
as $$
declare
  v_tier         text := 'free';
  v_row_tier     text;
  v_status       text;
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

  select tier, status, current_period_start, coalesce(pack_credits_balance, 0)
    into v_row_tier, v_status, v_sub_start, v_pack
    from subscriptions
   where user_id = NEW.user_id
   order by created_at desc
   limit 1;

  if v_row_tier = 'pro' and v_status in ('active', 'trialing') then
    v_tier := 'pro';
  else
    v_tier := 'free';
  end if;

  v_monthly := tier_monthly_credits(v_tier);
  if v_monthly is null then return NEW; end if;          -- unmetered tier

  v_period_start := credit_period_start(NEW.user_id, v_tier, v_sub_start);

  -- Usage in this period BEFORE this row (AFTER trigger → NEW is already in the SUM; subtract it back).
  select coalesce(sum(credits_cost), 0) - NEW.credits_cost
    into v_prior_used
    from usage_logs
   where user_id = NEW.user_id and created_at >= v_period_start;
  if v_prior_used < 0 then v_prior_used := 0; end if;

  v_from_monthly := least(NEW.credits_cost, greatest(0, v_monthly - v_prior_used));
  v_overflow := NEW.credits_cost - v_from_monthly;
  if v_overflow <= 0 then return NEW; end if;            -- fully covered by monthly

  -- Bonus first (temporary/free), then packs (paid, never expire — preserved for last).
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
     where user_id = NEW.user_id;                        -- one row per user (038), any status
    v_overflow := v_overflow - v_take;
  end if;

  return NEW;
end;
$$;
