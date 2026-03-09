
import { GoogleGenAI, Type, Modality, Chat, Content, Part } from "@google/genai";
import { BookStructure, Chapter, Concept, DictionaryEntry, FileContext, MindMapNode, NotebookItem } from "../types";

const getAi = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

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
    const ai = getAi();
    
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
    
    if (!response.text) throw new Error("Empty response from model");
    
    const data = safeJsonParse<any>(response.text);
    
    // Ensure data integrity
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
      const ai = getAi();
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: {
          parts: [{ text: `Translate the following sentences to ${targetLanguage}. Return a JSON array of strings. Maintain 1:1 mapping.\n\nSentences: ${JSON.stringify(batch)}` }]
        },
        config: {
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        }
      });
      return safeJsonParse<string[]>(response.text || "[]");
    });
    results.push(...batchResult);
    if (i + batchSize < sentences.length) {
        await new Promise(r => setTimeout(r, 200));
    }
  }
  return results;
};

export const extractChapterText = async (file: FileContext, chapter: Chapter): Promise<string> => {
  return withRetry(async () => {
    const ai = getAi();
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          getFilePart(file),
          { text: `Extract the full text for the chapter titled: "${chapter.title}". Use double newlines for paragraph breaks.` }
        ]
      },
      config: {
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    return response.text || "";
  });
};

export const generatePodcastAudio = async (
  file: FileContext,
  chapter: Chapter,
  tone: string = 'Engaging',
  hosts: { host1: string, voice1: string, host2: string, voice2: string },
  language: string = 'English'
): Promise<{ audio: string; script: string; episodeTitle: string }> => {
  return withRetry(async () => {
    const ai = getAi();
    const scriptResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview", 
      contents: {
        parts: [
          getFilePart(file),
          { text: `Create a ${tone} podcast dialogue about the chapter "${chapter.title}" in ${language}. Keep the conversation concise (max 600 words). Use hosts ${hosts.host1} and ${hosts.host2}. Output JSON with 'episodeTitle' and 'script'.` }
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

    const parsedResponse = safeJsonParse<{ script: string, episodeTitle: string }>(scriptResponse.text || "{}");
    if (!parsedResponse.script) throw new Error("Script generation failed");

    const audioResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: parsedResponse.script }] }],
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
    
    const base64Audio = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("Audio generation failed");
    return { audio: base64Audio, script: parsedResponse.script, episodeTitle: parsedResponse.episodeTitle };
  });
};

export const extractConcepts = async (file: FileContext, chapter: Chapter): Promise<Concept[]> => {
  return withRetry(async () => {
    const ai = getAi();
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
    return safeJsonParse<Concept[]>(response.text || "[]");
  });
};

export const generateConceptImage = async (visualPrompt: string, style: string = 'Digital Art', aspectRatio: string = '1:1'): Promise<string> => {
  // Mandatory check for API key when using gemini-3-pro-image-preview
  const hasKey = await (window as any).aistudio.hasSelectedApiKey();
  if (!hasKey) {
      await (window as any).aistudio.openSelectKey();
  }

  return withRetry(async () => {
    const ai = getAi();
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: { parts: [{ text: `${style} style: ${visualPrompt}` }] },
      config: { 
          imageConfig: { 
              aspectRatio: aspectRatio as any,
              imageSize: '4K'
          } 
      }
    });
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
    }
    throw new Error("No image generated");
  });
};

export const extractDictionary = async (file: FileContext, chapter: Chapter): Promise<DictionaryEntry[]> => {
  return withRetry(async () => {
    const ai = getAi();
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
    return safeJsonParse<DictionaryEntry[]>(response.text || "[]");
  });
};

export const translateDictionary = async (entries: DictionaryEntry[], targetLanguage: string): Promise<DictionaryEntry[]> => {
  if (entries.length === 0) return [];
  return withRetry(async () => {
    const ai = getAi();
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [{ text: `Translate the following dictionary entries to ${targetLanguage}. Return JSON array.\n\nEntries: ${JSON.stringify(entries)}` }]
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
    return safeJsonParse<DictionaryEntry[]>(response.text || "[]");
  });
};

