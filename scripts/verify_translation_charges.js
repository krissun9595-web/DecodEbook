// ---------------------------------------------------------------------------
// Verify recent Translation charges — dumps the RAW usage_logs rows (the credit-history line
// groups them by session, so this shows what actually made up each -7 / -4).
//
// HOW TO RUN: staging app, DevTools (F12) -> Console, paste this whole file, Enter.
// It prints every translate row (newest first) with the per-batch credits, model, page/book,
// tokens, and the session id — then a per-session summary (which is what one history line shows).
// ---------------------------------------------------------------------------
(async () => {
  const u = localStorage.getItem('supabase_url');
  const a = localStorage.getItem('supabase_anon_key');
  const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const s = JSON.parse(localStorage.getItem(k) || '{}');
  const e = s.currentSession || s;
  if (!e.access_token) { console.log('NO TOKEN in', k, 'keys:', Object.keys(s)); return; }

  const cols = 'created_at,credits_cost,model,book_title,input_tokens,output_tokens,session_id,usage_id';
  const r = await fetch(u + '/rest/v1/usage_logs?action=eq.translate&order=created_at.desc&limit=40&select=' + cols, {
    headers: { apikey: a, Authorization: 'Bearer ' + e.access_token }
  });
  const rows = await r.json();
  if (!Array.isArray(rows)) { console.log('ERROR', r.status, rows); return; }

  console.log('--- raw translate rows (newest first) ---');
  console.table(rows.map(x => ({
    time: x.created_at.replace('T', ' ').slice(0, 19),
    credits: x.credits_cost,
    model: x.model,
    book: (x.book_title || '').slice(0, 28),
    inTok: x.input_tokens, outTok: x.output_tokens,
    session: (x.session_id || '(none)').slice(0, 20),
  })));

  const bySession = {};
  for (const x of rows) {
    const key = x.session_id || 'no-session';
    (bySession[key] = bySession[key] || { rows: 0, credits: 0, book: x.book_title, first: x.created_at, last: x.created_at, model: x.model }).rows++;
    bySession[key].credits += x.credits_cost;
    if (x.created_at < bySession[key].first) bySession[key].first = x.created_at;
    if (x.created_at > bySession[key].last) bySession[key].last = x.created_at;
  }
  console.log('--- per session (= one credit-history line) ---');
  console.table(Object.entries(bySession).map(([sid, v]) => ({
    session: sid.slice(0, 24), batches: v.rows, totalCredits: v.credits, model: v.model,
    book: (v.book || '').slice(0, 24), start: v.first.replace('T', ' ').slice(11, 19), end: v.last.replace('T', ' ').slice(11, 19),
  })));
})();
