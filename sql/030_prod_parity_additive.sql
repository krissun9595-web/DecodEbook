-- 030: PROD PARITY (Tier 1 — additive only, zero behavior change).
--
-- A staging-vs-prod fingerprint showed prod was built on an older baseline and is missing objects the
-- current client/worker write. This adds the SAFE, additive ones (tables/columns/policy) so nothing is
-- rejected. The billing-FUNCTION gaps (deplete_wallet_on_usage, trg_referral_engagement,
-- tier_monthly_credits, credit_period_start, and the ledger-writing add_bonus/pack_credits) are handled
-- separately in a reviewed Tier-2 script. All idempotent.

-- (1) URGENT: book cloud sync is broken on prod because librarySync upserts pdf_outline (services/
--     librarySync.ts:64) but the column is absent → the whole user_books upsert is rejected. Add it.
alter table public.user_books add column if not exists pdf_outline jsonb;

-- (2) Credit-grant audit log (from sql/015). Table + RLS + read policy + index only — the function
--     redefinitions that WRITE to it are in Tier 2 (they change add_bonus_credits / add_pack_credits).
create table if not exists public.credit_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  delta      int not null,            -- positive = credits added
  type       text not null,           -- 'earn' | 'purchase' | 'bonus' | 'renewal'
  reason     text,                    -- human-readable description
  created_at timestamptz not null default now()
);
alter table public.credit_ledger enable row level security;
drop policy if exists "Users read own credit ledger" on public.credit_ledger;
create policy "Users read own credit ledger" on public.credit_ledger
  for select using (auth.uid() = user_id);
create index if not exists idx_credit_ledger_user on public.credit_ledger(user_id, created_at desc);

-- (3) Remaining missing columns (nullable/defaulted → safe on existing rows).
alter table public.subscriptions   add column if not exists pack_credits_purchased integer default 0;
alter table public.referral_signups add column if not exists referred_ip_hash text;
