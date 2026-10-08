// Language hinting for the free (Web Speech API) pronounce path, so a foreign word
// is spoken with the right voice instead of the device's default (usually English).

// DecodEbook target-language display names → BCP-47 codes.
const NAME_TO_CODE: Record<string, string> = {
  'Arabic': 'ar',
  'Chinese (Simplified)': 'zh-CN',
  'Chinese (Traditional)': 'zh-TW',
  'Dutch': 'nl',
  'English': 'en',
  'French': 'fr',
  'German': 'de',
  'Hindi': 'hi',
  'Indonesian': 'id',
  'Italian': 'it',
  'Japanese': 'ja',
  'Korean': 'ko',
  'Polish': 'pl',
  'Portuguese': 'pt',
  'Russian': 'ru',
  'Spanish': 'es',
  'Swedish': 'sv',
  'Thai': 'th',
  'Turkish': 'tr',
  'Vietnamese': 'vi',
};

export const languageNameToCode = (name?: string): string | undefined =>
  name && name !== 'Original' ? NAME_TO_CODE[name] : undefined;

// Detect a BCP-47 language from the text's Unicode script. Returns undefined for
// Latin script (ambiguous — French/Spanish/English/… all share it).
export const detectScriptLang = (text: string): string | undefined => {
  if (/[぀-ゟ゠-ヿ]/.test(text)) return 'ja'; // Hiragana / Katakana
  if (/[가-힣]/.test(text)) return 'ko';              // Hangul
  if (/[一-鿿㐀-䶿]/.test(text)) return 'zh'; // Han (default Chinese)
  if (/[Ѐ-ӿ]/.test(text)) return 'ru';              // Cyrillic
  if (/[؀-ۿݐ-ݿ]/.test(text)) return 'ar'; // Arabic
  if (/[֐-׿]/.test(text)) return 'he';              // Hebrew
  if (/[Ͱ-Ͽ]/.test(text)) return 'el';              // Greek
  if (/[฀-๿]/.test(text)) return 'th';              // Thai
  if (/[ऀ-ॿ]/.test(text)) return 'hi';              // Devanagari
  return undefined;
};

/**
 * Best-effort BCP-47 hint for pronouncing `text`:
 *  - non-Latin script → detected straight from the text (reliable)
 *  - Latin + selection is the TRANSLATED layer → the active target language
 *  - otherwise (Latin original of an unknown source language) → undefined (browser default)
 */
export const guessSpeechLang = (text: string, activeLanguage?: string, isTranslated?: boolean): string | undefined => {
  const script = detectScriptLang(text);
  if (script) {
    // Han may be Chinese or Japanese — prefer Japanese when the target is Japanese.
    if (script === 'zh' && activeLanguage === 'Japanese' && isTranslated) return 'ja';
    return script;
  }
  if (isTranslated) return languageNameToCode(activeLanguage);
  return undefined;
};
