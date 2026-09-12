-- FUNCTION-BODY fingerprint — run on BOTH prod and staging; paste both.
-- The name-only fingerprint can't see a stale BODY (that's how get_user_credits hid). This md5s each
-- function's FULL definition (args, body, SET search_path, volatility). Same name + same md5 = identical.
-- A differing md5 = a stale/old body on prod → I'll rebuild just those from staging's source.
select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')  ' || md5(pg_get_functiondef(p.oid)) as fn_sig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname, pg_get_function_identity_arguments(p.oid);
