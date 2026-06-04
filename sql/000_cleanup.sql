-- Run this FIRST to clean up the partial creation, then re-run 001_user_behavior_tracking.sql

drop view if exists public.v_user_funnel cascade;
drop view if exists public.v_feature_adoption cascade;
drop view if exists public.v_user_engagement cascade;
drop view if exists public.v_generation_stats cascade;
drop view if exists public.v_daily_events_by_module cascade;
drop view if exists public.v_daily_active_users cascade;
drop function if exists public.track_generation cascade;
drop function if exists public.end_session cascade;
drop function if exists public.start_session cascade;
drop function if exists public.track_event cascade;
drop function if exists public.increment_generation_count cascade;
drop function if exists public.decrement_book_count cascade;
drop function if exists public.increment_book_count cascade;
drop function if exists public.set_updated_at cascade;
drop function if exists public.handle_new_user cascade;
drop trigger if exists on_auth_user_created on auth.users;
drop table if exists public.generations cascade;
drop table if exists public.events cascade;
drop table if exists public.sessions cascade;
drop table if exists public.books cascade;
drop table if exists public.subscriptions cascade;
drop table if exists public.profiles cascade;
