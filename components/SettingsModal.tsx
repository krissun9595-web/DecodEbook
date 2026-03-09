
import React from 'react';
import { X, Globe, Highlighter, Type, AlignJustify, MoveHorizontal } from 'lucide-react';
import { AppSettings, ThemeColor } from '../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdate: (newSettings: AppSettings) => void;
}

const COLORS: { id: ThemeColor; label: string; class: string }[] = [
  { id: 'indigo', label: 'Neon Blue', class: 'bg-[#00f3ff]' },
  { id: 'emerald', label: 'Matrix Green', class: 'bg-emerald-500' },
  { id: 'rose', label: 'Laser Red', class: 'bg-[#ff003c]' },
  { id: 'amber', label: 'Amber', class: 'bg-amber-500' },
  { id: 'cyan', label: 'Cyan', class: 'bg-cyan-400' },
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
    'Crimson Text'
];

// Alphabetical order with Chinese (Traditional) added, and Original at the top
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
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in font-sans">
      <div className="bg-[#050505] border border-zinc-800 rounded-lg w-full max-w-md shadow-[0_0_50px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden animate-fade-in-up scale-in relative">
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-[#00f3ff] to-[#ff003c]"></div>
        
        <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
          <h2 className="text-xl font-black text-white uppercase tracking-widest font-mono">System_Config</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-8 overflow-y-auto max-h-[70vh] custom-scrollbar">
          {/* Language */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[#00f3ff] mb-2">
              <Globe size={18} />
              <label className="text-xs font-bold uppercase tracking-widest font-mono">Target_Language</label>
            </div>
            <select
              value={settings.targetLanguage}
              onChange={(e) => onUpdate({ ...settings, targetLanguage: e.target.value })}
              className="w-full bg-[#050505] border border-zinc-800 text-[#00f3ff] font-mono text-xs uppercase focus:border-[#00f3ff] outline-none rounded-sm px-4 py-3 transition-all cursor-pointer"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </div>

          {/* Highlight Color */}
          <div className="space-y-3">
             <div className="flex items-center gap-2 text-[#ff003c] mb-2">
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

          <hr className="border-zinc-800" />

          {/* Typography Settings */}
          <div className="space-y-6">
            <div className="flex items-center gap-2 text-white">
              <Type size={18} />
              <label className="text-xs font-bold uppercase tracking-widest font-mono">Typography_Modules</label>
            </div>
            
            {/* Font Family */}
            <div className="space-y-2">
                 <span className="text-[10px] text-zinc-500 uppercase font-mono">Font_Family</span>
                 <select
                    value={settings.font || 'Inter'}
                    onChange={(e) => onUpdate({ ...settings, font: e.target.value as any })}
                    className="w-full bg-[#050505] border border-zinc-800 text-zinc-300 font-mono text-xs focus:border-[#00f3ff] outline-none rounded-sm px-3 py-2 transition-all cursor-pointer"
                 >
                    {FONTS.map(f => (
                        <option key={f} value={f}>{f}</option>
                    ))}
                 </select>
            </div>

            {/* Font Size */}
            <div className="space-y-2">
                <span className="text-[10px] text-zinc-500 uppercase font-mono">Font_Scale</span>
                <div className="flex bg-zinc-900 p-1 rounded-sm border border-zinc-800">
                {(['sm', 'base', 'lg', 'xl'] as const).map((size) => (
                    <button
                    key={size}
                    onClick={() => onUpdate({ ...settings, textSize: size })}
                    className={`flex-1 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wide transition-colors ${
                        settings.textSize === size ? 'bg-zinc-800 text-[#00f3ff] shadow' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                    >
                    {size}
                    </button>
                ))}
                </div>
            </div>

            {/* Line Height */}
            <div className="space-y-2">
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
                        settings.lineHeight === lh ? 'bg-zinc-800 text-[#00f3ff] shadow' : 'text-zinc-500 hover:text-zinc-300'
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
                        settings.letterSpacing === ls ? 'bg-zinc-800 text-[#00f3ff] shadow' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                    >
                    {ls}
                    </button>
                ))}
                </div>
            </div>
          </div>
        </div>

        <div className="p-4 bg-zinc-900 border-t border-zinc-800 flex justify-end">
           <button 
             onClick={onClose}
             className="px-8 py-2.5 bg-[#00f3ff] hover:bg-[#00c2cc] text-black rounded-sm font-bold uppercase tracking-wider transition-all shadow-[0_0_15px_rgba(0,243,255,0.3)] hover:shadow-[0_0_25px_rgba(0,243,255,0.5)] font-mono text-xs"
           >
             Apply_Changes
           </button>
        </div>
      </div>
    </div>
  );
};
