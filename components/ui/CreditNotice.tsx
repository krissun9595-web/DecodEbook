import React from 'react';
import { StatusMessage } from './StatusMessage';
import { openAccount, getCachedTier } from '../../services/credits';
import { getAvailableCredits } from '../../services/stripe';
import { gateCost } from '../../services/pricing';

// The one "can't afford this" HAZARD notice shown by every blocked action. It's
// balance-aware: a user with SOME credits (just not enough for this action) sees
// "Not enough credits" + what they have and what it needs — not a misleading
// "Out of credits". Free users are steered to upgrade; pro users to buy a pack.
export const CreditNotice: React.FC<{ tier: 'free' | 'pro'; action?: string; className?: string }> = ({ tier, action, className }) => {
  const cached = getCachedTier();
  const available = cached ? getAvailableCredits(cached) : 0;
  const hasSome = available > 0 && available !== Infinity;
  const needed = action ? gateCost(action) : 0;

  const detail = hasSome
    ? `You have ${available} credit${available === 1 ? '' : 's'}${needed ? `, this needs ${needed}` : ''}. `
    : '';
  const cta = tier === 'free'
    ? 'Upgrade to Pro to keep generating.'
    : 'Buy a credit pack to keep generating.';

  return (
    <StatusMessage
      variant="hazard"
      title={hasSome ? 'Not enough credits' : 'Out of credits'}
      sub={detail + cta}
      action={{
        label: tier === 'free' ? 'Upgrade to Pro' : 'Buy Extra Credits',
        onClick: () => openAccount(tier === 'free' ? 'upgrade' : 'packs'),
      }}
      className={className}
    />
  );
};
