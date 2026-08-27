# Staging Environment Setup — Runbook

Goal: give staging its **own isolated Supabase database** (and its own Stripe test
account + AI keys) so app updates, migrations, and fixes are verified on staging
**before** production users are ever affected.

**Current state (2026-08-26):** staging Worker `decodebook0219-staging` and prod
Worker `decodebook0219` currently **share one Supabase database** — because the
staging Worker's `SUPABASE_*` secrets point at the prod project. This runbook makes
them independent.

Architecture after setup:
```
staging Worker  ──env.SUPABASE_URL = staging project──▶  STAGING database   (test data)
prod Worker     ──env.SUPABASE_URL = prod project────▶   PRODUCTION database (real users)
```
Secrets are stored **per-Worker**, so setting them on `--env staging` never touches prod.

---

## Step 1 — Create the staging Supabase project

1. https://supabase.com/dashboard → **New project** → name `decodebook-staging`
   (same region as prod). Save the DB password.
2. Wait for it to provision (~2 min).

## Step 2 — Build the schema from source of truth

1. In the **staging** project → **SQL Editor** → **New query**.
2. Paste the entire contents of **`schema.sql`** (repo root) → **Run**.
   - This creates all 15 tables, 6 views, functions, triggers, and RLS from scratch.
   - Fresh DB = zero users, clean slate.
3. (No extra migrations needed today — `schema.sql` already reflects the `012`/`013` state.)

## Step 3 — Match auth config to prod

In the **staging** project:
1. **Authentication → URL Configuration**
   - **Site URL:** `https://decodebook0219-staging.krissun9595.workers.dev`
   - **Redirect URLs:** add the staging URL (and any custom staging domain).
     *PKCE OAuth fails without this.*
2. **Authentication → Providers:** enable the same providers as prod (e.g. Google).
   Add the staging redirect URI to the provider's allowed list (or use a separate
   OAuth client for staging).

## Step 4 — Find the staging Supabase credentials

Staging project → **Settings → API** (aka *Project Settings → API Keys / Data API*):
- **Project URL** → `https://<staging-ref>.supabase.co`  ⟶ `SUPABASE_URL`
- **anon / public** key ⟶ `SUPABASE_ANON_KEY`
- **service_role / secret** key ⟶ `SUPABASE_SERVICE_ROLE_KEY`  *(keep private — bypasses RLS)*

Sanity check: `<staging-ref>` must **differ** from the prod project's ref.

## Step 5 — Point the staging Worker at the staging project

Each command prompts for the value (paste it in). `--env staging` = the `-staging`
Worker's own secret store; prod is untouched.

```bash
wrangler secret put SUPABASE_URL --env staging               # https://<staging-ref>.supabase.co
wrangler secret put SUPABASE_ANON_KEY --env staging          # staging anon key
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging  # staging service_role key
```

(Dashboard alternative: Cloudflare → Workers & Pages → `decodebook0219-staging` →
Settings → Variables and Secrets → add as **encrypted** Secret.)

## Step 6 — Stripe (TEST mode) for staging

Do all of this with the Stripe dashboard **Test mode** toggle ON (test mode has its
own keys/products/prices/webhooks). **Golden rule: staging never charges a real card.**

1. **Secret key:** Developers → API keys → **Secret key** (`sk_test_...`) ⟶ `STRIPE_SECRET_KEY`
2. **Products & prices:** Product catalog → recreate your products in test mode; each
   price gets an ID `price_...`. Map them:

   | Secret | Price |
   |---|---|
   | `STRIPE_PRO_PRICE_ID` | Pro monthly |
   | `STRIPE_PRO_ANNUAL_PRICE_ID` | Pro annual |
   | `STRIPE_BYOK_PRICE_ID` | BYOK |
   | `STRIPE_UNLIMITED_PRICE_ID` | Unlimited |
   | `STRIPE_PACK_S_PRICE_ID` | Small pack |
   | `STRIPE_PACK_M_PRICE_ID` | Medium pack |
   | `STRIPE_PACK_L_PRICE_ID` | Large pack |

   *(Shortcut: set placeholders `price_xxx` just to boot the Worker; use real test
   prices when you want to exercise checkout.)*
3. **Webhook:** Developers → Webhooks → Add endpoint (Test mode)
   - URL: `https://decodebook0219-staging.krissun9595.workers.dev/api/stripe/webhook`
   - Events: at least `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted` (or Select all for staging).
   - Signing secret (`whsec_...`) ⟶ `STRIPE_WEBHOOK_SECRET`
4. **Test card:** `4242 4242 4242 4242`, any future expiry, any CVC.

```bash
wrangler secret put STRIPE_SECRET_KEY --env staging          # sk_test_...
wrangler secret put STRIPE_WEBHOOK_SECRET --env staging      # whsec_...
wrangler secret put STRIPE_PRO_PRICE_ID --env staging
wrangler secret put STRIPE_PRO_ANNUAL_PRICE_ID --env staging
wrangler secret put STRIPE_BYOK_PRICE_ID --env staging
wrangler secret put STRIPE_UNLIMITED_PRICE_ID --env staging
wrangler secret put STRIPE_PACK_S_PRICE_ID --env staging
wrangler secret put STRIPE_PACK_M_PRICE_ID --env staging
wrangler secret put STRIPE_PACK_L_PRICE_ID --env staging
```

