const BIBLE_BOOK_PATTERN = String.raw`(?:Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Samuel|Kings|Chronicles|Ezra|Nehemiah|Esther|Job|Psalms?|Proverbs|Ecclesiastes|Solomon|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Timothy|Titus|Philemon|Hebrews|James|Peter|Jude|Revelation|Gen|Exod?|Lev|Num|Deut|Josh|Judg|Ps|Prov|Eccl|Song|Isa|Jer|Lam|Ezek|Dan|Matt?|Mt|Mk|Lk|Jn|Rom|Cor|Gal|Eph|Phil|Col|Thess|Tim|Rev|创世记|创|出埃及记|出|利未记|利|民数记|民|申命记|申|约书亚记|书|士师记|士|路得记|得|撒母耳记上|撒上|撒母耳记下|撒下|列王纪上|王上|列王纪下|王下|历代志上|代上|历代志下|代下|以斯拉记|拉|尼希米记|尼|以斯帖记|斯|约伯记|伯|诗篇|诗|箴言|箴|传道书|传|雅歌|歌|以赛亚书|赛|耶利米书|耶|耶利米哀歌|哀|以西结书|结|但以理书|但|何西阿书|何|约珥书|珥|阿摩司书|摩|俄巴底亚书|俄|约拿书|拿|弥迦书|弥|那鸿书|鸿|哈巴谷书|哈|西番雅书|番|哈该书|该|撒迦利亚书|亚|玛拉基书|玛|马太福音|太|马可福音|可|路加福音|路|约翰福音|约|使徒行传|徒|罗马书|罗|哥林多前书|林前|哥林多后书|林后|加拉太书|加|以弗所书|弗|腓立比书|腓|歌罗西书|西|帖撒罗尼迦前书|帖前|帖撒罗尼迦后书|帖后|提摩太前书|提前|提摩太后书|提后|提多书|多|腓利门书|门|希伯来书|来|雅各书|雅|彼得前书|彼前|彼得后书|彼后|约翰一书|约一|约翰二书|约二|约翰三书|约三|犹大书|犹|启示录|启)`;

const BIBLE_BOOK_REFERENCE_SOURCE = String.raw`(?:[1-3]\s*)?[《〈「『【]?\s*${BIBLE_BOOK_PATTERN}\.?\s*[》〉」』】]?\s*\d{1,3}`;
const BIBLE_REFERENCE_AT_END_RE = new RegExp(String.raw`(?:^|[\s("'“‘《〈「『【])${BIBLE_BOOK_REFERENCE_SOURCE}:\d{1,3}(?:[-–—]\d{1,3})?$`, 'iu');
const BIBLE_REFERENCE_BEFORE_COLON_RE = new RegExp(String.raw`(?:^|[\s("'“‘《〈「『【])${BIBLE_BOOK_REFERENCE_SOURCE}$`, 'iu');

export const isBibleReferenceAtEnd = (value: string): boolean =>
  BIBLE_REFERENCE_AT_END_RE.test(value.replace(/\s+/g, ' ').trim());

export const isBibleReferenceMarkerCandidate = (
  source: string,
  matchIndex: number,
  punctuation: string,
  marker: string
): boolean => {
  if (!marker || !punctuation.startsWith(':')) return false;
  const beforePunctuation = source.slice(0, matchIndex).replace(/\s+/g, ' ').trim();
  return BIBLE_REFERENCE_BEFORE_COLON_RE.test(beforePunctuation);
};

export const isNumericTextMarkerCandidate = (
  source: string,
  matchIndex: number,
  punctuation: string,
  marker: string
): boolean => {
  if (!/^\d{1,3}$/u.test(marker)) return false;

  const previous = source[matchIndex - 1] || '';
  const next = source[matchIndex + punctuation.length + marker.length] || '';
  if (punctuation === ',' && /\d/u.test(previous) && marker.length === 3) return true;
  if (punctuation === '.' && /\d/u.test(previous)) return true;
  // A number after a colon that follows a digit is a clock time or ratio
  // (e.g. "11:59:30", "12:00:00", "3:30"), not a footnote marker.
  if (punctuation.startsWith(':') && /\d/u.test(previous)) return true;
  if (/\d/u.test(previous) && /\d/u.test(next)) return true;

  return false;
};

export const isStandaloneYearAtEnd = (value: string): boolean =>
  /\b(?:1[5-9]\d{2}|20\d{2}|21\d{2})$/u.test(value.replace(/\s+/g, ' ').trim());
