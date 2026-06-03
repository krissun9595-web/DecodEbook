
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

function buildShareCard(filename: string, title?: string): Blob | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const W = 800, H = 420;
  canvas.width = W;
  canvas.height = H;

  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 1;
  for (let i = 0; i < W; i += 40) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, H); ctx.stroke(); }
  for (let i = 0; i < H; i += 40) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(W, i); ctx.stroke(); }

  const margin = 50;
  const cs = 8;
  ctx.fillStyle = '#00f3ff';
  ctx.fillRect(margin, margin, cs, cs);
  ctx.fillRect(W - margin - cs, margin, cs, cs);
  ctx.fillRect(margin, H - margin - cs, cs, cs);
  ctx.fillRect(W - margin - cs, H - margin - cs, cs, cs);

  const ext = filename.split('.').pop()?.toUpperCase() || 'FILE';
  const typeLabels: Record<string, { label: string; color: string; icon: string }> = {
    WAV: { label: 'AUDIO FILE', color: '#00f3ff', icon: '♪' },
    MP3: { label: 'AUDIO FILE', color: '#00f3ff', icon: '♪' },
    MP4: { label: 'VIDEO FILE', color: '#ff003c', icon: '▶' },
    PDF: { label: 'DOCUMENT', color: '#a855f7', icon: '◆' },
    TXT: { label: 'TEXT FILE', color: '#22d3ee', icon: '≡' },
    DOCX: { label: 'DOCUMENT', color: '#3b82f6', icon: '◆' },
  };
  const info = typeLabels[ext] || { label: ext + ' FILE', color: '#00f3ff', icon: '◇' };

  ctx.fillStyle = info.color;
  ctx.font = '72px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText(info.icon, W / 2, 160);

  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 14px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(info.label, W / 2, 200);

  const displayTitle = title || filename;
  let titleFontSize = 28;
  ctx.font = `bold ${titleFontSize}px "Courier New", monospace`;
  while (ctx.measureText(displayTitle).width > W - margin * 2 && titleFontSize > 14) {
    titleFontSize -= 2;
    ctx.font = `bold ${titleFontSize}px "Courier New", monospace`;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillText(displayTitle.length > 50 ? displayTitle.substring(0, 47) + '...' : displayTitle, W / 2, 250);

  ctx.fillStyle = '#4a4a5a';
  ctx.font = '12px "Courier New", monospace';
  ctx.fillText(filename, W / 2, 285);

  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin, H - 60);
  ctx.lineTo(W - margin, H - 60);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = '#00f3ff';
  ctx.font = 'bold 13px "Courier New", monospace';
  ctx.fillText('DecodEbook', margin, H - 30);
  ctx.fillStyle = '#4a4a5a';
  ctx.font = '11px "Courier New", monospace';
  ctx.fillText('decodebook.app', margin, H - 14);
  ctx.textAlign = 'right';
  ctx.fillText('Made with DecodEbook', W - margin, H - 22);

  const dataUrl = canvas.toDataURL('image/png');
  const binary = atob(dataUrl.split(',')[1]);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: 'image/png' });
}

export const ShareMenu: React.FC<Props> = ({ getBlob, filename, title, disabled, className, iconSize = 16 }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dropUp, setDropUp] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleOpen = () => {
    if (disabled) return;
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropUp(rect.top > 150);
    }
    setOpen(!open);
  };

  const handleNativeShare = async () => {
    setOpen(false);
    const blob = await getBlob();
    if (!blob) return;
    if (isImageFile(filename)) {
      shareFile(blob, filename, title);
    } else {
      const card = buildShareCard(filename, title);
      if (card) {
        const cardFile = new File([card], filename.replace(/\.[^.]+$/, '.png'), { type: 'image/png' });
        const origFile = new File([blob], filename, { type: blob.type });
        const shareData: ShareData = {
          title: title || 'DecodEbook',
          text: 'Made with DecodEbook\nhttps://decodebook.app',
          files: [cardFile, origFile],
        };
        try {
          if (navigator.canShare?.(shareData)) {
            await navigator.share(shareData);
            return;
          }
        } catch (e: any) {
          if (e.name === 'AbortError') return;
        }
        shareFile(blob, filename, title);
      } else {
        shareFile(blob, filename, title);
      }
    }
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

  const posClass = dropUp ? 'bottom-full mb-1' : 'top-full mt-1';

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={btnRef}
        onClick={handleOpen}
        disabled={disabled}
        className={className}
        title="Share"
      >
        <Share2 size={iconSize} />
      </button>
      {open && (
        <div className={`absolute ${posClass} right-0 bg-[#0a0a0c] border border-cyan-900/50 shadow-[0_0_20px_rgba(0,0,0,0.8)] rounded-sm overflow-hidden min-w-[160px] z-[60] animate-fade-in`}>
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
