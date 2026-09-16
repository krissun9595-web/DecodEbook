
import { GoogleGenAI, Type, Modality, Content, Part } from "@google/genai";
import { BookStructure, Chapter, Concept, DictionaryEntry, FileContext, MindMapNode, NotebookItem } from "../types";
import { getSession, getUser, logUsage } from "./supabase";
import { creditsForAction, costCentsForAction, VIDEO_SECONDS_DEFAULT } from "./pricing";
import { INSUFFICIENT_CREDITS } from "./credits";
import { extractChapterFromSource } from "../utils/sourceIndex";
import { buildLocalTextStructure, buildStructureAnalysisText, isReadableChapterTitle } from "../utils/structureAnalysis";
import { PDF_TEXT_EXTRACTION_VERSION } from "../utils/sourceVersion";

let _userApiKey: string | null = null;
const DEFAULT_TEXT_MODEL = 'gemini-3-flash-preview'; // translate default; geo-routed to deepseek-v4-pro for CN via setLLMModel
let _selectedModel: string = 'gemini-3-flash-preview';
let _ttsModel: string = 'gemini-3.1-flash-tts-preview';
let _imageModel: string = 'gemini-3-pro-image-preview';
let _videoModel: string = 'veo-3.1-fast-generate-preview';
let _currentBook = ''; // active book title, for usage attribution in credit history
export const setCurrentBook = (title: string) => { _currentBook = title || ''; };
export const setGeminiApiKey = (key: string) => { _userApiKey = key; };
export const setLLMModel = (model: string) => { _selectedModel = model; };
export const setTTSModel = (model: string) => { _ttsModel = model; };
export const setImageModel = (model: string) => { _imageModel = model; };
// Real per-image credit cost for the CURRENT image model (mode-aware) — lets callers
// pre-check on the true cost (a premium image is far pricier than the flat gate floor),
// matching the worker's gate so the notice shows before the call, not after a 429.
export const estimateImageCredits = (images = 1): number => creditsForAction('generateImage', _imageModel, { images });
export const setVideoModel = (model: string) => { _videoModel = model; };
export const getLLMModel = () => _selectedModel;
export const getVideoModel = () => _videoModel;

// ── Generation mode (universal, app-wide): Balanced (cost-effective) / Premium (best).
// Persisted in localStorage so every generation call reads it. User-visible text
// functions switch model by mode; internal functions stay fixed (see MODEL_POLICY).
export type GenMode = 'balanced' | 'premium';
let _genMode: GenMode = (typeof localStorage !== 'undefined' && localStorage.getItem('generation_mode') === 'premium') ? 'premium' : 'balanced';
export const setGenerationMode = (m: GenMode) => { _genMode = m === 'premium' ? 'premium' : 'balanced'; applyMediaMode(_genMode); };
export const getGenerationMode = (): GenMode => _genMode;
// Per-function TEXT model by mode. Only user-visible functions listed here scale; anything
// absent falls back to FUNCTION_MODELS (internal functions stay on the current model —
// the flash-lite cost-down is a separate follow-up pending JSON-adherence validation).
const MODEL_POLICY: Record<string, { balanced: string; premium: string }> = {
  translate:           { balanced: 'deepseek-v4-flash',      premium: 'gemini-3.1-pro-preview' },
  chat:                { balanced: 'gemini-3-flash-preview', premium: 'gemini-3.1-pro-preview' },
  quickDefinition:     { balanced: 'gemini-2.5-flash-lite',  premium: 'gemini-3-flash-preview' },
  podcastScript:       { balanced: 'gemini-3-flash-preview', premium: 'gemini-3.1-pro-preview' },
};
export const resolveModel = (fn?: string, mode: GenMode = _genMode): string =>
  (fn && MODEL_POLICY[fn]?.[mode]) || (fn ? FUNCTION_MODELS[fn] : '') || _selectedModel;

// MEDIA models by mode — image + video switch (video path is chosen from _videoModel:
// dreamina-* → Seedance path, veo-* → Veo path). TTS stays on Gemini flash both modes.
const applyMediaMode = (mode: GenMode) => {
  _imageModel = mode === 'premium' ? 'gemini-3-pro-image-preview' : 'gemini-2.5-flash-image';
  _videoModel = mode === 'premium' ? 'veo-3.1-fast-generate-preview' : 'dreamina-seedance-2-0-mini-260615';
  _ttsModel   = 'gemini-3.1-flash-tts-preview';
};
applyMediaMode(_genMode); // apply the persisted mode's media models on load

// Admin-set model per function — users do NOT choose (the settings picker was removed).
// Edit these to route a function to a different model; pricing (services/pricing.ts)
// charges credits from the chosen model automatically. Translate uses DeepSeek
// (Chinese-optimized). The others stay on gemini-flash until you assign + add keys.
export const FUNCTION_MODELS: Record<string, string> = {
  translate:            'gemini-3-flash-preview', // geo-routed: CN → deepseek-v4-pro (set on bootstrap)
  translateFigureText:  'gemini-3-flash-preview',
  chat:                 'gemini-3-flash-preview',
  analyzeBookStructure: 'gemini-3-flash-preview',
  extractChapterText:   'gemini-3-flash-preview',
  extractConcepts:      'gemini-3-flash-preview',
  podcastScript:        'gemini-3-flash-preview',
  videoPrompt:          'gemini-3-flash-preview',
  quickDefinition:      'gemini-3-flash-preview',
};
export const modelFor = (fn: string): string => FUNCTION_MODELS[fn] || DEFAULT_TEXT_MODEL;
// Direct (non-proxy) provider access is ONLY for a key the user pastes themselves. There is no
// build-time/bundled key fallback — the server key stays server-side behind the /api/gemini proxy.
const getDirectKey = () => _userApiKey || '';
const useProxy = () => !getDirectKey();
const isGeminiModel = (model?: string) => { const m = model || _selectedModel; return !m.startsWith('gpt-') && !m.startsWith('claude-') && !m.startsWith('deepseek'); };
// gemini-3.x Pro is a reasoning model that ONLY works with thinking (thinkingBudget 0 →
// 400 INVALID_ARGUMENT). Flash/lite allow disabling thinking for speed/cost. So only
// disable thinking for non-pro models; pro keeps its default (dynamic) thinking.
const modelRequiresThinking = (model?: string) => /pro/i.test(model || '');
const isMissingProviderKeyError = (message: string): boolean =>
  /(?:openai|anthropic)\s+api\s+key\s+not\s+configured/i.test(message);

interface TokenInfo {
  total: number;
  input: number;   // TOTAL prompt tokens (includes any cached prefix)
  output: number;
  cached?: number; // subset of input served from Gemini's implicit context cache (billed at 10%)
}

// Credits charged + real cost are BOTH derived from the model's unit price
// (services/pricing.ts) — so an expensive model costs more credits, and adding a
// model prices itself. The model is logged so per-model margin can be audited.
// For media actions the caller passes the modality model (_ttsModel/_imageModel/
// _videoModel); pricing routes by action and reads chars/seconds/images as needed.
// Count CJK/Kana/Hangul characters — they expand into far more TTS audio tokens per
// character than Latin text, so TTS costing is script-aware (see pricing.ttsCostCents).
export const countCjkChars = (s: string): number =>
  (s.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) || []).length;

