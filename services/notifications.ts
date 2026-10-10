// Local-only notifications MVP. Three sources merged into one list:
//   - 'update' : app announcements shipped in ANNOUNCEMENTS below (add one + deploy to post it).
//   - 'bonus'  : derived — a jump in the live bonus_credits balance = a grant.
//   - 'usage'  : derived — crossing 90% of the monthly allowance, fired once per billing period.
// Read / cleared state + the derived-source trackers live in localStorage (no backend; no cross-device
// sync — that's the Phase-2 upgrade). Each notif has a STABLE id that keys its read/cleared state.
import { UserTier, TIER_CREDITS } from './stripe';
import { fetchCreditHistory, CreditHistoryEntry } from './supabase';

// 'billing' = Pro subscribe/cancel/end + pack purchase/refund (same amber color as 'bonus').
export type NotifType = 'update' | 'bonus' | 'usage' | 'billing';
export interface Notif { id: string; type: NotifType; title: string; preview: string; ts: number; }
export interface NotifView extends Notif { read: boolean; }

// ── App updates (edit here, then deploy, to post one). Keep ids unique + stable. ──
// Each update names the SUBJECT it concerns + the detail; the title/preview are built from one
// template so every announcement reads consistently:  title "Update on {subject}" · preview
// "{subject} has been updated, {text}".
interface UpdateDef { id: string; subject: string; text: string; ts: number; }
const UPDATES: UpdateDef[] = [
  { id: 'u-2026-10-03-chat-mobile', subject: 'AI_ASSISTANT', text: 'the history "…" menu, the low-credits notice and its Upgrade button now behave properly on small screens.', ts: Date.parse('2026-10-03T16:30:00Z') },
  { id: 'u-2026-10-03-mobile-check', subject: 'Mobile layout', text: 'the full-text search box and the catalogue unread dot have been resized for small screens.', ts: Date.parse('2026-10-03T16:00:00Z') },
  { id: 'u-2026-10-03-my-inbox', subject: 'MY_INBOX', text: 'your new notification center for app updates, bonus-credit grants and usage alerts now lives in the sidebar.', ts: Date.parse('2026-10-03T00:00:00Z') },
  { id: 'u-2026-10-02-genfiles-swipe', subject: 'GEN_FILES', text: 'swipe a file row left to reveal Sync, Export, Share and Delete — the row now shows the full file title.', ts: Date.parse('2026-10-02T00:00:00Z') },
];
export const ANNOUNCEMENTS: Notif[] = UPDATES.map((u): Notif => ({
  id: u.id,
  type: 'update',
  title: `Update on ${u.subject}`,
  preview: `${u.subject} has been updated, ${u.text}`,
  ts: u.ts,
}));

const K_ITEMS = 'db_notif_items_v1';        // materialized derived notifs (bonus/usage)
const K_READ = 'db_notif_read_v1';          // string[] of read ids
const K_CLEARED = 'db_notif_cleared_v1';    // string[] of cleared ids
const K_BONUS = 'db_notif_bonus_seen_v1';   // last-seen bonus balance (number as string)
const K_USAGE = 'db_notif_usage_period_v1'; // period_start already warned at 90%
const K_TOASTED = 'db_notif_toasted_v1';    // announcement ids already popped as a toast
const K_LEDGER = 'db_notif_ledger_cursor_v1'; // newest credit_ledger created_at already turned into notifs

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

  // Bonus/credit grants now come from the credit_ledger (syncAccountNotifs) so we can label
  // "Free credits carried over" vs a referral/manual grant. Here we only keep the last-seen balance
  // for the cross-device merge; we no longer synthesize the bonus notif from the raw delta.
  localStorage.setItem(K_BONUS, String(tier.bonus_credits || 0));

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

