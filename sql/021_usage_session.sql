-- 021: per-EXECUTION grouping id for usage_logs.
--
-- One "generate" click fires many API calls (a translation batches by 10 sentences; a read-aloud by
-- TTS batch), each its own usage_logs row. The Credit History collapses a generation's rows into ONE
-- line, but grouping by (action + book + time-window) wrongly merged SEPARATE executions (a different
-- page's translation, or an audio re-run) into one line and rewrote it. session_id tags every row of a
-- single execution with the same value, so the UI groups by execution exactly — each run is its own
-- immutable line. Nullable; older rows and single-call actions simply have no session_id.
alter table public.usage_logs add column if not exists session_id text;
