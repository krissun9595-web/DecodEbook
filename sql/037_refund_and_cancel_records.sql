-- ============================================================================
-- 037: Refund + cancellation accounting.
--
-- Adds the pieces the worker's Stripe webhook needs to RECORD refunds and
-- cancellations in the credit history, and to reverse pack credits on a refund:
--
--   1. credit_pack_purchases.refunded / refunded_at — makes a pack refund
--      idempotent (a redelivered charge.refunded webhook can't double-debit).
--   2. refund_pack_credits()  — debit a refunded pack from BOTH the remaining
--      balance and the cumulative-purchased denominator (floored at 0), and
--      write a negative 'refund' ledger row so it shows in Credit History.
--   3. add_credit_note()      — write a delta-0 ledger row (type 'subscription'
--      or 'refund') to RECORD a cancel / downgrade / refund as a history line.
--      Monthly/Free credits are computed (allowance − period usage), not a stored
--      balance, so a cancel has no delta — it's an informational note only.
--
-- All three are service_role-only (the worker calls them; clients never do).
-- Run on STAGING first, verify, then prod.
-- ============================================================================

-- 1. Idempotency columns for pack refunds.
alter table public.credit_pack_purchases add column if not exists refunded    boolean     not null default false;
alter table public.credit_pack_purchases add column if not exists refunded_at timestamptz;

-- 2. Reverse a refunded credit pack. Debit balance + purchased (floor 0) and log it.
create or replace function public.refund_pack_credits(p_user_id uuid, p_credits int)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.subscriptions
     set pack_credits_balance   = greatest(0, coalesce(pack_credits_balance, 0)   - p_credits),
         pack_credits_purchased = greatest(0, coalesce(pack_credits_purchased, 0) - p_credits),
         updated_at = now()
   where user_id = p_user_id;
  insert into public.credit_ledger (user_id, delta, type, reason)
  values (p_user_id, -p_credits, 'refund', 'Credit pack refunded');
end; $$;

-- 3. Record a cancel / downgrade / refund as a delta-0 history line.
create or replace function public.add_credit_note(p_user_id uuid, p_reason text, p_type text default 'subscription')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.credit_ledger (user_id, delta, type, reason)
  values (p_user_id, 0, p_type, p_reason);
end; $$;

revoke all on function public.refund_pack_credits(uuid, int)        from public, anon, authenticated;
revoke all on function public.add_credit_note(uuid, text, text)     from public, anon, authenticated;
grant execute on function public.refund_pack_credits(uuid, int)     to service_role;
grant execute on function public.add_credit_note(uuid, text, text)  to service_role;
