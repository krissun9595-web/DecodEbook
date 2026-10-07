
import React from 'react';
import TextType from './TextType';

/**
 * Trial loader (NET_CAST) — a neon-cyan ring spinner (10 radiating bars) above
 * a typewriter "GENERATING" (TextType). Full-bleed + centered like Option B.
 */
export const LoaderSpinner: React.FC<{ text?: string; className?: string }> = ({ className = "" }) => (
  <div className={`absolute inset-0 flex flex-col items-center justify-center gap-7 ${className} animate-fade-in font-tech`}>
    <div className="db-spinner-wrap">
      <div className="db-spinner">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i}></div>
        ))}
      </div>
    </div>
    <TextType
      text="GENERATING"
      className="db-gen-text"
      typingSpeed={95}
      pauseDuration={1200}
      deletingSpeed={55}
      cursorCharacter="_"
      textColors={["#00f3ff"]}
    />
  </div>
);

export default LoaderSpinner;
