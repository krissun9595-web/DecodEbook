
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

  const modeTitle = { login: 'SIGN_IN', signup: 'SIGN_UP', forgot: 'RESET_PASSWORD' };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="bg-[#0a0a0c] border border-zinc-800 rounded-lg w-full max-w-md p-6 relative shadow-2xl" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-zinc-600 hover:text-white transition-colors"><X size={18} /></button>

        <div className="flex items-center gap-2 mb-6">
          <Shield size={18} className="text-[#00f3ff]" />
          <h2 className="text-sm font-bold text-white font-mono uppercase tracking-widest">
            {user ? 'ACCOUNT' : modeTitle[mode]}
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
                <div className="flex gap-2">
                  <button onClick={() => handleOAuth('google')} disabled={loading} className="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <Mail size={14} /> Google
                  </button>
                  <button onClick={() => handleOAuth('github')} disabled={loading} className="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <Github size={14} /> GitHub
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

  const handleOAuth = async (provider: 'google' | 'github') => {
    setLoading(true); setError('');
    try { await signInWithOAuth(provider); }
    catch (e: any) { setError(e.message || 'OAuth failed'); setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-[#020202]">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(0,243,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,243,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none"></div>

      <div className="w-full max-w-sm p-8 relative z-10">
        <div className="text-center mb-8">
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
                <div className="flex gap-2">
                  <button onClick={() => handleOAuth('google')} disabled={loading} className="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <Mail size={14} /> Google
                  </button>
                  <button onClick={() => handleOAuth('github')} disabled={loading} className="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded text-xs font-mono uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                    <Github size={14} /> GitHub
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
