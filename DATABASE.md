# DecodEbook — Data Model & Storage Architecture

Authoritative reference for where DecodEbook keeps state. Reflects production as of
2026-08-26 (after the DB consolidation, `sql/012`). The canonical Supabase schema is
**`schema.sql`** (single source of truth); `supabase-schema.sql` + `sql/000–012` are
retained only as migration history.

---

## 1. Storage layers (four of them)

| Layer | Where | Holds | Persistence |
|---|---|---|---|
| **Supabase (Postgres)** | cloud | accounts, settings, cloud library, notebook, reading state, billing, analytics | durable, cross-device |
| **IndexedDB `DecodEbook`** | browser | generated blobs + full extracted source text | per-device, large |
| **IndexedDB `DecodEbookPronunciation`** | browser | pronunciation audio (LRU, 180 cap) | per-device |
| **localStorage** | browser | settings, library metadata, notebook, UI prefs, config | per-device, ~5 MB |

---

## 2. Supabase tables (15) — `schema.sql`

Grouped by subsystem. RLS is **enabled on every table** with `auth.uid()` policies
(users see/manage only their own rows; billing/referral tables are SELECT-only for
users and written by the worker/service role or `SECURITY DEFINER` RPCs).

- **Core:** `profiles` (1:1 with `auth.users`, populated by the `handle_new_user`
  trigger), `user_settings`, `subscriptions`, `usage_logs` (billing/quota — one row
  per AI call).
- **Cloud library:** `user_books`, `user_notebook`, `user_reading_state`.
- **Analytics:** `sessions`, `events`, `generations` (+ 6 `v_*` reporting views).
  `events.book_id` / `generations.book_id` are **`text`, no FK** (book IDs are
  client-generated UUIDs, not DB rows).
- **Monetization:** `credit_pack_purchases`, `bonus_credits`, `referral_codes`,
  `referral_clicks`, `referral_signups`.

**Removed in `sql/012`:** the empty `public.books` table (app uses `user_books`),
its `increment/decrement_book_count` functions, and three never-used `profiles`
columns (`locale`, `timezone`, `device_fingerprint`). `v_user_funnel.first_upload_at`
now sources from `user_books` instead of the dropped `books`.

> **Known-dead field:** `profiles.total_books_uploaded` is frozen at 0 (its updater
> was dropped with `books`; kept because `v_user_engagement` reads it). Optional
> follow-up: re-wire it to `user_books`.

---

## 3. The book library — a 3-layer persistence contract

A book's data is deliberately split so nothing blows the ~5 MB localStorage quota:

1. **`localStorage['library']`** — `LibraryItem[]` **metadata only** (title, author,
   chapters, bookmarks, `fileContext` flags). `fileContext.content` is stripped to `''`.
2. **IndexedDB `DecodEbook`, `fileType:'source-file'`** — the full extracted text /
   base64, keyed by `sourceCacheKey(bookId)` with versioned fallbacks. This is the
   heavy payload.
3. **Supabase `user_books`** (logged-in only) — metadata + chapters; `content` is
   synced **only for text files** (`is_text=true`). PDFs/EPUBs sync metadata, not bytes.

**On login:** cloud library is merged with local (`mergeLibrary`); cloud fills in
stripped content where local lacks it; local-only books are queued for upload; sources
are re-hydrated from IndexedDB.

---

## 4. Settings — dual storage & precedence

Settings live in **both** `localStorage['app_settings']` and Supabase `user_settings`.

- **Load order (App.tsx):** localStorage is applied first; then, after auth,
  `loadUserSettings()` overrides with the Supabase row where each field is present
  (`remote.x || local.x`). **⇒ Supabase wins for logged-in users**; anonymous users
  use localStorage only.
- **Save:** both are written (localStorage immediately; `saveUserSettings` upserts to
  Supabase for logged-in users).

---

## 5. ⚠️ Security note — API keys at rest

`gemini_key` and `openrouter_key` (BYOK) are stored **in plaintext** in:
- `localStorage['app_settings']`, and
- Supabase `user_settings.gemini_key` / `.openrouter_key`.

The Supabase row is protected by RLS (`auth.uid() = user_id`, ALL policy), so another
user cannot read it — but it is **not encrypted at rest**, and anyone with the
service-role key or DB access can read it. This is acceptable for a BYOK model where
the key is the user's own, but it is a deliberate trade-off, documented here rather
than left implicit. **If keys ever need stronger protection**, options are: hold them
only client-side (drop the Supabase columns), or encrypt them with a per-user secret
before storing.

---

## 6. IndexedDB eviction

- **`DecodEbook` (generated files + source text):** size-cap LRU (added 2026-08-26).
  `enforceCacheBudget()` runs fire-and-forget after each `saveFile`; if the store
  exceeds **1 GB**, oldest-created blobs are evicted down to **800 MB**.
  `fileType:'source-file'` and `'original-file'` are **never evicted** (losing them
  would force re-extraction / re-upload).
- **`DecodEbookPronunciation`:** LRU capped at **180** entries by `lastUsed`.

---

## 7. localStorage keys (reference)

`library`, `notebook`, `app_settings` (incl. API keys), `audiobook_*`,
`podcast_*`, `voice_synth_player_minimized`, `supabase_url`, `supabase_anon_key`,
`stripe_*_price_id`, `auth_gate_skipped`, `referrer_id`,
`decodebook_audio_timings:*`. Debug-only: `dbgVersion`, `dbgCaptureChapters`.
