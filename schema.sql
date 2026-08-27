-- DecodEbook consolidated schema — single source of truth. Reflects live production as of 2026-08-26 after migration sql/012. Supersedes supabase-schema.sql + sql/000-012.
--
-- Run order (top-to-bottom on a fresh database):
--   extensions -> tables -> indexes -> functions -> triggers -> views -> RLS/policies -> grants
--
-- NOTE: public.books is intentionally absent (dropped in sql/012). Its triggers
-- (on_book_uploaded/on_book_deleted), functions (increment_book_count/
-- decrement_book_count), and index (idx_books_user) are likewise omitted.
-- events.book_id and generations.book_id are TEXT with NO foreign key (post sql/005).
-- profiles has no locale/timezone/device_fingerprint columns (dropped in sql/012).

-- ============================================================
-- EXTENSIONS
-- ============================================================
create extension if not exists "pgcrypto";

-- ===== TABLES =====

-- ------------------------------------------------------------
-- 1. profiles  (post-012: locale/timezone/device_fingerprint dropped)
-- ------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  avatar_url    text,
  first_seen_at   timestamptz not null default now(),
  last_active_at  timestamptz not null default now(),
  total_books_uploaded int not null default 0,
  total_generations    int not null default 0
);

comment on table public.profiles is 'Extended user profile, linked 1:1 to auth.users';

-- ------------------------------------------------------------
-- 2. subscriptions  (sql/001 profiles-FK uuid version + migrations 004/008/009)
-- ------------------------------------------------------------
create table public.subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  stripe_customer_id      text,
  stripe_subscription_id  text unique,
  stripe_price_id         text,
  tier                    text not null default 'free'
                          check (tier in ('free', 'pro', 'byok', 'unlimited')),
  status                  text not null default 'active'
                          check (status in ('active', 'canceled', 'past_due', 'trialing', 'incomplete')),
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  pack_credits_balance    int default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.subscriptions is 'Stripe subscription state, writable only via service role / webhooks';

-- ------------------------------------------------------------
-- 3. usage_logs  (sql/001 + migrations 008/009)
-- ------------------------------------------------------------
create table public.usage_logs (
  id            bigint generated always as identity primary key,
  user_id       uuid references auth.users,
  action        text,
  tokens_used   int default 0,
  input_tokens  int default 0,
  output_tokens int default 0,
  cost_cents    int default 0,
  credits_cost  int default 0,
  created_at    timestamptz default now()
);

-- ------------------------------------------------------------
-- 4. user_settings  (supabase-schema.sql + migrations 003/011: all 4 model columns)
-- ------------------------------------------------------------
create table public.user_settings (
  user_id         uuid references auth.users primary key,
  gemini_key      text,
  openrouter_key  text,
  target_language text default 'Original',
  highlight_color text default 'indigo',
  text_size       text default 'base',
  line_height     text default 'normal',
  letter_spacing  text default 'normal',
  font            text default 'Inter',
  llm_model       text,
  tts_model       text,
  image_model     text,
  video_model     text,
  updated_at      timestamptz default now()
);

-- ------------------------------------------------------------
-- 5. user_books  (sql/007)
-- ------------------------------------------------------------
create table public.user_books (
  id           text not null,
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text not null,
  author       text not null default 'Unknown Author',
  chapters     jsonb not null default '[]',
  bookmarks    jsonb not null default '[]',
  content      text,
  mime_type    text not null default 'text/plain',
  is_text      boolean not null default true,
  upload_date  bigint not null,
  updated_at   timestamptz not null default now(),
  primary key (id, user_id)
);

-- ------------------------------------------------------------
-- 6. user_notebook  (sql/007)
-- ------------------------------------------------------------
create table public.user_notebook (
  id              text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  text            text not null,
  type            text not null check (type in ('word', 'phrase', 'sentence')),
  definition      text,
  timestamp       bigint not null,
  source_chapter  text,
  book_title      text,
  book_author     text,
  comment         text,
  context_source  text,
  updated_at      timestamptz not null default now(),
  primary key (id, user_id)
);

-- ------------------------------------------------------------
-- 7. user_reading_state  (sql/007)
-- ------------------------------------------------------------
create table public.user_reading_state (
  user_id         uuid not null references auth.users(id) on delete cascade,
  book_id         text not null,
  active_chapter_id int,
  updated_at      timestamptz not null default now(),
  primary key (user_id, book_id)
);

-- ------------------------------------------------------------
-- 8. sessions  (sql/001)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 9. events  (sql/001; post-005: book_id is text, no FK to books)
-- ------------------------------------------------------------
create table public.events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles(id) on delete set null,
  session_id    uuid references public.sessions(id) on delete set null,
  event_type    text not null,
  event_action  text not null,
  book_id       text,
  chapter_index int,
  metadata      jsonb default '{}',
  created_at    timestamptz not null default now()
);

