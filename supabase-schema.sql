-- Run this in Supabase Dashboard → SQL Editor → New Query

create table if not exists user_settings (
  user_id uuid references auth.users primary key,
  gemini_key text,
  openrouter_key text,
  target_language text default 'Original',
  highlight_color text default 'indigo',
  text_size text default 'base',
  line_height text default 'normal',
  letter_spacing text default 'normal',
  font text default 'Inter',
  updated_at timestamptz default now()
);

alter table user_settings enable row level security;
create policy "Users manage own settings" on user_settings
  for all using (auth.uid() = user_id);

create table if not exists usage_logs (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users,
  action text,
  tokens_used int default 0,
  input_tokens int default 0,
  output_tokens int default 0,
  cost_cents int default 0,
  created_at timestamptz default now()
);

alter table usage_logs enable row level security;
create policy "Users read own logs" on usage_logs
  for select using (auth.uid() = user_id);
create policy "Users insert own logs" on usage_logs
  for insert with check (auth.uid() = user_id);

-- ============================================================
-- Subscriptions (Stripe)
-- ============================================================

create table if not exists subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users not null,
  stripe_customer_id text not null,
  stripe_subscription_id text unique,
  stripe_price_id text,
  tier text not null default 'free' check (tier in ('free', 'pro', 'byok', 'unlimited')),
  status text not null default 'active' check (status in ('active', 'canceled', 'past_due', 'incomplete', 'trialing')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table subscriptions enable row level security;
create policy "Users read own subscriptions" on subscriptions
  for select using (auth.uid() = user_id);

create index if not exists idx_subscriptions_stripe_customer on subscriptions(stripe_customer_id);
create index if not exists idx_subscriptions_stripe_subscription on subscriptions(stripe_subscription_id);
create index if not exists idx_subscriptions_user on subscriptions(user_id);

-- Returns user tier + usage counts for the current billing period
create or replace function get_user_tier_and_usage(p_user_id uuid)
returns json
language plpgsql
security definer
as $$
declare
  v_tier text := 'free';
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_cancel boolean := false;
  v_text_count int;
  v_tts_count int;
  v_image_count int;
  v_video_count int;
  v_chat_count int;
begin
  select tier, current_period_start, current_period_end, cancel_at_period_end
    into v_tier, v_period_start, v_period_end, v_cancel
  from subscriptions
  where user_id = p_user_id and status in ('active', 'trialing')
  order by created_at desc limit 1;

  if v_tier is null then v_tier := 'free'; end if;
  if v_period_start is null then v_period_start := date_trunc('month', now()); end if;

  select
    coalesce(sum(case when action like 'text:%' or action in (
      'analyzeBookStructure','extractChapterText','extractConcepts',
      'extractDictionary','podcastScript','videoPrompt'
    ) then 1 else 0 end), 0),
    coalesce(sum(case when action in ('tts','podcastAudio') then 1 else 0 end), 0),
    coalesce(sum(case when action = 'generateImage' then 1 else 0 end), 0),
    coalesce(sum(case when action in ('videoVeo','videoSeedance') then 1 else 0 end), 0),
    coalesce(sum(case when action = 'chat' then 1 else 0 end), 0)
  into v_text_count, v_tts_count, v_image_count, v_video_count, v_chat_count
  from usage_logs
  where user_id = p_user_id and created_at >= v_period_start;

  return json_build_object(
    'tier', v_tier,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'cancel_at_period_end', v_cancel,
    'text_used', v_text_count,
    'tts_used', v_tts_count,
    'image_used', v_image_count,
    'video_used', v_video_count,
    'chat_used', v_chat_count
  );
end;
$$;
