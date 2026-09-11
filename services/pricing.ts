// ============================================================================
// Cost-derived credit model — single source of truth for what a call costs and
// how many credits to charge. Credits are DERIVED from each model's real unit
// cost, so adding a new model = adding one registry row; it prices itself.
//
//   credits = max(1, ceil(realCostCents * MARGIN / CENTS_PER_CREDIT))
//
// Verify unit costs against provider invoices before shipping — see CREDIT_MODEL.md.
// ============================================================================

export const CENTS_PER_CREDIT = 1; // 1 credit ~= $0.01 revenue (Pro $9.99 / 1000 credits)
export const MARGIN = 3;           // charge ~3x real API cost (gross-margin target)
export const VIDEO_SECONDS_DEFAULT = 8;

// ---- Registries: REAL unit cost by model ----------------------------------

// Text LLMs — USD cents per 1M tokens {in, out}
export const TEXT_PRICING: Record<string, { in: number; out: number }> = {
  'qwen3-flash':           { in: 3,   out: 13 },
  'deepseek-v4-pro':       { in: 132, out: 396 }, // DeepSeek published peak, cache-miss ($1.32 / $3.96 per 1M)
  'deepseek-v4-flash':     { in: 44,  out: 132 }, // peak, cache-miss ($0.44 / $1.32 per 1M); off-peak is 50% less
  'gemini-2.5-flash-lite': { in: 10,  out: 40 },
  'gpt-4o-mini':           { in: 15,  out: 60 },
  'mistral-small':         { in: 15,  out: 60 },
  'deepseek-v3':           { in: 27,  out: 110 },
  'deepseek':              { in: 27,  out: 110 }, // generic deepseek fallback
  'claude-haiku':          { in: 100, out: 500 },
  'glm-5':                 { in: 140, out: 440 },
  'qwen3-max':             { in: 200, out: 600 },
  'qwen':                  { in: 200, out: 600 }, // generic qwen fallback
  'gemini-3-flash':        { in: 70,  out: 423 },  // Google invoice Aug'26: $0.70 / $4.23 per M
  'gemini-3.1-flash':      { in: 70,  out: 423 },  // assume same tier as 3-flash
  'claude-sonnet':         { in: 200, out: 1000 },
  'claude':                { in: 200, out: 1000 }, // generic claude fallback
  'gemini-3-pro':          { in: 285, out: 1690 }, // Google invoice Aug'26: ~$2.85 / ~$16.9 per M (small sample; refine)
  'gemini-3.1-pro':        { in: 285, out: 1690 }, // 3.1 Pro (replaced 3-pro-preview); assume same tier until invoiced
  'gpt-4o':                { in: 250, out: 1000 },
};
const TEXT_FALLBACK = { in: 150, out: 750 }; // treat unknown text models as flash-tier

// TTS — USD cents per 1M characters
export const TTS_PRICING: Record<string, number> = {
  'google-standard':      400,
  // NOTE: Gemini TTS is NOT priced here — it's audio-token billed and computed
  // script-aware in ttsCostCents(). These entries are the flat per-char providers only.
  'tts-1-hd':             3000,
  'tts-1':                1500,
  'elevenlabs-flash':     5000,
  'elevenlabs':           10000,
};
const TTS_FALLBACK = 1200;

// Image — USD cents per image
export const IMAGE_PRICING: Record<string, number> = {
  'gpt-image-1-mini':       0.5,
  'imagen-4-fast':          2,   // separate Imagen 4 model — only if added to options
  'gemini-2.5-flash-image': 4,   // "Nano Banana" (standard) — ~81% cheaper than Pro, model-swap only
  'gemini-3.1-flash-image': 4.5, // "Nano Banana 2"
  'imagen-4':               4,
  'gpt-image':              4,
  'ideogram':               5,
  'flux':                   5.5,
  'gemini-3-pro-image':     13,  // "Nano Banana Pro" (current default) — ~$0.13/img @1-2K, $0.24 @4K
  'gemini':                 13,  // generic gemini-image fallback (assume Pro tier)
};
const IMAGE_FALLBACK = 20;

