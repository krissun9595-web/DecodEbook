
import React from 'react';
import { Terminal, Cpu } from 'lucide-react';

interface LoaderProps {
  text?: string;
  className?: string;
}

export const Loader: React.FC<LoaderProps> = ({ text = "PROCESSING_DATA...", className = "" }) => (
  <div className={`flex flex-col items-center justify-center p-8 ${className} animate-fade-in font-tech`}>
    <div className="relative mb-6">
      <div className="w-16 h-16 border-2 border-[#00f3ff] border-t-transparent rounded-full animate-spin"></div>
      <div className="absolute inset-0 flex items-center justify-center">
        <Cpu className="w-8 h-8 text-[#00f3ff] animate-pulse" />
      </div>
      
      {/* Decorative HUD circles */}
      <div className="absolute -inset-4 border border-dashed border-zinc-800 rounded-full animate-spin-slow opacity-50"></div>
    </div>
    
    <div className="text-center space-y-1">
        <div className="text-[#00f3ff] text-xs font-bold tracking-[0.2em] uppercase animate-pulse">
            {text}
        </div>
        <div className="text-[10px] text-zinc-600 font-mono">
            // SYS.THREAD.ACTIVE
        </div>
    </div>
  </div>
);
