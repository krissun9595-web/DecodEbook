-- ===== Phase 0: live schema reconciliation (READ-ONLY) =====
-- Run in the Supabase SQL editor (or: psql "$SUPABASE_DB_URL" -f this_file).
-- Nothing is modified. Returns ONE row / ONE json column with every section,
-- because the SQL editor only shows the last statement's result.
-- Click the cell, copy, and paste the whole JSON back.

select json_build_object(

  -- 1. All tables + row counts (which "dead" tables are truly empty)
  'tables', (
    select json_agg(json_build_object('table', s.table_name, 'rows', s.rc) order by s.table_name)
    from (
      select t.table_name,
        (xpath('/row/c/text()',
          query_to_xml(format('select count(*) c from public.%I', t.table_name),
                       false, true, '')))[1]::text::bigint as rc
      from information_schema.tables t
      where t.table_schema='public' and t.table_type='BASE TABLE'
    ) s
  ),

  -- 2. Every column (diff against the 12 repo files)
  'columns', (
    select json_agg(json_build_object(
      't', table_name, 'pos', ordinal_position, 'col', column_name,
      'type', data_type, 'nullable', is_nullable, 'default', column_default)
      order by table_name, ordinal_position)
    from information_schema.columns where table_schema='public'
  ),

  -- 3. Constraints on the tables that disagree across repo files
  'constraints', (
    select json_agg(json_build_object(
      't', tc.table_name, 'type', tc.constraint_type,
      'name', tc.constraint_name, 'check', cc.check_clause))
    from information_schema.table_constraints tc
    left join information_schema.check_constraints cc using (constraint_name, constraint_schema)
    where tc.table_schema='public'
      and tc.table_name in ('subscriptions','usage_logs','user_books','events','generations')
  ),

  -- 4. Foreign keys (confirms books FKs really are gone, book_id is text)
  'foreign_keys', (
    select json_agg(json_build_object(
      't', tc.table_name, 'col', kcu.column_name,
      'ref_table', ccu.table_name, 'ref_col', ccu.column_name))
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu using (constraint_name, constraint_schema)
    join information_schema.constraint_column_usage ccu using (constraint_name, constraint_schema)
    where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public'
  ),

  -- 5. Functions (catches the duplicate get_user_credits + track_* signatures)
  'functions', (
    select json_agg(json_build_object(
      'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid)))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
  ),

  -- 6. RLS actually ENABLED per table (policies are moot if this is false)
  'rls', (
    select json_agg(json_build_object('t', c.relname, 'enabled', c.relrowsecurity)
      order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r'
  )

) as phase0;
