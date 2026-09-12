-- Run on STAGING. Paste BOTH rows' full text back. These are the 2 functions whose bodies still differ
-- from prod after 032 — staging is the source of truth for them (no file reproduces staging's md5).
select 'add_pack_credits' as fn, pg_get_functiondef('public.add_pack_credits(uuid,integer)'::regprocedure) as def
union all
select 'deplete_wallet_on_usage' as fn, pg_get_functiondef('public.deplete_wallet_on_usage()'::regprocedure) as def;
