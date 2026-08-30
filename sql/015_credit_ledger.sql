-- ============================================================================
-- 015: credit_ledger — records credit ADDITIONS (earn / purchase / bonus / renewal)
-- so the account "Credit history" can show them. Consumption stays in usage_logs
-- (credits_cost); the history view UNIONs the two. Run on staging first, then prod.
-- ============================================================================

create table if not exists public.credit_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  delta      int not null,            -- positive = credits added
  type       text not null,           -- 'earn' | 'purchase' | 'bonus' | 'renewal'
  reason     text,                    -- human-readable description
  created_at timestamptz not null default now()
);

alter table public.credit_ledger enable row level security;
create policy "Users read own credit ledger" on public.credit_ledger
  for select using (auth.uid() = user_id);
create index if not exists idx_credit_ledger_user on public.credit_ledger(user_id, created_at desc);

-- Write a ledger row whenever bonus credits are added (referral / promos).
create or replace function public.add_bonus_credits(p_user_id uuid, p_credits int)
returns void language plpgsql security definer as $$
begin
  insert into public.bonus_credits (user_id, balance, updated_at)
  values (p_user_id, p_credits, now())
  on conflict (user_id) do update set balance = bonus_credits.balance + p_credits, updated_at = now();
  insert into public.credit_ledger (user_id, delta, type, reason)
  values (p_user_id, p_credits, 'bonus', 'Referral / bonus credits');
end; $$;

-- Write a ledger row whenever a credit pack is purchased.
create or replace function public.add_pack_credits(p_user_id uuid, p_credits int)
returns void language plpgsql security definer as $$
begin
  update public.subscriptions
    set pack_credits_balance = coalesce(pack_credits_balance, 0) + p_credits, updated_at = now()
  where user_id = p_user_id and status in ('active', 'trialing');
  insert into public.credit_ledger (user_id, delta, type, reason)
  values (p_user_id, p_credits, 'purchase', 'Credit pack');
end; $$;
