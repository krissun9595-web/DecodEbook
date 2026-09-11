import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchCreditHistory, CreditHistoryEntry } from '../services/supabase';

const ACTION_LABELS: Record<string, string> = {
  translate: 'Translation',
  translateFigureText: 'Figure translation',
  chat: 'Chat',
  quickDefinition: 'Definition',
  analyzeBookStructure: 'Book analysis',
  extractChapterText: 'Content extraction',
  extractConcepts: 'Concept extraction',
  podcastScript: 'Podcast script',
  podcastAudio: 'Audio generation',
  tts: 'Audio generation',
  generateImage: 'Image generation',
  redrawFigureTranslated: 'Figure redraw',
  videoPrompt: 'Video prompt',
  videoVeo: 'Video generation',
  videoSeedance: 'Video generation',
  videoSeedanceFast: 'Video generation',
};

function labelFor(e: CreditHistoryEntry): string {
  if (e.type === 'consume') {
    const key = e.reason?.startsWith('text:') ? 'translate' : e.reason;
    return ACTION_LABELS[key] || e.reason || 'Usage';
  }
  if (e.type === 'purchase') return 'Credit pack';
  if (e.type === 'bonus' || e.type === 'earn') return e.reason || 'Bonus credits';
  if (e.type === 'renewal') return e.reason || 'Monthly renewal';
  return e.reason || e.type;
}

// The friendly label a consumption row groups under (all 'text:*' + translate → "Translation", etc.).
const labelKeyFor = (action: string): string => {
  const key = action?.startsWith('text:') ? 'translate' : action;
  return ACTION_LABELS[key] || action || 'Usage';
};

interface DisplayRow { created_at: string; label: string; book?: string; delta: number; type: string; mode?: string; }

// Balanced vs Premium — only for functions the mode toggle actually switches. Fixed internal steps
// (book analysis, concept extraction, video prompt) and TTS always use the same model regardless of
// mode, so they'd be misleading as "Balanced"; they get a blank (—). For the mode-switched ones the
// tier is read from the served model: gemini-pro / pro-image / veo = Premium, else Balanced.
const MODE_SWITCHED = new Set(['translate', 'chat', 'quickDefinition', 'podcastScript', 'generateImage', 'redrawFigureTranslated', 'videoVeo', 'videoSeedance', 'videoSeedanceFast']);
function modeForRow(action?: string, model?: string): string {
  if (!model || model === '__partial__') return '';
  const key = action?.startsWith('text:') ? 'translate' : (action || '');
  if (!MODE_SWITCHED.has(key)) return '';
  const m = model.toLowerCase();
  if (/tts/.test(m)) return '';
  if (/gemini[-\d.]*pro|pro-image|veo/.test(m)) return 'Premium';
  return 'Balanced';
}

