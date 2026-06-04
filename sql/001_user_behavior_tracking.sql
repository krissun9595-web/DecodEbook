-- ============================================================
-- DecodEbook: User Behavior Tracking Schema
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- 0. Extensions
create extension if not exists "pgcrypto";

-- ============================================================
-- 1. PROFILES
-- ============================================================
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  avatar_url    text,
  locale        text,
  timezone      text,
  device_fingerprint text,
  first_seen_at   timestamptz not null default now(),
  last_active_at  timestamptz not null default now(),
  total_books_uploaded int not null default 0,
  total_generations    int not null default 0
);

comment on table public.profiles is 'Extended user profile, linked 1:1 to auth.users';

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS
alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- ============================================================
-- 2. SUBSCRIPTIONS
-- ============================================================
create table public.subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  stripe_customer_id      text,
  stripe_subscription_id  text unique,
  plan                    text not null default 'free'
                          check (plan in ('free', 'pro', 'team')),
  status                  text not null default 'active'
                          check (status in ('active', 'canceled', 'past_due', 'trialing', 'incomplete')),
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.subscriptions is 'Stripe subscription state, writable only via service role / webhooks';

create index idx_subscriptions_user on public.subscriptions(user_id);
create index idx_subscriptions_stripe on public.subscriptions(stripe_customer_id);

-- RLS: users can read own, only service role can write
alter table public.subscriptions enable row level security;

create policy "Users can view own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ============================================================
-- 3. BOOKS
-- ============================================================
create table public.books (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  title           text,
  author          text,
  language        text,
  file_size_bytes bigint,
  chapter_count   int,
  word_count      int,
  uploaded_at     timestamptz not null default now()
);

comment on table public.books is 'Every ebook uploaded by a user';

create index idx_books_user on public.books(user_id, uploaded_at desc);

alter table public.books enable row level security;

create policy "Users can view own books"
  on public.books for select
  using (auth.uid() = user_id);

create policy "Users can insert own books"
  on public.books for insert
  with check (auth.uid() = user_id);

create policy "Users can delete own books"
  on public.books for delete
  using (auth.uid() = user_id);

-- Increment counter on profiles
create or replace function public.increment_book_count()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.profiles
    set total_books_uploaded = total_books_uploaded + 1
  where id = new.user_id;
  return new;
end;
$$;

create trigger on_book_uploaded
  after insert on public.books
  for each row execute function public.increment_book_count();

-- Decrement on delete
create or replace function public.decrement_book_count()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.profiles
    set total_books_uploaded = greatest(total_books_uploaded - 1, 0)
  where id = old.user_id;
  return old;
end;
$$;

create trigger on_book_deleted
  after delete on public.books
  for each row execute function public.decrement_book_count();

-- ============================================================
-- 4. SESSIONS
-- ============================================================
create table public.sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references public.profiles(id) on delete set null,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_seconds int,
  device_type      text check (device_type in ('mobile', 'tablet', 'desktop')),
  os               text,
  browser          text,
  screen_width     int,
  screen_height    int,
  referrer         text,
  is_pwa           boolean default false
);

comment on table public.sessions is 'Visit sessions for engagement metrics';

create index idx_sessions_user on public.sessions(user_id, started_at desc);

alter table public.sessions enable row level security;

create policy "Users can view own sessions"
  on public.sessions for select
  using (auth.uid() = user_id);

create policy "Users can insert own sessions"
  on public.sessions for insert
  with check (auth.uid() = user_id);

create policy "Users can update own sessions"
  on public.sessions for update
  using (auth.uid() = user_id);

-- ============================================================
-- 5. EVENTS (core analytics table)
-- ============================================================
create table public.events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles(id) on delete set null,
  session_id    uuid references public.sessions(id) on delete set null,
  event_type    text not null,
  event_action  text not null,
  book_id       uuid references public.books(id) on delete set null,
  chapter_index int,
  metadata      jsonb default '{}',
  created_at    timestamptz not null default now()
);

comment on table public.events is 'Append-only event log for all user actions';

-- Performance indexes
create index idx_events_user_time    on public.events(user_id, created_at desc);
create index idx_events_type_action  on public.events(event_type, event_action, created_at desc);
create index idx_events_session      on public.events(session_id);
create index idx_events_book         on public.events(book_id) where book_id is not null;
create index idx_events_created_brin on public.events using brin(created_at);
create index idx_events_metadata     on public.events using gin(metadata);

-- RLS: users can only INSERT their own events, no select/update/delete from client
alter table public.events enable row level security;

create policy "Users can insert own events"
  on public.events for insert
  with check (auth.uid() = user_id);

-- ============================================================
-- 6. GENERATIONS
-- ============================================================
create table public.generations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  book_id             uuid references public.books(id) on delete set null,
  chapter_index       int,
  module              text not null
                      check (module in ('voice', 'podcast', 'video', 'visualizer', 'mind_map')),
  provider            text,
  model               text,
  input_chars         int,
  output_duration_ms  int,
  estimated_cost_usd  numeric(10,6),
  status              text not null default 'success'
                      check (status in ('success', 'failed', 'canceled')),
  error_message       text,
  created_at          timestamptz not null default now()
);

comment on table public.generations is 'Denormalized generation log for cost tracking and quota enforcement';

create index idx_generations_user   on public.generations(user_id, created_at desc);
create index idx_generations_module on public.generations(module, created_at desc);
create index idx_generations_book   on public.generations(book_id) where book_id is not null;

alter table public.generations enable row level security;

