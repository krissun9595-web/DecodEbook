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
  'gemini-3-flash':        { in: 150, out: 750 }, // ⚠️ VERIFY vs Google invoice
  'gemini-3.1-flash':      { in: 150, out: 750 },
  'claude-sonnet':         { in: 200, out: 1000 },
  'claude':                { in: 200, out: 1000 }, // generic claude fallback
  'gemini-3-pro':          { in: 200, out: 1200 },
  'gpt-4o':                { in: 250, out: 1000 },
};
const TEXT_FALLBACK = { in: 150, out: 750 }; // treat unknown text models as flash-tier

// TTS — USD cents per 1M characters
export const TTS_PRICING: Record<string, number> = {
  'google-standard':      400,
  'gemini-3.1-flash-tts': 1200,
  'gemini':               1200, // generic gemini-tts fallback
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
  'veo-3.1-fast': 5,
  'veo-3.1-lite': 5,
  'kling':        12,
  'runway':       20,
  'seedance':     4,  // ⚠️ ESTIMATE ~$0.04/s (480/720p) — token-metered; VERIFY in BytePlus billing console
  'sora':         70,
  'veo-3.1':      75,
  'veo':          75,
};
const VIDEO_FALLBACK = 5;

// Typical token footprint per TEXT action → gives a predictable, pre-checkable
// per-(action, model) credit price. Tune from usage_logs avg input/output tokens.
export const ACTION_TOKENS: Record<string, { in: number; out: number }> = {
  translate:            { in: 600,  out: 600 },
  chat:                 { in: 800,  out: 400 },
  quickDefinition:      { in: 200,  out: 150 },
  analyzeBookStructure: { in: 6000, out: 1500 },
  extractChapterText:   { in: 4000, out: 4000 },
  extractConcepts:      { in: 4000, out: 800 },
  extractDictionary:    { in: 4000, out: 800 },
  generateMindMap:      { in: 3000, out: 800 },
  podcastScript:        { in: 3000, out: 3000 },
  videoPrompt:          { in: 400,  out: 200 },
  translateFigureText:  { in: 200,  out: 200 },
};
const ACTION_TOKENS_FALLBACK = { in: 500, out: 500 };

const TTS_ACTIONS = new Set(['tts', 'podcastAudio']);
const IMAGE_ACTIONS = new Set(['generateImage', 'redrawFigureTranslated']);
const VIDEO_ACTIONS = new Set(['videoVeo', 'videoSeedance', 'videoSeedanceFast']);

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

export function textCostCents(model: string, inTok: number, outTok: number): number {
  const r = rateFor(TEXT_PRICING, model, TEXT_FALLBACK);
  return (inTok * r.in + outTok * r.out) / 1_000_000;
}

export interface Units { inTok?: number; outTok?: number; chars?: number; images?: number; seconds?: number; }

function modalityCostCents(action: string, model: string, u: Units): number {
  if (TTS_ACTIONS.has(action))   return ((u.chars ?? 0) / 1_000_000) * rateFor(TTS_PRICING, model, TTS_FALLBACK);
  if (IMAGE_ACTIONS.has(action)) return (u.images ?? 1) * rateFor(IMAGE_PRICING, model, IMAGE_FALLBACK);
  if (VIDEO_ACTIONS.has(action)) return (u.seconds ?? VIDEO_SECONDS_DEFAULT) * rateFor(VIDEO_PRICING, model, VIDEO_FALLBACK);
  return textCostCents(model, u.inTok ?? 0, u.outTok ?? 0);
}

// Credits to CHARGE for an action on a model. Predictable per (action, model):
// text uses the typical-token footprint; media uses the measured/estimated unit.
export function creditsForAction(action: string, model: string, u: Units = {}): number {
  if (TTS_ACTIONS.has(action) || IMAGE_ACTIONS.has(action) || VIDEO_ACTIONS.has(action)) {
    return creditsFromCents(modalityCostCents(action, model, u));
  }
  const key = action.startsWith('text:') ? 'translate' : action;
  const t = ACTION_TOKENS[key] ?? ACTION_TOKENS_FALLBACK;
  return creditsFromCents(textCostCents(model, t.in, t.out));
}

// Real cost in cents for LOGGING (uses measured units where the caller has them).
export function costCentsForAction(action: string, model: string, u: Units = {}): number {
  return Math.round(modalityCostCents(action, model, u));
}
