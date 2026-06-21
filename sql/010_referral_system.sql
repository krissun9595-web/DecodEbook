-- 010: Referral & sharing reward system
-- Click-based sharing rewards + activation-gated referral rewards

-- 1. Referral codes (one per user)
CREATE TABLE IF NOT EXISTS referral_codes (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own referral code" ON referral_codes
  FOR SELECT USING (auth.uid() = user_id);

-- 2. Track unique clicks on shared links
CREATE TABLE IF NOT EXISTS referral_clicks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referrer_id UUID NOT NULL REFERENCES auth.users(id),
  visitor_hash TEXT NOT NULL,
  credited BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(referrer_id, visitor_hash)
);

ALTER TABLE referral_clicks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own referral clicks" ON referral_clicks
  FOR SELECT USING (auth.uid() = referrer_id);

CREATE INDEX IF NOT EXISTS idx_referral_clicks_referrer ON referral_clicks(referrer_id);

-- 3. Track referral signups
CREATE TABLE IF NOT EXISTS referral_signups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referrer_id UUID NOT NULL REFERENCES auth.users(id),
  referred_user_id UUID UNIQUE NOT NULL REFERENCES auth.users(id),
  activated BOOLEAN DEFAULT false,
  referrer_credited BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE referral_signups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own referral signups" ON referral_signups
  FOR SELECT USING (auth.uid() = referrer_id);

CREATE INDEX IF NOT EXISTS idx_referral_signups_referrer ON referral_signups(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referral_signups_referred ON referral_signups(referred_user_id);

-- 4. Bonus credits balance (works for all users, no subscription required)
CREATE TABLE IF NOT EXISTS bonus_credits (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  balance INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bonus_credits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own bonus credits" ON bonus_credits
  FOR SELECT USING (auth.uid() = user_id);

-- 5. RPC: get or create referral code
CREATE OR REPLACE FUNCTION get_or_create_referral_code(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT code INTO v_code FROM referral_codes WHERE user_id = p_user_id;
  IF v_code IS NOT NULL THEN RETURN v_code; END IF;

  v_code := substr(md5(random()::text || p_user_id::text || now()::text), 1, 8);
  INSERT INTO referral_codes (user_id, code) VALUES (p_user_id, v_code)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT code INTO v_code FROM referral_codes WHERE user_id = p_user_id;
  RETURN v_code;
END;
$$;

-- 6. RPC: add bonus credits atomically
CREATE OR REPLACE FUNCTION add_bonus_credits(p_user_id UUID, p_credits INT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO bonus_credits (user_id, balance, updated_at)
  VALUES (p_user_id, p_credits, now())
  ON CONFLICT (user_id)
  DO UPDATE SET balance = bonus_credits.balance + p_credits, updated_at = now();
END;
$$;

-- 7. RPC: get referral stats
CREATE OR REPLACE FUNCTION get_referral_stats(p_user_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_code TEXT;
  v_clicks INT;
  v_click_credits INT;
  v_signups INT;
  v_activated INT;
  v_signup_credits INT;
  v_bonus INT;
BEGIN
  SELECT code INTO v_code FROM referral_codes WHERE user_id = p_user_id;

  SELECT COUNT(*) INTO v_clicks FROM referral_clicks
    WHERE referrer_id = p_user_id AND credited = true;
  v_click_credits := LEAST(v_clicks * 5, 50);

  SELECT COUNT(*) INTO v_signups FROM referral_signups
    WHERE referrer_id = p_user_id;
  SELECT COUNT(*) INTO v_activated FROM referral_signups
    WHERE referrer_id = p_user_id AND activated = true AND referrer_credited = true;
  v_signup_credits := v_activated * 100;

  SELECT COALESCE(balance, 0) INTO v_bonus FROM bonus_credits WHERE user_id = p_user_id;

  RETURN json_build_object(
    'code', v_code,
    'clicks', v_clicks,
    'click_credits', v_click_credits,
    'click_credits_cap', 50,
    'signups', v_signups,
    'activated', v_activated,
    'signup_credits', v_signup_credits,
    'bonus_balance', COALESCE(v_bonus, 0),
    'total_earned', v_click_credits + v_signup_credits
  );
END;
$$;

-- 8. Update get_user_credits to include bonus_credits
CREATE OR REPLACE FUNCTION get_user_credits(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tier text := 'free';
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_cancel boolean := false;
  v_pack_balance int := 0;
  v_bonus int := 0;
  v_credits_used int;
BEGIN
  SELECT tier, current_period_start, current_period_end,
         cancel_at_period_end, COALESCE(pack_credits_balance, 0)
  INTO v_tier, v_period_start, v_period_end, v_cancel, v_pack_balance
  FROM subscriptions
  WHERE user_id = p_user_id AND status IN ('active', 'trialing')
  ORDER BY created_at DESC LIMIT 1;

  IF v_tier IS NULL THEN v_tier := 'free'; END IF;
  IF v_period_start IS NULL THEN v_period_start := date_trunc('month', now()); END IF;

  SELECT COALESCE(balance, 0) INTO v_bonus FROM bonus_credits WHERE user_id = p_user_id;

  SELECT COALESCE(SUM(credits_cost), 0)
  INTO v_credits_used
  FROM usage_logs
  WHERE user_id = p_user_id AND created_at >= v_period_start;

  RETURN json_build_object(
    'tier', v_tier,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'cancel_at_period_end', v_cancel,
    'credits_used', v_credits_used,
    'pack_credits', v_pack_balance,
    'bonus_credits', COALESCE(v_bonus, 0)
  );
END;
$$;
