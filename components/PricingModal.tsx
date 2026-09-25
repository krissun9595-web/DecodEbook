import React, { useState, useEffect, useRef } from 'react';
import { Zap, Crown, Key as KeyIcon, ExternalLink, Loader2, BarChart3, Shield, Github, Mail, Eye, EyeOff, LogIn, UserPlus, LogOut, RefreshCw, Package, Gift, Share2, Copy, Check, Facebook, Linkedin, Instagram, Wallet, Trash2 } from 'lucide-react';
import { CloseButton } from './ui/CloseButton';
import { Privacy, Pro } from './ui/glyphs';
import { UserTier, TIER_CREDITS, CREDIT_COSTS, getAvailableCredits, fetchUserTier, createCheckoutSession, createPackCheckout, openCustomerPortal } from '../services/stripe';
import { creditsForAction } from '../services/pricing';
import { GenMode, getGenerationMode, setGenerationMode, resolveModel } from '../services/gemini';
import { CreditHistory } from './CreditHistory';
import { StatusMessage } from './ui/StatusMessage';
import { InfoTooltip, InfoSection } from './ui/InfoTooltip';
import {
  signIn, signUp, signInWithOAuth, signOut, resetPassword, deleteAccount,
  isSupabaseConfigured, linkProvider, unlinkProvider, getIdentities
} from '../services/supabase';
import { getReferralCode, getShareUrl, shareOnTwitter, shareOnFacebook, shareOnLinkedIn, shareOnInstagram } from '../services/referral';
import type { User } from '@supabase/supabase-js';
import { trackAuth } from '../utils/analytics';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  onAuthChange: (user: User | null) => void;
  proPriceId: string;
  proAnnualPriceId: string;
  onModeChange?: (mode: GenMode) => void;
}

const TIER_DISPLAY: Record<string, { label: string; color: string; border: string; bg: string }> = {
  free: { label: 'FREE', color: 'text-zinc-400', border: 'border-zinc-700', bg: 'bg-zinc-800/50' },
  pro: { label: 'PRO', color: 'text-neon-cyan', border: 'border-neon-cyan/30', bg: 'bg-neon-cyan/5' },
};

const PLANS = [
  {
    id: 'free' as const,
    name: 'Free',
    price: '$0',
    period: '',
    icon: Zap,
    color: 'zinc-400',
    accentBorder: 'border-zinc-700',
    features: ['100 credits', 'No video generation'],
  },
  {
    id: 'pro' as const,
    name: 'Pro',
    price: '$9.99',
    period: '/month',
    icon: Pro,
    color: 'neon-cyan',
    accentBorder: 'border-neon-cyan/40',
    features: ['1,000 credits/month', 'All AI features unlocked', 'Buy extra credit packs anytime'],
  },
];

const PACKS = [
  { type: 'S', credits: 1000, price: '$9.99', storageKey: 'stripe_pack_s_price_id' },
  { type: 'M', credits: 2500, price: '$19.99', storageKey: 'stripe_pack_m_price_id' },
  { type: 'L', credits: 4000, price: '$29.99', storageKey: 'stripe_pack_l_price_id' },
];

const GoogleIcon = (<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>);
const XIcon = (<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>);
const DiscordIcon = (<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>);

const PROVIDERS: { key: string; matches: string[]; label: string; icon: React.ReactNode }[] = [
  { key: 'google', matches: ['google'], label: 'Google', icon: GoogleIcon },
  { key: 'github', matches: ['github'], label: 'GitHub', icon: <Github size={14} /> },
  { key: 'x', matches: ['twitter', 'x'], label: 'X', icon: XIcon },
  { key: 'discord', matches: ['discord'], label: 'Discord', icon: DiscordIcon },
];

