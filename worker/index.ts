import { gateCost, creditsForAction, costCentsForAction } from '../services/pricing';

interface Env {
  GEMINI_API_KEY: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  DEEPSEEK_API_KEY: string;
  BYTEPLUS_API_KEY: string;
  FAL_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRO_PRICE_ID: string;
  STRIPE_PRO_ANNUAL_PRICE_ID: string;
  STRIPE_PACK_S_PRICE_ID: string;
  STRIPE_PACK_M_PRICE_ID: string;
  STRIPE_PACK_L_PRICE_ID: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ASSETS: { fetch: typeof fetch };
  // Per-user generation rate limiter (KV). Optional: absent until the namespace is provisioned,
  // in which case checkRateLimit() no-ops (safe). Bind in wrangler as `RATE_LIMIT`.
  RATE_LIMIT?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  };
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const BYTEPLUS_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

const TIER_CREDITS: Record<string, number> = {
  free: 100, pro: 1000,
};

// Credit gate costs come from the shared GATE_COSTS in services/pricing.ts (via
// gateCost) — one calibrated source for the worker gate AND the client pre-check,
// so they can't drift. (The old hardcoded table here under-gated media/measured
// actions by 3–12x, letting low-balance users start unaffordable generations.)

const PACK_CREDITS: Record<string, number> = { S: 1000, M: 2500, L: 4000 };

// --- SSRF guards for the two user-supplied-URL download proxies ---
// A logged-in user controls the download URL, so we must restrict where the worker will fetch —
// critically for handleVideoDownload, which attaches GEMINI_API_KEY (an unrestricted fetch there
// leaks the key to any host the attacker names).
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;            // loopback / RFC1918 / link-local
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;                          // 172.16–31.x
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true; // IPv6 private
  return false;
}
// Returns a validated URL (https, non-internal, and — when `allow` is given — host must match an
// allowlisted suffix) or null. Callers MUST treat null as "refuse to fetch".
function safeFetchUrl(raw: string, allow?: string[]): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    if (isPrivateHost(u.hostname)) return null;
    if (allow) {
      const h = u.hostname.toLowerCase();
      if (!allow.some(s => h === s || h.endsWith('.' + s))) return null;
    }
    return u;
  } catch { return null; }
}

