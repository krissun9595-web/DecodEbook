
import React, { useEffect } from 'react';
import { Globe, Highlighter, PenLine, Type, AlignJustify, AlignLeft, MoveHorizontal, Cpu, MessageSquare, AudioLines, ImageIcon, Film, CaseSensitive, ALargeSmall, Send } from 'lucide-react';
import { CloseButton } from './ui/CloseButton';
import { Engine } from './ui/glyphs';
import { AppSettings, ThemeColor } from '../types';
import { inkLineStyle } from '../utils/inkLine';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdate: (newSettings: AppSettings) => void;
}

const COLORS: { id: ThemeColor; label: string; class: string }[] = [
  { id: 'indigo', label: 'Neon Blue', class: 'bg-neon-cyan' },
  { id: 'emerald', label: 'Matrix Green', class: 'bg-emerald-500' },
  { id: 'rose', label: 'Laser Red', class: 'bg-neon-red' },
  { id: 'amber', label: 'Amber', class: 'bg-amber-500' },
  { id: 'violet', label: 'Violet', class: 'bg-violet-400' },
  { id: 'pink', label: 'Neural Pink', class: 'bg-neon-pink' },
  { id: 'yellow', label: 'Cyber Yellow', class: 'bg-neon-yellow' },
];

const INK_LINES: { id: AppSettings['inkLine']; label: string; style: 'solid' | 'wavy' | 'dotted' }[] = [
  { id: 'full', label: 'Full', style: 'solid' },
  { id: 'curvy', label: 'Curvy', style: 'wavy' },
  { id: 'dotted', label: 'Dotted', style: 'dotted' },
];

const FONTS = [
    'Inter',
    'Merriweather',
    'Playfair Display',
    'Roboto Mono',
    'Open Sans',
    'Orbitron',
    'Cinzel',
    'Source Code Pro',
    'Crimson Text',
    'Lora',
    'Libre Baskerville',
    'EB Garamond',
    'Literata',
    'Spectral',
    'Noto Sans',
    'Noto Serif',
    'Noto Sans SC',
    'Noto Serif SC',
    'LXGW WenKai',
    'Ma Shan Zheng',
    'Zhi Mang Xing',
    'Noto Sans TC',
    'Noto Serif TC',
];

const TEXT_MODELS = [
  { value: 'gemini-3-flash-preview', label: 'Gemini Flash', provider: 'Google' },
  { value: 'gemini-3-pro-preview', label: 'Gemini Pro', provider: 'Google' },
  { value: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'OpenAI' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet', provider: 'Anthropic' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku', provider: 'Anthropic' },
];

const TTS_MODELS = [
  { value: 'gemini-3.1-flash-tts-preview', label: 'Gemini TTS', provider: 'Google' },
];

const IMAGE_MODELS = [
  { value: 'gemini-3-pro-image-preview', label: 'Gemini Image', provider: 'Google' },
];

