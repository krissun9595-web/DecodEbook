-- 033: Atomic credit reservation (reserve-then-release) to close the concurrency race
-- where several expensive requests read the same balance before any is charged and all pass
-- the gate. A reservation is a TRANSIENT HOLD in its own table — it never touches usage_logs
-- or the pack/bonus depletion triggers, so the real charge path is unchanged. The worker
-- holds the estimated cost for the duration of a generation, then releases it; the actual
-- charge is still recorded in usage_logs as before.
--
-- Balance seen by the gate = get_user_credits available MINUS the sum of this user's active
-- (non-expired) holds. reserve_credits() serializes per-user via an advisory lock so two
-- concurrent reserves can't both pass.

create table if not exists public.credit_reservations (
  usage_id   uuid primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  credits    int  not null check (credits >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes')
);
create index if not exists idx_credit_reservations_user_active
  on public.credit_reservations (user_id, expires_at);

-- Service-role only (the worker uses the service key, which bypasses RLS). Enable RLS with no
-- policies so no client can read/write holds directly.
alter table public.credit_reservations enable row level security;

-- Hold p_credits against the live balance (minus other active holds). Returns
-- {ok:true} if held, {ok:false, available, required} if not. Idempotent per usage_id.
create or replace function public.reserve_credits(p_user_id uuid, p_usage_id uuid, p_credits int)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v json;
  v_tier text;
  v_monthly int;
  v_used int;
  v_pack int;
  v_bonus int;
  v_available int;
  v_held int;
begin
  -- Serialize reserves for THIS user so concurrent calls can't both see the pre-hold balance.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 42));

  -- Best-effort GC of this user's expired holds (keeps the table small; also un-holds a
  -- crashed request's lease so it can't block the user forever).
  delete from public.credit_reservations where user_id = p_user_id and expires_at <= now();

  -- Idempotent retry: the same request already holds → succeed.
  if exists (select 1 from public.credit_reservations where usage_id = p_usage_id) then
    return json_build_object('ok', true, 'idempotent', true);
  end if;

  v := public.get_user_credits(p_user_id);
  v_tier    := coalesce(v->>'tier', 'free');
  v_monthly := public.tier_monthly_credits(v_tier);
  v_used    := coalesce((v->>'credits_used')::int, 0);
  v_pack    := coalesce((v->>'pack_credits')::int, 0);
  v_bonus   := coalesce((v->>'bonus_credits')::int, 0);

  -- Null monthly = an unmetered/unlimited tier → always allow (still record the hold so a
  -- future metered read stays consistent).
  if v_monthly is null then
    insert into public.credit_reservations (usage_id, user_id, credits)
      values (p_usage_id, p_user_id, greatest(coalesce(p_credits, 0), 0));
    return json_build_object('ok', true, 'unlimited', true);
  end if;

  -- get_user_credits already caps credits_used at the monthly allowance.
  v_available := greatest(0, v_monthly - v_used) + v_pack + v_bonus;

  select coalesce(sum(credits), 0) into v_held
    from public.credit_reservations
   where user_id = p_user_id and expires_at > now();

  if (v_available - v_held) < p_credits then
    return json_build_object('ok', false, 'available', (v_available - v_held), 'required', p_credits, 'tier', v_tier);
  end if;

  insert into public.credit_reservations (usage_id, user_id, credits)
    values (p_usage_id, p_user_id, greatest(coalesce(p_credits, 0), 0));

  return json_build_object('ok', true, 'available', (v_available - v_held), 'tier', v_tier);
end;
$$;

-- Release a hold (after the action finishes — success OR failure; the real charge, if any,
-- is recorded separately in usage_logs).
create or replace function public.release_reservation(p_usage_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.credit_reservations where usage_id = p_usage_id;
$$;

-- Include active holds in the balance the client displays, so a hold in flight isn't briefly
-- spendable twice. (Kept separate from get_user_credits so that RPC's shape is unchanged.)
create or replace function public.get_available_with_holds(p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v json; v_tier text; v_monthly int; v_used int; v_pack int; v_bonus int; v_held int;
begin
  v := public.get_user_credits(p_user_id);
  v_tier := coalesce(v->>'tier','free');
  v_monthly := public.tier_monthly_credits(v_tier);
  if v_monthly is null then return 2147483647; end if;
  v_used  := coalesce((v->>'credits_used')::int, 0);
  v_pack  := coalesce((v->>'pack_credits')::int, 0);
  v_bonus := coalesce((v->>'bonus_credits')::int, 0);
  select coalesce(sum(credits),0) into v_held from public.credit_reservations
    where user_id = p_user_id and expires_at > now();
  return greatest(0, (greatest(0, v_monthly - v_used) + v_pack + v_bonus) - v_held);
end;
$$;
