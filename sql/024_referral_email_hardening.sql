-- ============================================================================
-- 024: referral hardening — treat one PERSON as one referred user, by normalized email.
--
-- Context: bound OAuth identities already share one user_id (so they can't multiply a reward),
-- and unverified accounts are already blocked (sql/019 requires email_confirmed_at). The gap is
-- SEPARATE verified accounts controlled by one person — cheapest via email aliases that hit the
-- same inbox (Gmail ignores dots and +tags; googlemail.com == gmail.com). Those read as distinct
-- users today. This migration:
--   (a) normalizes emails to a canonical inbox, and
--   (b) refuses the 100-credit reward when the referred user's canonical email matches the
--       REFERRER's (self-referral via a second account) or an ALREADY-credited referral of the
--       same referrer (same person, second account).
-- Everything else in award_referral_on_engagement (019) is preserved verbatim.
--
-- Run on STAGING first, verify, then prod. Idempotent.
-- ============================================================================

-- Canonical inbox for an email: lowercase, drop +tag; for gmail/googlemail also drop dots and
-- fold to gmail.com. (Conservative — only the well-known Gmail rules; other providers keep dots.)
CREATE OR REPLACE FUNCTION normalize_email(e text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN e IS NULL OR position('@' in e) = 0 THEN NULL
    ELSE (
      WITH p AS (
        SELECT split_part(lower(trim(e)), '@', 1) AS loc,
               split_part(lower(trim(e)), '@', 2) AS dom
      )
      SELECT CASE
        WHEN dom IN ('gmail.com', 'googlemail.com')
          THEN regexp_replace(split_part(loc, '+', 1), '\.', '', 'g') || '@gmail.com'
        ELSE split_part(loc, '+', 1) || '@' || dom
      END
      FROM p
    )
  END;
$$;

REVOKE EXECUTE ON FUNCTION normalize_email(text) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION award_referral_on_engagement(p_referred uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id            bigint;
  v_referrer      uuid;
  v_ip_hash       text;
  v_email_ok      timestamptz;
  v_used          int;
  v_credited      int;
  v_referred_norm text;
  v_referrer_norm text;
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

  -- (NEW) one PERSON per canonical inbox: block self-referral-by-email and a second account whose
  -- normalized email matches an already-credited referral of the same referrer.
  SELECT normalize_email(email) INTO v_referred_norm FROM auth.users WHERE id = p_referred;
  SELECT normalize_email(email) INTO v_referrer_norm FROM auth.users WHERE id = v_referrer;
  IF v_referred_norm IS NOT NULL AND (
        v_referred_norm = v_referrer_norm
     OR EXISTS (
          SELECT 1 FROM referral_signups s2
            JOIN auth.users u2 ON u2.id = s2.referred_user_id
           WHERE s2.referrer_id = v_referrer
             AND s2.referred_user_id <> p_referred
             AND s2.referrer_credited = true
             AND normalize_email(u2.email) = v_referred_norm
        )
  ) THEN
    UPDATE referral_signups SET activated = true, referrer_credited = false WHERE id = v_id;
    RETURN;
  END IF;

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

REVOKE EXECUTE ON FUNCTION award_referral_on_engagement(uuid) FROM public, anon, authenticated;
