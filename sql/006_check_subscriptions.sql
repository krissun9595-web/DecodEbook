-- Check what columns the subscriptions table currently has
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'subscriptions'
order by ordinal_position;
