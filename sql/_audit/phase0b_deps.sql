-- ===== Phase 0b: dependency check before dropping books (READ-ONLY) =====
-- One json blob again. Paste it back.

select json_build_object(

  -- View definitions (does any view reference books / dead columns?)
  'views', (
    select json_agg(json_build_object('view', c.relname, 'def', pg_get_viewdef(c.oid, true))
      order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='v'
  ),

  -- Triggers per table (what fires on books, and elsewhere)
  'triggers', (
    select json_agg(json_build_object(
      't', c.relname, 'trigger', t.tgname,
      'fn', p.proname, 'def', pg_get_triggerdef(t.oid))
      order by c.relname, t.tgname)
    from pg_trigger t
    join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    join pg_proc p on p.oid=t.tgfoid
    where n.nspname='public' and not t.tgisinternal
  ),

  -- Anything in pg_depend referencing books (belt-and-suspenders)
  'books_dependents', (
    select json_agg(distinct dc.relname)
    from pg_depend d
    join pg_class bc on bc.oid=d.refobjid
    join pg_class dc on dc.oid=d.objid
    where bc.relname='books' and dc.relname <> 'books'
  )

) as phase0b;
