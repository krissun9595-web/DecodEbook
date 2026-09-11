-- Verify implicit-cache pass-through billing for AI-assistant chat.
-- Run in the Supabase SQL editor (staging project).
--
-- WHAT TO EXPECT
--   * The FIRST chat message after an idle gap is a COLD request  -> cachedTok 0 -> ~194 credits.
--   * FOLLOW-UP messages sent within a short window HIT the implicit cache
--     -> input_tokens stays ~the same (~219k, the whole book) BUT credits_cost DROPS to ~25-60.
--   * Same input_tokens + lower credits_cost == the cached slice was billed at 10% (the fix working).

-- 1) Recent chat charges, newest first. Watch credits_cost fall on warm follow-ups.
select
  created_at,
  action,
  model,
  input_tokens,     -- TOTAL prompt (cached + fresh); ~constant across cold & warm
  output_tokens,
  credits_cost,     -- the number the user is charged; drops on a cache hit
  cost_cents,       -- real API cost in cents
  usage_id
from usage_logs
where action = 'chat'
order by created_at desc
limit 20;

-- 2) Double-charge guard: the worker (dual-write) and client dedupe on usage_id,
--    so every REAL usage_id must appear EXACTLY ONCE. This query should return ZERO rows.
--    NOTE: exclude usage_id IS NULL — legacy pre-Phase-A rows (before the usage_id column
--    existed) all carry null and would group together as a meaningless false positive.
select usage_id, count(*) as rows
from usage_logs
where action = 'chat' and usage_id is not null
group by usage_id
having count(*) > 1;
