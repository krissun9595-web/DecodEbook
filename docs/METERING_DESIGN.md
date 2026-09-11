# Server-Authoritative Metering — Design (Security step 3.3)

## Problem
`credits_used = SUM(usage_logs.credits_cost)` and the worker gate only READS that sum — but the
row is written by the browser with a client-chosen amount. Rate limiting (3.1) caps the *rate* of
abuse, not the ability to *under-report*. The fix: the **worker** records each charge from
server-measured data, and we then **revoke the client's INSERT** on `usage_logs`. This also
subsumes H2 (creditAction spoofing), because the gate can price from the same server-derived cost.

## Reality that shapes the design
- **Paths & metering inputs**
  - `/api/gemini/*` (SDK passthrough, streams body through) — Gemini text `generateContent`
    (highest volume, currently **ungated**), TTS, Veo. Tokens live in the response `usageMetadata`
    (text) or are derived from the request (TTS chars, Veo seconds).
  - `/api/llm/generate` — non-Gemini text (rare). Response already parsed; has `usage`.
  - `/api/fal/image` — image. Flat per model.
  - `/api/seedance/generate|poll|download` — video (async). Fixed seconds.
- **Grouping** (one credit-history line = one execution) needs `session_id` + `book_title`, which
  today live only on the client.
- `creditsForAction()` is already importable in the worker (`services/pricing.ts`).
- **`translate` is footprint-priced, not measured** — so the worker must price it from the same
  `ACTION_TOKENS` footprint (ignoring real tokens), which `creditsForAction` already does by action.

## Design

### 1. Metadata channel (client → worker) — HTTP headers on every generation request
Worker needs `{action, model, book, session, usage_id}` per call. Deliver as headers:
`X-Db-Action`, `X-Db-Book`, `X-Db-Session`, `X-Db-Usage-Id`.
- Our own fetches (`/api/llm/generate`, `/api/fal/image`, `/api/seedance/*`): add headers directly.
- SDK-routed (`/api/gemini`): `getAi()` already sets `httpOptions.headers` — thread per-call
  metadata so each `generateContent`/`generateVideos`/tts call carries its own headers. Build the
  client per call (`getAi(meta)`) so parallel batches don't share ambient state.
- `usage_id` is generated at the call site (same value used for the request header AND, during the
  transition, the client's own write) so the two dedupe.

### 2. Worker records the charge (authoritative, idempotent)
After a successful proxied generation, compute `creditsForAction(action, model, units)` and INSERT
`usage_logs` via `supabaseAdmin` (service role) with `usage_id` → reuse the sql/022 unique index
(`ON CONFLICT (usage_id) DO NOTHING`). Per path:
- **text** (`/api/llm/generate` + `/api/gemini …:generateContent` non-tts): buffer the small JSON
  response, read `usageMetadata.{promptTokenCount,candidatesTokenCount}`, compute. (translate →
  footprint, automatically.)
- **tts** (`/api/gemini …tts:generateContent`): compute `chars`/`cjkChars` from the REQUEST text —
  no need to buffer the large audio response.
- **image** (`/api/fal/image`): flat per `model`.
- **Veo / seedance** (async): charge on the **terminal download** (proves success), keyed by
  `usage_id`, so a failed/abandoned generation isn't billed.

### 3. Migration phases (no double-charge, no regression)
- **Phase A — dual-write (idempotent):** worker writes with the SAME `usage_id` the client sends;
  client keeps its durable+idempotent write (sql/022). `ON CONFLICT` dedupes → identical value
  (same `creditsForAction` inputs). Deploy, then VERIFY over real usage: worker rows appear with
  correct model/session/book, no dupes, values match the client's.
- **Phase B — revoke client INSERT:** once A is verified, drop the `usage_logs` INSERT policy so
  ONLY `service_role` writes; client stops calling `logUsage` for credit rows. → malicious skip
  closed. Keep a NARROW client policy for 0-credit **partial markers** only:
  `with check (auth.uid()=user_id AND credits_cost = 0 AND model = '__partial__')`.
- **Phase C — H2:** gate prices from the server-derived model/units → `creditAction` spoofing moot.

### 4. Risks / mitigations
- **Streaming** would break response-buffering → confirm app uses non-streaming `generateContent`
  (it does). Exclude any stream path.
- **SDK header concurrency** → per-call `getAi(meta)`; verify parallel TTS batches carry distinct
  `usage_id`.
- **Async charge point** → terminal download + `usage_id` idempotency; if a user never downloads
  (rare), the charge is missed (favors user — acceptable).
- **Worker-write failure after a successful generation** → in Phase A the client still records (no
  loss). In Phase B, wrap the worker write with a short retry; a rare failure favors the user (lost
  charge, never a double).
- **Missing book/session on a path** → CreditHistory already has a burst-group fallback.

### 5. Effort
Moderate–large, but phased & reversible: client metadata threading (getAi + each generate site);
worker `recordUsage()` helper + per-path wiring; Phase-B RLS migration; a verification pass on real
traffic between A and B.

## Resolved decisions (2026-09-07)
1. **Video charge point → on SUCCESSFUL COMPLETION** (poll/operation reports done), not download.
   The provider bills us at generation, not retrieval, so this matches our cost and doesn't depend
   on the user downloading. Only successful results are billed. (Optional worker confirming-poll to
   catch abandoned-mid-poll; residual miss is user-favoring.)
2. **Partial markers → narrow client 0-credit policy.** In Phase B, replace the client's usage_logs
   INSERT with `with check (auth.uid()=user_id AND credits_cost = 0 AND model = '__partial__')` —
   client can still write 0-credit "(Partial)" tags, but any credit-bearing row must come from the
   worker (service_role).
3. **Phase-A soak → yes**, dual-write for a few days on real traffic; verify worker rows match the
   client's before Phase B. Phase A also MEASURES worker-write reliability to inform decision 4.
4. **Phase-B worker-write failure → accept rare user-favoring loss** (log server-side, no charge, no
   history line, balance unchanged — invisible & in the user's favor; never charged-for-nothing).
   Revisit with Phase-A failure-rate data; add a 2–3× in-request retry (or queue) only if needed.
5. **Premium `translate` → measured billing.** Applied to BOTH modes for one code path; materially
   affects only Premium (pro model, output-heavy) where the footprint over-charged short pages.
   Balanced (deepseek) stays at the 1-credit floor either way.

## Build status
- Decision 5 + Phase-A **text path** (Gemini generateContent + /api/llm/generate): worker dual-writes
  usage idempotently (same usage_id as client) — IN PROGRESS.
- Phase-A media paths (TTS / image / video-on-completion): next increment.
- Phase B (revoke client credit-INSERT + narrow partial policy): after Phase-A soak + verification.
