// ---------------------------------------------------------------------------
// sql/023 verification — the two OPTIONAL probes.
//   Probe A: IDOR read  — get_user_credits must be permission-denied for a normal user
//                         (before: it returned ANY user's balance by uuid).
//   Probe B: neg charge — inserting a negative credits_cost must hit the new CHECK
//                         (before: it manufactured balance via a negative SUM).
//
// HOW TO RUN: log into the STAGING app, DevTools (F12) → Console, select ALL of this
// file, copy, paste, Enter. Runs both probes and prints two HTTP lines.
//
// EXPECTED after sql/023:
//   Probe A: HTTP 403 → permission denied for function get_user_credits
//   Probe B: HTTP 400 → code 23514, ...violates check constraint "usage_logs_credits_cost_nonneg"
// (If Probe B ever returns 201, the CHECK didn't apply — tell me; a bad row got inserted.)
// ---------------------------------------------------------------------------
(async () => {
  const u = localStorage.getItem('supabase_url');
  const a = localStorage.getItem('supabase_anon_key');
  const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const s = JSON.parse(localStorage.getItem(k) || '{}');
  const e = s.currentSession || s;              // session is stored flat OR wrapped in currentSession
  if (!e.access_token) { console.log('NO TOKEN in', k, 'keys:', Object.keys(s)); return; }
  const H = { 'Content-Type': 'application/json', apikey: a, Authorization: 'Bearer ' + e.access_token };

  // Probe A — IDOR read. Target uuid is irrelevant: EXECUTE is revoked, so the permission
  // check fires before the function body. Expect 403 permission denied.
  const ra = await fetch(u + '/rest/v1/rpc/get_user_credits', {
    method: 'POST', headers: H,
    body: JSON.stringify({ p_user_id: '00000000-0000-0000-0000-000000000000' })
  });
  console.log('Probe A (IDOR read get_user_credits):  HTTP', ra.status, '→', await ra.text());

  // Probe B — negative charge into usage_logs (own row, so RLS passes; the CHECK must reject it).
  const rb = await fetch(u + '/rest/v1/usage_logs', {
    method: 'POST', headers: H,
    body: JSON.stringify({ user_id: e.user && e.user.id, action: 'translate', credits_cost: -100000 })
  });
  console.log('Probe B (negative credits_cost insert): HTTP', rb.status, '→', await rb.text());
})();
