-- Verify tables
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('profiles', 'subscriptions', 'books', 'sessions', 'events', 'generations')
order by table_name;

-- Verify functions
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'handle_new_user', 'set_updated_at',
    'increment_book_count', 'decrement_book_count', 'increment_generation_count',
    'track_event', 'start_session', 'end_session', 'track_generation'
  )
order by routine_name;

-- Verify views
select table_name as view_name
from information_schema.views
where table_schema = 'public'
  and table_name like 'v_%'
order by table_name;
