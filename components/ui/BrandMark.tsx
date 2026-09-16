import React from 'react';

/**
 * The DecodEbook logo lockup — `>_` glyph + Share Tech Mono wordmark.
 *
 * `>_` is the app's master mark (matches prod / public/icon.svg): the literal
 * SVG `viewBox="2 7 21 14"`, `strokeWidth 2`, square caps, miter joins, blinking
 * underscore — rendered em-relative so it scales with the wordmark font-size.
 * At the stacked height (0.639·em box) this reproduces the prod upload `>_`
 * exactly: chevron 0.456·em, stroke 0.091·em, `>`→`_` gap 0.137·em, chevron/cap 0.65.
 *
 * Wordmark: authentic single-weight Share Tech Mono; weight matched to prod's
 * synthetic-bold stem via a centered text-stroke (0.027·em) instead of faux-bold;
 * letter-spacing -0.05·em (tracking-tighter) — all matching prod.
 *
 * Layout: `stacked` centers the glyph above the wordmark (two lines, for hero/auth
 * screens); default is inline `>_ DecodEbook` (for nav).
 */
function Glyph({ heightEm, color, blink, glow }: {
  heightEm: number; color: string; blink: boolean; glow: boolean;
}) {
  return (
    <svg
      viewBox="2 7 21 14"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      style={{
        height: `${heightEm}em`,
        width: `${heightEm * (21 / 14)}em`,
        overflow: 'visible',
        filter: glow ? `drop-shadow(0 0 0.25em ${color}66)` : undefined,
      }}
    >
      <polyline points="4,9 9,14 4,19" />
      <line x1="12" y1="19" x2="21" y2="19" className={blink ? 'animate-blink' : undefined} />
    </svg>
  );
}

export function BrandMark({
  color = '#00f3ff',
  className = '',
  wordmark = true,
  blink = true,
  glow = true,
  stacked = false,
}: {
  color?: string;
  className?: string;
  wordmark?: boolean;
  blink?: boolean;
  glow?: boolean;
  stacked?: boolean;
}) {
  // SVG box height in em. 0.639 == prod's 46px glyph at the 72px wordmark.
  const heightEm = stacked ? 0.639 : 0.9;

  const wordmarkEl = wordmark && (
    <span
      className="font-tech text-white tracking-tighter"
      style={{
        marginLeft: stacked ? undefined : '0.34em',
        marginTop: stacked ? '0.14em' : undefined,
        textShadow: glow ? '0 0 0.6em rgba(0, 243, 255, 0.28)' : undefined,
        // Even weight matched to prod's synthetic-bold stem via a centered stroke.
        WebkitTextStrokeWidth: '0.027em',
        WebkitTextStrokeColor: 'currentColor',
        paintOrder: 'stroke fill',
      }}
    >
      Decod<span style={{ color }}>Ebook</span>
    </span>
  );

  return (
    <span
      className={`inline-flex leading-none ${stacked ? 'flex-col items-center' : 'items-baseline'} ${className}`}
    >
      <Glyph heightEm={heightEm} color={color} blink={blink} glow={glow} />
      {wordmarkEl}
    </span>
  );
}

export default BrandMark;
