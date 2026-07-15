import React, { useState, useEffect, useRef } from 'react';
import { BookOpen, Languages, Headphones, Brain, Film, Mic2, ChevronDown, Zap, Crown, ArrowRight, Sparkles, MessageSquare, Map, Image as ImageIcon, Upload } from 'lucide-react';
import ScrollVelocity from './ui/ScrollVelocity';
import FallingText from './ui/FallingText';
import DecryptedText from './ui/DecryptedText';
import TrueFocus from './ui/TrueFocus';
import './ui/LandingCyberpunk.css';

interface LandingPageProps {
  variant: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  onEnterApp: () => void;
  onSignIn: () => void;
}

function useUnlockScroll() {
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    const body = document.body;
    const html = document.documentElement;
    const previous = {
      rootPosition: root.style.position,
      rootOverflow: root.style.overflow,
      rootHeight: root.style.height,
      rootMinHeight: root.style.minHeight,
      bodyOverflow: body.style.overflow,
      bodyHeight: body.style.height,
      htmlOverflow: html.style.overflow,
      htmlHeight: html.style.height,
    };

    root.style.position = 'static';
    root.style.overflow = 'visible';
    root.style.height = 'auto';
    root.style.minHeight = '100%';
    body.style.overflow = 'auto';
    body.style.height = 'auto';
    html.style.overflow = 'auto';
    html.style.height = 'auto';

    return () => {
      root.style.position = previous.rootPosition;
      root.style.overflow = previous.rootOverflow;
      root.style.height = previous.rootHeight;
      root.style.minHeight = previous.rootMinHeight;
      body.style.overflow = previous.bodyOverflow;
      body.style.height = previous.bodyHeight;
      html.style.overflow = previous.htmlOverflow;
      html.style.height = previous.htmlHeight;
    };
  }, []);
}

// ─── Shared ───

const PRICING = [
  {
    id: 'free', name: 'Free', price: '$0', period: '', icon: Zap, color: '#a1a1aa',
    features: ['100 credits / month', 'Translation & AI chat', 'TTS & mind maps', 'No credit card required'],
  },
  {
    id: 'pro', name: 'Pro', price: '$9.99', period: '/mo', icon: Crown, color: '#00f3ff',
    features: ['1,000 credits / month', 'All AI features unlocked', 'Video & podcast generation', 'Buy extra credit packs'],
    annual: '$99.99/yr — save 17%',
  },
];

