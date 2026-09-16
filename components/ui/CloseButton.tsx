import React from 'react';
import { X } from 'lucide-react';

/**
 * The single close (✕) control used across sidebar popups (Settings, Gen_Files,
 * My_Account) and the upload page, so every dismiss affordance looks/behaves the same.
 */
export function CloseButton({
  onClick,
  size = 24,
  label = 'Close',
  className = '',
}: {
  onClick: () => void;
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`text-zinc-500 hover:text-white transition-colors active:scale-90 ${className}`}
    >
      <X size={size} />
    </button>
  );
}

export default CloseButton;
