import { getSession } from './supabase';

export interface UserTier {
  tier: 'free' | 'pro' | 'unlimited';
  period_start: string;
  period_end: string | null;
  cancel_at_period_end: boolean;
  text_used: number;
  tts_used: number;
  image_used: number;
  video_used: number;
}

export const TIER_LIMITS: Record<string, { text: number; tts: number; image: number; video: number }> = {
  free:      { text: 50,  tts: 10,  image: 3,   video: 0 },
  pro:       { text: 500, tts: 100, image: 30,  video: 5 },
  unlimited: { text: Infinity, tts: Infinity, image: Infinity, video: Infinity },
};

export function getTierLimits(tier: string) {
  return TIER_LIMITS[tier as keyof typeof TIER_LIMITS] || TIER_LIMITS.free;
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
    if (!res.ok) return { tier: 'free', period_start: '', period_end: null, cancel_at_period_end: false, text_used: 0, tts_used: 0, image_used: 0, video_used: 0 };
    return await res.json() as UserTier;
  } catch {
    return { tier: 'free', period_start: '', period_end: null, cancel_at_period_end: false, text_used: 0, tts_used: 0, image_used: 0, video_used: 0 };
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
