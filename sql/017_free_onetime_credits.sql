-- ============================================================================
-- 017: Free tier = ONE-TIME lifetime 100-credit grant (not a monthly reset).
-- get_user_credits previously counted a free user's usage since the start of the
-- current month, so free credits effectively refreshed monthly. Now, for free tier
-- we count usage since SIGNUP (profiles.first_seen_at), so the 100 credits are a
-- one-time "Signup bonus" that never renews. Paid tiers are unchanged (monthly).
-- Run on staging first, then prod.
-- ============================================================================

create or replace function public.get_user_credits(p_user_id uuid)
returns json
language plpgsql
security definer
as $$
declare
  v_tier text := 'free';
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_cancel boolean := false;
  v_pack_balance int := 0;
  v_bonus int := 0;
  v_credits_used int;
begin
  select tier, current_period_start, current_period_end, cancel_at_period_end, coalesce(pack_credits_balance, 0)
    into v_tier, v_period_start, v_period_end, v_cancel, v_pack_balance
  from public.subscriptions
  where user_id = p_user_id and status in ('active', 'trialing')
  order by created_at desc limit 1;

  if v_tier is null then v_tier := 'free'; end if;

  if v_tier = 'free' then
    -- Free credits are a one-time lifetime grant: count usage since signup.
    select first_seen_at into v_period_start from public.profiles where id = p_user_id;
    v_period_start := coalesce(v_period_start, '1970-01-01'::timestamptz);
    v_period_end := null;
  elsif v_period_start is null then
    v_period_start := date_trunc('month', now());
  end if;

  select coalesce(balance, 0) into v_bonus from public.bonus_credits where user_id = p_user_id;

  select coalesce(sum(credits_cost), 0) into v_credits_used from public.usage_logs
  where user_id = p_user_id and created_at >= v_period_start;

  return json_build_object(
    'tier', v_tier,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'cancel_at_period_end', v_cancel,
    'credits_used', v_credits_used,
    'pack_credits', v_pack_balance,
    'bonus_credits', coalesce(v_bonus, 0)
  );
end;
$$;
