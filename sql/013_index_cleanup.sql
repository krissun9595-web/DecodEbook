-- ============================================================================
-- 013: Redundant index cleanup  (Phase 3 of the DB establishment review)
-- ============================================================================
-- Verified against the live index inventory (2026-08-26). Exactly one index is
-- truly redundant:
--   idx_referral_signups_referred (non-unique, referred_user_id) duplicates the
--   UNIQUE constraint index referral_signups_referred_user_id_key (same single
--   column). The unique index serves all referred_user_id lookups, so the
--   non-unique copy is dead weight. Dropping it does NOT remove the uniqueness
--   guarantee (that lives on the *_key index, which is kept).
--
-- Idempotent + non-destructive to data. Safe to re-run.
-- (Left intentionally in place: idx_referral_clicks_referrer — technically covered
--  by the leading column of the (referrer_id, visitor_hash) unique index, but a
--  narrower single-column index is a legitimate choice on a hot lookup column.)
-- ============================================================================

drop index if exists public.idx_referral_signups_referred;
