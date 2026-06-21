interface Env {
  GEMINI_API_KEY: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  BYTEPLUS_API_KEY: string;
  FAL_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRO_PRICE_ID: string;
  STRIPE_PRO_ANNUAL_PRICE_ID: string;
  STRIPE_BYOK_PRICE_ID: string;
  STRIPE_UNLIMITED_PRICE_ID: string;
  STRIPE_PACK_S_PRICE_ID: string;
  STRIPE_PACK_M_PRICE_ID: string;
  STRIPE_PACK_L_PRICE_ID: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ASSETS: { fetch: typeof fetch };
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const BYTEPLUS_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

const TIER_CREDITS: Record<string, number> = {
  free: 100, pro: 1000, byok: Infinity, unlimited: Infinity,
};

const CREDIT_COSTS: Record<string, number> = {
  translate: 1, quickDefinition: 1, chat: 1,
  analyzeBookStructure: 2, extractConcepts: 2, extractDictionary: 2, generateMindMap: 2,
  extractChapterText: 3, podcastScript: 3,
  tts: 5, generateImage: 10, podcastAudio: 40,
  videoSeedanceFast: 30, videoSeedance: 50, videoVeo: 150,
};

const PACK_CREDITS: Record<string, number> = { S: 1000, M: 2500, L: 4000 };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-goog-api-key, Authorization',
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
        stripeByokPriceId: env.STRIPE_BYOK_PRICE_ID || '',
        stripeUnlimitedPriceId: env.STRIPE_UNLIMITED_PRICE_ID || '',
        stripePackSPriceId: env.STRIPE_PACK_S_PRICE_ID || '',
        stripePackMPriceId: env.STRIPE_PACK_M_PRICE_ID || '',
        stripePackLPriceId: env.STRIPE_PACK_L_PRICE_ID || '',
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
      const body = await request.clone().json() as any;
      const creditAction = body.creditAction || 'translate';
      const check = await checkCreditBalance(auth.userId, creditAction, env);
      if (check) return check;
      return handleUnifiedLLM(request, env);
    }

    if (url.pathname === '/api/fal/image') {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      const check = await checkCreditBalance(auth.userId, 'generateImage', env);
      if (check) return check;
      return handleFalImage(request, env);
    }

    if (url.pathname === '/api/seedance/generate') {
      const auth = await getUserIdFromAuth(request, env);
      if (auth instanceof Response) return auth;
      const body = await request.clone().json() as any;
      const isFast = (body.model || '').includes('fast');
      const check = await checkCreditBalance(auth.userId, isFast ? 'videoSeedanceFast' : 'videoSeedance', env);
      if (check) return check;
      return handleSeedanceGenerate(request, env);
    }

    if (url.pathname === '/api/seedance/poll') {
      const authError = await verifyAuth(request, env);
      if (authError) return authError;
      return handleSeedancePoll(request, env);
    }

    if (url.pathname === '/api/seedance/download') {
      const authError = await verifyAuth(request, env);
      if (authError) return authError;
      return handleSeedanceDownload(request);
    }

    if (url.pathname.startsWith('/api/gemini/')) {
      const authError = await verifyAuth(request, env);
      if (authError) return authError;

      if (url.pathname.startsWith('/api/gemini/video-download')) {
        return handleVideoDownload(request, env);
      }
      return handleGeminiProxy(request, url, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function verifyAuth(request: Request, env: Env): Promise<Response | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;

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

function getProvider(model: string): 'gemini' | 'openai' | 'anthropic' {
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  return 'gemini';
}

async function handleUnifiedLLM(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as any;
  const model = body.model || 'gemini-3-flash-preview';
  const provider = getProvider(model);

  if (provider === 'openai') return callOpenAI(body, env);
  if (provider === 'anthropic') return callAnthropic(body, env);
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
  if (!env.OPENAI_API_KEY) return jsonError('OpenAI API key not configured', 500);

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

  const openaiBody: any = {
    model: body.model,
    messages,
  };
  if (body.generationConfig?.responseMimeType === 'application/json') {
    openaiBody.response_format = { type: 'json_object' };
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(openaiBody),
  });

  const data = await res.json() as any;
  if (data.error) return jsonError(data.error.message || 'OpenAI error', res.status);
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

async function handleGeminiProxy(request: Request, url: URL, env: Env): Promise<Response> {
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

  const response = await fetch(targetUrl.toString(), init);

  const resHeaders = new Headers(response.headers);
  resHeaders.set('Access-Control-Allow-Origin', '*');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: resHeaders,
  });
}

async function handleVideoDownload(request: Request, env: Env): Promise<Response> {
  if (!env.GEMINI_API_KEY) {
    return jsonError('API key not configured on server', 500);
  }

  try {
    const { uri } = (await request.json()) as { uri: string };
    const response = await fetch(uri, {
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

async function getUserIdFromAuth(request: Request, env: Env): Promise<{ userId: string } | Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return { userId: '' };
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return jsonError('Authentication required', 401);
  const token = authHeader.slice(7);
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': env.SUPABASE_ANON_KEY },
    });
    if (!res.ok) return jsonError('Invalid or expired session', 401);
    const user = await res.json() as any;
    return { userId: user.id };
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

  // Check referral activation (non-blocking)
  if (data.credits_used >= 10) {
    checkReferralActivation(userId, env).catch(() => {});
  }

  return jsonResponse(data);
}

async function checkCreditBalance(userId: string, action: string, env: Env): Promise<Response | null> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
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
    if (!res.ok) return null;
    const data = await res.json() as any;
    const tier = data.tier || 'free';
    const monthlyCredits = TIER_CREDITS[tier] || TIER_CREDITS.free;
    if (monthlyCredits === Infinity) return null;
    const creditsUsed = data.credits_used || 0;
    const packCredits = data.pack_credits || 0;
    const bonusCredits = data.bonus_credits || 0;
    const cost = CREDIT_COSTS[action] || 1;
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
    return null;
  }
}

