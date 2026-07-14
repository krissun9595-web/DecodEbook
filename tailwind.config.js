/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './index.tsx', './App.tsx', './components/**/*.{ts,tsx}'],
  // Dynamic `text-${plan.color}` classes in PricingModal aren't statically scannable.
  safelist: ['text-zinc-400', 'text-amber-400', 'text-[#00f3ff]'],
  theme: {
    extend: {
      colors: {
        neon: {
          cyan: '#00f3ff',
          red: '#ff003c',
          pink: '#ff4fd8',
          violet: '#a78bfa',
          amber: '#fbbf24',
        },
        // backgrounds: bg-void-0 (deepest) → bg-void-2
        void: {
          0: '#020202',
          1: '#050505',
          2: '#0a0a0c',
        },
        surface: '#0a0a0c',
        // text: text-fg-hi / text-fg-mid / text-fg-dim (dim passes 4.5:1 on void)
        fg: {
          hi: '#f4f4f5',
          mid: '#a1a1aa',
          dim: '#8b8b95',
        },
        edge: 'rgba(0, 243, 255, 0.15)',
      },
      boxShadow: {
        'glow-cyan': '0 0 12px rgba(0, 243, 255, 0.45)',
        'glow-red': '0 0 12px rgba(255, 0, 60, 0.45)',
        'glow-sm': '0 0 6px rgba(0, 243, 255, 0.30)',
        'glow-lg': '0 0 24px rgba(0, 243, 255, 0.40)',
      },
    },
  },
  plugins: [],
};
