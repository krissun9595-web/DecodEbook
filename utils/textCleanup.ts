import { looksLikePersonName, looksLikeAttributionAuthor } from './personName';

// A trailing footnote/cross-reference link ("…AGES.”[2](#…)") and any trailing emphasis
// sit after the sentence's terminal punctuation; strip them first so a footnote-terminated
// sentence still counts as ending (otherwise the next paragraph merges in, and a sentence
// tail in small caps slips past the subtitle guard).
const endsWithTerminalPunctuation = (value: string): boolean =>
  /[.!?。！？]["'”’)\]]?$/u.test(
    value.trim().replace(/\s*\[[^\]]*\]\([^)]*\)\s*$/u, '').replace(/[*_~]+$/u, '').trim(),
  );

// Block-role / alignment sentinels (U+E010 centre, E011 right, E012 list, E013 heading) are
// prepended to a block by the PDF extractor and stripped for display downstream. Strip them here
// too so the first-character heading/subtitle tests below see the real text — otherwise a heading
// that leads with the sentinel (e.g. "THE BIRTH OF AI") fails the `^[A-Z…]` anchor, the
// heading guard never fires, and the heading is merged into the body paragraph that follows it.
const stripBlockSentinels = (value: string): string => value.replace(/[-]/g, '');

const looksLikeHeadingOrStructure = (value: string): boolean => {
  // A block carrying the heading sentinel (U+E013) IS a heading by construction — an EPUB <h1>–<h6> or
  // a TOC-anchored section heading, or a PDF geometry heading. Honour it directly and up front: the text
  // heuristics below only recognise Title-Case / all-caps headings, so a sentence-case heading
  // ("You get what you do not want") or a single word ("Guilt") would otherwise fail them and be merged
  // into the following paragraph as a run-in (losing the heading role the sentinel already granted).
  if (//.test(value)) return true;
  // Strip wrapping emphasis (an italic <h2>/<h3> extracts as "*Title*"), otherwise
  // the leading "*" hides the heading and it gets merged into the next paragraph.
  const trimmed = stripBlockSentinels(value).trim().replace(/^[*_~]+\s*/u, '').replace(/\s*[*_~]+$/u, '').trim();
  if (!trimmed) return false;
  const withoutHashes = trimmed.replace(/^#{1,6}\s*/, '');
  // A structural heading's designation is a number, roman numeral, or capitalised word
  // ("Chapter 1", "Book III", "Part One") — never a lowercase prose word. Requiring an
  // uppercase/digit after the keyword stops a soft-wrapped continuation line that merely
  // begins with one of these common words ("book tells why…", "Part of the reason…",
  // "section on trade…") from being misread as a heading and split into its own
  // paragraph — which shreds a sentence across paragraphs. (EPUB paragraphs arrive
  // pre-joined from <p> tags, so they don't begin mid-sentence; only PDF soft-wrapped
  // lines do.) The first char after the keyword is tested case-sensitively, so the
  // keyword itself still matches in any case (Chapter/chapter/CHAPTER).
  const headingDesignation = withoutHashes.match(/^(?:chapter|part|book|section|appendix)\s+(\S)/iu);
  if (headingDesignation && /[A-Z0-9]/.test(headingDesignation[1])) return true;
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
  const trimmed = stripBlockSentinels(value).trim().replace(/^[*_~]+\s*/u, '').replace(/\s*[*_~]+$/u, '').trim();
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
  const clean = stripDisplayStyleMarkers(stripBlockSentinels(value)).replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 120) return false;
  if (/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/u.test(clean)) return true;
  // A signature is a multi-token person name (initials/particles/suffixes handled by the
  // principle). Require ≥2 tokens: a lone capitalised word ("State") is a heading fragment,
  // not a signature — only after an attribution dash is a mononym treated as a credit.
  if (/\s/.test(clean) && looksLikePersonName(clean)) return true;
  // …or a dateline place.
  return /^(?:Los Angeles|New York|London|Paris|Berlin|Beijing|Shanghai|Tokyo|Hong Kong|Singapore|San Francisco|Washington(?:,\s*D\.C\.)?)$/u.test(clean);
};

const looksLikeAttributionLine = (value: string): boolean => {
  const clean = stripDisplayStyleMarkers(stripBlockSentinels(value)).replace(/\s+/g, ' ').trim();
  if (!/^(?:——|--|—|–|-)\s*\S/u.test(clean)) return false;
  return looksLikeAttributionAuthor(clean.replace(/^(?:——|--|—|–|-)\s*/u, ''));
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
  const clean = stripDisplayStyleMarkers(stripBlockSentinels(value)).replace(/\s+/g, ' ').trim();
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
  // The author may carry initials ("ARTHUR C. CLARKE", "C. S. LEWIS"), so periods are
  // allowed in the name; it is anchored to the end of the (quote-led) block, so this
  // can't run into following prose. Excluding "." here previously dropped any attribution
  // whose author has an initial, leaving the quote, credit, and next paragraph huddled.
  const match = clean.match(/^(.{20,900}?[.!?。！？"”’][*_~]{0,2}(?:\d{1,3}|\[\s*[0-9ivxlcdm]{1,8}[.)]?\s*\]\s*\([^)]+\))?[*_~]{0,2})\s*(?:——|--|—|–|-)\s*([A-Z][^!?\n]{2,140})$/u);
  if (!match) return value;
  const body = match[1].trim();
  const attribution = stripDisplayStyleMarkers(match[2]).trim();
  if (!/^[“"‘']|\*[“"‘']/.test(body)) return value;
  // Only split when the tail really is an attribution (a person name — initials/particles/
  // suffixes included — or a short source), never a stray sentence.
  if (!looksLikeAttributionAuthor(attribution)) return value;
  return `${markCitationBody(body)}\n\n—— ${attribution.replace(/^(?:——|--|—|–|-)\s*/u, '')}`;
};

const normalizeAttributionLine = (value: string): string => {
  // A leading block/alignment sentinel (U+E010–E013, e.g. a right-aligned EPUB "att" credit) must be
  // PRESERVED and re-emitted at the very start so the reader still aligns the credit — and it must be
  // stripped BEFORE the dash, else the dash regex fails on it and the source's own "—" survives under
  // the "—— " prefix ("—— —HENRY…"), while the sentinel gets buried mid-string and the alignment is
  // lost. Also strip a leading emphasis marker (an italic credit extracts as "*—Tom Stoppard,*").
  const sentinel = value.match(/^\s*([-]+)/u)?.[1] ?? '';
  const body = value.replace(/\s+/g, ' ').trim().replace(/^[-]*[*_~]*\s*(?:——|--|—|–|-)\s*/u, '');
  const linkedNote = body.match(/^(.*?)\s*(\[\s*[0-9ivxlcdm]{1,8}[.)]?\s*\]\s*\([^)]+\))\s*[*_~]*$/iu);
  if (linkedNote) {
    return `${sentinel}—— ${stripDisplayStyleMarkers(linkedNote[1])}${linkedNote[2]}`;
  }
  return `${sentinel}—— ${stripDisplayStyleMarkers(body)}`;
};

const markCitationBlocks = (paragraphs: string[]): string[] => paragraphs.map((paragraph, index) => {
  if (looksLikeAttributionLine(paragraph)) return normalizeAttributionLine(paragraph);
  const next = paragraphs[index + 1];
  if (!next || !looksLikeAttributionLine(next) || !looksLikeCitationBody(paragraph)) return paragraph;
  return markCitationBody(paragraph);
});

// Fallback continuation detector. For PDFs, processPdf now rejoins cross-page paragraphs
// geometrically (a line that fills the right margin wrapped, so it continues) and emits
// them already merged — so this text-only heuristic only handles the seams geometry can't
// decide (e.g. a page-number footer between the prose) and EPUB, which has no page markers.
const looksLikeContinuationAfterArtificialBreak = (previous: string, current: string): boolean => {
  // A block that opens with a leading NBSP indent is a deliberately SET-OFF block from the PDF geometry
  // (a definition description, an indented set-off definition/quote) — never merge it back into the
  // previous paragraph, even when that paragraph ends with a colon introducing it. (Checked before the
  // .trim() below, which would drop the NBSP and hide the indent.)
  if (/^[^\S ]* /u.test(current)) return false;
  const prev = previous.trim();
  // A PDF page boundary injects a "[[PAGE n]]" marker at the start of the next block, so
  // a sentence that runs across the page break ("…is rapidly" / "[[PAGE 15]] eroding.")
  // is split into two paragraphs and the marker blocks the continuation heuristics below.
  // Look past a leading page marker when deciding continuation; the marker stays in the
  // merged text (it carries the cross-page continuation) and is stripped for display in
  // buildPageSentenceData. EPUB has no page markers, so this never changes EPUB behaviour.
  const cur = current.trim().replace(/^\[\[PAGE\s+\d+\]\]\s*/iu, '');
  // The previous block may itself end with an attribution line — e.g. splitAttributionTail
  // returns "*quote*\n\n—— AUTHOR" as one block when a quote and its credit shared a
  // paragraph (the PDF epigraph case). The credit must never absorb the next body
  // paragraph, but the whole-block checks below miss it (the block starts with the quote,
  // not the dash), so a body paragraph starting with a capitalised word ("We believe…")
  // gets wrongly merged as a name continuation. Guard on the block's last line too.
  const prevLastLine = (prev.split('\n').pop() || '').trim();
  if (
    !prev ||
    !cur ||
    // A bullet-list item is a distinct paragraph — never merge it into the previous, even when the
    // previous ends with a colon introducing the list ("…patterns:" + "• Prompt chaining…"). The
    // bullet may be bold ("**•** …"), so skip a leading emphasis wrapper before the marker.
    /^\s*(?:[*_~`]+\s*)?[•‣▪●◦⁃∙○■]/u.test(cur) ||
    // A labeled entry (an email header "Date: …" / "To: …", an address field, a spec row) is its own
    // line — never absorb it into the previous, even one that ends in a name/word (the name-continuation
    // rule below) or a colon. Short "Label:" at line start: a capitalised word (≤24 chars) then a colon.
    /^["'“]?[A-Z][^:\n]{0,24}:(?:\s|$)/u.test(cur) ||
    endsWithTerminalPunctuation(prev) ||
    looksLikeAttributionLine(prev) ||
    looksLikeAttributionLine(prevLastLine) ||
    looksLikeSignatureLine(prevLastLine) ||
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
  if (/^\d+(?:[.,/]\d+)*\.?\b/u.test(cur) && /\b(?:at|on|in|was|were|is|are|be|been|being|of|to|from|by|with|and|or|plus|minus|equals?|until|since|after|before|around|between|circa|near|stood at|amounted to|rose to|fell to)$/iu.test(prev)) return true;
  if (/^(?:and|or|but|nor|for|yet|so|to|of|in|on|at|by|from|with|without|into|through|over|under|than|as|that|which|who|whom|whose)\b/iu.test(cur)) return true;
  // A comma / semicolon / dash at line end is a mid-sentence wrap → merge. A COLON is different: it
  // INTRODUCES a following block (a list, a definition, a set-off term/quote), so it must NOT pull that
  // block back in ("…key components:" + italic "Endpoints", "…thinking:" + "Agentic"). A genuine
  // lowercase continuation after a colon is already merged by the /^[a-z]/ rule above.
  if (/[,;—–-]\s*$/u.test(prev)) return true;
  if (/;[^.!?。！？]*$/u.test(prev) && (/;/.test(cur) || /^[A-Z][\p{L}.'-]*(?:,\s*(?:Jr\.?|Sr\.?|I{2,4}|V?I{0,3}))?;/u.test(cur))) return true;
  // Name split across a line break ("James Dale" / "Davidson"). NOT when the previous line is a BULLET
  // item (a short "• Simon Torrance") — that's a complete list entry, and the next capitalised word
  // ("Also, …") begins a new paragraph, not a name continuation.
  if (!/^(?:[*_~`]+\s*)?[•‣▪●◦⁃∙○■]/u.test(prev) && /\b[A-Z][\p{L}'-]*$/u.test(prevTail) && /^[A-Z][\p{L}'-]*(?:[,;:]|$)/u.test(firstToken)) return true;
  if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sir|Dame|St|Gen|Gov|Rev|Hon)\.?$/u.test(prevTail) && /^[A-Z]/u.test(cur)) return true;

  return false;
};

const normalizeParagraphLines = (paragraph: string): string[] => {
  const lines = paragraph
    .split('\n')
    // Trim ordinary surrounding whitespace but KEEP a leading NBSP run — it encodes a geometry-derived
    // block indent (e.g. a definition-list description sitting deeper than the body margin) that the
    // reader turns into left padding. Plain .trim() removes NBSP and would flatten the indent.
    .map(line => line.replace(/^[^\S\u00a0]+/u, '').replace(/[ \t\f\v]+$/u, ''))
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
