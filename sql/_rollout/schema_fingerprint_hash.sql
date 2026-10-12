-- FAST PARITY CHECK — run on BOTH prod and staging; compare the single hash each returns.
-- Same hash on both projects = byte-identical across tables/cols/constraints/indexes/function
-- BODIES/grants/policies/triggers/buckets → zero drift, done.
-- Different hash = run schema_fingerprint.sql (full) on both and diff to locate it.
-- (Identical union to schema_fingerprint.sql, wrapped in md5(string_agg).)
select md5(string_agg(sig, E'\n' order by sig)) as fingerprint_hash from (
  select 'tbl  ' || table_name                                                as sig
    from information_schema.tables
    where table_schema='public' and table_type='BASE TABLE'
  union all
  select 'rls  ' || c.relname || ' enabled=' || c.relrowsecurity::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relkind='r'
  union all
  select 'col  ' || table_name || '.' || column_name || ' :' || data_type
         || ' ' || case when is_nullable='YES' then 'null' else 'notnull' end
         || case when column_default is not null then ' =' || column_default else '' end
    from information_schema.columns where table_schema='public'
  union all
  select 'con  ' || conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid)
    from pg_constraint where connamespace = 'public'::regnamespace
  union all
  select 'idx  ' || pg_get_indexdef(i.indexrelid)
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public'
  union all
  select 'fn   ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
         || case p.provolatile when 'i' then 'imm' when 's' then 'stab' else 'vol' end || ' '
         || case when p.prosecdef then 'secdef' else 'invoker' end
         || ' md5=' || md5(pg_get_functiondef(p.oid))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public'
  union all
  select 'gexec ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> '
         || coalesce(
              (select string_agg(g, ',' order by g) from (
                 select distinct case when a.grantee = 0 then 'PUBLIC' else r.rolname end as g
                 from aclexplode(p.proacl) a
                 left join pg_roles r on r.oid = a.grantee
                 where a.privilege_type = 'EXECUTE'
               ) q),
              'PUBLIC(default)')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public'
  union all
  select 'pol  ' || schemaname || '.' || tablename || '.' || policyname
         || ' [' || cmd || '] roles(' || array_to_string(roles, ',') || ')'
         || ' U(' || coalesce(qual, '') || ') C(' || coalesce(with_check, '') || ')'
    from pg_policies where schemaname in ('public','storage')
  union all
  select 'trig ' || pg_get_triggerdef(t.oid)
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and not t.tgisinternal
  union all
  select 'buck ' || id || ' public=' || public::text from storage.buckets
) s;
