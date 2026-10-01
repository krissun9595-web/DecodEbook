-- Blast radius: DB subscription rows that look stale vs. reality after the 2026-09-09 Stripe
-- API-version drift. Run in the Supabase SQL editor; these are the rows resync-subscriptions.mjs fixes.
--
--   period_in_past   = still marked active/trialing but current_period_end is already past  → renewal froze
--   never_renewed    = updated_at is well after period_end but period never advanced
-- The affected count tells you how many Pro users had their monthly credits stuck.

select
  user_id,
  stripe_subscription_id,
  tier,
  status,
  current_period_start,
  current_period_end,
  updated_at,
  (status in ('active','trialing') and current_period_end is not null and current_period_end < now()) as period_in_past,
  now() - current_period_end as overdue_by
from public.subscriptions
where current_period_end is not null
  and current_period_end < now()
  and status in ('active','trialing')
order by current_period_end asc;
