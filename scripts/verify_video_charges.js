// Dump the raw usage_logs rows behind recent VIDEO charges so we can reconcile that -535.
// Staging app → DevTools (F12) → Console → paste → Enter.
(async () => {
  const u = localStorage.getItem('supabase_url');
  const a = localStorage.getItem('supabase_anon_key');
  const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const s = JSON.parse(localStorage.getItem(k) || '{}');
  const e = s.currentSession || s;
  if (!e.access_token) { console.log('NO TOKEN in', k, 'keys:', Object.keys(s)); return; }
  const cols = 'created_at,action,credits_cost,model,input_tokens,output_tokens,session_id,usage_id';
  const q = 'action=in.(videoVeo,videoSeedance,videoSeedanceFast,videoPrompt)';
  const r = await fetch(u + '/rest/v1/usage_logs?' + q + '&order=created_at.desc&limit=30&select=' + cols, {
    headers: { apikey: a, Authorization: 'Bearer ' + e.access_token }
  });
  const rows = await r.json();
  if (!Array.isArray(rows)) { console.log('ERROR', r.status, rows); return; }
  console.table(rows.map(x => ({
    time: x.created_at.replace('T', ' ').slice(0, 19),
    action: x.action, credits: x.credits_cost, model: x.model,
    inTok: x.input_tokens, outTok: x.output_tokens,
    usage_id: (x.usage_id || '(none)').slice(0, 8),
    session: (x.session_id || '(none)').slice(0, 18),
  })));
})();
