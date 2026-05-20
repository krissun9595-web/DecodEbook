
import React, { useState } from 'react';
import { X, LogIn, UserPlus, Github, Mail, Key, Loader2, Eye, EyeOff, Shield } from 'lucide-react';
import {
  signIn, signUp, signInWithOAuth, signOut, resetPassword,
  isSupabaseConfigured
} from '../services/supabase';
import type { User } from '@supabase/supabase-js';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  onAuthChange: (user: User | null) => void;
}

export const AuthModal: React.FC<Props> = ({ isOpen, onClose, user, onAuthChange }) => {
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  if (!isOpen) return null;

  const handleAuth = async () => {
    if (!email || !password) {
      setError('Email and password required');
      return;
    }
    if (mode === 'signup' && !agreedToTerms) {
      setError('You must agree to the Terms of Service and Privacy Policy');
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

  const handleForgotPassword = async () => {
    if (!email) {
      setError('Enter your email address first');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await resetPassword(email);
      setSuccess('Password reset email sent! Check your inbox.');
    } catch (e: any) {
      setError(e.message || 'Failed to send reset email');
    } finally {
      setLoading(false);
    }
  };

  const handleOAuth = async (provider: 'google' | 'github' | 'x' | 'discord') => {
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

  const modeTitle = { login: 'SIGN_IN', signup: 'SIGN_UP', forgot: 'RESET_PASSWORD' };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="bg-[#0a0a0c] border border-zinc-800 rounded-lg w-full max-w-md p-6 relative shadow-2xl" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-zinc-600 hover:text-white transition-colors"><X size={18} /></button>

        <div className="flex items-center gap-2 mb-6">
          <Shield size={18} className="text-[#00f3ff]" />
          <h2 className="text-sm font-bold text-white font-mono uppercase tracking-widest">
            {user ? 'MY_ACCOUNT' : modeTitle[mode]}
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
        ) : mode === 'forgot' ? (
          <div className="space-y-4">
            <p className="text-xs text-zinc-500 font-mono leading-relaxed">
              Enter your email address and we'll send you a link to reset your password.
            </p>
            <div className="flex items-center gap-2 bg-[#050505] border border-zinc-800 rounded px-3 py-2">
              <Mail size={14} className="text-zinc-600 shrink-0" />
              <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="email@example.com" className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono" onKeyDown={e => e.key === 'Enter' && handleForgotPassword()} />
            </div>
            <button onClick={handleForgotPassword} disabled={loading} className="w-full py-2.5 bg-[#00f3ff] text-black font-bold rounded text-xs font-mono uppercase tracking-widest hover:bg-[#00c2cc] transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {loading && <Loader2 size={14} className="animate-spin" />}
              Send Reset Link
            </button>
            <button onClick={() => { setMode('login'); setError(''); setSuccess(''); }} className="w-full py-2 text-zinc-500 hover:text-[#00f3ff] text-[10px] font-mono uppercase tracking-widest transition-colors">
              Back to Sign In
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
                <input
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  type={showPassword ? 'text' : 'password'}
                  placeholder="password"
                  className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono"
                  onKeyDown={e => e.key === 'Enter' && handleAuth()}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="text-zinc-600 hover:text-zinc-400 transition-colors shrink-0"
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {mode === 'login' && (
              <div className="flex justify-end">
                <button onClick={() => { setMode('forgot'); setError(''); setSuccess(''); }} className="text-[10px] text-zinc-500 hover:text-[#00f3ff] font-mono uppercase tracking-widest transition-colors">
                  Forgot Password?
                </button>
              </div>
            )}

            {mode === 'signup' && (
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreedToTerms}
                  onChange={e => setAgreedToTerms(e.target.checked)}
                  className="mt-0.5 accent-[#00f3ff]"
                />
                <span className="text-[10px] text-zinc-500 font-mono leading-relaxed">
                  I agree to the{' '}
                  <a href="/terms" target="_blank" className="text-[#00f3ff] hover:underline">Terms of Service</a>
                  {' '}and{' '}
                  <a href="/privacy" target="_blank" className="text-[#00f3ff] hover:underline">Privacy Policy</a>
                </span>
              </label>
            )}

            <button onClick={handleAuth} disabled={loading || (mode === 'signup' && !agreedToTerms)} className="w-full py-2.5 bg-[#00f3ff] text-black font-bold rounded text-xs font-mono uppercase tracking-widest hover:bg-[#00c2cc] transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {loading ? <Loader2 size={14} className="animate-spin" /> : mode === 'login' ? <LogIn size={14} /> : <UserPlus size={14} />}
              {mode === 'login' ? 'Sign In' : 'Create Account'}
            </button>

            {isSupabaseConfigured() && (
              <>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-[1px] bg-zinc-800"></div>
                  <span className="text-[10px] text-zinc-600 font-mono uppercase">or</span>
                  <div className="flex-1 h-[1px] bg-zinc-800"></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => handleOAuth('google')} disabled={loading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Google
                  </button>
                  <button onClick={() => handleOAuth('github')} disabled={loading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <Github size={14} /> GitHub
                  </button>
                  <button onClick={() => handleOAuth('x')} disabled={loading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg> X
                  </button>
                  <button onClick={() => handleOAuth('discord')} disabled={loading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg> Discord
                  </button>
                </div>
              </>
            )}

            <div className="flex items-center justify-center">
              <button onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setSuccess(''); setAgreedToTerms(false); }} className="text-[10px] text-zinc-500 hover:text-[#00f3ff] font-mono uppercase tracking-widest transition-colors">
                {mode === 'login' ? 'Create Account' : 'Already have an account?'}
              </button>
            </div>

            {mode === 'login' && (
              <p className="text-[9px] text-zinc-700 font-mono text-center leading-relaxed">
                By signing in, you agree to our{' '}
                <a href="/terms" target="_blank" className="text-zinc-500 hover:text-[#00f3ff] underline">Terms of Service</a>
                {' '}and{' '}
                <a href="/privacy" target="_blank" className="text-zinc-500 hover:text-[#00f3ff] underline">Privacy Policy</a>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// Full-page auth gate — shown before the app when not logged in
interface AuthGateProps {
  onAuthChange: (user: User | null) => void;
  onSkip: () => void;
}

export const AuthGate: React.FC<AuthGateProps> = ({ onAuthChange, onSkip }) => {
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleAuth = async () => {
    if (!email || !password) { setError('Email and password required'); return; }
    if (mode === 'signup' && !agreedToTerms) { setError('You must agree to the Terms of Service and Privacy Policy'); return; }
    setLoading(true); setError('');
    try {
      if (mode === 'signup') {
        await signUp(email, password);
        setSuccess('Account created! Check your email to confirm.');
      } else {
        const data = await signIn(email, password);
        onAuthChange(data.user);
      }
    } catch (e: any) { setError(e.message || 'Authentication failed'); }
    finally { setLoading(false); }
  };

  const handleForgotPassword = async () => {
    if (!email) { setError('Enter your email address first'); return; }
    setLoading(true); setError('');
    try { await resetPassword(email); setSuccess('Password reset email sent! Check your inbox.'); }
    catch (e: any) { setError(e.message || 'Failed to send reset email'); }
    finally { setLoading(false); }
  };

  const handleOAuth = async (provider: 'google' | 'github' | 'x' | 'discord') => {
    setLoading(true); setError('');
    try { await signInWithOAuth(provider); }
    catch (e: any) { setError(e.message || 'OAuth failed'); setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-[#020202]">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(0,243,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,243,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none"></div>

      <div className="w-full max-w-sm p-8 relative z-10">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="relative w-16 h-16 flex items-center justify-center">
              <div className="absolute inset-0 border border-[#00f3ff]/30 rounded-lg rotate-3"></div>
              <div className="absolute inset-0 border border-[#00f3ff]/10 rounded-lg -rotate-3"></div>
              <svg viewBox="0 0 64 64" width="40" height="40" className="relative z-10">
                <rect x="16" y="8" width="32" height="48" rx="2" fill="none" stroke="#00f3ff" strokeWidth="1.5"/>
                <rect x="20" y="8" width="28" height="48" rx="2" fill="none" stroke="#00f3ff" strokeWidth="1.5"/>
                <line x1="24" y1="20" x2="44" y2="20" stroke="#00f3ff" strokeWidth="1" opacity="0.6"/>
                <line x1="24" y1="26" x2="40" y2="26" stroke="#00f3ff" strokeWidth="1" opacity="0.4"/>
                <line x1="24" y1="32" x2="42" y2="32" stroke="#00f3ff" strokeWidth="1" opacity="0.6"/>
                <line x1="24" y1="38" x2="38" y2="38" stroke="#00f3ff" strokeWidth="1" opacity="0.4"/>
                <line x1="24" y1="44" x2="41" y2="44" stroke="#00f3ff" strokeWidth="1" opacity="0.3"/>
                <circle cx="42" cy="44" r="6" fill="#020202" stroke="#00f3ff" strokeWidth="1.5"/>
                <line x1="42" y1="40" x2="42" y2="48" stroke="#00f3ff" strokeWidth="1" opacity="0.8"/>
                <line x1="38" y1="44" x2="46" y2="44" stroke="#00f3ff" strokeWidth="1" opacity="0.8"/>
              </svg>
              <div className="absolute inset-0 rounded-lg shadow-[0_0_20px_rgba(0,243,255,0.15)]"></div>
            </div>
          </div>
          <h1 className="text-2xl font-black text-white font-mono uppercase tracking-[0.3em] mb-2">DecodEbook</h1>
          <p className="text-[10px] text-zinc-600 font-mono uppercase tracking-widest">AI-Powered Reading Interface</p>
        </div>

        {error && <div className="mb-4 p-2 bg-rose-950/30 border border-rose-900/50 rounded text-xs text-rose-400 font-mono">{error}</div>}
        {success && <div className="mb-4 p-2 bg-emerald-950/30 border border-emerald-900/50 rounded text-xs text-emerald-400 font-mono">{success}</div>}

        {mode === 'forgot' ? (
          <div className="space-y-4">
            <p className="text-xs text-zinc-500 font-mono leading-relaxed text-center">
              Enter your email to receive a password reset link.
            </p>
            <div className="flex items-center gap-2 bg-[#050505] border border-zinc-800 rounded px-3 py-2.5">
              <Mail size={14} className="text-zinc-600 shrink-0" />
              <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="email@example.com" className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono" onKeyDown={e => e.key === 'Enter' && handleForgotPassword()} />
            </div>
            <button onClick={handleForgotPassword} disabled={loading} className="w-full py-2.5 bg-[#00f3ff] text-black font-bold rounded text-xs font-mono uppercase tracking-widest hover:bg-[#00c2cc] transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {loading && <Loader2 size={14} className="animate-spin" />}
              Send Reset Link
            </button>
            <button onClick={() => { setMode('login'); setError(''); setSuccess(''); }} className="w-full py-2 text-zinc-500 hover:text-[#00f3ff] text-[10px] font-mono uppercase tracking-widest transition-colors">
              Back to Sign In
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2 bg-[#050505] border border-zinc-800 rounded px-3 py-2.5">
                <Mail size={14} className="text-zinc-600 shrink-0" />
                <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="email@example.com" className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono" onKeyDown={e => e.key === 'Enter' && handleAuth()} />
              </div>
              <div className="flex items-center gap-2 bg-[#050505] border border-zinc-800 rounded px-3 py-2.5">
                <Key size={14} className="text-zinc-600 shrink-0" />
                <input
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  type={showPassword ? 'text' : 'password'}
                  placeholder="password"
                  className="bg-transparent text-xs text-zinc-300 outline-none w-full font-mono"
                  onKeyDown={e => e.key === 'Enter' && handleAuth()}
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="text-zinc-600 hover:text-zinc-400 transition-colors shrink-0">
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {mode === 'login' && (
              <div className="flex justify-end">
                <button onClick={() => { setMode('forgot'); setError(''); setSuccess(''); }} className="text-[10px] text-zinc-500 hover:text-[#00f3ff] font-mono uppercase tracking-widest transition-colors">
                  Forgot Password?
                </button>
              </div>
            )}

            {mode === 'signup' && (
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" checked={agreedToTerms} onChange={e => setAgreedToTerms(e.target.checked)} className="mt-0.5 accent-[#00f3ff]" />
                <span className="text-[10px] text-zinc-500 font-mono leading-relaxed">
                  I agree to the{' '}
                  <a href="/terms" target="_blank" className="text-[#00f3ff] hover:underline">Terms of Service</a>
                  {' '}and{' '}
                  <a href="/privacy" target="_blank" className="text-[#00f3ff] hover:underline">Privacy Policy</a>
                </span>
              </label>
            )}

            <button onClick={handleAuth} disabled={loading || (mode === 'signup' && !agreedToTerms)} className="w-full py-2.5 bg-[#00f3ff] text-black font-bold rounded text-xs font-mono uppercase tracking-widest hover:bg-[#00c2cc] transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {loading ? <Loader2 size={14} className="animate-spin" /> : mode === 'login' ? <LogIn size={14} /> : <UserPlus size={14} />}
              {mode === 'login' ? 'Sign In' : 'Create Account'}
            </button>

            {isSupabaseConfigured() && (
              <>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-[1px] bg-zinc-800"></div>
                  <span className="text-[10px] text-zinc-600 font-mono uppercase">or</span>
                  <div className="flex-1 h-[1px] bg-zinc-800"></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => handleOAuth('google')} disabled={loading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Google
                  </button>
                  <button onClick={() => handleOAuth('github')} disabled={loading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <Github size={14} /> GitHub
                  </button>
                  <button onClick={() => handleOAuth('x')} disabled={loading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg> X
                  </button>
                  <button onClick={() => handleOAuth('discord')} disabled={loading} className="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg> Discord
                  </button>
                </div>
              </>
            )}

            <div className="flex items-center justify-center">
              <button onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setSuccess(''); setAgreedToTerms(false); }} className="text-[10px] text-zinc-500 hover:text-[#00f3ff] font-mono uppercase tracking-widest transition-colors">
                {mode === 'login' ? 'Create Account' : 'Already have an account?'}
              </button>
            </div>

            <button onClick={onSkip} className="w-full py-2 text-zinc-700 hover:text-zinc-500 text-[10px] font-mono uppercase tracking-widest transition-colors">
              Continue Without Account
            </button>

            <p className="text-[9px] text-zinc-700 font-mono text-center leading-relaxed">
              By continuing, you agree to our{' '}
              <a href="/terms" target="_blank" className="text-zinc-500 hover:text-[#00f3ff] underline">Terms of Service</a>
              {' '}and{' '}
              <a href="/privacy" target="_blank" className="text-zinc-500 hover:text-[#00f3ff] underline">Privacy Policy</a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