// Per-EXECUTION session id (ambient). A generation calls beginUsageSession(label) before its many
// sub-calls and endUsageSession() after; every usage_logs row it produces carries the same id + label,
// so the Credit History groups a whole generation into ONE immutable line — and a re-run (new session)
// is a SEPARATE line, never a rewrite of the previous one. Format: `<Friendly Label>#<uuid>`.
let _usageSession: string | null = null;
export const beginUsageSession = (label: string): void => {
  const rand = (typeof crypto !== 'undefined' && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : `${_currentBook.length}-${performance.now()}`;
  _usageSession = `${label}#${rand}`;
};
export const endUsageSession = (): void => { _usageSession = null; };

// A unique idempotency key per charge, so the durable client write (supabase.ts) can re-send a
// row after a tab-close / crash without double-charging (ON CONFLICT DO NOTHING on usage_id).
const newUsageId = (): string => {
  try { return (crypto as any).randomUUID(); } catch { return `u-${Date.now()}-${Math.round(Math.random() * 1e9)}`; }
};

const trackUsage = (action: string, tokens: TokenInfo | number = 0, model?: string, extraUnits?: { chars?: number; cjkChars?: number; seconds?: number; images?: number }, sessionId?: string, usageId?: string) => {
  const t: TokenInfo = typeof tokens === 'number'
    ? { total: tokens, input: 0, output: 0 }
    : tokens;
  const m = model || _selectedModel;
  const units = { inTok: t.input, outTok: t.output, cachedTok: t.cached ?? 0, chars: t.input, images: 1, seconds: VIDEO_SECONDS_DEFAULT, ...(extraUnits || {}) };
  const creditsCost = creditsForAction(action, m, units);
  const costCents = costCentsForAction(action, m, units);
  // Explicit sessionId wins over the ambient one — used to group a whole page-view's translation
  // (current page + its prefetch) into ONE credit line, immune to the deferred translation job chain.
  const session = sessionId ?? _usageSession;
  // Explicit usageId (passed by a caller that also sent it to the worker) lets the worker's Phase-A
  // dual-write dedupe against this client write on the SAME id; otherwise generate a fresh one.
  const uid = usageId || newUsageId();
  getUser().then(user => {
    if (user) logUsage(user.id, action, t.total, costCents, t.input, t.output, creditsCost, m, _currentBook || null, session, uid);
  }).catch(() => {});
};

// Records a zero-credit "this generation was stopped part-way" marker (model='__partial__'), so the
// Credit History can tag the delivered-partial work as e.g. "Audio generation (Partial)". Harmless if
// no batches were charged — the grouping simply has nothing to tag.
export const PARTIAL_MARKER = '__partial__';
export const logGenerationPartial = (action: string) => {
  const session = _usageSession;
  const usageId = newUsageId();
  getUser().then(user => {
    if (user) logUsage(user.id, action, 0, 0, 0, 0, 0, PARTIAL_MARKER, _currentBook || null, session, usageId);
  }).catch(() => {});
};

const extractTokens = (response: any): TokenInfo => {
  const meta = response?.usageMetadata;
  if (!meta) return { total: 0, input: 0, output: 0 };
  const input = meta.promptTokenCount || 0;
  const output = meta.candidatesTokenCount || 0;
  // Implicit-cache hit count: the slice of `input` Gemini served from cache (billed at 10%).
  const cached = meta.cachedContentTokenCount || 0;
  return { total: input + output, input, output, cached };
};

const getAuthHeaders = async (): Promise<Record<string, string>> => {
  if (!useProxy()) return {};
  const session = await getSession();
  return session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {};
};

// Phase-A metering headers — tell the worker how to record this call's charge (it dedupes on
// usageId, so this is a no-op double vs the client's own write). Reused by getAi() (SDK calls) AND
// the direct media fetches (image / video / seedance). Text tokens come from the response; media
// units (chars/seconds/images) are passed here.
type UsageMeta = { usageId?: string; action?: string; model?: string; book?: string; session?: string; chars?: number; cjkChars?: number; seconds?: number; images?: number };
const usageHeaders = (meta?: UsageMeta): Record<string, string> => {
  const h: Record<string, string> = {};
  if (!meta?.usageId) return h;
  h['X-Db-Usage-Id'] = meta.usageId;
  if (meta.action)          h['X-Db-Action']  = meta.action;
  if (meta.model)           h['X-Db-Model']   = meta.model;
  if (meta.book)            h['X-Db-Book']    = encodeURIComponent(meta.book); // may be non-ASCII
  if (meta.session)         h['X-Db-Session'] = meta.session;
  if (meta.chars != null)   h['X-Db-Chars']   = String(meta.chars);
  if (meta.cjkChars != null)h['X-Db-Cjk']     = String(meta.cjkChars);
  if (meta.seconds != null) h['X-Db-Seconds'] = String(meta.seconds);
  if (meta.images != null)  h['X-Db-Images']  = String(meta.images);
  return h;
};

const getAi = async (meta?: UsageMeta) => {
  if (useProxy()) {
    const headers = { ...(await getAuthHeaders()), ...usageHeaders(meta) };
    return new GoogleGenAI({
      apiKey: 'proxy',
      httpOptions: { baseUrl: `${window.location.origin}/api/gemini`, headers },
    });
  }
  return new GoogleGenAI({ apiKey: getDirectKey() });
};

const callUnifiedLLM = async (params: {
  model?: string;
  contents: any;
  systemInstruction?: string;
  generationConfig?: any;
  creditAction?: string;
  creditSession?: string; // groups this call's charge under a specific credit-history line
  signal?: AbortSignal;   // optional cancellation (used by chat); existing callers omit it
}): Promise<string> => {
  const model = params.model || resolveModel(params.creditAction);

  if (isGeminiModel(model)) {
    const usageId = newUsageId();
    const ai = await getAi({ usageId, action: params.creditAction || 'translate', model, book: _currentBook || undefined, session: params.creditSession });
    const config: any = {};
    if (params.systemInstruction) config.systemInstruction = params.systemInstruction;
    if (params.generationConfig) Object.assign(config, params.generationConfig);
    if (!modelRequiresThinking(model)) config.thinkingConfig = { thinkingBudget: 0 };
    if (params.signal) config.abortSignal = params.signal;
    const response = await ai.models.generateContent({ model, contents: params.contents, config });
    trackUsage(params.creditAction || 'translate', extractTokens(response), model, undefined, params.creditSession, usageId);
    return response.text || '';
  }

  const llmUsageId = newUsageId();
  const headers = { ...(await getAuthHeaders()), ...usageHeaders({ usageId: llmUsageId, action: params.creditAction || 'translate', model, book: _currentBook || undefined, session: params.creditSession }) };
  const res = await fetch('/api/llm/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    signal: params.signal,
    body: JSON.stringify({
      model,
      contents: Array.isArray(params.contents) ? params.contents : [params.contents],
      systemInstruction: params.systemInstruction,
      generationConfig: params.generationConfig,
      creditAction: params.creditAction || 'translate',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    const message = (err as any).error || 'LLM request failed';
    // A 429 is only "insufficient credits" when the body actually says so (the worker's
    // credit gate returns {"error":"Insufficient credits"}). A 429 from the per-user rate
    // limiter or an upstream provider quota is NOT a credit problem — surface it as a
    // retryable "service busy" instead of the misleading (silent) credit prompt.
    if (/insufficient credits/i.test(message)) throw new Error(INSUFFICIENT_CREDITS);
    if (res.status === 429) throw new Error('The AI service is busy right now — please wait a moment and try again.');
    if (model !== DEFAULT_TEXT_MODEL && isMissingProviderKeyError(message)) {
      console.warn(`${message}; falling back to ${DEFAULT_TEXT_MODEL}.`);
      return callUnifiedLLM({ ...params, model: DEFAULT_TEXT_MODEL });
    }
    throw new Error(message);
  }
  const data = await res.json() as any;
  const usage = data.usage || {};
  trackUsage(params.creditAction || 'translate', {
    total: usage.total_tokens || 0,
    input: usage.prompt_tokens || 0,
    output: usage.completion_tokens || 0,
  }, model, undefined, params.creditSession, llmUsageId);
  return data.text || '';
};

const safeJsonParse = <T>(text: string): T => {
  if (!text) throw new Error("Empty text provided to parser");
  
  // 1. Remove markdown code blocks
  let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  
  // 2. Try direct parse
  try {
    return JSON.parse(clean);
  } catch (e) {
    // 3. Try to extract the first JSON object or array
    const match = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        // Fall through to error
      }
    }
    console.error("JSON Parse Failed. Raw text:", text);
    throw new Error("Failed to parse structured data from model response.");
  }
};

export const cleanGenAiText = (text: string): string => {
  if (!text) return "";
  let cleaned = text.replace(/^(Below|Here|Following|This) is the (translation|text).*?:/gi, '');
  cleaned = cleaned.replace(/^(以下是|这是).*(翻译|内容).*?：/gi, '');
  return cleaned
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`/g, '')
    .replace(/^#+\s/gm, '') 
    .trim();
};

const withRetry = async <T>(fn: () => Promise<T>, retries = 3, delay = 2000, signal?: AbortSignal): Promise<T> => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  try {
    return await fn();
  } catch (error: any) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const code = error.status || error.response?.status || error.code || 500;
    const message = (error.message || JSON.stringify(error)).toLowerCase();

    // A credit rejection is terminal — retrying can't help and just stalls the UI (a 429 is
    // otherwise "retryable"). Surface it immediately as the insufficient-credits sentinel.
    if (message.includes('insufficient credits') || message.includes('insufficient_credits')) {
      throw new Error(INSUFFICIENT_CREDITS);
    }

    console.warn(`Gemini API Request Failed [${code}]. Retries left: ${retries}.`);

    const isRetryable = 
      code === 429 || 
      code === 500 || 
      code === 503 || 
      code === 504 ||
      message.includes('overloaded') ||
      message.includes('quota') || 
      message.includes('internal server error') ||
      message.includes('server error') ||
      message.includes('deadline') ||
      message.includes('timeout') ||
      message.includes('unavailable') ||
      message.includes('fetch failed');

    if (retries > 0 && isRetryable) {
      const nextDelay = delay * 2;
      console.log(`Retrying in ${delay}ms...`);
      await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, delay);
          if (signal) {
              signal.addEventListener('abort', () => {
                  clearTimeout(timeout);
                  reject(new DOMException('Aborted', 'AbortError'));
              });
          }
      });
      return withRetry(fn, retries - 1, nextDelay, signal);
    }
    throw error;
  }
};

const getFilePart = (file: FileContext): Part => {
  if (file.isText) {
    // Limit to ~2M chars (safe for Gemini 1.5/Pro context window)
    const LIMIT = 2000000;
    const content = file.content.length > LIMIT ? file.content.substring(0, LIMIT) + "\n...[Content Truncated]..." : file.content;
    return { text: content };
  }
  return { inlineData: { mimeType: file.mimeType, data: file.content } };
};

const getStructureFilePart = (file: FileContext): Part => {
  if (!file.isText) return getFilePart(file);
  return { text: buildStructureAnalysisText(file.content) };
};

// Chapter-scoped context for per-chapter generations (concept extraction, video prompt). These
// ask the model about ONE chapter, so sending the whole book is wasted context (~47 credits each).
// Send just this chapter's text when we can slice it; fall back to the full file otherwise.
const getChapterPart = (file: FileContext, chapter: Chapter): Part => {
  try {
    if (file.isText && file.content) {
      const t = extractChapterFromSource(file.content, chapter);
      if (t && t.trim().length > 0) return { text: t };
    }
  } catch {}
  return getFilePart(file);
};

// Guard: a failed/empty download (e.g. a proxy error JSON ~32 bytes, or a missing URL) must never
// be returned/saved as a "video". Reject anything that isn't a real binary blob so the caller fails
// the generation instead of persisting a broken file.
const assertVideoBlob = async (response: Response): Promise<Blob> => {
  if (!response.ok) throw new Error('Video download failed');
  const blob = await response.blob();
  if (blob.size < 1024 || /application\/json|text\//i.test(blob.type)) throw new Error('Video download returned no data');
  return blob;
};

// On-demand figure translation: read the text baked INTO a figure image (diagram labels, captions)
// and translate each, returning normalized bounding boxes so the reader can overlay the translations.
export const translateFigureText = async (
  imageBase64: string,
  mimeType: string,
  targetLanguage: string,
  signal?: AbortSignal,
): Promise<{ box: [number, number, number, number]; original: string; translated: string }[]> => {
  try {
    return await withRetry(async () => {
      const usageId = newUsageId();
      const ai = await getAi({ usageId, action: 'translateFigureText', model: 'gemini-3-flash-preview', book: _currentBook || undefined, session: _usageSession || undefined });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: `This image is a figure/diagram from a book. Find EVERY piece of text rendered inside it (node/box labels, axis labels, captions drawn on the image) and translate each into ${targetLanguage}. Return {"labels": [...]} where each label is {"box":[ymin,xmin,ymax,xmax] as INTEGERS 0–1000 normalized to the image height/width (ymin,xmin = top-left; ymax,xmax = bottom-right — the TIGHT rectangle around exactly that text run), "original": the source text, "translated": the ${targetLanguage} text}. Give one label per distinct text run; make each box tight. Keep acronyms and untranslatable proper nouns as-is. Return {"labels": []} if the image has no text.` },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: signal,
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              labels: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    box: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                    original: { type: Type.STRING },
                    translated: { type: Type.STRING },
                  },
                  required: ['box', 'translated'],
                },
              },
            },
            required: ['labels'],
          },
        },
      });
      trackUsage('translateFigureText', extractTokens(response), 'gemini-3-flash-preview', undefined, undefined, usageId);
      const raw = response.text;
      if (!raw) return [];
      const data = safeJsonParse<{ labels?: any[] }>(raw);
      const arr = Array.isArray(data?.labels) ? data.labels : [];
      return arr
        .filter(d => Array.isArray(d.box) && d.box.length === 4 && typeof d.translated === 'string' && d.translated.trim())
        .map(d => ({ box: d.box.map(Number) as [number, number, number, number], original: String(d.original ?? ''), translated: String(d.translated) }));
    }, 3, 2000, signal);
  } catch {
    return [];
  }
};

// On-demand FULL redraw: hand the figure to the image model and ask it to reproduce the diagram
// identically but with all text translated. Returns a data URL, or null on failure/no image.
// Image models emit only a fixed set of aspect ratios; pick the one closest to the figure's real shape.
const IMG_RATIOS: [string, number][] = [['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3], ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9]];
const closestRatio = (w: number, h: number): string => {
  const r = w / h;
  return IMG_RATIOS.reduce((best, cur) => Math.abs(cur[1] - r) < Math.abs(best[1] - r) ? cur : best)[0];
};

export const redrawFigureTranslated = async (
  imageBase64: string,
  mimeType: string,
  targetLanguage: string,
  signal?: AbortSignal,
  width?: number,
  height?: number,
): Promise<string | null> => {
  const ratio = width && height ? closestRatio(width, height) : undefined;
  try {
    return await withRetry(async () => {
      const usageId = newUsageId();
      const ai = await getAi({ usageId, action: 'redrawFigureTranslated', model: _imageModel, book: _currentBook || undefined, session: _usageSession || undefined, images: 1 });
      const response = await ai.models.generateContent({
        model: _imageModel,
        contents: {
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: `You are editing this existing diagram image. Output an image with the EXACT SAME pixel dimensions${width && height ? ` (${width}×${height} pixels)` : ''}, aspect ratio, and framing as the input, with the diagram filling the whole frame edge-to-edge just like the input (no added margin, padding, border, or background bars). Translate ONLY the text into ${targetLanguage}. CRITICAL: keep every box, rectangle, circle, arrow, connector, line, icon, colour, and their SIZES and POSITIONS pixel-for-pixel identical to the input. Do NOT resize, shrink, enlarge, re-space, move, or re-layout any box or element to fit the translated text — even when the translation is shorter or longer than the original, the box stays the exact same size and place; fit the translated text inside the original box, shrinking the font if needed. Only the text characters change; the geometry is frozen. Keep acronyms and untranslatable proper nouns as-is. Output only the edited image.` },
          ],
        },
        config: { abortSignal: signal, ...(ratio ? { imageConfig: { aspectRatio: ratio } } : {}) } as any,
      });
      trackUsage('redrawFigureTranslated', extractTokens(response), _imageModel, undefined, undefined, usageId);
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
      }
      return null;
    }, 3, 2000, signal);
  } catch {
    return null;
  }
};

export const analyzeBookStructure = async (file: FileContext): Promise<BookStructure> => {
  try {
    return await withRetry(async () => {
      const usageId = newUsageId();
      const ai = await getAi({ usageId, action: 'analyzeBookStructure', model: 'gemini-3-flash-preview', book: _currentBook || undefined, session: _usageSession || undefined });

      // Switched to gemini-3-flash-preview to prevent 429 Resource Exhausted errors on Pro quota
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: {
          parts: [
            getStructureFilePart(file),
            { text: "Analyze the document structure. Return a valid JSON object with 'title', 'author', and 'chapters' (an array of ordered readable sections with 'id' (number), 'title' (string), 'description' (string), optional 'sourceHeading' with the exact visible heading text, and optional 'pageStart'/'pageEnd' numbers if page markers like [[PAGE N]] are present). Include readable front/back matter such as foreword, preface, introduction, prologue, epilogue, afterword, appendices, notes, and bibliography when they appear as substantial sections. Do NOT include title page, cover page, copyright page, contents, or table of contents as chapters. Ensure the JSON is clean and strictly follows this schema." }
          ]
        },
        config: {
          systemInstruction: "You are a specialized document parser. Your output must be ONLY a valid JSON object. Do not include markdown code blocks (```json), conversational text, or introductions. If the document is large or represented by a LONG_SOURCE_OUTLINE, identify ordered readable sections from the heading candidates, including foreword and afterword pages, and preserve exact headings in sourceHeading. Never return title page, cover page, copyright page, contents, or table of contents as chapters.",
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              author: { type: Type.STRING },
              chapters: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.INTEGER },
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    sourceHeading: { type: Type.STRING },
                    pageStart: { type: Type.INTEGER },
                    pageEnd: { type: Type.INTEGER }
                  },
                  required: ["id", "title"]
                },
              }
            },
            required: ["title", "author", "chapters"]
          }
        }
      });

      trackUsage('analyzeBookStructure', extractTokens(response), 'gemini-3-flash-preview', undefined, undefined, usageId);
      if (!response.text) throw new Error("Empty response from model");

      const data = safeJsonParse<any>(response.text);

      const chapters = Array.isArray(data.chapters) ? data.chapters.map((c: any, i: number) => ({
        id: c.id || i + 1,
        title: c.title || `Chapter ${i + 1}`,
        description: c.description || "",
        sourceHeading: typeof c.sourceHeading === 'string' ? c.sourceHeading : undefined,
        pageStart: typeof c.pageStart === 'number' ? c.pageStart : undefined,
        pageEnd: typeof c.pageEnd === 'number' ? c.pageEnd : undefined
      })).filter((chapter: Chapter) =>
        isReadableChapterTitle(chapter.title) &&
        isReadableChapterTitle(chapter.sourceHeading || chapter.title)
      ).map((chapter: Chapter, index: number) => ({
        ...chapter,
        id: index + 1,
      })) : [];

      if (chapters.length === 0 && file.isText && file.content?.trim()) {
        const fallback = buildLocalTextStructure(file.content);
        return {
          ...fallback,
          title: data.title || fallback.title,
          author: data.author || fallback.author,
        };
      }

      return {
        title: data.title || "Untitled Document",
        author: data.author || "Unknown Author",
        chapters: chapters,
        id: crypto.randomUUID(),
        bookmarks: []
      } as BookStructure;
    });
  } catch (error: any) {
    const status = error?.status || error?.response?.status || error?.code;
    const message = error?.message || JSON.stringify(error);
    const canFallback =
      file.isText &&
      file.content?.trim() &&
      (status === 400 || /invalid argument|request contains an invalid argument|request.*too large|payload|too many tokens/i.test(message));

    if (canFallback) {
      console.warn('Structure analysis request failed; using local text heading fallback.', error);
      return buildLocalTextStructure(file.content);
    }
    throw error;
  }
};