// Map one credit_ledger row to a notification (or null if it isn't notification-worthy, e.g. a
// consume/renewal row). Bonus grants distinguish carryover from a referral/manual grant by reason.
function notifForLedgerRow(h: CreditHistoryEntry): Notif | null {
  const id = `acct-${h.created_at}`;              // stable per row → de-dupes across devices
  const ts = Date.parse(h.created_at) || Date.now();
  const n = Math.abs(h.delta);
  const r = (h.reason || '').toLowerCase();
  if ((h.type === 'bonus' || h.type === 'earn') && h.delta > 0) {
    if (r.includes('carried over') || r.includes('carry'))
      return { id, type: 'bonus', title: 'Free credits carried over',
        preview: `${n} of your free credits were carried over as permanent bonus credits when you upgraded — they're used after your monthly credits and never expire.`, ts };
    return { id, type: 'bonus', title: 'Bonus credits added',
      preview: `${n} bonus credits were added to your account (e.g. a referral reward) — they're used after your monthly credits and never expire.`, ts };
  }
  if (h.type === 'purchase' && h.delta > 0)
    return { id, type: 'billing', title: 'Credit pack added', preview: `${n} pack credits were added to your account — they never expire.`, ts };
  if (h.type === 'refund')
    return { id, type: 'billing', title: 'Pack refunded', preview: `${n} pack credits were refunded.`, ts };
  if (h.type === 'subscription') {
    const title = /ended|revert/.test(r) ? 'Subscription ended' : /cancel/.test(r) ? 'Pro set to cancel' : 'Welcome to Pro';
    return { id, type: 'billing', title, preview: h.reason || 'Your subscription was updated.', ts };
  }
  return null;
}

// Account-event notifications derived from the credit_ledger: carryover/bonus grants + Pro
// subscribe/cancel/end + pack purchase/refund. First call just BASELINES the cursor (so a new user
// isn't flooded with historical rows); later calls notify only genuinely new rows.
export async function syncAccountNotifs(userId: string | null | undefined): Promise<Notif[]> {
  if (!userId) return [];
  let history: CreditHistoryEntry[];
  try { history = await fetchCreditHistory(userId, 30); } catch { return []; }
  const rows = history.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const newest = rows.length ? rows[rows.length - 1].created_at : null;
  const cursor = localStorage.getItem(K_LEDGER);
  if (cursor === null) { if (newest) localStorage.setItem(K_LEDGER, newest); return []; } // baseline only
  const list = items();
  const existing = new Set(list.map(i => i.id));
  const fresh: Notif[] = [];
  for (const h of rows) {
    if (h.created_at <= cursor) continue;
    const notif = notifForLedgerRow(h);
    if (notif && !existing.has(notif.id)) { list.push(notif); fresh.push(notif); }
  }
  if (newest) localStorage.setItem(K_LEDGER, newest);
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

// ── Cross-device sync (user_notifications). The client mirrors the localStorage state to Supabase and
// merges a remote row in on login. Read/cleared are UNION-merged; derived items merge by id; bonus_seen
// takes the MAX and usage_period the LATEST, so a grant/warning fires once per account, not per device.
export interface NotifSyncState { read: string[]; cleared: string[]; items: Notif[]; bonusSeen: number | null; usagePeriod: string | null; }

export function getLocalNotifState(): NotifSyncState {
  const b = localStorage.getItem(K_BONUS);
  return { read: arr(K_READ), cleared: arr(K_CLEARED), items: items(), bonusSeen: b !== null ? Number(b) : null, usagePeriod: localStorage.getItem(K_USAGE) };
}

export function mergeRemoteNotifState(remote: NotifSyncState | null): void {
  if (!remote) return;
  setArr(K_READ, [...new Set([...arr(K_READ), ...(remote.read || [])])]);
  setArr(K_CLEARED, [...new Set([...arr(K_CLEARED), ...(remote.cleared || [])])]);
  const byId = new Map<string, Notif>();
  for (const n of [...items(), ...(remote.items || [])]) byId.set(n.id, n);
  setItems([...byId.values()]);
  const lb = localStorage.getItem(K_BONUS);
  const mergedBonus = Math.max(lb !== null ? Number(lb) : -Infinity, remote.bonusSeen ?? -Infinity);
  if (isFinite(mergedBonus)) localStorage.setItem(K_BONUS, String(mergedBonus));
  const later = (remote.usagePeriod || '') > (localStorage.getItem(K_USAGE) || '') ? remote.usagePeriod : localStorage.getItem(K_USAGE);
  if (later) localStorage.setItem(K_USAGE, later);
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
