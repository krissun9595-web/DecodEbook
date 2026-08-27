-- ===== Phase 3: live index inventory (READ-ONLY) =====
-- One json blob. Paste it back to author the redundant-index cleanup migration.
-- We want to spot: duplicate indexes (same table+columns, different names),
-- and indexes that duplicate a UNIQUE/PK constraint's implicit index.

select json_build_object(
  'indexes', (
    select json_agg(json_build_object(
      't', tablename, 'index', indexname, 'def', indexdef)
      order by tablename, indexname)
    from pg_indexes
    where schemaname = 'public'
  )
) as phase3;
