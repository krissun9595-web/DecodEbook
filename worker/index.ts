interface Env {
  GEMINI_API_KEY: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  ASSETS: Fetcher;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

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
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/api/llm/generate') {
      const authError = await verifyAuth(request, env);
      if (authError) return authError;
      return handleUnifiedLLM(request, env);
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
  return jsonResponse({ text, raw: data });
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
  return jsonResponse({ text, raw: data });
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
  return jsonResponse({ text, raw: data });
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

  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (['host', 'x-goog-api-key', 'cf-connecting-ip', 'cf-ray', 'authorization'].includes(k.toLowerCase())) continue;
    headers.set(k, v);
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
