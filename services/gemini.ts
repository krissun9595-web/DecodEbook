
import { GoogleGenAI, Type, Modality, Chat, Content, Part } from "@google/genai";
import { BookStructure, Chapter, Concept, DictionaryEntry, FileContext, MindMapNode, NotebookItem } from "../types";
import { getSession, getUser, logUsage } from "./supabase";
import { CREDIT_COSTS } from "./stripe";
import { extractChapterFromSource } from "../utils/sourceIndex";
import { buildLocalTextStructure, buildStructureAnalysisText, isReadableChapterTitle } from "../utils/structureAnalysis";
import { PDF_TEXT_EXTRACTION_VERSION } from "../utils/sourceVersion";

let _userApiKey: string | null = null;
const DEFAULT_TEXT_MODEL = 'gemini-3-flash-preview';
let _selectedModel: string = 'gemini-3-flash-preview';
let _ttsModel: string = 'gemini-3.1-flash-tts-preview';
let _imageModel: string = 'gemini-3-pro-image-preview';
let _videoModel: string = 'veo-3.1-fast-generate-preview';
export const setGeminiApiKey = (key: string) => { _userApiKey = key; };
export const setLLMModel = (model: string) => { _selectedModel = model; };
export const setTTSModel = (model: string) => { _ttsModel = model; };
export const setImageModel = (model: string) => { _imageModel = model; };
export const setVideoModel = (model: string) => { _videoModel = model; };
export const getLLMModel = () => _selectedModel;
export const getVideoModel = () => _videoModel;
const getDirectKey = () => _userApiKey || process.env.API_KEY || '';
const useProxy = () => !getDirectKey();
const isGeminiModel = (model?: string) => !(model || _selectedModel).startsWith('gpt-') && !(model || _selectedModel).startsWith('claude-');
const isMissingProviderKeyError = (message: string): boolean =>
  /(?:openai|anthropic)\s+api\s+key\s+not\s+configured/i.test(message);

// Cost per million tokens (USD cents) by model family
const COST_PER_M: Record<string, { input: number; output: number }> = {
  'gemini-3-flash':   { input: 10, output: 40 },
  'gemini-3-pro':     { input: 125, output: 500 },
  'gemini-3.1-flash': { input: 10, output: 40 },
  'gpt-4o':           { input: 250, output: 1000 },
  'gpt-4o-mini':      { input: 15, output: 60 },
  'claude-sonnet':    { input: 300, output: 1500 },
  'claude-haiku':     { input: 80, output: 400 },
};

function estimateCostCents(inputTokens: number, outputTokens: number, model: string): number {
  const key = Object.keys(COST_PER_M).find(k => model.startsWith(k)) || 'gemini-3-flash';
  const rate = COST_PER_M[key];
  return Math.round((inputTokens * rate.input + outputTokens * rate.output) / 1_000_000);
}

interface TokenInfo {
  total: number;
  input: number;
  output: number;
}

const trackUsage = (action: string, tokens: TokenInfo | number = 0, model?: string) => {
  const t: TokenInfo = typeof tokens === 'number'
    ? { total: tokens, input: 0, output: 0 }
    : tokens;
  const costCents = (t.input || t.output) ? estimateCostCents(t.input, t.output, model || _selectedModel) : 0;
  const creditKey = action.startsWith('text:') ? 'translate' : action;
  const creditsCost = CREDIT_COSTS[creditKey] || 1;
  getUser().then(user => {
    if (user) logUsage(user.id, action, t.total, costCents, t.input, t.output, creditsCost);
  }).catch(() => {});
};

const extractTokens = (response: any): TokenInfo => {
  const meta = response?.usageMetadata;
  if (!meta) return { total: 0, input: 0, output: 0 };
  const input = meta.promptTokenCount || 0;
  const output = meta.candidatesTokenCount || 0;
  return { total: input + output, input, output };
};

