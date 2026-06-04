-- 1. Backfill profiles for existing auth.users who don't have one yet
insert into public.profiles (id, email, display_name, avatar_url, first_seen_at)
select
  u.id,
  u.email,
  coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
  u.raw_user_meta_data ->> 'avatar_url',
  u.created_at
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

-- 2. Add missing columns to user_settings (if they don't exist)
alter table public.user_settings
  add column if not exists image_model text,
  add column if not exists video_model text;
