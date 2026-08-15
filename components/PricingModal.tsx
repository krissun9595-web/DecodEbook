import React, { useState, useEffect } from 'react';
import { X, Zap, Crown, Key as KeyIcon, ExternalLink, Loader2, Calendar, BarChart3, Shield, Github, Mail, Eye, EyeOff, LogIn, UserPlus, LogOut, RefreshCw, ChevronDown, ChevronUp, Package, Gift, Share2, Copy, Check } from 'lucide-react';
import { Privacy, Pro } from './ui/glyphs';
import { UserTier, TIER_CREDITS, CREDIT_COSTS, getAvailableCredits, fetchUserTier, createCheckoutSession, createPackCheckout, openCustomerPortal } from '../services/stripe';
import {
  signIn, signUp, signInWithOAuth, signOut, resetPassword,
  isSupabaseConfigured
} from '../services/supabase';
import { getReferralCode, getReferralStats, getShareUrl, shareOnTwitter, shareOnFacebook, shareOnLinkedIn, ReferralStats } from '../services/referral';
import type { User } from '@supabase/supabase-js';
import { trackAuth } from '../utils/analytics';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  onAuthChange: (user: User | null) => void;
  proPriceId: string;
  proAnnualPriceId: string;
}

const TIER_DISPLAY: Record<string, { label: string; color: string; border: string; bg: string }> = {
  free: { label: 'FREE', color: 'text-zinc-400', border: 'border-zinc-700', bg: 'bg-zinc-800/50' },
  pro: { label: 'PRO', color: 'text-neon-cyan', border: 'border-neon-cyan/30', bg: 'bg-neon-cyan/5' },
  unlimited: { label: 'UNLIMITED', color: 'text-neon-cyan', border: 'border-neon-cyan/30', bg: 'bg-neon-cyan/5' },
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
    features: ['100 credits/month', '1 cr/chat · 5 cr/TTS · 10 cr/image', 'No video generation'],
  },
  {
    id: 'pro' as const,
    name: 'Pro',
    price: '$9.99',
    period: '/month',
    annualPrice: '$99.99',
    annualPeriod: '/year',
    annualSave: 'Save 17% — $8.33/mo',
    icon: Pro,
    color: 'neon-cyan',
    accentBorder: 'border-neon-cyan/40',
    features: ['1,000 credits/month', 'All AI features unlocked', '30-150 cr/video · 40 cr/podcast', 'Buy extra credit packs anytime'],
  },
];

const PACKS = [
  { type: 'S', credits: 1000, price: '$9.99', storageKey: 'stripe_pack_s_price_id' },
  { type: 'M', credits: 2500, price: '$19.99', storageKey: 'stripe_pack_m_price_id' },
  { type: 'L', credits: 4000, price: '$29.99', storageKey: 'stripe_pack_l_price_id' },
];

