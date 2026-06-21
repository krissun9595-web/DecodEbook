const ABBREV = /(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Gen|Gov|Sgt|Cpl|Pvt|Rev|Vol|Vols|Dept|Est|Inc|Ltd|Corp|vs|etc|approx|e\.g|i\.e|al|fig|no|op|ch|pt|p|pp|ed|eds|trans|repr|cf|ca|Mme|Mlle|Mgr|Sra|Srta|Ud|Vd|Dra|Lic|z\.B|d\.h|usw|bzw|Nr|Abs|Aufl|Bd|hrsg|[A-Z])$/;
const hasIntlSegmenter = typeof Intl !== 'undefined' && typeof (Intl as any).Segmenter === 'function';

const normalizeSoftLineBreaks = (text: string): string => {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/\b([A-Z])\.(?=[A-Z][a-z])/g, '$1. ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
};

const INLINE_WRAPPERS = [
  { open: '**', close: '**' },
  { open: '__', close: '__' },
  { open: '~~', close: '~~' },
  { open: '*', close: '*' },
];

const splitWrappedInlineText = (text: string): string[] | null => {
  const trimmed = text.trim();
  const wrapper = INLINE_WRAPPERS.find(candidate =>
    trimmed.startsWith(candidate.open) &&
    trimmed.endsWith(candidate.close) &&
    trimmed.length > candidate.open.length + candidate.close.length
  );
  if (!wrapper) return null;

  const inner = trimmed.slice(wrapper.open.length, trimmed.length - wrapper.close.length).trim();
  if (!inner) return null;
  const innerSentences = splitSentenceCore(inner);
  return innerSentences.map(sentence => `${wrapper.open}${sentence}${wrapper.close}`);
};

// A markdown footnote/reference link can be torn across sentence-segmentation
// boundaries (e.g. "...born.[" + "II](part0007split010.html#ch01fn2) The...").
// Detect a segment that ends with an *unclosed* link opener so it can be rejoined.
const endsWithOpenLink = (text: string): boolean => {
  const withoutComplete = text.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, '');
  return /\[[^\[\]\n]*$/.test(withoutComplete) ||          // "[..."  (no closing "]")
    /\[[^\[\]\n]*\]\([^()\n]*$/.test(withoutComplete);      // "[...](..."  (no closing ")")
};

// Rejoin raw segments whenever a markdown link was split mid-way. Operates on the
// untrimmed segmenter output so original spacing is preserved exactly.
const mergeTornLinks = (segments: string[]): string[] => {
  const merged: string[] = [];
  for (const segment of segments) {
    if (merged.length > 0 && endsWithOpenLink(merged[merged.length - 1])) {
      merged[merged.length - 1] += segment;
    } else {
      merged.push(segment);
    }
  }
  return merged;
};

// After reconstituting a torn link, a real sentence boundary can sit right after the
// footnote marker ("...was born.[ II](href) The industrial..."). Re-split there so the
// marker stays attached to its sentence while the next sentence starts cleanly.
const FOOTNOTE_LINK_BOUNDARY = /([.!?。！？]["'”’)\]]?\s*\[[^\]\n]*\]\([^)\n]+\))\s+(?=[\p{Lu}\p{Lo}"“‘《])/u;
const splitTrailingFootnoteLinks = (sentences: string[]): string[] => {
  const out: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    let match = rest.match(FOOTNOTE_LINK_BOUNDARY);
    while (match && match.index !== undefined) {
      const cut = match.index + match[1].length;
      const head = rest.slice(0, cut).trim();
      if (head) out.push(head);
      rest = rest.slice(cut).trim();
      match = rest.match(FOOTNOTE_LINK_BOUNDARY);
    }
    if (rest.trim()) out.push(rest.trim());
  }
  return out;
};

