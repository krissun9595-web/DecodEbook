-- Phase B policy check that works IN THE SQL EDITOR (reads pg_catalog, not subject to RLS).
-- The earlier "insert a credit row" test does NOT work in the editor: the editor runs as a
-- privileged role that BYPASSES RLS and auth.uid() is null, so the insert always succeeds there.
-- These queries confirm the policy STATE directly instead.

-- 1) The INSERT policy on usage_logs. EXPECT exactly ONE row:
--      policyname = 'Users insert own zero-credit logs'
--      with_check contains  (auth.uid() = user_id) AND (credits_cost = 0)
--    and NO row named 'Users insert own logs' (the old permissive policy must be gone).
select policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'usage_logs' and cmd = 'INSERT';

-- 2) Clean up the junk test row the editor insert created (user_id null, credits 5).
--    Review first:
select id, user_id, action, credits_cost, model, created_at
from usage_logs
where action = 'chat' and credits_cost = 5 and model = 'gemini-3.1-pro-preview'
order by created_at desc
limit 5;

-- Then delete it (tightly scoped so it can't touch a real charge — real rows never have null user_id):
delete from usage_logs
where action = 'chat' and credits_cost = 5 and model = 'gemini-3.1-pro-preview'
  and user_id is null;