## Step 7 — AI provider keys for staging

Either **reuse prod keys** (simplest; usage mixes with prod billing) or **mint separate
keys** (cleaner quota separation):
- Gemini → https://aistudio.google.com/apikey
- OpenAI → https://platform.openai.com/api-keys
- Anthropic → https://console.anthropic.com/settings/keys
- BytePlus → Volcengine/BytePlus console → API keys
- FAL → https://fal.ai/dashboard/keys

```bash
wrangler secret put GEMINI_API_KEY --env staging
wrangler secret put OPENAI_API_KEY --env staging
wrangler secret put ANTHROPIC_API_KEY --env staging
wrangler secret put BYTEPLUS_API_KEY --env staging
wrangler secret put FAL_API_KEY --env staging
```

## Step 8 — Deploy & verify isolation

```bash
wrangler secret list --env staging   # expect all 18 names present
npm run deploy:staging
```
Then open the staging URL, sign up a **test** account, and confirm the new row appears
in the **staging** project's `profiles` table and **NOT** in prod. Two independent DBs. ✅

---

## The 18 secrets (checklist)

| # | Secret | Source |
|---|---|---|
| 1 | `SUPABASE_URL` | staging project → Settings → API |
| 2 | `SUPABASE_ANON_KEY` | staging project → Settings → API |
| 3 | `SUPABASE_SERVICE_ROLE_KEY` | staging project → Settings → API |
| 4 | `STRIPE_SECRET_KEY` | Stripe test mode → API keys |
| 5 | `STRIPE_WEBHOOK_SECRET` | Stripe test mode → Webhooks |
| 6 | `STRIPE_PRO_PRICE_ID` | Stripe test mode → Products |
| 7 | `STRIPE_PRO_ANNUAL_PRICE_ID` | Stripe test mode → Products |
| 8 | `STRIPE_BYOK_PRICE_ID` | Stripe test mode → Products |
| 9 | `STRIPE_UNLIMITED_PRICE_ID` | Stripe test mode → Products |
| 10 | `STRIPE_PACK_S_PRICE_ID` | Stripe test mode → Products |
| 11 | `STRIPE_PACK_M_PRICE_ID` | Stripe test mode → Products |
| 12 | `STRIPE_PACK_L_PRICE_ID` | Stripe test mode → Products |
| 13 | `GEMINI_API_KEY` | Google AI Studio |
| 14 | `OPENAI_API_KEY` | OpenAI platform |
| 15 | `ANTHROPIC_API_KEY` | Anthropic console |
| 16 | `BYTEPLUS_API_KEY` | BytePlus console |
| 17 | `FAL_API_KEY` | FAL dashboard |

*(18 = also `ENVIRONMENT=staging`, already set as a plain var in `wrangler.jsonc`.)*

---

## Going-forward migration workflow

For any schema change / DB-touching feature:
1. Write it as `sql/0NN_description.sql` (keep the numbered convention).
2. Run it on the **staging** project → `npm run deploy:staging` → test on staging.
3. When green, run the same file on the **prod** project → `npm run deploy:production`.
4. Update **`schema.sql`** to the new end-state (keeps a fresh rebuild correct).

This discipline (apply to both, always update `schema.sql`) is what prevents the
repo↔DB drift the DB-consolidation review had to clean up. If it feels fragile,
graduate to the Supabase CLI + `supabase/migrations/` (auto-applies the same files
to every DB).

## Gotchas
- **service_role key:** staging must use its OWN (staging project's) — never prod's.
- **Stripe webhook:** must use the test-mode signing secret, or credit/subscription
  flows won't complete on staging.
- **OAuth redirect URLs:** must include the staging origin or login silently fails.
- **`SUPABASE_URL` must be the BARE project origin** — `https://<ref>.supabase.co`,
  with NO trailing path. Supabase's "Data API" page shows it as
  `https://<ref>.supabase.co/rest/v1/`; if you paste that, the client/worker append
  paths → `…/rest/v1//auth/v1/token` → 404 → login silently fails, no user created.
  Verify with `curl https://<staging-worker>/api/config`.
- **OAuth providers are per-project:** a fresh staging project has NO providers
  configured. To use e.g. X/Google login on staging you must (a) enable the provider
  in the staging project's Authentication → Providers with its client id/secret, and
  (b) add the staging callback `https://<staging-ref>.supabase.co/auth/v1/callback` to
  the provider app's allowed callbacks. Until then, test with email/password (needs
  no provider config).
- **Stale client config:** the browser caches `supabase_url` in localStorage. After
  fixing a bad `SUPABASE_URL`, test in an incognito window (or clear site data) so the
  old value isn't reused.
