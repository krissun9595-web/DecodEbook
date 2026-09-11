import React, { useState, useRef, useEffect } from 'react';
import { Info } from 'lucide-react';

// Small header affordance: an Info glyph (matches the "Info" mark on /proposal) revealing a
// structured help popover. CLICK toggles it PINNED open (so the tall content scrolls reliably —
// a pure hover popover dropped as you moved toward its scrollbar); hover still previews it.
// Click-outside or Esc closes. Placed to the LEFT of a modal's close button; drops down-and-left.
export const InfoTooltip: React.FC<{ children: React.ReactNode; label?: string }> = ({ children, label = 'Info' }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative group flex items-center">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={`transition-colors focus:outline-none ${open ? 'text-neon-cyan' : 'text-zinc-500 hover:text-neon-cyan focus:text-neon-cyan'}`}
      >
        <Info size={20} />
      </button>
      {/* top-full with NO gap so a hover-preview is contiguous (reachable to scroll); when pinned open
          it's pointer-events-auto regardless of hover, so the scrollbar always responds. */}
      <div
        role="tooltip"
        className={`absolute right-0 top-full w-80 max-w-[calc(100vw-2.5rem)] max-h-[60vh] overflow-y-auto custom-scrollbar bg-void-1 border border-zinc-800 rounded-lg p-4 shadow-[0_0_30px_rgba(0,0,0,0.85)] text-left transition-all duration-150 z-[60] ${
          open
            ? 'opacity-100 visible translate-y-0 pointer-events-auto'
            : 'opacity-0 invisible translate-y-1 pointer-events-none group-hover:opacity-100 group-hover:visible group-hover:translate-y-0 group-hover:pointer-events-auto'
        }`}
      >
        {children}
      </div>
    </div>
  );
};

// One titled section inside an InfoTooltip — a small caption + body, styled like the panel headers.
export const InfoSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="mb-3 last:mb-0">
    <div className="text-[10px] font-bold uppercase tracking-widest font-mono text-neon-cyan mb-1">{title}</div>
    <div className="text-[11px] leading-relaxed text-zinc-400 space-y-1">{children}</div>
  </div>
);
