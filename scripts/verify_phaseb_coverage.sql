-- Phase B coverage check: confirm the WORKER writes a charge for every path.
--
-- HOW TO USE
--   1) First confirm the policy is live (run the VERIFY block in sql/025): a credit-bearing
--      client insert must fail with 42501. Once it does, the client CANNOT write real charges —
--      so any credit-bearing row below was necessarily written by the worker (service_role).
--   2) In the app, exercise each feature ONCE (recent window below is 1 hour):
--        - Translate a page            -> action 'translate'
--        - Ask the AI assistant        -> 'chat'
--        - Define a word               -> 'quickDefinition'
--        - Read-aloud (TTS)            -> 'tts'
--        - Generate a podcast          -> 'podcastScript' + 'tts' (per line)
--        - Generate a concept image    -> 'generateImage'
--        - Translate a figure (redraw) -> 'redrawFigureTranslated' (+ 'translateFigureText')
--        - Generate a Veo video        -> 'videoVeo' (+ 'videoPrompt')
--        - Generate a Seedance video   -> 'videoSeedance' or 'videoSeedanceFast' (+ 'videoPrompt')
--        - Extract concepts / analyze  -> 'extractConcepts' / 'analyzeBookStructure'
--      (Mindmap is built locally with no LLM call, so it is intentionally NOT expected here.)
--   3) Run this. Each feature you exercised should appear with rows > 0. A missing action you
--      DID exercise == a path the worker isn't covering (a leak to fix).

select
  action,
  count(*)                              as rows,
  min(credits_cost)                     as min_credits,
  max(credits_cost)                     as max_credits,
  max(created_at)                       as latest,
  count(*) filter (where model = '__partial__') as partial_markers
from usage_logs
where created_at > now() - interval '1 hour'
group by action
order by latest desc;