export const translateSentences = async (sentences: string[], targetLanguage: string, sessionId?: string): Promise<string[]> => {
  if (sentences.length === 0) return [];
  // All of this call's batches log under ONE credit line. When the reader passes a shared sessionId,
  // a page's translation AND its next-page prefetch combine into a single line; otherwise this call is
  // its own "Translation" line. Explicit (not ambient) so it's immune to the deferred job chain.
  const rand = (typeof crypto !== 'undefined' && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : String(sentences.length);
  const creditSession = sessionId || `Translation#${rand}`;
  const batchSize = 10;
  const results: string[] = [];
  const SEGMENT_ID_PREFIX = 'DBSEG';
  const NAME_TOKEN_PREFIX = 'DBNAME';
  const isLongSemicolonList = (sentence: string): boolean => {
    const semicolons = (sentence.match(/;/g) || []).length;
    return semicolons >= 6 && sentence.length >= 240;
  };

  const protectNameListItems = (sentence: string): { text: string; names: string[] } => {
    const names: string[] = [];
    const protect = (value: string): string => {
      const token = `[[${NAME_TOKEN_PREFIX}_${names.length}]]`;
      names.push(value.trim());
      return token;
    };

    const text = sentence
      .split(/(;)/)
      .map((part, index, parts) => {
        if (part === ';') return part;
        const previous = index > 0 ? parts[index - 1] : '';
        const next = index < parts.length - 1 ? parts[index + 1] : '';
        const trimmed = part.trim();
        if (!trimmed || next !== ';') return part;

        const prefixMatch = trimmed.match(/^(.*?\b(?:of|and|to)\s+)([A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*)*(?:,\s*(?:Jr\.?|Sr\.?|I{2,4}|IV|V))?)$/u);
        if (prefixMatch && !previous) {
          return part.replace(prefixMatch[2], protect(prefixMatch[2]));
        }

        const looksLikeNameItem =
          /^[A-Z][\p{L}.'-]*(?:,\s*[A-Z][\p{L}.'-]*)?(?:\s+(?:and\s+)?[A-Z][\p{L}.'-]*)*(?:,\s*(?:Jr\.?|Sr\.?|I{2,4}|IV|V))?$/u.test(trimmed) &&
          !/\b(?:and|or|but|who|which|that|with|without|because|while|when|where|helped|acknowledge|acknowledgments?)\b/iu.test(trimmed);
        return looksLikeNameItem ? part.replace(trimmed, protect(trimmed)) : part;
      })
      .join('');

    return { text, names };
  };

  const isNameListItem = (value: string): boolean => {
    const trimmed = value.trim().replace(/\.$/, '');
    if (!trimmed) return false;
    return /^[A-Z][\p{L}.'-]*(?:,\s*[A-Z][\p{L}.'-]*)?(?:\s+(?:and\s+)?[A-Z][\p{L}.'-]*)*(?:,\s*(?:Jr\.?|Sr\.?|I{2,4}|IV|V))?$/u.test(trimmed) &&
      !/\b(?:who|which|that|with|without|because|while|when|where|helped|acknowledge|acknowledgments?|friendship|families)\b/iu.test(trimmed);
  };

  const translateShortFragment = async (fragment: string): Promise<string> => {
    const text = await callUnifiedLLM({
      contents: {
        parts: [{ text: `Translate this short phrase to ${targetLanguage}. Return ONLY the translation, no added context.\n\n${fragment}` }]
      },
      creditAction: 'translate',
      creditSession,
    });
    return cleanGenAiText(text || '').trim();
  };

  const translateNameListPassage = async (sentence: string): Promise<string | null> => {
    const parts = sentence.split(';');
    if (parts.length < 7) return null;

    const first = parts[0].trim();
    const firstNameMatch = first.match(/^(.*?\b(?:of|to|for)\s+)([A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*)*(?:,\s*(?:Jr\.?|Sr\.?|I{2,4}|IV|V))?)$/u);
    if (!firstNameMatch) return null;

    const prefix = firstNameMatch[1].trim();
    const names = [firstNameMatch[2].trim()];
    let tail = '';

    for (const rawPart of parts.slice(1)) {
      const trimmed = rawPart.trim();
      if (!trimmed) continue;
      const isFinal = /\.$/.test(trimmed);
      const withoutFinalPeriod = trimmed.replace(/\.$/, '').trim();
      const finalFamilyMatch = withoutFinalPeriod.match(/^and\s+our\s+families$/iu);
      if (finalFamilyMatch) {
        tail = 'and our families';
        continue;
      }
      if (!isNameListItem(withoutFinalPeriod)) return null;
      names.push(withoutFinalPeriod);
      if (isFinal) tail = '';
    }

    const translatedPrefix = await translateShortFragment(prefix);
    const translatedTail = tail ? await translateShortFragment(tail) : '';
    const separator = /Chinese|Japanese|Korean/i.test(targetLanguage) ? '；' : '; ';
    const finalSeparator = /Chinese|Japanese|Korean/i.test(targetLanguage) ? '以及' : ' and ';
    const namesText = names.join(separator);
    const finalText = translatedTail
      ? `${namesText}${finalSeparator}${translatedTail}`
      : namesText;
    return `${translatedPrefix} ${finalText}.`.replace(/\s+([。.!?])/g, '$1').trim();
  };

  const restoreProtectedNames = (text: string, names: string[]): string => {
    // The model sometimes mangles a placeholder (drops the underscore → "[[DBNAME0]]", adds spaces,
    // or changes case), so match tolerantly by the captured index rather than an exact token string.
    let result = text.replace(
      new RegExp(`\\[\\[\\s*${NAME_TOKEN_PREFIX}[_\\s]*(\\d+)\\s*\\]\\]`, 'gi'),
      (_m, idx) => { const name = names[Number(idx)]; return name !== undefined ? name : ''; },
    );
    // Final safety net: strip any DBNAME placeholder mangled beyond an index match, so a raw token
    // never renders literally in the reader.
    result = result.replace(new RegExp(`\\[\\[\\s*${NAME_TOKEN_PREFIX}[^\\]]*\\]\\]`, 'gi'), '');
    return result;
  };

  const buildSegmentId = (absoluteIndex: number): string => `${SEGMENT_ID_PREFIX}_${absoluteIndex.toString().padStart(4, '0')}`;

  const parseAlignedBatch = (
    value: unknown,
    batchItems: { id: string; text: string }[]
  ): string[] | null => {
    if (!Array.isArray(value)) return null;

    const byId = new Map<string, string>();
    for (const item of value) {
      if (!item || typeof item !== 'object') return null;
      const entry = item as { id?: unknown; translation?: unknown };
      if (typeof entry.id !== 'string' || typeof entry.translation !== 'string') return null;
      if (byId.has(entry.id)) return null;
      byId.set(entry.id, entry.translation.trim());
    }

    if (byId.size !== batchItems.length) return null;
    const aligned = batchItems.map(item => byId.get(item.id) || '');
    return aligned.every(Boolean) ? aligned : null;
  };

  const translateSinglePassage = async (sentence: string): Promise<string> => {
    const deterministicListTranslation = await translateNameListPassage(sentence);
    if (deterministicListTranslation) return deterministicListTranslation;

    const protectedPassage = protectNameListItems(sentence);
    const text = await callUnifiedLLM({
      contents: {
        parts: [{ text: `Translate this single complete passage to ${targetLanguage}. Return ONLY the translated passage as one string. Do not split semicolon-separated names into separate list items. Tokens like [[${NAME_TOKEN_PREFIX}_0]] are protected personal names: copy every token exactly, keep each token in its original position, and do not translate or alter tokens. Preserve the paragraph meaning.\n\nPassage:\n${protectedPassage.text}` }]
      },
      creditAction: 'translate',
      creditSession,
    });
    return restoreProtectedNames(cleanGenAiText(text || '').trim(), protectedPassage.names);
  };

  for (let i = 0; i < sentences.length;) {
    if (isLongSemicolonList(sentences[i])) {
      results.push(await withRetry(() => translateSinglePassage(sentences[i])));
      i += 1;
      continue;
    }

    const batch: { id: string; text: string }[] = [];
    while (i < sentences.length && batch.length < batchSize && !isLongSemicolonList(sentences[i])) {
      batch.push({ id: buildSegmentId(i), text: sentences[i] });
      i += 1;
    }

    const batchResult = await withRetry(async () => {
      const text = await callUnifiedLLM({
        contents: {
          parts: [{ text: `Translate these source segments to ${targetLanguage}.\n\nReturn ONLY a JSON array of objects. Every output object MUST have exactly these fields:\n- "id": copy the input id exactly\n- "translation": the translation for only that same input segment\n\nHard alignment rules:\n- Return exactly ${batch.length} objects.\n- Copy every id exactly once. Do not invent, omit, rename, sort, merge, or split ids.\n- Translate each segment independently. Never attach translation from a previous or later segment.\n- If a segment is a sentence fragment, translate only that fragment; do not complete it from surrounding context.\n- Preserve personal names exactly, including initials and generational suffixes such as "V. Harwood Bocker, III" and "Robert Lawrence, III".\n- Do not treat "III" or a single-letter initial period as a sentence boundary.\n\nInput segments:\n${JSON.stringify(batch)}` }]
        },
        creditAction: 'translate',
        creditSession,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                translation: { type: Type.STRING }
              },
              required: ['id', 'translation']
            }
          }
        }
      });
      const parsed = safeJsonParse<unknown>(text || "[]");
      const aligned = parseAlignedBatch(parsed, batch);
      if (aligned) return aligned;

      console.warn('Translation batch failed strict id alignment; falling back to single-segment translation.');
      return Promise.all(batch.map(item => translateSinglePassage(item.text)));
    });
    results.push(...batchResult);
    if (i < sentences.length) {
        await new Promise(r => setTimeout(r, 200));
    }
  }
  return results;
};

