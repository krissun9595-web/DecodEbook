// ---------------------------------------------------------------------------
// Step-2 verification — SSRF / Gemini-key-exfil fix on /api/gemini/video-download.
//
// Before: the worker fetched ANY uri you gave it WITH x-goog-api-key attached (key leak).
// After : a non-Google host is refused with HTTP 400 before any fetch, so the key is never sent.
//
// HOW TO RUN: log into the STAGING app, DevTools (F12) -> Console, select ALL of this file,
// copy, paste, Enter. Runs two probes.
//
// EXPECTED after this deploy:
//   Probe 1 (attacker host):  HTTP 400 -> {"error":"Invalid download URL"}   (key-exfil closed)
//   Probe 2 (googleapis host): NOT 400 (some Google 400/403/404 for a bogus file id) -> allowlist lets Google through
// ---------------------------------------------------------------------------
(async () => {
  const u = localStorage.getItem('supabase_url');
  const a = localStorage.getItem('supabase_anon_key');
  const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const s = JSON.parse(localStorage.getItem(k) || '{}');
  const e = s.currentSession || s;
  if (!e.access_token) { console.log('NO TOKEN in', k, 'keys:', Object.keys(s)); return; }
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + e.access_token };
  const origin = window.location.origin;

  // Probe 1 — malicious host. Must be refused (400) so the API key is never forwarded.
  const r1 = await fetch(origin + '/api/gemini/video-download', {
    method: 'POST', headers: H,
    body: JSON.stringify({ uri: 'https://attacker.example.com/collect' })
  });
  console.log('Probe 1 (attacker host):   HTTP', r1.status, '->', (await r1.text()).slice(0, 120));

  // Probe 2 — allowlisted Google host with a bogus file id: should pass the allowlist (NOT our 400),
  // then get some error FROM Google. This confirms real Veo downloads still work.
  const r2 = await fetch(origin + '/api/gemini/video-download', {
    method: 'POST', headers: H,
    body: JSON.stringify({ uri: 'https://generativelanguage.googleapis.com/v1beta/files/nonexistent:download' })
  });
  console.log('Probe 2 (googleapis host): HTTP', r2.status, '->', (await r2.text()).slice(0, 120));
})();
