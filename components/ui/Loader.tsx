
import React from 'react';
import { Terminal, Cpu } from 'lucide-react';

interface LoaderProps {
  text?: string;
  className?: string;
}

export const Loader: React.FC<LoaderProps> = ({ text = "PROCESSING_DATA...", className = "" }) => (
  <div className={`flex flex-col items-center justify-center p-6 ${className} animate-fade-in font-tech`}>
    <div className="relative mb-5">
      <div className="w-12 h-12 border-2 border-[#00f3ff] border-t-transparent rounded-full animate-spin"></div>
      <div className="absolute inset-0 flex items-center justify-center">
        <Cpu className="w-6 h-6 text-[#00f3ff] animate-pulse" />
      </div>

      {/* Decorative HUD circles */}
      <div className="absolute -inset-3 border border-dashed border-zinc-800 rounded-full animate-spin-slow opacity-50"></div>
    </div>

    <div className="text-center space-y-1">
        <div className="text-[#00f3ff] text-[11px] font-bold tracking-[0.2em] uppercase animate-pulse">
            {text}
        </div>
    </div>
  </div>
);