export const extractChapterText = async (file: FileContext, chapter: Chapter, allChapters?: Chapter[]): Promise<string> => {
  if (!file.isText || !file.content) {
    throw new Error("AudioBook requires locally extracted source text. Re-upload the file so DecodEbook can extract verbatim text.");
  }
  if (file.sourceKind === 'pdf' && file.sourceExtractorVersion !== PDF_TEXT_EXTRACTION_VERSION) {
    throw new Error("This PDF was extracted by an older text engine that discarded paragraph boundaries. Re-upload the PDF so DecodEbook can preserve paragraph breaks from the original layout.");
  }

  const local = extractChapterFromSource(file.content, chapter, allChapters);
  if (local && local.length > 0) return local;

  throw new Error(`Could not locate the verbatim text for "${chapter.title}" in the extracted source. Try a text-based EPUB/TXT, or check that the detected chapter titles match the book.`);
};

export const generatePodcastAudio = async (
  file: FileContext,
  chapter: Chapter,
  tone: string = 'Engaging',
  hosts: { host1: string, voice1: string, desc1?: string, host2: string, voice2: string, desc2?: string },
  language: string = 'English'
): Promise<{ audio: string; script: string; episodeTitle: string }> => {
  return withRetry(async () => {
    const scriptModel = resolveModel('podcastScript');
    const usageId = newUsageId();
    const ai = await getAi({ usageId, action: 'podcastScript', model: scriptModel, book: _currentBook || undefined, session: _usageSession || undefined });
    const scriptResponse = await ai.models.generateContent({
      model: scriptModel,
      contents: {
        parts: [
          getFilePart(file),
          { text: `Create a ${tone} podcast dialogue about the chapter "${chapter.title}" in ${language}. Keep the conversation concise (max 600 words). Use EXACTLY these two hosts:\n\n- ${hosts.host1}: ${hosts.desc1 || 'leads the discussion'}\n- ${hosts.host2}: ${hosts.desc2 || 'responds and adds counterpoints'}\n\nCHARACTER CONSISTENCY RULES (CRITICAL):\n- ${hosts.host1} speaks with the SAME energy, vocabulary, and attitude in EVERY single line. If they are gruff, they are gruff even when agreeing. If they are enthusiastic, they stay enthusiastic even when confused. NEVER let a character become generic or neutral.\n- ${hosts.host2} speaks with the SAME energy, vocabulary, and attitude in EVERY single line. Their style must be distinctly DIFFERENT from ${hosts.host1} in sentence length, word choice, and tone.\n- Write each line so it could ONLY have been said by that character. A reader should identify the speaker without seeing the name prefix.\n- Alternate speakers frequently. Never have the same speaker talk for more than 3 consecutive lines.\n\nFORMAT RULES:\n- Output JSON with 'episodeTitle' and 'script'.\n- The 'script' MUST be formatted as lines of dialogue, one per line.\n- Each line MUST start with EXACTLY "${hosts.host1}:" or "${hosts.host2}:" (no bold, no brackets, no variations).\n- Example:\n${hosts.host1}: Welcome to the show!\n${hosts.host2}: Thanks for having me.` }
        ]
      },
      config: {
        responseMimeType: "application/json",
        ...(modelRequiresThinking(scriptModel) ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            episodeTitle: { type: Type.STRING },
            script: { type: Type.STRING }
          },
          required: ["episodeTitle", "script"]
        }
      }
    });

    trackUsage('podcastScript', extractTokens(scriptResponse), scriptModel, undefined, undefined, usageId);
    const parsedResponse = safeJsonParse<{ script: string, episodeTitle: string }>(scriptResponse.text || "{}");
    if (!parsedResponse.script) throw new Error("Script generation failed");

    // Parse script into speaker/text lines
    const cleanedLines = parsedResponse.script
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .split('\n')
      .filter((l: string) => l.trim().length > 0);

    const voiceMap: Record<string, string> = {
      [hosts.host1.toLowerCase()]: hosts.voice1,
      [hosts.host2.toLowerCase()]: hosts.voice2,
    };

    const dialogueLines: { speaker: string; text: string; voice: string }[] = [];
    for (const line of cleanedLines) {
      const m = line.match(new RegExp(`^\\s*(?:${hosts.host1}|${hosts.host2})\\s*:\\s*`, 'i'));
      if (!m) continue;
      const rawName = m[0].replace(/:\s*$/, '').trim();
      const voice = voiceMap[rawName.toLowerCase()] || hosts.voice1;
      const text = line.substring(m[0].length).trim();
      if (text) dialogueLines.push({ speaker: rawName, text, voice });
    }

    if (dialogueLines.length === 0) throw new Error("No dialogue lines parsed from script");

    // Per-line single-speaker TTS — each line locked to its voice
    const BATCH_SIZE = 3;
    const audioChunks: string[] = [];
    for (let i = 0; i < dialogueLines.length; i += BATCH_SIZE) {
      const batch = dialogueLines.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(line => generateSpeech(line.text, line.voice))
      );
      audioChunks.push(...results);
    }

    // Normalize each segment individually, then concatenate
    const TARGET_PEAK = 0.9 * 32767;
    const normalizedSegments: Uint8Array[] = [];
    for (const b64 of audioChunks) {
      const raw = window.atob(b64);
      const sampleCount = Math.floor(raw.length / 2);
      const samples = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
      }
      let peak = 0;
      for (let i = 0; i < sampleCount; i++) {
        const abs = Math.abs(samples[i]);
        if (abs > peak) peak = abs;
      }
      if (peak > 0 && peak < 16384) {
        const gain = TARGET_PEAK / peak;
        for (let i = 0; i < sampleCount; i++) {
          samples[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * gain)));
        }
      }
      normalizedSegments.push(new Uint8Array(samples.buffer));
    }

    const totalLen = normalizedSegments.reduce((acc, s) => acc + s.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const seg of normalizedSegments) {
      combined.set(seg, offset);
      offset += seg.length;
    }
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < combined.length; i += CHUNK) {
      binary += String.fromCharCode(...combined.subarray(i, i + CHUNK));
    }
    const finalAudio = window.btoa(binary);

    // NOTE: the podcast audio is billed by the per-line generateSpeech('tts') calls above (each is a
    // real TTS API call). The old aggregate trackUsage('podcastAudio') here double-charged the same
    // dialogue, so it's removed.
    return { audio: finalAudio, script: parsedResponse.script, episodeTitle: parsedResponse.episodeTitle };
  });
};

