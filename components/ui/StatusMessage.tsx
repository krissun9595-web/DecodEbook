import React from 'react';
import { AlertTriangle, CheckCircle2, type LucideIcon } from 'lucide-react';

// ============================================================================
// Single source of truth for every transient USER-FACING TIP (error, success,
// and the credits HAZARD notice). Fixes one color + glyph + font-size per
// message type and always centres the message in its panel, so the whole app
// speaks with one visual voice. Two-tone: neon-red for failures, neon-cyan
// ("neon-blue") for everything else.
//
//   error    → neon-red   ⚠   14px mono   (failures)
//   hazard   → neon-cyan  ⚠   14px mono   (credits: action-needed + CTA)
//   success  → neon-cyan  ✓   14px mono
//
// This is TIP chrome only — it never renders book content. (Idle/empty states
// use the separate <EmptyState/> component.)
// ============================================================================

export type StatusVariant = 'error' | 'success' | 'hazard';

// Two-tone scheme: neon-red for ERROR (failures); neon-cyan ("neon-blue") for everything else.
const CYAN_BTN = 'border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/15 bg-neon-cyan/5';
const VARIANT: Record<StatusVariant, { color: string; Icon: LucideIcon | null; btn: string }> = {
  error:    { color: 'text-neon-red',  Icon: AlertTriangle, btn: 'border-neon-red/40 text-neon-red hover:bg-neon-red/15 bg-neon-red/5' },
  hazard:   { color: 'text-neon-cyan', Icon: AlertTriangle, btn: CYAN_BTN },
  success:  { color: 'text-neon-cyan', Icon: CheckCircle2,  btn: CYAN_BTN },
};

interface Props {
  variant: StatusVariant;
  title?: React.ReactNode;   // primary line (14px, variant colour)
  sub?: React.ReactNode;     // secondary line (12px, zinc)
  icon?: LucideIcon;         // override glyph
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
  const size = iconSize ?? (inline ? 14 : 18);

  if (inline) {
    return (
      <div className={`flex items-center justify-center gap-1.5 text-sm font-tech ${v.color} ${className}`}>
        {Icon && <Icon size={size} className="shrink-0" />}
        {title && <span>{title}</span>}
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center justify-center text-center gap-2 px-4 ${className}`}>
      {Icon && <Icon size={size} className={v.color} />}
      {title && <p className={`text-sm font-tech ${v.color}`}>{title}</p>}
      {sub && <p className="text-xs font-tech text-zinc-500 max-w-xs leading-relaxed">{sub}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className={`mt-1 flex items-center justify-center w-[200px] h-9 sm:w-auto sm:h-auto px-3 py-1.5 !min-h-0 text-[10px] font-tech uppercase tracking-widest rounded-sm border transition active:scale-[0.98] ${v.btn}`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
};
