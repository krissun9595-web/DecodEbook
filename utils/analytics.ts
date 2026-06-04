
import { getSupabase } from '../services/supabase';

let sessionId: string | null = null;

function detectDevice(): { deviceType: string; os: string; browser: string } {
  const ua = navigator.userAgent;
  const width = window.innerWidth;

  let deviceType = 'desktop';
  if (width < 768 || /Mobi|Android/i.test(ua)) deviceType = 'mobile';
  else if (width < 1024 || /iPad|Tablet/i.test(ua)) deviceType = 'tablet';

  let os = 'unknown';
  if (/iPhone|iPad|iPod/.test(ua)) os = 'ios';
  else if (/Android/.test(ua)) os = 'android';
  else if (/Mac/.test(ua)) os = 'macos';
  else if (/Win/.test(ua)) os = 'windows';
  else if (/Linux/.test(ua)) os = 'linux';

  let browser = 'unknown';
  if (/CriOS|Chrome/.test(ua) && !/Edge/.test(ua)) browser = 'chrome';
  else if (/Safari/.test(ua) && !/Chrome/.test(ua)) browser = 'safari';
  else if (/Firefox/.test(ua)) browser = 'firefox';
  else if (/Edg/.test(ua)) browser = 'edge';

  return { deviceType, os, browser };
}

export async function startSession(): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { deviceType, os, browser } = detectDevice();
    const isPwa = window.matchMedia('(display-mode: standalone)').matches;
    const { data, error } = await sb.rpc('start_session', {
      p_device_type: deviceType,
      p_os: os,
      p_browser: browser,
      p_screen_width: window.screen.width,
      p_screen_height: window.screen.height,
      p_referrer: document.referrer || null,
      p_is_pwa: isPwa,
    });
    if (error) { console.warn('[analytics] start_session failed:', error.message); return null; }
    sessionId = data;
    return sessionId;
  } catch { return null; }
}

export async function endSession() {
  if (!sessionId) return;
  const sb = getSupabase();
  if (!sb) return;
  try { await sb.rpc('end_session', { p_session_id: sessionId }); } catch {}
}

export function trackEvent(
  eventType: string,
  eventAction: string,
  metadata: Record<string, any> = {},
  bookId?: string,
  chapterIndex?: number,
) {
  const sb = getSupabase();
  if (!sb || !sessionId) return;
  sb.rpc('track_event', {
    p_session_id: sessionId,
    p_event_type: eventType,
    p_event_action: eventAction,
    p_book_id: bookId || null,
    p_chapter_index: chapterIndex ?? null,
    p_metadata: metadata,
  }).then(({ error }) => {
    if (error) console.warn('[analytics] track_event failed:', error.message);
  });
}

export function trackGeneration(params: {
  bookId: string;
  chapterIndex: number;
  module: string;
  provider?: string;
  model?: string;
  inputChars?: number;
  outputDurationMs?: number;
  estimatedCost?: number;
  status?: string;
  errorMessage?: string;
}) {
  const sb = getSupabase();
  if (!sb) return;
  sb.rpc('track_generation', {
    p_book_id: params.bookId,
    p_chapter_index: params.chapterIndex,
    p_module: params.module,
    p_provider: params.provider || null,
    p_model: params.model || null,
    p_input_chars: params.inputChars || null,
    p_output_duration_ms: params.outputDurationMs || null,
    p_estimated_cost: params.estimatedCost || null,
    p_status: params.status || 'success',
    p_error_message: params.errorMessage || null,
  }).then(({ error }) => {
    if (error) console.warn('[analytics] track_generation failed:', error.message);
  });
}

// Convenience helpers

export function trackAuth(action: string, metadata: Record<string, any> = {}) {
  trackEvent('auth', action, metadata);
}

export function trackBookAction(action: string, metadata: Record<string, any> = {}, bookId?: string) {
  trackEvent('book', action, metadata, bookId);
}

export function trackNavigation(action: string, metadata: Record<string, any> = {}) {
  trackEvent('navigation', action, metadata);
}

export function trackShare(action: string, metadata: Record<string, any> = {}) {
  trackEvent('share', action, metadata);
}

export function trackPlayback(action: string, metadata: Record<string, any> = {}, bookId?: string, chapterIndex?: number) {
  trackEvent('playback', action, metadata, bookId, chapterIndex);
}

export function trackNotebook(action: string, metadata: Record<string, any> = {}) {
  trackEvent('notebook', action, metadata);
}

export function trackError(action: string, metadata: Record<string, any> = {}, bookId?: string) {
  trackEvent('error', action, metadata, bookId);
}

// End session on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') endSession();
  });
}
