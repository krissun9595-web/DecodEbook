const endsWithTerminalPunctuation = (value: string): boolean =>
  /[.!?。！？]["'”’)\]]?$/u.test(value.trim());

const looksLikeHeadingOrStructure = (value: string): boolean => {
  // Strip wrapping emphasis (an italic <h2>/<h3> extracts as "*Title*"), otherwise
  // the leading "*" hides the heading and it gets merged into the next paragraph.
  const trimmed = value.trim().replace(/^[*_~]+\s*/u, '').replace(/\s*[*_~]+$/u, '').trim();
  if (!trimmed) return false;
  const withoutHashes = trimmed.replace(/^#{1,6}\s*/, '');
  if (/^(?:chapter|part|book|section|appendix)\s+[\wivxlcdm\d]/iu.test(withoutHashes)) return true;
  if (/^(?:introduction|preface|foreword|afterword|epilogue|prologue|acknowledg(?:e)?ments?|contents?)$/iu.test(withoutHashes)) return true;
  const numberedHeading = trimmed.match(/^(?:#{1,6}\s*)?(?:(?:topic|day|lesson)\s+)?\d{1,3}[\).:\-–—|]\s+(.+)$/iu);
  if (numberedHeading) {
    const title = numberedHeading[1].trim();
    return Boolean(title) && !/^\p{Ll}/u.test(title);
  }
  if (/^(?:principle|interpretation)\s*(?:$|[:.\-–—]\s*\S*)/iu.test(trimmed)) return true;
  return trimmed.length <= 80 &&
    /^[A-Z0-9][A-Z0-9\s:'’&.,-]+$/.test(trimmed) &&
    /[A-Z]{2,}/.test(trimmed);
};

const looksLikeSubtitleLine = (value: string): boolean => {
  // Strip wrapping emphasis so an italic subtitle ("*Genius and Nemesis*") is detected.
  const trimmed = value.trim().replace(/^[*_~]+\s*/u, '').replace(/\s*[*_~]+$/u, '').trim();
  if (!trimmed || looksLikeHeadingOrStructure(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (trimmed.length > 90 || words.length > 12) return false;
  if (endsWithTerminalPunctuation(trimmed)) return false;
  if (/^\p{Ll}/u.test(trimmed)) return false;
  if (/[;,]/u.test(trimmed)) return false;
  if (/^(?:and|or|but|so|because|while|when|where|which|that|with|without|into|through|from|to|of|in|on|at|by)\b/iu.test(trimmed)) return false;
  if (/[,:;]$/u.test(trimmed)) return false;

  const contentWords = words.filter(word => !/^(?:a|an|and|as|at|but|by|for|from|in|into|of|on|or|the|to|with)$/iu.test(word));
  return contentWords.length >= 2 && contentWords.every(word => /^[\p{Lu}\d"“‘]/u.test(word));
};

const looksLikeQuotedTermLine = (value: string): boolean => {
  const trimmed = value.trim();
  if (!/^[‘']/u.test(trimmed)) return false;

  const inner = trimmed.match(/^[‘']([^’']{1,80})[’'](?:\s*[.,;:!?])?$/u)?.[1]?.trim();
  if (inner && !/\s/.test(inner) && /^[\p{Ll}\p{N}_-]+$/u.test(inner)) return true;

  const afterOpen = trimmed.slice(1).trimStart();
  return /^[\p{Ll}\p{N}_-]/u.test(afterOpen);
};

const startsDialogueLine = (value: string): boolean => {
  const trimmed = value.trim();
  if (!/^[“"‘'][^”"’']+/u.test(trimmed)) return false;
  if (looksLikeQuotedTermLine(trimmed)) return false;
  return true;
};

const startsParagraphTransitionLine = (value: string): boolean =>
  /^(?:However|Therefore|Thus|Consequently|Moreover|Furthermore|Meanwhile|In ancient times|In contrast|At the same time|As a result|For example|For instance)\b/iu.test(value.trim());

const stripDisplayStyleMarkers = (value: string): string => value
  .replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/~~([^~]+)~~/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/[*_~]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const stripDisplayStyleMarkersPreserveLinks = (value: string): string => {
  const links: string[] = [];
  const protectedValue = value.replace(/\[[^\]]+\]\s*\([^)]+\)/g, match => {
    const token = `DECODEBOOKLINKTOKEN${links.length}`;
    links.push(match);
    return token;
  });

  return protectedValue
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/DECODEBOOKLINKTOKEN(\d+)/g, (_match, index) => links[Number(index)] || '')
    .replace(/\s+/g, ' ')
    .trim();
};

const looksLikeSignatureLine = (value: string): boolean => {
  const clean = stripDisplayStyleMarkers(value).replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 120 || /[.!?。！？]$/u.test(clean)) return false;
  if (/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/u.test(clean)) return true;
  if (/^(?:[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){1,3}|[A-Z][\p{L}'-]+,\s+[A-Z][\p{L}'-]+)$/u.test(clean)) return true;
  return /^(?:Los Angeles|New York|London|Paris|Berlin|Beijing|Shanghai|Tokyo|Hong Kong|Singapore|San Francisco|Washington(?:,\s*D\.C\.)?)$/u.test(clean);
};

const looksLikeAttributionLine = (value: string): boolean => {
  const clean = stripDisplayStyleMarkers(value).replace(/\s+/g, ' ').trim();
  if (!/^(?:——|--|—|–|-)\s*[A-Z]/u.test(clean)) return false;
  const author = clean.replace(/^(?:——|--|—|–|-)\s*/u, '');
  if (author.length > 140 || /[.!?]$/u.test(author)) return false;
  return author.split(/\s+/).length <= 18;
};

const markCitationBody = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const clean = stripDisplayStyleMarkersPreserveLinks(trimmed);
  const linkedNote = clean.match(/^(.*?)(\s*\[\s*[0-9ivxlcdm]{1,8}[.)]?\s*\]\s*\([^)]+\))\s*$/iu);
  if (linkedNote) {
    const body = linkedNote[1].trim();
    const note = linkedNote[2].trim();
    return body ? `*${body}*${note}` : note;
  }
  return `*${clean}*`;
};

const looksLikeCitationBody = (value: string): boolean => {
  const clean = stripDisplayStyleMarkers(value).replace(/\s+/g, ' ').trim();
  if (clean.length < 20 || clean.length > 900) return false;
  if (looksLikeHeadingOrStructure(clean) || looksLikeSubtitleLine(clean)) return false;
  if (/\b(?:asked|said|responded|replied|answered|whispered|shouted|muttered)\b/i.test(clean)) return false;
  if (/^[“"‘']/.test(clean)) return /[”"’](?:[.!?。！？])?(?:\d{1,3})?$/u.test(clean);
  return endsWithTerminalPunctuation(clean);
};

const splitAttributionTail = (value: string): string => {
  const clean = value.replace(/\s+/g, ' ').trim();
  // The body ends with the quote's terminal punctuation, then an optional footnote
  // marker and emphasis markers in any order. The marker is either a bare digit or a
  // structural note link ("[1](#pdfnote-…)", as the PDF extractor now emits and EPUB
  // always has), and a multi-line italic epigraph puts the closing emphasis before the
  // marker ("understand.”*1" / "understand.”*[1](#…)"). markCitationBody strips the
  // emphasis and re-glues the marker to the quote, so every ordering normalises the same.
  const match = clean.match(/^(.{20,900}?[.!?。！？"”’][*_~]{0,2}(?:\d{1,3}|\[\s*[0-9ivxlcdm]{1,8}[.)]?\s*\]\s*\([^)]+\))?[*_~]{0,2})\s*(?:——|--|—|–|-)\s*([A-Z][^.!?\n]{2,140})$/u);
  if (!match) return value;
  const body = match[1].trim();
  const attribution = stripDisplayStyleMarkers(match[2]).trim();
  if (!/^[“"‘']|\*[“"‘']/.test(body)) return value;
  if (attribution.split(/\s+/).length > 18) return value;
  return `${markCitationBody(body)}\n\n—— ${attribution.replace(/^(?:——|--|—|–|-)\s*/u, '')}`;
};

const normalizeAttributionLine = (value: string): string => {
  const body = value.replace(/\s+/g, ' ').trim().replace(/^(?:——|--|—|–|-)\s*/u, '');
  const linkedNote = body.match(/^(.*?)\s*(\[\s*[0-9ivxlcdm]{1,8}[.)]?\s*\]\s*\([^)]+\))\s*[*_~]*$/iu);
  if (linkedNote) {
    return `—— ${stripDisplayStyleMarkers(linkedNote[1])}${linkedNote[2]}`;
  }
  return `—— ${stripDisplayStyleMarkers(body)}`;
};

const markCitationBlocks = (paragraphs: string[]): string[] => paragraphs.map((paragraph, index) => {
  if (looksLikeAttributionLine(paragraph)) return normalizeAttributionLine(paragraph);
  const next = paragraphs[index + 1];
  if (!next || !looksLikeAttributionLine(next) || !looksLikeCitationBody(paragraph)) return paragraph;
  return markCitationBody(paragraph);
});

const looksLikeContinuationAfterArtificialBreak = (previous: string, current: string): boolean => {
  const prev = previous.trim();
  const cur = current.trim();
  if (
    !prev ||
    !cur ||
    endsWithTerminalPunctuation(prev) ||
    looksLikeAttributionLine(prev) ||
    looksLikeAttributionLine(cur) ||
    looksLikeSignatureLine(prev) ||
    looksLikeSignatureLine(cur) ||
    looksLikeHeadingOrStructure(prev) ||
    looksLikeHeadingOrStructure(cur) ||
    looksLikeSubtitleLine(prev) ||
    looksLikeSubtitleLine(cur)
  ) return false;

  const prevTail = prev.split(/\s+/).slice(-4).join(' ');
  const firstToken = cur.split(/\s+/)[0] || '';

  if (/^[a-z]/u.test(cur)) return true;
  if (/^\d+(?:[.,]\d+)?\.?\b/u.test(cur) && /\b(?:at|was|were|is|are|be|been|being|of|to|from|by|with|and|or|plus|minus|equals?|stood at|amounted to|rose to|fell to)$/iu.test(prev)) return true;
  if (/^(?:and|or|but|nor|for|yet|so|to|of|in|on|at|by|from|with|without|into|through|over|under|than|as|that|which|who|whom|whose)\b/iu.test(cur)) return true;
  if (/[,;:—–-]\s*$/u.test(prev)) return true;
  if (/;[^.!?。！？]*$/u.test(prev) && (/;/.test(cur) || /^[A-Z][\p{L}.'-]*(?:,\s*(?:Jr\.?|Sr\.?|I{2,4}|V?I{0,3}))?;/u.test(cur))) return true;
  if (/\b[A-Z][\p{L}'-]*$/u.test(prevTail) && /^[A-Z][\p{L}'-]*(?:[,;:]|$)/u.test(firstToken)) return true;
  if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sir|Dame|St|Gen|Gov|Rev|Hon)\.?$/u.test(prevTail) && /^[A-Z]/u.test(cur)) return true;

  return false;
};

const normalizeParagraphLines = (paragraph: string): string[] => {
  const lines = paragraph
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const blocks: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (startsDialogueLine(buffer[0])) {
      const turns: string[] = [];
      for (const line of buffer) {
        if (startsDialogueLine(line) || turns.length === 0) {
          turns.push(line);
        } else {
          turns[turns.length - 1] = `${turns[turns.length - 1]} ${line}`;
        }
      }
      blocks.push(splitAttributionTail(turns.join('\n').replace(/[ \t]{2,}/g, ' ')));
    } else {
      blocks.push(splitAttributionTail(buffer.join(' ').replace(/[ \t]{2,}/g, ' ')));
    }
    buffer = [];
  };

  for (const line of lines) {
    const bufferIsDialogue = buffer.length > 0 && startsDialogueLine(buffer[0]);
    const previous = buffer[buffer.length - 1] || '';
    const shouldStartTransitionParagraph =
      !bufferIsDialogue &&
      buffer.length > 0 &&
      endsWithTerminalPunctuation(previous) &&
      startsParagraphTransitionLine(line);

    if (looksLikeHeadingOrStructure(line) || looksLikeSubtitleLine(line)) {
      flush();
      blocks.push(line);
    } else if (looksLikeSignatureLine(line)) {
      flush();
      blocks.push(line);
    } else if (startsDialogueLine(line)) {
      if (!bufferIsDialogue) flush();
      buffer.push(line);
    } else {
      if (shouldStartTransitionParagraph) {
        flush();
      }
      if (bufferIsDialogue && endsWithTerminalPunctuation(previous)) {
        flush();
      }
      buffer.push(line);
    }
  }
  flush();
  return blocks;
};

export const rearrangeAndCleanText = (text: string): string => {
  if (!text) return "";
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  const paragraphs = normalized
    .split(/\n{2,}/)
    .flatMap(normalizeParagraphLines);

  const merged: string[] = [];
  for (const paragraph of paragraphs) {
    const previous = merged[merged.length - 1];
    if (previous && looksLikeContinuationAfterArtificialBreak(previous, paragraph)) {
      merged[merged.length - 1] = `${previous} ${paragraph}`;
    } else {
      merged.push(paragraph);
    }
  }

  return markCitationBlocks(merged)
    .join('\n\n')
    .replace(/\b([A-Z])\.(?=[A-Z][a-z])/g, '$1. ')
    .trim();
};
