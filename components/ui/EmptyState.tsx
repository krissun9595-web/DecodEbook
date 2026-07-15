import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  label: string;
  sublabel?: string;
  /** extra classes on the icon (e.g. animate-pulse) */
  iconClassName?: string;
  /** classes on the outer wrapper (layout: flex-1, h-full, content-panel, etc.) */
  className?: string;
}

/**
 * Shared module empty state — a centered icon + tech label + optional sub-line.
 * One treatment across Voice_Synth / Net_Cast / Visual_Core / Notebook / Files so
 * empty modules read as one system. Callers own the outer layout via `className`.
 */
export const EmptyState = ({ icon: Icon, label, sublabel, iconClassName = '', className = '' }: EmptyStateProps) => (
  <div className={`flex flex-col items-center justify-center text-zinc-600 gap-4 font-mono ${className}`}>
    <Icon size={48} className={`opacity-20 ${iconClassName}`} />
    <div className="text-center space-y-1">
      <p className="text-xs uppercase tracking-[0.3em]">{label}</p>
      {sublabel && <p className="text-[10px] opacity-50 max-w-xs">{sublabel}</p>}
    </div>
  </div>
);
