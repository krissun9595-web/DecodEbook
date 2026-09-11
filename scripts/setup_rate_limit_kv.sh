#!/usr/bin/env bash
# Provision the per-user rate-limit KV namespace for the Worker (step 3.1).
# The limiter code is already deployed and NO-OPS until this binding exists — so this is safe to
# run whenever. After it prints the namespace id, paste that id back and I'll add the binding to
# wrangler.jsonc, then a redeploy turns the limiter on.
#
# Run from the repo root:
#   bash scripts/setup_rate_limit_kv.sh
set -e

echo "Creating KV namespace 'RATE_LIMIT' ..."
npx wrangler kv namespace create RATE_LIMIT

echo
echo "==> Copy the \"id\": \"...\" value from the output above and send it to me."
echo "    I'll add this to wrangler.jsonc under env.staging:"
echo '      "kv_namespaces": [{ "binding": "RATE_LIMIT", "id": "<that-id>" }]'
echo "    then redeploy (npm run deploy:staging) to activate the 100-requests/60s per-user cap."
