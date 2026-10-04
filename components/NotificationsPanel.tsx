import { useEffect, useState } from 'react';
import { Bell, Megaphone, Gift, AlertTriangle, X, CheckCheck } from 'lucide-react';
import { CloseButton } from './ui/CloseButton';
import { listNotifs, markRead, markAllRead, clearNotif, fmtDay, NotifView } from '../services/notifications';

const TYPE_ICON: Record<string, { icon: typeof Bell; color: string }> = {
  update: { icon: Megaphone, color: 'text-neon-cyan' },
  bonus: { icon: Gift, color: 'text-neon-amber' },
  usage: { icon: AlertTriangle, color: 'text-neon-red' },
};

export function NotificationsPanel({ isOpen, onClose, onChange }: { isOpen: boolean; onClose: () => void; onChange: () => void }) {
  const [rows, setRows] = useState<NotifView[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const refresh = () => { setRows(listNotifs()); onChange(); };
  useEffect(() => { if (isOpen) setRows(listNotifs()); }, [isOpen]);
  if (!isOpen) return null;

  const hasUnread = rows.some(r => !r.read);

  return (
    <div role="dialog" aria-modal="true" aria-label="My Inbox" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in font-sans" onClick={onClose}>
      <div className="bg-void-1 border border-zinc-800 rounded-lg w-full max-w-2xl h-[90dvh] shadow-[0_0_50px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden animate-fade-in-up scale-in relative" onClick={e => e.stopPropagation()}>
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-neon-cyan to-neon-red"></div>

        <div className="px-5 md:px-6 py-[14px] md:py-[19px] border-b border-zinc-800 flex items-center justify-between shrink-0">
          <h2 className="text-xl font-black text-white uppercase tracking-widest font-mono">My_Inbox</h2>
          <div className="flex items-center gap-3">
            {hasUnread && (
              <button
                onClick={() => { markAllRead(); refresh(); }}
                className="!min-h-0 flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-zinc-500 hover:text-neon-cyan transition-colors"
                title="Mark all as read"
              >
                <CheckCheck size={12} /> Mark all read
              </button>
            )}
            <CloseButton onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          {rows.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-600 gap-2">
              <Bell size={28} />
              <p className="text-xs font-mono uppercase tracking-widest">No notifications</p>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-900">
              {rows.map(n => {
                const cfg = TYPE_ICON[n.type] || TYPE_ICON.update;
                const Icon = cfg.icon;
                return (
                  <li key={n.id}>
                    <div className="group flex items-start gap-3 px-5 md:px-6 py-3 hover:bg-zinc-900/40 transition-colors">
                      {/* unread dot */}
                      <span className={`mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full ${n.read ? 'bg-transparent' : 'bg-neon-cyan'}`} aria-label={n.read ? undefined : 'Unread'} />
                      <Icon size={15} className={`mt-0.5 shrink-0 ${cfg.color}`} />
                      <button
                        onClick={() => { setExpandedId(expandedId === n.id ? null : n.id); if (!n.read) { markRead(n.id); refresh(); } }}
                        className="flex-1 min-w-0 text-left !min-h-0"
                        aria-expanded={expandedId === n.id}
                      >
                        <div className="flex items-baseline gap-2">
                          <span className={`text-xs font-medium ${expandedId === n.id ? '' : 'truncate'} ${n.read ? 'text-zinc-400' : 'text-zinc-100'}`}>{n.title}</span>
                          <span className="ml-auto shrink-0 text-[9px] font-mono text-zinc-600 whitespace-nowrap">{fmtDay(n.ts)}</span>
                        </div>
                        <p className={`mt-0.5 text-[10px] text-zinc-500 leading-relaxed ${expandedId === n.id ? '' : 'line-clamp-2'}`}>{n.preview}</p>
                      </button>
                      <button
                        onClick={() => { clearNotif(n.id); refresh(); }}
                        className="shrink-0 p-1 !min-h-0 aspect-square flex items-center justify-center text-zinc-600 hover:text-neon-red rounded-sm transition-colors"
                        title="Clear"
                        aria-label="Clear notification"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