export const extractConcepts = async (file: FileContext, chapter: Chapter): Promise<Concept[]> => {
  return withRetry(async () => {
    const usageId = newUsageId();
    const ai = await getAi({ usageId, action: 'extractConcepts', model: 'gemini-3-flash-preview', book: _currentBook || undefined, session: _usageSession || undefined });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          getChapterPart(file, chapter),
          { text: `Identify 3 key concepts from "${chapter.title}". Return as JSON array of objects with 'term', 'definition', and 'visualPrompt'.` }
        ]
      },
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              term: { type: Type.STRING },
              definition: { type: Type.STRING },
              visualPrompt: { type: Type.STRING }
            },
            required: ["term", "definition", "visualPrompt"]
          }
        }
      }
    });
    trackUsage('extractConcepts', extractTokens(response), 'gemini-3-flash-preview', undefined, undefined, usageId);
    return safeJsonParse<Concept[]>(response.text || "[]");
  });
};

const isFalImageModel = (model: string) => model.startsWith('fal-ai/');

export const generateConceptImage = async (visualPrompt: string, style: string = 'Digital Art', aspectRatio: string = '1:1'): Promise<string> => {
  if (isFalImageModel(_imageModel)) {
    return withRetry(async () => {
      const authHeaders = await getAuthHeaders();
      const res = await fetch('/api/fal/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          model: _imageModel,
          prompt: `${style} style: ${visualPrompt}`,
          aspect_ratio: aspectRatio,
          resolution: '2K',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Image generation failed' }));
        const message = (err as any).error || 'fal.ai image generation failed';
        if (/insufficient credits/i.test(message)) throw new Error(INSUFFICIENT_CREDITS);
        if (res.status === 429) throw new Error('The AI service is busy right now — please wait a moment and try again.');
        throw new Error(message);
      }
      const data = await res.json() as any;
      trackUsage('generateImage');
      return data.imageUrl;
    });
  }

  if (typeof (window as any).aistudio !== 'undefined') {
    const hasKey = await (window as any).aistudio.hasSelectedApiKey();
    if (!hasKey) await (window as any).aistudio.openSelectKey();
  }

  return withRetry(async () => {
    const usageId = newUsageId();
    const ai = await getAi({ usageId, action: 'generateImage', model: _imageModel, book: _currentBook || undefined, session: _usageSession || undefined, images: 1 });
    const response = await ai.models.generateContent({
      model: _imageModel,
      contents: { parts: [{ text: `${style} style: ${visualPrompt}` }] },
      config: {
          imageConfig: {
              aspectRatio: aspectRatio as any,
              imageSize: '4K'
          }
      }
    });
    trackUsage('generateImage', extractTokens(response), _imageModel, undefined, undefined, usageId);
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
    }
    throw new Error("No image generated");
  });
};


