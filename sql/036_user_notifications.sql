-- 036: user_notifications — cross-device sync for My_Inbox state (was localStorage-only).
-- One row per user. User-owned (RLS), written by the client like user_notebook / user_settings.
--   read_ids / cleared_ids : which notif ids the user has read / cleared (union-merged across devices)
--   items                  : materialized derived notifs (bonus / 90%-usage) so they show on every device
--   bonus_seen             : last-seen bonus balance (max-merged) — so a grant notifies once, not per-device
--   usage_period           : billing period already warned at 90% — so the warning fires once per period

create table if not exists public.user_notifications (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  read_ids     text[] not null default '{}',
  cleared_ids  text[] not null default '{}',
  items        jsonb  not null default '[]',
  bonus_seen   integer,
  usage_period text,
  updated_at   timestamptz not null default now()
);

alter table public.user_notifications enable row level security;

drop policy if exists "Users manage own notifications" on public.user_notifications;
create policy "Users manage own notifications" on public.user_notifications
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