// Video — USD cents per second
export const VIDEO_PRICING: Record<string, number> = {
  'veo-3.1-fast': 14,  // Google invoice Aug'26: 720p + audio ~$0.14/s
  'veo-3.1-lite': 5,
  'kling':        12,
  'runway':       20,
  // BytePlus Seedance — verified per-second @720p 16:9, input WITHOUT video. Higher
  // resolutions cost more (2.0: 1080p ~37¢/s, 4K ~78¢/s) — resolution-aware pricing is
  // a follow-up before pushing 1080p; these keep us safe at the 720p default.
  'dreamina-seedance-2-5':      23,  // Seedance 2.5 720p ~$0.231/s
  'dreamina-seedance-2-0-fast': 12,  // 2.0 Fast 720p ~$0.12/s
  'dreamina-seedance-2-0-mini': 8,   // 2.0 Mini 720p ~$0.08/s
  'dreamina-seedance-2-0':      15,  // 2.0 720p ~$0.15/s (current default)
  'seedance-1-0-pro-fast':      3,   // 1.0 Pro Fast 720p ~$0.021/s
  'seedance-1-0-pro':           6,   // 1.0 Pro 720p ~$0.051/s
  'seedance':                   15,  // generic fallback → 2.0 720p
  'sora':         70,
  'veo-3.1':      75,
  'veo':          75,
};
const VIDEO_FALLBACK = 5;

// Typical token footprint per TEXT action → gives a predictable, pre-checkable
// per-(action, model) credit price. Tune from usage_logs avg input/output tokens.
export const ACTION_TOKENS: Record<string, { in: number; out: number }> = {
  translate:            { in: 1200, out: 1100 }, // calibrated from usage_logs (139-call batch avg ~1233/1096)
  chat:                 { in: 800,  out: 400 },
  quickDefinition:      { in: 200,  out: 150 },
  analyzeBookStructure: { in: 20000, out: 2900 }, // calibrated (1 sample ~29.7k in — conservative; refine w/ more data)
  extractChapterText:   { in: 4000, out: 4000 },
  extractConcepts:      { in: 4000, out: 800 },
  podcastScript:        { in: 3000, out: 3000 },
  videoPrompt:          { in: 400,  out: 200 },
  translateFigureText:  { in: 200,  out: 200 },
};
const ACTION_TOKENS_FALLBACK = { in: 500, out: 500 };

const TTS_ACTIONS = new Set(['tts', 'podcastAudio']);
const IMAGE_ACTIONS = new Set(['generateImage', 'redrawFigureTranslated']);
const VIDEO_ACTIONS = new Set(['videoVeo', 'videoSeedance', 'videoSeedanceFast']);
// Text actions whose input scales with the whole file/chapter (a fixed footprint can't
// approximate them), so they're charged on ACTUAL measured tokens instead.
// Measured (actual-token) billing: file-scaled actions AND reasoning-model actions whose
// output is inflated by thinking tokens (a fixed footprint would undercharge Premium/pro).
const MEASURED_TEXT_ACTIONS = new Set([
  'videoPrompt', 'podcastScript', 'analyzeBookStructure', 'chat',
  'extractConcepts', 'extractChapterText', // send the whole chapter → footprint was ~22x too low (real leak)
  'translate', // measured: Premium (pro, output-heavy) footprint over-charged short pages 2-3x; Balanced (deepseek) stays at the 1-credit floor either way. Falls back to footprint when tokens aren't surfaced.
]);

