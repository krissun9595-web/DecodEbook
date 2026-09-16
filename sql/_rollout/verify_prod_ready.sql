-- Pre-deploy readiness check for prod (run in the PROD Supabase SQL editor).
-- All four results should look right before running `npm run deploy:production`.

-- 1) migration 033 objects exist
select to_regclass('public.credit_reservations') as reservations_table;   -- expect: credit_reservations
select array_agg(proname order by proname) as reserve_fns
  from pg_proc
 where proname in ('reserve_credits','release_reservation','get_available_with_holds');
 -- expect: {get_available_with_holds,release_reservation,reserve_credits}

-- 2) usage_logs has the columns the metering/gate path needs (migrations 022 + 029)
select array_agg(column_name order by column_name) as usage_cols
  from information_schema.columns
 where table_schema='public' and table_name='usage_logs'
   and column_name in ('usage_id','model','session_id','book_title','credits_cost');
 -- expect: {book_title,credits_cost,model,session_id,usage_id}

-- 3) credit functions the reserve/gate depend on are present & current
select proname
  from pg_proc
 where proname in ('get_user_credits','tier_monthly_credits','get_user_credits'::text);
 -- expect: get_user_credits, tier_monthly_credits

-- 4) sanity: the credit RPC returns for a known account (replace with any real prod user id)
-- select public.get_user_credits('00000000-0000-0000-0000-000000000000');
