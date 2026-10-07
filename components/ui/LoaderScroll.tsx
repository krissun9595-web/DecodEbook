
import React from 'react';

interface LoaderProps {
  text?: string;
  /** Marquee word (default "GENERATING"); e.g. "LOADING" for module-switch. */
  word?: string;
  className?: string;
}

/**
 * Option B — fisheye marquee loader. Centered scrolling word.
 */
export const LoaderScroll: React.FC<LoaderProps> = ({ word = "GENERATING", className = "" }) => (
  <div className={`db-scroll-wrap absolute inset-0 flex items-center justify-center overflow-hidden ${className} animate-fade-in font-tech`}>
    <div className="db-scroll-loader relative z-10" aria-label="loading">
      {Array.from({ length: 9 }).map((_, i) => (
        <div className="text" key={i}><span>{word}</span></div>
      ))}
    </div>
  </div>
);
