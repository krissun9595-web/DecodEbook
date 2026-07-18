import type { Chapter } from '../types';

export function slugifyFilename(text: string, maxLen = 30): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, maxLen)
    .replace(/-$/, '');
}

// A strict Roman-numeral matcher (I, II, IV, XV, …) used to KEEP such tokens uppercase — otherwise
// a chapter numbered "II" would title-case to "Ii". Anchored + no empty match.
const ROMAN_NUMERAL = /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

export function titleCase(text: string, maxLen = 50): string {
  return text
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => {
      // Preserve an all-caps Roman numeral (ignoring trailing punctuation like "II."), so book
      // chapter numbers survive; everything else gets normal Title-casing.
      const core = w.replace(/[^A-Za-z]+$/, '');
      if (core.length > 0 && core === core.toUpperCase() && ROMAN_NUMERAL.test(core)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join('')
    .substring(0, maxLen);
}

// A chapter/part's OWN number as written in the source — arabic ("2", "15-1") or Roman ("II"), after an
// optional leading "Chapter"/"Part"/"Section"/"Book" word. undefined for unnumbered front/back matter
// (Copyright, Cover, Index…). The trailing look-ahead keeps "Copyright"/"Index" from matching as Roman.
function leadingChapterNumber(chapter: Pick<Chapter, 'title' | 'sourceHeading'>): string | undefined {
  for (const s of [chapter.sourceHeading, chapter.title]) {
    if (!s) continue;
    const m = s.match(/^\s*(?:chapter|part|section|book)?\s*([0-9]+(?:[.\-][0-9]+)*|[IVXLCDM]+)(?=[\s.):\-]|$)/i);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

// Drop the leading number (and any "Chapter"/"Part" word) from a title, leaving the human name only:
// "Chapter II Pendulums" → "Pendulums", "1 Elon's World" → "Elon's World". No-op when unnumbered.
function stripChapterNumber(title: string, num?: string): string {
  if (!num) return title;
  const esc = num.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const cleaned = title.replace(new RegExp('^\\s*(?:chapter|part|section|book)?\\s*' + esc + '[\\s.):\\-]*', 'i'), '').trim();
  return cleaned || title;
}

// Build the chapter portion of a generated filename: title-led, with a REAL chapter number (as written)
// only when the chapter has one, and the enclosing Part prefixed for multi-level (Part→Chapter) books.
// e.g. "PartII-ChII-Pendulums", "Ch1-Elon'sWorld", or just "Copyright" for front matter.
export function chapterFileLabel(chapter: Chapter, allChapters?: Chapter[]): string {
  const segs: string[] = [];
  if (chapter.parentId != null && allChapters) {
    const parent = allChapters.find(c => c.id === chapter.parentId);
    if (parent) {
      const pnum = leadingChapterNumber(parent);
      segs.push(pnum ? `Part${pnum}` : titleCase(parent.title, 18));
    }
  }
  const cnum = leadingChapterNumber(chapter);
  if (cnum) segs.push(`Ch${cnum}`);
  segs.push(titleCase(stripChapterNumber(chapter.title, cnum), 30));
  return segs.filter(Boolean).join('-');
}
