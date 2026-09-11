// Release gate: fail the build if a provider secret got compiled into the client bundle.
// Runs automatically as `postbuild`. Scans dist/ for API-key shaped tokens.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
// Google (AIza...), OpenAI/Anthropic (sk-..., sk-ant-...), Stripe secret/restricted (sk_live/rk_live),
// Supabase service-role JWT has role":"service_role" embedded.
const PATTERNS = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_\-]{30,}/ },
  { name: 'OpenAI/Anthropic key', re: /sk-(ant-)?[A-Za-z0-9_\-]{20,}/ },
  { name: 'Stripe secret key', re: /(sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { name: 'Supabase service_role key', re: /service_role/ },
];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|css|html|map)$/.test(e)) out.push(p);
  }
  return out;
}

if (!existsSync(DIST)) { console.log('[check-bundle-secrets] no dist/ — skipping'); process.exit(0); }

const hits = [];
for (const f of walk(DIST)) {
  const text = readFileSync(f, 'utf8');
  for (const { name, re } of PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(`${f}: ${name} → ${m[0].slice(0, 12)}…`);
  }
}

if (hits.length) {
  console.error('\n[31m✗ SECRET FOUND IN BUNDLE — build blocked:[0m');
  for (const h of hits) console.error('   ' + h);
  console.error('A provider/secret key must never ship to the client. Check vite.config.ts `define`.\n');
  process.exit(1);
}
console.log('[check-bundle-secrets] clean — no secrets in dist/');
