import React from 'react';
import { AlertTriangle, Loader2, CheckCircle2, type LucideIcon } from 'lucide-react';

// ============================================================================
// Single source of truth for every transient USER-FACING TIP (error, warning,
// success, progress, empty/idle, and the credits HAZARD notice). Fixes one
// color + glyph + font-size per message type and always centres the message in
// its panel, so the whole app speaks with one visual voice. Two-tone: neon-red
// for failures, neon-cyan ("neon-blue") for everything else.
//
//   error    → neon-red   ⚠   14px mono   (failures)
//   warning  → neon-cyan  ⚠   14px mono   (soft/transient caution)
//   hazard   → neon-cyan  ⚠   14px mono   (credits: action-needed + CTA)
//   success  → neon-cyan  ✓   14px mono
//   progress → neon-cyan  ⟳   14px mono   (spins)
//   empty    → neon-cyan  (caller icon) label 14px + sub 12px mono
//
// This is TIP chrome only — it never renders book content.
// ============================================================================

export type StatusVariant = 'error' | 'warning' | 'success' | 'progress' | 'hazard' | 'empty';

// Two-tone scheme: neon-red for ERROR (failures); neon-cyan ("neon-blue") for everything else.
const CYAN_BTN = 'border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/15 bg-neon-cyan/5';
const VARIANT: Record<StatusVariant, { color: string; Icon: LucideIcon | null; spin?: boolean; btn: string }> = {
  error:    { color: 'text-neon-red',  Icon: AlertTriangle, btn: 'border-neon-red/40 text-neon-red hover:bg-neon-red/15 bg-neon-red/5' },
  warning:  { color: 'text-neon-cyan', Icon: AlertTriangle, btn: CYAN_BTN },
  hazard:   { color: 'text-neon-cyan', Icon: AlertTriangle, btn: CYAN_BTN },
  success:  { color: 'text-neon-cyan', Icon: CheckCircle2,  btn: CYAN_BTN },
  progress: { color: 'text-neon-cyan', Icon: Loader2, spin: true, btn: CYAN_BTN },
  empty:    { color: 'text-neon-cyan', Icon: null, btn: CYAN_BTN },
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
      <div className={`flex items-center justify-center gap-1.5 text-sm font-tech ${v.color} ${className}`}>
        {Icon && <Icon size={size} className={v.spin ? 'animate-spin shrink-0' : 'shrink-0'} />}
        {title && <span>{title}</span>}
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center justify-center text-center gap-2 px-4 ${className}`}>
      {Icon && <Icon size={size} className={`${v.color} ${v.spin ? 'animate-spin' : ''}`} />}
      {title && <p className={`text-sm font-tech ${v.color}`}>{title}</p>}
      {sub && <p className="text-xs font-tech text-zinc-500 max-w-xs leading-relaxed">{sub}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className={`mt-1 px-3 py-1.5 text-[10px] font-tech uppercase tracking-widest rounded-sm border transition active:scale-[0.98] ${v.btn}`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
};
