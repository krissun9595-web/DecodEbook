-- Add the remaining model-selection columns to user_settings.
--
-- The app (saveUserSettings in services/supabase.ts) upserts four model columns:
--   llm_model, tts_model, image_model, video_model
-- Migration 003 added image_model and video_model, but llm_model and tts_model were
-- never created — so every settings save 400s with
--   "Could not find the 'llm_model' column of 'user_settings' in the schema cache".
-- Add the two missing columns (idempotent).
alter table public.user_settings
  add column if not exists llm_model text,
  add column if not exists tts_model text;
