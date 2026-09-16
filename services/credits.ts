import { UserTier, getAvailableCredits, fetchUserTier, TIER_CREDITS } from './stripe';
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

// Optimistically reduce the cached balance by a charge that JUST happened, in the server's
// depletion order (monthly → pack → bonus), so the very next pre-check reflects it without a
// round-trip — even the first "out of credits" notice fires instantly. Reconciled by the next
// real fetchUserTier; the worker's 429 is the backstop for any drift.
export function applyLocalCharge(credits: number): void {
  if (!cachedTier || !(credits > 0)) return;
  const monthly = TIER_CREDITS[cachedTier.tier] ?? TIER_CREDITS.free;
  if (monthly === Infinity) return; // unmetered tier
  let remaining = credits;
  const monthlyRemaining = Math.max(0, monthly - (cachedTier.credits_used || 0));
  const fromMonthly = Math.min(monthlyRemaining, remaining);
  cachedTier.credits_used = (cachedTier.credits_used || 0) + fromMonthly;
  remaining -= fromMonthly;
  if (remaining > 0 && (cachedTier.pack_credits || 0) > 0) {
    const fromPack = Math.min(cachedTier.pack_credits, remaining);
    cachedTier.pack_credits -= fromPack;
    remaining -= fromPack;
  }
  if (remaining > 0 && (cachedTier.bonus_credits || 0) > 0) {
    const fromBonus = Math.min(cachedTier.bonus_credits, remaining);
    cachedTier.bonus_credits -= fromBonus;
    remaining -= fromBonus;
  }
}

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
  const cost = typeof estimatedCost === 'number' ? estimatedCost : gateCost(action);

  // Fast path: if the CACHED balance already can't cover this, reject INSTANTLY — no network
  // wait — so the "not enough credits" notice shows immediately instead of after a tier fetch.
  // Refresh the cache in the background for next time; the worker's 429 is the authoritative
  // backstop for any staleness (an over-optimistic cache still gets blocked server-side).
  if (cachedTier) {
    const cachedAvailable = getAvailableCredits(cachedTier);
    if (cachedAvailable !== Infinity && cachedAvailable < cost) {
      fetchUserTier().then(setCachedTier).catch(() => { /* keep cached */ });
      return { ok: false, available: cachedAvailable, tier: (cachedTier.tier === 'pro' ? 'pro' : 'free') };
    }
  }

  // Cache says affordable (or none yet) → confirm with a fresh read (catches a just-ran-out).
  let tier = cachedTier;
  try {
    tier = await fetchUserTier();
    setCachedTier(tier);
  } catch {
    /* keep whatever we had cached */
  }
  if (!tier) return { ok: true, available: Infinity, tier: 'free' };
  const available = getAvailableCredits(tier);
  const ok = available === Infinity || available >= cost;
  return { ok, available, tier: (tier.tier === 'pro' ? 'pro' : 'free') };
}
