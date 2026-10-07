
import React from 'react';

interface LoaderProps {
  text?: string;
  className?: string;
}

const CHARS = ['D', 'E', 'C', 'O', 'D', 'I', 'N', 'G', '…'];

/**
 * Option C — "matrix" loader: a 3×3 grid of falling/flickering glyphs spelling
 * DECODING…. Neon-cyan + Share Tech Mono theme.
 */
export const LoaderMatrix: React.FC<LoaderProps> = ({ className = "" }) => (
  <div className={`flex items-center justify-center ${className} animate-fade-in font-tech`}>
    <div className="db-matrix-loader" aria-label="loading">
      {CHARS.map((c, i) => (
        <span className="digit" key={i}>{c}</span>
      ))}
      <div className="glow"></div>
    </div>
  </div>
);