// Per-user rate limit on the generation routes. Caps runaway abuse (scripted loops burning our
// provider budget) regardless of client-side metering. Generous enough that no human hits it.
const RATE_LIMIT_MAX = 100;     // generation requests
const RATE_LIMIT_WINDOW = 60;   // ...per this many seconds, per user
async function checkRateLimit(userId: string, env: Env): Promise<Response | null> {
  if (!env.RATE_LIMIT || !userId) return null;   // no-op until the KV namespace is bound
  try {
    const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW);
    const key = `rl:${userId}:${bucket}`;
    const cur = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
    if (cur >= RATE_LIMIT_MAX) {
      console.warn('[429] per-user rate-limit hit', 'user=' + userId, 'count=' + cur);
      return new Response(JSON.stringify({ error: 'Too many requests — please slow down and try again shortly.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(RATE_LIMIT_WINDOW), 'Access-Control-Allow-Origin': '*' },
      });
    }
    // KV isn't atomic; a small overshoot during a burst is acceptable for an abuse cap.
    await env.RATE_LIMIT.put(key, String(cur + 1), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
    return null;
  } catch { return null; }   // a limiter failure must never break a legitimate request
}

// Constant-time hex-string compare (for the Stripe webhook signature — avoids leaking bytes via timing).
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil: (p: Promise<any>) => void }): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-goog-api-key, Authorization, X-Db-Action, X-Db-Model, X-Db-Book, X-Db-Session, X-Db-Usage-Id, X-Db-Chars, X-Db-Cjk, X-Db-Seconds, X-Db-Images',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (url.pathname === '/api/config') {
      return new Response(JSON.stringify({
        supabaseUrl: env.SUPABASE_URL || '',
        supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
        stripeProPriceId: env.STRIPE_PRO_PRICE_ID || '',
        stripeProAnnualPriceId: env.STRIPE_PRO_ANNUAL_PRICE_ID || '',
        stripePackSPriceId: env.STRIPE_PACK_S_PRICE_ID || '',
        stripePackMPriceId: env.STRIPE_PACK_M_PRICE_ID || '',
        stripePackLPriceId: env.STRIPE_PACK_L_PRICE_ID || '',
        country: (request as any).cf?.country || null, // Cloudflare geo-IP, for model routing
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // --- Stripe routes (webhook has no auth) ---
    if (url.pathname === '/api/stripe/webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }
    if (url.pathname === '/api/stripe/checkout' && request.method === 'POST') {
      return handleStripeCheckout(request, env);
    }
    if (url.pathname === '/api/stripe/portal' && request.method === 'POST') {
      return handleStripePortal(request, env);
    }
    if (url.pathname === '/api/stripe/pack-checkout' && request.method === 'POST') {
      return handlePackCheckout(request, env);
    }
    if (url.pathname === '/api/user/tier') {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      return handleGetTier(auth.userId, env);
    }
    if (url.pathname === '/api/account/delete' && request.method === 'POST') {
      return handleDeleteAccount(request, env);
    }

    // --- Referral routes ---
    if (url.pathname === '/api/ref/code') {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      return handleGetReferralCode(auth.userId, env);
    }
    if (url.pathname === '/api/ref/stats') {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      return handleGetReferralStats(auth.userId, env);
    }
    if (url.pathname === '/api/ref/track' && request.method === 'POST') {
      return handleTrackClick(request, env);
    }
    if (url.pathname === '/api/ref/signup' && request.method === 'POST') {
      return handleReferralSignup(request, env);
    }

    // --- AI routes (auth + credit check) ---
    if (url.pathname === '/api/llm/generate') {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      const rl = await checkRateLimit(auth.userId, env);
      if (rl) return rl;
      const body = await request.clone().json() as any;
      const creditAction = body.creditAction || 'translate';
      const check = await checkCreditBalance(auth.userId, creditAction, env);
      if (check) return check;
      const resp = await handleUnifiedLLM(request, env);
      // Phase-A metering for the non-Gemini text path (e.g. Balanced translate → deepseek). Read the
      // real tokens from the clone's raw.usage; stream the original untouched.
      const lm = usageMetaFromHeaders(request);
      if (resp.ok && lm.usageId && ctx) {
        ctx.waitUntil((async () => {
          try {
            const d = await resp.clone().json();
            const u = d?.raw?.usage || {};
            await recordUsage(env, auth.userId, {
              action: lm.action || creditAction, model: lm.model || body.model || '',
              book: lm.book, session: lm.session, usageId: lm.usageId,
              inTok: u.prompt_tokens || 0, outTok: u.completion_tokens || 0,
            });
          } catch {}
        })());
      }
      return resp;
    }

    if (url.pathname === '/api/fal/image') {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      const rl = await checkRateLimit(auth.userId, env);
      if (rl) return rl;
      const check = await reserveMedia(auth.userId, 'generateImage', env, request);
      if (check) return check;
      const resp = await handleFalImage(request, env, auth.userId, ctx);
      releaseReservation(env, request, ctx);
      return resp;
    }

    if (url.pathname === '/api/seedance/generate') {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      const rl = await checkRateLimit(auth.userId, env);
      if (rl) return rl;
      const body = await request.clone().json() as any;
      const isFast = (body.model || '').includes('fast');
      const check = await checkCreditBalance(auth.userId, isFast ? 'videoSeedanceFast' : 'videoSeedance', env, request);
      if (check) return check;
      return handleSeedanceGenerate(request, env);
    }

    if (url.pathname === '/api/seedance/poll') {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      return handleSeedancePoll(request, env, auth.userId, ctx);
    }

    if (url.pathname === '/api/seedance/download') {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      return handleSeedanceDownload(request, env, auth.userId, ctx);
    }

    if (url.pathname.startsWith('/api/gemini/')) {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      // This proxy carries the highest-volume path (Gemini text generateContent, which has no
      // per-call credit gate) plus TTS/Veo — so the rate limit here is the main worker-side cost cap.
      const rl = await checkRateLimit(auth.userId, env);
      if (rl) return rl;

      if (url.pathname.startsWith('/api/gemini/video-download')) {
        return handleVideoDownload(request, env, auth.userId, ctx);
      }
      // The @google/genai SDK routes TTS + Veo through this proxy (unlike text,
      // which uses /api/llm/generate). Credit-gate those two generation calls so
      // a 0-balance user can't synthesise audio or video. Polls/operations pass.
      // Image, TTS and Veo all come through this proxy. Detect the modality by the model in
      // the path (:generateContent carries the model name; :predictLongRunning is Veo) and
      // credit-gate each on its REAL cost. NOTE: image generation previously had NO gate here
      // — a premium image (any balance) ran ungated — this closes that hole.
      const p = url.pathname;
      let releaseHold = false;
      if (/:predictLongRunning/.test(p)) {
        // Veo is long-running (create → poll for minutes); a brief hold around create wouldn't
        // cover the charge window, so keep the (accurate) read check here.
        const check = await checkCreditBalance(auth.userId, 'videoVeo', env, request);
        if (check) return check;
      } else if (/:generateContent/.test(p)) {
        if (/image/i.test(p)) {
          const check = await reserveMedia(auth.userId, 'generateImage', env, request);
          if (check) return check;
          releaseHold = true;
        } else if (/tts/i.test(p)) {
          const check = await reserveMedia(auth.userId, 'tts', env, request);
          if (check) return check;
          releaseHold = true;
        }
      }
      const resp = await handleGeminiProxy(request, url, env, auth.userId, ctx);
      if (releaseHold) releaseReservation(env, request, ctx);
      return resp;
    }

    return env.ASSETS.fetch(request);
  },
};

async function verifyAuth(request: Request, env: Env): Promise<Response | null> {
  // Fail CLOSED: if we can't verify tokens (auth backend not configured), reject rather than
  // treat the request as authenticated. A misconfigured deploy must not open every route.
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return jsonError('Auth not configured', 503);

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonError('Authentication required', 401);
  }

  const token = authHeader.slice(7);
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': env.SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) return jsonError('Invalid or expired session', 401);
    return null;
  } catch {
    return jsonError('Auth verification failed', 500);
  }
}

function getProvider(model: string): 'gemini' | 'openai' | 'anthropic' | 'deepseek' {
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('deepseek')) return 'deepseek';
  return 'gemini';
}

async function handleUnifiedLLM(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as any;
  const model = body.model || 'gemini-3-flash-preview';
  const provider = getProvider(model);

  if (provider === 'openai') return callOpenAI(body, env);
  if (provider === 'anthropic') return callAnthropic(body, env);
  if (provider === 'deepseek') return callDeepSeek(body, env);
  return callGemini(body, env);
}