// Longest-prefix match so 'gpt-4o-mini' wins over 'gpt-4o', 'veo-3.1-fast' over 'veo'.
function rateFor<T>(reg: Record<string, T>, model: string, fallback: T): T {
  const hit = Object.keys(reg)
    .filter(k => (model || '').startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? reg[hit] : fallback;
}

export function creditsFromCents(cents: number): number {
  return Math.max(1, Math.ceil((cents * MARGIN) / CENTS_PER_CREDIT));
}

// Implicit context-cache pass-through: when a request re-uses a prefix (e.g. the whole book
// resent every chat message), Gemini bills the matched tokens at the model's "Context caching
// price" row instead of the "Input price" row. For every current Gemini 3.x tier that ratio is
// exactly one-tenth (pricing.md.txt Gemini 3.1 Pro Preview: input $2.00/$4.00 vs cached
// $0.20/$0.40). So a cached input token costs 10% of a fresh one. Google surfaces the hit count
// in usageMetadata.cachedContentTokenCount (aka usage.total_cached_tokens); we split the prompt
// into (fresh @ full rate) + (cached @ 10%) so the charge tracks what Google actually bills.
export const CACHED_INPUT_FRACTION = 0.1;

export function textCostCents(model: string, inTok: number, outTok: number, cachedTok: number = 0): number {
  const r = rateFor(TEXT_PRICING, model, TEXT_FALLBACK);
  const cached = Math.min(Math.max(cachedTok, 0), inTok); // cached is a SUBSET of the (total) input tokens
  const fresh = inTok - cached;
  return (fresh * r.in + cached * r.in * CACHED_INPUT_FRACTION + outTok * r.out) / 1_000_000;
}

export interface Units { inTok?: number; outTok?: number; cachedTok?: number; chars?: number; cjkChars?: number; images?: number; seconds?: number; }

// Gemini TTS is billed by AUDIO-OUTPUT tokens (Google invoice: ~$28.35/M audio-tok).
// Audio tokens scale with spoken DURATION, so per source character they vary by script:
// CJK characters ~= one token each and expand ~7x into audio tokens; Latin runs ~4
// chars/token → ~2.65 audio-tok/char. Costing by the source text's script keeps TTS
// both predictable (known before synthesis) and accurate across languages.
const GEMINI_TTS_AUDIO_CENTS_PER_M = 2835; // $28.35 / M audio-output-tokens
const AUDIO_TOK_PER_CJK_CHAR = 7.1;
const AUDIO_TOK_PER_LATIN_CHAR = 2.65;

function ttsCostCents(model: string, u: Units): number {
  const chars = u.chars ?? 0;
  if (model.startsWith('gemini')) { // audio-token billed → script-aware estimate
    const cjk = Math.min(chars, u.cjkChars ?? 0);
    const audioTokens = cjk * AUDIO_TOK_PER_CJK_CHAR + (chars - cjk) * AUDIO_TOK_PER_LATIN_CHAR;
    return (audioTokens / 1_000_000) * GEMINI_TTS_AUDIO_CENTS_PER_M;
  }
  return (chars / 1_000_000) * rateFor(TTS_PRICING, model, TTS_FALLBACK); // flat per-char (BytePlus/Google-std/ElevenLabs)
}

function modalityCostCents(action: string, model: string, u: Units): number {
  if (TTS_ACTIONS.has(action))   return ttsCostCents(model, u);
  if (IMAGE_ACTIONS.has(action)) return (u.images ?? 1) * rateFor(IMAGE_PRICING, model, IMAGE_FALLBACK);
  if (VIDEO_ACTIONS.has(action)) return (u.seconds ?? VIDEO_SECONDS_DEFAULT) * rateFor(VIDEO_PRICING, model, VIDEO_FALLBACK);
  return textCostCents(model, u.inTok ?? 0, u.outTok ?? 0, u.cachedTok ?? 0);
}

// Discrete "generate X" media/creative actions are rounded UP to a clean multiple of 5
// (small % on these already-expensive actions, nicer UX). The high-frequency reading-loop
// text (translate, definitions, chat, extraction, read-aloud TTS) stays cost-derived so a
// per-sentence action isn't inflated 5x.
const ROUND5_ACTIONS = new Set([
  'generateImage', 'redrawFigureTranslated',
  'videoVeo', 'videoSeedance', 'videoSeedanceFast',
  'podcastScript', 'podcastAudio',
]);

// Credits to CHARGE for an action on a model. Predictable per (action, model):
// text uses the typical-token footprint; media uses the measured/estimated unit.
export function creditsForAction(action: string, model: string, u: Units = {}): number {
  const key = action.startsWith('text:') ? 'translate' : action;
  let credits: number;
  if (TTS_ACTIONS.has(action) || IMAGE_ACTIONS.has(action) || VIDEO_ACTIONS.has(action)) {
    credits = creditsFromCents(modalityCostCents(action, model, u));
  } else if (MEASURED_TEXT_ACTIONS.has(key) && ((u.inTok ?? 0) + (u.outTok ?? 0) > 0)) {
    credits = creditsFromCents(textCostCents(model, u.inTok ?? 0, u.outTok ?? 0, u.cachedTok ?? 0)); // real tokens (file-scaled); cached prefix billed at 10%
  } else {
    const t = ACTION_TOKENS[key] ?? ACTION_TOKENS_FALLBACK;
    credits = creditsFromCents(textCostCents(model, t.in, t.out));
  }
  if (ROUND5_ACTIONS.has(key)) credits = Math.ceil(credits / 5) * 5;
  return credits;
}

// ============================================================================
// PRE-CHECK GATE COST per action. This is what the balance is checked against
// BEFORE a call runs (worker checkCreditBalance + client ensureCredits), so it
// must approximate the ACTUAL charge — which is metered on real tokens/seconds
// and only known AFTER the call. Single source of truth: both the worker gate
// and the client pre-check import this, so gate == gate.
//
// Calibrated from real usage_logs (avg/max credits actually charged), NOT from
// the small footprint reference — because measured actions send the whole
// chapter (podcastScript really averaged ~116, max 185; the footprint ref said
// 5). Cheap high-frequency actions carry minimal headroom so we don't block a
// user who can genuinely afford them; expensive one-shots are set conservatively
// (≈ observed max + headroom) so a low-balance user can't start an unaffordable
// generation and leave us eating the difference. The ACTUAL charge is unchanged
// (creditsForAction on real units) — this only governs "can you start it".
// ============================================================================
export const GATE_COSTS: Record<string, number> = {
  // cheap / high-frequency text — gate ≈ actual (obs max in comments)
  translate: 7,                //  max 7
  quickDefinition: 1,          //  single call, flat 1 credit (was 2 when Define double-called)
  tts: 15,                     //  max 13 (per read-aloud batch)
  // measured text (whole-chapter input) — calibrated conservative from usage
  chat: 50,                    //  max 45 (premium pro + thinking)
  analyzeBookStructure: 15,    //  max 10
  extractConcepts: 50,         //  max 45
  // extractChapterText is LOCAL-only (slices already-extracted source text, no LLM call) → never
  // charged and never gated; intentionally NOT listed so it can't block a low-credit user.
  podcastScript: 200,          //  max 185
  videoPrompt: 50,             //  max 46
  // media / creative one-shots — conservative ≈ observed max
  generateImage: 40,           //  fixed per-image (obs max 40)
  redrawFigureTranslated: 40,
  podcastAudio: 100,           //  max 81
  videoSeedanceFast: 200,      //  cheaper seedance path
  videoSeedance: 360,          //  max 360
  videoVeo: 350,               //  max 340
};
const GATE_FALLBACK = 5;
export function gateCost(action: string): number {
  const key = action.startsWith('text:') ? 'translate' : action;
  return GATE_COSTS[key] ?? GATE_FALLBACK;
}

// Real cost in cents for LOGGING (uses measured units where the caller has them).
export function costCentsForAction(action: string, model: string, u: Units = {}): number {
  return Math.round(modalityCostCents(action, model, u));
}
