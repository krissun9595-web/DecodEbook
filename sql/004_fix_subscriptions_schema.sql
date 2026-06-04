-- Fix subscriptions table to match what the Cloudflare Worker expects.
-- The worker writes 'tier', 'stripe_price_id', and 'cancel_at_period_end'
-- but the original schema used 'plan' and omitted the other two columns.

-- Rename 'plan' to 'tier'
alter table public.subscriptions rename column plan to tier;

-- Add missing columns the worker writes to
alter table public.subscriptions
  add column if not exists stripe_price_id text,
  add column if not exists cancel_at_period_end boolean not null default false;

-- Update the check constraint to use the new column name
alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions drop constraint if exists subscriptions_tier_check;
alter table public.subscriptions add constraint subscriptions_tier_check
  check (tier in ('free', 'pro', 'unlimited', 'team'));
