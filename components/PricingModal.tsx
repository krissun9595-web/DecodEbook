import React, { useState, useEffect } from 'react';
import { X, Zap, Crown, Infinity, ExternalLink, Loader2, CreditCard } from 'lucide-react';
import { UserTier, TIER_LIMITS, fetchUserTier, createCheckoutSession, openCustomerPortal } from '../services/stripe';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  proPriceId: string;
  unlimitedPriceId: string;
}

const TIERS = [
  {
    id: 'free' as const,
    name: 'FREE',
    price: '$0',
    period: '',
    icon: Zap,
    color: 'zinc-500',
    border: 'border-zinc-700',
    glow: '',
  },
  {
    id: 'pro' as const,
    name: 'PRO',
    price: '$9.99',
    period: '/ month',
    icon: Crown,
    color: '[#00f3ff]',
    border: 'border-[#00f3ff]/50',
    glow: 'shadow-[0_0_20px_rgba(0,243,255,0.15)]',
  },
  {
    id: 'unlimited' as const,
    name: 'UNLIMITED',
    price: '$29.99',
    period: '/ month',
    icon: Infinity,
    color: 'amber-400',
    border: 'border-amber-500/50',
    glow: 'shadow-[0_0_20px_rgba(245,158,11,0.15)]',
  },
];

const CATEGORIES = [
  { key: 'text', label: 'Text Generation' },
  { key: 'tts', label: 'Voice Synthesis' },
  { key: 'image', label: 'Image Generation' },
  { key: 'video', label: 'Video Generation' },
] as const;

export function PricingModal({ isOpen, onClose, proPriceId, unlimitedPriceId }: Props) {
  const [tierInfo, setTierInfo] = useState<UserTier | null>(null);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    fetchUserTier().then(t => { setTierInfo(t); setLoading(false); });
  }, [isOpen]);

  const handleUpgrade = async (tier: string) => {
    const priceId = tier === 'pro' ? proPriceId : unlimitedPriceId;
    if (!priceId) return;
    setUpgrading(tier);
    const url = await createCheckoutSession(priceId);
    if (url) window.location.href = url;
    setUpgrading(null);
  };

  const handleManage = async () => {
    setPortalLoading(true);
    const url = await openCustomerPortal();
    if (url) window.location.href = url;
    setPortalLoading(false);
  };

  if (!isOpen) return null;

  const currentTier = tierInfo?.tier || 'free';

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <CreditCard size={16} className="text-[#00f3ff]" />
            <h2 className="font-tech text-xs text-zinc-300 uppercase tracking-widest">Subscription Plans</h2>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X size={16} /></button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center p-16">
            <Loader2 size={20} className="animate-spin text-[#00f3ff]" />
          </div>
        ) : (
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {TIERS.map(tier => {
                const limits = TIER_LIMITS[tier.id];
                const isCurrent = currentTier === tier.id;
                const Icon = tier.icon;

                return (
                  <div key={tier.id} className={`relative rounded-lg border ${tier.border} ${tier.glow} p-4 flex flex-col`}>
                    {isCurrent && (
                      <div className={`absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-zinc-950 border ${tier.border} rounded text-[9px] font-tech uppercase tracking-widest text-${tier.color}`}>
                        Current
                      </div>
                    )}

                    <div className="flex items-center gap-2 mb-3 mt-1">
                      <Icon size={14} className={`text-${tier.color}`} />
                      <span className={`font-tech text-xs tracking-widest text-${tier.color}`}>{tier.name}</span>
                    </div>

                    <div className="mb-4">
                      <span className="text-2xl font-bold text-white">{tier.price}</span>
                      {tier.period && <span className="text-zinc-500 text-xs ml-1">{tier.period}</span>}
                    </div>

                    <div className="space-y-2 flex-1 mb-4">
                      {CATEGORIES.map(cat => {
                        const limit = limits[cat.key as keyof typeof limits];
                        const used = tierInfo?.[`${cat.key}_used` as keyof UserTier] as number || 0;
                        const displayLimit = limit === Infinity ? '∞' : limit;
                        return (
                          <div key={cat.key} className="flex items-center justify-between text-[11px]">
                            <span className="text-zinc-500">{cat.label}</span>
                            <span className="font-tech text-zinc-300">
                              {isCurrent ? <span className={used >= limit && limit !== Infinity ? 'text-red-400' : ''}>{used}/</span> : null}
                              {displayLimit}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {isCurrent ? (
                      tier.id !== 'free' ? (
                        <button
                          onClick={handleManage}
                          disabled={portalLoading}
                          className="w-full py-2 text-[10px] font-tech uppercase tracking-widest border border-zinc-700 rounded text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors flex items-center justify-center gap-1.5"
                        >
                          {portalLoading ? <Loader2 size={12} className="animate-spin" /> : <><ExternalLink size={10} /> Manage</>}
                        </button>
                      ) : null
                    ) : tier.id !== 'free' ? (
                      <button
                        onClick={() => handleUpgrade(tier.id)}
                        disabled={!!upgrading}
                        className={`w-full py-2 text-[10px] font-tech uppercase tracking-widest rounded transition-colors flex items-center justify-center gap-1.5 ${
                          tier.id === 'pro'
                            ? 'bg-[#00f3ff]/10 border border-[#00f3ff]/30 text-[#00f3ff] hover:bg-[#00f3ff]/20'
                            : 'bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20'
                        }`}
                      >
                        {upgrading === tier.id ? <Loader2 size={12} className="animate-spin" /> : 'Upgrade'}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {tierInfo?.cancel_at_period_end && (
              <p className="text-center text-[10px] font-tech text-amber-400">
                Your subscription will end on {new Date(tierInfo.period_end || '').toLocaleDateString()}
              </p>
            )}

            <p className="text-center text-[10px] text-zinc-600">
              Secure payments via Stripe. Cancel anytime.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
