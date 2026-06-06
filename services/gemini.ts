
import { GoogleGenAI, Type, Modality, Chat, Content, Part } from "@google/genai";
import { BookStructure, Chapter, Concept, DictionaryEntry, FileContext, MindMapNode, NotebookItem } from "../types";
import { getSession, getUser, logUsage } from "./supabase";

let _userApiKey: string | null = null;
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

const trackUsage = (action: string, tokensUsed: number = 0) => {
  getUser().then(user => {
    if (user) logUsage(user.id, action, tokensUsed);
  }).catch(() => {});
};

const extractTokens = (response: any): number => {
  const meta = response?.usageMetadata;
  if (!meta) return 0;
  return (meta.promptTokenCount || 0) + (meta.candidatesTokenCount || 0);
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
}): Promise<string> => {
  const model = params.model || _selectedModel;

  if (isGeminiModel(model)) {
    const ai = await getAi();
    const config: any = {};
    if (params.systemInstruction) config.systemInstruction = params.systemInstruction;
    if (params.generationConfig) Object.assign(config, params.generationConfig);
    config.thinkingConfig = { thinkingBudget: 0 };
    const response = await ai.models.generateContent({ model, contents: params.contents, config });
    trackUsage(`text:${model}`, extractTokens(response));
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
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error((err as any).error || 'LLM request failed');
  }
  const data = await res.json() as any;
  trackUsage(`text:${model}`, data.usage?.total_tokens || 0);
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

export const analyzeBookStructure = async (file: FileContext): Promise<BookStructure> => {
  return withRetry(async () => {
    const ai = await getAi();
    
    // Switched to gemini-3-flash-preview to prevent 429 Resource Exhausted errors on Pro quota
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview", 
      contents: {
        parts: [
          getFilePart(file),
          { text: "Analyze the document structure. Return a valid JSON object with 'title', 'author', and 'chapters' (an array of objects with 'id' (number), 'title' (string), and 'description' (string)). Ensure the JSON is clean and strictly follows this schema." }
        ]
      },
      config: {
        systemInstruction: "You are a specialized document parser. Your output must be ONLY a valid JSON object. Do not include markdown code blocks (```json), conversational text, or introductions. If the document is large, identify the main sections as chapters.",
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
                  description: { type: Type.STRING }
                },
                required: ["id", "title"]
              }
            }
          },
          required: ["title", "author", "chapters"]
        }
      }
    });
    
    trackUsage('analyzeBookStructure', extractTokens(response));
    if (!response.text) throw new Error("Empty response from model");

    const data = safeJsonParse<any>(response.text);

    const chapters = Array.isArray(data.chapters) ? data.chapters.map((c: any, i: number) => ({
        id: c.id || i + 1,
        title: c.title || `Chapter ${i + 1}`,
        description: c.description || ""
    })) : [];

    return { 
        title: data.title || "Untitled Document",
        author: data.author || "Unknown Author",
        chapters: chapters,
        id: crypto.randomUUID(), 
        bookmarks: [] 
    } as BookStructure;
  });
};

export const translateSentences = async (sentences: string[], targetLanguage: string): Promise<string[]> => {
  if (sentences.length === 0) return [];
  const batchSize = 10;
  const results: string[] = [];
  
  for (let i = 0; i < sentences.length; i += batchSize) {
    const batch = sentences.slice(i, i + batchSize);
    const batchResult = await withRetry(async () => {
      const text = await callUnifiedLLM({
        contents: {
          parts: [{ text: `Translate the following sentences to ${targetLanguage}. Return a JSON array of strings. Maintain 1:1 mapping.\n\nSentences: ${JSON.stringify(batch)}` }]
        },
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        }
      });
      return safeJsonParse<string[]>(text || "[]");
    });
    results.push(...batchResult);
    if (i + batchSize < sentences.length) {
        await new Promise(r => setTimeout(r, 200));
    }
  }
  return results;
};

export const extractChapterText = async (file: FileContext, chapter: Chapter, allChapters?: Chapter[]): Promise<string> => {
  if (file.isText) {
    const local = extractChapterLocal(file.content, chapter, allChapters);
    if (local && local.length > 200) return local;
  }

  return withRetry(async () => {
    const ai = await getAi();
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          getFilePart(file),
          { text: `Reproduce the COMPLETE ORIGINAL text of the chapter titled "${chapter.title}" from the document above. Output EVERY paragraph, sentence, and word EXACTLY as written — do NOT summarize, paraphrase, shorten, or skip any content. Preserve the original wording. Use double newlines between paragraphs.` }
        ]
      },
      config: {
        systemInstruction: "You are a text extraction tool. Your ONLY job is to copy text verbatim from the source document. Never summarize, never paraphrase, never add commentary. If the chapter is long, output ALL of it.",
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    trackUsage('extractChapterText', extractTokens(response));
    return response.text || "";
  });
};