async function callGemini(body: any, env: Env): Promise<Response> {
  if (!env.GEMINI_API_KEY) return jsonError('Gemini API key not configured', 500);

  const model = body.model || 'gemini-3-flash-preview';
  const url = `${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const geminiBody: any = { contents: body.contents };
  if (body.systemInstruction) geminiBody.systemInstruction = body.systemInstruction;
  if (body.generationConfig) geminiBody.generationConfig = body.generationConfig;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiBody),
  });

  const data = await res.json() as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const usage = data.usageMetadata ? {
    total_tokens: (data.usageMetadata.promptTokenCount || 0) + (data.usageMetadata.candidatesTokenCount || 0),
  } : undefined;
  return jsonResponse({ text, usage, raw: data });
}

async function callOpenAI(body: any, env: Env): Promise<Response> {
  return callOpenAICompatible(body, env.OPENAI_API_KEY, 'https://api.openai.com/v1/chat/completions', 'OpenAI');
}

// DeepSeek uses the OpenAI-compatible Chat Completions API (models: deepseek-v4-flash,
// deepseek-v4-pro). Same request/response shape as OpenAI, different base URL + key.
async function callDeepSeek(body: any, env: Env): Promise<Response> {
  return callOpenAICompatible(body, env.DEEPSEEK_API_KEY, 'https://api.deepseek.com/v1/chat/completions', 'DeepSeek');
}

async function callOpenAICompatible(body: any, apiKey: string, endpoint: string, providerName: string): Promise<Response> {
  if (!apiKey) return jsonError(`${providerName} API key not configured`, 500);

  const messages: any[] = [];
  if (body.systemInstruction) {
    const sysText = typeof body.systemInstruction === 'string'
      ? body.systemInstruction
      : body.systemInstruction?.parts?.[0]?.text || '';
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  const contents = Array.isArray(body.contents) ? body.contents : [body.contents];
  for (const c of contents) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const parts = c.parts || [];
    const text = parts.map((p: any) => p.text || '').filter(Boolean).join('\n');
    if (text) messages.push({ role, content: text });
  }

  const reqBody: any = {
    model: body.model,
    messages,
  };
  if (body.generationConfig?.responseMimeType === 'application/json') {
    reqBody.response_format = { type: 'json_object' };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(reqBody),
  });

  const data = await res.json() as any;
  if (data.error) {
    if (res.status === 429) console.warn('[429] upstream provider quota/rate', 'provider=' + providerName, 'detail=' + JSON.stringify(data.error).slice(0, 200));
    return jsonError(data.error.message || `${providerName} error`, res.status);
  }
  const text = data.choices?.[0]?.message?.content || '';
  const usage = data.usage ? {
    total_tokens: data.usage.total_tokens || (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0),
  } : undefined;
  return jsonResponse({ text, usage, raw: data });
}

async function callAnthropic(body: any, env: Env): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) return jsonError('Anthropic API key not configured', 500);

  const messages: any[] = [];
  let system = '';
  if (body.systemInstruction) {
    system = typeof body.systemInstruction === 'string'
      ? body.systemInstruction
      : body.systemInstruction?.parts?.[0]?.text || '';
  }

  const contents = Array.isArray(body.contents) ? body.contents : [body.contents];
  for (const c of contents) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const parts = c.parts || [];
    const text = parts.map((p: any) => p.text || '').filter(Boolean).join('\n');
    if (text) messages.push({ role, content: text });
  }

  const anthropicBody: any = {
    model: body.model,
    max_tokens: 8192,
    messages,
  };
  if (system) anthropicBody.system = system;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicBody),
  });

  const data = await res.json() as any;
  if (data.error) return jsonError(data.error.message || 'Anthropic error', res.status);
  const text = data.content?.[0]?.text || '';
  const usage = data.usage ? {
    total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
  } : undefined;
  return jsonResponse({ text, usage, raw: data });
}

async function handleGeminiProxy(request: Request, url: URL, env: Env, userId?: string, ctx?: { waitUntil: (p: Promise<any>) => void }): Promise<Response> {
  if (!env.GEMINI_API_KEY) {
    return jsonError('API key not configured on server', 500);
  }

  const path = url.pathname.replace('/api/gemini', '');
  const targetUrl = new URL(`${GEMINI_BASE}${path}`);

  url.searchParams.forEach((v, k) => {
    if (k !== 'key') targetUrl.searchParams.set(k, v);
  });
  targetUrl.searchParams.set('key', env.GEMINI_API_KEY);

  const ALLOWED_HEADERS = ['content-type', 'accept', 'accept-encoding', 'accept-language', 'user-agent', 'x-goog-api-client'];
  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (ALLOWED_HEADERS.includes(k.toLowerCase())) headers.set(k, v);
  }

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  const meta = usageMetaFromHeaders(request);
  const model = meta.model || (path.match(/models\/([^:]+):/)?.[1] ?? 'unknown');
  let response: Response;
  try {
    response = await fetch(targetUrl.toString(), init);
  } catch (error) {
    console.error('[gemini] upstream fetch failed', JSON.stringify({
      user_id: userId || 'anonymous',
      action: meta.action || 'unknown',
      model,
      error: String(error instanceof Error ? error.message : error).slice(0, 500),
    }));
    throw error;
  }

  const resHeaders = new Headers(response.headers);
  resHeaders.set('Access-Control-Allow-Origin', '*');

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.clone().text()).replace(/\s+/g, ' ').slice(0, 500);
    } catch {}
    console.warn('[gemini] upstream non-ok', JSON.stringify({
      user_id: userId || 'anonymous',
      action: meta.action || 'unknown',
      model,
      status: response.status,
      detail,
    }));
  }

  // Phase-A metering: for a TEXT generateContent (not tts) carrying a client usage id, buffer the
  // (small JSON) response, read usageMetadata, and record the charge idempotently (deduped vs the
  // client). Everything else streams through unchanged — tts/veo/ops responses are large and priced
  // from the request, not the body — and with no usage id it's pure passthrough (no regression).
  const isGenerate = /:generateContent/.test(path);

  // Veo completion: the client polls the operation through this proxy with X-Db-Action=videoVeo.
  // CLONE the response to read `done` while the ORIGINAL body streams back UNTOUCHED (buffering +
  // re-returning it previously corrupted the SDK's operation parse → unplayable video). Meter once,
  // at completion (done=true); idempotent on usage_id handles repeated polls.
  if (response.ok && !isGenerate && meta.action === 'videoVeo' && meta.usageId && meta.model && userId && ctx) {
    const clone = response.clone();
    ctx.waitUntil((async () => {
      try {
        const d = await clone.json();
        if (d.done === true) {
          await recordUsage(env, userId, {
            action: 'videoVeo', model: meta.model, book: meta.book, session: meta.session,
            usageId: meta.usageId, seconds: meta.seconds,
          });
        }
      } catch {}
    })());
    // fall through — do NOT return a re-encoded body
  }

  // TTS + image generateContent return LARGE bodies and are priced from request units, not tokens —
  // meter them from headers without buffering. Only genuine TEXT generateContent gets buffered.
  const isMedia = isGenerate && (/tts/i.test(path) || /image/i.test(meta.model || '') || meta.action === 'generateImage' || meta.action === 'redrawFigureTranslated');
  const isText = isGenerate && !isMedia;
  if (response.ok && isText && meta.usageId && userId && ctx) {
    const buf = await response.arrayBuffer();
    ctx.waitUntil((async () => {
      try {
        const data = JSON.parse(new TextDecoder().decode(buf));
        const um = data.usageMetadata || {};
        await recordUsage(env, userId, {
          action: meta.action || 'translate',
          model: meta.model || (path.match(/models\/([^:]+):/)?.[1] ?? ''),
          book: meta.book, session: meta.session, usageId: meta.usageId,
          inTok: um.promptTokenCount || 0, outTok: um.candidatesTokenCount || 0,
          cachedTok: um.cachedContentTokenCount || 0, // implicit-cache hit slice → billed at 10%
        });
      } catch {}
    })());
    return new Response(buf, { status: response.status, statusText: response.statusText, headers: resHeaders });
  }

  if (response.ok && isMedia) {
    meterMediaFromHeaders(env, userId, request, ctx); // tts (chars) / image (images) from headers
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: resHeaders,
  });
}

async function handleVideoDownload(request: Request, env: Env, userId?: string, ctx?: { waitUntil: (p: Promise<any>) => void }): Promise<Response> {
  if (!env.GEMINI_API_KEY) {
    return jsonError('API key not configured on server', 500);
  }

  try {
    const { uri } = (await request.json()) as { uri: string };
    // Veo returns file URIs on *.googleapis.com. Only fetch (and only attach the API key) when the
    // target is an allowlisted Google host — otherwise the key would be handed to an attacker host.
    const safe = safeFetchUrl(uri, ['googleapis.com']);
    if (!safe) return jsonError('Invalid download URL', 400);
    const response = await fetch(safe.toString(), {
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
    });
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch {
    return jsonError('Invalid request', 400);
  }
}

// --- Auth helper that extracts user ID ---

async function getUserIdFromAuth(request: Request, env: Env): Promise<{ userId: string; email?: string } | Response> {
  // Fail CLOSED (see verifyAuth): no auth backend configured → reject, never return an empty userId.
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return jsonError('Auth not configured', 503);
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return jsonError('Authentication required', 401);
  const token = authHeader.slice(7);
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': env.SUPABASE_ANON_KEY },
    });
    if (!res.ok) return jsonError('Invalid or expired session', 401);
    const user = await res.json() as any;
    return { userId: user.id, email: user.email };
  } catch {
    return jsonError('Auth verification failed', 500);
  }
}

// --- Supabase admin fetch (service role, bypasses RLS) ---

function supabaseAdmin(env: Env, path: string, options: RequestInit = {}) {
  return fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Prefer': 'return=minimal',
      ...(options.headers || {}),
    },
  });
}

// --- Phase-A server-side metering (dual-write) ---
// The worker records the charge itself, idempotent on usage_id so it DEDUPES against the client's
// own write (ON CONFLICT DO NOTHING via the sql/022 unique index). It only engages when the client
// sends X-Db-Usage-Id, so older clients stay pure passthrough — no regression. Always fire-and-forget
// (ctx.waitUntil) and error-swallowing: metering must never block or fail a generation.
function usageMetaFromHeaders(request: Request) {
  const h = request.headers;
  const dec = (v: string | null) => { if (!v) return undefined; try { return decodeURIComponent(v); } catch { return v; } };
  const num = (v: string | null) => { const n = v ? parseInt(v, 10) : NaN; return Number.isFinite(n) ? n : undefined; };
  return {
    usageId: h.get('X-Db-Usage-Id') || undefined,
    action:  h.get('X-Db-Action') || undefined,
    model:   h.get('X-Db-Model') || undefined,
    book:    dec(h.get('X-Db-Book')),      // may contain non-ASCII → the client encodeURIComponent's it
    session: h.get('X-Db-Session') || undefined,
    // media billing units (text tokens come from the response instead)
    chars:    num(h.get('X-Db-Chars')),
    cjkChars: num(h.get('X-Db-Cjk')),
    seconds:  num(h.get('X-Db-Seconds')),
    images:   num(h.get('X-Db-Images')),
  };
}

// Record a MEDIA charge from client-provided header units (chars/seconds/images) — no need to buffer
// the large audio/video/image responses. Fire-and-forget; only engages when a usage id is present.
function meterMediaFromHeaders(env: Env, userId: string | undefined, request: Request, ctx?: { waitUntil: (p: Promise<any>) => void }, actionOverride?: string): void {
  const m = usageMetaFromHeaders(request);
  const action = actionOverride || m.action;
  if (!userId || !m.usageId || !action || !m.model || !ctx) return;
  ctx.waitUntil(recordUsage(env, userId, {
    action, model: m.model, book: m.book, session: m.session, usageId: m.usageId,
    chars: m.chars, cjkChars: m.cjkChars, seconds: m.seconds, images: m.images,
  }));
}

async function recordUsage(env: Env, userId: string, meta: {
  action: string; model: string; book?: string; session?: string; usageId: string;
  inTok?: number; outTok?: number; cachedTok?: number; chars?: number; cjkChars?: number; images?: number; seconds?: number;
}): Promise<void> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !userId || !meta.usageId || !meta.action || !meta.model) return;
  try {
    const units = {
      inTok: meta.inTok, outTok: meta.outTok, cachedTok: meta.cachedTok, chars: meta.chars, cjkChars: meta.cjkChars,
      images: meta.images, seconds: meta.seconds,
    };
    const credits = creditsForAction(meta.action, meta.model, units);
    const costCents = costCentsForAction(meta.action, meta.model, units);
    const row: any = {
      user_id: userId, action: meta.action, credits_cost: credits, cost_cents: costCents, model: meta.model,
      tokens_used: (meta.inTok || 0) + (meta.outTok || 0),
      input_tokens: meta.inTok || 0, output_tokens: meta.outTok || 0,
      usage_id: meta.usageId,
    };
    if (meta.book) row.book_title = meta.book;
    if (meta.session) row.session_id = meta.session;
    // Write the charge. ON CONFLICT (usage_id) DO NOTHING dedupes vs the client's own write. Crucially,
    // we LOG any failure (visible in `wrangler tail`) instead of swallowing it — a silent catch here is
    // how a prod schema gap (missing model/book_title/session_id column) leaked revenue undetected. And
    // we retry once WITHOUT the optional columns (session_id / book_title), mirroring the client's
    // fallback, so a schema missing one of those still records a correct charge rather than none.
    const post = (body: any) => supabaseAdmin(env, '/usage_logs', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(body),
    });
    let res = await post(row);
    if (!res.ok) {
      let detail = await res.text().catch(() => '');
      const { session_id, book_title, ...core } = row;
      if (session_id !== undefined || book_title !== undefined) {
        res = await post(core);
        if (!res.ok) detail = await res.text().catch(() => detail);
      }
      if (!res.ok) console.error('[meter] usage_logs insert failed', res.status, detail, 'action=' + meta.action, 'model=' + meta.model);
    }
  } catch (e) {
    console.error('[meter] usage_logs insert threw', String(e), 'action=' + meta.action);
  }
}

// --- Tier & quota ---

async function handleGetTier(userId: string, env: Env): Promise<Response> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return jsonResponse({ tier: 'free', credits_used: 0, pack_credits: 0, bonus_credits: 0, period_start: '', period_end: null, cancel_at_period_end: false });
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_user_credits`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_user_id: userId }),
  });
  if (!res.ok) return jsonResponse({ tier: 'free', credits_used: 0, pack_credits: 0, bonus_credits: 0, period_start: '', period_end: null, cancel_at_period_end: false });
  const data = await res.json() as any;

  // Referral activation now fires on free-trial / subscription start (Stripe webhook),
  // not on credit usage.

  return jsonResponse(data);
}