const mergeDetachedFootnoteSegments = (segments: string[]): string[] => {
  const merged: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const markerOnly = segment.match(/^\s*([*_~]{1,2})\s*$/u);
    if (markerOnly && merged.length > 0) {
      merged[merged.length - 1] += markerOnly[1];
      continue;
    }

    const noteEntryPrefix = segment.match(/^\s*(?:\[[0-9ivxlcdm]{1,8}[.)]?\]\([^)]+\)|\[[0-9ivxlcdm]{1,8}[.)]?\]|(?:no\.?|note)\s*[0-9ivxlcdm]{1,8}[.)]?|\d{1,3}[.)])(?:[.)])?\s*$/iu);
    if (noteEntryPrefix && segments[index + 1]?.trim()) {
      merged.push(`${segment.trimEnd()} ${segments[index + 1].trimStart()}`);
      index++;
      continue;
    }

    const footnoteLead = segment.match(/^(\s*\d{1,3})([*_~]{0,2})(\s+[\s\S]+)?$/u);
    const previous = merged[merged.length - 1]?.trim() || '';
    if (footnoteLead && previous && /[.!?。！？]["'”’)\]]?$/u.test(previous)) {
      merged[merged.length - 1] += `${footnoteLead[1].trim()}${footnoteLead[2] || ''}`;
      if (footnoteLead[3]?.trim()) merged.push(footnoteLead[3].trimStart());
      continue;
    }

    merged.push(segment);
  }
  return merged;
};

const splitSentenceCore = (segmentText: string): string[] => {
  if (hasIntlSegmenter) {
    const segmenter = new (Intl as any).Segmenter(undefined, { granularity: 'sentence' });
    const raw: string[] = mergeDetachedFootnoteSegments(mergeTornLinks([...segmenter.segment(segmentText)].map((s: any) => s.segment)));
    const results: string[] = [];
    let buf = '';
    for (const seg of raw) {
      buf += seg;
      const trimmed = buf.trim();
      const lastWord = trimmed.replace(/[.!?]+\s*$/, '').split(/\s+/).pop() || '';
      if (ABBREV.test(lastWord)) continue;
      if (trimmed.length > 0) results.push(trimmed);
      buf = '';
    }
    if (buf.trim()) {
      if (results.length > 0) results[results.length - 1] += ' ' + buf.trim();
      else results.push(buf.trim());
    }
    return splitTrailingFootnoteLinks(results).filter(s => s.length > 0);
  }

  // Fallback for browsers without Intl.Segmenter
  const results: string[] = [];
  let buf = '';
  const raw = mergeDetachedFootnoteSegments(mergeTornLinks(segmentText.match(/[^.!?。！？]+[.!?。！？]+[“”'」』）']*\s*|.+$/g) || [segmentText]));
  for (const seg of raw) {
    buf += seg;
    const trimmed = buf.replace(/[.!?。！？]+[“”'」』）']*\s*$/, '').trim();
    const lastWord = trimmed.split(/\s+/).pop() || '';
    if (ABBREV.test(lastWord)) continue;
    results.push(buf.trim());
    buf = '';
  }
  if (buf.trim()) {
    if (results.length > 0) results[results.length - 1] += ' ' + buf.trim();
    else results.push(buf.trim());
  }
  return splitTrailingFootnoteLinks(results).filter(s => s.length > 0);
};

// Open emphasis wrappers remaining at the end of `text`, starting from `initial`.
// Link hrefs are masked first so underscores inside them (part0023_split_001) don't
// register as underline markers.
const openEmphasisWrappers = (text: string, initial: string[]): string[] => {
  const scan = text.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, 'x');
  const stack = [...initial];
  const re = /\*\*|__|~~|\*|_|~/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(scan)) !== null) {
    const token = match[0];
    if (stack.length && stack[stack.length - 1] === token) stack.pop();
    else stack.push(token);
  }
  return stack;
};

// An emphasis span (e.g. an italic blockquote) can cover several sentences. Splitting
// it leaves the open/close markers on different sentences, so each renders plain.
// Re-wrap every sentence in the emphasis that is open across it — but only when the
// block's emphasis is balanced overall, so a stray marker can't wrap the remainder.
const rebalanceEmphasisAcrossSentences = (sentences: string[]): string[] => {
  if (sentences.length < 2) return sentences;
  if (openEmphasisWrappers(sentences.join(' '), []).length > 0) return sentences;
  let open: string[] = [];
  return sentences.map(sentence => {
    const reopened = open.join('') + sentence;
    open = openEmphasisWrappers(reopened, []);
    return open.length ? reopened + [...open].reverse().join('') : reopened;
  });
};

export const splitIntoSentences = (text: string): string[] => {
  if (!text) return [];

  const segmentText = normalizeSoftLineBreaks(text);
  if (!segmentText) return [];

  return rebalanceEmphasisAcrossSentences(splitWrappedInlineText(segmentText) || splitSentenceCore(segmentText));
};
