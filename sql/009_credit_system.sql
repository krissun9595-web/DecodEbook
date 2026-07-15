-- 009: Universal credit system migration
-- Replaces per-feature quotas with a single credit pool

-- 1. Add credits_cost to usage_logs
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS credits_cost int DEFAULT 0;

-- 2. Add pack_credits_balance to subscriptions
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pack_credits_balance int DEFAULT 0;

-- 3. Credit pack purchases audit table
CREATE TABLE IF NOT EXISTS credit_pack_purchases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES auth.users NOT NULL,
  stripe_session_id text UNIQUE,
  pack_type text NOT NULL,
  credits int NOT NULL,
  amount_cents int NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE credit_pack_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own pack purchases" ON credit_pack_purchases
  FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_credit_pack_purchases_user ON credit_pack_purchases(user_id);

-- 4. Backfill credits_cost on existing usage_logs
UPDATE usage_logs SET credits_cost = CASE
  WHEN action LIKE 'text:%' THEN 1
  WHEN action = 'chat' THEN 1
  WHEN action = 'analyzeBookStructure' THEN 6
  WHEN action IN ('extractConcepts', 'extractDictionary') THEN 2
  WHEN action IN ('extractChapterText', 'podcastScript') THEN 3
  WHEN action = 'tts' THEN 5
  WHEN action = 'generateImage' THEN 10
  WHEN action = 'podcastAudio' THEN 40
  WHEN action = 'videoSeedance' THEN 50
  WHEN action = 'videoVeo' THEN 150
  WHEN action = 'videoPrompt' THEN 1
  ELSE 1
END
WHERE credits_cost = 0 OR credits_cost IS NULL;

-- 5. Atomic pack credit increment
CREATE OR REPLACE FUNCTION add_pack_credits(p_user_id uuid, p_credits int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE subscriptions
  SET pack_credits_balance = COALESCE(pack_credits_balance, 0) + p_credits,
      updated_at = now()
  WHERE user_id = p_user_id AND status IN ('active', 'trialing');
END;
$$;

-- 6. New RPC: get_user_credits
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
    'pack_credits', v_pack_balance
  );
END;
$$;
