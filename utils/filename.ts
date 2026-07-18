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
