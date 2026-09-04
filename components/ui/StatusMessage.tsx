import React from 'react';
import { AlertTriangle, Loader2, CheckCircle2, type LucideIcon } from 'lucide-react';

// ============================================================================
// Single source of truth for every transient USER-FACING TIP (error, warning,
// success, progress, empty/idle, and the credits HAZARD notice). Fixes one
// color + glyph + font-size per message type and always centres the message in
// its panel, so the whole app speaks with one visual voice.
//
//   error    → neon-red     ⚠   14px mono
//   warning  → neon-amber   ⚠   14px mono   (soft/transient caution)
//   hazard   → neon-yellow  ⚠   14px mono   (credits: distinct action-needed signal + CTA)
//   success  → emerald      ✓   14px mono
//   progress → neon-cyan    ⟳   14px mono   (spins)
//   empty    → zinc-500     (caller icon) label 14px + sub 12px mono
//
// This is TIP chrome only — it never renders book content.
// ============================================================================

export type StatusVariant = 'error' | 'warning' | 'success' | 'progress' | 'hazard' | 'empty';

const VARIANT: Record<StatusVariant, { color: string; Icon: LucideIcon | null; spin?: boolean; btn: string }> = {
  error:    { color: 'text-neon-red',    Icon: AlertTriangle, btn: 'border-neon-red/40 text-neon-red hover:bg-neon-red/15 bg-neon-red/5' },
  warning:  { color: 'text-neon-amber',   Icon: AlertTriangle, btn: 'border-neon-amber/40 text-neon-amber hover:bg-neon-amber/15 bg-neon-amber/5' },
  hazard:   { color: 'text-neon-yellow',  Icon: AlertTriangle, btn: 'border-neon-yellow/40 text-neon-yellow hover:bg-neon-yellow/15 bg-neon-yellow/5' },
  success:  { color: 'text-emerald-400', Icon: CheckCircle2,  btn: 'border-emerald-400/40 text-emerald-400 hover:bg-emerald-400/15 bg-emerald-400/5' },
  progress: { color: 'text-neon-cyan',   Icon: Loader2, spin: true, btn: 'border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/15 bg-neon-cyan/5' },
  empty:    { color: 'text-zinc-500',    Icon: null, btn: 'border-zinc-700 text-zinc-400 hover:bg-zinc-800' },
};

interface Props {
  variant: StatusVariant;
  title?: React.ReactNode;   // primary line (14px, variant colour)
  sub?: React.ReactNode;     // secondary line (12px, zinc)
  icon?: LucideIcon;         // override glyph (empty states pass their module icon)
  iconSize?: number;
  action?: { label: string; onClick: () => void };
  className?: string;
  /** Compact single-line form for tight spots (e.g. chat input hint). */
  inline?: boolean;
}

/** A centred, type-consistent status tip. Drop it into any panel; it centres itself. */
export const StatusMessage: React.FC<Props> = ({ variant, title, sub, icon, iconSize, action, className = '', inline = false }) => {
  const v = VARIANT[variant];
  const Icon = icon || v.Icon;
  const size = iconSize ?? (inline ? 14 : variant === 'empty' ? 24 : 18);

  if (inline) {
    return (
      <div className={`flex items-center justify-center gap-1.5 text-sm font-mono ${v.color} ${className}`}>
        {Icon && <Icon size={size} className={v.spin ? 'animate-spin shrink-0' : 'shrink-0'} />}
        {title && <span>{title}</span>}
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center justify-center text-center gap-2 px-4 ${className}`}>
      {Icon && <Icon size={size} className={`${v.color} ${v.spin ? 'animate-spin' : ''}`} />}
      {title && <p className={`text-sm font-mono ${v.color}`}>{title}</p>}
      {sub && <p className="text-xs font-mono text-zinc-500 max-w-xs leading-relaxed">{sub}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className={`mt-1 px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest rounded-sm border transition active:scale-[0.98] ${v.btn}`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
};
