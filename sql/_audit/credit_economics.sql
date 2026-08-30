-- ============================================================================
-- Credit economics audit (READ-ONLY) — run in the PRODUCTION Supabase SQL editor.
-- Shows real API cost vs credits charged per action, to find money-losing actions.
--
-- Revenue proxy: 1 credit ~= 1 cent (Pro tier = $9.99 / 1000 credits).
-- CAVEATS:
--   * usage_logs has NO model column, so cost cannot be attributed to which LLM
--     the user picked (only per-action aggregates).
--   * cost_cents was computed with the STALE COST_PER_M (Gemini undercounted
--     ~10x), so these figures are an OPTIMISTIC FLOOR — real margins are worse.
-- ============================================================================

-- 1. Per-action economics (the main table)
select
  action,
  count(*)                             as calls,
  round(avg(cost_cents)::numeric, 2)   as avg_cost_c,     -- avg real cost, cents
  round(max(cost_cents)::numeric, 2)   as max_cost_c,     -- worst single call
  round(avg(credits_cost)::numeric, 2) as avg_credits,    -- avg credits charged
  sum(cost_cents)                      as total_cost_c,   -- total real cost, cents
  sum(credits_cost)                    as total_credits_c,-- ~= revenue, cents
  sum(credits_cost) - sum(cost_cents)  as margin_c        -- NEGATIVE = losing money
from usage_logs
where created_at > now() - interval '90 days'
group by action
order by total_cost_c desc;

-- 2. Headline: overall cost vs revenue over the window
select
  sum(cost_cents)                     as total_cost_c,
  sum(credits_cost)                   as total_rev_c,
  sum(credits_cost) - sum(cost_cents) as net_margin_c
from usage_logs
where created_at > now() - interval '90 days';

-- 3. (Optional) token volume per action — helps size the high-variance actions
select
  action,
  count(*)                              as calls,
  round(avg(input_tokens)::numeric, 0)  as avg_in_tok,
  round(avg(output_tokens)::numeric, 0) as avg_out_tok,
  max(output_tokens)                    as max_out_tok
from usage_logs
where created_at > now() - interval '90 days'
group by action
order by avg_out_tok desc;