// Media actions whose real per-request cost is knowable up front (from the client's
// billing units in the request headers) — gate on the ACTUAL cost, not the flat floor,
// so a premium/batch generation can't start underfunded. These are also fail-CLOSED on a
// balance-lookup error (an expensive generation must not run un-verified).
const MEDIA_GATE_ACTIONS = new Set([
  'generateImage', 'redrawFigureTranslated',
  'videoSeedance', 'videoSeedanceFast', 'videoVeo',
  'tts', 'podcastAudio',
]);

async function checkCreditBalance(userId: string, action: string, env: Env, request?: Request): Promise<Response | null> {
  // Fail CLOSED on missing config (a deploy with no service-role key must not serve ungated).
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return jsonError('Billing not configured', 503);

  const isMedia = MEDIA_GATE_ACTIONS.has(action);
  // Gate cost = the REAL cost this request will incur. For media the units (images/seconds/
  // chars) + model are in the headers, so creditsForAction() gives the SAME number the charge
  // will (e.g. a premium image ≈ its true cost, not the flat 40 floor). Text tokens aren't
  // known until the response, so text keeps the calibrated flat floor.
  let cost = gateCost(action);
  if (isMedia && request) {
    const m = usageMetaFromHeaders(request);
    if (m.model) {
      const est = creditsForAction(action, m.model, { images: m.images, seconds: m.seconds, chars: m.chars, cjkChars: m.cjkChars });
      if (Number.isFinite(est) && est > 0) cost = est;
    }
  }

  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_user_credits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_user_id: userId }),
    });
    // Transient lookup failure: fail-OPEN for cheap text (don't block a paying reader during a
    // Supabase blip), but fail-CLOSED for expensive media (better to ask a retry than overspend).
    if (!res.ok) return isMedia ? jsonError('Could not verify your credit balance — please try again.', 503) : null;
    const data = await res.json() as any;
    const tier = data.tier || 'free';
    const monthlyCredits = TIER_CREDITS[tier] || TIER_CREDITS.free;
    if (monthlyCredits === Infinity) return null;
    const creditsUsed = data.credits_used || 0;
    const packCredits = data.pack_credits || 0;
    const bonusCredits = data.bonus_credits || 0;
    const available = Math.max(0, monthlyCredits - creditsUsed) + packCredits + bonusCredits;
    if (available < cost) {
      return new Response(JSON.stringify({
        error: 'Insufficient credits',
        credits_available: available,
        credits_required: cost,
        tier,
      }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }
    return null;
  } catch {
    return isMedia ? jsonError('Could not verify your credit balance — please try again.', 503) : null;
  }
}

