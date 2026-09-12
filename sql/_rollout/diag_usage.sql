-- PROD usage_logs diagnostic — run in the prod Supabase SQL editor, paste all 3 results back.

-- (A) Which columns exist on usage_logs? (worker writes: user_id, action, credits_cost, cost_cents,
--     model, tokens_used, input_tokens, output_tokens, usage_id, book_title, session_id)
select string_agg(column_name, ', ' order by ordinal_position) as usage_logs_columns
from information_schema.columns
where table_schema = 'public' and table_name = 'usage_logs';

-- (B) Any consumption rows in the last day? (safe columns only)
select created_at, action, credits_cost, model
from public.usage_logs
where created_at > now() - interval '1 day'
order by created_at desc
limit 30;

-- (C) Is the 025 lockdown policy in place? (tells us whether the client can still write)
select policyname, cmd, with_check::text
from pg_policies
where schemaname = 'public' and tablename = 'usage_logs' and cmd = 'INSERT';