comment on table public.events is 'Append-only event log for all user actions';

-- ------------------------------------------------------------
-- 10. generations  (sql/001; post-005: book_id is text, no FK to books)
-- ------------------------------------------------------------
create table public.generations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  book_id             text,
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

-- ------------------------------------------------------------
-- 11. referral_codes  (sql/010)
-- ------------------------------------------------------------
create table public.referral_codes (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 12. referral_clicks  (sql/010)
-- ------------------------------------------------------------
create table public.referral_clicks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referrer_id UUID NOT NULL REFERENCES auth.users(id),
  visitor_hash TEXT NOT NULL,
  credited BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(referrer_id, visitor_hash)
);

-- ------------------------------------------------------------
-- 13. referral_signups  (sql/010)
-- ------------------------------------------------------------
create table public.referral_signups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referrer_id UUID NOT NULL REFERENCES auth.users(id),
  referred_user_id UUID UNIQUE NOT NULL REFERENCES auth.users(id),
  activated BOOLEAN DEFAULT false,
  referrer_credited BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 14. bonus_credits  (sql/010)
-- ------------------------------------------------------------
create table public.bonus_credits (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  balance INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 15. credit_pack_purchases  (sql/009)
-- ------------------------------------------------------------
create table public.credit_pack_purchases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES auth.users NOT NULL,
  stripe_session_id text UNIQUE,
  pack_type text NOT NULL,
  credits int NOT NULL,
  amount_cents int NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- ===== INDEXES =====

-- subscriptions  (one index per column; stripe_subscription_id already has a
-- unique index from its UNIQUE constraint, so no separate index for it)
create index if not exists idx_subscriptions_user   on public.subscriptions(user_id);
create index if not exists idx_subscriptions_stripe on public.subscriptions(stripe_customer_id);

-- user_books / user_notebook
create index idx_user_books_user on public.user_books(user_id);
create index idx_user_notebook_user on public.user_notebook(user_id);

-- sessions
create index idx_sessions_user on public.sessions(user_id, started_at desc);

-- events
create index idx_events_user_time    on public.events(user_id, created_at desc);
create index idx_events_type_action  on public.events(event_type, event_action, created_at desc);
create index idx_events_session      on public.events(session_id);
create index idx_events_book         on public.events(book_id) where book_id is not null;
create index idx_events_created_brin on public.events using brin(created_at);
create index idx_events_metadata     on public.events using gin(metadata);

-- generations
create index idx_generations_user   on public.generations(user_id, created_at desc);
create index idx_generations_module on public.generations(module, created_at desc);
create index idx_generations_book   on public.generations(book_id) where book_id is not null;

-- credit_pack_purchases
create index if not exists idx_credit_pack_purchases_user on public.credit_pack_purchases(user_id);

-- referral_*  (no idx on referral_signups.referred_user_id — the UNIQUE
-- constraint referral_signups_referred_user_id_key already indexes it)
create index if not exists idx_referral_clicks_referrer on public.referral_clicks(referrer_id);
create index if not exists idx_referral_signups_referrer on public.referral_signups(referrer_id);

-- ===== FUNCTIONS =====

-- ------------------------------------------------------------
-- set_updated_at  (sql/001)
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- handle_new_user  (sql/001)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- increment_generation_count  (sql/001)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- start_session  (sql/001)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- end_session  (sql/001)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- track_event  (sql/005: text book_id)
-- ------------------------------------------------------------
create or replace function public.track_event(
  p_session_id    uuid,
  p_event_type    text,
  p_event_action  text,
  p_book_id       text default null,
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

  update public.profiles set last_active_at = now() where id = auth.uid();

  return v_event_id;
end;
$$;

comment on function public.track_event is 'Client-callable RPC to log a user event and update last_active_at';

-- ------------------------------------------------------------
-- track_generation  (sql/005: text book_id)
-- ------------------------------------------------------------
create or replace function public.track_generation(
  p_book_id          text,
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

-- ------------------------------------------------------------
-- get_user_tier_and_usage  (sql/008: chat separated from text)
-- ------------------------------------------------------------
create or replace function get_user_tier_and_usage(p_user_id uuid)
returns json
language plpgsql
security definer
as $$
declare
  v_tier text := 'free';
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_cancel boolean := false;
  v_text_count int;
  v_tts_count int;
  v_image_count int;
  v_video_count int;
  v_chat_count int;
begin
  select tier, current_period_start, current_period_end, cancel_at_period_end
    into v_tier, v_period_start, v_period_end, v_cancel
  from subscriptions
  where user_id = p_user_id and status in ('active', 'trialing')
  order by created_at desc limit 1;

  if v_tier is null then v_tier := 'free'; end if;
  if v_period_start is null then v_period_start := date_trunc('month', now()); end if;

  select
    coalesce(sum(case when action like 'text:%' or action in (
      'analyzeBookStructure','extractChapterText','extractConcepts',
      'extractDictionary','podcastScript','videoPrompt'
    ) then 1 else 0 end), 0),
    coalesce(sum(case when action in ('tts','podcastAudio') then 1 else 0 end), 0),
    coalesce(sum(case when action = 'generateImage' then 1 else 0 end), 0),
    coalesce(sum(case when action in ('videoVeo','videoSeedance') then 1 else 0 end), 0),
    coalesce(sum(case when action = 'chat' then 1 else 0 end), 0)
  into v_text_count, v_tts_count, v_image_count, v_video_count, v_chat_count
  from usage_logs
  where user_id = p_user_id and created_at >= v_period_start;

  return json_build_object(
    'tier', v_tier,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'cancel_at_period_end', v_cancel,
    'text_used', v_text_count,
    'tts_used', v_tts_count,
    'image_used', v_image_count,
    'video_used', v_video_count,
    'chat_used', v_chat_count
  );
end;
$$;

-- ------------------------------------------------------------
-- add_pack_credits  (sql/009)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION add_pack_credits(p_user_id uuid, p_credits int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE subscriptions
  SET pack_credits_balance = COALESCE(pack_credits_balance, 0) + p_credits,
      updated_at = now()
  WHERE user_id = p_user_id AND status IN ('active', 'trialing');
END;
$$;

-- ------------------------------------------------------------
-- get_user_credits  (sql/010 version — includes bonus_credits; supersedes sql/009)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_user_credits(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tier text := 'free';
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_cancel boolean := false;
  v_pack_balance int := 0;
  v_bonus int := 0;
  v_credits_used int;
BEGIN
  SELECT tier, current_period_start, current_period_end,
         cancel_at_period_end, COALESCE(pack_credits_balance, 0)
  INTO v_tier, v_period_start, v_period_end, v_cancel, v_pack_balance
  FROM subscriptions
  WHERE user_id = p_user_id AND status IN ('active', 'trialing')
  ORDER BY created_at DESC LIMIT 1;

  IF v_tier IS NULL THEN v_tier := 'free'; END IF;
  IF v_period_start IS NULL THEN v_period_start := date_trunc('month', now()); END IF;

  SELECT COALESCE(balance, 0) INTO v_bonus FROM bonus_credits WHERE user_id = p_user_id;

  SELECT COALESCE(SUM(credits_cost), 0)
  INTO v_credits_used
  FROM usage_logs
  WHERE user_id = p_user_id AND created_at >= v_period_start;

  RETURN json_build_object(
    'tier', v_tier,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'cancel_at_period_end', v_cancel,
    'credits_used', v_credits_used,
    'pack_credits', v_pack_balance,
    'bonus_credits', COALESCE(v_bonus, 0)
  );
END;
$$;

-- ------------------------------------------------------------
-- get_or_create_referral_code  (sql/010)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_or_create_referral_code(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT code INTO v_code FROM referral_codes WHERE user_id = p_user_id;
  IF v_code IS NOT NULL THEN RETURN v_code; END IF;

  v_code := substr(md5(random()::text || p_user_id::text || now()::text), 1, 8);
  INSERT INTO referral_codes (user_id, code) VALUES (p_user_id, v_code)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT code INTO v_code FROM referral_codes WHERE user_id = p_user_id;
  RETURN v_code;
END;
$$;

-- ------------------------------------------------------------
-- add_bonus_credits  (sql/010)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION add_bonus_credits(p_user_id UUID, p_credits INT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO bonus_credits (user_id, balance, updated_at)
  VALUES (p_user_id, p_credits, now())
  ON CONFLICT (user_id)
  DO UPDATE SET balance = bonus_credits.balance + p_credits, updated_at = now();
END;
$$;

-- ------------------------------------------------------------
-- get_referral_stats  (sql/010)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_referral_stats(p_user_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_code TEXT;
  v_clicks INT;
  v_click_credits INT;
  v_signups INT;
  v_activated INT;
  v_signup_credits INT;
  v_bonus INT;
BEGIN
  SELECT code INTO v_code FROM referral_codes WHERE user_id = p_user_id;

  SELECT COUNT(*) INTO v_clicks FROM referral_clicks
    WHERE referrer_id = p_user_id AND credited = true;
  v_click_credits := LEAST(v_clicks * 5, 50);

  SELECT COUNT(*) INTO v_signups FROM referral_signups
    WHERE referrer_id = p_user_id;
  SELECT COUNT(*) INTO v_activated FROM referral_signups
    WHERE referrer_id = p_user_id AND activated = true AND referrer_credited = true;
  v_signup_credits := v_activated * 100;

  SELECT COALESCE(balance, 0) INTO v_bonus FROM bonus_credits WHERE user_id = p_user_id;

  RETURN json_build_object(
    'code', v_code,
    'clicks', v_clicks,
    'click_credits', v_click_credits,
    'click_credits_cap', 50,
    'signups', v_signups,
    'activated', v_activated,
    'signup_credits', v_signup_credits,
    'bonus_balance', COALESCE(v_bonus, 0),
    'total_earned', v_click_credits + v_signup_credits
  );
END;
$$;

-- ===== TRIGGERS =====

-- handle_new_user on auth.users
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- set_updated_at BEFORE UPDATE
create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

create trigger user_books_updated_at
  before update on public.user_books
  for each row execute function public.set_updated_at();

create trigger user_notebook_updated_at
  before update on public.user_notebook
  for each row execute function public.set_updated_at();

create trigger user_reading_state_updated_at
  before update on public.user_reading_state
  for each row execute function public.set_updated_at();

-- increment_generation_count AFTER INSERT
create trigger on_generation_created
  after insert on public.generations
  for each row execute function public.increment_generation_count();

-- ===== VIEWS =====

-- Daily active users  (sql/001)
create or replace view public.v_daily_active_users as
select
  date_trunc('day', created_at)::date as day,
  count(distinct user_id) as dau
from public.events
where user_id is not null
group by 1
order by 1 desc;

-- Events per module per day  (sql/001)
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

-- Generation stats per module  (sql/001)
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

-- User engagement summary  (sql/001)
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

-- Feature adoption  (sql/001)
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

-- Funnel  (sql/012: re-pointed off dropped books onto user_books)
create view public.v_user_funnel as
  select p.id as user_id, p.first_seen_at as signed_up_at,
    (select min(to_timestamp(ub.upload_date/1000.0)) from public.user_books ub where ub.user_id=p.id) as first_upload_at,
    (select min(g.created_at) from public.generations g where g.user_id=p.id and g.status='success') as first_generation_at,
    (select min(e.created_at) from public.events e where e.user_id=p.id and e.event_type='share') as first_share_at
  from public.profiles p;

-- ===== RLS =====

-- profiles
alter table public.profiles enable row level security;
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- subscriptions (SELECT only for users; writes via service role)
alter table public.subscriptions enable row level security;
create policy "Users can view own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- usage_logs
alter table public.usage_logs enable row level security;
create policy "Users read own logs" on public.usage_logs
  for select using (auth.uid() = user_id);
create policy "Users insert own logs" on public.usage_logs
  for insert with check (auth.uid() = user_id);

-- user_settings (ALL)
alter table public.user_settings enable row level security;
create policy "Users manage own settings" on public.user_settings
  for all using (auth.uid() = user_id);

-- user_books (ALL)
alter table public.user_books enable row level security;
create policy "Users can manage own books"
  on public.user_books for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- user_notebook (ALL)
alter table public.user_notebook enable row level security;
create policy "Users can manage own notebook"
  on public.user_notebook for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- user_reading_state (ALL)
alter table public.user_reading_state enable row level security;
create policy "Users can manage own reading state"
  on public.user_reading_state for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- sessions
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

-- events (INSERT only from client)
alter table public.events enable row level security;
create policy "Users can insert own events"
  on public.events for insert
  with check (auth.uid() = user_id);

-- generations
alter table public.generations enable row level security;
create policy "Users can view own generations"
  on public.generations for select
  using (auth.uid() = user_id);
create policy "Users can insert own generations"
  on public.generations for insert
  with check (auth.uid() = user_id);

-- credit_pack_purchases (SELECT only)
alter table public.credit_pack_purchases enable row level security;
create policy "Users read own pack purchases" on public.credit_pack_purchases
  for select using (auth.uid() = user_id);

-- referral_codes (SELECT only)
alter table public.referral_codes enable row level security;
create policy "Users read own referral code" on public.referral_codes
  for select using (auth.uid() = user_id);

-- referral_clicks (SELECT only)
alter table public.referral_clicks enable row level security;
create policy "Users read own referral clicks" on public.referral_clicks
  for select using (auth.uid() = referrer_id);

-- referral_signups (SELECT only)
alter table public.referral_signups enable row level security;
create policy "Users read own referral signups" on public.referral_signups
  for select using (auth.uid() = referrer_id);

-- bonus_credits (SELECT only)
alter table public.bonus_credits enable row level security;
create policy "Users read own bonus credits" on public.bonus_credits
  for select using (auth.uid() = user_id);

-- ===== INDEXES/GRANTS =====
-- (No explicit GRANT statements exist in the repo source files; access is governed
--  entirely by RLS policies above plus Supabase's default role grants. All index
--  DDL is defined in the INDEXES section above, adjacent to its table.
--  idx_books_user is intentionally omitted — it was dropped with public.books.)