// Exact media cost from the request's billing headers (same creditsForAction the charge uses).
function estimatedMediaCost(action: string, request: Request): number | null {
  if (!MEDIA_GATE_ACTIONS.has(action)) return null;
  const m = usageMetaFromHeaders(request);
  if (!m.model) return null;
  const est = creditsForAction(action, m.model, { images: m.images, seconds: m.seconds, chars: m.chars, cjkChars: m.cjkChars });
  return Number.isFinite(est) && est > 0 ? est : null;
}

// Atomic gate for a synchronous media action: hold the exact cost for the duration of
// the generation so two concurrent requests can't both pass on the same pre-charge balance.
// Returns a Response to short-circuit (429 insufficient / 503 can't-verify), or null once the
// hold is placed. Falls back to the read-only balance check if the reservation RPC isn't
// available yet (migration 033 not applied) — so the worker is safe to deploy either order.
async function reserveMedia(userId: string, action: string, env: Env, request: Request): Promise<Response | null> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return jsonError('Billing not configured', 503);
  const usageId = request.headers.get('X-Db-Usage-Id');
  const cost = estimatedMediaCost(action, request);
  if (!usageId || cost == null) return checkCreditBalance(userId, action, env, request);
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/reserve_credits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_user_id: userId, p_usage_id: usageId, p_credits: cost }),
    });
    if (!res.ok) return checkCreditBalance(userId, action, env, request); // RPC missing/blip → safe read check
    const data = await res.json() as any;
    if (data && data.ok === false) {
      return new Response(JSON.stringify({
        error: 'Insufficient credits',
        credits_available: data.available,
        credits_required: data.required,
        tier: data.tier,
      }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }
    return null; // held
  } catch {
    return checkCreditBalance(userId, action, env, request);
  }
}

