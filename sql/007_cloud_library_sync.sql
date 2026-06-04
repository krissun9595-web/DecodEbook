-- ============================================================
-- Cloud Library Sync: Phase 1 (text-only, lightweight)
-- ============================================================

-- 1. USER_BOOKS — book metadata + parsed text content
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

create index idx_user_books_user on public.user_books(user_id);

alter table public.user_books enable row level security;

create policy "Users can manage own books"
  on public.user_books for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create trigger user_books_updated_at
  before update on public.user_books
  for each row execute function public.set_updated_at();

-- 2. USER_NOTEBOOK — synced notebook items
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

create index idx_user_notebook_user on public.user_notebook(user_id);

alter table public.user_notebook enable row level security;

create policy "Users can manage own notebook"
  on public.user_notebook for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create trigger user_notebook_updated_at
  before update on public.user_notebook
  for each row execute function public.set_updated_at();

-- 3. USER_READING_STATE — per-book reading position
create table public.user_reading_state (
  user_id         uuid not null references auth.users(id) on delete cascade,
  book_id         text not null,
  active_chapter_id int,
  updated_at      timestamptz not null default now(),
  primary key (user_id, book_id)
);

alter table public.user_reading_state enable row level security;

create policy "Users can manage own reading state"
  on public.user_reading_state for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create trigger user_reading_state_updated_at
  before update on public.user_reading_state
  for each row execute function public.set_updated_at();