function PricingCards({ onEnterApp }: { onEnterApp: () => void }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
      {PRICING.map(plan => (
        <div key={plan.id} className="bg-void-2 border rounded-sm p-6 space-y-4 transition-all hover:border-opacity-60" style={{ borderColor: `${plan.color}33` }}>
          <div className="flex items-center gap-2">
            <plan.icon size={18} style={{ color: plan.color }} />
            <span className="font-mono font-bold tracking-widest text-sm" style={{ color: plan.color }}>{plan.name}</span>
          </div>
          <div>
            <span className="text-3xl font-bold text-white">{plan.price}</span>
            <span className="text-zinc-500 text-sm ml-1">{plan.period}</span>
          </div>
          <ul className="space-y-2">
            {plan.features.map((f, i) => (
              <li key={i} className="text-xs text-zinc-400 font-mono flex items-center gap-2">
                <span style={{ color: plan.color }}>+</span> {f}
              </li>
            ))}
          </ul>
          {plan.annual && <p className="text-[10px] text-emerald-400 font-mono">{plan.annual}</p>}
          <button
            onClick={onEnterApp}
            className="w-full py-2.5 text-xs font-mono uppercase tracking-widest rounded-sm transition-all flex items-center justify-center gap-2"
            style={{
              backgroundColor: `${plan.color}15`,
              borderWidth: 1,
              borderColor: `${plan.color}40`,
              color: plan.color,
            }}
          >
            {plan.id === 'free' ? 'Start Reading Free' : 'Upgrade to Pro'} <ArrowRight size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Version A: Story Scroll ───

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { threshold });
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, visible };
}

function FadeSection({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const { ref, visible } = useInView();
  return (
    <div ref={ref} className={`transition-all duration-700 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

function VersionA({ onEnterApp, onSignIn }: { onEnterApp: () => void; onSignIn: () => void }) {
  useUnlockScroll();
  const [scrollY, setScrollY] = useState(0);
  useEffect(() => {
    const h = () => setScrollY(window.scrollY);
    window.addEventListener('scroll', h, { passive: true });
    return () => window.removeEventListener('scroll', h);
  }, []);

  return (
    <div className="min-h-screen bg-void-0 text-zinc-100 overflow-x-hidden">
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 bg-void-0/80 backdrop-blur-md border-b border-zinc-900">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-4 sm:px-6 py-3">
          <span className="font-mono font-bold text-sm tracking-wider text-white">Decod<span className="text-neon-cyan">Ebook</span></span>
          <div className="flex items-center gap-2 sm:gap-3">
            <button onClick={onSignIn} className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 hover:text-white transition-colors">Sign In</button>
            <button onClick={onEnterApp} className="text-[10px] font-mono uppercase tracking-widest bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan px-3 sm:px-4 py-1.5 rounded-sm hover:bg-neon-cyan/20 transition-colors">Decode a Book</button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative min-h-screen flex items-center justify-center px-4 sm:px-6 overflow-hidden">
        <div className="absolute inset-0 bg-grid opacity-30" />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 30%, rgba(0,243,255,0.06) 0%, transparent 60%)' }} />
        {/* Floating book spines — multi-color to hint at the theme */}
        <div className="absolute left-[8%] top-[18%] w-2.5 h-28 bg-gradient-to-b from-neon-cyan/20 to-transparent rounded-sm hidden md:block" style={{ transform: `translateY(${scrollY * 0.1}px) rotate(-5deg)` }} />
        <div className="absolute right-[12%] top-[25%] w-2.5 h-20 bg-gradient-to-b from-neon-red/20 to-transparent rounded-sm hidden md:block" style={{ transform: `translateY(${scrollY * 0.15}px) rotate(3deg)` }} />
        <div className="absolute left-[18%] bottom-[22%] w-2.5 h-24 bg-gradient-to-b from-emerald-500/20 to-transparent rounded-sm hidden md:block" style={{ transform: `translateY(${scrollY * -0.08}px) rotate(-8deg)` }} />
        <div className="absolute right-[20%] bottom-[30%] w-2.5 h-16 bg-gradient-to-b from-amber-500/20 to-transparent rounded-sm hidden md:block" style={{ transform: `translateY(${scrollY * 0.12}px) rotate(6deg)` }} />

        <div className="relative z-10 text-center max-w-3xl mx-auto space-y-5 sm:space-y-6">
          <p className="text-[9px] sm:text-[10px] font-mono uppercase tracking-[0.25em] sm:tracking-[0.3em] text-zinc-600 animate-fade-in">The book is in your hands. The meaning is in ours.</p>
          <h1 className="text-[1.75rem] sm:text-4xl md:text-7xl font-bold tracking-tighter leading-[0.9] animate-fade-in" style={{ animationDelay: '0.1s' }}>
            Finish the book.<br /><span className="text-neon-cyan drop-shadow-[0_0_30px_rgba(0,243,255,0.4)]">Not just start it.</span>
          </h1>
          <p className="text-zinc-400 text-xs sm:text-sm md:text-base max-w-xl mx-auto leading-relaxed animate-fade-in" style={{ animationDelay: '0.2s' }}>
            Original-language books are full of words a dictionary won't crack — literary phrasings, cultural idioms, sentences whose meaning bends with the paragraph around them. DecodEbook wraps an AI tutor around every page. Tap a word for what it means <em className="text-zinc-300 not-italic">in this passage</em>. Hear it pronounced. Ask why the grammar bends that way. Five ways to understand — until the book clicks.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 animate-fade-in" style={{ animationDelay: '0.3s' }}>
            <button onClick={onEnterApp} className="px-5 sm:px-8 py-2.5 sm:py-3 bg-neon-cyan text-black font-mono font-bold text-[10px] sm:text-xs uppercase tracking-widest rounded-sm hover:bg-neon-cyan/90 transition-all hover:shadow-glow-lg flex items-center gap-2">
              Decode Your First Chapter <ArrowRight size={14} />
            </button>
            <span className="text-[9px] sm:text-[10px] text-zinc-600 font-mono">Free · 100 credits/mo · 30 seconds</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2 animate-fade-in" style={{ animationDelay: '0.4s' }}>
            {['EPUB', 'PDF', 'TXT'].map(fmt => (
              <span key={fmt} className="text-[8px] sm:text-[9px] font-mono text-zinc-700 border border-zinc-800/50 px-1.5 sm:px-2 py-0.5 rounded-sm">{fmt}</span>
            ))}
            <span className="text-[8px] sm:text-[9px] font-mono text-zinc-700 mx-0.5 sm:mx-1">·</span>
            {['EN', 'JP', 'FR', 'DE', 'ZH', 'ES', 'KO'].map(lang => (
              <span key={lang} className="text-[8px] sm:text-[9px] font-mono text-zinc-600">{lang}</span>
            ))}
            <span className="text-[8px] sm:text-[9px] font-mono text-zinc-700">+ 50 more</span>
          </div>
        </div>

        <button aria-label="Scroll down" onClick={() => document.getElementById('section-problem')?.scrollIntoView({ behavior: 'smooth' })} className="absolute bottom-6 sm:bottom-8 left-1/2 -translate-x-1/2 text-zinc-600 hover:text-neon-cyan transition-colors animate-bounce">
          <ChevronDown size={20} />
        </button>
      </section>

      {/* Who's already decoding — use-case tiles */}
      <section className="py-12 sm:py-16 px-4 sm:px-6 border-t border-zinc-900">
        <div className="max-w-5xl mx-auto">
          <FadeSection>
            <p className="text-[9px] sm:text-[10px] font-mono uppercase tracking-[0.3em] text-zinc-600 mb-6 text-center">
              Who's already decoding
            </p>
          </FadeSection>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 sm:gap-3">
            {[
              { tag: 'Language learners', line: "Finally finish a novel in the language you're studying.", color: '#00f3ff' },
              { tag: 'Students', line: 'Decode dense textbooks chapter by chapter — with audio and visuals.', color: '#10b981' },
              { tag: 'Researchers', line: 'Read foreign-language papers without losing the thread.', color: '#a78bfa' },
              { tag: 'Re-readers', line: "Return to the classics with a tutor who's read them too.", color: '#f59e0b' },
              { tag: 'Slow readers', line: 'Listen on the commute, read at night — same book, same place.', color: '#ff003c' },
            ].map((u, i) => (
              <FadeSection key={i} delay={i * 60}>
                <div className="bg-void-2 border rounded-sm p-3 sm:p-4 h-full hover:border-opacity-50 transition-colors" style={{ borderColor: `${u.color}20` }}>
                  <p className="text-[9px] sm:text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: u.color }}>{u.tag}</p>
                  <p className="text-[10px] sm:text-[11px] text-zinc-400 leading-relaxed">{u.line}</p>
                </div>
              </FadeSection>
            ))}
          </div>
        </div>
      </section>

      {/* Why "decode" */}
      <section id="section-problem" className="py-16 sm:py-20 md:py-28 px-4 sm:px-6">
        <div className="max-w-4xl mx-auto">
          <FadeSection>
            <div className="content-panel rounded-sm p-5 sm:p-8 md:p-10 mb-12 sm:mb-16 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-neon-red via-neon-cyan to-emerald-500" />
              <p className="text-[9px] sm:text-[10px] font-mono uppercase tracking-[0.3em] text-neon-cyan mb-3 sm:mb-4">Why "decode"?</p>
              <h2 className="text-lg sm:text-2xl md:text-3xl font-bold tracking-tight text-white mb-3 sm:mb-4 leading-snug">
                A dictionary translates <span className="text-neon-red">words</span>.<br />
                Decoding translates <span className="text-neon-cyan">meaning</span>.
              </h2>
              <p className="text-[11px] sm:text-sm text-zinc-400 leading-relaxed max-w-2xl">
                The hard part of a foreign-language book isn't the vocabulary — it's the literary phrasing, the cultural idiom, the sentence whose meaning bends with the paragraph around it. A dictionary tells you what a word means. DecodEbook tells you what the <em className="text-zinc-300 not-italic">author</em> means, <em className="text-zinc-300 not-italic">in this passage</em>. That's the difference between translating and decoding.
              </p>
            </div>
          </FadeSection>

          <FadeSection>
            <p className="text-[9px] sm:text-[10px] font-mono uppercase tracking-[0.3em] text-neon-red mb-3">Sound familiar?</p>
            <h2 className="text-xl sm:text-2xl md:text-4xl font-bold tracking-tight text-white mb-8 sm:mb-12">
              Five books started.<br />One <span className="text-neon-red">finished</span>.
            </h2>
          </FadeSection>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            {[
              { title: 'You read 3 pages and quit', desc: 'Every sentence is a puzzle. Look up a word, lose your place, look up another. By page 4, reading feels like work.', icon: BookOpen, color: '#ff003c' },
              { title: 'Words, but no meaning', desc: 'Literary language, idioms, cultural context — a dictionary gives definitions but not understanding. You read the sentence three times.', icon: Brain, color: '#f59e0b' },
              { title: 'Silent words', desc: 'You can read it but can\'t hear it. Written words stay flat in your head. Reading and speaking stay disconnected.', icon: Headphones, color: '#00f3ff' },
              { title: 'No one to ask at 11pm', desc: 'Why is this verb different? What\'s the nuance? There\'s no teacher when you\'re finally reading.', icon: MessageSquare, color: '#10b981' },
            ].map((item, i) => (
              <FadeSection key={i} delay={i * 100}>
                <div className="bg-void-2 border rounded-sm p-4 sm:p-5 space-y-2 hover:border-opacity-40 transition-colors h-full" style={{ borderColor: `${item.color}15` }}>
                  <div className="flex items-center gap-2">
                    <item.icon size={14} className="shrink-0" style={{ color: item.color }} />
                    <h3 className="font-mono font-bold text-[11px] sm:text-xs text-white tracking-wide">{item.title}</h3>
                  </div>
                  <p className="text-[10px] sm:text-[11px] text-zinc-500 leading-relaxed">{item.desc}</p>
                </div>
              </FadeSection>
            ))}
          </div>
        </div>
      </section>

      {/* Five modes of comprehension — deep dive */}
      <section className="py-16 sm:py-20 md:py-28 px-4 sm:px-6 relative">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 50%, rgba(0,243,255,0.03) 0%, transparent 60%)' }} />
        <div className="max-w-5xl mx-auto relative z-10">
          <FadeSection>
            <p className="text-[9px] sm:text-[10px] font-mono uppercase tracking-[0.3em] text-neon-cyan mb-3">Five modes of comprehension</p>
            <h2 className="text-xl sm:text-2xl md:text-4xl font-bold tracking-tight text-white mb-2 sm:mb-3">
              Read it. Hear it. Discuss it.<br />See it. Watch it.
            </h2>
            <p className="text-zinc-500 text-xs sm:text-sm max-w-lg mb-12 sm:mb-16">
              One book, five angles of understanding. Pick the one that makes the chapter click — or layer all of them.
            </p>
          </FadeSection>

          {/* 01 · Read & Understand */}
          <FadeSection>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8 items-center mb-16 sm:mb-24">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <BookOpen size={14} className="text-neon-cyan" />
                  <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-neon-cyan">01 · Read &amp; Understand</p>
                </div>
                <h3 className="text-lg sm:text-2xl font-bold tracking-tight text-white leading-tight">
                  Bilingual pages.<br />A voice that <span className="text-neon-cyan">follows your eyes</span>.
                </h3>
                <p className="text-[11px] sm:text-sm text-zinc-400 leading-relaxed">
                  Split-screen original and translation. The audiobook reads with you — every sentence highlighted in turn, every voice, pace, and accent your choice. Tap a word for what it means <em className="text-zinc-300 not-italic">here</em>, not in some dictionary. Save it, copy it, send it to your notebook.
                </p>
                <ul className="space-y-1.5 pt-2">
                  {['8 voices · adjustable pace', 'Sentence-level auto-highlight', 'Tap-word contextual meaning', 'Notebook integration in one tap'].map(l => (
                    <li key={l} className="text-[10px] sm:text-[11px] text-zinc-500 font-mono flex items-center gap-2">
                      <span className="text-neon-cyan">+</span>{l}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-void-2 border border-neon-cyan/20 rounded-sm p-4 sm:p-5 font-mono text-[10px] sm:text-[11px] space-y-3 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-neon-cyan/40 to-transparent" />
                <div className="grid grid-cols-2 gap-3 text-zinc-400 leading-relaxed">
                  <div>
                    <p className="text-[8px] uppercase tracking-widest text-zinc-600 mb-2">FR · original</p>
                    <p>L'essentiel est <span className="bg-neon-cyan/15 text-neon-cyan px-0.5">invisible</span> pour les yeux.</p>
                  </div>
                  <div>
                    <p className="text-[8px] uppercase tracking-widest text-zinc-600 mb-2">EN · decoded</p>
                    <p>What is essential is <span className="bg-neon-cyan/15 text-neon-cyan px-0.5">invisible</span> to the eye.</p>
                  </div>
                </div>
                <div className="border-t border-zinc-800 pt-3 space-y-1.5">
                  <p className="text-[8px] uppercase tracking-widest text-zinc-600">tap-word · "invisible"</p>
                  <p className="text-zinc-400 leading-relaxed">Here it carries a philosophical weight — not unseen, but <em className="text-zinc-300 not-italic">imperceptible to surface reading</em>. The fox's lesson hinges on this word.</p>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <div className="flex-1 h-1 bg-zinc-900 rounded-full overflow-hidden"><div className="h-full w-1/3 bg-neon-cyan" /></div>
                  <span className="text-[8px] text-zinc-600 font-mono">0:14 / 0:42</span>
                </div>
              </div>
            </div>
          </FadeSection>

          {/* 02 · Discuss — reversed layout */}
          <FadeSection>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8 items-center mb-16 sm:mb-24">
              <div className="space-y-3 md:order-2">
                <div className="flex items-center gap-2">
                  <Mic2 size={14} className="text-[#f59e0b]" />
                  <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-[#f59e0b]">02 · Discuss</p>
                </div>
                <h3 className="text-lg sm:text-2xl font-bold tracking-tight text-white leading-tight">
                  Two hosts. One chapter.<br /><span className="text-[#f59e0b]">Whatever language you want</span>.
                </h3>
                <p className="text-[11px] sm:text-sm text-zinc-400 leading-relaxed">
                  Turn any chapter into a 12-minute conversation. Pick the host style — academic, casual, late-night radio — and the language they discuss in, independent of the book's language. Listen on the walk, download audio and transcript when you're done.
                </p>
                <ul className="space-y-1.5 pt-2">
                  {['Host style: academic · casual · late-night', 'Discussion language independent of book', 'Audio + script both downloadable', 'Pause to ask follow-ups any time'].map(l => (
                    <li key={l} className="text-[10px] sm:text-[11px] text-zinc-500 font-mono flex items-center gap-2">
                      <span className="text-[#f59e0b]">+</span>{l}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-void-2 border border-[#f59e0b]/20 rounded-sm p-4 sm:p-5 font-mono text-[10px] sm:text-[11px] space-y-3 md:order-1 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[#f59e0b]/40 to-transparent" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[8px] uppercase tracking-widest text-zinc-600">EP · ch. 21</span>
                    <span className="text-[#f59e0b]">●</span>
                    <span className="text-[8px] text-zinc-500">FR book · EN discussion</span>
                  </div>
                  <span className="text-[8px] text-zinc-600">12:04</span>
                </div>
                {/* Waveform */}
                <div className="flex items-end gap-[2px] h-10">
                  {[3,7,4,8,5,9,6,4,7,8,5,3,6,9,7,4,8,5,9,6,3,7,5,8,4,6,9,5,3,7,4,8,5,9,6,4,7,5,3].map((h,i) => (
                    <div key={i} className="w-1 bg-[#f59e0b]/50" style={{ height: `${h*10}%` }} />
                  ))}
                </div>
                <div className="border-t border-zinc-800 pt-3 space-y-2">
                  <div className="flex gap-2">
                    <span className="text-[8px] text-[#f59e0b] uppercase tracking-widest shrink-0">Maya</span>
                    <p className="text-zinc-400 leading-relaxed">"The fox doesn't just teach a moral here — he reframes what 'taming' means. It's almost a contract."</p>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-[8px] text-zinc-500 uppercase tracking-widest shrink-0">Jules</span>
                    <p className="text-zinc-500 leading-relaxed">"Right, and Saint-Exupéry borrows that from his own pilot life — the rituals, the trust…"</p>
                  </div>
                </div>
              </div>
            </div>
          </FadeSection>

          {/* 03 · Visualize */}
          <FadeSection>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8 items-center mb-16 sm:mb-24">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <ImageIcon size={14} className="text-neon-violet" />
                  <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-neon-violet">03 · Visualize</p>
                </div>
                <h3 className="text-lg sm:text-2xl font-bold tracking-tight text-white leading-tight">
                  Concepts<br /><span className="text-neon-violet">you can see</span>.
                </h3>
                <p className="text-[11px] sm:text-sm text-zinc-400 leading-relaxed">
                  Visualize the chapter's ideas, places, and characters. Pick an art style — line drawing, cinematic still, watercolor — and the aspect ratio. Save the images as note material, slide decks, or just to look at while the words settle.
                </p>
                <ul className="space-y-1.5 pt-2">
                  {['6+ art styles', 'Aspect ratios for note / slide / wallpaper', 'Generated per concept, not per page', 'Download as PNG'].map(l => (
                    <li key={l} className="text-[10px] sm:text-[11px] text-zinc-500 font-mono flex items-center gap-2">
                      <span className="text-neon-violet">+</span>{l}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-void-2 border border-neon-violet/20 rounded-sm p-4 sm:p-5 space-y-3 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-neon-violet/40 to-transparent" />
                <div className="flex items-center justify-between">
                  <p className="text-[8px] uppercase tracking-widest text-zinc-600 font-mono">Style · cinematic still · 16:9</p>
                  <span className="text-[8px] text-zinc-600 font-mono">×3 variants</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[0,1,2].map(i => (
                    <div key={i} className="aspect-video rounded-sm relative overflow-hidden" style={{
                      background: i === 0
                        ? 'linear-gradient(135deg, #1a1145 0%, #a78bfa 60%, #f9c97c 100%)'
                        : i === 1
                        ? 'linear-gradient(160deg, #0a0a2a 0%, #4c1d95 50%, #fbbf24 100%)'
                        : 'linear-gradient(120deg, #2d1b4e 0%, #c4b5fd 70%, #fde68a 100%)'
                    }}>
                      <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
                      <div className="absolute bottom-1 left-1 w-1.5 h-1.5 rounded-full bg-white/80" />
                    </div>
                  ))}
                </div>
                <p className="text-[10px] sm:text-[11px] text-zinc-400 font-mono leading-relaxed">
                  <span className="text-zinc-600">prompt ›</span> the little prince stands on his tiny asteroid, watching forty-four sunsets…
                </p>
              </div>
            </div>
          </FadeSection>

          {/* 04 · Watch */}
          <FadeSection>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8 items-center mb-16 sm:mb-24">
              <div className="space-y-3 md:order-2">
                <div className="flex items-center gap-2">
                  <Film size={14} className="text-neon-red" />
                  <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-neon-red">04 · Watch</p>
                </div>
                <h3 className="text-lg sm:text-2xl font-bold tracking-tight text-white leading-tight">
                  A chapter, in<br /><span className="text-neon-red">moving pictures</span>.
                </h3>
                <p className="text-[11px] sm:text-sm text-zinc-400 leading-relaxed">
                  Each chapter becomes a short summary video — visual context that turns abstract scenes into something you'll actually remember. The kind of memory that holds vocabulary in place long after the page is closed.
                </p>
                <ul className="space-y-1.5 pt-2">
                  {['60–90 second summary per chapter', '720p / 1080p export', 'Narration in your target language', 'Save to library or download as MP4'].map(l => (
                    <li key={l} className="text-[10px] sm:text-[11px] text-zinc-500 font-mono flex items-center gap-2">
                      <span className="text-neon-red">+</span>{l}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-void-2 border border-neon-red/20 rounded-sm p-4 sm:p-5 space-y-3 md:order-1 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-neon-red/40 to-transparent" />
                <div className="flex items-center justify-between">
                  <p className="text-[8px] uppercase tracking-widest text-zinc-600 font-mono">Ch. 21 · The Fox</p>
                  <span className="text-[8px] text-zinc-600 font-mono">1080p · 1:24</span>
                </div>
                <div className="aspect-video rounded-sm relative overflow-hidden" style={{ background: 'radial-gradient(circle at 30% 60%, #fbbf24 0%, #f97316 30%, #1f0f3a 70%, #020202 100%)' }}>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white/20 backdrop-blur-sm border border-white/40 flex items-center justify-center">
                      <div className="w-0 h-0 border-l-[8px] border-l-white border-y-[5px] border-y-transparent ml-0.5" />
                    </div>
                  </div>
                </div>
                {/* Film strip */}
                <div className="flex gap-1">
                  {[0,1,2,3,4].map(i => (
                    <div key={i} className="flex-1 aspect-video rounded-[2px]" style={{
                      background: `linear-gradient(${120 + i*20}deg, #ff003c${i === 0 ? '60' : '20'}, #1a0510)`
                    }} />
                  ))}
                </div>
              </div>
            </div>
          </FadeSection>

          {/* 05 · Notebook */}
          <FadeSection>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8 items-center mb-8">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Map size={14} className="text-[#10b981]" />
                  <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-[#10b981]">05 · Notebook</p>
                </div>
                <h3 className="text-lg sm:text-2xl font-bold tracking-tight text-white leading-tight">
                  Everything you<br /><span className="text-[#10b981]">wanted to keep</span>.
                </h3>
                <p className="text-[11px] sm:text-sm text-zinc-400 leading-relaxed">
                  Save words, sentences, and sparks. The notebook draws itself into a mind map of what you've decoded — and exports as sticky notes you can share. Every artifact you generate — audio, scripts, images, video — is yours to download.
                </p>
                <ul className="space-y-1.5 pt-2">
                  {['Words · sentences · sparks · all in one place', 'Auto-generated mind maps', 'Shareable sticky notes', 'Cloud-synced across devices'].map(l => (
                    <li key={l} className="text-[10px] sm:text-[11px] text-zinc-500 font-mono flex items-center gap-2">
                      <span className="text-[#10b981]">+</span>{l}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-void-2 border border-[#10b981]/20 rounded-sm p-4 sm:p-5 space-y-3 relative overflow-hidden min-h-[220px]">
                <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[#10b981]/40 to-transparent" />
                <p className="text-[8px] uppercase tracking-widest text-zinc-600 font-mono">12 sparks · 4 chapters</p>
                <div className="relative h-[180px]">
                  {/* Sticky notes pile */}
                  <div className="absolute top-2 left-2 w-32 sm:w-36 p-2.5 rounded-sm shadow-md bg-[#fef3c7] rotate-[-3deg] text-[10px] leading-tight text-zinc-800">
                    <p className="font-mono text-[7px] uppercase tracking-widest text-zinc-500 mb-1">apprivoiser</p>
                    <p>to tame — but really, "to make tied to one another"</p>
                  </div>
                  <div className="absolute top-8 left-20 sm:left-28 w-32 sm:w-36 p-2.5 rounded-sm shadow-md bg-[#fce7f3] rotate-[2deg] text-[10px] leading-tight text-zinc-800">
                    <p className="font-mono text-[7px] uppercase tracking-widest text-zinc-500 mb-1">ch.21 · spark</p>
                    <p>"You become responsible, forever, for what you have tamed."</p>
                  </div>
                  <div className="absolute bottom-2 left-6 sm:left-12 w-32 sm:w-36 p-2.5 rounded-sm shadow-md bg-[#d1fae5] rotate-[-1deg] text-[10px] leading-tight text-zinc-800">
                    <p className="font-mono text-[7px] uppercase tracking-widest text-zinc-500 mb-1">mind map</p>
                    <p>Fox → Rose → Prince · the ritual of taming</p>
                  </div>
                </div>
              </div>
            </div>
          </FadeSection>

          <FadeSection delay={200}>
            <p className="text-[9px] sm:text-[10px] text-zinc-600 font-mono text-center mt-4">
              Every artifact — audio, image, script, video — is downloadable. Your book, your output.
            </p>
          </FadeSection>
        </div>
      </section>

      {/* Getting started */}
      <section className="py-16 sm:py-20 md:py-28 px-4 sm:px-6 border-t border-zinc-900">
        <div className="max-w-3xl mx-auto">
          <FadeSection>
            <p className="text-[9px] sm:text-[10px] font-mono uppercase tracking-[0.3em] text-emerald-500 mb-3 text-center">Getting started</p>
            <h2 className="text-xl sm:text-2xl md:text-4xl font-bold tracking-tight text-white mb-10 sm:mb-16 text-center">Upload. <span className="text-neon-cyan">Decode</span>. Finish.</h2>
          </FadeSection>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 sm:gap-4">
            {[
              { step: '01', title: 'Upload', desc: 'Drop any EPUB, PDF, or text file. AI breaks it into chapters.', icon: Upload, color: '#00f3ff' },
              { step: '02', title: 'Customize', desc: 'Set target language. Adjust font, spacing, highlight color.', icon: Languages, color: '#f59e0b' },
              { step: '03', title: 'Decode', desc: 'Bilingual view, tap-to-translate, TTS, AI chat — one tap away.', icon: Sparkles, color: '#10b981' },
            ].map((s, i) => (
              <FadeSection key={i} delay={i * 150}>
                <div className="text-center space-y-2.5 sm:space-y-3">
                  <div className="w-12 h-12 sm:w-14 sm:h-14 mx-auto content-panel rounded-full flex items-center justify-center">
                    <s.icon size={18} style={{ color: s.color }} />
                  </div>
                  <p className="text-[10px] font-mono tracking-widest" style={{ color: s.color }}>{s.step}</p>
                  <h3 className="font-mono font-bold text-[11px] sm:text-sm text-white">{s.title}</h3>
                  <p className="text-[10px] sm:text-[11px] text-zinc-500 max-w-[200px] mx-auto leading-relaxed">{s.desc}</p>
                </div>
              </FadeSection>
            ))}
          </div>
        </div>
      </section>

      {/* Trust — your books stay yours */}
      <section className="py-12 sm:py-16 md:py-20 px-4 sm:px-6 border-t border-zinc-900">
        <div className="max-w-4xl mx-auto">
          <FadeSection>
            <p className="text-[9px] sm:text-[10px] font-mono uppercase tracking-[0.3em] text-emerald-500 mb-3 text-center">Trust</p>
            <h2 className="text-lg sm:text-2xl md:text-3xl font-bold tracking-tight text-white text-center mb-10 sm:mb-12">
              Your books stay <span className="text-emerald-400">yours</span>.
            </h2>
          </FadeSection>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
            {[
              { tag: 'Private', body: 'Your uploaded books are visible to you only. Never indexed, never shared, never resold.', color: '#10b981' },
              { tag: 'No training', body: "Nothing you upload is used to train models. The AI reads — it doesn't remember.", color: '#00f3ff' },
              { tag: 'Keys on the server', body: 'API keys never touch the browser. Every call routes through our worker, encrypted in transit.', color: '#a78bfa' },
            ].map((p, i) => (
              <FadeSection key={i} delay={i * 80}>
                <div className="bg-void-2 border rounded-sm p-4 sm:p-5 h-full" style={{ borderColor: `${p.color}20` }}>
                  <p className="text-[10px] font-mono uppercase tracking-[0.25em] mb-2" style={{ color: p.color }}>{p.tag}</p>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">{p.body}</p>
                </div>
              </FadeSection>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-16 sm:py-20 md:py-28 px-4 sm:px-6 relative">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 50%, rgba(0,243,255,0.03) 0%, transparent 60%)' }} />
        <div className="max-w-4xl mx-auto relative z-10">
          <FadeSection>
            <p className="text-[9px] sm:text-[10px] font-mono uppercase tracking-[0.3em] text-amber-500 mb-3 text-center">Pricing</p>
            <h2 className="text-xl sm:text-2xl md:text-4xl font-bold tracking-tight text-white mb-2 sm:mb-3 text-center">Decode your first chapter free.</h2>
            <p className="text-zinc-500 text-xs sm:text-sm text-center mb-8 sm:mb-12">100 credits/month — enough for several chapters with full AI support.</p>
          </FadeSection>
          <FadeSection delay={100}>
            <PricingCards onEnterApp={onEnterApp} />
          </FadeSection>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-16 sm:py-20 md:py-28 px-4 sm:px-6 relative">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 80%, rgba(0,243,255,0.05) 0%, transparent 50%)' }} />
        <div className="max-w-3xl mx-auto text-center relative z-10 space-y-5 sm:space-y-6">
          <FadeSection>
            <h2 className="text-xl sm:text-3xl md:text-5xl font-bold tracking-tight text-white leading-tight">
              Every book you gave up on<br />was just <span className="text-neon-cyan">missing a tutor</span>.
            </h2>
          </FadeSection>
          <FadeSection delay={100}>
            <button onClick={onEnterApp} className="px-5 sm:px-10 py-3 sm:py-3.5 bg-neon-cyan text-black font-mono font-bold text-[10px] sm:text-xs uppercase tracking-widest rounded-sm hover:bg-neon-cyan/90 transition-all hover:shadow-glow-lg inline-flex items-center gap-2">
              Decode Your First Book <ArrowRight size={14} />
            </button>
            <p className="text-[9px] sm:text-[10px] text-zinc-600 font-mono mt-3">Free · EPUB, PDF, TXT · 50+ languages</p>
          </FadeSection>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-900 py-6 sm:py-8 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-4">
          <span className="font-mono text-[10px] sm:text-xs text-zinc-600">DecodEbook &copy; {new Date().getFullYear()}</span>
          <div className="flex items-center gap-4 sm:gap-6">
            <button onClick={onSignIn} className="text-[10px] font-mono text-zinc-600 hover:text-white transition-colors uppercase tracking-widest">Sign In</button>
            <button onClick={onEnterApp} className="text-[10px] font-mono text-zinc-600 hover:text-neon-cyan transition-colors uppercase tracking-widest">Open App</button>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── Version C: Poster ───

const PILL_LABELS = ['AI Translation', 'Neural TTS', 'Smart Chat', 'Mind Maps', 'Podcast Generator', 'Video Summaries', 'Image Generation'];

function VersionC({ onEnterApp, onSignIn }: { onEnterApp: () => void; onSignIn: () => void }) {
  const [activePill, setActivePill] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setActivePill(p => (p + 1) % PILL_LABELS.length), 2000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="h-screen bg-void-0 flex flex-col items-center justify-between overflow-hidden relative">
      <div className="absolute inset-0 bg-grid opacity-20" />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 40%, rgba(0,243,255,0.04) 0%, transparent 60%)' }} />

      {/* Top bar */}
      <nav className="w-full flex items-center justify-between px-6 py-4 relative z-10">
        <span className="font-mono font-bold text-sm tracking-wider text-white">Decod<span className="text-neon-cyan">Ebook</span></span>
        <div className="flex items-center gap-3">
          <button onClick={onSignIn} className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 hover:text-white transition-colors">Sign In</button>
        </div>
      </nav>

      {/* Center */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 relative z-10 space-y-8 max-w-3xl">
        <h1 className="text-3xl sm:text-5xl md:text-7xl font-bold tracking-tighter text-center leading-[0.95]">
          Read any book.<br />
          In any language.<br />
          <span className="text-neon-cyan drop-shadow-[0_0_25px_rgba(0,243,255,0.3)]">With AI.</span>
        </h1>

        {/* Animated pills */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {PILL_LABELS.map((label, i) => (
            <span
              key={label}
              className={`text-[10px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-sm border transition-all duration-500 ${
                i === activePill
                  ? 'border-neon-cyan/50 text-neon-cyan bg-neon-cyan/10 shadow-[0_0_15px_rgba(0,243,255,0.15)]'
                  : 'border-zinc-800 text-zinc-600'
              }`}
            >
              {label}
            </span>
          ))}
        </div>

        {/* Screenshot placeholder */}
        <div className="w-full max-w-2xl aspect-video content-panel rounded-sm overflow-hidden relative group">
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center space-y-2">
              <BookOpen size={32} className="text-zinc-700 mx-auto" />
              <p className="text-[10px] font-mono text-zinc-700 uppercase tracking-widest">App Preview</p>
            </div>
          </div>
          <div className="absolute inset-0 bg-gradient-to-t from-void-0 via-transparent to-transparent" />
        </div>
      </div>

      {/* Bottom */}
      <div className="w-full px-6 pb-8 relative z-10 space-y-4">
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button onClick={onEnterApp} className="px-8 py-3 bg-neon-cyan text-black font-mono font-bold text-xs uppercase tracking-widest rounded-sm hover:bg-neon-cyan/90 transition-all hover:shadow-glow-lg flex items-center gap-2">
            Start Free — 100 credits/mo <ArrowRight size={14} />
          </button>
          <button onClick={onEnterApp} className="px-8 py-3 border border-neon-cyan/30 text-neon-cyan font-mono font-bold text-xs uppercase tracking-widest rounded-sm hover:bg-neon-cyan/10 transition-all flex items-center gap-2">
            Go Pro — $9.99/mo <Crown size={14} />
          </button>
        </div>
        <p className="text-[10px] text-zinc-600 font-mono text-center">No credit card required &middot; Upload EPUB, PDF, TXT</p>
      </div>
    </div>
  );
}

// ─── Version B: Interactive Demo ───

const DEMO_TEXT = `It is only with the heart that one can see rightly; what is essential is invisible to the eye. And now here is my secret, a very simple secret: It is only with the heart that one can see rightly; what is essential is invisible to the eye.`;

const DEMO_TRANSLATION = `C'est seulement avec le cœur qu'on peut voir correctement ; l'essentiel est invisible pour les yeux. Et voici mon secret, un secret très simple : c'est seulement avec le cœur qu'on peut voir correctement ; l'essentiel est invisible pour les yeux.`;

const DEMO_CHAT_ANSWER = `The Little Prince uses the metaphor of "seeing with the heart" to distinguish between superficial observation and deeper understanding. The fox teaches this lesson — that meaningful connections and truths require emotional engagement, not just rational analysis. It's the book's central philosophy: what matters most can't be measured or seen.`;

const DEMO_MINDMAP = {
  center: 'The Little Prince',
  branches: [
    { label: 'Themes', children: ['Loneliness', 'Friendship', 'Loss of innocence'] },
    { label: 'Characters', children: ['The Prince', 'The Fox', 'The Rose'] },
    { label: 'Symbols', children: ['Stars', 'Desert', 'Water'] },
  ],
};

type DemoAction = 'translate' | 'tts' | 'chat' | 'mindmap' | null;

function VersionB({ onEnterApp, onSignIn }: { onEnterApp: () => void; onSignIn: () => void }) {
  useUnlockScroll();
  const [activeDemo, setActiveDemo] = useState<DemoAction>(null);
  const [typing, setTyping] = useState('');
  const [showResult, setShowResult] = useState(false);

  const triggerDemo = (action: DemoAction) => {
    setActiveDemo(action);
    setShowResult(false);
    setTyping('');
    setTimeout(() => setShowResult(true), 600);
  };

  useEffect(() => {
    if (!showResult || activeDemo !== 'chat') return;
    let i = 0;
    const t = setInterval(() => {
      i++;
      setTyping(DEMO_CHAT_ANSWER.slice(0, i));
      if (i >= DEMO_CHAT_ANSWER.length) clearInterval(t);
    }, 12);
    return () => clearInterval(t);
  }, [showResult, activeDemo]);

  const resetDemo = () => { setActiveDemo(null); setShowResult(false); setTyping(''); };

  return (
    <div className="min-h-screen bg-void-0 text-zinc-100 overflow-x-hidden">
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 bg-void-0/80 backdrop-blur-md border-b border-zinc-900">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-6 py-3">
          <span className="font-mono font-bold text-sm tracking-wider text-white">Decod<span className="text-neon-cyan">Ebook</span></span>
          <div className="flex items-center gap-3">
            <button onClick={onSignIn} className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 hover:text-white transition-colors">Sign In</button>
            <button onClick={onEnterApp} className="text-[10px] font-mono uppercase tracking-widest bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan px-4 py-1.5 rounded-sm hover:bg-neon-cyan/20 transition-colors">Try Free</button>
          </div>
        </div>
      </nav>

      {/* Demo Hero */}
      <section className="pt-20 pb-12 px-6 min-h-screen flex flex-col items-center justify-center">
        <div className="max-w-3xl w-full space-y-6">
          <div className="text-center space-y-2">
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-neon-cyan">Live demo</p>
            <h1 className="text-2xl sm:text-3xl md:text-5xl font-bold tracking-tight">
              Try it. <span className="text-neon-cyan">Right now.</span>
            </h1>
            <p className="text-zinc-500 text-sm">Click any action below to see AI transform this passage.</p>
          </div>

          {/* Book mock */}
          <div className="content-panel rounded-sm overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-[#080808]">
              <BookOpen size={12} className="text-neon-cyan" />
              <span className="text-[10px] font-mono text-zinc-500">The Little Prince — Antoine de Saint-Exupéry</span>
            </div>
            <div className="p-6">
              <p className="text-sm text-zinc-300 leading-relaxed font-serif">{DEMO_TEXT}</p>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 px-4 pb-4">
              {[
                { id: 'translate' as DemoAction, label: 'Translate to French', icon: Languages },
                { id: 'tts' as DemoAction, label: 'Read Aloud', icon: Headphones },
                { id: 'chat' as DemoAction, label: 'Ask AI', icon: MessageSquare },
                { id: 'mindmap' as DemoAction, label: 'Mind Map', icon: Map },
              ].map(btn => (
                <button
                  key={btn.id}
                  onClick={() => activeDemo === btn.id ? resetDemo() : triggerDemo(btn.id)}
                  className={`text-[10px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-sm border transition-all flex items-center gap-1.5 ${
                    activeDemo === btn.id
                      ? 'border-neon-cyan/50 text-neon-cyan bg-neon-cyan/10'
                      : 'border-zinc-800 text-zinc-500 hover:border-neon-cyan/30 hover:text-neon-cyan'
                  }`}
                >
                  <btn.icon size={12} /> {btn.label}
                </button>
              ))}
            </div>

            {/* Results */}
            {activeDemo && (
              <div className="border-t border-zinc-800 p-4">
                {!showResult ? (
                  <div className="flex items-center gap-2 text-[10px] font-mono text-neon-cyan">
                    <div className="w-3 h-3 border-2 border-neon-cyan border-t-transparent rounded-full animate-spin" />
                    Processing...
                  </div>
                ) : activeDemo === 'translate' ? (
                  <div className="space-y-2 animate-fade-in">
                    <p className="text-[10px] font-mono text-neon-cyan uppercase tracking-widest">French Translation</p>
                    <p className="text-sm text-zinc-300 leading-relaxed font-serif italic">{DEMO_TRANSLATION}</p>
                  </div>
                ) : activeDemo === 'tts' ? (
                  <div className="space-y-3 animate-fade-in">
                    <p className="text-[10px] font-mono text-neon-cyan uppercase tracking-widest">Neural TTS</p>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1">
                        {Array.from({ length: 24 }).map((_, i) => (
                          <div key={i} className="w-1 bg-neon-cyan rounded-full animate-pulse" style={{ height: `${8 + Math.random() * 20}px`, animationDelay: `${i * 0.05}s` }} />
                        ))}
                      </div>
                      <span className="text-[10px] font-mono text-zinc-500">0:12 / 0:28</span>
                    </div>
                    <p className="text-[10px] text-zinc-600 font-mono">Audio preview — sign up to hear full pages</p>
                  </div>
                ) : activeDemo === 'chat' ? (
                  <div className="space-y-2 animate-fade-in">
                    <p className="text-[10px] font-mono text-zinc-500">Q: What does "seeing with the heart" mean in this context?</p>
                    <p className="text-sm text-zinc-300 leading-relaxed">{typing}<span className="animate-blink text-neon-cyan">|</span></p>
                  </div>
                ) : activeDemo === 'mindmap' ? (
                  <div className="space-y-3 animate-fade-in">
                    <p className="text-[10px] font-mono text-neon-cyan uppercase tracking-widest">Mind Map</p>
                    <div className="flex flex-col items-center gap-4 py-4">
                      <span className="text-xs font-mono font-bold text-neon-cyan border border-neon-cyan/30 bg-neon-cyan/5 px-4 py-2 rounded-sm">{DEMO_MINDMAP.center}</span>
                      <div className="flex flex-wrap justify-center gap-6">
                        {DEMO_MINDMAP.branches.map((b, i) => (
                          <div key={i} className="text-center space-y-2">
                            <span className="text-[10px] font-mono font-bold text-white border border-zinc-700 bg-zinc-800/50 px-3 py-1 rounded-sm inline-block">{b.label}</span>
                            <div className="flex flex-col gap-1">
                              {b.children.map((c, j) => (
                                <span key={j} className="text-[10px] font-mono text-zinc-500">{c}</span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* Prompt */}
          <div className="text-center space-y-3 pt-4">
            <p className="text-zinc-400 text-sm">Like it? Upload your own book.</p>
            <button onClick={onEnterApp} className="px-8 py-3 bg-neon-cyan text-black font-mono font-bold text-xs uppercase tracking-widest rounded-sm hover:bg-neon-cyan/90 transition-all hover:shadow-glow-lg inline-flex items-center gap-2">
              Get Started Free <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </section>

      {/* Feature grid */}
      <section className="py-24 px-6 border-t border-zinc-900">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white mb-8 text-center">Everything your books need.</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {FEATURES.map((f, i) => (
              <div key={i} className="content-panel rounded-sm p-4 space-y-2 hover:border-neon-cyan/20 transition-colors">
                <div className="flex items-center gap-2">
                  <f.icon size={14} className="text-neon-cyan" />
                  <span className="text-[10px] font-mono font-bold text-white tracking-wide">{f.title}</span>
                  <span className="text-[8px] font-mono text-zinc-600 ml-auto">{f.credit}</span>
                </div>
                <p className="text-[10px] text-zinc-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white mb-8 text-center">Simple pricing.</h2>
          <PricingCards onEnterApp={onEnterApp} />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-900 py-8 px-6">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <span className="font-mono text-xs text-zinc-600">DecodEbook — read smarter, not harder.</span>
          <div className="flex items-center gap-6">
            <button onClick={onSignIn} className="text-[10px] font-mono text-zinc-600 hover:text-white transition-colors uppercase tracking-widest">Sign In</button>
            <button onClick={onEnterApp} className="text-[10px] font-mono text-zinc-600 hover:text-neon-cyan transition-colors uppercase tracking-widest">Open App</button>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── Version D: Jobs Cut ───
// Three screens. Black & white. One image per screen. No pricing. No segments.
// The promise is that you're no longer alone with the page.

function VersionD({ onEnterApp, onSignIn }: { onEnterApp: () => void; onSignIn: () => void }) {
  useUnlockScroll();
  const [screen, setScreen] = useState(0);
  const screensRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => {
      const h = window.innerHeight;
      setScreen(Math.round(window.scrollY / h));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToScreen = (i: number) => {
    window.scrollTo({ top: i * window.innerHeight, behavior: 'smooth' });
  };

  return (
    <div ref={screensRef} className="bg-white text-black antialiased">
      {/* Tiny, restrained nav. White space does the talking. */}
      <nav className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 sm:px-10 py-4">
          <span className="font-semibold tracking-tight text-[15px] text-black">DecodEbook</span>
          <div className="flex items-center gap-6">
            <button onClick={onSignIn} className="text-[13px] text-zinc-500 hover:text-black transition-colors">Sign in</button>
            <button onClick={onEnterApp} className="text-[13px] text-black hover:text-zinc-600 transition-colors">Open →</button>
          </div>
        </div>
      </nav>

      {/* Progress dots — right edge, tiny, almost invisible. */}
      <div className="fixed right-5 top-1/2 -translate-y-1/2 z-40 flex flex-col gap-2.5">
        {[0, 1, 2].map(i => (
          <button
            key={i}
            onClick={() => scrollToScreen(i)}
            className={`w-1.5 h-1.5 rounded-full transition-all ${screen === i ? 'bg-black scale-125' : 'bg-zinc-300 hover:bg-zinc-500'}`}
            aria-label={`Screen ${i + 1}`}
          />
        ))}
      </div>

      {/* ─── Screen 1 ─── The promise. */}
      <section className="h-screen flex flex-col items-center justify-center px-6 relative">
        <div className="text-center space-y-12 sm:space-y-16 max-w-4xl">
          <h1
            className="text-[2.75rem] sm:text-6xl md:text-[5.5rem] font-semibold tracking-[-0.03em] leading-[1.02] text-black"
            style={{ fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif' }}
          >
            The book<br />that listens back.
          </h1>
          <div>
            <button
              onClick={onEnterApp}
              className="inline-flex items-center gap-2 bg-black text-white text-[15px] font-medium px-7 py-3.5 rounded-full hover:bg-zinc-800 transition-colors"
            >
              Try it
            </button>
          </div>
        </div>
        <button
          onClick={() => scrollToScreen(1)}
          className="absolute bottom-10 left-1/2 -translate-x-1/2 text-zinc-400 hover:text-black transition-colors"
          aria-label="Next"
        >
          <ChevronDown size={22} strokeWidth={1.5} />
        </button>
      </section>

      {/* ─── Screen 2 ─── The story + the one artifact. */}
      <section className="min-h-screen flex items-center px-6 sm:px-10 py-20 sm:py-24 border-t border-zinc-100">
        <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-12 sm:gap-20 items-center w-full">
          <div className="space-y-7 sm:space-y-9 max-w-md">
            <h2
              className="text-[2rem] sm:text-4xl md:text-[3.25rem] font-semibold tracking-[-0.025em] leading-[1.08] text-black"
              style={{ fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif' }}
            >
              You used to read alone.
            </h2>
            <p className="text-[17px] sm:text-[19px] text-zinc-600 leading-[1.55]">
              Now your book reads with you. Tap any word — not for a dictionary definition, but for what it means right here, on this page, in this paragraph. Ask why a sentence works. Hear it spoken in the voice you choose.
            </p>
            <p className="text-[17px] sm:text-[19px] text-zinc-900 leading-[1.55] font-medium">
              The book stops being a wall.<br />It starts being a conversation.
            </p>
          </div>

          {/* The one artifact. A page. A glowing word. A spoken answer. */}
          <div className="relative w-full max-w-md mx-auto">
            <div className="relative aspect-[4/5] bg-zinc-50 rounded-[28px] overflow-hidden shadow-[0_20px_60px_-20px_rgba(0,0,0,0.15)]">
              {/* Page */}
              <div className="absolute inset-0 p-8 sm:p-10 flex flex-col">
                <p className="text-[10px] uppercase tracking-[0.25em] text-zinc-400 mb-6">Le Petit Prince · Ch. 21</p>
                <div className="space-y-3 text-[15px] sm:text-[17px] leading-[1.7] text-zinc-700">
                  <p>"Bonjour", répondit poliment le petit prince, qui se retourna mais ne vit rien.</p>
                  <p>"Je suis là, dit la voix, sous le pommier..."</p>
                  <p>"Qui es-tu? dit le petit prince. Tu es bien joli..."</p>
                  <p>"Je suis un renard, dit le renard."</p>
                  <p>"Viens jouer avec moi, lui proposa le petit prince. Je suis si triste..."</p>
                  <p>"Je ne puis pas jouer avec toi, dit le renard. Je ne suis pas <span className="bg-black text-white px-1 rounded-[3px]">apprivoisé</span>."</p>
                </div>
              </div>

              {/* Floating answer card — the magic moment */}
              <div className="absolute bottom-6 left-6 right-6 sm:left-8 sm:right-8 bg-white rounded-2xl shadow-[0_8px_30px_-8px_rgba(0,0,0,0.2)] p-5 border border-zinc-100">
                <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 mb-2">apprivoisé</p>
                <p className="text-[14px] leading-[1.5] text-zinc-800">
                  Tamed — but in this book it means something deeper. To be <em>bound</em> to another by ritual and care. The fox is about to teach the prince the difference.
                </p>
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-zinc-100">
                  <div className="w-6 h-6 rounded-full bg-black flex items-center justify-center">
                    <div className="w-0 h-0 border-l-[5px] border-l-white border-y-[3px] border-y-transparent ml-[1px]" />
                  </div>
                  <span className="text-[12px] text-zinc-500">Hear it · French</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Screen 3 ─── The close. One sentence. One button. */}
      <section className="h-screen flex flex-col items-center justify-center px-6 relative border-t border-zinc-100">
        <div className="text-center space-y-12 sm:space-y-14 max-w-3xl">
          <h2
            className="text-[2rem] sm:text-4xl md:text-[3.5rem] font-semibold tracking-[-0.025em] leading-[1.08] text-black"
            style={{ fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif' }}
          >
            Every book on Earth,<br />in any language you speak.
          </h2>
          <p className="text-[15px] sm:text-[17px] text-zinc-500 max-w-md mx-auto">
            Free to start. Bring any book — EPUB, PDF, or text.
          </p>
          <div>
            <button
              onClick={onEnterApp}
              className="inline-flex items-center gap-2 bg-black text-white text-[15px] font-medium px-7 py-3.5 rounded-full hover:bg-zinc-800 transition-colors"
            >
              Open a book →
            </button>
          </div>
        </div>

        <footer className="absolute bottom-8 left-0 right-0 px-6 sm:px-10">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <span className="text-[12px] text-zinc-400">DecodEbook &copy; {new Date().getFullYear()}</span>
            <div className="flex items-center gap-6">
              <button onClick={onSignIn} className="text-[12px] text-zinc-400 hover:text-black transition-colors">Sign in</button>
              <button onClick={onEnterApp} className="text-[12px] text-zinc-400 hover:text-black transition-colors">Open app</button>
            </div>
          </div>
        </footer>
      </section>
    </div>
  );
}

// ─── Version E: Transformation Scroll ───
// Hero → seven feature screens → CTA. Alternating sides.

type FeatureE = {
  id: string;
  num: string;
  codename: string;
  label: string;
  side: 'left' | 'right';
  color: string;
  before: string;
  after: string;
  beforeHighlights?: string[];
  cta: string;
  demo: React.ReactNode;
  demoDurationMs?: number;
  patternBreak?: boolean;
};

const LANDING_E_PALETTE = {
  cyan: '#00f3ff',
  emerald: '#34d399',
  rose: '#ff003c',
  amber: '#fbbf24',
  violet: '#a78bfa',
  pink: '#ff4fd8',
};

const LANDING_E_LEARNING_BLOCKS = [
  { label: 'Read', color: LANDING_E_PALETTE.cyan },
  { label: 'Listen', color: LANDING_E_PALETTE.emerald },
  { label: 'Discuss', color: LANDING_E_PALETTE.amber },
  { label: 'Visualize', color: LANDING_E_PALETTE.violet },
  { label: 'Watch', color: LANDING_E_PALETTE.rose },
  { label: 'Share', color: LANDING_E_PALETTE.pink },
  { label: 'Recap', color: '#38bdf8' },
  { label: 'Ask', color: '#f472b6' },
];

function MediaFrameE({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative w-full max-w-[640px] mx-auto aspect-video">
      {children}
    </div>
  );
}

function LearningBlockRow({ blocks }: { blocks: typeof LANDING_E_LEARNING_BLOCKS }) {
  return (
    <span className="decodebook-scroll-velocity__group">
      {blocks.map(block => (
        <span
          key={block.label}
          className="decodebook-scroll-velocity__chip"
          style={{ color: block.color, borderColor: `${block.color}40` }}
        >
          {block.label}
        </span>
      ))}
    </span>
  );
}

function HeroLearningBlocksVelocity() {
  const rows = [
    LANDING_E_LEARNING_BLOCKS.slice(0, 4),
    LANDING_E_LEARNING_BLOCKS.slice(4),
  ];

  return (
    <div className="decodebook-scroll-velocity mx-auto animate-fade-in" style={{ animationDelay: '0.25s' }}>
      <ScrollVelocity
        texts={rows.map((blocks, index) => <LearningBlockRow key={index} blocks={blocks} />)}
        velocity={18}
        damping={45}
        stiffness={320}
        numCopies={8}
        velocityMapping={{ input: [0, 1000], output: [0, 2.5] }}
        className="decodebook-scroll-velocity__copy"
        parallaxClassName="decodebook-scroll-velocity__row"
        scrollerClassName="decodebook-scroll-velocity__scroller"
      />
    </div>
  );
}

function VoiceSynthDemo() {
  return (
    <div className="h-full bg-void-2 border border-neon-cyan/20 rounded-sm p-4 sm:p-6 font-mono text-[10px] sm:text-[11px] space-y-3 sm:space-y-4 relative overflow-hidden flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-neon-cyan/40 to-transparent" />
      <div className="flex items-center justify-between">
        <p className="text-[8px] sm:text-[9px] uppercase tracking-widest text-zinc-600">Le Petit Prince · Ch. 21</p>
        <span className="text-[9px] text-zinc-600">FR ↔ EN</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 text-zinc-400 leading-[1.6]">
        <div>
          <p className="text-[9px] uppercase tracking-widest text-zinc-600 mb-2">Original</p>
          <p>"Je ne suis pas <span className="bg-neon-cyan/15 text-neon-cyan px-1 rounded-sm">apprivoisé</span>", dit le renard.</p>
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-widest text-zinc-600 mb-2">Decoded</p>
          <p>"I am not <span className="bg-neon-cyan/15 text-neon-cyan px-1 rounded-sm">tamed</span>", said the fox.</p>
        </div>
      </div>
      <div className="border-t border-zinc-800 pt-3 space-y-1.5 flex-1 min-h-0">
        <p className="text-[9px] uppercase tracking-widest text-zinc-600">apprivoisé · in this passage</p>
        <p className="text-zinc-400 leading-[1.65]">Tamed, but in Saint-Exupery's hands it means something deeper: <em className="text-zinc-300 not-italic">to be bound to another by ritual and care.</em></p>
      </div>
      <div className="flex items-center gap-3 pt-1">
        <div className="w-7 h-7 rounded-full bg-neon-cyan/10 border border-neon-cyan/40 flex items-center justify-center shrink-0">
          <div className="w-0 h-0 border-l-[6px] border-l-neon-cyan border-y-[4px] border-y-transparent ml-[2px]" />
        </div>
        <div className="flex-1 h-1 bg-zinc-900 rounded-full overflow-hidden"><div className="h-full w-1/3 bg-neon-cyan" /></div>
        <span className="text-[9px] text-zinc-600">0:14 / 0:42</span>
      </div>
    </div>
  );
}

function PodcastDemo() {
  return (
    <div className="h-full bg-void-2 border border-neon-amber/20 rounded-sm p-4 sm:p-6 font-mono text-[10px] sm:text-[11px] space-y-3 sm:space-y-4 relative overflow-hidden flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-neon-amber/40 to-transparent" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-widest text-zinc-600">Ep · ch. 21</span>
          <span className="text-neon-amber">●</span>
          <span className="text-[9px] text-zinc-500">FR book · EN discussion · late-night</span>
        </div>
        <span className="text-[9px] text-zinc-600">12:04</span>
      </div>
      <div className="flex items-end gap-[2px] h-10 sm:h-12 shrink-0">
        {[3,7,4,8,5,9,6,4,7,8,5,3,6,9,7,4,8,5,9,6,3,7,5,8,4,6,9,5,3,7,4,8,5,9,6,4,7,5,3,6,8,4,9,5,7].map((h,i) => (
          <div key={i} className="flex-1 bg-neon-amber/50" style={{ height: `${h*10}%` }} />
        ))}
      </div>
      <div className="border-t border-zinc-800 pt-3 space-y-2.5 flex-1 min-h-0">
        <div className="flex gap-2.5">
          <span className="text-[9px] text-neon-amber uppercase tracking-widest shrink-0 w-10">Maya</span>
          <p className="text-zinc-400 leading-[1.6]">"The fox is not defining taming. He is showing how responsibility begins."</p>
        </div>
        <div className="flex gap-2.5">
          <span className="text-[9px] text-zinc-500 uppercase tracking-widest shrink-0 w-10">Jules</span>
          <p className="text-zinc-500 leading-[1.6]">"Exactly. The rituals, the trust, the slow approach. The relationship creates the meaning."</p>
        </div>
      </div>
    </div>
  );
}

function VisualCoreDemo() {
  return (
    <div className="h-full bg-void-2 border border-neon-violet/20 rounded-sm p-4 sm:p-6 space-y-3 sm:space-y-4 relative overflow-hidden flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-neon-violet/40 to-transparent" />
      <div className="flex items-center justify-between font-mono">
        <p className="text-[9px] uppercase tracking-widest text-zinc-600">Style · cinematic still · 16:9</p>
        <span className="text-[9px] text-zinc-600">×3 variants</span>
      </div>
      <div className="grid grid-cols-3 gap-2 shrink-0">
        {[0,1,2].map(i => (
          <div key={i} className="aspect-video rounded-sm relative overflow-hidden" style={{
            background: i === 0
              ? 'linear-gradient(135deg, #1a1145 0%, #a78bfa 60%, #f9c97c 100%)'
              : i === 1
              ? 'linear-gradient(160deg, #0a0a2a 0%, #4c1d95 50%, #fbbf24 100%)'
              : 'linear-gradient(120deg, #2d1b4e 0%, #c4b5fd 70%, #fde68a 100%)'
          }}>
            <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
            <div className="absolute bottom-1.5 left-1.5 w-1.5 h-1.5 rounded-full bg-white/80" />
          </div>
        ))}
      </div>
      <p className="text-[10px] sm:text-[11px] text-zinc-400 font-mono leading-[1.65] flex-1 min-h-0">
        <span className="text-zinc-600">prompt ›</span> tiny asteroid, forty-four sunsets, loneliness made visible
      </p>
      <div className="flex items-center gap-2 pt-1 font-mono">
        {['Cinematic', 'Watercolor', 'Line drawing', 'Ukiyo-e'].map((s, i) => (
          <span key={s} className={`text-[9px] px-2 py-0.5 rounded-sm border ${i === 0 ? 'border-neon-violet/40 text-neon-violet bg-neon-violet/10' : 'border-zinc-800 text-zinc-600'}`}>{s}</span>
        ))}
      </div>
    </div>
  );
}

function CineRenderDemo() {
  return (
    <div className="h-full bg-void-2 border border-neon-red/20 rounded-sm p-4 sm:p-6 space-y-3 sm:space-y-4 relative overflow-hidden flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-neon-red/40 to-transparent" />
      <div className="flex items-center justify-between font-mono">
        <p className="text-[9px] uppercase tracking-widest text-zinc-600">Ch. 21 · The Fox</p>
        <span className="text-[9px] text-zinc-600">1080p · 1:24</span>
      </div>
      <div className="aspect-video rounded-sm relative overflow-hidden shrink-0" style={{ background: 'radial-gradient(circle at 30% 60%, #fbbf24 0%, #f97316 30%, #1f0f3a 70%, #020202 100%)' }}>
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-white/20 backdrop-blur-sm border border-white/40 flex items-center justify-center">
            <div className="w-0 h-0 border-l-[9px] border-l-white border-y-[6px] border-y-transparent ml-0.5" />
          </div>
        </div>
        <p className="absolute bottom-3 left-3 right-3 text-[10px] text-white/80 font-mono leading-snug">"You become responsible, forever, for what you have tamed."</p>
      </div>
      <div className="flex gap-1 shrink-0">
        {[0,1,2,3,4,5].map(i => (
          <div key={i} className="flex-1 aspect-video rounded-[2px]" style={{
            background: `linear-gradient(${120 + i*20}deg, #ff003c${i === 2 ? '70' : '20'}, #1a0510)`
          }} />
        ))}
      </div>
    </div>
  );
}

function MemLogDemo() {
  return (
    <div className="h-full bg-void-2 border border-[#34d399]/20 rounded-sm p-4 sm:p-6 space-y-3 relative overflow-hidden flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[#34d399]/40 to-transparent" />
      <div className="flex items-center justify-between font-mono">
        <p className="text-[9px] uppercase tracking-widest text-zinc-600">Notebook · 12 sparks · 4 chapters</p>
        <span className="text-[9px] text-[#34d399]">Mind map ready</span>
      </div>
      <div className="relative flex-1 min-h-0">
        <div className="absolute top-2 left-1 w-32 sm:w-36 p-3 rounded-sm shadow-md bg-[#fef3c7] rotate-[-3deg] text-[10px] sm:text-[11px] leading-[1.35] text-zinc-800">
          <p className="font-mono text-[8px] uppercase tracking-widest text-zinc-500 mb-1">apprivoiser</p>
          <p>to tame, but with ritual and responsibility</p>
        </div>
        <div className="absolute top-9 left-24 sm:left-32 w-36 sm:w-40 p-3 rounded-sm shadow-md bg-[#fce7f3] rotate-[2deg] text-[10px] sm:text-[11px] leading-[1.35] text-zinc-800">
          <p className="font-mono text-[8px] uppercase tracking-widest text-zinc-500 mb-1">ch.1 · spark</p>
          <p>"All grown-ups were once children, but few of them remember it."</p>
        </div>
        <div className="absolute bottom-1 left-8 sm:left-16 w-32 sm:w-36 p-3 rounded-sm shadow-md bg-[#d1fae5] rotate-[-1deg] text-[10px] sm:text-[11px] leading-[1.35] text-zinc-800">
          <p className="font-mono text-[8px] uppercase tracking-widest text-zinc-500 mb-1">mind map</p>
          <p>Fox → Rose → Prince · the ritual of taming</p>
        </div>
      </div>
    </div>
  );
}

function GenFilesDemo() {
  const files = [
    { kind: 'Audio', name: 'ch21_narration_FR.mp3', size: '3.2 MB', color: '#00f3ff' },
    { kind: 'Podcast', name: 'ch21_discussion_EN.mp3', size: '8.7 MB', color: '#fbbf24' },
    { kind: 'Script', name: 'ch21_podcast_transcript.txt', size: '12 KB', color: '#fbbf24' },
    { kind: 'Image', name: 'ch21_cinematic_3x.png', size: '4.1 MB', color: '#a78bfa' },
    { kind: 'Video', name: 'ch21_summary_1080p.mp4', size: '24.3 MB', color: '#ff003c' },
    { kind: 'Notebook', name: 'sparks_4_chapters.pdf', size: '88 KB', color: '#34d399' },
  ];
  return (
    <div className="h-full bg-void-2 border border-[#38bdf8]/20 rounded-sm p-4 sm:p-6 space-y-3 relative overflow-hidden flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[#38bdf8]/40 to-transparent" />
      <div className="flex items-center justify-between font-mono">
        <p className="text-[9px] uppercase tracking-widest text-zinc-600">Generated files · Le Petit Prince</p>
        <button className="text-[9px] uppercase tracking-widest text-[#38bdf8] hover:text-white transition-colors">Download all ↓</button>
      </div>
      <div className="space-y-1.5 flex-1 min-h-0">
        {files.map((f, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-sm border border-zinc-800/50 hover:border-zinc-700 transition-colors group">
            <span className="text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm shrink-0 w-[68px] text-center" style={{ color: f.color, backgroundColor: `${f.color}10`, borderWidth: 1, borderColor: `${f.color}30` }}>{f.kind}</span>
            <span className="text-[11px] font-mono text-zinc-300 truncate flex-1">{f.name}</span>
            <span className="text-[9px] font-mono text-zinc-600 shrink-0">{f.size}</span>
            <span className="text-zinc-600 group-hover:text-white transition-colors shrink-0">↓</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AiTutorDemo() {
  return (
    <div className="h-full bg-void-2 border border-neon-pink/20 rounded-sm p-4 sm:p-6 font-mono text-[10px] sm:text-[11px] space-y-3 relative overflow-hidden flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-neon-pink/40 to-transparent" />
      <div className="flex items-center justify-between">
        <p className="text-[9px] uppercase tracking-widest text-zinc-600">Tutor · Le Petit Prince · Ch. 21</p>
        <span className="text-[9px] text-neon-pink">● online</span>
      </div>
      <div className="space-y-2.5 sm:space-y-3 pt-1 flex-1 min-h-0">
        <div className="flex justify-end">
          <div className="max-w-[85%] bg-zinc-900/80 border border-zinc-800 rounded-lg rounded-tr-sm px-3 py-2 text-zinc-300 leading-[1.55]">
            Why does the fox suddenly say "tu" instead of "vous"?
          </div>
        </div>
        <div className="flex">
          <div className="max-w-[85%] bg-neon-pink/10 border border-neon-pink/25 rounded-lg rounded-tl-sm px-3 py-2.5 text-zinc-300 leading-[1.55] space-y-1.5">
            <p>French has two "you" forms — <em className="text-zinc-200 not-italic">vous</em> (formal, distant) and <em className="text-zinc-200 not-italic">tu</em> (intimate, between friends).</p>
            <p>Saint-Exupery shifts to <em className="text-neon-pink not-italic">tu</em> when the fox accepts the prince's friendship. The pronoun makes the bond visible.</p>
          </div>
        </div>
        <div className="flex justify-end">
          <div className="max-w-[85%] bg-zinc-900/80 border border-zinc-800 rounded-lg rounded-tr-sm px-3 py-2 text-zinc-300 leading-[1.55]">
            Does he ever switch back?
          </div>
        </div>
        <div className="flex">
          <div className="max-w-[80%] bg-neon-pink/10 border border-neon-pink/25 rounded-lg rounded-tl-sm px-3 py-2.5 text-zinc-300 leading-[1.55] flex items-center gap-2">
            <span className="inline-flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-neon-pink animate-pulse" />
              <span className="w-1 h-1 rounded-full bg-neon-pink animate-pulse" style={{ animationDelay: '0.2s' }} />
              <span className="w-1 h-1 rounded-full bg-neon-pink animate-pulse" style={{ animationDelay: '0.4s' }} />
            </span>
            <span className="text-zinc-500">tutor is reading…</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const FEATURES_E: FeatureE[] = [
  {
    id: 'voice_synth', num: '01', codename: 'VOICE_SYNTH', label: 'Read & Listen', side: 'left', color: LANDING_E_PALETTE.cyan,
    before: 'The original used to mean reading line by line with a dictionary always open.',
    beforeHighlights: ['original', 'dictionary'],
    after: 'Now the original, translation, and narration stay synced, with contextual meaning on tap.',
    cta: 'Open the reader',
    demo: <VoiceSynthDemo />,
  },
  {
    id: 'net_cast', num: '02', codename: 'NET_CAST', label: 'Follow The Discussion', side: 'right', color: LANDING_E_PALETTE.amber,
    before: 'Dense chapters used to demand a desk, silence, and an hour of focus.',
    beforeHighlights: ['Dense', 'chapters'],
    after: 'Now two hosts unpack the chapter in the tone and language you choose. Listen anywhere.',
    cta: 'Create a podcast',
    demo: <PodcastDemo />,
  },
  {
    id: 'visual_core', num: '03', codename: 'VISUAL_CORE', label: 'Visualize The Concept', side: 'left', color: LANDING_E_PALETTE.violet,
    before: 'Abstract scenes and ideas used to stay vague.',
    beforeHighlights: ['Abstract', 'ideas'],
    after: 'Now key concepts become reference images in the style and ratio you choose.',
    cta: 'Generate visuals',
    demo: <VisualCoreDemo />,
  },
  {
    id: 'cine_render', num: '04', codename: 'CINE_RENDER', label: 'Summarize With Scenes', side: 'right', color: LANDING_E_PALETTE.rose,
    patternBreak: true,
    before: 'Some chapters stay with you.',
    beforeHighlights: ['chapters'],
    after: 'Now more of them can: short summary videos give each chapter a memorable shape.',
    cta: 'Make a video',
    demo: <CineRenderDemo />,
  },
  {
    id: 'mem_log', num: '05', codename: 'MEM_LOG', label: 'Share Your Thoughts', side: 'left', color: LANDING_E_PALETTE.emerald,
    before: 'Highlights used to scatter across screenshots, notes, and downloads.',
    beforeHighlights: ['Highlights', 'scatter'],
    after: 'Now share a card with your thought or a mindmap with your thinking path.',
    cta: 'Open the notebook',
    demo: <MemLogDemo />,
  },
  {
    id: 'gen_files', num: '06', codename: 'GEN_FILES', label: 'Keep In Order', side: 'right', color: '#38bdf8',
    before: 'You looked around for what you just save.',
    beforeHighlights: ['looked', 'save'],
    after: 'Now everything stay organized by book, filtered by type.',
    cta: 'Review files',
    demo: <GenFilesDemo />,
  },
  {
    id: 'neural_assistant', num: '07', codename: 'NEURAL_ASSISTANT', label: 'Ask the Expert', side: 'left', color: LANDING_E_PALETTE.pink,
    before: 'Your questions used to outlive the reading session.',
    beforeHighlights: ['questions'],
    after: 'Now you ask about grammar, nuance, and context, and get answers grounded in the chapter.',
    cta: 'Ask the expert',
    demo: <AiTutorDemo />,
  },
];

const LANDING_E_SECTION_IDS = [
  'e-hero',
  ...FEATURES_E.map(feature => `e-feature-${feature.id}`),
  'e-cta',
];

const LANDING_F_SECTION_IDS = [
  'f-hero',
  ...FEATURES_E.map(feature => `f-feature-${feature.id}`),
  'f-cta',
];

const LANDING_G_SECTION_IDS = [
  'g-hero',
  ...FEATURES_E.map(feature => `g-feature-${feature.id}`),
  'g-cta',
];

const LANDING_E_SECTION_ACCENTS = [
  LANDING_E_PALETTE.cyan,
  ...FEATURES_E.map(feature => feature.color),
  LANDING_E_PALETTE.cyan,
];

const LANDING_F_SECTION_ACCENTS = LANDING_E_SECTION_ACCENTS;
const LANDING_G_SECTION_ACCENTS = LANDING_E_SECTION_ACCENTS;

const FEATURE_STEP_ORDER = ['before', 'after', 'demo', 'cta'] as const;
type FeatureStepE = typeof FEATURE_STEP_ORDER[number];

const FEATURE_STEP_DURATIONS_MS: Record<FeatureStepE, number> = {
  before: 3000,
  after: 3000,
  demo: 5000,
  cta: 2000,
};

const FEATURE_STEP_LABELS: Record<FeatureStepE, string> = {
  before: 'Before',
  after: 'After',
  demo: 'Demo',
  cta: 'CTA',
};

function FeatureTitleE({ feature }: { feature: FeatureE }) {
  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <span className="text-[10px] sm:text-xs font-mono tracking-[0.25em] text-zinc-600">{feature.num}</span>
      <span className="text-[10px] sm:text-xs font-mono uppercase tracking-[0.25em]" style={{ color: feature.color }}>{feature.codename}</span>
      <span className="text-[10px] sm:text-xs font-mono uppercase tracking-[0.2em] text-zinc-500">· {feature.label}</span>
    </div>
  );
}

function FeatureStepNavE({
  activeStep,
  color,
  onSelect,
}: {
  activeStep: FeatureStepE;
  color: string;
  onSelect: (step: FeatureStepE) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {FEATURE_STEP_ORDER.map(step => {
        const active = activeStep === step;
        return (
          <button
            key={step}
            type="button"
            onClick={() => onSelect(step)}
            className="min-w-[4.5rem] px-2.5 py-1.5 rounded-sm border font-mono text-[9px] uppercase tracking-[0.18em] transition-colors"
            style={{
              borderColor: active ? `${color}80` : 'rgba(63, 63, 70, 0.75)',
              color: active ? color : '#52525b',
              backgroundColor: active ? `${color}12` : 'transparent',
            }}
          >
            {FEATURE_STEP_LABELS[step]}
          </button>
        );
      })}
    </div>
  );
}

function FeatureScreenE({ feature, index, onEnterApp }: { feature: FeatureE; index: number; onEnterApp: () => void }) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const textOrder = feature.side === 'left' ? 'md:order-1' : 'md:order-2';
  const demoOrder = feature.side === 'left' ? 'md:order-2' : 'md:order-1';
  const beforeClass = feature.patternBreak
    ? 'text-[1.35rem] sm:text-2xl md:text-[2rem] text-zinc-300 leading-[1.25] max-w-[31rem] font-medium tracking-normal'
    : 'text-[15px] sm:text-[17px] md:text-[18px] text-zinc-500 leading-[1.7] max-w-[32rem]';

  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className="min-h-[100svh] scroll-mt-16 flex items-center px-4 sm:px-6 md:px-10 py-20 sm:py-24 border-t border-zinc-900/50"
      id={`e-feature-${feature.id}`}
    >
      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-10 sm:gap-14 md:gap-20 items-center w-full">
        <div
          className={`space-y-5 sm:space-y-6 ${textOrder} transition-all duration-700 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'}`}
          style={{ transitionDelay: `${index * 30}ms` }}
        >
          <FeatureTitleE feature={feature} />
          <p className={beforeClass}>{feature.before}</p>
          <div className="flex items-center gap-3 max-w-md py-1">
            <div className="flex-1 h-[1px]" style={{ background: `linear-gradient(to right, transparent, ${feature.color}66, transparent)` }} />
            <ArrowRight size={11} style={{ color: feature.color }} strokeWidth={2} />
            <div className="flex-1 h-[1px]" style={{ background: `linear-gradient(to right, transparent, ${feature.color}66, transparent)` }} />
          </div>
          <h2 className="text-[1.65rem] sm:text-3xl md:text-[2.5rem] font-semibold tracking-normal text-white leading-[1.16] max-w-[34rem]">
            {feature.after}
          </h2>
          <button
            onClick={onEnterApp}
            className="inline-flex items-center gap-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-[0.2em] opacity-70 hover:opacity-100 transition-opacity pt-2"
            style={{ color: feature.color }}
          >
            {feature.cta} <ArrowRight size={11} strokeWidth={2} />
          </button>
        </div>
        <div className={`${demoOrder} transition-all duration-700 delay-150 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
          <MediaFrameE>{feature.demo}</MediaFrameE>
        </div>
      </div>
    </section>
  );
}

function FeatureScreenF({ feature, index, onEnterApp }: { feature: FeatureE; index: number; onEnterApp: () => void }) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const activeStep = FEATURE_STEP_ORDER[stepIndex];
  const demoDurationMs = feature.demoDurationMs ?? FEATURE_STEP_DURATIONS_MS.demo;
  const activeDurationMs = activeStep === 'demo' ? demoDurationMs : FEATURE_STEP_DURATIONS_MS[activeStep];

  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const isActive = entry.isIntersecting && entry.intersectionRatio >= 0.2;
        if (entry.isIntersecting) setVisible(true);
        setActive(isActive);
      },
      { threshold: [0, 0.2, 0.45, 0.7] }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (active) setStepIndex(0);
  }, [active, feature.id]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      setStepIndex(current => (current + 1) % FEATURE_STEP_ORDER.length);
    }, activeDurationMs);

    return () => window.clearTimeout(timer);
  }, [active, activeDurationMs]);

  const selectStep = (step: FeatureStepE) => {
    setStepIndex(FEATURE_STEP_ORDER.indexOf(step));
  };

  return (
    <section
      ref={sectionRef}
      className="min-h-[100svh] scroll-mt-16 flex items-center justify-center px-4 sm:px-6 md:px-10 py-20 sm:py-24 border-t border-zinc-900/50"
      id={`f-feature-${feature.id}`}
    >
      <div className="mx-auto flex w-full flex-col items-center gap-4 sm:gap-5">
        <div
          className={`flex justify-center text-center transition-all duration-700 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}
          style={{
            width: 'min(80vw, calc(80svh * 16 / 9))',
            maxWidth: '1280px',
            transitionDelay: `${index * 30}ms`,
          }}
        >
          <FeatureTitleE feature={feature} />
        </div>
        <div
          className={`relative aspect-video overflow-hidden rounded-sm border bg-[#050507]/95 transition-all duration-700 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'}`}
          style={{
            width: 'min(80vw, calc(80svh * 16 / 9))',
            maxWidth: '1280px',
            maxHeight: '80svh',
            borderColor: `${feature.color}33`,
            boxShadow: `0 0 48px ${feature.color}14`,
            transitionDelay: `${index * 30}ms`,
          }}
        >
          <div className="pointer-events-none absolute inset-0 bg-grid opacity-10" />
          <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(ellipse at 50% 35%, ${feature.color}16 0%, transparent 58%)` }} />

          <div className="absolute left-4 right-4 top-3 z-20 flex justify-end sm:left-6 sm:right-6 sm:top-5">
            <span
              className="shrink-0 rounded-sm border px-2 py-1 font-mono text-[8px] uppercase tracking-[0.18em] sm:text-[9px]"
              style={{ color: feature.color, borderColor: `${feature.color}45`, backgroundColor: `${feature.color}10` }}
            >
              {FEATURE_STEP_LABELS[activeStep]}
            </span>
          </div>

          <div className="absolute inset-x-4 bottom-3 z-20 h-1 overflow-hidden rounded-full bg-black/45 sm:inset-x-6 sm:bottom-5">
            <div
              key={`${feature.id}-${activeStep}-${stepIndex}-progress`}
              className="landing-demo-progress h-full rounded-full"
              style={{
                backgroundColor: feature.color,
                animationDuration: `${activeDurationMs}ms`,
                boxShadow: `0 0 14px ${feature.color}99`,
              }}
            />
          </div>

          <div className="absolute inset-0 z-10 px-4 pb-8 pt-12 sm:px-8 sm:pb-12 sm:pt-20 md:px-10">
            {activeStep === 'before' && (
              <FallingText
                key={`${feature.id}-before-${stepIndex}`}
                text={feature.before}
                highlightWords={feature.beforeHighlights ?? []}
                highlightClass="landing-falling-highlight"
                trigger="auto"
                backgroundColor="transparent"
                wireframes={false}
                gravity={feature.patternBreak ? 0.42 : 0.5}
                fontSize={feature.patternBreak ? 'clamp(1.25rem, 3.5vw, 3.1rem)' : 'clamp(0.95rem, 2.4vw, 2.25rem)'}
                wordSpacing="4px"
                startDelayMs={1200}
                mouseConstraintStiffness={0.9}
              />
            )}

            {activeStep === 'after' && (
              <div className="flex h-full items-center justify-center text-center">
                <h2 className="max-w-[78%] font-semibold tracking-normal text-white leading-[1.16]" style={{ fontSize: 'clamp(1.05rem, 3.3vw, 3.6rem)' }}>
                  <DecryptedText
                    key={`${feature.id}-after-${stepIndex}`}
                    text={feature.after}
                    speed={22}
                    maxIterations={18}
                    sequential
                    revealDirection="center"
                    animateOn="view"
                    parentClassName="landing-decrypted-parent"
                    className="landing-decrypted-revealed"
                    encryptedClassName="landing-decrypted-encrypted"
                    characters="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+-_"
                  />
                </h2>
              </div>
            )}

            {activeStep === 'demo' && (
              <div className="mx-auto h-full w-full max-w-[78%]">
                <div className="relative h-full w-full">
                  {feature.demo}
                </div>
              </div>
            )}

            {activeStep === 'cta' && (
              <div className="flex h-full items-center justify-center">
                <button
                  onClick={onEnterApp}
                  className="inline-flex min-h-14 max-w-[82%] items-center justify-center gap-3 rounded-sm border bg-neon-cyan/5 px-5 py-4 transition-all hover:bg-neon-cyan/10 hover:shadow-[0_0_30px_rgba(0,243,255,0.18)] sm:px-8 sm:py-6"
                  style={{ borderColor: `${LANDING_E_PALETTE.cyan}66` }}
                >
                  <TrueFocus
                    sentence={feature.cta}
                    manualMode={false}
                    blurAmount={3}
                    borderColor={LANDING_E_PALETTE.cyan}
                    glowColor="rgba(0, 243, 255, 0.75)"
                    animationDuration={0.35}
                    pauseBetweenAnimations={0.35}
                    className="landing-true-focus landing-true-focus-stage"
                  />
                  <ArrowRight size={14} className="shrink-0 text-neon-cyan" strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        </div>

        <FeatureStepNavE activeStep={activeStep} color={feature.color} onSelect={selectStep} />
      </div>
    </section>
  );
}

function FeatureTitleG({ feature }: { feature: FeatureE }) {
  return (
    <div className="landing-g-title">
      <span className="landing-g-title__num">{feature.num}</span>
      <span className="landing-g-title__code" style={{ color: feature.color }}>{feature.codename}</span>
      <span className="landing-g-title__label">{feature.label}</span>
    </div>
  );
}

function FeatureScreenG({ feature, index, onEnterApp }: { feature: FeatureE; index: number; onEnterApp: () => void }) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [pointer, setPointer] = useState({ x: 50, y: 50 });
  const activeStep = FEATURE_STEP_ORDER[stepIndex];
  const demoDurationMs = feature.demoDurationMs ?? FEATURE_STEP_DURATIONS_MS.demo;
  const activeDurationMs = activeStep === 'demo' ? demoDurationMs : FEATURE_STEP_DURATIONS_MS[activeStep];

  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const isActive = entry.isIntersecting && entry.intersectionRatio >= 0.2;
        if (entry.isIntersecting) setVisible(true);
        setActive(isActive);
      },
      { threshold: [0, 0.2, 0.45, 0.7] }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (active) setStepIndex(0);
  }, [active, feature.id]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      setStepIndex(current => (current + 1) % FEATURE_STEP_ORDER.length);
    }, activeDurationMs);

    return () => window.clearTimeout(timer);
  }, [active, activeDurationMs]);

  const selectStep = (step: FeatureStepE) => {
    setStepIndex(FEATURE_STEP_ORDER.indexOf(step));
  };

  const updatePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    });
  };

  return (
    <section
      ref={sectionRef}
      className="landing-g-section min-h-[100svh] scroll-mt-16 flex items-center justify-center px-4 sm:px-6 md:px-10 py-20 sm:py-24 border-t border-zinc-900/50"
      id={`g-feature-${feature.id}`}
    >
      <div className="mx-auto flex w-full flex-col items-center gap-4 sm:gap-5">
        <div
          className={`landing-g-title-panel transition-all duration-700 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}
          style={{
            width: 'min(80vw, calc(80svh * 16 / 9))',
            maxWidth: '1280px',
            transitionDelay: `${index * 30}ms`,
          }}
        >
          <FeatureTitleG feature={feature} />
        </div>

        <div
          className={`landing-g-console relative aspect-video overflow-hidden rounded-sm border transition-all duration-700 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'}`}
          onPointerMove={updatePointer}
          style={{
            width: 'min(80vw, calc(80svh * 16 / 9))',
            maxWidth: '1280px',
            maxHeight: '80svh',
            borderColor: `${feature.color}66`,
            boxShadow: `0 0 58px ${feature.color}18, inset 0 0 42px rgba(0, 243, 255, 0.04)`,
            background: `radial-gradient(circle at ${pointer.x}% ${pointer.y}%, ${feature.color}24 0%, transparent 28%), linear-gradient(135deg, rgba(2, 2, 4, 0.58) 0%, rgba(7, 9, 16, 0.44) 56%, rgba(3, 3, 5, 0.5) 100%)`,
            transitionDelay: `${index * 30}ms`,
          }}
        >
          <div className="landing-g-wire" style={{ borderColor: `${feature.color}22` }} />
          <div className="landing-g-scanlines" />
          <div className="landing-g-noise" />
          <div className="landing-g-hud-corner landing-g-hud-corner--tl" style={{ borderColor: feature.color }} />
          <div className="landing-g-hud-corner landing-g-hud-corner--tr" style={{ borderColor: feature.color }} />
          <div className="landing-g-hud-corner landing-g-hud-corner--bl" style={{ borderColor: feature.color }} />
          <div className="landing-g-hud-corner landing-g-hud-corner--br" style={{ borderColor: feature.color }} />

          <div className="landing-g-side-label landing-g-side-label--left">DECODE_PROTOCOL</div>
          <div className="landing-g-side-label landing-g-side-label--right">NEURAL_READER</div>

          <div className="absolute left-4 right-4 top-3 z-30 flex items-start justify-between gap-3 sm:left-6 sm:right-6 sm:top-5">
            <span className="landing-g-metric" style={{ color: feature.color, borderColor: `${feature.color}45` }}>
              SIGNAL {String(stepIndex + 1).padStart(2, '0')} / 04
            </span>
            <span
              className="landing-g-step-badge"
              style={{ color: feature.color, borderColor: `${feature.color}55`, backgroundColor: `${feature.color}10` }}
            >
              {FEATURE_STEP_LABELS[activeStep]}
            </span>
          </div>

          <div className="landing-g-progress-track absolute inset-x-4 bottom-3 z-30 h-1 overflow-hidden rounded-full sm:inset-x-6 sm:bottom-5">
            <div
              key={`${feature.id}-g-${activeStep}-${stepIndex}-progress`}
              className="landing-demo-progress h-full rounded-full"
              style={{
                backgroundColor: feature.color,
                animationDuration: `${activeDurationMs}ms`,
                boxShadow: `0 0 16px ${feature.color}`,
              }}
            />
          </div>

          <div className="absolute inset-0 z-20 px-4 pb-8 pt-12 sm:px-8 sm:pb-12 sm:pt-20 md:px-10">
            {activeStep === 'before' && (
              <FallingText
                key={`${feature.id}-g-before-${stepIndex}`}
                className="landing-g-falling"
                text={feature.before}
                highlightWords={feature.beforeHighlights ?? []}
                highlightClass="landing-falling-highlight"
                trigger="auto"
                backgroundColor="transparent"
                wireframes={false}
                gravity={feature.patternBreak ? 0.42 : 0.5}
                fontSize={feature.patternBreak ? 'clamp(1.25rem, 3.5vw, 3.1rem)' : 'clamp(0.95rem, 2.4vw, 2.25rem)'}
                wordSpacing="4px"
                startDelayMs={1200}
                mouseConstraintStiffness={0.9}
              />
            )}

            {activeStep === 'after' && (
              <div className="flex h-full items-center justify-center text-center">
                <h2 className="landing-g-after max-w-[78%] font-semibold tracking-normal text-white leading-[1.16]" style={{ fontSize: 'clamp(1.05rem, 3.3vw, 3.6rem)' }}>
                  <DecryptedText
                    key={`${feature.id}-g-after-${stepIndex}`}
                    text={feature.after}
                    speed={22}
                    maxIterations={18}
                    sequential
                    revealDirection="center"
                    animateOn="view"
                    parentClassName="landing-decrypted-parent"
                    className="landing-decrypted-revealed"
                    encryptedClassName="landing-decrypted-encrypted"
                    characters="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+-_"
                  />
                </h2>
              </div>
            )}

            {activeStep === 'demo' && (
              <div className="mx-auto h-full w-full max-w-[78%] landing-g-demo-shell">
                <div className="relative h-full w-full">
                  {feature.demo}
                </div>
              </div>
            )}

            {activeStep === 'cta' && (
              <div className="flex h-full items-center justify-center">
                <button
                  onClick={onEnterApp}
                  className="landing-g-cta inline-flex min-h-14 max-w-[82%] items-center justify-center gap-3 rounded-sm border px-5 py-4 transition-all sm:px-8 sm:py-6"
                  style={{ borderColor: `${feature.color}75`, color: feature.color, boxShadow: `0 0 32px ${feature.color}1f` }}
                >
                  <TrueFocus
                    sentence={feature.cta}
                    manualMode={false}
                    blurAmount={3}
                    borderColor={feature.color}
                    glowColor={`${feature.color}bf`}
                    animationDuration={0.35}
                    pauseBetweenAnimations={0.35}
                    className="landing-true-focus landing-true-focus-stage"
                  />
                  <ArrowRight size={14} className="shrink-0" strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="landing-g-step-nav">
          <FeatureStepNavE activeStep={activeStep} color={feature.color} onSelect={selectStep} />
        </div>
      </div>
    </section>
  );
}

function TransformationLanding({
  onEnterApp,
  onSignIn,
  sectionIds,
  sectionAccents,
  heroId,
  ctaId,
  renderFeature,
}: {
  onEnterApp: () => void;
  onSignIn: () => void;
  sectionIds: string[];
  sectionAccents: string[];
  heroId: string;
  ctaId: string;
  renderFeature: (feature: FeatureE, index: number) => React.ReactNode;
}) {
  useUnlockScroll();
  const [screen, setScreen] = useState(0);
  const totalScreens = sectionIds.length;
  const activeAccent = sectionAccents[screen] || LANDING_E_PALETTE.cyan;
  const progressPercent = totalScreens > 1 ? (screen / (totalScreens - 1)) * 100 : 0;
  const isCyber = heroId.startsWith('g-');

  useEffect(() => {
    let frame = 0;
    const updateActiveScreen = () => {
      frame = 0;
      const viewportCenter = window.innerHeight * 0.5;
      let nextScreen = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;

      sectionIds.forEach((id, index) => {
        const element = document.getElementById(id);
        if (!element) return;
        const rect = element.getBoundingClientRect();
        if (rect.top <= viewportCenter && rect.bottom >= viewportCenter) {
          nextScreen = index;
          nearestDistance = 0;
          return;
        }
        const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nextScreen = index;
        }
      });

      setScreen(current => current === nextScreen ? current : nextScreen);
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateActiveScreen);
    };
    scheduleUpdate();
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
    };
  }, [sectionIds]);

  const scrollToScreen = (i: number) => {
    const target = document.getElementById(sectionIds[Math.max(0, Math.min(totalScreens - 1, i))]);
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target?.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <div className={`bg-void-0 text-zinc-100 min-h-screen ${isCyber ? 'landing-g-shell' : ''}`}>
      {/* Nav */}
      <nav className={`fixed top-0 w-full z-50 bg-void-0/80 backdrop-blur-md border-b border-zinc-900/60 ${isCyber ? 'landing-g-nav' : ''}`}>
        <div className="max-w-6xl mx-auto flex items-center justify-between px-4 sm:px-6 md:px-10 py-3.5">
          <span className="font-mono font-bold text-sm tracking-wider text-white">Decod<span className="text-neon-cyan">Ebook</span></span>
          <div className="flex items-center gap-3 sm:gap-4">
            <button onClick={onSignIn} className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 hover:text-white transition-colors">Sign In</button>
            <button onClick={onEnterApp} className="text-[10px] font-mono uppercase tracking-widest bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan px-3 sm:px-4 py-1.5 rounded-sm hover:bg-neon-cyan/20 transition-colors">Decode</button>
          </div>
        </div>
      </nav>

      {/* Progress rail */}
      <div className="hidden sm:flex fixed right-5 top-1/2 -translate-y-1/2 z-40 flex-col gap-2.5">
        <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-zinc-800/70" />
        <div
          className="absolute left-1/2 top-0 w-px -translate-x-1/2 transition-all duration-300"
          style={{ height: `${progressPercent}%`, background: `linear-gradient(to bottom, ${activeAccent}, ${activeAccent}55)` }}
        />
        {Array.from({ length: totalScreens }).map((_, i) => (
          <button
            key={i}
            onClick={() => scrollToScreen(i)}
            className={`relative z-10 w-2 h-2 rounded-full border transition-all ${screen === i ? 'scale-125' : 'bg-void-0 border-zinc-700 hover:border-zinc-500'}`}
            style={screen === i ? { backgroundColor: activeAccent, borderColor: activeAccent, boxShadow: `0 0 10px ${activeAccent}99` } : undefined}
            aria-label={`Screen ${i + 1}`}
          />
        ))}
      </div>
      <div className="sm:hidden fixed left-0 right-0 top-[49px] z-50 h-[2px] bg-zinc-900/80">
        <div
          className="h-full transition-all duration-300"
          style={{ width: `${progressPercent}%`, backgroundColor: activeAccent, boxShadow: `0 0 12px ${activeAccent}99` }}
        />
      </div>

      {/* Screen 1 — Hero */}
      <section id={heroId} className={`min-h-[100svh] flex flex-col items-center justify-center px-4 sm:px-6 relative overflow-hidden ${isCyber ? 'landing-g-hero' : ''}`}>
        <div className="absolute inset-0 bg-grid opacity-20" />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 40%, rgba(0,243,255,0.07) 0%, transparent 60%)' }} />
        <div className="relative z-10 text-center max-w-4xl space-y-7 sm:space-y-9">
          <p className="text-[10px] sm:text-xs font-mono tracking-[0.2em] text-zinc-500 animate-fade-in">One Book, Multiple Ways to Learn.</p>
          <h1 className="text-[2.3rem] sm:text-5xl md:text-7xl font-semibold tracking-normal leading-[1.08] text-white animate-fade-in" style={{ animationDelay: '0.1s' }}>
            Read the original.<br />
            <span className="text-neon-cyan drop-shadow-[0_0_30px_rgba(0,243,255,0.4)]">Understand the meaning.</span>
          </h1>
          <p className="text-zinc-500 text-sm sm:text-base max-w-[34rem] mx-auto leading-[1.75] animate-fade-in" style={{ animationDelay: '0.2s' }}>
            DecodEbook turns EPUB, PDF, and text into a bilingual reader, pronunciation coach, live podcast, visual brief, video summary and notebook. With AI tutor, you can learn everything you want to.
          </p>
          <HeroLearningBlocksVelocity />
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 animate-fade-in" style={{ animationDelay: '0.3s' }}>
            <button onClick={onEnterApp} className="px-7 py-3 bg-neon-cyan text-black font-mono font-bold text-xs uppercase tracking-widest rounded-sm hover:bg-neon-cyan/90 transition-all hover:shadow-glow-lg flex items-center gap-2">
              Decode Your First Chapter <ArrowRight size={14} />
            </button>
          </div>
        </div>
        <button onClick={() => scrollToScreen(1)} className="absolute bottom-8 left-1/2 -translate-x-1/2 text-zinc-600 hover:text-neon-cyan transition-colors animate-bounce" aria-label="Next">
          <ChevronDown size={22} strokeWidth={1.5} />
        </button>
      </section>

      {/* Screens 2–7 — feature transformations */}
      {FEATURES_E.map((f, i) => (
        <React.Fragment key={f.id}>{renderFeature(f, i)}</React.Fragment>
      ))}

      {/* Social proof strip — between last feature and CTA */}
      <section className="py-12 sm:py-16 px-4 sm:px-6 md:px-10 border-t border-zinc-900/50">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-center gap-6 md:gap-12 text-center">
            <div className="space-y-1">
              <p className="text-2xl sm:text-3xl font-semibold tracking-normal text-white">EPUB, PDF, TXT</p>
              <p className="text-[10px] sm:text-xs font-mono uppercase tracking-[0.2em] text-zinc-500">Bring the book you already have</p>
            </div>
            <div className="hidden md:block w-px h-12 bg-zinc-800" />
            <div className="space-y-1">
              <p className="text-2xl sm:text-3xl font-semibold tracking-normal text-white">50+ <span className="text-neon-cyan">languages</span></p>
              <p className="text-[10px] sm:text-xs font-mono uppercase tracking-[0.2em] text-zinc-500">Read in the original, learn in yours</p>
            </div>
          </div>
        </div>
      </section>

      {/* Screen 8 — Final CTA */}
      <section id={ctaId} className="min-h-[100svh] scroll-mt-16 flex flex-col items-center justify-center px-4 sm:px-6 relative border-t border-zinc-900/50 overflow-hidden">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 70%, rgba(0,243,255,0.06) 0%, transparent 60%)' }} />
        <div className="relative z-10 text-center max-w-3xl space-y-8 sm:space-y-10">
          <h2 className="text-[2rem] sm:text-4xl md:text-[3.75rem] font-semibold tracking-normal leading-[1.1] text-white">
            Decode your first chapter<br /><span className="text-neon-cyan">for free</span>.
          </h2>
          <p className="text-[11px] sm:text-xs text-zinc-500 font-mono tracking-wider">
            100 credits for new user registered
          </p>
          <button onClick={onEnterApp} className="px-8 py-3.5 bg-neon-cyan text-black font-mono font-bold text-xs uppercase tracking-widest rounded-sm hover:bg-neon-cyan/90 transition-all hover:shadow-[0_0_40px_rgba(0,243,255,0.4)] inline-flex items-center gap-2">
            Decode Your First Chapter <ArrowRight size={14} />
          </button>
        </div>
        <footer className="absolute bottom-6 left-0 right-0 px-4 sm:px-6 md:px-10">
          <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 sm:gap-4">
            <span className="font-mono text-[10px] text-zinc-600">DecodEbook &copy; {new Date().getFullYear()}</span>
            <div className="flex items-center gap-4 sm:gap-6">
              <button onClick={onSignIn} className="text-[10px] font-mono text-zinc-600 hover:text-white transition-colors uppercase tracking-widest">Sign In</button>
              <button onClick={onEnterApp} className="text-[10px] font-mono text-zinc-600 hover:text-neon-cyan transition-colors uppercase tracking-widest">Open App</button>
            </div>
          </div>
        </footer>
      </section>
    </div>
  );
}

function VersionE({ onEnterApp, onSignIn }: { onEnterApp: () => void; onSignIn: () => void }) {
  return (
    <TransformationLanding
      onEnterApp={onEnterApp}
      onSignIn={onSignIn}
      sectionIds={LANDING_E_SECTION_IDS}
      sectionAccents={LANDING_E_SECTION_ACCENTS}
      heroId="e-hero"
      ctaId="e-cta"
      renderFeature={(feature, index) => (
        <FeatureScreenE feature={feature} index={index} onEnterApp={onEnterApp} />
      )}
    />
  );
}

function VersionF({ onEnterApp, onSignIn }: { onEnterApp: () => void; onSignIn: () => void }) {
  return (
    <TransformationLanding
      onEnterApp={onEnterApp}
      onSignIn={onSignIn}
      sectionIds={LANDING_F_SECTION_IDS}
      sectionAccents={LANDING_F_SECTION_ACCENTS}
      heroId="f-hero"
      ctaId="f-cta"
      renderFeature={(feature, index) => (
        <FeatureScreenF feature={feature} index={index} onEnterApp={onEnterApp} />
      )}
    />
  );
}

function VersionG({ onEnterApp, onSignIn }: { onEnterApp: () => void; onSignIn: () => void }) {
  return (
    <TransformationLanding
      onEnterApp={onEnterApp}
      onSignIn={onSignIn}
      sectionIds={LANDING_G_SECTION_IDS}
      sectionAccents={LANDING_G_SECTION_ACCENTS}
      heroId="g-hero"
      ctaId="g-cta"
      renderFeature={(feature, index) => (
        <FeatureScreenG feature={feature} index={index} onEnterApp={onEnterApp} />
      )}
    />
  );
}

// ─── Main Export ───

export function LandingPage({ variant, onEnterApp, onSignIn }: LandingPageProps) {
  switch (variant) {
    case 'A': return <VersionA onEnterApp={onEnterApp} onSignIn={onSignIn} />;
    case 'B': return <VersionB onEnterApp={onEnterApp} onSignIn={onSignIn} />;
    case 'C': return <VersionC onEnterApp={onEnterApp} onSignIn={onSignIn} />;
    case 'D': return <VersionD onEnterApp={onEnterApp} onSignIn={onSignIn} />;
    case 'E': return <VersionE onEnterApp={onEnterApp} onSignIn={onSignIn} />;
    case 'F': return <VersionF onEnterApp={onEnterApp} onSignIn={onSignIn} />;
    case 'G': return <VersionG onEnterApp={onEnterApp} onSignIn={onSignIn} />;
  }
}