const getAuthHeaders = async (): Promise<Record<string, string>> => {
  if (!useProxy()) return {};
  const session = await getSession();
  return session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {};
};

const getAi = async () => {
  if (useProxy()) {
    const headers = await getAuthHeaders();
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
}): Promise<string> => {
  const model = params.model || _selectedModel;

  if (isGeminiModel(model)) {
    const ai = await getAi();
    const config: any = {};
    if (params.systemInstruction) config.systemInstruction = params.systemInstruction;
    if (params.generationConfig) Object.assign(config, params.generationConfig);
    config.thinkingConfig = { thinkingBudget: 0 };
    const response = await ai.models.generateContent({ model, contents: params.contents, config });
    trackUsage(`text:${model}`, extractTokens(response), model);
    return response.text || '';
  }

  const headers = await getAuthHeaders();
  const res = await fetch('/api/llm/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
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
    if (model !== DEFAULT_TEXT_MODEL && isMissingProviderKeyError(message)) {
      console.warn(`${message}; falling back to ${DEFAULT_TEXT_MODEL}.`);
      return callUnifiedLLM({ ...params, model: DEFAULT_TEXT_MODEL });
    }
    throw new Error(message);
  }
  const data = await res.json() as any;
  const usage = data.usage || {};
  trackUsage(`text:${model}`, {
    total: usage.total_tokens || 0,
    input: usage.prompt_tokens || 0,
    output: usage.completion_tokens || 0,
  }, model);
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

export const analyzeBookStructure = async (file: FileContext): Promise<BookStructure> => {
  try {
    return await withRetry(async () => {
      const ai = await getAi();

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

      trackUsage('analyzeBookStructure', extractTokens(response), 'gemini-3-flash-preview');
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

export const translateSentences = async (sentences: string[], targetLanguage: string): Promise<string[]> => {
  if (sentences.length === 0) return [];
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
    return names.reduce((result, name, index) => {
      const tokenPattern = new RegExp(`\\[\\[${NAME_TOKEN_PREFIX}_${index}\\]\\]`, 'g');
      return result.replace(tokenPattern, name);
    }, text);
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
    const ai = await getAi();
    const scriptResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview", 
      contents: {
        parts: [
          getFilePart(file),
          { text: `Create a ${tone} podcast dialogue about the chapter "${chapter.title}" in ${language}. Keep the conversation concise (max 600 words). Use EXACTLY these two hosts:\n\n- ${hosts.host1}: ${hosts.desc1 || 'leads the discussion'}\n- ${hosts.host2}: ${hosts.desc2 || 'responds and adds counterpoints'}\n\nCHARACTER CONSISTENCY RULES (CRITICAL):\n- ${hosts.host1} speaks with the SAME energy, vocabulary, and attitude in EVERY single line. If they are gruff, they are gruff even when agreeing. If they are enthusiastic, they stay enthusiastic even when confused. NEVER let a character become generic or neutral.\n- ${hosts.host2} speaks with the SAME energy, vocabulary, and attitude in EVERY single line. Their style must be distinctly DIFFERENT from ${hosts.host1} in sentence length, word choice, and tone.\n- Write each line so it could ONLY have been said by that character. A reader should identify the speaker without seeing the name prefix.\n- Alternate speakers frequently. Never have the same speaker talk for more than 3 consecutive lines.\n\nFORMAT RULES:\n- Output JSON with 'episodeTitle' and 'script'.\n- The 'script' MUST be formatted as lines of dialogue, one per line.\n- Each line MUST start with EXACTLY "${hosts.host1}:" or "${hosts.host2}:" (no bold, no brackets, no variations).\n- Example:\n${hosts.host1}: Welcome to the show!\n${hosts.host2}: Thanks for having me.` }
        ]
      },
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
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

    trackUsage('podcastScript', extractTokens(scriptResponse), 'gemini-3-flash-preview');
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

    const totalChars = dialogueLines.reduce((sum, l) => sum + l.text.length, 0);
    trackUsage('podcastAudio', { total: totalChars, input: totalChars, output: dialogueLines.length }, _ttsModel);
    return { audio: finalAudio, script: parsedResponse.script, episodeTitle: parsedResponse.episodeTitle };
  });
};

export const extractConcepts = async (file: FileContext, chapter: Chapter): Promise<Concept[]> => {
  return withRetry(async () => {
    const ai = await getAi();
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          getFilePart(file),
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
    trackUsage('extractConcepts', extractTokens(response), 'gemini-3-flash-preview');
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
        throw new Error((err as any).error || 'fal.ai image generation failed');
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
    const ai = await getAi();
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
    trackUsage('generateImage', extractTokens(response), _imageModel);
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
    }
    throw new Error("No image generated");
  });
};

export const extractDictionary = async (file: FileContext, chapter: Chapter): Promise<DictionaryEntry[]> => {
  return withRetry(async () => {
    const ai = await getAi();
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          getFilePart(file),
          { text: `List 5 specialized terms from "${chapter.title}". Return JSON array of objects with 'word', 'context', and 'definition'.` }
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
              word: { type: Type.STRING },
              context: { type: Type.STRING },
              definition: { type: Type.STRING }
            },
            required: ["word", "context", "definition"]
          }
        }
      }
    });
    trackUsage('extractDictionary', extractTokens(response), 'gemini-3-flash-preview');
    return safeJsonParse<DictionaryEntry[]>(response.text || "[]");
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

