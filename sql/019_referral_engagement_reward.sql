-- ============================================================================
-- 019: Referral reward on ENGAGEMENT (signup + genuine free-credit usage).
--
-- Goal: grow the app by rewarding referrers when the people they invite actually
-- TRY it — i.e. sign up and start spending their free credits — rather than only
-- when they upgrade to a paid plan. Replaces the old paid-activation trigger
-- (worker checkReferralActivation, removed).
--
-- The referrer earns 100 credits once their referred user:
--   (a) has a VERIFIED email, and
--   (b) has consumed >= REFERRAL_ENGAGEMENT_THRESHOLD free credits (a real trial).
--
-- ANTI-ABUSE (layered — caps bound the damage, the rest raises the cost of faking):
--   1. Email verified            → blocks throwaway/bot accounts that can't confirm.
--   2. Genuine usage threshold   → a bot must actually use the product, not just register.
--   3. One reward per referred user (referred_user_id UNIQUE, from 010).
--   4. Per-referrer cap 1,000 cr (10 x 100)  → bounds max exposure per attacker.
--   5. No self-referral (referrer <> referred, enforced at signup in the worker).
--   6. Same-IP self-farm guard   → a referred signup whose IP hash matches ANOTHER
--      already-credited referral by the SAME referrer is not credited (one person
--      spinning up multiple accounts on one network).
-- Residual risk: usage_logs is client-inserted (existing trust model), so a determined
-- attacker with verified emails could fake usage — but each yields only 100 cr, capped
-- at 1,000/referrer, and credits are non-refundable store credit. Server-side metering
-- would close this fully (separate, larger project).
--
-- Run on STAGING first, verify, then prod.
-- ============================================================================

-- Store the referred user's signup IP hash (written by the worker) for the self-farm guard.
ALTER TABLE referral_signups ADD COLUMN IF NOT EXISTS referred_ip_hash text;

-- Award the referrer once their referred user proves a genuine trial.
CREATE OR REPLACE FUNCTION award_referral_on_engagement(p_referred uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id            bigint;
  v_referrer      uuid;
  v_ip_hash       text;
  v_email_ok      timestamptz;
  v_used          int;
  v_credited      int;
  threshold constant int := 20;   -- free credits the referred user must spend to qualify (tunable)
BEGIN
  -- Pending (not-yet-processed) referral for this user?
  SELECT id, referrer_id, referred_ip_hash
    INTO v_id, v_referrer, v_ip_hash
    FROM referral_signups
   WHERE referred_user_id = p_referred AND activated = false
   LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  -- (1) email verified
  SELECT email_confirmed_at INTO v_email_ok FROM auth.users WHERE id = p_referred;
  IF v_email_ok IS NULL THEN RETURN; END IF;   -- not yet verified; try again on later usage

  -- (2) genuine free-credit usage
  SELECT COALESCE(SUM(credits_cost), 0) INTO v_used FROM usage_logs WHERE user_id = p_referred;
  IF v_used < threshold THEN RETURN; END IF;    -- not engaged enough yet; try again later

  -- (6) same-IP self-farm guard: another already-credited referral by this referrer shares this IP
  IF v_ip_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM referral_signups s2
     WHERE s2.referrer_id = v_referrer
       AND s2.referred_user_id <> p_referred
       AND s2.referred_ip_hash = v_ip_hash
       AND s2.referrer_credited = true
  ) THEN
    UPDATE referral_signups SET activated = true, referrer_credited = false WHERE id = v_id;
    RETURN;
  END IF;

  -- (4) per-referrer cap: 1,000 credits = 10 x 100
  SELECT count(*) INTO v_credited FROM referral_signups
   WHERE referrer_id = v_referrer AND referrer_credited = true;

  -- Mark processed once; credit only under the cap.
  UPDATE referral_signups
     SET activated = true, referrer_credited = (v_credited < 10)
   WHERE id = v_id;

  IF v_credited < 10 THEN
    PERFORM add_bonus_credits(v_referrer, 100);   -- also writes a credit_ledger 'bonus' row (015)
  END IF;
END;
$$;

-- Fire the check whenever the referred user consumes credits.
CREATE OR REPLACE FUNCTION trg_referral_engagement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Never let referral logic break usage logging: swallow any error.
  BEGIN
    PERFORM award_referral_on_engagement(NEW.user_id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_engagement ON usage_logs;
CREATE TRIGGER trg_referral_engagement
  AFTER INSERT ON usage_logs
  FOR EACH ROW
  EXECUTE FUNCTION trg_referral_engagement();

-- Hardening: with byok/unlimited tiers removed, no tier should be unmetered. Make the
-- monthly-allowance helper (018) treat any unknown/legacy tier as free-metered (100)
-- instead of NULL (which the 018 trigger and get_user_credits treat as "unlimited").
CREATE OR REPLACE FUNCTION tier_monthly_credits(p_tier text)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_tier
           WHEN 'pro' THEN 1000
           ELSE 100          -- free and any legacy/unknown tier: metered at the free allowance
         END;
$$;
