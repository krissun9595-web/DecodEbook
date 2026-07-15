import { getSession } from './supabase';

export interface UserTier {
  tier: 'free' | 'pro' | 'byok' | 'unlimited';
  period_start: string;
  period_end: string | null;
  cancel_at_period_end: boolean;
  credits_used: number;
  pack_credits: number;
  bonus_credits: number;
}

export const TIER_CREDITS: Record<string, number> = {
  free: 100, pro: 1000, byok: Infinity, unlimited: Infinity,
};

export const CREDIT_COSTS: Record<string, number> = {
  translate: 1, quickDefinition: 1, chat: 1,
  analyzeBookStructure: 6, extractConcepts: 2, extractDictionary: 2, generateMindMap: 2,
  extractChapterText: 3, podcastScript: 3,
  tts: 5, generateImage: 10, podcastAudio: 40,
  videoSeedanceFast: 30, videoSeedance: 50, videoVeo: 150,
};

export function getAvailableCredits(tier: UserTier): number {
  const monthly = TIER_CREDITS[tier.tier] || 100;
  if (monthly === Infinity) return Infinity;
  return Math.max(0, monthly - tier.credits_used) + tier.pack_credits + (tier.bonus_credits || 0);
}

export function canAfford(tier: UserTier, action: string): boolean {
  const cost = CREDIT_COSTS[action] || 1;
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
    if (!res.ok) return { tier: 'free', period_start: '', period_end: null, cancel_at_period_end: false, credits_used: 0, pack_credits: 0, bonus_credits: 0 };
    return await res.json() as UserTier;
  } catch {
    return { tier: 'free', period_start: '', period_end: null, cancel_at_period_end: false, credits_used: 0, pack_credits: 0, bonus_credits: 0 };
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