function extractChapterLocal(content: string, chapter: Chapter, allChapters?: Chapter[]): string | null {
  if (!allChapters || allChapters.length === 0) return null;

  const sorted = [...allChapters].sort((a, b) => a.id - b.id);
  const idx = sorted.findIndex(c => c.id === chapter.id);
  if (idx === -1) return null;

  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const title = chapter.title;
  const startPattern = new RegExp(`(?:^|\\n)(?:#{1,4}\\s*)?${escapeRegex(title)}\\s*\\n`, 'im');
  const startMatch = content.match(startPattern);
  if (!startMatch || startMatch.index === undefined) return null;

  const startPos = startMatch.index + startMatch[0].length;

  let endPos = content.length;
  if (idx + 1 < sorted.length) {
    const nextTitle = sorted[idx + 1].title;
    const endPattern = new RegExp(`(?:^|\\n)(?:#{1,4}\\s*)?${escapeRegex(nextTitle)}\\s*\\n`, 'im');
    const endMatch = content.substring(startPos).match(endPattern);
    if (endMatch && endMatch.index !== undefined) {
      endPos = startPos + endMatch.index;
    }
  }

  return content.substring(startPos, endPos).trim();
}

export const generatePodcastAudio = async (
  file: FileContext,
  chapter: Chapter,
  tone: string = 'Engaging',
  hosts: { host1: string, voice1: string, host2: string, voice2: string },
  language: string = 'English'
): Promise<{ audio: string; script: string; episodeTitle: string }> => {
  return withRetry(async () => {
    const ai = await getAi();
    const scriptResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview", 
      contents: {
        parts: [
          getFilePart(file),
          { text: `Create a ${tone} podcast dialogue about the chapter "${chapter.title}" in ${language}. Keep the conversation concise (max 600 words). Use hosts ${hosts.host1} and ${hosts.host2}.\n\nCRITICAL PERSONALITY RULES:\n- ${hosts.host1} and ${hosts.host2} must have DISTINCT speaking styles throughout the ENTIRE script.\n- ${hosts.host1} leads the discussion, asks questions, and drives the narrative.\n- ${hosts.host2} responds, challenges, adds counterpoints, and reacts with a clearly different personality.\n- They must NEVER converge into the same tone. Maintain their unique voices from start to finish.\n- Alternate speakers frequently. Never have the same speaker talk for more than 3 consecutive lines.\n\nFORMAT RULES:\n- Output JSON with 'episodeTitle' and 'script'.\n- The 'script' MUST be formatted as lines of dialogue, one per line, each starting with the speaker name followed by a colon.\n- Example:\n${hosts.host1}: Welcome to the show!\n${hosts.host2}: Thanks for having me.\n- Every line must start with either "${hosts.host1}:" or "${hosts.host2}:". Do NOT merge multiple speakers into one line.` }
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

    trackUsage('podcastScript', extractTokens(scriptResponse));
    const parsedResponse = safeJsonParse<{ script: string, episodeTitle: string }>(scriptResponse.text || "{}");
    if (!parsedResponse.script) throw new Error("Script generation failed");

    // Clean script for TTS: strip markdown bold and normalize speaker names exactly
    const cleanedScript = parsedResponse.script
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .split('\n')
      .map(line => {
        const m = line.match(new RegExp(`^\\s*(${hosts.host1}|${hosts.host2})\\s*:\\s*`, 'i'));
        if (!m) return line;
        const name = m[1].toLowerCase() === hosts.host1.toLowerCase() ? hosts.host1 : hosts.host2;
        return `${name}: ${line.substring(m[0].length)}`;
      })
      .join('\n');

    const audioResponse = await ai.models.generateContent({
      model: _ttsModel,
      contents: [{ parts: [{ text: cleanedScript }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              { speaker: hosts.host1, voiceConfig: { prebuiltVoiceConfig: { voiceName: hosts.voice1 } } },
              { speaker: hosts.host2, voiceConfig: { prebuiltVoiceConfig: { voiceName: hosts.voice2 } } }
            ]
          }
        }
      }
    });
    
    trackUsage('podcastAudio', extractTokens(audioResponse));
    const base64Audio = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("Audio generation failed");
    return { audio: base64Audio, script: parsedResponse.script, episodeTitle: parsedResponse.episodeTitle };
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
    trackUsage('extractConcepts', extractTokens(response));
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
    trackUsage('generateImage', extractTokens(response));
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
    trackUsage('extractDictionary', extractTokens(response));
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
    trackUsage('tts', extractTokens(response));
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
      }
    });
  });
};

export const getQuickDefinition = async (text: string, language: string): Promise<string> => {
  return withRetry(async () => {
    const result = await callUnifiedLLM({
      contents: {
        parts: [{ text: `Act as a reading assistant. Analyze and define this text in ${language}: "${text}". Output strictly a concise, insightful definition or explanation. No introductory phrases.` }]
      }
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
    trackUsage('videoPrompt', extractTokens(promptResponse));
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

    trackUsage('videoVeo');
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
  trackUsage('videoPrompt', extractTokens(promptResponse));
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
  trackUsage('videoSeedance', tokensUsed);

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
    
    trackUsage('chat', extractTokens(response));
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
