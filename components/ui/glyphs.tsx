import React from 'react';

/**
 * A few bespoke glyphs applied selectively over the lucide base:
 *  - Engine  → CPU/processor (LLM_Engines, AI assistant)
 *  - Privacy → shield with keyhole (Account_Info, auth)
 *  - Pro     → faceted diamond (premium / Pro plan)
 * Same size/className API as lucide; uses currentColor (color unchanged).
 */
type P = { size?: number | string; className?: string; [k: string]: any };

const g = (children: React.ReactNode) =>
  function Glyph({ size = 24, className = '', ...rest }: P) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        {...rest}
      >
        <g transform="translate(-1.44 -1.44) scale(1.12)">{children}</g>
      </svg>
    );
  };

export const Engine = g(
  <>
    <rect x="7" y="7" width="10" height="10" rx="1" />
    <rect x="10" y="10" width="4" height="4" />
    <path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3" />
  </>
);

export const Privacy = g(
  <>
    <path d="M12 3l6.8 2.4v6.1c0 4.3-2.9 7.4-6.8 8.9-3.9-1.5-6.8-4.6-6.8-8.9V5.4z" />
    <path d="M8.2 6.4L12 5.1l3.8 1.3" opacity=".45" />
    <circle cx="12" cy="10.6" r="1.7" />
    <path d="M12 12.3v3" />
  </>
);

export const Pro = g(
  <>
    <path d="M6 3.4h12l3.6 5.7L12 20.6 2.4 9.1z" />
    <path d="M2.4 9.1h19.2" />
    <path d="M6 3.4l2.4 5.7L12 3.4l3.6 5.7L18 3.4M8.4 9.1L12 20.6l3.6-11.5" />
  </>
);
