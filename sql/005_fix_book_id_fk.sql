-- Book IDs in the app are generated client-side (crypto.randomUUID in browser)
-- and stored in localStorage, not in the public.books table.
-- The foreign key constraints cause silent failures on every trackGeneration
-- and trackEvent call that includes a book_id.

-- Drop FK on generations.book_id
alter table public.generations
  drop constraint if exists generations_book_id_fkey;

-- Drop FK on events.book_id
alter table public.events
  drop constraint if exists events_book_id_fkey;

-- Change book_id column type to text in both tables
alter table public.generations alter column book_id type text using book_id::text;
alter table public.events alter column book_id type text using book_id::text;

-- Recreate track_event with text book_id
-- Must drop old version first (different param types = different function signature)
drop function if exists public.track_event(uuid, text, text, uuid, int, jsonb);

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

-- Recreate track_generation with text book_id
drop function if exists public.track_generation(uuid, int, text, text, text, int, int, numeric, text, text);

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
