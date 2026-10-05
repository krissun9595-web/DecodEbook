-- ============================================================================
-- 038: Credit-model hardening.
--   A — carry-over fires at most ONCE per user, ever (not "once per non-pro gap"),
--       and does its whole job atomically (claim + grant + consume) so it can't
--       half-finish or re-accumulate across upgrade/cancel cycles.
--   B — ONE subscriptions row per user. Multiple rows (one per upgrade) let pack
--       credits on a stale row get orphaned (get_user_credits reads newest only).
--       Collapse to one row (summing pack balances) + UNIQUE(user_id) so future
--       upserts merge instead of inserting.
-- Run on STAGING first, verify, then prod.
-- ============================================================================

-- ── A. One-time carry-over ──────────────────────────────────────────────────
alter table public.profiles add column if not exists free_carried_over boolean not null default false;

-- Backfill: anyone who already received a carry-over grant must not get another.
update public.profiles p set free_carried_over = true
where exists (
  select 1 from public.credit_ledger l
  where l.user_id = p.id and l.type = 'bonus' and l.reason = 'Free credits carried over'
) and coalesce(p.free_carried_over, false) = false;

-- Atomic, once-ever carry-over. Claims the flag (only the first caller wins), then carries the
-- user's UNUSED free credits into permanent bonus AND consumes them (so they can't reappear on a
-- later downgrade). Returns the amount carried (0 if already done or nothing to carry).
create or replace function public.carry_over_free_credits(p_user_id uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_first_seen timestamptz;
  v_used       int;
  v_free_total int := tier_monthly_credits('free');
  v_remaining  int;
begin
  -- Claim atomically: only the first caller flips false→true.
  update public.profiles set free_carried_over = true
   where id = p_user_id and coalesce(free_carried_over, false) = false;
  if not found then return 0; end if;                      -- already carried over once, ever

  select coalesce(first_seen_at, '1970-01-01'::timestamptz) into v_first_seen
    from public.profiles where id = p_user_id;

  select coalesce(sum(credits_cost), 0) into v_used
    from public.usage_logs
   where user_id = p_user_id and created_at >= v_first_seen;

  v_remaining := v_free_total - least(v_free_total, greatest(0, v_used));
  if v_remaining is null or v_remaining <= 0 then return 0; end if;   -- nothing to carry

  -- Grant as permanent bonus + a ledger line.
  insert into public.bonus_credits (user_id, balance, updated_at)
  values (p_user_id, v_remaining, now())
  on conflict (user_id) do update set balance = bonus_credits.balance + v_remaining, updated_at = now();
  insert into public.credit_ledger (user_id, delta, type, reason)
  values (p_user_id, v_remaining, 'bonus', 'Free credits carried over');

  -- Consume those free credits (stamped at the free period start = first_seen_at so it counts only
  -- vs the free lifetime grant, never a Pro period; the wallet-depletion trigger sees zero overflow,
  -- leaving the bonus just granted untouched). Hidden from Credit History by the client.
  insert into public.usage_logs (user_id, action, model, credits_cost, cost_cents, usage_id, created_at)
  values (p_user_id, 'creditCarryover', 'carryover', v_remaining, 0, gen_random_uuid(), v_first_seen);

  return v_remaining;
end; $$;

revoke all on function public.carry_over_free_credits(uuid) from public, anon, authenticated;
grant execute on function public.carry_over_free_credits(uuid) to service_role;

-- ── B. One subscriptions row per user ───────────────────────────────────────
-- Collapse multi-row users onto their NEWEST row, SUMMING pack balances so paid credits on stale
-- rows aren't orphaned. (created_at desc, ctid desc = deterministic newest.)
update public.subscriptions s
   set pack_credits_balance   = agg.tot_bal,
       pack_credits_purchased = agg.tot_pur,
       updated_at = now()
  from (
    select user_id,
           sum(coalesce(pack_credits_balance, 0))   as tot_bal,
           sum(coalesce(pack_credits_purchased, 0)) as tot_pur,
           (array_agg(id order by created_at desc, ctid desc))[1] as keep_id
    from public.subscriptions
    group by user_id
    having count(*) > 1
  ) agg
 where s.id = agg.keep_id;

delete from public.subscriptions s
 using (
   select id, row_number() over (partition by user_id order by created_at desc, ctid desc) as rn
   from public.subscriptions
 ) r
 where s.id = r.id and r.rn > 1;

-- Enforce one row per user so the webhook upsert (?on_conflict=user_id) MERGES onto it.
alter table public.subscriptions
  add constraint subscriptions_user_id_key unique (user_id);
