// Comprehensive person-name recognition, used to decide whether a trailing token after
// an attribution dash ("—— ARTHUR C. CLARKE") is really a name/source rather than prose.
//
// The principle (shared by mature name parsers — Python `nameparser`, JS `parse-full-name`,
// `humanparser`): a name is a short run of TOKENS, each matched against curated sets, not a
// character class. A token is one of: a capitalised name word (incl. internal caps and
// ALL-CAPS — McLuhan, O'Brien, Rees-Mogg, CLARKE), an initial (C.), a nobiliary particle
// (van/de/della…), a suffix (Jr./III/PhD), or a multi-author conjunction (and/&). Anything
// else (a lowercase prose word, a digit, sentence punctuation) means it is not a name.
//
// Particle and suffix lists are taken from nameparser's PREFIXES / SUFFIX sets so the
// recognition matches a widely-used, real-world reference rather than ad-hoc patterns.

// nameparser PREFIXES (nobiliary particles / surname connectors), verbatim.
const NAME_PARTICLES = new Set([
  'abu', 'al', 'bin', 'bon', 'da', 'dal', 'de', "de'", 'degli', 'dei', 'del', 'dela',
  'della', 'delle', 'delli', 'dello', 'der', 'den', 'di', 'do', 'dos', 'du', 'ibn',
  'la', 'le', 'mac', 'mc', 'san', 'santa', 'st', 'ste', 'van', 'vander', 'vel', 'von', 'vom',
]);

// nameparser SUFFIX_NOT_ACRONYMS plus the common academic acronyms that appear after names.
const NAME_SUFFIXES = new Set([
  'jr', 'jnr', 'junior', 'sr', 'snr', 'senior', 'ii', 'iii', 'iv', 'v',
  'phd', 'md', 'dds', 'esq', 'esquire', 'jd', 'llm', 'do', 'dphil', 'dsc',
]);

const NAME_WORD = /^[\p{Lu}][\p{L}'’.\-]*$/u; // Capitalised incl. ALL-CAPS, McLuhan, O'Brien, Rees-Mogg
const INITIAL = /^\p{Lu}\.?$/u;               // C. or C

// True when `raw` reads as a person name: a short sequence of name words / initials /
// particles / suffixes / conjunctions, with at least one real name word, and no prose
// markers. Handles initials ("ARTHUR C. CLARKE", "C. S. LEWIS"), particles
// ("Vincent van Gogh", "W. E. B. DU BOIS"), suffixes ("Martin Luther King Jr."), and
// multiple authors ("X AND Y"); rejects sentences and anything with digits.
export const looksLikePersonName = (raw: string): boolean => {
  const text = (raw || '').replace(/\s+/g, ' ').trim().replace(/[.,]+$/u, '');
  if (!text || /[!?:;]/u.test(text)) return false;
  const tokens = text.split(/\s+/);
  if (tokens.length === 0 || tokens.length > 8) return false;
  let nameWords = 0;
  for (const tok of tokens) {
    const bare = tok.replace(/[.,]+$/u, '');
    const low = bare.toLowerCase().replace(/\./g, '');
    if (bare === '&' || low === 'and' || low === 'y' || low === 'und' || low === 'et') continue;
    if (NAME_PARTICLES.has(low)) continue;
    if (NAME_SUFFIXES.has(low)) continue;
    if (INITIAL.test(bare)) continue;
    if (NAME_WORD.test(bare)) { nameWords++; continue; }
    return false; // a non-name token (lowercase prose word, digit, etc.)
  }
  return nameWords >= 1;
};

// True when `raw` is a valid attribution source: a person name, a name followed by a
// ", source/year" tail ("Marshall McLuhan, 1964"), or a short capitalised non-prose source
// (a publication or scripture reference — "The Economist", "MATTHEW 10:26"). Used to gate
// attribution detection so a real credit splits off while ordinary prose never does.
export const looksLikeAttributionAuthor = (raw: string): boolean => {
  const text = (raw || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 160) return false;
  if (looksLikePersonName(text)) return true;
  const head = text.split(',')[0].trim();
  if (head && head !== text && looksLikePersonName(head)) return true;
  // A short capitalised source that is not a prose sentence (no terminal/internal
  // sentence punctuation, reasonable word count, capitalised start).
  if (/[.!?]$/u.test(text) || /[!?]/u.test(text)) return false;
  return text.split(/\s+/).length <= 18 && /^[\p{Lu}“"‘'《]/u.test(text);
};