export const translateDictionary = async (entries: DictionaryEntry[], targetLanguage: string): Promise<DictionaryEntry[]> => {
  if (entries.length === 0) return [];
  return withRetry(async () => {
    const text = await callUnifiedLLM({
      contents: {
        parts: [{ text: `Translate the following dictionary entries to ${targetLanguage}. Return JSON array.\n\nEntries: ${JSON.stringify(entries)}` }]
      },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              word: { type: Type.STRING },
              context: { type: Type.STRING },
              definition: { type: Type.STRING }
            },
            required: ["word", "context", "definition"]
          }
        }
      }
    });
    return safeJsonParse<DictionaryEntry[]>(text || "[]");
  });
};

// TTS uses Gemini flash TTS in BOTH modes.
export const generateSpeech = async (text: string, voiceName: string = 'Kore', signal?: AbortSignal): Promise<string> => {
  return withRetry(async () => {
    const usageId = newUsageId();
    const cjk = countCjkChars(text);
    const ai = await getAi({ usageId, action: 'tts', model: _ttsModel, book: _currentBook || undefined, session: _usageSession || undefined, chars: text.length, cjkChars: cjk });
    const response = await ai.models.generateContent({
      model: _ttsModel,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
        // Cancels the in-flight request when the user hits STOP → the promise rejects BEFORE
        // trackUsage below, so a stopped batch isn't billed.
        abortSignal: signal,
      },
    });
    trackUsage('tts', extractTokens(response), _ttsModel, { chars: text.length, cjkChars: cjk }, undefined, usageId);
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("Failed to generate audio");
    return base64Audio;
  }, 3, 2000, signal);
};

