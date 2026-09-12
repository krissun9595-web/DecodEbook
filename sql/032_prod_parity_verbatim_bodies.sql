-- 032: PROD PARITY (Tier 3 — byte-identical function bodies).
--
-- 031 brought these 6 functions to the correct LOGIC but I retyped them (lowercase/compact), so their
-- stored source differed from staging (md5 mismatch, cosmetic only). This re-creates them from the
-- VERBATIM sql/018 & sql/019 text — exactly what staging ran — so pg_get_functiondef (and its md5)
-- matches staging byte-for-byte, and eliminates any transcription risk. award_referral_on_engagement is
-- deliberately untouched (prod already has the newer 024). Idempotent.

-- ---- add_pack_credits (sql/018) ----
CREATE OR REPLACE FUNCTION add_pack_credits(p_user_id uuid, p_credits int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE subscriptions
     SET pack_credits_balance   = COALESCE(pack_credits_balance, 0)   + p_credits,
         pack_credits_purchased = COALESCE(pack_credits_purchased, 0) + p_credits,
         updated_at = now()
   WHERE user_id = p_user_id AND status IN ('active', 'trialing');
  INSERT INTO public.credit_ledger (user_id, delta, type, reason)
  VALUES (p_user_id, p_credits, 'purchase', 'Credit pack');
END;
$$;

-- ---- credit_period_start (sql/018) ----
CREATE OR REPLACE FUNCTION credit_period_start(p_user_id uuid, p_tier text, p_sub_start timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v timestamptz;
BEGIN
  IF p_tier = 'free' THEN
    SELECT first_seen_at INTO v FROM profiles WHERE id = p_user_id;
    RETURN COALESCE(v, '1970-01-01'::timestamptz);
  END IF;
  RETURN COALESCE(p_sub_start, date_trunc('month', now()));
END;
$$;

-- ---- deplete_wallet_on_usage (sql/018) ----
CREATE OR REPLACE FUNCTION deplete_wallet_on_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tier         text := 'free';
  v_sub_start    timestamptz;
  v_monthly      int;
  v_period_start timestamptz;
  v_prior_used   int;
  v_from_monthly int;
  v_overflow     int;
  v_pack         int := 0;
  v_bonus        int := 0;
  v_take         int;
BEGIN
  IF COALESCE(NEW.credits_cost, 0) <= 0 THEN RETURN NEW; END IF;

  SELECT tier, current_period_start, COALESCE(pack_credits_balance, 0)
    INTO v_tier, v_sub_start, v_pack
    FROM subscriptions
   WHERE user_id = NEW.user_id AND status IN ('active', 'trialing')
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_tier IS NULL THEN v_tier := 'free'; END IF;

  v_monthly := tier_monthly_credits(v_tier);
  IF v_monthly IS NULL THEN RETURN NEW; END IF;         -- unmetered tier

  v_period_start := credit_period_start(NEW.user_id, v_tier, v_sub_start);

  -- Usage in this period BEFORE this row. This is an AFTER trigger, so NEW is already
  -- counted in the SUM — subtract it back out to get the prior total.
  SELECT COALESCE(SUM(credits_cost), 0) - NEW.credits_cost
    INTO v_prior_used
    FROM usage_logs
   WHERE user_id = NEW.user_id AND created_at >= v_period_start;
  IF v_prior_used < 0 THEN v_prior_used := 0; END IF;

  v_from_monthly := LEAST(NEW.credits_cost, GREATEST(0, v_monthly - v_prior_used));
  v_overflow := NEW.credits_cost - v_from_monthly;
  IF v_overflow <= 0 THEN RETURN NEW; END IF;           -- fully covered by monthly

  -- Bonus first: it's temporary/free, so drain it before the paid packs.
  SELECT COALESCE(balance, 0) INTO v_bonus FROM bonus_credits WHERE user_id = NEW.user_id;
  IF v_bonus > 0 THEN
    v_take := LEAST(v_overflow, v_bonus);
    UPDATE bonus_credits
       SET balance = balance - v_take, updated_at = now()
     WHERE user_id = NEW.user_id;
    v_overflow := v_overflow - v_take;
  END IF;

  -- Then packs (paid, never expire — preserved for last).
  IF v_overflow > 0 AND v_pack > 0 THEN
    v_take := LEAST(v_overflow, v_pack);
    UPDATE subscriptions
       SET pack_credits_balance = COALESCE(pack_credits_balance, 0) - v_take,
           updated_at = now()
     WHERE user_id = NEW.user_id AND status IN ('active', 'trialing');
    v_overflow := v_overflow - v_take;
  END IF;

  -- Any remaining v_overflow means the pre-charge gate let an over-budget action
  -- through; it is intentionally not clamped here (history stays truthful).
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deplete_wallet ON usage_logs;
CREATE TRIGGER trg_deplete_wallet
  AFTER INSERT ON usage_logs
  FOR EACH ROW
  EXECUTE FUNCTION deplete_wallet_on_usage();

-- ---- get_user_credits (sql/018) ----
CREATE OR REPLACE FUNCTION get_user_credits(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tier         text := 'free';
  v_period_start timestamptz;
  v_period_end   timestamptz;
  v_cancel       boolean := false;
  v_pack_balance int := 0;
  v_pack_bought  int := 0;
  v_bonus        int := 0;
  v_credits_used int;
  v_monthly      int;
BEGIN
  SELECT tier, current_period_start, current_period_end, cancel_at_period_end,
         COALESCE(pack_credits_balance, 0), COALESCE(pack_credits_purchased, 0)
    INTO v_tier, v_period_start, v_period_end, v_cancel, v_pack_balance, v_pack_bought
    FROM public.subscriptions
   WHERE user_id = p_user_id AND status IN ('active', 'trialing')
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_tier IS NULL THEN v_tier := 'free'; END IF;

  IF v_tier = 'free' THEN
    SELECT first_seen_at INTO v_period_start FROM public.profiles WHERE id = p_user_id;
    v_period_start := COALESCE(v_period_start, '1970-01-01'::timestamptz);
    v_period_end := NULL;
  ELSIF v_period_start IS NULL THEN
    v_period_start := date_trunc('month', now());
  END IF;

  SELECT COALESCE(balance, 0) INTO v_bonus FROM public.bonus_credits WHERE user_id = p_user_id;

  SELECT COALESCE(SUM(credits_cost), 0) INTO v_credits_used
    FROM public.usage_logs
   WHERE user_id = p_user_id AND created_at >= v_period_start;

  -- Cap monthly usage at the allowance; over-monthly overflow is accounted in the wallet.
  v_monthly := tier_monthly_credits(v_tier);
  IF v_monthly IS NOT NULL AND v_credits_used > v_monthly THEN
    v_credits_used := v_monthly;
  END IF;

  RETURN json_build_object(
    'tier', v_tier,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'cancel_at_period_end', v_cancel,
    'credits_used', v_credits_used,
    'pack_credits', v_pack_balance,
    'pack_purchased', v_pack_bought,
    'bonus_credits', COALESCE(v_bonus, 0)
  );
END;
$$;

-- ---- tier_monthly_credits (sql/019 FINAL) ----
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

-- ---- trg_referral_engagement (sql/019) ----
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

-- Re-pin search_path on the SECURITY DEFINER functions above (CREATE OR REPLACE drops the pin; grants
-- persist). Same DO-block as sql/023. Idempotent.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.proname in (
      'add_pack_credits','get_user_credits','deplete_wallet_on_usage','credit_period_start','trg_referral_engagement')
  loop execute format('alter function %s set search_path = public, pg_temp', r.sig); end loop;
end $$;
