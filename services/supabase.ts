
import { createClient, SupabaseClient, User, Session } from '@supabase/supabase-js';

// These will be set by the user in the app's connection settings.
// Default to empty strings — the app works offline without Supabase.
const SUPABASE_URL = (typeof process !== 'undefined' && process.env?.SUPABASE_URL) || '';
const SUPABASE_ANON_KEY = (typeof process !== 'undefined' && process.env?.SUPABASE_ANON_KEY) || '';

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (supabase) return supabase;

  // Try env vars first, then localStorage for user-provided config
  const url = SUPABASE_URL || localStorage.getItem('supabase_url') || '';
  const key = SUPABASE_ANON_KEY || localStorage.getItem('supabase_anon_key') || '';

  if (!url || !key) return null;

  supabase = createClient(url, key);
  return supabase;
}

export function configureSupabase(url: string, anonKey: string) {
  localStorage.setItem('supabase_url', url);
  localStorage.setItem('supabase_anon_key', anonKey);
  supabase = createClient(url, anonKey);
  return supabase;
}

export function isSupabaseConfigured(): boolean {
  return getSupabase() !== null;
}

export async function testConnection(): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  try {
    // A lightweight call that verifies the URL and key are valid
    const { error } = await client.auth.getSession();
    return !error;
  } catch {
    return false;
  }
}

// ---- Auth helpers ----

export async function signUp(email: string, password: string) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured');
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email: string, password: string) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured');
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signInWithOAuth(provider: 'google' | 'github') {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured');
  const { data, error } = await client.auth.signInWithOAuth({ provider });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const client = getSupabase();
  if (!client) return;
  await client.auth.signOut();
}

export async function resetPassword(email: string) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured');
  const { error } = await client.auth.resetPasswordForEmail(email);
  if (error) throw error;
}

export async function getSession(): Promise<Session | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session;
}

export async function getUser(): Promise<User | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data } = await client.auth.getUser();
  return data.user;
}

// ---- Settings sync ----

export interface UserSettings {
  gemini_key?: string;
  openrouter_key?: string;
  target_language?: string;
  highlight_color?: string;
  text_size?: string;
  line_height?: string;
  letter_spacing?: string;
  font?: string;
}

export async function loadUserSettings(userId: string): Promise<UserSettings | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data, error } = await client
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data as UserSettings;
}

export async function saveUserSettings(userId: string, settings: UserSettings) {
  const client = getSupabase();
  if (!client) return;
  await client
    .from('user_settings')
    .upsert({ user_id: userId, ...settings, updated_at: new Date().toISOString() });
}

// ---- Usage logging ----

export async function logUsage(userId: string, action: string, tokensUsed: number = 0, costCents: number = 0) {
  const client = getSupabase();
  if (!client) return;
  await client
    .from('usage_logs')
    .insert({ user_id: userId, action, tokens_used: tokensUsed, cost_cents: costCents });
}