// Release a hold once the generation returns (success or failure — the real charge, if any,
// lands in usage_logs separately). Best-effort, keyed on the request's usage id.
function releaseReservation(env: Env, request: Request, ctx?: ExecutionContext) {
  const usageId = request.headers.get('X-Db-Usage-Id');
  if (!usageId || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const p = fetch(`${env.SUPABASE_URL}/rest/v1/rpc/release_reservation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_usage_id: usageId }),
  }).then(() => {}).catch(() => {});
  if (ctx) ctx.waitUntil(p);
}

// --- Referral handlers ---
// NOTE: the referrer's 100-credit reward is granted server-side by a DB trigger
// (sql/019) when the referred user verifies their email AND spends enough free credits
// to prove a genuine trial — not on paid activation. See award_referral_on_engagement().

async function handleGetReferralCode(userId: string, env: Env): Promise<Response> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_or_create_referral_code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_user_id: userId }),
  });
  if (!res.ok) return jsonError('Failed to get referral code', 500);
  const code = await res.json();
  return jsonResponse({ code });
}

async function handleGetReferralStats(userId: string, env: Env): Promise<Response> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_referral_stats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_user_id: userId }),
  });
  if (!res.ok) return jsonError('Failed to get referral stats', 500);
  const stats = await res.json();
  return jsonResponse(stats);
}

async function handleTrackClick(request: Request, env: Env): Promise<Response> {
  const { code } = await request.json() as { code: string };
  if (!code || !/^[a-f0-9]{6,16}$/i.test(code)) return jsonError('Invalid referral code', 400);

  // Look up referrer by code
  const codeRes = await supabaseAdmin(env, `/referral_codes?code=eq.${encodeURIComponent(code)}&select=user_id`, {
    method: 'GET', headers: { 'Prefer': '' },
  });
  const codes = await codeRes.json() as any[];
  if (!codes?.length) return jsonError('Invalid referral code', 404);
  const referrerId = codes[0].user_id;

  // Record the click for STATS ONLY. Rewards are SIGNUP-ONLY now: the 100-credit reward is granted
  // (via the sql/019 trigger) when a referred user verifies their email AND actually uses their free
  // credits. Click-based credit was removed — raw-IP dedup made it farmable by IP rotation.
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(ip + referrerId));
  const visitorHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  await supabaseAdmin(env, '/referral_clicks', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=ignore-duplicates' },
    body: JSON.stringify({ referrer_id: referrerId, visitor_hash: visitorHash, credited: false }),
  });

  return jsonResponse({ ok: true, referrer_id: referrerId });
}

async function handleReferralSignup(request: Request, env: Env): Promise<Response> {
  const auth = await getUserIdFromAuth(request, env);
  if (auth instanceof Response) return auth;

  const { referrer_id } = await request.json() as { referrer_id: string };
  if (!referrer_id || referrer_id === auth.userId) return jsonError('Invalid referral', 400);

  // Validate the referrer is a REAL referral-code owner (not an arbitrary uuid the client invented,
  // which was the H7 ring-farming vector). Full click-match is stronger but the reward is already
  // gated on email-verify + real spend (sql/019); this stops targeting a stranger's account.
  const ownerRes = await supabaseAdmin(env, `/referral_codes?user_id=eq.${referrer_id}&select=user_id&limit=1`, {
    method: 'GET', headers: { 'Prefer': '' },
  });
  const owner = await ownerRes.json() as any[];
  if (!owner?.length) return jsonError('Invalid referral', 400);

  // Check not already referred
  const existRes = await supabaseAdmin(env, `/referral_signups?referred_user_id=eq.${auth.userId}&select=id`, {
    method: 'GET', headers: { 'Prefer': '' },
  });
  const existing = await existRes.json() as any[];
  if (existing?.length > 0) return jsonResponse({ ok: true, already: true });

  // Capture the referred user's signup IP (hashed) for abuse review — same-IP clusters
  // across a referrer's referrals flag likely self-farming.
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const ipHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);

  await supabaseAdmin(env, '/referral_signups', {
    method: 'POST',
    body: JSON.stringify({ referrer_id: referrer_id, referred_user_id: auth.userId, referred_ip_hash: ipHash }),
  });

  return jsonResponse({ ok: true });
}

// --- Stripe handlers ---

async function handleStripeCheckout(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return jsonError('Stripe not configured', 500);
  const auth = await getUserIdFromAuth(request, env);
  if (auth instanceof Response) return auth;
  const { userId } = auth;
  const { priceId } = await request.json() as { priceId: string };

  let stripeCustomerId: string | null = null;
  if (env.SUPABASE_SERVICE_ROLE_KEY) {
    const subRes = await supabaseAdmin(env, `/subscriptions?user_id=eq.${userId}&select=stripe_customer_id&limit=1`, {
      method: 'GET', headers: { 'Prefer': '' },
    });
    const subs = await subRes.json() as any[];
    if (subs?.length > 0) stripeCustomerId = subs[0].stripe_customer_id;
  }

  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': request.headers.get('Authorization')!, 'apikey': env.SUPABASE_ANON_KEY },
  });
  const userData = await userRes.json() as any;

  const params: Record<string, string> = {
    'mode': 'subscription',
    'success_url': `${new URL(request.url).origin}?checkout=success`,
    'cancel_url': new URL(request.url).origin,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'metadata[user_id]': userId,
    'subscription_data[metadata][user_id]': userId,
    'allow_promotion_codes': 'true',
  };
  if (stripeCustomerId) {
    params['customer'] = stripeCustomerId;
  } else {
    params['customer_email'] = userData.email;
  }

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(env.STRIPE_SECRET_KEY + ':')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const session = await stripeRes.json() as any;
  if (session.error) return jsonError(session.error.message, 400);
  return jsonResponse({ url: session.url });
}

async function handleStripePortal(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return jsonError('Stripe not configured', 500);
  const auth = await getUserIdFromAuth(request, env);
  if (auth instanceof Response) return auth;

  const subRes = await supabaseAdmin(env, `/subscriptions?user_id=eq.${auth.userId}&select=stripe_customer_id&limit=1`, {
    method: 'GET', headers: { 'Prefer': '' },
  });
  const subs = await subRes.json() as any[];
  if (!subs?.length || !subs[0].stripe_customer_id) return jsonError('No subscription found', 404);

  const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(env.STRIPE_SECRET_KEY + ':')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'customer': subs[0].stripe_customer_id,
      'return_url': new URL(request.url).origin,
    }).toString(),
  });
  const portal = await portalRes.json() as any;
  if (portal.error) return jsonError(portal.error.message, 400);
  return jsonResponse({ url: portal.url });
}

async function handlePackCheckout(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return jsonError('Stripe not configured', 500);
  const auth = await getUserIdFromAuth(request, env);
  if (auth instanceof Response) return auth;

  const subRes = await supabaseAdmin(env, `/subscriptions?user_id=eq.${auth.userId}&select=stripe_customer_id,tier&status=eq.active&limit=1`, {
    method: 'GET', headers: { 'Prefer': '' },
  });
  const subs = await subRes.json() as any[];
  if (!subs?.length) return jsonError('Pro subscription required to buy credit packs', 403);
  if (subs[0].tier !== 'pro') return jsonError('Credit packs are available for Pro subscribers only', 403);

  const { priceId } = await request.json() as { priceId: string };
  let packType = 'S';
  let credits = 1000;
  if (priceId === env.STRIPE_PACK_M_PRICE_ID) { packType = 'M'; credits = 2500; }
  else if (priceId === env.STRIPE_PACK_L_PRICE_ID) { packType = 'L'; credits = 4000; }

  const params: Record<string, string> = {
    'mode': 'payment',
    'success_url': `${new URL(request.url).origin}?pack=success`,
    'cancel_url': new URL(request.url).origin,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'metadata[user_id]': auth.userId,
    'metadata[pack_type]': packType,
    'metadata[credits]': String(credits),
  };
  // A pro account created outside Stripe checkout (e.g. a manually/test-granted Pro) has no
  // stripe_customer_id. Passing it as `customer` sends the literal string "null" → Stripe
  // "No such customer: 'null'". Only pass a real customer; otherwise seed the email so Stripe
  // creates/attaches one (the webhook still credits the pack via metadata[user_id] regardless).
  if (subs[0].stripe_customer_id) {
    params['customer'] = subs[0].stripe_customer_id;
  } else if (auth.email) {
    params['customer_email'] = auth.email;
  }

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(env.STRIPE_SECRET_KEY + ':')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const session = await stripeRes.json() as any;
  if (session.error) return jsonError(session.error.message, 400);
  return jsonResponse({ url: session.url });
}

// Permanently delete the signed-in user's account and all associated data (GDPR/CCPA erasure).
async function handleDeleteAccount(request: Request, env: Env): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return jsonError('Not configured', 503);
  const auth = await getUserIdFromAuth(request, env);
  if (auth instanceof Response) return auth;
  const uid = auth.userId;
  const svc = { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

  // 1) Delete rows in tables whose FK to auth.users has NO ON DELETE CASCADE — otherwise the auth
  //    admin-delete below fails on the constraint. (Cascading tables — profiles, subscriptions,
  //    generations, credit_ledger, user_books, user_notebook, user_reading_state, user_synced_files,
  //    plus sessions/events which SET NULL — are handled automatically when the auth user is deleted.)
  const nonCascade = [
    `/usage_logs?user_id=eq.${uid}`,
    `/user_settings?user_id=eq.${uid}`,
    `/bonus_credits?user_id=eq.${uid}`,
    `/credit_pack_purchases?user_id=eq.${uid}`,
    `/referral_clicks?referrer_id=eq.${uid}`,
    `/referral_signups?referrer_id=eq.${uid}`,
    `/referral_signups?referred_user_id=eq.${uid}`,
    `/referral_codes?user_id=eq.${uid}`,
  ];
  for (const path of nonCascade) {
    const r = await supabaseAdmin(env, path, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[account/delete] row delete failed', path, r.status, t);
      return jsonError('Failed to delete account data. Please contact support@decodebook.app.', 500);
    }
  }

  // 2) Best-effort: remove the user's private Storage folder ({uid}/ in the book-media bucket). Do not
  //    fail the whole deletion if storage cleanup is incomplete — log and continue. (Nested folders may
  //    need a recursive sweep; the personal data in the database is fully removed by steps 1 + 3.)
  try {
    const listRes = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/book-media`, {
      method: 'POST',
      headers: { ...svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: `${uid}/`, limit: 1000 }),
    });
    if (listRes.ok) {
      const objs = await listRes.json() as any[];
      const names = (objs || []).map(o => `${uid}/${o.name}`).filter(n => n && !n.endsWith('/'));
      if (names.length) {
        await fetch(`${env.SUPABASE_URL}/storage/v1/object/book-media`, {
          method: 'DELETE', headers: { ...svc, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: names }),
        }).catch(e => console.error('[account/delete] storage remove failed', e));
      }
    }
  } catch (e) { console.error('[account/delete] storage cleanup error', e); }

  // 3) Delete the auth user — cascades the remaining user tables.
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: svc });
  if (!res.ok && res.status !== 404) {
    const t = await res.text().catch(() => '');
    console.error('[account/delete] auth admin delete failed', res.status, t);
    return jsonError('Failed to delete account. Please contact support@decodebook.app.', 500);
  }
  return jsonResponse({ deleted: true });
}

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return jsonError('Stripe not configured', 500);
  const signature = request.headers.get('stripe-signature');
  if (!signature) return jsonError('Missing signature', 400);

  const body = await request.text();
  const valid = await verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return jsonError('Invalid signature', 400);

  const event = JSON.parse(body);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.user_id;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      if (session.mode === 'payment' && userId && session.metadata?.pack_type) {
        const credits = parseInt(session.metadata.credits, 10) || 0;
        const packType = session.metadata.pack_type;
        if (credits > 0) {
          // Idempotent: insert the purchase FIRST (stripe_session_id is UNIQUE). Only grant credits
          // when this insert actually created a row — so a replayed/redelivered webhook (same session)
          // gets a 409 and skips the grant, instead of double-crediting.
          const purRes = await supabaseAdmin(env, '/credit_pack_purchases', {
            method: 'POST',
            body: JSON.stringify({
              user_id: userId,
              stripe_session_id: session.id,
              pack_type: packType,
              credits,
              amount_cents: session.amount_total || 0,
            }),
          });
          if (purRes.ok) {
            await supabaseAdmin(env, '/rpc/add_pack_credits', {
              method: 'POST',
              body: JSON.stringify({ p_user_id: userId, p_credits: credits }),
            });
          }
        }
        break;
      }

      if (!userId || !subscriptionId) break;

      const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
        headers: { 'Authorization': `Basic ${btoa(env.STRIPE_SECRET_KEY + ':')}` },
      });
      const sub = await subRes.json() as any;
      const item = sub.items?.data?.[0];
      const priceId = item?.price?.id;
      const tier = mapPriceToTier(priceId, env);
      const periodStart = sub.current_period_start || item?.current_period_start || sub.start_date;
      const periodEnd = sub.current_period_end || item?.current_period_end;

      await supabaseAdmin(env, '/subscriptions', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          stripe_price_id: priceId,
          tier,
          status: sub.status,
          current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : new Date().toISOString(),
          current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
          cancel_at_period_end: sub.cancel_at_period_end || false,
          updated_at: new Date().toISOString(),
        }),
      });

      // Referral reward is handled by a DB trigger on engagement (sql/019), not here.
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const subItem = sub.items?.data?.[0];
      const priceId = subItem?.price?.id;
      const tier = event.type === 'customer.subscription.deleted' ? 'free' : mapPriceToTier(priceId, env);
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
      const pStart = sub.current_period_start || subItem?.current_period_start || sub.start_date;
      const pEnd = sub.current_period_end || subItem?.current_period_end;

      await supabaseAdmin(env, `/subscriptions?stripe_subscription_id=eq.${sub.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          tier, status, stripe_price_id: priceId,
          current_period_start: pStart ? new Date(pStart * 1000).toISOString() : new Date().toISOString(),
          current_period_end: pEnd ? new Date(pEnd * 1000).toISOString() : null,
          cancel_at_period_end: sub.cancel_at_period_end || false,
          updated_at: new Date().toISOString(),
        }),
      });
      break;
    }

    case 'invoice.payment_failed': {
      const subscriptionId = event.data.object.subscription;
      if (subscriptionId) {
        await supabaseAdmin(env, `/subscriptions?stripe_subscription_id=eq.${subscriptionId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'past_due', updated_at: new Date().toISOString() }),
        });
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const subscriptionId = event.data.object.subscription;
      if (subscriptionId) {
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
          headers: { 'Authorization': `Basic ${btoa(env.STRIPE_SECRET_KEY + ':')}` },
        });
        const sub = await subRes.json() as any;
        const invItem = sub.items?.data?.[0];
        const invStart = sub.current_period_start || invItem?.current_period_start || sub.start_date;
        const invEnd = sub.current_period_end || invItem?.current_period_end;
        await supabaseAdmin(env, `/subscriptions?stripe_subscription_id=eq.${subscriptionId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'active',
            current_period_start: invStart ? new Date(invStart * 1000).toISOString() : new Date().toISOString(),
            current_period_end: invEnd ? new Date(invEnd * 1000).toISOString() : null,
            updated_at: new Date().toISOString(),
          }),
        });
      }
      break;
    }
  }

  return jsonResponse({ received: true });
}

function mapPriceToTier(priceId: string, env: Env): string {
  if (env.STRIPE_PRO_PRICE_ID && priceId === env.STRIPE_PRO_PRICE_ID) return 'pro';
  if (env.STRIPE_PRO_ANNUAL_PRICE_ID && priceId === env.STRIPE_PRO_ANNUAL_PRICE_ID) return 'pro';
  return 'pro';
}

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = header.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const vPart = parts.find(p => p.startsWith('v1='));
  if (!tPart || !vPart) return false;

  const timestamp = tPart.split('=')[1];
  const sig = vPart.split('=')[1];
  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp)) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqualHex(expected, sig);
}

// --- Seedance handlers ---

async function handleFalImage(request: Request, env: Env, userId?: string, ctx?: { waitUntil: (p: Promise<any>) => void }): Promise<Response> {
  if (!env.FAL_API_KEY) return jsonError('fal.ai API key not configured', 500);

  const body = await request.json() as any;
  const endpoint = body.model || 'fal-ai/nano-banana-2';

  const res = await fetch(`https://fal.run/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${env.FAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: body.prompt,
      num_images: 1,
      aspect_ratio: body.aspect_ratio || '1:1',
      output_format: 'png',
      resolution: body.resolution || '2K',
      safety_tolerance: '4',
    }),
  });

  const data = await res.json() as any;
  if (!res.ok) return jsonError(data.detail || 'fal.ai image generation failed', res.status);

  const imageUrl = data.images?.[0]?.url;
  if (!imageUrl) return jsonError('No image generated', 500);

  meterMediaFromHeaders(env, userId, request, ctx, 'generateImage'); // idempotent dual-write (flat per image)
  return jsonResponse({ imageUrl });
}

