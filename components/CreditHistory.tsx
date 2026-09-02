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

  const shown = all
    .filter(e => monthKey(new Date(e.created_at)) === selKey)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  const btn = 'p-1 text-zinc-500 hover:text-neon-cyan transition active:scale-90 disabled:opacity-30 disabled:pointer-events-none';
  const col = {
    time: 'w-[118px] shrink-0',
    action: 'flex-[3] min-w-0',
    source: 'flex-[2] min-w-0',
    credits: 'w-10 shrink-0 text-left',
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* header line with month navigation */}
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] text-zinc-600 font-mono">Credit History · <span className="text-zinc-500">{monthLabel}</span></p>
        <div className="flex items-center gap-1">
          <button onClick={() => setMonthOffset(o => o - 1)} aria-label="Previous month" className={btn}><ChevronLeft size={12} /></button>
          <button onClick={() => setMonthOffset(o => Math.min(0, o + 1))} disabled={monthOffset >= 0} aria-label="Next month" className={btn}><ChevronRight size={12} /></button>
        </div>
      </div>

      {/* column headers (pr-2 keeps them aligned with the scrollable rows below) */}
      <div className="flex items-center gap-2 text-[8px] text-zinc-600 font-mono uppercase tracking-widest pb-1 border-b border-zinc-900 pr-2">
        <span className={col.time}>Time</span>
        <span className={col.action}>Action</span>
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
            <div key={i} className="flex items-center gap-2 text-[9px] font-mono py-1">
              <span className={`${col.time} text-zinc-600`}>{fmtTimestamp(e.created_at)}</span>
              <span className={`${col.action} truncate ${e.type === 'renewal' ? 'text-zinc-600' : 'text-zinc-400'}`}>{labelFor(e)}</span>
              <span className={`${col.source} text-zinc-600 truncate`}>{e.book || '—'}</span>
              <span className={`${col.credits} ${e.delta >= 0 ? 'text-neon-cyan' : 'text-zinc-500'}`}>{e.delta >= 0 ? '+' : ''}{e.delta}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
