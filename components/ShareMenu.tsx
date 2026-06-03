
import React, { useState, useRef, useEffect } from 'react';
import { Share2, Download, Copy, Check } from 'lucide-react';
import { shareFile, copyImageToClipboard, canNativeShare, canCopyImages, isImageFile, downloadBlob } from '../utils/share';

interface Props {
  getBlob: () => Promise<Blob | null>;
  filename: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  iconSize?: number;
}

export const ShareMenu: React.FC<Props> = ({ getBlob, filename, title, disabled, className, iconSize = 16 }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleNativeShare = async () => {
    setOpen(false);
    const blob = await getBlob();
    if (blob) shareFile(blob, filename, title);
  };

  const handleCopy = async () => {
    const blob = await getBlob();
    if (!blob) return;
    const ok = await copyImageToClipboard(blob);
    if (ok) {
      setCopied(true);
      setTimeout(() => { setCopied(false); setOpen(false); }, 1200);
    }
  };

  const handleDownload = async () => {
    setOpen(false);
    const blob = await getBlob();
    if (blob) downloadBlob(blob, filename);
  };

  const useNative = canNativeShare();
  const showCopy = canCopyImages() && isImageFile(filename);

  if (useNative && !showCopy) {
    return (
      <button onClick={handleNativeShare} disabled={disabled} className={className} title="Share">
        <Share2 size={iconSize} />
      </button>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => { if (disabled) return; setOpen(!open); }}
        disabled={disabled}
        className={className}
        title="Share"
      >
        <Share2 size={iconSize} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 bg-[#0a0a0c] border border-cyan-900/50 shadow-[0_0_20px_rgba(0,0,0,0.8)] rounded-sm overflow-hidden min-w-[160px] z-50 animate-fade-in">
          {useNative && (
            <button onClick={handleNativeShare} className="w-full text-left px-3 py-2 text-zinc-300 hover:bg-[#00f3ff]/10 hover:text-[#00f3ff] text-[11px] font-mono uppercase flex items-center gap-2 transition-colors">
              <Share2 size={13} /> Share
            </button>
          )}
          {showCopy && (
            <button onClick={handleCopy} className="w-full text-left px-3 py-2 text-zinc-300 hover:bg-[#00f3ff]/10 hover:text-[#00f3ff] text-[11px] font-mono uppercase flex items-center gap-2 transition-colors">
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              {copied ? 'Copied!' : 'Copy Image'}
            </button>
          )}
          <button onClick={handleDownload} className="w-full text-left px-3 py-2 text-zinc-300 hover:bg-[#00f3ff]/10 hover:text-[#00f3ff] text-[11px] font-mono uppercase flex items-center gap-2 transition-colors">
            <Download size={13} /> Download
          </button>
        </div>
      )}
    </div>
  );
};
