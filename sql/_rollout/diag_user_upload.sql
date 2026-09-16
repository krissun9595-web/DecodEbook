-- Diagnose the "upload errors with no message" report on PROD.
-- User: 4319d51c-9b4d-4008-93fd-5d77c4c2d1a8
-- Run in the PRODUCTION Supabase SQL editor. Read the 5 results top-to-bottom;
-- interpretation notes are at the bottom.
--
-- Mechanism: an upload runs analyzeBookStructure (gate cost = 15 credits). If the
-- worker's get_user_credits RPC reports available < 15 it returns HTTP 429, which
-- the client shows as the CreditNotice upgrade prompt — no red error text. That is
-- the ONLY no-message failure path.

\set uid '4319d51c-9b4d-4008-93fd-5d77c4c2d1a8'

-- 1) What the worker/gate actually sees (authoritative):
SELECT public.get_user_credits(:'uid'::uuid) AS rpc_result;

-- 2) Raw usage since signup — cross-check credits_used vs the RPC:
SELECT COUNT(*)                         AS usage_rows,
       COALESCE(SUM(credits_cost), 0)   AS raw_credits_used,
       MIN(created_at)                  AS first_use,
       MAX(created_at)                  AS last_use
FROM public.usage_logs
WHERE user_id = :'uid'::uuid;

-- 3) Subscription + pack wallet (is she free, and any packs?):
SELECT tier, status, current_period_start, current_period_end, cancel_at_period_end,
       pack_credits_balance, pack_credits_purchased
FROM public.subscriptions
WHERE user_id = :'uid'::uuid
ORDER BY created_at DESC;

-- 4) Free-tier period anchor + bonus wallet:
SELECT p.first_seen_at,
       (SELECT balance FROM public.bonus_credits b WHERE b.user_id = p.id) AS bonus_balance
FROM public.profiles p
WHERE p.id = :'uid'::uuid;

-- 5) Is prod's get_user_credits the CURRENT body? (rollout 031/032 was PENDING on prod)
--    Compare against sql/032_prod_parity_verbatim_bodies.sql — it must read
--    profiles.first_seen_at and cap usage at tier_monthly_credits.
SELECT pg_get_functiondef('public.get_user_credits(uuid)'::regprocedure) AS fn_body;

-- ── Interpretation ─────────────────────────────────────────────────────────────
-- • RPC credits_used ≈ 100 (capped), pack=0, bonus=0  → available < 15 → GENUINELY
--   out of free credits. The prompt is correct; she must upgrade or buy a pack.
--   (Free = 100 ONE-TIME credits, not monthly — it never resets for free users.)
-- • raw_credits_used is LOW (<85) but RPC available is still <15  → the RPC is
--   mis-counting → prod fn is stale or usage_logs has dup/foreign rows. Deploy
--   031/032 to prod and re-check; inspect usage_logs for duplicate usage_id.
-- • fn_body differs from sql/032  → prod is running a STALE get_user_credits →
--   run 031_prod_parity_functions.sql + 032_prod_parity_verbatim_bodies.sql on prod.
-- • RPC errors / first_seen_at is NULL  → profiles schema drift on prod.