export function AccountPanel({ isOpen, onClose, user, onAuthChange, proPriceId, proAnnualPriceId, onModeChange }: Props) {
  const [tierInfo, setTierInfo] = useState<UserTier | null>(null);
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [expandedAnnual, setExpandedAnnual] = useState(false);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);

  const [refCode, setRefCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [genMode, setGenMode] = useState<GenMode>(getGenerationMode());
  const [identities, setIdentities] = useState<any[]>(user?.identities || []);
  const [linkingProvider, setLinkingProvider] = useState<string | null>(null);
  const [bindMsg, setBindMsg] = useState('');

  const [authMode, setAuthMode] = useState<'login' | 'signup' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [billingError, setBillingError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    if (user) {
      setLoading(true);
      fetchUserTier().then(t => { setTierInfo(t); setLoading(false); });
      getReferralCode().then(setRefCode);
    }
  }, [isOpen, user]);

  // Stripe cancel/back navigation can restore this modal from the browser's
  // back-forward cache, preserving the old spinner state. Clear transient
  // checkout state when a cached page is restored so every Buy button works.
  useEffect(() => {
    const resetCheckoutState = (event?: PageTransitionEvent) => {
      if (event && !event.persisted) return;
      setBuyingPack(null);
      setUpgrading(null);
      setPortalLoading(false);
    };
    window.addEventListener('pageshow', resetCheckoutState);
    return () => window.removeEventListener('pageshow', resetCheckoutState);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setBuyingPack(null);
      setUpgrading(null);
      setPortalLoading(false);
    }
  }, [isOpen]);

  const handleUpgrade = async (tierId: string, annual = false) => {
    let priceId = '';
    if (tierId === 'pro') priceId = annual && proAnnualPriceId ? proAnnualPriceId : proPriceId;
    if (!priceId) { setBillingError('The Pro price is not configured.'); return; }
    setBillingError('');
    setUpgrading(tierId + (annual ? '_annual' : ''));
    try {
      window.location.href = await createCheckoutSession(priceId);
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : 'Unable to start checkout.');
      setUpgrading(null);
    }
  };

  const handleBuyPack = async (storageKey: string, packType: string) => {
    const priceId = localStorage.getItem(storageKey);
    if (!priceId) { setBillingError('This credit pack is not configured.'); return; }
    setBillingError('');
    setBuyingPack(packType);
    try {
      window.location.href = await createPackCheckout(priceId);
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : 'Unable to start checkout.');
      setBuyingPack(null);
    }
  };

  const handleManage = async () => {
    setBillingError('');
    setPortalLoading(true);
    try {
      window.location.href = await openCustomerPortal();
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : 'Unable to open the billing portal.');
      setPortalLoading(false);
    }
  };

  const handleAuth = async () => {
    if (!email || !password) { setError('Email and password required'); return; }
    if (authMode === 'signup' && !agreedToTerms) { setError('You must agree to the Terms of Service and Privacy Policy'); return; }
    setAuthLoading(true); setError('');
    try {
      if (authMode === 'signup') {
        await signUp(email, password);
        trackAuth('sign_up', { method: 'email' });
        setSuccess('Account created! Check your email to confirm.');
      } else {
        const data = await signIn(email, password);
        trackAuth('sign_in', { method: 'email' });
        onAuthChange(data.user);
        setSuccess('Logged in');
      }
    } catch (e: any) { setError(e.message || 'Authentication failed'); }
    finally { setAuthLoading(false); }
  };

  const handleForgotPassword = async () => {
    if (!email) { setError('Enter your email address first'); return; }
    setAuthLoading(true); setError('');
    try { await resetPassword(email); setSuccess('Password reset email sent!'); }
    catch (e: any) { setError(e.message || 'Failed to send reset email'); }
    finally { setAuthLoading(false); }
  };

  const handleOAuth = async (provider: 'google' | 'github' | 'x' | 'discord') => {
    setAuthLoading(true); setError('');
    try { await signInWithOAuth(provider); }
    catch (e: any) { setError(e.message || 'OAuth failed'); setAuthLoading(false); }
  };

  useEffect(() => { setIdentities(user?.identities || []); }, [user]);

  // Measure Account_Info so the other panels match its height (uniform); Credits = 1.5x.

  const handleToggleBind = async (p: { key: string; matches: string[]; label: string }) => {
    const identity = identities.find(i => p.matches.includes(i.provider));
    setLinkingProvider(p.key); setBindMsg('');
    try {
      if (identity) {
        if (identities.length <= 1) { setBindMsg("Can't unbind your only sign-in method."); return; }
        await unlinkProvider(identity);
        setIdentities(await getIdentities());
        setBindMsg(`${p.label} unbound.`);
      } else {
        setBindMsg(`Redirecting to ${p.label}…`);
        await linkProvider(p.key); // redirects to the provider's OAuth, returns linked
      }
    } catch (e: any) {
      setBindMsg(e.message || `Couldn't ${identity ? 'unbind' : 'bind'} ${p.label}.`);
    } finally { setLinkingProvider(null); }
  };


  const handleSignOut = async () => {
    trackAuth('sign_out');
    await signOut();
    onAuthChange(null);
    setTierInfo(null);
    setSuccess('Signed out');
  };

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const handleDeleteAccount = async () => {
    setDeleting(true); setError('');
    try {
      await deleteAccount();
      trackAuth('account_deleted');
      onAuthChange(null);
      setTierInfo(null);
      onClose();
      // Full reload clears in-memory + local caches for the now-deleted account.
      window.location.href = '/';
    } catch (e: any) {
      setError(e?.message || 'Failed to delete account.');
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const handleSwitchAccount = async () => {
    await handleSignOut();
    setEmail('');
    setPassword('');
    setAuthMode('login');
    setError('');
    setSuccess('');
  };

  if (!isOpen) return null;

  const currentTier = tierInfo?.tier || 'free';
  const td = TIER_DISPLAY[currentTier] || TIER_DISPLAY.free;
  const meta: any = user?.user_metadata || {};
  const accountName = user ? (meta.full_name || meta.name || meta.user_name || meta.preferred_username || user.email?.split('@')[0] || 'User') : '';
  const monthlyCredits = TIER_CREDITS[currentTier] || 100;
  const available = tierInfo ? getAvailableCredits(tierInfo) : 0;
  const subscriptionRemaining = tierInfo ? Math.max(0, monthlyCredits - tierInfo.credits_used) : 0;
  const creditPct = monthlyCredits === Infinity ? 0 : Math.min(((tierInfo?.credits_used || 0) / monthlyCredits) * 100, 100);
  // Theme-colored progress: red ≥95%, amber ≥60%, else cyan.
  const barText = (p: number) => p >= 95 ? 'text-neon-red' : p >= 60 ? 'text-neon-amber' : 'text-neon-cyan';
  const barBg = (p: number) => p >= 95 ? 'bg-neon-red' : p >= 60 ? 'bg-neon-amber' : 'bg-neon-cyan';
  // Credit packs: persistent wallet drawn down after monthly runs out (see sql/018).
  // Total = cumulative purchased (bar denominator); remaining = current balance.
  const packTotal = tierInfo?.pack_purchased || 0;
  const packRemaining = tierInfo?.pack_credits || 0;
  const packUsed = Math.max(0, packTotal - packRemaining);
  const packPct = packTotal > 0 ? Math.min((packUsed / packTotal) * 100, 100) : 0;

  const handleToggleMode = () => {
    const next: GenMode = genMode === 'premium' ? 'balanced' : 'premium';
    setGenMode(next);
    setGenerationMode(next);
    try { localStorage.setItem('generation_mode', next); } catch {}
    onModeChange?.(next);
  };
  // Complete, per-MODE credit RANGES for the main functions, from the same cost-derived math as billing
  // (the mode swaps the model → the price). Text uses its token footprint, media its per-unit rate; TTS
  // is identical in both modes. Ranges span a short vs long input — the real charge scales with length.
  const IMG_MODEL = { balanced: 'gemini-2.5-flash-image', premium: 'gemini-3-pro-image' };
  const VID_MODEL = { balanced: 'dreamina-seedance-2-0-mini', premium: 'veo-3.1-fast' };
  const TTS_MODEL = 'gemini-3.1-flash-tts';
  const c = (action: string, model: string, u: any = {}) => creditsForAction(action, model, u);
  const fmt = (lo: number, hi: number, unit: string) => `${lo === hi ? lo : `${lo}–${hi}`} ${unit}`;
  // Translate is footprint-billed per batch (~10 sentences); a page is roughly 1–3 batches.
  const trB = c('translate', resolveModel('translate', 'balanced'));
  const trP = c('translate', resolveModel('translate', 'premium'));
  const modeRows = [
    { module: 'VOICE_SYNTH', fn: 'Translation', b: fmt(trB, trB * 3, 'per page'), p: fmt(trP, trP * 3, 'per page') },
    { module: 'VOICE_SYNTH', fn: 'Definition',  b: fmt(c('quickDefinition', resolveModel('quickDefinition', 'balanced')), c('quickDefinition', resolveModel('quickDefinition', 'balanced')), 'per lookup'), p: fmt(c('quickDefinition', resolveModel('quickDefinition', 'premium')), c('quickDefinition', resolveModel('quickDefinition', 'premium')), 'per lookup') },
    { module: 'VOICE_SYNTH', fn: 'Audio',       b: fmt(c('tts', TTS_MODEL, { chars: 600 }), c('tts', TTS_MODEL, { chars: 2400 }), 'per page'), p: fmt(c('tts', TTS_MODEL, { chars: 600 }), c('tts', TTS_MODEL, { chars: 2400 }), 'per page') },
    { module: 'NET_CAST',    fn: 'Podcast',     b: fmt(c('podcastScript', resolveModel('podcastScript', 'balanced'), { inTok: 4000, outTok: 4000 }) + c('podcastAudio', TTS_MODEL, { chars: 2500 }), c('podcastScript', resolveModel('podcastScript', 'balanced'), { inTok: 16000, outTok: 12000 }) + c('podcastAudio', TTS_MODEL, { chars: 6000 }), 'per episode'), p: fmt(c('podcastScript', resolveModel('podcastScript', 'premium'), { inTok: 4000, outTok: 4000 }) + c('podcastAudio', TTS_MODEL, { chars: 2500 }), c('podcastScript', resolveModel('podcastScript', 'premium'), { inTok: 16000, outTok: 12000 }) + c('podcastAudio', TTS_MODEL, { chars: 6000 }), 'per episode') },
    { module: 'VISUAL_CORE', fn: 'Image',       b: fmt(c('generateImage', IMG_MODEL.balanced, { images: 1 }), c('generateImage', IMG_MODEL.balanced, { images: 1 }), 'per image'), p: fmt(c('generateImage', IMG_MODEL.premium, { images: 1 }), c('generateImage', IMG_MODEL.premium, { images: 1 }), 'per image') },
    { module: 'CINE_RENDER', fn: 'Video',       b: fmt(c('videoSeedance', VID_MODEL.balanced, { seconds: 8 }), c('videoSeedance', VID_MODEL.balanced, { seconds: 8 }), 'per clip'), p: fmt(c('videoVeo', VID_MODEL.premium, { seconds: 8 }), c('videoVeo', VID_MODEL.premium, { seconds: 8 }), 'per clip') },
    { module: 'ASSISTANT',   fn: 'Chat',        b: fmt(c('chat', resolveModel('chat', 'balanced'), { inTok: 400, outTok: 200 }), c('chat', resolveModel('chat', 'balanced'), { inTok: 1600, outTok: 800 }), 'per message'), p: fmt(c('chat', resolveModel('chat', 'premium'), { inTok: 400, outTok: 200 }), c('chat', resolveModel('chat', 'premium'), { inTok: 1600, outTok: 800 }), 'per message') },
  ];

  return (
    <div role="dialog" aria-modal="true" aria-label="Upgrade" className="fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4 animate-fade-in font-sans" onClick={onClose}>
      <div className="bg-void-1 border border-zinc-800 rounded-lg w-full max-w-2xl max-h-[90dvh] shadow-[0_0_50px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden animate-fade-in-up scale-in relative" onClick={e => e.stopPropagation()}>
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-neon-cyan to-neon-red"></div>

        <div className="px-6 py-[19px] border-b border-zinc-800 flex items-center justify-between shrink-0">
          <h2 className="text-xl font-black text-white uppercase tracking-widest font-mono">My_Account</h2>
          <div className="flex items-center gap-3">
            <InfoTooltip label="About My_Account">
              <InfoSection title="Account_Info">
                <p>Your identity and linked sign-in accounts. You can add your own Gemini API key to run on your own quota.</p>
              </InfoSection>
              <InfoSection title="Active_Mode">
                <p><span className="text-zinc-300">Balanced</span> uses cost-optimized models; <span className="text-zinc-300">Premium</span> uses the most capable ones. The mode sets both quality and the credits each action costs.</p>
              </InfoSection>
              <InfoSection title={currentTier === 'pro' ? 'Credit_Packs' : 'Upgrade_to_Pro'}>
                <p>{currentTier === 'pro' ? 'Buy additional credit packs here.' : 'Upgrade your plan here.'}</p>
              </InfoSection>
              <InfoSection title="Credit_Balance">
                <p>Shows your monthly, pack, and bonus credits. Actions are metered on real usage; the Mode column in history shows which model ran.</p>
              </InfoSection>
              <InfoSection title="Earn_Free_Credits">
                <p>Share your referral link: earn <span className="text-zinc-300">100 credits</span> when a new user you referred signs up and starts using their free credits (up to 1,000 credits).</p>
              </InfoSection>
              <InfoSection title="Rights & terms">
                <p>Credits are prepaid usage units, non-transferable and non-refundable except as required by law. Billing runs on a secure provider; we never store card details. Abuse of referrals may reverse bonus credits.</p>
              </InfoSection>
            </InfoTooltip>
            <CloseButton onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          {user ? (
            <div className="p-6 space-y-[1.6rem]">

              {/* ── Account Info ── */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-neon-cyan mb-2">
                  <Privacy size={18} />
                  <label className="text-xs font-bold uppercase tracking-widest font-mono">Account_Info</label>
                </div>
                <div data-acct-panel="Account_Info" className="content-panel rounded-sm p-4 space-y-1 min-h-[175px]">
                  <div className="relative">
                    {/* credits figure absolutely positioned so it doesn't inflate the name row.
                        NOTE: keep spacing OFF this wrapper's `space-y-*` — an out-of-flow first
                        child still counts for the `* + *` selector and would push the name down. */}
                    <div className="absolute top-0 right-0 text-right whitespace-nowrap">
                      <span className="text-lg font-bold text-white">{monthlyCredits === Infinity ? '∞' : monthlyCredits.toLocaleString()}</span>
                      <span className="text-zinc-500 text-xs ml-0.5">{currentTier === 'free' ? 'Free credits' : 'credits'}</span>
                    </div>
                    <p className="text-xs text-neon-cyan font-mono font-bold truncate pr-28">{accountName}</p>
                    <p className="mt-2 text-[10px] text-zinc-500 font-mono break-all pr-28">Email: {user.email}&nbsp;&nbsp;ID: {user.id}</p>
                  </div>

                  <div className="space-y-2">
                    <div className="space-y-1.5">
                      <p className="text-[9px] text-zinc-600 font-mono">Binded accounts:</p>
                      <div className="grid grid-cols-4 gap-2">
                        {PROVIDERS.map(p => {
                          const linked = identities.some(i => p.matches.includes(i.provider));
                          return (
                            <button key={p.key} onClick={() => handleToggleBind(p)} disabled={linkingProvider === p.key}
                              title={linked ? `Unbind ${p.label}` : `Bind ${p.label}`}
                              className={`py-2 rounded-sm border transition active:scale-[0.98] flex items-center justify-center ${linked ? 'border-neon-cyan/40 text-neon-cyan bg-neon-cyan/5 hover:bg-neon-cyan/10' : 'border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700'}`}>
                              {linkingProvider === p.key ? <Loader2 size={12} className="animate-spin" /> : p.icon}
                            </button>
                          );
                        })}
                      </div>
                      {bindMsg && <p className="text-[9px] text-zinc-500 font-mono">{bindMsg}</p>}
                    </div>
                    <button onClick={handleSignOut} className="w-full py-2 bg-zinc-900 hover:bg-rose-950/30 text-zinc-400 hover:text-rose-400 border border-zinc-800 hover:border-rose-900/50 rounded-sm text-[10px] font-mono uppercase tracking-widest transition-all active:scale-[0.98] flex items-center justify-center gap-1.5">
                      <LogOut size={10} /> Sign Out
                    </button>
                  </div>
                </div>
              </div>

              {/* ── Active Mode (universal generation quality) ── */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-neon-cyan mb-2">
                  <Zap size={18} />
                  <label className="text-xs font-bold uppercase tracking-widest font-mono">Active_Mode</label>
                </div>
                <div data-acct-panel="Active_Mode" className="content-panel rounded-sm p-4 min-h-[262px] flex flex-col">
                  {/* Toggle row height = the text line (h-4 switch), so "Balanced" sits at the same
                      top as the account name, and the mt-2 below matches the name→email gap. */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-neon-cyan font-mono font-bold">{genMode === 'premium' ? 'Premium' : 'Balanced'}</span>
                    <button
                      role="switch" aria-checked={genMode === 'premium'} aria-label="Toggle generation mode"
                      onClick={handleToggleMode}
                      className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${genMode === 'premium' ? 'bg-neon-cyan/30' : 'bg-zinc-700'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-neon-cyan transition-transform ${genMode === 'premium' ? 'translate-x-4' : ''}`} />
                    </button>
                  </div>
                  <div className="mt-2 text-zinc-600 font-mono">
                    <p data-gap="am-desc" className="text-[10px] mb-[6.5px]">{genMode === 'premium'
                      ? 'Top-tier models for every generation — maximum quality at a higher credit cost.'
                      : 'Cost-optimized models — great quality at the lowest credit cost.'}</p>
                    <div className="text-[9px] overflow-x-auto">
                      <div className="min-w-[300px]">
                      <div data-gap="am-hd" className="flex items-center gap-3 text-[9px] uppercase tracking-widest text-zinc-600 pb-1 border-b border-zinc-800/60">
                        <span className="flex-[1.15]">Module</span>
                        <span className="flex-1">Function</span>
                        <span className={`flex-[1.5] text-right ${genMode === 'balanced' ? 'text-neon-cyan' : ''}`}>Balanced</span>
                        <span className={`flex-[1.5] text-right ${genMode === 'premium' ? 'text-neon-cyan' : ''}`}>Premium</span>
                      </div>
                      {modeRows.map(r => (
                        <div key={r.fn} className="flex items-center gap-3 py-[3px]">
                          <span className="flex-[1.15] text-zinc-600 truncate">{r.module}</span>
                          <span className="flex-1 text-zinc-600 truncate">{r.fn}</span>
                          <span className={`flex-[1.5] text-right whitespace-nowrap ${genMode === 'balanced' ? 'text-zinc-200 font-bold' : 'text-zinc-600'}`}>{r.b}</span>
                          <span className={`flex-[1.5] text-right whitespace-nowrap ${genMode === 'premium' ? 'text-zinc-200 font-bold' : 'text-zinc-600'}`}>{r.p}</span>
                        </div>
                      ))}
                      </div>
                    </div>
                    <p className="text-[9px]">Actual cost scales with length; No charge for saved result re-open; Other functions costs will be recorded in Credit history table.</p>
                  </div>
                </div>
              </div>

              {/* ── Plans / Packs (dynamic: FREE → Pro upgrade, PRO → Packs) ── */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-neon-cyan mb-2">
                  {currentTier === 'pro' ? <Package size={18} /> : <Pro size={18} />}
                  <label className="text-xs font-bold uppercase tracking-widest font-mono">{currentTier === 'pro' ? 'Credit_Packs' : 'Upgrade_to_Pro'}</label>
                </div>
                {currentTier === 'pro' ? (
                  <div data-acct-panel="Credit_Packs" className="space-y-3 min-h-[175px]">
                    <div className="flex items-center justify-between">
                      <p className="text-[9px] text-zinc-600 font-mono">Credit packs are used only after your monthly credits run out, and never expire.</p>
                      <button onClick={handleManage} disabled={portalLoading} className="text-[9px] font-mono uppercase tracking-widest text-zinc-500 hover:text-neon-cyan transition flex items-center gap-1">
                        {portalLoading ? <Loader2 size={10} className="animate-spin" /> : <><ExternalLink size={9} /> Manage</>}
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {PACKS.map(pack => (
                        <div key={pack.type} className="content-panel rounded-sm p-3 text-center space-y-2">
                          <p className="text-lg font-bold text-white">{pack.credits.toLocaleString()}</p>
                          <p className="text-[9px] text-zinc-500 font-mono uppercase">credits</p>
                          <p className="text-sm font-bold text-neon-cyan">{pack.price}</p>
                          <button onClick={() => handleBuyPack(pack.storageKey, pack.type)} disabled={!!buyingPack} aria-busy={buyingPack === pack.type} className="w-full min-h-[28px] py-1.5 text-[10px] font-mono uppercase tracking-widest bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 rounded-sm transition active:scale-[0.98] flex items-center justify-center gap-1">
                            {buyingPack === pack.type ? <Loader2 size={10} className="animate-spin" /> : 'Buy'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : currentTier === 'free' ? (
                  <div className={`bg-void-2 border rounded-sm overflow-hidden min-h-[175px] ${billingError ? 'border-neon-red/40' : 'border-zinc-800'}`}>
                    <div className="p-4 relative">
                      {/* $9.99 is absolutely positioned so it doesn't inflate the "Pro" row height */}
                      <div className="absolute top-4 right-4 text-right">
                        <span className="text-lg font-bold text-white">$9.99</span>
                        <span className="text-zinc-500 text-xs ml-0.5">/month</span>
                      </div>
                      {/* Keep vertical spacing off the price's parent: an absolutely positioned
                          first child still makes Tailwind's space-y selector offset "Pro". */}
                      <div>
                        <p className="font-mono text-xs font-bold text-neon-cyan">Pro</p>
                        <p className="mt-2 text-[10px] text-zinc-600 font-mono">Auto-renewing · cancel anytime · secure payments via Stripe</p>
                        <button onClick={() => handleUpgrade('pro')} disabled={!!upgrading} className="mt-2 w-full py-2 text-[10px] font-mono uppercase tracking-widest bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 rounded-sm transition active:scale-[0.98] flex items-center justify-center gap-1.5">
                          {upgrading === 'pro' ? <Loader2 size={12} className="animate-spin" /> : 'Upgrade to Pro'}
                        </button>
                        <ul className="mt-2 space-y-1 text-[9px] text-zinc-500 font-mono list-disc list-inside">
                          <li>1,000 credits/month</li>
                          <li>1 GB local space and 1 GB cloud space</li>
                          <li>Buy extra credit packs anytime</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                ) : null}
                {billingError && (
                  <div className="pt-1"><StatusMessage variant="error" title={billingError} inline /></div>
                )}
              </div>

              {/* ── Credits Dashboard ── */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-neon-cyan mb-2">
                  <Wallet size={18} />
                  <label className="text-xs font-bold uppercase tracking-widest font-mono">Credit_Balance</label>
                </div>

                {loading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 size={16} className="animate-spin text-zinc-500" />
                  </div>
                ) : tierInfo ? (
                  <div data-acct-panel="Credit_Balance" className="content-panel rounded-sm p-4 flex flex-col gap-2 min-h-[262px]">
                    {(
                      <>
                        <div className="flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1.5">
                            <span className="text-neon-cyan font-mono font-bold">Monthly credits</span>
                            {(tierInfo.bonus_credits || 0) > 0 && (
                              <span className="text-[9px] text-neon-amber font-mono border border-neon-amber/30 rounded-sm px-1 py-px leading-none" title="Temporary bonus credits — used after your monthly credits, before packs">
                                +{tierInfo.bonus_credits} bonus
                              </span>
                            )}
                          </span>
                          <span className={`font-mono font-bold ${barText(creditPct)}`}>
                            {tierInfo.credits_used} / {monthlyCredits} used
                          </span>
                        </div>
                        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${barBg(creditPct)}`}
                            style={{ width: `${creditPct}%` }}
                          />
                        </div>
                        {currentTier === 'pro' && (
                          <>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-neon-cyan font-mono font-bold">Credit pack</span>
                              <span className={`font-mono font-bold ${packTotal > 0 ? barText(packPct) : 'text-zinc-500'}`}>
                                {packTotal > 0 ? `${packUsed} / ${packTotal} used` : '0'}
                              </span>
                            </div>
                            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${barBg(packPct)}`}
                                style={{ width: `${packPct}%` }}
                              />
                            </div>
                          </>
                        )}
                      </>
                    )}

                    {/* Credit history (consume / earn / renewal) */}
                    <CreditHistory userId={user?.id} renewal={tierInfo ? { at: tierInfo.period_start, credits: TIER_CREDITS[tierInfo.tier], label: currentTier === 'free' ? 'Signup bonus' : 'Monthly renewal' } : undefined} />
                  </div>
                ) : null}
              </div>

              {/* ── Earn Free Credits ── */}
              {refCode && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-neon-cyan mb-2">
                    <Gift size={18} />
                    <label className="text-xs font-bold uppercase tracking-widest font-mono">Earn_Free_Credits</label>
                  </div>
                  <div data-acct-panel="Earn_Free_Credits" className="bg-void-2 border border-zinc-800 rounded-sm p-4 space-y-2 flex flex-col min-h-[262px]">
                    {/* Share link */}
                    <div className="space-y-2">
                      <p className="text-xs text-neon-cyan font-mono font-bold">Limited Time Offer</p>
                      <p className="text-[10px] text-zinc-400 font-mono">Earn <span className="text-neon-cyan">100 credits</span> when a new user you referred signs up and starts using their free credits (up to 1,000 credits).</p>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-void-1 border border-zinc-800 rounded-sm px-3 py-1.5 text-[10px] font-mono text-neon-cyan truncate">
                          {getShareUrl(refCode)}
                        </div>
                        <button
                          onClick={() => { navigator.clipboard.writeText(getShareUrl(refCode)); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                          aria-label="Copy referral link"
                          className="shrink-0 p-1.5 border border-zinc-800 rounded-sm text-zinc-500 hover:text-neon-cyan hover:border-neon-cyan/30 transition active:scale-90"
                        >
                          {copied ? <Check size={12} className="text-neon-cyan" /> : <Copy size={12} />}
                        </button>
                      </div>
                      <p className="text-[9px] text-zinc-600 font-mono">Send the URL to friends directly; Quick sharing buttons below copies the caption to your clipboard automatically - paste it into the post that opens.</p>
                      <div className="grid grid-cols-4 gap-2">
                        <button onClick={() => shareOnTwitter(refCode)} className="text-[9px] font-mono uppercase tracking-widest py-2 border border-zinc-800 rounded-sm text-zinc-500 hover:text-neon-cyan hover:border-neon-cyan/30 transition active:scale-95 flex items-center justify-center gap-1.5"><span className="text-[11px] leading-none">𝕏</span> Twitter</button>
                        <button onClick={() => shareOnFacebook(refCode)} title="Copies the caption, then opens Facebook" className="text-[9px] font-mono uppercase tracking-widest py-2 border border-zinc-800 rounded-sm text-zinc-500 hover:text-neon-cyan hover:border-neon-cyan/30 transition active:scale-95 flex items-center justify-center gap-1.5"><Facebook size={11} /> Facebook</button>
                        <button onClick={() => shareOnLinkedIn(refCode)} title="Copies the caption, then opens LinkedIn" className="text-[9px] font-mono uppercase tracking-widest py-2 border border-zinc-800 rounded-sm text-zinc-500 hover:text-neon-cyan hover:border-neon-cyan/30 transition active:scale-95 flex items-center justify-center gap-1.5"><Linkedin size={11} /> LinkedIn</button>
                        <button onClick={() => shareOnInstagram(refCode)} title="Copies the caption, then opens Instagram" className="text-[9px] font-mono uppercase tracking-widest py-2 border border-zinc-800 rounded-sm text-zinc-500 hover:text-neon-cyan hover:border-neon-cyan/30 transition active:scale-95 flex items-center justify-center gap-1.5"><Instagram size={11} /> Instagram</button>
                      </div>
                    </div>


                    {/* Program terms — always shown; the list scrolls within the remaining space, like the Credit History table area. */}
                    <div className="flex flex-col min-h-0 flex-1">
                      <p className="text-[10px] font-mono text-zinc-600">Program terms</p>
                      <ul className="mt-2 space-y-1 text-[9px] text-zinc-500 font-mono leading-relaxed list-disc list-inside overflow-y-auto custom-scrollbar min-h-0 flex-1 pr-2">
                        <li>Bonus credits are promotional store credit for use within DecodEbook only — they have no cash value and are not redeemable, transferable, or refundable.</li>
                        <li>Credits earned never expire. They are applied after your monthly credits and before any purchased packs.</li>
                        <li>Rewards: 100 credits when a new user you referred signs up, verifies their email, and starts using their free credits (up to 1,000 credits total).</li>
                        <li>Self-referrals, duplicate or automated signups, and other abuse do not qualify and may result in credit reversal or account action.</li>
                        <li>This is a limited-time promotion. DecodEbook may change, suspend, or end it at any time; credits already earned are unaffected.</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}


              {/* Delete account (danger zone) — a small grey link below Earn_Free_Credits that expands
                  into a red confirmation with DELETE / CANCEL (same height as the binded-account buttons). */}
              <div>
                {!confirmingDelete ? (
                  <div className="text-center">
                    <button onClick={() => { setConfirmingDelete(true); setError(''); }} className="text-[9px] font-mono uppercase tracking-widest text-zinc-600 hover:text-neon-red transition-colors">
                      Delete Account
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[10px] text-neon-red font-mono leading-relaxed text-center">This cannot be undone, remaining credit balance cannot be refunded, still Delete?</p>
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={handleDeleteAccount} disabled={deleting} className="py-2 rounded-sm border border-neon-red/50 bg-neon-red/10 text-neon-red hover:bg-neon-red/20 text-[10px] font-mono uppercase tracking-widest transition active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-1.5">
                        {deleting ? <Loader2 size={11} className="animate-spin" /> : null}Delete
                      </button>
                      <button onClick={() => setConfirmingDelete(false)} disabled={deleting} className="py-2 rounded-sm border border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 text-[10px] font-mono uppercase tracking-widest transition active:scale-[0.98] disabled:opacity-50 flex items-center justify-center">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

            </div>
          ) : (
            /* ── Auth View ── */
            <div className="p-6 space-y-6">
              {error && <div className="py-1"><StatusMessage variant="error" title={error} inline /></div>}
              {success && <div className="py-1"><StatusMessage variant="success" title={success} inline /></div>}

              {authMode === 'forgot' ? (
                <div className="space-y-4">
                  <p className="text-xs text-zinc-500 font-mono leading-relaxed">Enter your email to receive a password reset link.</p>
                  <div className="flex items-center gap-2 content-panel rounded-sm px-3 py-2.5">
                    <Mail size={14} className="text-zinc-600 shrink-0" />
                    <input id="acct-reset-email" name="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="email@example.com" className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono" onKeyDown={e => e.key === 'Enter' && handleForgotPassword()} />
                  </div>
                  <button onClick={handleForgotPassword} disabled={authLoading} className="w-full py-2.5 bg-neon-cyan text-black font-bold rounded-sm text-xs font-mono uppercase tracking-widest hover:bg-[#00c2cc] transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 shadow-glow-cyan">
                    {authLoading && <Loader2 size={14} className="animate-spin" />}
                    Send Reset Link
                  </button>
                  <button onClick={() => { setAuthMode('login'); setError(''); setSuccess(''); }} className="w-full py-2 text-zinc-500 hover:text-neon-cyan text-[10px] font-mono uppercase tracking-widest transition-colors">
                    Back to Sign In
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 content-panel rounded-sm px-3 py-2.5">
                      <Mail size={14} className="text-zinc-600 shrink-0" />
                      <input id="acct-auth-email" name="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="email@example.com" className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono" onKeyDown={e => e.key === 'Enter' && handleAuth()} />
                    </div>
                    <div className="flex items-center gap-2 content-panel rounded-sm px-3 py-2.5">
                      <KeyIcon size={14} className="text-zinc-600 shrink-0" />
                      <input id="acct-auth-password" name="password" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} type={showPassword ? 'text' : 'password'} placeholder="password" className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono" onKeyDown={e => e.key === 'Enter' && handleAuth()} />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="text-zinc-600 hover:text-zinc-400 transition-colors shrink-0">
                        {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>

                  {authMode === 'login' && (
                    <div className="flex justify-end">
                      <button onClick={() => { setAuthMode('forgot'); setError(''); setSuccess(''); }} className="text-[10px] text-zinc-500 hover:text-neon-cyan font-mono uppercase tracking-widest transition-colors">Forgot Password?</button>
                    </div>
                  )}

                  {authMode === 'signup' && (
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input id="acct-agree-terms" name="agree-terms" type="checkbox" checked={agreedToTerms} onChange={e => setAgreedToTerms(e.target.checked)} className="mt-0.5 accent-neon-cyan" />
                      <span className="text-[10px] text-zinc-500 font-mono leading-relaxed">
                        I agree to the <a href="/terms" target="_blank" className="text-neon-cyan hover:underline">Terms of Service</a> and <a href="/privacy" target="_blank" className="text-neon-cyan hover:underline">Privacy Policy</a>
                      </span>
                    </label>
                  )}

                  <button onClick={handleAuth} disabled={authLoading || (authMode === 'signup' && !agreedToTerms)} className="w-full py-2.5 bg-neon-cyan text-black font-bold rounded-sm text-xs font-mono uppercase tracking-widest hover:bg-[#00c2cc] transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 shadow-glow-cyan">
                    {authLoading ? <Loader2 size={14} className="animate-spin" /> : authMode === 'login' ? <LogIn size={14} /> : <UserPlus size={14} />}
                    {authMode === 'login' ? 'Sign In' : 'Create Account'}
                  </button>

                  {isSupabaseConfigured() && (
                    <>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-[1px] bg-zinc-800"></div>
                        <span className="text-[10px] text-zinc-600 font-mono uppercase">or</span>
                        <div className="flex-1 h-[1px] bg-zinc-800"></div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button onClick={() => handleOAuth('google')} disabled={authLoading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded-sm text-xs font-mono uppercase tracking-widest transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Google
                        </button>
                        <button onClick={() => handleOAuth('github')} disabled={authLoading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded-sm text-xs font-mono uppercase tracking-widest transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50">
                          <Github size={14} /> GitHub
                        </button>
                        <button onClick={() => handleOAuth('x')} disabled={authLoading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded-sm text-xs font-mono uppercase tracking-widest transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg> X
                        </button>
                        <button onClick={() => handleOAuth('discord')} disabled={authLoading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded-sm text-xs font-mono uppercase tracking-widest transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg> Discord
                        </button>
                      </div>
                    </>
                  )}

                  <div className="flex items-center justify-center">
                    <button onClick={() => { setAuthMode(authMode === 'login' ? 'signup' : 'login'); setError(''); setSuccess(''); setAgreedToTerms(false); }} className="text-[10px] text-zinc-500 hover:text-neon-cyan font-mono uppercase tracking-widest transition-colors">
                      {authMode === 'login' ? 'Create Account' : 'Already have an account?'}
                    </button>
                  </div>

                  <p className="text-[9px] text-zinc-500 font-mono text-center leading-relaxed">
                    By continuing, you agree to our <a href="/terms" target="_blank" className="text-zinc-500 hover:text-neon-cyan underline">Terms of Service</a> and <a href="/privacy" target="_blank" className="text-zinc-500 hover:text-neon-cyan underline">Privacy Policy</a>
                  </p>
                </div>
              )}

              {/* Plans teaser */}
              <div className="border-t border-zinc-800 pt-4">
                <div className="flex items-center gap-2 text-neon-cyan mb-3">
                  <Pro size={16} />
                  <label className="text-[10px] font-bold uppercase tracking-widest font-mono">Plans</label>
                </div>
                <div className="space-y-2">
                  {PLANS.map(plan => (
                    <div key={plan.id} className="flex items-center justify-between p-3 rounded-sm content-panel">
                      <div className="flex items-center gap-2">
                        <plan.icon size={14} className={`text-${plan.color}`} />
                        <span className={`text-xs font-mono font-bold tracking-widest text-${plan.color}`}>{plan.name}</span>
                      </div>
                      <div>
                        <span className="text-sm font-bold text-white">{plan.price}</span>
                        {plan.period && <span className="text-[10px] text-zinc-600 ml-0.5">{plan.period}</span>}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[9px] text-zinc-600 font-mono text-center mt-2">Sign in to manage your subscription</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