export const generateSpeech = async (text: string, voiceName: string = 'Kore'): Promise<string> => {
  return withRetry(async () => {
    const ai = await getAi();
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
      },
    });
    trackUsage('tts', extractTokens(response), _ttsModel);
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("Failed to generate audio");
    return base64Audio;
  });
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
  return withRetry(async () => {
    const ai = await getAi();
    onStatus("Crafting visual narrative...");
    const promptResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          getFilePart(file),
          { text: `Create a cinematic visual description for a summary of "${chapter.title}" in ${style} style. IMPORTANT: The output video MUST NOT contain any text, subtitles, captions, or watermarks. Focus entirely on purely visual storytelling and atmosphere.` }
        ]
      },
      config: {
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    trackUsage('videoPrompt', extractTokens(promptResponse), 'gemini-3-flash-preview');
    const videoPrompt = promptResponse.text || `Visual summary of ${chapter.title} in style of ${style}`;

    onStatus("Transmitting to Veo Core...");
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
      operation = await ai.operations.getVideosOperation({operation: operation});
    }

    trackUsage('videoVeo', { total: 0, input: videoPrompt.length, output: 0 }, _videoModel);
    onStatus("Finalizing transmission...");
    const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
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
    return await response.blob();
  });
};

export const generateSeedanceVideo = async (
  file: FileContext,
  chapter: Chapter,
  onStatus: (status: string) => void,
  style: string = 'Cinematic',
  language: string = 'English',
  resolution: '720p' | '1080p' = '720p'
): Promise<Blob> => {
  const ai = await getAi();
  onStatus("Crafting visual narrative...");
  const promptResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: {
      parts: [
        getFilePart(file),
        { text: `Create a cinematic visual description for a summary of "${chapter.title}" in ${style} style. IMPORTANT: The output video MUST NOT contain any text, subtitles, captions, or watermarks. Focus entirely on purely visual storytelling and atmosphere.` }
      ]
    },
    config: { thinkingConfig: { thinkingBudget: 0 } }
  });
  trackUsage('videoPrompt', extractTokens(promptResponse), 'gemini-3-flash-preview');
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
  if (!createRes.ok || !taskId) throw new Error(error || 'Failed to create Seedance task');

  let status = 'queued';
  let videoUrl: string | null = null;
  let tokensUsed = 0;
  while (status !== 'succeeded' && status !== 'failed') {
    onStatus("Synthesizing temporal data...");
    await new Promise(resolve => setTimeout(resolve, 10000));
    const pollRes = await fetch('/api/seedance/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ taskId }),
    });
    const pollData = await pollRes.json() as any;
    status = pollData.status;
    videoUrl = pollData.videoUrl;
    if (pollData.tokensUsed) tokensUsed = pollData.tokensUsed;
  }

  if (status === 'failed' || !videoUrl) throw new Error('Seedance video generation failed');
  const seedanceAction = _videoModel.includes('fast') ? 'videoSeedanceFast' : 'videoSeedance';
  trackUsage(seedanceAction, { total: tokensUsed, input: videoPrompt.length, output: 0 }, _videoModel);

  onStatus("Finalizing transmission...");
  const dlRes = await fetch('/api/seedance/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ url: videoUrl }),
  });
  return await dlRes.blob();
};

