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
          yellow: '#FCEE0A',
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
      // Glow scale — values match the recurring ad-hoc cyberpunk glows in the app
      // so adoption is visual parity. ambient = panel halo, sm/cyan = resting
      // interactive, press = active/pressed, lg = hover lift, red = danger.
      boxShadow: {
        'glow-ambient': '0 0 15px rgba(0, 243, 255, 0.05)',
        'glow-sm': '0 0 10px rgba(0, 243, 255, 0.30)',
        'glow-cyan': '0 0 15px rgba(0, 243, 255, 0.30)',
        'glow-press': '0 0 20px rgba(0, 243, 255, 0.60)',
        'glow-lg': '0 0 30px rgba(0, 243, 255, 0.30)',
        'glow-red': '0 0 12px rgba(255, 0, 60, 0.80)',
      },
    },
  },
  plugins: [],
};
