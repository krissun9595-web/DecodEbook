# Credit Model — cost-derived pricing

How DecodEbook charges credits. Credits are **derived from each model's real API
cost**, so adding a model is a one-line registry entry that prices itself.

## Formula (`services/pricing.ts`)

```
CENTS_PER_CREDIT = 1     // 1 credit ≈ $0.01 revenue (Pro $9.99 / 1000 credits)
MARGIN           = 3     // charge ~3× real API cost (gross-margin target)

credits = max(1, ceil(realCostCents × MARGIN / CENTS_PER_CREDIT))
```

Real cost per modality:

| Modality | Registry unit | Cost |
|---|---|---|
| Text LLM | ¢ / 1M tokens `{in,out}` | `(inTok·in + outTok·out)/1e6` |
| TTS | ¢ / 1M chars | `chars/1e6 · rate` |
| Image | ¢ / image | `n · rate` |
| Video | ¢ / second | `seconds · rate` |

Text credits use a **typical-token footprint per action** (`ACTION_TOKENS`) so the
price is predictable per `(action, model)` and can be pre-checked. Media use the
measured unit (chars / images / seconds).

## Adding a model
1. Add a row to the relevant registry in `pricing.ts` with its **real unit cost**.
2. (Optional) expose it in the UI model picker.
That's it — `creditsForAction()` and cost logging pick it up automatically.

## Where it's wired
- `services/pricing.ts` — registries + `creditsForAction` / `costCentsForAction`.
- `services/gemini.ts` `trackUsage` — charges + logs model-aware credits & cost.
- `services/supabase.ts` `logUsage` — persists `model` to `usage_logs.model`.
- `services/stripe.ts` `CREDIT_COSTS` — default-model reference for UI/pre-check;
  `canAfford(tier, action, model?)` takes the chosen model.
- `sql/014_usage_logs_model.sql` — adds `usage_logs.model` for per-model auditing.

## Calibration
- **Verify unit costs** against provider invoices before trusting margins — the
  Gemini and Seedance rates in particular are estimates (see ⚠️ in `pricing.ts`).
- Tune `ACTION_TOKENS` from real data:
  `select action, avg(input_tokens), avg(output_tokens) from usage_logs group by action;`
- Once `usage_logs.model` has data, compare `avg(cost_cents)` vs `avg(credits_cost)`
  per `(action, model)` to check the real margin and retune `MARGIN` or the registry.

## Knobs
- `MARGIN` (default 3) — global margin multiple.
- `CENTS_PER_CREDIT` (default 1) — revenue per credit; change if Pro price/credit
  allotment changes.