create policy "Users can view own generations"
  on public.generations for select
  using (auth.uid() = user_id);

create policy "Users can insert own generations"
  on public.generations for insert
  with check (auth.uid() = user_id);

-- Increment counter on profiles
create or replace function public.increment_generation_count()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.status = 'success' then
    update public.profiles
      set total_generations = total_generations + 1
    where id = new.user_id;
  end if;
  return new;
end;
$$;

create trigger on_generation_created
  after insert on public.generations
  for each row execute function public.increment_generation_count();

-- ============================================================
-- 7. ANALYTICS VIEWS (run with service_role)
-- ============================================================

-- Daily active users
create or replace view public.v_daily_active_users as
select
  date_trunc('day', created_at)::date as day,
  count(distinct user_id) as dau
from public.events
where user_id is not null
group by 1
order by 1 desc;

-- Events per module per day
create or replace view public.v_daily_events_by_module as
select
  date_trunc('day', created_at)::date as day,
  event_type,
  event_action,
  count(*) as event_count,
  count(distinct user_id) as unique_users
from public.events
group by 1, 2, 3
order by 1 desc, 4 desc;

-- Generation stats per module
create or replace view public.v_generation_stats as
select
  module,
  status,
  count(*) as total,
  avg(input_chars) as avg_input_chars,
  avg(output_duration_ms) as avg_output_ms,
  sum(estimated_cost_usd) as total_cost_usd
from public.generations
group by 1, 2
order by 3 desc;

-- User engagement summary
create or replace view public.v_user_engagement as
select
  p.id as user_id,
  p.email,
  p.first_seen_at,
  p.last_active_at,
  p.total_books_uploaded,
  p.total_generations,
  count(distinct s.id) as total_sessions,
  coalesce(avg(s.duration_seconds), 0) as avg_session_duration,
  count(distinct e.id) as total_events,
  max(e.created_at) as last_event_at
from public.profiles p
left join public.sessions s on s.user_id = p.id
left join public.events e on e.user_id = p.id
group by p.id, p.email, p.first_seen_at, p.last_active_at,
         p.total_books_uploaded, p.total_generations;

-- Feature adoption: which modules have users tried
create or replace view public.v_feature_adoption as
select
  user_id,
  array_agg(distinct module) as modules_used,
  count(distinct module) as module_count,
  min(created_at) as first_generation,
  max(created_at) as last_generation
from public.generations
where status = 'success'
group by user_id;

-- Funnel: upload → first generation → share
create or replace view public.v_user_funnel as
select
  p.id as user_id,
  p.first_seen_at as signed_up_at,
  (select min(uploaded_at) from public.books b where b.user_id = p.id) as first_upload_at,
  (select min(created_at) from public.generations g where g.user_id = p.id and g.status = 'success') as first_generation_at,
  (select min(created_at) from public.events e where e.user_id = p.id and e.event_type = 'share') as first_share_at
from public.profiles p;

-- ============================================================
-- 8. HELPER FUNCTIONS
-- ============================================================

-- Track event (callable from client via supabase.rpc)
create or replace function public.track_event(
  p_session_id    uuid,
  p_event_type    text,
  p_event_action  text,
  p_book_id       uuid default null,
  p_chapter_index int default null,
  p_metadata      jsonb default '{}'
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_event_id uuid;
begin
  insert into public.events (user_id, session_id, event_type, event_action, book_id, chapter_index, metadata)
  values (auth.uid(), p_session_id, p_event_type, p_event_action, p_book_id, p_chapter_index, p_metadata)
  returning id into v_event_id;

  -- Bump last_active_at
  update public.profiles set last_active_at = now() where id = auth.uid();

  return v_event_id;
end;
$$;

comment on function public.track_event is 'Client-callable RPC to log a user event and update last_active_at';

-- Start session
create or replace function public.start_session(
  p_device_type  text default null,
  p_os           text default null,
  p_browser      text default null,
  p_screen_width int default null,
  p_screen_height int default null,
  p_referrer     text default null,
  p_is_pwa       boolean default false
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_session_id uuid;
begin
  insert into public.sessions (user_id, device_type, os, browser, screen_width, screen_height, referrer, is_pwa)
  values (auth.uid(), p_device_type, p_os, p_browser, p_screen_width, p_screen_height, p_referrer, p_is_pwa)
  returning id into v_session_id;

  update public.profiles set last_active_at = now() where id = auth.uid();

  return v_session_id;
end;
$$;

-- End session
create or replace function public.end_session(p_session_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.sessions
    set ended_at = now(),
        duration_seconds = extract(epoch from (now() - started_at))::int
  where id = p_session_id
    and user_id = auth.uid();
end;
$$;

-- Record generation (callable from client)
create or replace function public.track_generation(
  p_book_id          uuid,
  p_chapter_index    int,
  p_module           text,
  p_provider         text,
  p_model            text,
  p_input_chars      int,
  p_output_duration_ms int default null,
  p_estimated_cost   numeric default null,
  p_status           text default 'success',
  p_error_message    text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_gen_id uuid;
begin
  insert into public.generations (
    user_id, book_id, chapter_index, module, provider, model,
    input_chars, output_duration_ms, estimated_cost_usd, status, error_message
  ) values (
    auth.uid(), p_book_id, p_chapter_index, p_module, p_provider, p_model,
    p_input_chars, p_output_duration_ms, p_estimated_cost, p_status, p_error_message
  )
  returning id into v_gen_id;

  return v_gen_id;
end;
$$;
