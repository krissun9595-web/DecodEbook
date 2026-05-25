
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

  supabase = createClient(url, key, {
    auth: { detectSessionInUrl: true, flowType: 'pkce' },
  });
  return supabase;
}

export function configureSupabase(url: string, anonKey: string) {
  localStorage.setItem('supabase_url', url);
  localStorage.setItem('supabase_anon_key', anonKey);
  supabase = createClient(url, anonKey, {
    auth: { detectSessionInUrl: true, flowType: 'pkce' },
  });
  return supabase;
}

export function isSupabaseConfigured(): boolean {
  return getSupabase() !== null;
}

export async function bootstrapSupabase(): Promise<boolean> {
  if (isSupabaseConfigured()) return true;
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return false;
    const data = await res.json();
    if (data.supabaseUrl && data.supabaseAnonKey) {
      configureSupabase(data.supabaseUrl, data.supabaseAnonKey);
      if (data.stripeProPriceId) localStorage.setItem('stripe_pro_price_id', data.stripeProPriceId);
      if (data.stripeUnlimitedPriceId) localStorage.setItem('stripe_unlimited_price_id', data.stripeUnlimitedPriceId);
      return true;
    }
  } catch {}
  return false;
}

export async function handleOAuthCallback(): Promise<Session | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return null;

  const client = getSupabase();
  if (!client) return null;

  try {
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    window.history.replaceState({}, '', window.location.pathname);
    if (error) {
      console.error('[Supabase] OAuth code exchange failed:', error.message);
      return null;
    }
    return data.session;
  } catch (e) {
    console.error('[Supabase] OAuth code exchange error:', e);
    return null;
  }
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
  if (!client) throw new Error('Supabase not configured. Check supabase_url and supabase_anon_key in localStorage.');
  console.log('[Supabase] signUp attempt:', email);
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) {
    console.error('[Supabase] signUp error:', error.message, error.status, error);
    throw error;
  }
  console.log('[Supabase] signUp success:', data.user?.id, 'confirmed:', data.user?.confirmed_at ? 'yes' : 'no (email confirmation required)');
  return data;
}

export async function signIn(email: string, password: string) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured. Check supabase_url and supabase_anon_key in localStorage.');
  console.log('[Supabase] signIn attempt:', email);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    console.error('[Supabase] signIn error:', error.message, error.status, error);
    throw error;
  }
  console.log('[Supabase] signIn success:', data.user?.id);
  return data;
}

export async function signInWithOAuth(provider: 'google' | 'github' | 'x' | 'discord') {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured');
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo: window.location.origin },
  });
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

export function onAuthStateChange(callback: (user: User | null) => void): (() => void) | null {
  const client = getSupabase();
  if (!client) return null;
  const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
  return () => subscription.unsubscribe();
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
  llm_model?: string;
  tts_model?: string;
  image_model?: string;
  video_model?: string;
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
  const { error } = await client
    .from('user_settings')
    .upsert({ user_id: userId, ...settings, updated_at: new Date().toISOString() });
  if (error) console.warn('[Supabase] Failed to save settings:', error.message);
}

// ---- Usage logging ----

export async function logUsage(userId: string, action: string, tokensUsed: number = 0, costCents: number = 0) {
  const client = getSupabase();
  if (!client) return;
  await client
    .from('usage_logs')
    .insert({ user_id: userId, action, tokens_used: tokensUsed, cost_cents: costCents });
}
