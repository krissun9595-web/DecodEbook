// One-time re-sync of DB `subscriptions` from Stripe (the source of truth), to repair rows that went
// stale after the 2026-09-09 Stripe default-API-version change (frozen current_period_*, missed
// cancellations). Uses the SAME extraction the fixed worker now uses. Safe to re-run (idempotent).
//
// Review before running. Run on STAGING's database first, confirm, then prod.
// Usage:
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//   STRIPE_SECRET_KEY=sk_test_... \
//   node scripts/resync-subscriptions.mjs            # all rows
//   node scripts/resync-subscriptions.mjs sub_123    # just one subscription id
//
// Subscriptions exist only for paid (pro) users; free users have no row. So: status active/trialing
// ⇒ pro, anything else ⇒ free. Period is read off the subscription ITEM (dahlia location) with a
// legacy fallback. Nothing is deleted; only tier/status/period/cancel are patched.

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
  console.error('Missing env: need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY');
  process.exit(1);
}
const ONLY = process.argv[2] || null;
const SV = '2026-04-22.dahlia';

const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1${path}`, {
  ...opts,
  headers: {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  },
});
const stripe = (path) => fetch(`https://api.stripe.com/v1${path}`, {
  headers: {
    Authorization: `Basic ${Buffer.from(STRIPE_SECRET_KEY + ':').toString('base64')}`,
    'Stripe-Version': SV,
  },
});

const sel = ONLY
  ? `/subscriptions?select=stripe_subscription_id&stripe_subscription_id=eq.${ONLY}`
  : `/subscriptions?select=stripe_subscription_id&stripe_subscription_id=not.is.null`;
const rows = await (await sb(sel)).json();
console.log(`Re-syncing ${rows.length} subscription row(s)…`);

let changed = 0;
for (const r of rows) {
  const id = r.stripe_subscription_id;
  if (!id) continue;
  const sub = await (await stripe(`/subscriptions/${id}`)).json();
  if (sub.error) { console.log(`  skip ${id}: ${sub.error.message}`); continue; }
  const item = sub.items?.data?.[0];
  const pStart = sub.current_period_start || item?.current_period_start || sub.start_date;
  const pEnd = sub.current_period_end || item?.current_period_end;
  const active = sub.status === 'active' || sub.status === 'trialing';
  const body = {
    tier: active ? 'pro' : 'free',
    status: sub.status,
    stripe_price_id: item?.price?.id,
    current_period_start: pStart ? new Date(pStart * 1000).toISOString() : null,
    current_period_end: pEnd ? new Date(pEnd * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end || false,
    updated_at: new Date().toISOString(),
  };
  const res = await sb(`/subscriptions?stripe_subscription_id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  if (!res.ok) { console.log(`  FAIL ${id}: ${res.status} ${await res.text()}`); continue; }
  changed++;
  console.log(`  ${id} → ${body.tier}/${body.status}  period ${body.current_period_start} .. ${body.current_period_end}`);
}
console.log(`Done. Patched ${changed}/${rows.length}.`);
