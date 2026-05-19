interface Env {
  GEMINI_API_KEY: string;
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
          'Access-Control-Allow-Headers': 'Content-Type, x-goog-api-key',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (url.pathname.startsWith('/api/gemini/video-download')) {
      return handleVideoDownload(request, env);
    }

    if (url.pathname.startsWith('/api/gemini/')) {
      return handleGeminiProxy(request, url, env);
    }

    return env.ASSETS.fetch(request);
  },
};

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
    if (['host', 'x-goog-api-key', 'cf-connecting-ip', 'cf-ray'].includes(k.toLowerCase())) continue;
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
