-- 035: add_bonus_credits_reason — like add_bonus_credits (atomic bonus-balance bump + a credit_ledger
-- row) but takes a human-readable reason, so the credit history can distinguish e.g. "Free credits
-- carried over" (Pro-upgrade carry-over, written by the worker's checkout.session.completed handler)
-- from the referral "Referral / bonus credits". Service-role only (same lockdown as add_bonus_credits).
-- Idempotent (CREATE OR REPLACE). Run on BOTH prod + staging Supabase.

create or replace function public.add_bonus_credits_reason(p_user_id uuid, p_credits int, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.bonus_credits (user_id, balance, updated_at)
  values (p_user_id, p_credits, now())
  on conflict (user_id) do update set balance = bonus_credits.balance + p_credits, updated_at = now();

  insert into public.credit_ledger (user_id, delta, type, reason)
  values (p_user_id, p_credits, 'bonus', p_reason);
end;
$$;

revoke all on function public.add_bonus_credits_reason(uuid, int, text) from public, anon, authenticated;
grant execute on function public.add_bonus_credits_reason(uuid, int, text) to service_role;
