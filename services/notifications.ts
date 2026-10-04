// Local-only notifications MVP. Three sources merged into one list:
//   - 'update' : app announcements shipped in ANNOUNCEMENTS below (add one + deploy to post it).
//   - 'bonus'  : derived — a jump in the live bonus_credits balance = a grant.
//   - 'usage'  : derived — crossing 90% of the monthly allowance, fired once per billing period.
// Read / cleared state + the derived-source trackers live in localStorage (no backend; no cross-device
// sync — that's the Phase-2 upgrade). Each notif has a STABLE id that keys its read/cleared state.
import { UserTier, TIER_CREDITS } from './stripe';

export type NotifType = 'update' | 'bonus' | 'usage';
export interface Notif { id: string; type: NotifType; title: string; preview: string; ts: number; }
export interface NotifView extends Notif { read: boolean; }

// ── App updates (edit here, then deploy, to post one). Keep ids unique + stable. ──
export const ANNOUNCEMENTS: Notif[] = [
  {
    id: 'u-2026-10-03-chat-mobile',
    type: 'update',
    title: 'Chat tuned for mobile',
    preview: 'The history "…" menu, the low-credits notice and its Upgrade button now behave properly on small screens — open a chat to try it.',
    ts: Date.parse('2026-10-03T16:30:00Z'),
  },
  {
    id: 'u-2026-10-03-mobile-check',
    type: 'update',
    title: 'Mobile layout refresh',
    preview: 'The full-text search box and the catalogue unread dot have been resized for mobile — swipe open the sidebar to take a look.',
    ts: Date.parse('2026-10-03T16:00:00Z'),
  },
  {
    id: 'u-2026-10-03-my-inbox',
    type: 'update',
    title: 'Introducing My_Inbox',
    preview: 'Your new notification center — app updates, bonus-credit grants, and usage alerts now live here in the sidebar.',
    ts: Date.parse('2026-10-03T00:00:00Z'),
  },
  {
    id: 'u-2026-10-02-genfiles-swipe',
    type: 'update',
    title: 'Gen_Files: swipe actions on mobile',
    preview: 'Swipe a file row left to reveal Sync, Export, Share and Delete — the row now shows the full file title.',
    ts: Date.parse('2026-10-02T00:00:00Z'),
  },
];

const K_ITEMS = 'db_notif_items_v1';        // materialized derived notifs (bonus/usage)
const K_READ = 'db_notif_read_v1';          // string[] of read ids
const K_CLEARED = 'db_notif_cleared_v1';    // string[] of cleared ids
const K_BONUS = 'db_notif_bonus_seen_v1';   // last-seen bonus balance (number as string)
const K_USAGE = 'db_notif_usage_period_v1'; // period_start already warned at 90%
const K_TOASTED = 'db_notif_toasted_v1';    // announcement ids already popped as a toast

const arr = (k: string): string[] => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
const setArr = (k: string, v: string[]) => localStorage.setItem(k, JSON.stringify(v));
const items = (): Notif[] => { try { return JSON.parse(localStorage.getItem(K_ITEMS) || '[]'); } catch { return []; } };
const setItems = (v: Notif[]) => localStorage.setItem(K_ITEMS, JSON.stringify(v));

// Fold live tier state into stored notifs. Returns the NEWLY-created ones (for a toast). Safe to call often.
export function syncDerivedNotifs(tier: UserTier | null): Notif[] {
  if (!tier) return [];
  const list = items();
  const fresh: Notif[] = [];
  const now = Date.now();

  // Bonus: balance is cumulative; an increase vs. last-seen means a grant just landed.
  const prevBonus = localStorage.getItem(K_BONUS);
  const curBonus = tier.bonus_credits || 0;
  if (prevBonus !== null) {
    const delta = curBonus - Number(prevBonus);
    if (delta > 0) {
      const n: Notif = { id: `bonus-${now}`, type: 'bonus', title: 'Bonus credits added',
        preview: `${delta} bonus credits were added to your account (e.g. carried over from your free credits when you upgraded, or a referral reward). They're used after your monthly credits and never expire.`, ts: now };
      list.push(n); fresh.push(n);
    }
  }
  localStorage.setItem(K_BONUS, String(curBonus));

  // 90% usage: fire once per billing period (period_start as the key; resets on renewal).
  const monthly = TIER_CREDITS[tier.tier] || 100;
  if (monthly > 0 && isFinite(monthly)) {
    const pct = (tier.credits_used || 0) / monthly;
    if (pct >= 0.9 && localStorage.getItem(K_USAGE) !== (tier.period_start || '')) {
      const n: Notif = { id: `usage90-${tier.period_start || now}`, type: 'usage', title: 'Monthly credits almost used up',
        preview: `You've used ${Math.min(100, Math.round(pct * 100))}% of your monthly credits. Upgrade or buy a credit pack to keep generating.`, ts: now };
      list.push(n); fresh.push(n);
      localStorage.setItem(K_USAGE, tier.period_start || '');
    }
  }

  if (fresh.length) setItems(list);
  return fresh;
}

export function listNotifs(): NotifView[] {
  const cleared = new Set(arr(K_CLEARED));
  const read = new Set(arr(K_READ));
  return [...ANNOUNCEMENTS, ...items()]
    .filter(n => !cleared.has(n.id))
    .sort((a, b) => b.ts - a.ts)
    .map(n => ({ ...n, read: read.has(n.id) }));
}

// Pop the NEWEST not-yet-toasted announcement once (as a transient push toast). Marks every current
// announcement toasted, so only the newest ever pops — the rest just live in the inbox. A future new
// announcement (not in K_TOASTED) will pop on the next load.
export function takeAnnouncementToast(): Notif | null {
  const toasted = new Set(arr(K_TOASTED));
  const cleared = new Set(arr(K_CLEARED));
  const fresh = ANNOUNCEMENTS
    .filter(a => !toasted.has(a.id) && !cleared.has(a.id))
    .sort((a, b) => b.ts - a.ts);
  setArr(K_TOASTED, ANNOUNCEMENTS.map(a => a.id));
  return fresh[0] || null;
}

export function unreadCount(): number { return listNotifs().filter(n => !n.read).length; }
export function markRead(id: string) { const r = new Set(arr(K_READ)); r.add(id); setArr(K_READ, [...r]); }
export function markAllRead() { setArr(K_READ, listNotifs().map(n => n.id)); }
export function clearNotif(id: string) { const c = new Set(arr(K_CLEARED)); c.add(id); setArr(K_CLEARED, [...c]); }

// YYYY-MM-DD for the row timestamp.
export function fmtDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