const VIDEO_MODELS = [
  { value: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast', provider: 'Google' },
  { value: 'dreamina-seedance-2-0-260128', label: 'Seedance 2.0', provider: 'ByteDance' },
  { value: 'dreamina-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast', provider: 'ByteDance' },
];

const LANGUAGES = [
  'Original',
  'Arabic',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Dutch',
  'English',
  'French',
  'German',
  'Hindi',
  'Indonesian',
  'Italian',
  'Japanese',
  'Korean',
  'Polish',
  'Portuguese',
  'Russian',
  'Spanish',
  'Swedish',
  'Thai',
  'Turkish',
  'Vietnamese'
];

export const SettingsModal: React.FC<Props> = ({ isOpen, onClose, settings, onUpdate }) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Settings" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in font-sans" onClick={onClose}>
      <div className="bg-void-1 border border-zinc-800 rounded-lg w-full max-w-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden animate-fade-in-up scale-in relative" onClick={e => e.stopPropagation()}>
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-neon-cyan to-neon-red"></div>

        <div className="px-6 py-[19px] border-b border-zinc-800 flex items-center justify-between shrink-0">
          <h2 className="text-xl font-black text-white uppercase tracking-widest font-mono">System_Config</h2>
          <CloseButton onClick={onClose} />
        </div>

        <div className="h-[calc(70vh+69px)] flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-[1.6rem] custom-scrollbar">
          {/* LLM engines are admin-set per function in services/gemini.ts (FUNCTION_MODELS)
              + the media model defaults; users don't choose them. */}

          {/* Language */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-neon-cyan mb-2">
              <Globe size={18} />
              <label className="text-xs font-bold uppercase tracking-widest font-mono">Target_Language</label>
            </div>
            <select
              value={settings.targetLanguage}
              onChange={(e) => onUpdate({ ...settings, targetLanguage: e.target.value })}
              className="block w-full bg-void-1 border border-zinc-800 text-neon-cyan font-mono text-xs uppercase focus:border-neon-cyan outline-none rounded-sm px-3 py-2 transition-all cursor-pointer"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </div>

          {/* Highlight Color */}
          <div className="space-y-3">
             <div className="flex items-center gap-2 text-neon-cyan mb-2">
              <Highlighter size={18} />
              <label className="text-xs font-bold uppercase tracking-widest font-mono">Highlight_Hue</label>
            </div>
            <div className="flex gap-4">
              {COLORS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onUpdate({ ...settings, highlightColor: c.id })}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${c.class} ${
                    settings.highlightColor === c.id ? 'ring-2 ring-white scale-110 shadow-[0_0_15px_currentColor]' : 'opacity-40 hover:opacity-100'
                  }`}
                  title={c.label}
                />
              ))}
            </div>
          </div>

          {/* Ink Line Style */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-neon-cyan mb-2">
              <PenLine size={18} />
              <label className="text-xs font-bold uppercase tracking-widest font-mono">Ink_Line</label>
            </div>
            <div className="flex gap-3">
              {INK_LINES.map((line) => (
                <button
                  key={line.id}
                  onClick={() => onUpdate({ ...settings, inkLine: line.id })}
                  className={`flex-1 px-3 py-2 rounded-sm border text-[10px] font-mono uppercase tracking-wider transition-all ${
                    (settings.inkLine || 'full') === line.id
                      ? 'border-neon-cyan text-white bg-neon-cyan/10'
                      : 'border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
                  }`}
                  title={`${line.label} ink line`}
                >
                  <span style={inkLineStyle(line.id, '#00f3ff') as React.CSSProperties}>
                    {line.label}
                  </span>
                </button>
              ))}
            </div>
          </div>


          {/* Typography Settings */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-neon-cyan mb-2">
              <Type size={18} />
              <label className="text-xs font-bold uppercase tracking-widest font-mono">Typography_Modules</label>
            </div>

            {/* Font Family */}
            <div className="space-y-1.5">
                 <div className="flex items-center gap-2 text-zinc-500 text-[10px] font-mono uppercase">
                    <CaseSensitive size={14} />
                    <span>Font_Family</span>
                 </div>
                 <select
                    value={settings.font || 'Inter'}
                    onChange={(e) => onUpdate({ ...settings, font: e.target.value as any })}
                    className="w-full bg-void-1 border border-zinc-800 text-zinc-300 font-mono text-xs focus:border-neon-cyan outline-none rounded-sm px-3 py-2 transition-all cursor-pointer"
                 >
                    {FONTS.map(f => (
                        <option key={f} value={f}>{f}</option>
                    ))}
                 </select>
            </div>

            {/* Font Size */}
            <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-zinc-500 text-[10px] font-mono uppercase">
                    <ALargeSmall size={14} />
                    <span>Font_Scale</span>
                </div>
                <div className="flex bg-zinc-900 p-1 rounded-sm border border-zinc-800">
                {(['sm', 'base', 'lg', 'xl'] as const).map((size) => (
                    <button
                    key={size}
                    onClick={() => onUpdate({ ...settings, textSize: size })}
                    className={`flex-1 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wide transition-colors ${
                        settings.textSize === size ? 'bg-zinc-800 text-neon-cyan shadow' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                    >
                    {size}
                    </button>
                ))}
                </div>
            </div>

            {/* Line Height */}
            <div className="space-y-1.5">
                 <div className="flex items-center gap-2 text-zinc-500 text-[10px] font-mono uppercase">
                    <AlignJustify size={14} />
                    <span>Line_Height</span>
                 </div>
                <div className="flex bg-zinc-900 p-1 rounded-sm border border-zinc-800">
                {(['tight', 'normal', 'relaxed', 'loose'] as const).map((lh) => (
                    <button
                    key={lh}
                    onClick={() => onUpdate({ ...settings, lineHeight: lh })}
                    className={`flex-1 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wide transition-colors ${
                        settings.lineHeight === lh ? 'bg-zinc-800 text-neon-cyan shadow' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                    >
                    {lh}
                    </button>
                ))}
                </div>
            </div>

             {/* Letter Spacing */}
             <div className="space-y-2">
                 <div className="flex items-center gap-2 text-zinc-500 text-[10px] font-mono uppercase">
                    <MoveHorizontal size={14} />
                    <span>Char_Spacing</span>
                 </div>
                <div className="flex bg-zinc-900 p-1 rounded-sm border border-zinc-800">
                {(['tighter', 'normal', 'wide', 'wider'] as const).map((ls) => (
                    <button
                    key={ls}
                    onClick={() => onUpdate({ ...settings, letterSpacing: ls })}
                    className={`flex-1 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wide transition-colors ${
                        settings.letterSpacing === ls ? 'bg-zinc-800 text-neon-cyan shadow' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                    >
                    {ls}
                    </button>
                ))}
                </div>
            </div>

             {/* Text Alignment */}
             <div className="space-y-2">
                 <div className="flex items-center gap-2 text-zinc-500 text-[10px] font-mono uppercase">
                    <AlignLeft size={14} />
                    <span>Alignment</span>
                 </div>
                <div className="flex bg-zinc-900 p-1 rounded-sm border border-zinc-800">
                {(['auto', 'justify', 'left'] as const).map((al) => (
                    <button
                    key={al}
                    onClick={() => onUpdate({ ...settings, textAlign: al })}
                    title={al === 'auto' ? 'Mirror the source (justify + hyphenation when the book is justified)' : al === 'justify' ? 'Justify with hyphenation' : 'Left-aligned (ragged right)'}
                    className={`flex-1 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wide transition-colors ${
                        (settings.textAlign ?? 'auto') === al ? 'bg-zinc-800 text-neon-cyan shadow' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                    >
                    {al}
                    </button>
                ))}
                </div>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 bg-zinc-900 border-t border-zinc-800 flex justify-end shrink-0">
           <button
             onClick={onClose}
             className="btn-action btn-go"
           >
             <Send size={14} /> APPLY
           </button>
        </div>
        </div>
      </div>
    </div>
  );
};
