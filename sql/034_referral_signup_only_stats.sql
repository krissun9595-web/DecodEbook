-- 034_referral_signup_only_stats.sql
-- Referral is signup-only now (click rewards were removed in the write path back on
-- 2026-09-12, commit 0185369 → handleTrackClick writes credited=false). This aligns
-- get_referral_stats with that model: it no longer computes click credits or folds
-- them into total_earned. Clicks are still counted for information only.
--
-- Display-only: this function is a read RPC; it does NOT grant or revoke credits.
-- Already-granted bonus credits (bonus_credits.balance) are untouched.
--
-- Run in the Supabase SQL editor of the target project (staging first, then prod).
-- Idempotent (CREATE OR REPLACE); preserves the grants/search_path from sql/031/032.

CREATE OR REPLACE FUNCTION public.get_referral_stats(p_user_id uuid) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_code TEXT;
  v_clicks INT;
  v_signups INT;
  v_activated INT;
  v_signup_credits INT;
  v_bonus INT;
BEGIN
  SELECT code INTO v_code FROM referral_codes WHERE user_id = p_user_id;

  -- Informational only; click-based crediting was removed (signup-only model).
  SELECT COUNT(*) INTO v_clicks FROM referral_clicks
    WHERE referrer_id = p_user_id AND credited = true;

  SELECT COUNT(*) INTO v_signups FROM referral_signups
    WHERE referrer_id = p_user_id;
  SELECT COUNT(*) INTO v_activated FROM referral_signups
    WHERE referrer_id = p_user_id AND activated = true AND referrer_credited = true;
  v_signup_credits := v_activated * 100;

  SELECT COALESCE(balance, 0) INTO v_bonus FROM bonus_credits WHERE user_id = p_user_id;

  RETURN json_build_object(
    'code', v_code,
    'clicks', v_clicks,
    'click_credits', 0,
    'click_credits_cap', 0,
    'signups', v_signups,
    'activated', v_activated,
    'signup_credits', v_signup_credits,
    'bonus_balance', COALESCE(v_bonus, 0),
    'total_earned', v_signup_credits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_referral_stats(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_referral_stats(p_user_id uuid) TO service_role;