async function handleSeedanceGenerate(request: Request, env: Env): Promise<Response> {
  if (!env.BYTEPLUS_API_KEY) return jsonError('BytePlus API key not configured', 500);

  const body = await request.json() as any;
  const res = await fetch(`${BYTEPLUS_BASE}/contents/generations/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.BYTEPLUS_API_KEY}`,
    },
    body: JSON.stringify({
      model: body.model || 'dreamina-seedance-2-0-mini-260615',
      content: [{ type: 'text', text: body.prompt }],
      resolution: body.resolution || '1080p',
      ratio: body.ratio || '16:9',
      duration: body.duration || 5,
      generate_audio: body.generate_audio || false,
      watermark: false,
    }),
  });

  const data = await res.json() as any;
  if (!res.ok) return jsonError(data.error?.message || 'Seedance task creation failed', res.status);
  return jsonResponse({ taskId: data.id });
}

async function handleSeedancePoll(request: Request, env: Env, userId?: string, ctx?: { waitUntil: (p: Promise<any>) => void }): Promise<Response> {
  if (!env.BYTEPLUS_API_KEY) return jsonError('BytePlus API key not configured', 500);

  const { taskId } = await request.json() as { taskId: string };
  // taskId is interpolated into a URL that carries the BytePlus key — validate its charset and
  // encode it so it can't inject path segments / alter where the keyed request goes.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId || '')) return jsonError('Invalid task id', 400);
  const res = await fetch(`${BYTEPLUS_BASE}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
    headers: { 'Authorization': `Bearer ${env.BYTEPLUS_API_KEY}` },
  });

  const data = await res.json() as any;
  if (!res.ok) return jsonError(data.error?.message || 'Seedance poll failed', res.status);
  // Meter at GENERATION COMPLETION (the poll that reports success), not on download — matches our
  // provider cost and doesn't depend on the user fetching the file. Idempotent on usage_id.
  if (data.status === 'succeeded') meterMediaFromHeaders(env, userId, request, ctx); // action from X-Db-Action
  return jsonResponse({
    status: data.status,
    videoUrl: data.content?.video_url || null,
    tokensUsed: data.usage?.total_tokens || 0,
  });
}

async function handleSeedanceDownload(request: Request, env: Env, userId?: string, ctx?: { waitUntil: (p: Promise<any>) => void }): Promise<Response> {
  const { url } = await request.json() as { url: string };
  // No secret is attached here, but the URL is user-supplied — require https and block internal
  // hosts so the worker can't be used to probe/relay non-public targets.
  const safe = safeFetchUrl(url);
  if (!safe) return jsonError('Invalid download URL', 400);
  const response = await fetch(safe.toString());
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonResponse(data: any): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