export const translateText = async (text: string, targetLanguage: string): Promise<string> => {
  return withRetry(async () => {
    return callUnifiedLLM({
      contents: {
        parts: [{ text: `Translate the following to ${targetLanguage}. Return ONLY translation.\n\n${text}` }]
      },
      creditAction: 'translate',
    });
  });
};

export const getQuickDefinition = async (text: string, language: string): Promise<string> => {
  return withRetry(async () => {
    const result = await callUnifiedLLM({
      contents: {
        parts: [{ text: `Act as a reading assistant. Analyze and define this text in ${language}: "${text}". Output strictly a concise, insightful definition or explanation. No introductory phrases.` }]
      },
      creditAction: 'quickDefinition',
    });
    if (!result?.trim()) throw new Error("Empty definition generated");
    return result.trim();
  });
};

// One Define click = ONE model call (1 credit). Returns the definition in the
// text's own language and, when a target language is set, its translation too —
// asked for together in a single request instead of two parallel calls (which
// billed 2 credits + logged two rows for a single lookup).
export const getBilingualDefinition = async (
  text: string,
  targetLanguage: string | null,
): Promise<{ original: string; translated: string | null }> => {
  return withRetry(async () => {
    if (!targetLanguage) {
      const result = await callUnifiedLLM({
        contents: { parts: [{ text: `Act as a reading assistant. Analyze and define this text in its own language: "${text}". Output strictly a concise, insightful definition or explanation. No introductory phrases.` }] },
        creditAction: 'quickDefinition',
      });
      if (!result?.trim()) throw new Error("Empty definition generated");
      return { original: result.trim(), translated: null };
    }
    const result = await callUnifiedLLM({
      contents: { parts: [{ text: `Act as a reading assistant. For the text "${text}", give two concise, insightful definitions: "original" in the text's own language, and "translated" in ${targetLanguage}. No introductory phrases.` }] },
      creditAction: 'quickDefinition',
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: { original: { type: Type.STRING }, translated: { type: Type.STRING } },
          required: ['original', 'translated'],
        },
      },
    });
    const parsed = JSON.parse(result);
    if (!parsed?.original) throw new Error("Empty definition generated");
    return { original: String(parsed.original).trim(), translated: parsed.translated ? String(parsed.translated).trim() : null };
  });
};

export const batchGetDefinitions = async (items: { id: string, text: string }[], language: string): Promise<Record<string, string>> => {
  if (items.length === 0) return {};
  return withRetry(async () => {
    const text = await callUnifiedLLM({
      contents: {
        parts: [{ text: `Provide concise one-sentence definitions in ${language} for the following items. Return a JSON array of objects, each containing an "id" field (matching the input) and a "definition" field. \n\nItems: ${JSON.stringify(items)}` }]
      },
      creditAction: 'quickDefinition',
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              definition: { type: Type.STRING }
            },
            required: ["id", "definition"]
          }
        }
      }
    });
    if (!text) return {};
    const rawResults = safeJsonParse<{ id: string, definition: string }[]>(text);
    const mapping: Record<string, string> = {};
    rawResults.forEach(r => { mapping[r.id] = r.definition; });
    return mapping;
  });
};

export const hasValidKeyForVeo = async (): Promise<boolean> => {
  if (useProxy()) return true;
  if (typeof (window as any).aistudio !== 'undefined') {
    return await (window as any).aistudio.hasSelectedApiKey();
  }
  return !!getDirectKey();
};

export const requestVeoKey = async (): Promise<void> => {
  if (typeof (window as any).aistudio !== 'undefined') {
    await (window as any).aistudio.openSelectKey();
  }
};

