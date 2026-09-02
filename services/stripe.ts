import { getSession } from './supabase';
import { creditsForAction } from './pricing';

export interface UserTier {
  tier: 'free' | 'pro';
  period_start: string;
  period_end: string | null;
  cancel_at_period_end: boolean;
  credits_used: number;
  pack_credits: number;      // remaining pack balance
  pack_purchased?: number;   // cumulative packs bought (progress-bar denominator)
  bonus_credits: number;
}

export const TIER_CREDITS: Record<string, number> = {
  free: 100, pro: 1000,
};

// Displayed/pre-check credit cost per action for the DEFAULT models. The ACTUAL
// charge is model-aware and derived at call time in gemini.ts trackUsage() via
// pricing.creditsForAction(action, chosenModel) — an expensive model costs more.
// These reference values come from the same registry so the UI stays in sync.
const REF_TEXT = 'gemini-3-flash';
export const CREDIT_COSTS: Record<string, number> = {
  translate:            creditsForAction('translate', REF_TEXT),
  quickDefinition:      creditsForAction('quickDefinition', REF_TEXT),
  chat:                 creditsForAction('chat', REF_TEXT),
  analyzeBookStructure: creditsForAction('analyzeBookStructure', REF_TEXT),
  extractConcepts:      creditsForAction('extractConcepts', REF_TEXT),
  extractChapterText:   creditsForAction('extractChapterText', REF_TEXT),
  podcastScript:        creditsForAction('podcastScript', REF_TEXT),
  tts:                  creditsForAction('tts', 'gemini-3.1-flash-tts', { chars: 1500 }),
  generateImage:        creditsForAction('generateImage', 'gemini-3-pro-image'),
  podcastAudio:         creditsForAction('podcastAudio', 'gemini-3.1-flash-tts', { chars: 10000 }),
  videoSeedanceFast:    creditsForAction('videoSeedanceFast', 'seedance'),
  videoSeedance:        creditsForAction('videoSeedance', 'dreamina-seedance-2-0-mini'),
  videoVeo:             creditsForAction('videoVeo', 'veo-3.1-fast'),
};

export function getAvailableCredits(tier: UserTier): number {
  const monthly = TIER_CREDITS[tier.tier] || 100;
  if (monthly === Infinity) return Infinity;
  // Backend (sql/018) caps credits_used at the monthly allowance and draws over-monthly
  // usage from pack_credits then bonus_credits, so both are true REMAINING balances here.
  return Math.max(0, monthly - tier.credits_used) + (tier.pack_credits || 0) + (tier.bonus_credits || 0);
}

// Pre-check gate. Pass the chosen model where known for a model-accurate estimate;
// otherwise falls back to the default-model reference cost above.
export function canAfford(tier: UserTier, action: string, model?: string): boolean {
  const cost = model ? creditsForAction(action, model) : (CREDIT_COSTS[action] ?? 1);
  return getAvailableCredits(tier) >= cost;
}

async function authHeaders(): Promise<Record<string, string>> {
  const session = await getSession();
  return session?.access_token
    ? { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

export async function fetchUserTier(): Promise<UserTier> {
  try {
    const headers = await authHeaders();
    const res = await fetch('/api/user/tier', { headers });
    if (!res.ok) return { tier: 'free', period_start: '', period_end: null, cancel_at_period_end: false, credits_used: 0, pack_credits: 0, pack_purchased: 0, bonus_credits: 0 };
    return await res.json() as UserTier;
  } catch {
    return { tier: 'free', period_start: '', period_end: null, cancel_at_period_end: false, credits_used: 0, pack_credits: 0, pack_purchased: 0, bonus_credits: 0 };
  }
}

export async function createCheckoutSession(priceId: string): Promise<string | null> {
  const headers = await authHeaders();
  const res = await fetch('/api/stripe/checkout', {
    method: 'POST',
    headers,
    body: JSON.stringify({ priceId }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { url: string };
  return data.url;
}

export async function createPackCheckout(priceId: string): Promise<string | null> {
  const headers = await authHeaders();
  const res = await fetch('/api/stripe/pack-checkout', {
    method: 'POST',
    headers,
    body: JSON.stringify({ priceId }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { url: string };
  return data.url;
}

export async function openCustomerPortal(): Promise<string | null> {
  const headers = await authHeaders();
  const res = await fetch('/api/stripe/portal', {
    method: 'POST',
    headers,
  });
  if (!res.ok) return null;
  const data = await res.json() as { url: string };
  return data.url;
}
