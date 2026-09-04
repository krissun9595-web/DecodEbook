import { UserTier, getAvailableCredits, fetchUserTier } from './stripe';
import { gateCost } from './pricing';

// ============================================================================
// Client-side credit gate. Every credit-consuming action pre-checks here so the
// user gets a consistent "out of credits" HAZARD notice (with a tier-aware CTA)
// BEFORE anything runs — no partial charge. The worker's 429 is the backstop.
// ============================================================================

// Sentinel thrown by services/gemini.ts when the worker rejects a call with 429
// (Insufficient credits). Callers detect it with isInsufficientCreditsError().
export const INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS';

export function isInsufficientCreditsError(e: unknown): boolean {
  return e instanceof Error && (e.message === INSUFFICIENT_CREDITS || /insufficient credits/i.test(e.message));
}

// Latest known tier, refreshed by App.tsx whenever it fetches. Used as a fallback
// if a fresh fetch fails mid-action.
let cachedTier: UserTier | null = null;
export function setCachedTier(t: UserTier | null) { cachedTier = t; }
export function getCachedTier(): UserTier | null { return cachedTier; }

// Fired by a blocked action's CTA; App.tsx listens and opens MY_ACCOUNT (to the
// Upgrade section for free users, the Credit_Packs section for pro users).
export const OPEN_ACCOUNT_EVENT = 'decodebook:open-account';
export function openAccount(section?: 'upgrade' | 'packs') {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OPEN_ACCOUNT_EVENT, { detail: { section } }));
  }
}

export interface CreditCheck {
  ok: boolean;                 // true → enough credits (or unknown/unmetered → allow)
  available: number;           // remaining balance (Infinity if unmetered)
  tier: 'free' | 'pro';        // drives the CTA copy: free → upgrade, pro → buy pack
}

// Fresh-fetch the tier (mirrors AIAssistant's per-action check) and decide if the
// action can run. On any fetch failure we ALLOW the action — the server-side 429
// gate is the real enforcement; this is purely for a friendly pre-emptive notice.
// `estimatedCost` overrides the flat gate for actions whose real cost scales with the input and is
// knowable up front (e.g. a full-page read-aloud makes many TTS batches — gate on the page's whole
// estimated cost, not one batch). Falls back to the calibrated GATE_COSTS[action].
export async function ensureCredits(action: string, estimatedCost?: number): Promise<CreditCheck> {
  let tier = cachedTier;
  try {
    tier = await fetchUserTier();
    setCachedTier(tier);
  } catch {
    /* keep whatever we had cached */
  }
  if (!tier) return { ok: true, available: Infinity, tier: 'free' };
  const available = getAvailableCredits(tier);
  const cost = typeof estimatedCost === 'number' ? estimatedCost : gateCost(action);
  const ok = available === Infinity || available >= cost;
  return { ok, available, tier: (tier.tier === 'pro' ? 'pro' : 'free') };
}