export function AccountPanel({ isOpen, onClose, user, onAuthChange, proPriceId, proAnnualPriceId }: Props) {
  const [tierInfo, setTierInfo] = useState<UserTier | null>(null);
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [expandedAnnual, setExpandedAnnual] = useState(false);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);

  const [refCode, setRefCode] = useState<string | null>(null);
  const [refStats, setRefStats] = useState<ReferralStats | null>(null);
  const [copied, setCopied] = useState(false);

  const [authMode, setAuthMode] = useState<'login' | 'signup' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    if (user) {
      setLoading(true);
      fetchUserTier().then(t => { setTierInfo(t); setLoading(false); });
      getReferralCode().then(setRefCode);
      getReferralStats().then(setRefStats);
    }
  }, [isOpen, user]);

  const handleUpgrade = async (tierId: string, annual = false) => {
    let priceId = '';
    if (tierId === 'pro') priceId = annual && proAnnualPriceId ? proAnnualPriceId : proPriceId;
    if (!priceId) return;
    setUpgrading(tierId + (annual ? '_annual' : ''));
    const url = await createCheckoutSession(priceId);
    if (url) window.location.href = url;
    setUpgrading(null);
  };

  const handleBuyPack = async (storageKey: string, packType: string) => {
    const priceId = localStorage.getItem(storageKey);
    if (!priceId) return;
    setBuyingPack(packType);
    const url = await createPackCheckout(priceId);
    if (url) window.location.href = url;
    setBuyingPack(null);
  };

  const handleManage = async () => {
    setPortalLoading(true);
    const url = await openCustomerPortal();
    if (url) window.location.href = url;
    setPortalLoading(false);
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

  const handleSignOut = async () => {
    trackAuth('sign_out');
    await signOut();
    onAuthChange(null);
    setTierInfo(null);
    setSuccess('Signed out');
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
  const monthlyCredits = TIER_CREDITS[currentTier] || 100;
  const available = tierInfo ? getAvailableCredits(tierInfo) : 0;
  const subscriptionRemaining = tierInfo ? Math.max(0, monthlyCredits - tierInfo.credits_used) : 0;
  const creditPct = monthlyCredits === Infinity ? 0 : Math.min(((tierInfo?.credits_used || 0) / monthlyCredits) * 100, 100);

  return (
    <div role="dialog" aria-modal="true" aria-label="Upgrade" className="fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4 animate-fade-in font-sans" onClick={onClose}>
      <div className="bg-void-1 border border-zinc-800 rounded-lg w-full max-w-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden animate-fade-in-up scale-in relative" onClick={e => e.stopPropagation()}>
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-neon-cyan to-neon-red"></div>

        <div className="p-6 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <h2 className="text-xl font-black text-white uppercase tracking-widest font-mono">My_Account</h2>
          <button onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-white transition active:scale-90"><X size={24} /></button>
        </div>

        <div className="h-[70vh] overflow-y-auto custom-scrollbar">
          {user ? (
            <div className="p-6 space-y-8">

              {/* ── Account Info ── */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-neon-cyan mb-2">
                  <Privacy size={18} />
                  <label className="text-xs font-bold uppercase tracking-widest font-mono">Account_Info</label>
                </div>
                <div className="content-panel rounded-sm p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-white font-mono">{user.email}</p>
                      <p className="text-[9px] text-zinc-600 font-mono mt-0.5">ID: {user.id.substring(0, 12)}...</p>
                    </div>
                    <span className={`text-[10px] font-mono font-bold uppercase tracking-widest px-2.5 py-1 rounded-sm border ${td.border} ${td.color} ${td.bg}`}>
                      {td.label}
                    </span>
                  </div>

                  {loading ? (
                    <div className="flex items-center justify-center py-3">
                      <Loader2 size={14} className="animate-spin text-zinc-500" />
                    </div>
                  ) : tierInfo && currentTier !== 'free' ? (
                    <div className="border-t border-zinc-800 pt-3 space-y-2">
                      <div className="flex items-center gap-1.5 text-zinc-500">
                        <Calendar size={12} />
                        <span className="text-[9px] font-mono uppercase">Subscription</span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="text-[9px] text-zinc-600 font-mono uppercase">Started</p>
                          <p className="text-xs text-zinc-300 font-mono">{tierInfo.period_start ? new Date(tierInfo.period_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-zinc-600 font-mono uppercase">Renews</p>
                          <p className="text-xs text-zinc-300 font-mono">{tierInfo.period_end ? new Date(tierInfo.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</p>
                        </div>
                      </div>
                      {tierInfo.cancel_at_period_end && (
                        <p className="text-[10px] font-mono text-neon-cyan bg-neon-cyan/5 border border-neon-cyan/20 rounded-sm px-2 py-1">
                          Cancels on {new Date(tierInfo.period_end || '').toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="border-t border-zinc-800 pt-3">
                      <p className="text-[10px] text-zinc-600 font-mono">No active subscription — using free tier.</p>
                    </div>
                  )}

                  <div className="border-t border-zinc-800 pt-3 flex gap-2">
                    <button onClick={handleSwitchAccount} className="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-sm text-[10px] font-mono uppercase tracking-widest transition-all active:scale-[0.98] flex items-center justify-center gap-1.5">
                      <RefreshCw size={10} /> Switch Account
                    </button>
                    <button onClick={handleSignOut} className="flex-1 py-2 bg-zinc-900 hover:bg-rose-950/30 text-zinc-400 hover:text-rose-400 border border-zinc-800 hover:border-rose-900/50 rounded-sm text-[10px] font-mono uppercase tracking-widest transition-all active:scale-[0.98] flex items-center justify-center gap-1.5">
                      <LogOut size={10} /> Sign Out
                    </button>
                  </div>
                </div>
              </div>

              {/* ── Credits Dashboard ── */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-neon-cyan mb-2">
                  <BarChart3 size={18} />
                  <label className="text-xs font-bold uppercase tracking-widest font-mono">Credits</label>
                </div>

                {loading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 size={16} className="animate-spin text-zinc-500" />
                  </div>
                ) : tierInfo ? (
                  <div className="content-panel rounded-sm p-4 space-y-3">
                    {monthlyCredits === Infinity ? (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-neon-cyan font-mono font-bold">Unlimited Credits</span>
                        <span className="text-[9px] text-zinc-600 font-mono">Unlimited tier</span>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-zinc-400 font-mono">Monthly credits</span>
                          <span className={`font-mono font-bold ${creditPct > 90 ? 'text-red-400' : creditPct > 70 ? 'text-neon-cyan' : 'text-neon-cyan'}`}>
                            {tierInfo.credits_used} / {monthlyCredits} used
                          </span>
                        </div>
                        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${creditPct > 90 ? 'bg-red-500' : creditPct > 70 ? 'bg-neon-cyan' : 'bg-neon-cyan'}`}
                            style={{ width: `${creditPct}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-zinc-500 font-mono">
                          <span>{subscriptionRemaining} remaining this period</span>
                          <span className="flex items-center gap-2">
                            {tierInfo.pack_credits > 0 && (
                              <span className="text-neon-cyan">+{tierInfo.pack_credits} pack</span>
                            )}
                            {(tierInfo.bonus_credits || 0) > 0 && (
                              <span className="text-neon-cyan">+{tierInfo.bonus_credits} bonus</span>
                            )}
                          </span>
                        </div>
                        <div className="text-[10px] font-mono font-bold text-zinc-300">
                          Total available: <span className={available < 10 ? 'text-red-400' : 'text-neon-cyan'}>{available}</span> credits
                        </div>
                      </>
                    )}

                    {/* Credit cost reference */}
                    <div className="border-t border-zinc-800 pt-2 mt-1">
                      <p className="text-[9px] text-zinc-600 font-mono mb-1.5">Credit costs:</p>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                        {[
                          { label: 'Chat/Text', cost: 1 },
                          { label: 'TTS page', cost: 5 },
                          { label: 'Image', cost: 10 },
                          { label: 'Podcast', cost: 43 },
                          { label: 'Video', cost: '30-150' },
                        ].map(c => (
                          <span key={c.label} className="text-[9px] text-zinc-500 font-mono">
                            <span className="text-zinc-400">{c.cost}</span> {c.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* ── Earn Free Credits ── */}
              {refCode && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-neon-cyan mb-2">
                    <Gift size={18} />
                    <label className="text-xs font-bold uppercase tracking-widest font-mono">Earn Free Credits</label>
                  </div>
                  <div className="bg-void-2 border border-neon-cyan/20 rounded-sm p-4 space-y-4">
                    {/* Share link */}
                    <div className="space-y-2">
                      <p className="text-[10px] text-zinc-400 font-mono">Share your link — earn <span className="text-neon-cyan">5 credits</span> per unique click (up to 50)</p>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-void-1 border border-zinc-800 rounded-sm px-3 py-1.5 text-[10px] font-mono text-zinc-400 truncate">
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
                      <div className="flex items-center gap-2">
                        <button onClick={() => shareOnTwitter(refCode)} className="text-[9px] font-mono uppercase tracking-widest px-2.5 py-1 border border-zinc-800 rounded-sm text-zinc-500 hover:text-neon-cyan hover:border-neon-cyan/30 transition active:scale-95">𝕏 Twitter</button>
                        <button onClick={() => shareOnFacebook(refCode)} className="text-[9px] font-mono uppercase tracking-widest px-2.5 py-1 border border-zinc-800 rounded-sm text-zinc-500 hover:text-neon-cyan hover:border-neon-cyan/30 transition active:scale-95">Facebook</button>
                        <button onClick={() => shareOnLinkedIn(refCode)} className="text-[9px] font-mono uppercase tracking-widest px-2.5 py-1 border border-zinc-800 rounded-sm text-zinc-500 hover:text-neon-cyan hover:border-neon-cyan/30 transition active:scale-95">LinkedIn</button>
                      </div>
                    </div>

                    {/* Referral invite */}
                    <div className="border-t border-zinc-800 pt-3 space-y-1">
                      <p className="text-[10px] text-zinc-400 font-mono">Invite a friend — earn <span className="text-neon-cyan">100 credits</span> when they sign up and use the app</p>
                      <p className="text-[9px] text-zinc-600 font-mono">Credits awarded after your friend uses 10 credits</p>
                    </div>

                    {/* Stats */}
                    {refStats && refStats.total_earned > 0 && (
                      <div className="border-t border-zinc-800 pt-3 flex items-center gap-4">
                        <div className="text-center">
                          <p className="text-sm font-bold text-neon-cyan font-mono">{refStats.total_earned}</p>
                          <p className="text-[8px] text-zinc-600 font-mono uppercase">Earned</p>
                        </div>
                        <div className="text-center">
                          <p className="text-sm font-bold text-white font-mono">{refStats.clicks}</p>
                          <p className="text-[8px] text-zinc-600 font-mono uppercase">Clicks</p>
                        </div>
                        <div className="text-center">
                          <p className="text-sm font-bold text-white font-mono">{refStats.signups}</p>
                          <p className="text-[8px] text-zinc-600 font-mono uppercase">Signups</p>
                        </div>
                        <div className="text-center">
                          <p className="text-sm font-bold text-white font-mono">{refStats.activated}</p>
                          <p className="text-[8px] text-zinc-600 font-mono uppercase">Activated</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── Plans ── */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-neon-cyan mb-2">
                  <Pro size={18} />
                  <label className="text-xs font-bold uppercase tracking-widest font-mono">Plans</label>
                </div>

                <div className="space-y-3">
                  {PLANS.map(plan => {
                    const isCurrent = currentTier === plan.id;
                    const Icon = plan.icon;
                    const isPaid = plan.id !== 'free';
                    const isProPlan = plan.id === 'pro';

                    return (
                      <div key={plan.id} className={`bg-void-2 border rounded-sm overflow-hidden transition-all ${isCurrent ? plan.accentBorder : 'border-zinc-800'}`}>
                        <div className="p-4">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Icon size={16} className={`text-${plan.color}`} />
                              <span className={`font-mono text-sm font-bold tracking-widest text-${plan.color}`}>{plan.name}</span>
                              {isCurrent && (
                                <span className={`text-[8px] font-mono font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-sm border ${td.border} ${td.color} ${td.bg}`}>
                                  Current
                                </span>
                              )}
                            </div>
                            <div className="text-right">
                              <span className="text-lg font-bold text-white">{plan.price}</span>
                              {plan.period && <span className="text-zinc-500 text-xs ml-0.5">{plan.period}</span>}
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
                            {plan.features.map((f, i) => (
                              <p key={i} className="text-[10px] text-zinc-500 font-mono flex items-center gap-1">
                                <span className={`text-${plan.color}`}>+</span> {f}
                              </p>
                            ))}
                          </div>

                          {isCurrent && isPaid ? (
                            <button onClick={handleManage} disabled={portalLoading} className="w-full py-2 text-[10px] font-mono uppercase tracking-widest border border-zinc-700 rounded-sm text-zinc-400 hover:text-white hover:border-zinc-500 transition active:scale-[0.98] flex items-center justify-center gap-1.5">
                              {portalLoading ? <Loader2 size={12} className="animate-spin" /> : <><ExternalLink size={10} /> Manage Subscription</>}
                            </button>
                          ) : !isCurrent && isPaid ? (
                            <div className="space-y-2">
                              <button
                                onClick={() => handleUpgrade(plan.id)}
                                disabled={!!upgrading}
                                className={`w-full py-2 text-[10px] font-mono uppercase tracking-widest rounded-sm transition active:scale-[0.98] flex items-center justify-center gap-1.5 ${
                                  isProPlan
                                    ? 'bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20'
                                    : 'bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20'
                                }`}
                              >
                                {upgrading === plan.id ? <Loader2 size={12} className="animate-spin" /> : 'Upgrade'}
                              </button>

                              {isProPlan && 'annualPrice' in plan && (
                                <>
                                  <button onClick={() => setExpandedAnnual(!expandedAnnual)} className="w-full flex items-center justify-center gap-1 text-[9px] text-zinc-600 hover:text-neon-cyan font-mono uppercase tracking-widest transition-colors py-1">
                                    {expandedAnnual ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                                    Annual plan available
                                  </button>
                                  {expandedAnnual && (
                                    <div className="bg-neon-cyan/5 border border-neon-cyan/20 rounded-sm p-3 space-y-2 animate-fade-in">
                                      <div className="flex items-center justify-between">
                                        <div>
                                          <span className="text-sm font-bold text-white">{plan.annualPrice}</span>
                                          <span className="text-zinc-500 text-xs ml-0.5">{plan.annualPeriod}</span>
                                        </div>
                                        <span className="text-[9px] font-mono text-neon-cyan bg-neon-cyan/10 px-1.5 py-0.5 rounded-sm">{plan.annualSave}</span>
                                      </div>
                                      <button onClick={() => handleUpgrade('pro', true)} disabled={!!upgrading} className="w-full py-2 text-[10px] font-mono uppercase tracking-widest bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 rounded-sm transition active:scale-[0.98] flex items-center justify-center gap-1.5">
                                        {upgrading === 'pro_annual' ? <Loader2 size={12} className="animate-spin" /> : 'Upgrade to Annual'}
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <p className="text-[9px] text-zinc-600 font-mono text-center leading-relaxed pt-1">
                  Monthly plans are auto-renewing subscriptions. Cancel anytime via Manage Subscription.
                  <br />Secure payments via Stripe · Prices in USD
                </p>
              </div>

              {/* ── Credit Packs (Pro only) ── */}
              {currentTier === 'pro' && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-neon-cyan mb-2">
                    <Package size={18} />
                    <label className="text-xs font-bold uppercase tracking-widest font-mono">Credit_Packs</label>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {PACKS.map(pack => (
                      <div key={pack.type} className="content-panel rounded-sm p-3 text-center space-y-2">
                        <p className="text-lg font-bold text-white">{pack.credits.toLocaleString()}</p>
                        <p className="text-[9px] text-zinc-500 font-mono uppercase">credits</p>
                        <p className="text-sm font-bold text-neon-cyan">{pack.price}</p>
                        <button
                          onClick={() => handleBuyPack(pack.storageKey, pack.type)}
                          disabled={!!buyingPack}
                          className="w-full py-1.5 text-[10px] font-mono uppercase tracking-widest bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 rounded-sm transition active:scale-[0.98] flex items-center justify-center gap-1"
                        >
                          {buyingPack === pack.type ? <Loader2 size={10} className="animate-spin" /> : 'Buy'}
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="text-[9px] text-zinc-600 font-mono text-center">
                    Credit packs never expire. One-time purchase, Pro subscribers only.
                  </p>
                </div>
              )}

            </div>
          ) : (
            /* ── Auth View ── */
            <div className="p-6 space-y-6">
              {error && <div className="p-2 bg-rose-950/30 border border-rose-900/50 rounded-sm text-xs text-rose-400 font-mono">{error}</div>}
              {success && <div className="p-2 bg-neon-cyan/30 border border-neon-cyan/50 rounded-sm text-xs text-neon-cyan font-mono">{success}</div>}

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
