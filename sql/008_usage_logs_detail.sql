-- Add input/output token breakdown, update tier constraint, add chat quota
-- Run against Supabase SQL editor

-- Add token breakdown columns
alter table usage_logs add column if not exists input_tokens int default 0;
alter table usage_logs add column if not exists output_tokens int default 0;

-- Update subscriptions tier constraint to include 'byok'
alter table subscriptions drop constraint if exists subscriptions_tier_check;
alter table subscriptions add constraint subscriptions_tier_check
  check (tier in ('free', 'pro', 'byok', 'unlimited'));

-- Update RPC function to separate chat from text counting
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