// One "generate" fires many API calls → many rows. Collapse a single EXECUTION's rows into ONE line:
// primarily by its per-execution session id (so a re-run or a different page is its OWN immutable line,
// never merged with a previous one), and — only for legacy/session-less rows — by a tight label+book
// burst as a fallback. Tag "(Partial)" when a stop-marker belongs to the same execution. Additions pass
// through unchanged. This keeps history readable without exposing per-batch amounts.
const GROUP_GAP_MS = 5 * 60 * 1000;
function buildDisplayRows(entries: CreditHistoryEntry[]): DisplayRow[] {
  const consume = entries.filter(e => e.type === 'consume');
  const markers = entries.filter(e => e.type === 'partial-marker');
  const others = entries.filter(e => e.type !== 'consume' && e.type !== 'partial-marker');
  const rows: DisplayRow[] = [];

  // 1) Session-tagged rows → one line PER EXECUTION (exact, immutable). Label is the session prefix.
  const bySession = new Map<string, CreditHistoryEntry[]>();
  const sessionless: CreditHistoryEntry[] = [];
  for (const e of consume) {
    if (e.session) { if (!bySession.has(e.session)) bySession.set(e.session, []); bySession.get(e.session)!.push(e); }
    else sessionless.push(e);
  }
  for (const [sid, es] of bySession) {
    const label = sid.split('#')[0] || labelKeyFor(es[0].reason);
    const credits = es.reduce((s, e) => s + -e.delta, 0);
    const latest = es.reduce((t, e) => (e.created_at > t ? e.created_at : t), es[0].created_at);
    const partial = markers.some(m => m.session === sid);
    rows.push({ created_at: latest, label: label + (partial ? ' (Partial)' : ''), book: es[0].book, delta: -credits, type: 'consume', mode: modeForRow(es[0].reason, (es.find(e => e.model) || es[0]).model) });
  }

  // 2) Legacy / single-call rows (no session) → burst-group by label+book as a fallback.
  const asc = [...sessionless].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  interface G { label: string; book?: string; startMs: number; endMs: number; endIso: string; credits: number; model?: string; action?: string; }
  const groups: G[] = [];
  const lastIdx = new Map<string, number>();
  for (const e of asc) {
    const label = labelKeyFor(e.reason);
    const k = `${label}|${e.book || ''}`;
    const ms = new Date(e.created_at).getTime();
    const gi = lastIdx.get(k);
    if (gi != null && ms - groups[gi].endMs <= GROUP_GAP_MS) {
      groups[gi].endMs = ms; groups[gi].endIso = e.created_at; groups[gi].credits += -e.delta;
    } else {
      groups.push({ label, book: e.book, startMs: ms, endMs: ms, endIso: e.created_at, credits: -e.delta, model: e.model, action: e.reason });
      lastIdx.set(k, groups.length - 1);
    }
  }
  for (const g of groups) {
    const partial = markers.some(m => {
      if (m.session || labelKeyFor(m.reason) !== g.label || (m.book || '') !== (g.book || '')) return false;
      const t = new Date(m.created_at).getTime();
      return t >= g.startMs - GROUP_GAP_MS && t <= g.endMs + GROUP_GAP_MS;
    });
    rows.push({ created_at: g.endIso, label: g.label + (partial ? ' (Partial)' : ''), book: g.book, delta: -g.credits, type: 'consume', mode: modeForRow(g.action, g.model) });
  }

  // 3) additions (packs / bonus / renewal) pass through unchanged.
  for (const o of others) rows.push({ created_at: o.created_at, label: labelFor(o), book: o.book, delta: o.delta, type: o.type });
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// YYYY-MM-DD HH:MM:SS
export function fmtTimestamp(ts: string | number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const monthKey = (d: Date) => d.getFullYear() * 12 + d.getMonth();

export function CreditHistory({ userId, renewal }: { userId?: string; renewal?: { at: string; credits: number; label?: string } }) {
  const [rows, setRows] = useState<CreditHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [monthOffset, setMonthOffset] = useState(0); // 0 = current, -1 = last month …

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    fetchCreditHistory(userId, 500).then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, [userId]);

  if (!userId) return null;

  const all: CreditHistoryEntry[] = (renewal && renewal.at && isFinite(renewal.credits))
    ? [...rows, { delta: renewal.credits, type: 'renewal', reason: renewal.label || 'Monthly renewal', created_at: renewal.at }]
    : rows;

  const now = new Date();
  const selKey = monthKey(now) + monthOffset;
  const monthLabel = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  const shown = buildDisplayRows(all.filter(e => monthKey(new Date(e.created_at)) === selKey));

  const btn = 'p-1 text-zinc-500 hover:text-neon-cyan transition active:scale-90 disabled:opacity-30 disabled:pointer-events-none';
  const col = {
    time: 'w-[118px] shrink-0',
    action: 'flex-[3] min-w-0',
    mode: 'w-[58px] shrink-0',   // Balanced / Premium tier for this charge
    source: 'flex-[4] min-w-0',  // book title
    credits: 'w-10 shrink-0 text-left',
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* header line with month navigation */}
      <div className="flex items-center justify-between mb-1">
        <p data-gap="ch-title" className="text-[10px] text-zinc-600 font-mono">Credit History · <span className="text-zinc-500">{monthLabel}</span></p>
        <div className="flex items-center gap-1">
          <button onClick={() => setMonthOffset(o => o - 1)} aria-label="Previous month" className={btn}><ChevronLeft size={12} /></button>
          <button onClick={() => setMonthOffset(o => Math.min(0, o + 1))} disabled={monthOffset >= 0} aria-label="Next month" className={btn}><ChevronRight size={12} /></button>
        </div>
      </div>

      {/* column headers (pr-2 keeps them aligned with the scrollable rows below) */}
      <div data-gap="ch-hd" className="flex items-center gap-3 text-[8px] text-zinc-600 font-mono uppercase tracking-widest pb-1 border-b border-zinc-900 pr-2">
        <span className={col.time}>Time</span>
        <span className={col.action}>Action</span>
        <span className={col.mode}>Mode</span>
        <span className={col.source}>Source</span>
        <span className={col.credits}>Credits</span>
      </div>

      {loading ? (
        <p className="text-[9px] text-zinc-600 font-mono py-2">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-[9px] text-zinc-600 font-mono py-2">No activity this month.</p>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar divide-y divide-zinc-900/60 pr-2">
          {shown.map((e, i) => (
            <div key={i} className="flex items-center gap-3 text-[9px] font-mono py-[3px]">
              <span className={`${col.time} text-zinc-600`}>{fmtTimestamp(e.created_at)}</span>
              <span className={`${col.action} truncate ${e.type === 'renewal' ? 'text-zinc-600' : 'text-zinc-500'}`}>{e.label}</span>
              <span className={`${col.mode} truncate ${e.mode === 'Premium' ? 'text-neon-cyan' : 'text-zinc-600'}`}>{e.mode || '—'}</span>
              <span className={`${col.source} text-zinc-600 truncate`}>{e.book || '—'}</span>
              <span className={`${col.credits} ${e.delta >= 0 ? 'text-neon-cyan' : 'text-zinc-500'}`}>{e.delta >= 0 ? '+' : ''}{e.delta}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