export const createChatSession = async (file: FileContext, history: Content[] = []): Promise<Chat> => {
  const ai = await getAi();
  return ai.chats.create({
    model: 'gemini-3-flash-preview',
    config: {
      systemInstruction: "You are a reading assistant. Answer questions strictly based on the provided document.",
      thinkingConfig: { thinkingBudget: 0 }
    },
    history: [
      {
        role: 'user',
        parts: [getFilePart(file)]
      },
      ...history
    ]
  });
};

export const sendMessageToChat = async (chat: Chat, message: string | Part[], signal?: AbortSignal): Promise<string> => {
  return withRetry(async () => {
    const messageContent = typeof message === 'string' ? { message } : { message: { parts: message } };
    
    let response;
    if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
        // Race the SDK call against the abort signal
        response = await Promise.race([chat.sendMessage(messageContent as any), abortPromise]);
    } else {
        response = await chat.sendMessage(messageContent as any);
    }
    
    trackUsage('chat', extractTokens(response), 'gemini-3-flash-preview');
    return response.text || "";
  }, 3, 2000, signal);
};

export const generateMindMapStructure = async (items: NotebookItem[], bookTitle: string, context?: string): Promise<MindMapNode> => {
  return withRetry(async () => {
    const contextStr = context ? `\nContext: ${context}` : '';
    const itemsStr = JSON.stringify(items.map(i => ({ text: i.text, type: i.type, definition: i.definition })));

    const text = await callUnifiedLLM({
      contents: {
        parts: [
          { text: `Organize the following study notes from the book "${bookTitle}" into a structured mind map hierarchy. \n${contextStr}\n\nNotes:\n${itemsStr}\n\nOutput a strictly valid JSON object where the root node is the main topic (e.g. Chapter Title), and children are categories or themes. \n\nRULES:\n1. For vocabulary/words: The word itself is a node. Its definition must be a CHILD node of that word.\n2. For themes/sentences: The sentence text is a node. Its interpretation/definition must be a CHILD node of that sentence.\n\nStructure: { id, label, type: 'root'|'category'|'item', children: [...] }. Ensure 'id' is unique for every node.` }
        ]
      },
      creditAction: 'generateMindMap',
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            label: { type: Type.STRING },
            type: { type: Type.STRING, enum: ['root', 'category', 'item'] },
            children: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  label: { type: Type.STRING },
                  type: { type: Type.STRING },
                  children: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                         id: { type: Type.STRING },
                         label: { type: Type.STRING },
                         type: { type: Type.STRING },
                         children: {
                             type: Type.ARRAY,
                             items: {
                                type: Type.OBJECT,
                                properties: {
                                    id: { type: Type.STRING },
                                    label: { type: Type.STRING },
                                    type: { type: Type.STRING }
                                },
                                required: ["id", "label", "type"]
                             }
                         }
                      },
                      required: ["id", "label", "type"]
                    }
                  }
                },
                required: ["id", "label", "type"]
              }
            }
          },
          required: ["id", "label", "type", "children"]
        }
      }
    });

    return safeJsonParse<MindMapNode>(text || "{}");
  });
};
