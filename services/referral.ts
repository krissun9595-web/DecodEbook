import { getSession } from './supabase';

async function authHeaders(): Promise<Record<string, string>> {
  const session = await getSession();
  return session?.access_token
    ? { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

export interface ReferralStats {
  code: string | null;
  clicks: number;
  click_credits: number;
  click_credits_cap: number;
  signups: number;
  activated: number;
  signup_credits: number;
  bonus_balance: number;
  total_earned: number;
}

export async function getReferralCode(): Promise<string | null> {
  try {
    const headers = await authHeaders();
    const res = await fetch('/api/ref/code', { headers });
    if (!res.ok) return null;
    const data = await res.json() as { code: string };
    return data.code;
  } catch {
    return null;
  }
}

export async function getReferralStats(): Promise<ReferralStats | null> {
  try {
    const headers = await authHeaders();
    const res = await fetch('/api/ref/stats', { headers });
    if (!res.ok) return null;
    return await res.json() as ReferralStats;
  } catch {
    return null;
  }
}

export async function trackReferralClick(code: string): Promise<string | null> {
  try {
    const res = await fetch('/api/ref/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { referrer_id: string };
    return data.referrer_id;
  } catch {
    return null;
  }
}

export async function registerReferralSignup(referrerId: string): Promise<void> {
  try {
    const headers = await authHeaders();
    await fetch('/api/ref/signup', {
      method: 'POST',
      headers,
      body: JSON.stringify({ referrer_id: referrerId }),
    });
  } catch {}
}

export function getShareUrl(code: string): string {
  return `${window.location.origin}?ref=${code}`;
}

export function shareOnTwitter(code: string) {
  const url = getShareUrl(code);
  const text = 'I\'ve been using DecodEbook to read books with AI — translation, TTS, mind maps, and more. Try it free:';
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank');
}

export function shareOnFacebook(code: string) {
  const url = getShareUrl(code);
  window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, '_blank');
}

export function shareOnLinkedIn(code: string) {
  const url = getShareUrl(code);
  window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`, '_blank');
}