export const generateSpeech = async (text: string, voiceName: string = 'Kore'): Promise<string> => {
  return withRetry(async () => {
    const ai = getAi();
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
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
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("Failed to generate audio");
    return base64Audio;
  });
};

export const translateText = async (text: string, targetLanguage: string): Promise<string> => {
  return withRetry(async () => {
    const ai = getAi();
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [{ text: `Translate the following to ${targetLanguage}. Return ONLY translation.\n\n${text}` }]
      },
      config: {
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    return response.text || "";
  });
};

export const getQuickDefinition = async (text: string, language: string): Promise<string> => {
  return withRetry(async () => {
    const ai = getAi();
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [{ text: `Act as a reading assistant. Analyze and define this text in ${language}: "${text}". Output strictly a concise, insightful definition or explanation. No introductory phrases.` }]
      },
      config: {
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    const result = response.text?.trim();
    if (!result) throw new Error("Empty definition generated");
    return result;
  });
};

export const batchGetDefinitions = async (items: { id: string, text: string }[], language: string): Promise<Record<string, string>> => {
  if (items.length === 0) return {};
  return withRetry(async () => {
    const ai = getAi();
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
          parts: [{ text: `Provide concise one-sentence definitions in ${language} for the following items. Return a JSON array of objects, each containing an "id" field (matching the input) and a "definition" field. \n\nItems: ${JSON.stringify(items)}` }] 
      },
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
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
    
    const text = response.text;
    if (!text) return {};
    const rawResults = safeJsonParse<{ id: string, definition: string }[]>(text);
    const mapping: Record<string, string> = {};
    rawResults.forEach(r => { mapping[r.id] = r.definition; });
    return mapping;
  });
};

export const hasValidKeyForVeo = async (): Promise<boolean> => {
  return await (window as any).aistudio.hasSelectedApiKey();
};

export const requestVeoKey = async (): Promise<void> => {
  await (window as any).aistudio.openSelectKey();
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
    const ai = getAi();
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
    const videoPrompt = promptResponse.text || `Visual summary of ${chapter.title} in style of ${style}`;

    onStatus("Transmitting to Veo Core...");
    let operation = await ai.models.generateVideos({
      model: 'veo-3.1-fast-generate-preview',
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

    onStatus("Finalizing transmission...");
    const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
    const response = await fetch(downloadLink, {
      headers: { 'x-goog-api-key': process.env.API_KEY || '' }
    });
    return await response.blob();
  });
};

export const createChatSession = (file: FileContext, history: Content[] = []): Chat => {
  const ai = getAi();
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
    
    return response.text || "";
  }, 3, 2000, signal);
};

export const generateMindMapStructure = async (items: NotebookItem[], bookTitle: string, context?: string): Promise<MindMapNode> => {
  return withRetry(async () => {
    const ai = getAi();
    const contextStr = context ? `\nContext: ${context}` : '';
    const itemsStr = JSON.stringify(items.map(i => ({ text: i.text, type: i.type, definition: i.definition })));

    // Switched to gemini-3-flash-preview to avoid quota exhaustion on pro models
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          { text: `Organize the following study notes from the book "${bookTitle}" into a structured mind map hierarchy. \n${contextStr}\n\nNotes:\n${itemsStr}\n\nOutput a strictly valid JSON object where the root node is the main topic (e.g. Chapter Title), and children are categories or themes. \n\nRULES:\n1. For vocabulary/words: The word itself is a node. Its definition must be a CHILD node of that word.\n2. For themes/sentences: The sentence text is a node. Its interpretation/definition must be a CHILD node of that sentence.\n\nStructure: { id, label, type: 'root'|'category'|'item', children: [...] }. Ensure 'id' is unique for every node.` }
        ]
      },
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
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

    return safeJsonParse<MindMapNode>(response.text || "{}");
  });
};