// --- Referral handlers ---

async function checkReferralActivation(userId: string, env: Env) {
  // Check if this user was referred and not yet activated
  const res = await supabaseAdmin(env, `/referral_signups?referred_user_id=eq.${userId}&activated=eq.false&select=id,referrer_id`, {
    method: 'GET', headers: { 'Prefer': '' },
  });
  const signups = await res.json() as any[];
  if (!signups?.length) return;

  const signup = signups[0];
  // Mark as activated
  await supabaseAdmin(env, `/referral_signups?id=eq.${signup.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ activated: true, referrer_credited: true }),
  });
  // Award referrer 100 bonus credits
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/add_bonus_credits`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_user_id: signup.referrer_id, p_credits: 100 }),
  });
}

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
  if (!code) return jsonError('Missing referral code', 400);

  // Look up referrer by code
  const codeRes = await supabaseAdmin(env, `/referral_codes?code=eq.${code}&select=user_id`, {
    method: 'GET', headers: { 'Prefer': '' },
  });
  const codes = await codeRes.json() as any[];
  if (!codes?.length) return jsonError('Invalid referral code', 404);
  const referrerId = codes[0].user_id;

  // Hash visitor IP for uniqueness
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(ip + referrerId));
  const visitorHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);

  // Insert click (ignore duplicate)
  const clickRes = await supabaseAdmin(env, '/referral_clicks', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ referrer_id: referrerId, visitor_hash: visitorHash, credited: false }),
  });

  // Check if this is a new unique click
  const clicks = await clickRes.json() as any[];
  if (clicks?.length > 0) {
    // Count total credited clicks for this referrer
    const countRes = await supabaseAdmin(env, `/referral_clicks?referrer_id=eq.${referrerId}&credited=eq.true&select=id`, {
      method: 'GET', headers: { 'Prefer': 'count=exact' },
    });
    const countHeader = countRes.headers.get('content-range');
    const creditedCount = countHeader ? parseInt(countHeader.split('/')[1] || '0') : 0;

    if (creditedCount < 10) { // cap at 10 clicks * 5 cr = 50 cr
      // Mark this click as credited
      await supabaseAdmin(env, `/referral_clicks?referrer_id=eq.${referrerId}&visitor_hash=eq.${visitorHash}`, {
        method: 'PATCH',
        body: JSON.stringify({ credited: true }),
      });
      // Award 5 bonus credits
      await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/add_bonus_credits`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ p_user_id: referrerId, p_credits: 5 }),
      });
    }
  }

  return jsonResponse({ ok: true, referrer_id: referrerId });
}

async function handleReferralSignup(request: Request, env: Env): Promise<Response> {
  const auth = await getUserIdFromAuth(request, env);
  if (auth instanceof Response) return auth;

  const { referrer_id } = await request.json() as { referrer_id: string };
  if (!referrer_id || referrer_id === auth.userId) return jsonError('Invalid referral', 400);

  // Check not already referred
  const existRes = await supabaseAdmin(env, `/referral_signups?referred_user_id=eq.${auth.userId}&select=id`, {
    method: 'GET', headers: { 'Prefer': '' },
  });
  const existing = await existRes.json() as any[];
  if (existing?.length > 0) return jsonResponse({ ok: true, already: true });

  await supabaseAdmin(env, '/referral_signups', {
    method: 'POST',
    body: JSON.stringify({ referrer_id: referrer_id, referred_user_id: auth.userId }),
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
    'customer': subs[0].stripe_customer_id,
    'metadata[user_id]': auth.userId,
    'metadata[pack_type]': packType,
    'metadata[credits]': String(credits),
  };

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
          await supabaseAdmin(env, '/rpc/add_pack_credits', {
            method: 'POST',
            body: JSON.stringify({ p_user_id: userId, p_credits: credits }),
          });
          await supabaseAdmin(env, '/credit_pack_purchases', {
            method: 'POST',
            body: JSON.stringify({
              user_id: userId,
              stripe_session_id: session.id,
              pack_type: packType,
              credits,
              amount_cents: session.amount_total || 0,
            }),
          });
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
  if (env.STRIPE_BYOK_PRICE_ID && priceId === env.STRIPE_BYOK_PRICE_ID) return 'byok';
  if (env.STRIPE_UNLIMITED_PRICE_ID && priceId === env.STRIPE_UNLIMITED_PRICE_ID) return 'unlimited';
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
  return expected === sig;
}

// --- Seedance handlers ---

async function handleFalImage(request: Request, env: Env): Promise<Response> {
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
      model: body.model || 'dreamina-seedance-2-0-260128',
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

async function handleSeedancePoll(request: Request, env: Env): Promise<Response> {
  if (!env.BYTEPLUS_API_KEY) return jsonError('BytePlus API key not configured', 500);

  const { taskId } = await request.json() as { taskId: string };
  const res = await fetch(`${BYTEPLUS_BASE}/contents/generations/tasks/${taskId}`, {
    headers: { 'Authorization': `Bearer ${env.BYTEPLUS_API_KEY}` },
  });

  const data = await res.json() as any;
  if (!res.ok) return jsonError(data.error?.message || 'Seedance poll failed', res.status);
  return jsonResponse({
    status: data.status,
    videoUrl: data.content?.video_url || null,
    tokensUsed: data.usage?.total_tokens || 0,
  });
}

async function handleSeedanceDownload(request: Request): Promise<Response> {
  const { url } = await request.json() as { url: string };
  const response = await fetch(url);
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
