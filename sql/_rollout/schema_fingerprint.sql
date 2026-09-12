-- SCHEMA FINGERPRINT — run on BOTH the prod and the staging Supabase project.
-- Paste each project's FULL output back, labeled. One sorted signature per line → mechanical diff.
select sig from (
  select 'tbl  ' || table_name                                              as sig
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  union all
  select 'col  ' || table_name || '.' || column_name || ' :' || data_type
    from information_schema.columns where table_schema = 'public'
  union all
  select distinct 'fn   ' || p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  union all
  select 'pol  ' || tablename || '.' || policyname || ' [' || cmd || ']'
    from pg_policies where schemaname = 'public'
  union all
  select 'buck ' || id from storage.buckets
) s
order by sig;
