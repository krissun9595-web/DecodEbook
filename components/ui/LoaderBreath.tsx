
import React from 'react';
import BrandMark from './BrandMark';

/**
 * VISUAL_CORE initiating loader — the DecodEbook `>_` brand mark with a
 * breathing pulse (same mark as the upload interface) and "Generating" below.
 */
export const LoaderBreath: React.FC<{ text?: string; className?: string }> = ({ className = "" }) => (
  <div className={`absolute inset-0 flex flex-col items-center justify-center gap-5 ${className} animate-fade-in font-tech`}>
    <BrandMark wordmark={false} breathe className="text-5xl md:text-6xl" />
    <span className="db-gen-label">Generating</span>
  </div>
);

export default LoaderBreath;
