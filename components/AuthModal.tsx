
import React, { useState } from 'react';
import { X, LogIn, UserPlus, Github, Mail, Key, Server, Loader2 } from 'lucide-react';
import {
  signIn, signUp, signInWithOAuth, signOut,
  configureSupabase, isSupabaseConfigured,
  getUser
} from '../services/supabase';
import type { User } from '@supabase/supabase-js';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  onAuthChange: (user: User | null) => void;
}

export const AuthModal: React.FC<Props> = ({ isOpen, onClose, user, onAuthChange }) => {
  const [mode, setMode] = useState<'login' | 'signup' | 'setup'>(!isSupabaseConfigured() ? 'setup' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [supabaseUrl, setSupabaseUrl] = useState(localStorage.getItem('supabase_url') || '');
  const [supabaseKey, setSupabaseKey] = useState(localStorage.getItem('supabase_anon_key') || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  if (!isOpen) return null;

  const handleSetup = () => {
    if (!supabaseUrl || !supabaseKey) {
      setError('Both URL and Anon Key are required');
      return;
    }
    try {
      configureSupabase(supabaseUrl, supabaseKey);
      setError('');
      setSuccess('Connected to Supabase');
      setMode('login');
    } catch (e: any) {
      setError(e.message || 'Connection failed');
    }
  };

  const handleAuth = async () => {
    if (!email || !password) {
      setError('Email and password required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      if (mode === 'signup') {
        await signUp(email, password);
        setSuccess('Account created! Check your email to confirm.');
      } else {
        const data = await signIn(email, password);
        onAuthChange(data.user);
        setSuccess('Logged in');
        setTimeout(onClose, 500);
      }
    } catch (e: any) {
      setError(e.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleOAuth = async (provider: 'google' | 'github') => {
    setLoading(true);
    setError('');
    try {
      await signInWithOAuth(provider);
    } catch (e: any) {
      setError(e.message || 'OAuth failed');
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    onAuthChange(null);
    setSuccess('Signed out');
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="bg-[#0a0a0c] border border-zinc-800 rounded-lg w-full max-w-md p-6 relative shadow-2xl" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-zinc-600 hover:text-white transition-colors"><X size={18} /></button>

        <div className="flex items-center gap-2 mb-6">
          <Key size={18} className="text-[#00f3ff]" />
          <h2 className="text-sm font-bold text-white font-mono uppercase tracking-widest">
            {user ? 'ACCOUNT' : mode === 'setup' ? 'CONNECT_DB' : mode === 'login' ? 'SIGN_IN' : 'SIGN_UP'}
          </h2>
        </div>

        {error && <div className="mb-4 p-2 bg-rose-950/30 border border-rose-900/50 rounded text-xs text-rose-400 font-mono">{error}</div>}
        {success && <div className="mb-4 p-2 bg-emerald-950/30 border border-emerald-900/50 rounded text-xs text-emerald-400 font-mono">{success}</div>}

        {user ? (
          <div className="space-y-4">
            <div className="p-3 bg-zinc-900 rounded border border-zinc-800">
              <p className="text-xs text-zinc-500 font-mono uppercase mb-1">Logged in as</p>
              <p className="text-sm text-[#00f3ff] font-mono">{user.email}</p>
            </div>
            <button onClick={handleSignOut} className="w-full py-2.5 bg-zinc-900 hover:bg-rose-950/30 text-zinc-400 hover:text-rose-400 border border-zinc-800 hover:border-rose-900/50 rounded text-xs font-mono uppercase tracking-widest transition-all">
              Sign Out
            </button>
          </div>
        ) : mode === 'setup' ? (
          <div className="space-y-4">
            <p className="text-xs text-zinc-500 font-mono leading-relaxed">
              Connect your Supabase project to enable cloud sync, auth, and usage tracking. Get your project URL and anon key from supabase.com → Project Settings → API.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-zinc-500 font-mono uppercase mb-1 block">Project URL</label>
                <div className="flex items-center gap-2 bg-[#050505] border border-zinc-800 rounded px-3 py-2">
                  <Server size={14} className="text-zinc-600 shrink-0" />
                  <input value={supabaseUrl} onChange={e => setSupabaseUrl(e.target.value)} placeholder="https://xxx.supabase.co" className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono" />
                </div>
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 font-mono uppercase mb-1 block">Anon Key</label>
                <div className="flex items-center gap-2 bg-[#050505] border border-zinc-800 rounded px-3 py-2">
                  <Key size={14} className="text-zinc-600 shrink-0" />
                  <input value={supabaseKey} onChange={e => setSupabaseKey(e.target.value)} type="password" placeholder="eyJhbGc..." className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono" />
                </div>
              </div>
            </div>
            <button onClick={handleSetup} className="w-full py-2.5 bg-[#00f3ff] text-black font-bold rounded text-xs font-mono uppercase tracking-widest hover:bg-[#00c2cc] transition-all">
              Connect
            </button>
            <button onClick={() => { setMode('login'); }} className="w-full py-2 text-zinc-600 hover:text-zinc-400 text-[10px] font-mono uppercase tracking-widest transition-colors">
              Skip — Use Without Account
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2 bg-[#050505] border border-zinc-800 rounded px-3 py-2">
                <Mail size={14} className="text-zinc-600 shrink-0" />
                <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="email@example.com" className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono" onKeyDown={e => e.key === 'Enter' && handleAuth()} />
              </div>
              <div className="flex items-center gap-2 bg-[#050505] border border-zinc-800 rounded px-3 py-2">
                <Key size={14} className="text-zinc-600 shrink-0" />
                <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="password" className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono" onKeyDown={e => e.key === 'Enter' && handleAuth()} />
              </div>
            </div>

            <button onClick={handleAuth} disabled={loading} className="w-full py-2.5 bg-[#00f3ff] text-black font-bold rounded text-xs font-mono uppercase tracking-widest hover:bg-[#00c2cc] transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {loading ? <Loader2 size={14} className="animate-spin" /> : mode === 'login' ? <LogIn size={14} /> : <UserPlus size={14} />}
              {mode === 'login' ? 'Sign In' : 'Create Account'}
            </button>

            {isSupabaseConfigured() && (
              <div className="flex items-center gap-2">
                <div className="flex-1 h-[1px] bg-zinc-800"></div>
                <span className="text-[10px] text-zinc-600 font-mono uppercase">or</span>
                <div className="flex-1 h-[1px] bg-zinc-800"></div>
              </div>
            )}

            {isSupabaseConfigured() && (
              <div className="flex gap-2">
                <button onClick={() => handleOAuth('google')} disabled={loading} className="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                  <Mail size={14} /> Google
                </button>
                <button onClick={() => handleOAuth('github')} disabled={loading} className="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                  <Github size={14} /> GitHub
                </button>
              </div>
            )}

            <div className="flex items-center justify-between">
              <button onClick={() => setMode(mode === 'login' ? 'signup' : 'login')} className="text-[10px] text-zinc-500 hover:text-[#00f3ff] font-mono uppercase tracking-widest transition-colors">
                {mode === 'login' ? 'Create Account' : 'Already have an account?'}
              </button>
              {isSupabaseConfigured() && (
                <button onClick={() => setMode('setup')} className="text-[10px] text-zinc-600 hover:text-zinc-400 font-mono uppercase tracking-widest transition-colors">
                  DB Settings
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