export const generateSummaryVideo = async (
  file: FileContext,
  chapter: Chapter,
  onStatus: (status: string) => void,
  style: string = 'Cinematic',
  language: string = 'English',
  resolution: '720p' | '1080p' = '720p'
): Promise<Blob> => {
  // One per-execution session so the video prompt + the render fold into ONE "Video generation"
  // history line, and two separate videos never merge into one.
  beginUsageSession('Video generation');
  try {
  return await withRetry(async () => {
    const ai = await getAi();
    onStatus("Crafting visual narrative...");
    // Dedicated client for the prompt call ONLY, so the worker meters videoPrompt (a text
    // generateContent — safe to buffer) without tagging the generateVideos/poll requests.
    const vpUsageId = newUsageId();
    const promptAi = await getAi({ usageId: vpUsageId, action: 'videoPrompt', model: 'gemini-3-flash-preview', book: _currentBook || undefined, session: _usageSession || undefined });
    const promptResponse = await promptAi.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          getChapterPart(file, chapter),
          { text: `Create a cinematic visual description for a summary of "${chapter.title}" in ${style} style. IMPORTANT: The output video MUST NOT contain any text, subtitles, captions, or watermarks. Focus entirely on purely visual storytelling and atmosphere.` }
        ]
      },
      config: {
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    trackUsage('videoPrompt', extractTokens(promptResponse), 'gemini-3-flash-preview', undefined, undefined, vpUsageId);
    const videoPrompt = promptResponse.text || `Visual summary of ${chapter.title} in style of ${style}`;

    onStatus("Transmitting to Veo Core...");
    // Meter Veo at COMPLETION: poll the operation on a metered client so the worker records the
    // charge when the operation reports done. The worker reads `done` from a CLONE and streams the
    // original body untouched (safe — unlike the earlier buffer-and-return that broke playback).
    const usageId = newUsageId();
    const pollAi = await getAi({ usageId, action: 'videoVeo', model: _videoModel, book: _currentBook || undefined, session: _usageSession || undefined, seconds: VIDEO_SECONDS_DEFAULT });
    let operation = await ai.models.generateVideos({
      model: _videoModel,
      prompt: videoPrompt,
      config: {
        numberOfVideos: 1,
        resolution: resolution,
        aspectRatio: '16:9'
      }
    });

    while (!operation.done) {
      onStatus("Synthesizing temporal data...");
      await new Promise(resolve => setTimeout(resolve, 10000));
      operation = await pollAi.operations.getVideosOperation({operation: operation});
    }

    trackUsage('videoVeo', { total: 0, input: videoPrompt.length, output: 0 }, _videoModel, undefined, undefined, usageId);
    onStatus("Finalizing transmission...");
    const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
    if (!downloadLink) throw new Error('Video generation returned no download URL');
    const authHeaders = await getAuthHeaders();
    const response = useProxy()
      ? await fetch('/api/gemini/video-download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ uri: downloadLink }),
        })
      : await fetch(downloadLink, {
          headers: { 'x-goog-api-key': getDirectKey() },
        });
    return await assertVideoBlob(response);
  });
  } finally {
    endUsageSession();
  }
};

export const generateSeedanceVideo = async (
  file: FileContext,
  chapter: Chapter,
  onStatus: (status: string) => void,
  style: string = 'Cinematic',
  language: string = 'English',
  resolution: '720p' | '1080p' = '720p'
): Promise<Blob> => {
  // One per-execution session so prompt + render fold into ONE "Video generation" line.
  beginUsageSession('Video generation');
  try {
  onStatus("Crafting visual narrative...");
  const vpUsageId = newUsageId();
  const promptAi = await getAi({ usageId: vpUsageId, action: 'videoPrompt', model: 'gemini-3-flash-preview', book: _currentBook || undefined, session: _usageSession || undefined });
  const promptResponse = await promptAi.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: {
      parts: [
        getChapterPart(file, chapter),
        { text: `Create a cinematic visual description for a summary of "${chapter.title}" in ${style} style. IMPORTANT: The output video MUST NOT contain any text, subtitles, captions, or watermarks. Focus entirely on purely visual storytelling and atmosphere.` }
      ]
    },
    config: { thinkingConfig: { thinkingBudget: 0 } }
  });
  trackUsage('videoPrompt', extractTokens(promptResponse), 'gemini-3-flash-preview', undefined, undefined, vpUsageId);
  const videoPrompt = promptResponse.text || `Visual summary of ${chapter.title} in style of ${style}`;

  onStatus("Transmitting to Seedance Core...");
  const authHeaders = await getAuthHeaders();
  const createRes = await fetch('/api/seedance/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      model: _videoModel,
      prompt: videoPrompt,
      resolution,
      ratio: '16:9',
      duration: 5,
    }),
  });
  const { taskId, error } = await createRes.json() as any;
  if (/insufficient credits/i.test(error || '')) throw new Error(INSUFFICIENT_CREDITS);
  if (createRes.status === 429) throw new Error('The AI service is busy right now — please wait a moment and try again.');
  if (!createRes.ok || !taskId) throw new Error(error || 'Failed to create Seedance task');

  // Meter at COMPLETION: the poll requests carry the metering headers so the worker records the
  // charge on the poll that reports 'succeeded' (not on download). Same usageId as the client's
  // trackUsage below → deduped to one row.
  const seedanceAction = _videoModel.includes('fast') ? 'videoSeedanceFast' : 'videoSeedance';
  const usageId = newUsageId();
  const dbHeaders = usageHeaders({ usageId, action: seedanceAction, model: _videoModel, book: _currentBook || undefined, session: _usageSession || undefined, seconds: VIDEO_SECONDS_DEFAULT });
  let status = 'queued';
  let videoUrl: string | null = null;
  let tokensUsed = 0;
  while (status !== 'succeeded' && status !== 'failed') {
    onStatus("Synthesizing temporal data...");
    await new Promise(resolve => setTimeout(resolve, 10000));
    const pollRes = await fetch('/api/seedance/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders, ...dbHeaders },
      body: JSON.stringify({ taskId }),
    });
    const pollData = await pollRes.json() as any;
    status = pollData.status;
    videoUrl = pollData.videoUrl;
    if (pollData.tokensUsed) tokensUsed = pollData.tokensUsed;
  }

  if (status === 'failed' || !videoUrl) throw new Error('Seedance video generation failed');
  trackUsage(seedanceAction, { total: tokensUsed, input: videoPrompt.length, output: 0 }, _videoModel, undefined, undefined, usageId);

  onStatus("Finalizing transmission...");
  const dlRes = await fetch('/api/seedance/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ url: videoUrl }),
  });
  return await assertVideoBlob(dlRes);
  } finally {
    endUsageSession();
  }
};

// Stateless chat session: holds the document context + running conversation history. Each turn is a
// fresh callUnifiedLLM call (Gemini is stateless under the hood, so this is token-equivalent to the
// old ai.chats.sendMessage) — which means every message gets its own usage_id and is worker-metered
// like every other generation (needed for server-authoritative billing). Same external interface as
// before, so AIAssistant only changes the state type.
const CHAT_SYSTEM_INSTRUCTION = "You are a reading assistant. Answer strictly based on the provided document. Format replies in clean Markdown so they're easy to scan: use short paragraphs, bullet points or numbered lists when listing multiple items or steps, and **bold** for key terms. Never dump everything into one dense block.";
export interface ChatSession { docParts: Part[]; history: Content[]; }

export const createChatSession = async (file: FileContext, history: Content[] = []): Promise<ChatSession> => {
  return { docParts: [getFilePart(file)], history: [...history] };
};

export const sendMessageToChat = async (chat: ChatSession, message: string | Part[], signal?: AbortSignal): Promise<string> => {
  const userParts: Part[] = typeof message === 'string' ? [{ text: message }] : message;
  // The document is the first user turn (as before), then the accumulated dialogue, then this message.
  const contents: Content[] = [
    { role: 'user', parts: chat.docParts },
    ...chat.history,
    { role: 'user', parts: userParts },
  ];
  const text = await callUnifiedLLM({
    model: resolveModel('chat'),
    contents,
    systemInstruction: CHAT_SYSTEM_INSTRUCTION,
    creditAction: 'chat',
    creditSession: `Chat#${newUsageId()}`, // one credit-history line per message
    signal,
  });
  // Persist the turn for continuity on the next message (the SDK Chat did this internally).
  chat.history.push({ role: 'user', parts: userParts });
  chat.history.push({ role: 'model', parts: [{ text }] });
  return text;
};

