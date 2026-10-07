
import React from 'react';
import { QuantumField } from './QuantumField';

interface LoaderProps {
  /** Kept for API parity with <Loader/>; not rendered. */
  text?: string;
  /** Kept for API parity; the progress bar was removed by design. */
  progress?: number;
  className?: string;
}

/**
 * Option A — glitch loader over the full-bleed quantum-particle field (same
 * effect as the playing visualizer). Centered glitch "DECODING…" wordmark.
 */
export const LoaderGlitch: React.FC<LoaderProps> = ({ className = "" }) => (
  <div className={`absolute inset-0 flex items-center justify-center overflow-hidden ${className} animate-fade-in font-tech`}>
    <QuantumField className="absolute inset-0 w-full h-full" />
    <div className="db-hacker-loader relative z-10">
      <span className="text-glitch" data-text="DECODING…">DECODING…</span>
    </div>
  </div>
);
