# Prod rollout — commit 5bbf4fc (credit-model-v2)

Ships the credit-gate fix + Version-E landing + auth/upload UX + brand to **production**.
- Prod worker: `decodebook0219` (top-level env) · Prod Supabase: a **separate project** from staging.
- Last prod deploy ~Sept 12 → this is a large jump; everything was tested on staging.
- `npm run deploy:production` = `wrangler deploy`, which auto-runs `npm run build` (vite build +
  bundle-secret scan) and uploads `dist/` + the worker.

## 0. Pre-flight
- [ ] `git status` clean; `git log --oneline -1` shows **5bbf4fc** on **credit-model-v2**.
- [ ] Decide intentionally: this deploys the WHOLE branch to prod, not just the gate.
- [ ] Prod worker secrets present (CF dashboard → decodebook0219 → Settings → Variables):
      `STRIPE_SECRET_KEY` (the rotated one), `STRIPE_WEBHOOK_SECRET`, all `*_PRICE_ID`,
      `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`.
      (RATE_LIMIT KV is already bound in wrangler.jsonc for prod.)

## 1. DB parity check (run in the PROD Supabase SQL editor, then staging, and diff)
- [ ] `sql/_rollout/schema_fingerprint.sql` — prod tables/columns must match staging (022–032).
- [ ] `sql/_rollout/function_body_fingerprint.sql` — function bodies (get_user_credits,
      tier_monthly_credits, depletion triggers …) must match staging.
- [ ] Any drift → apply the missing `sql/0XX_*.sql` to prod FIRST. (029–032 should already be
      applied — a prior prod diagnostic showed get_user_credits current; verify anyway.)

## 2. Apply migration 033 to PROD
- [ ] Run `sql/033_atomic_credit_reserve.sql` in the **PROD** Supabase SQL editor.
      Additive & safe (creates credit_reservations + reserve/release funcs; unused until the
      worker deploys, and the worker falls back if it's absent).
- [ ] Verify:
      `select to_regclass('public.credit_reservations');`  -- not null
      `select proname from pg_proc where proname in ('reserve_credits','release_reservation','get_available_with_holds');`  -- 3 rows

## 3. Deploy worker + frontend to PROD
- [ ] `npm run deploy:production`
- [ ] Record the printed **Version ID**.

## 4. Verify on prod (https://decodebook.app)
- [ ] Landing + AuthGate sign-in work; app loads.
- [ ] **Credit gate:** on a low-balance account, a Premium image is BLOCKED with the credit
      notice — no charge, balance does NOT go negative. A small action (translate) still works.
- [ ] **Reserve:** `select * from credit_reservations;` (prod) shows a hold during a generation,
      cleared after.
- [ ] `npx wrangler tail` (prod — no `--env`) while exercising → watch `[429]` (rate/quota) + errors.
- [ ] Stripe Upgrade / Buy opens Checkout (rotated key).

## 5. Rollback
- Worker: `npx wrangler rollback` (or redeploy the prior version from the CF dashboard — it keeps
  versions).
- DB: 033 is additive — leaving it is harmless (worker without it falls back to the read-check).
  Full revert only if needed:
  `drop function if exists reserve_credits(uuid,uuid,int), release_reservation(uuid), get_available_with_holds(uuid); drop table if exists credit_reservations;`

## Notes
- **Order: DB (033) FIRST, then the worker.** 033 is safe pre-worker; the image gate + real-cost
  fix take effect on worker deploy; the atomic reserve activates once both are live.
- Frontend assets are content-hashed → users get the new build on next load (no manual cache bust).
- `sql/_rollout/set_test_*.sql` target **staging** test accounts — do NOT run them on prod.
