
import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, ChevronLeft, ChevronRight, Eye, Headphones, Download, RotateCcw, RotateCw, Columns, Globe, Settings2, Square, RefreshCw, Volume2, Minimize2, Maximize2, Activity, Share2 } from 'lucide-react';
import { Chapter, FileContext, AppSettings, ThemeColor, ReaderPageTarget, PdfFigure } from '../types';
import { extractChapterText, generateSpeech, translateSentences, translateFigureText, redrawFigureTranslated } from '../services/gemini';
import { Loader } from './ui/Loader';
import { pcmToWav } from '../utils/audio';
import { saveFile, getFile, buildCacheKey } from '../services/fileCache';
import { shareFile } from '../utils/share';
import { titleCase } from '../utils/filename';
import { trackGeneration, trackShare, trackError } from '../utils/analytics';
import { rearrangeAndCleanText } from '../utils/textCleanup';
import {
  findTopicHeadingForExtractedText,
  findTopicHeadingAtOffset,
  findTopicHeadingBeforeOffset,
  normalizeNotesReaderText,
  paginateReaderText,
  computePageTargetSize,
  type ReaderBlock,
  type ReaderPage,
  type ReaderTopicBlock,
} from '../utils/readerStructure';
import { splitIntoSentences } from '../utils/sentenceSplit';
import { looksLikeAttributionAuthor, looksLikePersonName } from '../utils/personName';
import { inkLineStyle } from '../utils/inkLine';
import {
  isBibleReferenceAtEnd,
  isBibleReferenceMarkerCandidate,
  isNumericTextMarkerCandidate,
  isStandaloneYearAtEnd,
} from '../utils/footnotes';

interface Props {
  chapter: Chapter;
  allChapters: Chapter[];
  fileContext: FileContext;
  settings: AppSettings;
  onSettingsUpdate: (settings: AppSettings) => void;
  bookId: string;
  initialPageTarget?: ReaderPageTarget;
  onChapterChange?: (chapterId: number, pageTarget?: ReaderPageTarget) => void;
}

interface QuantumParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  hue: number;
  alpha: number;
  targetSize: number;
  intensity: number;
  angle: number;
  type: 'pixel' | 'data' | 'shimmer';
  life: number;
}

const VOICES = [
  { name: 'Puck', label: 'Puck (Male)', tone: 'NARRATIVE' },
  { name: 'Charon', label: 'Charon (Male)', tone: 'RESONANT' },
  { name: 'Kore', label: 'Kore (Female)', tone: 'MELODIC' },
  { name: 'Fenrir', label: 'Fenrir (Male)', tone: 'RUGGED' },
  { name: 'Zephyr', label: 'Zephyr (Female)', tone: 'SERENE' }
];

const LANGUAGES = [
  'Original', 'Arabic', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Dutch', 'English', 'French', 'German', 'Hindi', 'Indonesian', 'Italian', 'Japanese', 'Korean', 'Polish', 'Portuguese', 'Russian', 'Spanish', 'Swedish', 'Thai', 'Turkish', 'Vietnamese'
];

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const CONCURRENCY_LIMIT = 3;
const TTS_BATCH_SIZE = 4;
const CHAPTER_TEXT_CACHE_VERSION = 'v31-side-by-side-columns';
const AUDIO_CACHE_VERSION = 'v9-bibliographic-abbreviation-timings';
const TRANSLATION_CACHE_VERSION = 'v18-dbname-restore';

// Module-level store for in-flight audio generation.
// Survives component unmount/remount so generation isn't lost on tab switch.
interface InFlightAudio {
  promise: Promise<{ blob: Blob; timings: ChunkTiming[] } | null>;
  abort: () => void;
}
const inflightAudioMap = new Map<string, InFlightAudio>();

// Persist user selections across unmount/remount
let lastAudioVoice: string | null = null;
let lastAudioLanguage: string | null = null;
let lastViewMode: 'single' | 'split' | null = null;
let lastAutoScroll: boolean | null = null;
let lastVoiceSynthMinimized: boolean | null = null;

const readStoredValue = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStoredValue = (key: string, value: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures; in-memory defaults still work for this session.
  }
};

const initialAudioLanguage = (): string => {
  if (lastAudioLanguage) return lastAudioLanguage;
  const stored = readStoredValue('audiobook_audio_language');
  lastAudioLanguage = stored || 'Original';
  return lastAudioLanguage;
};

const initialViewMode = (): 'single' | 'split' => {
  if (lastViewMode) return lastViewMode;
  const stored = readStoredValue('audiobook_view_mode');
  lastViewMode = stored === 'single' ? 'single' : 'split';
  return lastViewMode;
};

const initialAutoScroll = (): boolean => {
  if (lastAutoScroll !== null) return lastAutoScroll;
  const stored = readStoredValue('audiobook_auto_scroll');
  lastAutoScroll = stored === null ? true : stored !== 'false';
  return lastAutoScroll;
};

const initialVoiceSynthMinimized = (): boolean => {
  if (lastVoiceSynthMinimized !== null) return lastVoiceSynthMinimized;
  const stored = readStoredValue('voice_synth_player_minimized');
  lastVoiceSynthMinimized = stored === null ? true : stored !== 'false';
  return lastVoiceSynthMinimized;
};

// Module-level cache for timings (keyed same as audio cache)
const timingsCache = new Map<string, ChunkTiming[]>();
const translationJobMap = new Map<string, Promise<string[] | null>>();
const translationMemoryCache = new Map<string, string[]>();
// Remembers the last playback position per audio (cache key) so leaving the module
// — e.g. clicking a footnote — and returning resumes where the user left off instead
// of snapping the progress bar back to the start.
const audioPlaybackPositions = new Map<string, number>();

interface ChunkTiming {
  text: string;
  start: number;
  end: number;
  isWhitespace: boolean;
}

const timingStorageKeyFor = (audioKey: string): string => `decodebook_audio_timings:${audioKey}`;

const readStoredTimings = (audioKey: string): ChunkTiming[] | null => {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(timingStorageKeyFor(audioKey)) || 'null');
    if (!Array.isArray(parsed)) return null;
    const timings = parsed
      .map((entry): ChunkTiming | null => {
        if (!entry || typeof entry.start !== 'number' || typeof entry.end !== 'number') return null;
        return {
          text: typeof entry.text === 'string' ? entry.text : '',
          start: entry.start,
          end: entry.end,
          isWhitespace: Boolean(entry.isWhitespace),
        };
      })
      .filter(Boolean) as ChunkTiming[];
    return timings.length > 0 ? timings : null;
  } catch {
    return null;
  }
};

const writeStoredTimings = (audioKey: string, timings: ChunkTiming[]): void => {
  if (typeof window === 'undefined' || timings.length === 0) return;
  try {
    window.localStorage.setItem(timingStorageKeyFor(audioKey), JSON.stringify(timings));
  } catch {
    // Timing persistence is best-effort; audio generation should not fail if storage is full.
  }
};

interface SentenceMap {
    pIndex: number;
    sIndex: number;
    globalIndex: number;
    text: string;
    lineBreakAfter?: boolean;
}

interface SentenceRun {
    text: string;
    globalIndex: number;
}

interface ParagraphLineRun {
    sentence: string;
    sIdx: number;
    globalIndex: number;
}

interface InkedSelection {
  text: string;
  sentenceIndex: number;
  startOffset?: number;
  source?: string;
}

interface ParagraphData {
    original: string[];
    translated: string[];
    indent?: number;
    align?: 'right' | 'center';
    role?: 'list' | 'heading';
    // A side-by-side two-column region (from a two-column PDF page): each column an array of
    // paragraphs, each paragraph its sentences with a global index (so the sentences translate and
    // highlight like any other). Rendered as side-by-side columns; in split view the translated
    // columns render in the right half.
    columns?: { left: ColumnPara[]; right: ColumnPara[] };
    // An extracted PDF figure: the image bytes live in the file cache (fileType 'figure-image',
    // key bookId + id). Rendered as an inline image; carries no sentences (invisible to TTS/
    // translation/highlighting).
    figure?: { id: string };
}

interface ColumnPara { sentences: { text: string; gi: number }[] }

const HIGHLIGHT_STYLES: Record<ThemeColor, string> = {
  indigo: 'text-[#00f3ff] drop-shadow-[0_0_2px_rgba(0,243,255,0.8)]',
  emerald: 'text-emerald-400 drop-shadow-[0_0_2px_rgba(52,211,153,0.8)]',
  rose: 'text-[#ff003c] drop-shadow-[0_0_2px_rgba(255,0,60,0.8)]',
  amber: 'text-amber-400 drop-shadow-[0_0_2px_rgba(251,191,36,0.8)]',
  violet: 'text-violet-400 drop-shadow-[0_0_2px_rgba(167,139,250,0.8)]',
  pink: 'text-[#ff4fd8] drop-shadow-[0_0_2px_rgba(255,79,216,0.8)]',
};

// Hyperlinks render in the app's selected accent colour (not the PDF's original link colour), so a
// link is unmistakable and easy to match against the coloured link in the source. Static strings so
// Tailwind keeps the classes.
const LINK_STYLES: Record<ThemeColor, string> = {
  indigo: 'text-[#00f3ff] underline decoration-[#00f3ff]/70 underline-offset-4 hover:text-white',
  emerald: 'text-emerald-400 underline decoration-emerald-400/70 underline-offset-4 hover:text-white',
  rose: 'text-[#ff003c] underline decoration-[#ff003c]/70 underline-offset-4 hover:text-white',
  amber: 'text-amber-400 underline decoration-amber-400/70 underline-offset-4 hover:text-white',
  violet: 'text-violet-400 underline decoration-violet-400/70 underline-offset-4 hover:text-white',
  pink: 'text-[#ff4fd8] underline decoration-[#ff4fd8]/70 underline-offset-4 hover:text-white',
};

const HIGHLIGHT_TEXT_COLORS: Record<ThemeColor, string> = {
  indigo: '#00f3ff',
  emerald: '#34d399',
  rose: '#ff003c',
  amber: '#fbbf24',
  violet: '#a78bfa',
  pink: '#ff4fd8',
};

const INK_LINE_COLORS: Record<ThemeColor, string> = {
  indigo: '#00f3ff',
  emerald: '#34d399',
  rose: '#ff003c',
  amber: '#fbbf24',
  violet: '#a78bfa',
  pink: '#ff4fd8',
};

const TEXT_SIZES: Record<string, string> = {
  sm: 'text-[14px]',
  base: 'text-[16px]',
  lg: 'text-[18px]',
  xl: 'text-[22px]',
};

const LINE_HEIGHTS: Record<string, string> = {
  tight: 'leading-tight',
  normal: 'leading-normal',
  relaxed: 'leading-relaxed',
  loose: 'leading-loose',
};

const LETTER_SPACINGS: Record<string, string> = {
  tighter: 'tracking-tighter',
  normal: 'tracking-normal',
  wide: 'tracking-wide',
  wider: 'tracking-wider',
};

type InlineFormat = 'plain' | 'bold' | 'italic' | 'underline' | 'strike' | 'link' | 'attribution' | 'attributionFootnote' | 'footnote' | 'referenceMarker' | 'lineBreak';

interface InlineSegment {
  text: string;
  format: InlineFormat;
  href?: string;
  marker?: string;
}

interface FootnoteRef {
  marker: string;
  href?: string;
  // True for a roman/reference marker (rendered as a superscript), false for a
  // numeric footnote (rendered as a subscript).
  isReference?: boolean;
  // True when the reference marker labels the start of the line (a note-definition
  // label, e.g. "I. Nomenklaturas are…"). Such markers render BEFORE the translated
  // content to mirror the original, instead of being appended at the end.
  isLeading?: boolean;
  // The marker's display text including its trailing separator (e.g. "I."), so the
  // translated leading marker reads exactly like the original.
  displayText?: string;
}

interface PositionedFootnoteRef extends FootnoteRef {
  sentenceIndex: number;
}

interface LeadingNoteRef extends FootnoteRef {
  noteKey?: string;
}

interface InlineParseOptions {
  internalNoteLinksAsFootnotes?: boolean;
  inferBareFootnotes?: boolean;
  romanMarkersAsReferences?: boolean;
}

// A flattened footnote marker is a small digit that PDF flattening dropped inline. We only
// recover it after strong, low-ambiguity signals: sentence punctuation or a closing quote
// ("…end.27", "…word.”27"). We deliberately do NOT treat a digit glued to a plain word
// ("Zip2", "Model3", "COVID19") as a footnote — that content-only guess has no PDF backing
// and misfires on product names and identifiers. Real markers backed by a link annotation
// are emitted by the extractor as explicit "[N](#pdffn…)" / "[N](#pdfnote…)" links and are
// handled by the link parser above, not here.
const FOOTNOTE_MARKER_PATTERN = /((?<!\d)[.!?。！？,;:][”"’")\]]?|[”"’")\]])(\d{1,3})(?=(?:\s|$|(?:——|--|—|–|-)))/gu;

const stripInlineMarkupSyntax = (value: string): string => value
  .replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/~~([^~]+)~~/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1');

const stripOrphanDisplayMarkers = (value: string): string =>
  value.replace(/[*_~]/g, '');

const normalizeInternalLinkMarkup = (value: string): string =>
  value.replace(/\[\s*([^\]\n]{1,120}?)\s*\]\s*\(([^)\n]+)\)/g, (match, rawLabel: string, rawHref: string) => {
    const label = rawLabel.replace(/\s+/g, ' ').trim();
    const href = rawHref.trim();
    return label && href ? `[${label}](${href})` : match;
  });

// A PDF index: processPdf emits one entry per line and encodes each entry's depth as
// leading non-breaking spaces (4 per level). Drop the page markers, make each entry its
// own paragraph (so buildPageSentenceData captures the per-entry indent), and keep the
// leading NBSP so the renderer applies the matching left padding. EPUB indexes keep their
// own light cleanup path; this runs only for PDF sources.
const formatPdfIndexEntries = (rawText: string): string =>
  normalizeInternalLinkMarkup(rawText)
    .replace(/\[\[PAGE\s+\d+\]\]/g, '')
    .split('\n')
    .map(line => {
      const indent = line.match(/^ +/)?.[0] ?? '';
      const body = line.slice(indent.length).trim();
      return body ? indent + body : '';
    })
    .filter(Boolean)
    .join('\n\n');

const stripFootnoteMarkers = (value: string): string => value.replace(
  FOOTNOTE_MARKER_PATTERN,
  (match, punctuation: string, _marker: string, offset: number, source: string) => {
    const previous = source[offset - 1] || '';
    if (punctuation === '.' && /\d/u.test(previous)) return match;
    if (isBibleReferenceMarkerCandidate(source, offset, punctuation, _marker)) return match;
    if (isNumericTextMarkerCandidate(source, offset, punctuation, _marker)) return match;
    return punctuation;
  }
);

// Remove internal footnote/reference links entirely — the marker is not content.
// Done before the generic link->label flattening, otherwise a footnote after a number
// ("1999.[2](...#...)") would flatten to a bare "1999.2" whose "2" the decimal guard
// in stripFootnoteMarkers then keeps, leaking the number into translation/audio.
const stripInternalFootnoteLinks = (value: string): string =>
  value
    // A leading note/reference marker ("[I](#...). " at the very start of a line) is a
    // label, not content. Strip the marker AND its trailing separator punctuation so the
    // remaining text (used for translation/audio/matching) does not begin with a stray
    // ". " — otherwise the translation keeps the leading period, which splits into its own
    // sentence and the inherited reference marker latches onto it, rendering ".¹" with the
    // period before the numeral instead of after it.
    .replace(/^([ \t ]*)\[\s*(?:fn\s*)?[0-9ivxlcdm]{1,8}[.)]?\s*\]\s*\([^)\n]*#[^)\n]*\)[.)]?[ \t ]*/iu, '$1')
    .replace(/\[\s*(?:fn\s*)?[0-9ivxlcdm]{1,8}[.)]?\s*\]\s*\([^)\n]*#[^)\n]*\)/giu, '');

// Drop orphan emphasis markers (e.g. a lone "*" left by a blockquote's tangled
// emphasis) before stripping footnote markers, otherwise a stray "*" between the
// punctuation and a footnote number prevents the number from being stripped — so it
// leaks into translation/audio input and gets echoed as prose.
const stripInlineFormatSyntax = (value: string): string =>
  stripFootnoteMarkers(stripOrphanDisplayMarkers(stripInlineMarkupSyntax(stripInternalFootnoteLinks(value))));

// The emphasis wrapper a whole sentence is in (e.g. "*...*" for an italic quote,
// "**...**" for bold), ignoring a trailing footnote link. Used so the translated
// layer can match the original's italic/bold formatting. Returns '' if none.
const wholeSentenceEmphasisWrapper = (value: string): string => {
  const core = value.trim().replace(/\[[^\]\n]*\]\([^)\n]*\)\s*$/u, '').trim();
  for (const wrapper of ['**', '__', '~~', '*', '_', '~']) {
    if (core.length > wrapper.length * 2 && core.startsWith(wrapper) && core.endsWith(wrapper)) {
      const inner = core.slice(wrapper.length, core.length - wrapper.length);
      if (!inner.includes(wrapper)) return wrapper;
    }
  }
  return '';
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cleanNoteMarkerLabel = (value: string): string =>
  value.replace(/^\[|\]$/g, '').replace(/[.)]+$/g, '').trim();

// A numbered note marker: a bare 1–3 digit number, OR the literal "fn"-prefixed form some
// books print for page-bottom / chapter-end footnotes ("fn3"). Both render as the footnote
// marker with their ORIGINAL text preserved — "fn3" shows as "fn3", not a synthesized "3".
const isNumericNoteMarkerText = (value: string): boolean =>
  /^(?:fn\s*)?\d{1,3}[.)]?$/iu.test(cleanNoteMarkerLabel(value));

const isRomanNoteMarkerText = (value: string): boolean =>
  /^[ivxlcdm]{1,8}[.)]?$/iu.test(cleanNoteMarkerLabel(value));

const noteKeyFromHref = (href?: string): string | undefined => {
  if (!href) return undefined;
  // Two PDF footnote href schemes coexist:
  //  - "#pdffn-…" (annotation-backed): the marker's real link destination, and the same
  //    key is injected onto the note entry, so it pairs exactly like an EPUB anchor — it
  //    must yield a key (handled by the normaliser below, since it isn't "#pdfnote-").
  //  - "#pdfnote-<page>-<n>" (geometry-only, no link annotation): the note entry has no
  //    matching anchor, so a derived key could never match and would only make the
  //    resolver give up and suppress the back-link. Treat it as anchorless and let the
  //    chapter-scope path (chapter + marker number) resolve it, as anchorless EPUB notes
  //    do. (EPUB anchors never start with "#pdfnote", so EPUB note keys are unaffected.)
  if (/^#pdfnote-/iu.test(href)) return undefined;
  const hash = href.match(/#([^#/?]+)/u)?.[1];
  const raw = hash || href;
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/gu, '');
  return normalized || undefined;
};

const isNotesChapterTitle = (value: string): boolean =>
  /^(?:chapter\s+)?(?:notes|endnotes|footnotes|references)\b|(?:notes|endnotes|footnotes)$/iu.test(value.trim());

const isIndexChapterTitle = (value: string): boolean =>
  /^(?:chapter\s+)?index\b|\bindex$/iu.test(value.trim());

const normalizeNoteScopeText = (value?: string): string =>
  stripInlineFormatSyntax(value || '')
    .toLowerCase()
    .replace(/^(?:chapter|part|book)\s+\d+[\).:\-–—]?\s*/iu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const explicitChapterNumberFrom = (...values: Array<string | undefined>): number | undefined => {
  for (const value of values) {
    const clean = stripInlineFormatSyntax(value || '').trim();
    const match = clean.match(/^(?:chapter\s*)?(\d{1,3})[\).:\-–—\s]/iu);
    if (match) return Number(match[1]);
  }
  return undefined;
};

const noteMarkerSourceFor = (marker: string): string => {
  const escaped = escapeRegExp(marker);
  return `(?:\\[${escaped}\\]|(?:no\\.?|note)\\s*${escaped}[.)]?|${escaped}[.)]?)`;
};

const linkedNoteMarkerSourceFor = (marker: string): string =>
  `(?:\\[${noteMarkerSourceFor(marker)}\\]\\([^)]+\\)|${noteMarkerSourceFor(marker)})`;

const noteStartPatternFor = (marker: string): RegExp => {
  const esc = escapeRegExp(marker);
  // A note ENTRY begins with the marker as a LABEL: a linked "[I](#…)", a bracketed "[I]", an explicit
  // "no./note I", or the bare marker with a trailing separator. For a ROMAN-numeral marker the trailing
  // separator on the BARE form is REQUIRED ("I." not "I ") — otherwise the note-page lookup matches a
  // sentence that simply begins with the pronoun/word "I" (or "V"/"X"…), so a chapter-end Roman note
  // never resolves uniquely and its bidirectional link/back navigation fails. Numeric markers can't
  // collide with a word, so they keep the lenient optional separator.
  const isRoman = /^[ivxlcdm]+$/i.test(cleanNoteMarkerLabel(marker));
  const bare = isRoman ? `${esc}[.)]` : `${esc}[.)]?`;
  const label = `(?:\\[\\s*${esc}[.)]?\\s*\\](?:\\s*\\([^)\\n]*\\))?|(?:no\\.?|note)\\s*${esc}[.)]?|${bare})`;
  return new RegExp(`(?:^|\\n)\\s*${label}(?:[.)])?(?:\\s+|$)`, 'iu');
};

const parseLeadingNoteMarker = (
  value: string,
  marker: string
): { label: string; rest: string; href?: string; noteKey?: string } | null => {
  const clean = value.trimStart();
  const linkedMatch = clean.match(new RegExp(`^\\[(${noteMarkerSourceFor(marker)})\\]\\(([^)]+)\\)(?:[.)])?(?:\\s+|$)`, 'iu'));
  if (linkedMatch) {
    return {
      label: cleanNoteMarkerLabel(linkedMatch[1]),
      rest: clean.slice(linkedMatch[0].length),
      href: linkedMatch[2],
      noteKey: noteKeyFromHref(linkedMatch[2]),
    };
  }
  const match = clean.match(new RegExp(`^(${noteMarkerSourceFor(marker)})(?:\\s+|$)`, 'iu'));
  if (!match) return null;
  return {
    label: cleanNoteMarkerLabel(match[1]),
    rest: clean.slice(match[0].length),
  };
};

const sentenceStartsWithNoteMarker = (value: string, marker: string, noteKey?: string): boolean => {
  const linked = parseLeadingNoteMarker(value, marker);
  if (linked) return noteKey ? linked.noteKey === noteKey : true;
  if (noteKey) return false;
  return new RegExp(`^\\s*${linkedNoteMarkerSourceFor(marker)}(?:[.)])?(?:\\s+|$)`, 'iu').test(value) ||
    new RegExp(`^\\s*${noteMarkerSourceFor(marker)}(?:\\s+|$)`, 'iu').test(stripInlineFormatSyntax(value));
};

const splitLeadingNoteMarker = (value: string, marker: string, noteKey?: string): { label: string; rest: string } | null => {
  const parsed = parseLeadingNoteMarker(value, marker);
  if (!parsed || (noteKey && parsed.noteKey !== noteKey)) return null;
  return { label: parsed.label, rest: parsed.rest };
};

const isInternalEbookHref = (href: string): boolean =>
  Boolean(href) && !/^(?:https?:|mailto:|tel:|blob:|data:)/iu.test(href);

const isLikelyInternalNoteLink = (text: string, href?: string): boolean =>
  Boolean(href && href.includes('#') && isInternalEbookHref(href) && isNumericNoteMarkerText(text));

const isLikelyInternalRomanReferenceLink = (text: string, href?: string): boolean =>
  Boolean(href && href.includes('#') && isInternalEbookHref(href) && isRomanNoteMarkerText(text));

// A long URL shown as its own link text has no spaces, so it can't wrap: the browser jumps the
// whole token to the next line and leaves a ragged blank gap on the line before it. Insert a <wbr>
// (a zero-width break OPPORTUNITY — invisible, and not included when the text is copied) after each
// run of URL delimiters (/ . - ? = & : _), so the URL wraps at natural points and fills the line.
// Only applied to URL-looking text; a short custom label ("click here") is returned unchanged so it
// never breaks. Purely visual — the copied/selected text and the href are untouched.
const renderUrlWithBreaks = (value: string, keyBase: string): React.ReactNode => {
  if (!/:\/\//.test(value) && !/^["'(<]*\s*www\./iu.test(value)) return value;
  const parts = value.split(/([/.\-?=&:_]+)/u);
  if (parts.length < 4) return value;
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const chunk = (parts[i] || '') + (parts[i + 1] || '');
    if (chunk) nodes.push(chunk);
    if (parts[i + 1] && i + 2 < parts.length) nodes.push(<wbr key={`${keyBase}-wbr-${i}`} />);
  }
  return nodes;
};

const attributionTailFor = (value: string): { body: string; attribution: string } | null => {
  const clean = value.replace(/\s+/g, ' ').trim();
  const match = clean.match(/^(.{20,900}?[.!?。！？"”’](?:\d{1,3})?[*_~]{0,2})\s*(?:——|--|—|–|-)\s*([A-Z][^!?\n]{2,140})$/u);
  if (!match) return null;
  const body = match[1].trim();
  const attribution = stripOrphanDisplayMarkers(match[2]).trim();
  if (!/^[“"‘']|\*[“"‘']/.test(body)) return null;
  // The tail must read as an attribution (person name with initials/particles/suffixes,
  // or a short source) rather than a stray sentence.
  if (!looksLikeAttributionAuthor(attribution)) return null;
  return { body, attribution };
};

const looksLikeStandaloneCitation = (value: string): boolean => {
  const clean = stripInlineMarkupSyntax(value).replace(/\s+/g, ' ').trim();
  if (!/^[“"‘']/.test(clean) || clean.length < 24 || clean.length > 700) return false;
  if (/\b(?:asked|said|responded|replied|answered|whispered|shouted|muttered)\b/i.test(clean)) return false;
  return /[”"’](?:[.!?。！？])?(?:\d{1,3})?$/.test(clean);
};

const looksLikeAttributionLine = (value: string): boolean => {
  const clean = stripInlineFormatSyntax(value).replace(/\s+/g, ' ').trim();
  if (!/^(?:——|--|—|–|-)\s*\S/u.test(clean)) return false;
  return looksLikeAttributionAuthor(clean.replace(/^(?:——|--|—|–|-)\s*/u, ''));
};

const normalizeAttributionAuthor = (value: string): string =>
  stripOrphanDisplayMarkers(stripInlineMarkupSyntax(value).replace(/^(?:——|--|—|–|-)\s*/u, '')).replace(/\s+/g, ' ').trim();

const attributionLineSegmentsFor = (
  value: string,
  options: InlineParseOptions
): InlineSegment[] | null => {
  if (!looksLikeAttributionLine(value)) return null;

  const clean = value.replace(/\s+/g, ' ').trim();
  const body = clean.replace(/^(?:——|--|—|–|-)\s*/u, '');
  const linkedMarker = body.match(/^(.*?)\s*\[([0-9ivxlcdm]{1,8}[.)]?)\]\(([^)]+)\)\s*$/iu);
  if (
    linkedMarker &&
    options.internalNoteLinksAsFootnotes &&
    isLikelyInternalNoteLink(linkedMarker[2], linkedMarker[3])
  ) {
    const author = normalizeAttributionAuthor(linkedMarker[1]);
    if (author) {
      return [{
        text: `—— ${author}`,
        format: 'attributionFootnote',
        marker: cleanNoteMarkerLabel(linkedMarker[2]),
        href: linkedMarker[3],
      }];
    }
  }

  const bareMarker = body.match(/^(.+?)(?:\s*)(\d{1,3})[.)]?\s*$/u);
  if (bareMarker) {
    const author = normalizeAttributionAuthor(bareMarker[1]);
    const markerStart = body.length - (bareMarker[2]?.length || 0);
    const markerIsAttached = markerStart > 0 && !/\s/u.test(body[markerStart - 1] || '');
    if (
      author &&
      markerIsAttached &&
      author.split(/\s+/).length <= 18 &&
      /^[\p{Lu}\p{Lo}"“‘]/u.test(author) &&
      !isBibleReferenceAtEnd(`${author}${bareMarker[2]}`) &&
      !isStandaloneYearAtEnd(body)
    ) {
      return [{
        text: `—— ${author}`,
        format: 'attributionFootnote',
        marker: cleanNoteMarkerLabel(bareMarker[2]),
      }];
    }
  }

  return [{
    text: `—— ${normalizeAttributionAuthor(value)}`,
    format: 'attribution',
  }];
};

const parseInlineFormatting = (value: string, options: InlineParseOptions = {}): InlineSegment[] => {
  value = normalizeInternalLinkMarkup(value);
  const attribution = attributionTailFor(value);
  if (attribution) {
    return [
      ...parseInlineFormatting(`*${stripOrphanDisplayMarkers(stripInlineMarkupSyntax(attribution.body))}*`, options),
      { text: `—— ${attribution.attribution}`, format: 'attribution' },
    ];
  }
  if (looksLikeStandaloneCitation(value)) {
    // Split off a trailing footnote/reference link BEFORE wrapping the quote in emphasis. Wrapping
    // the whole value would run the link through stripInlineMarkupSyntax, collapsing "[1](#pdffn…)"
    // to a bare "1" and destroying the note href (the reader then infers a hrefless footnote and the
    // note can't be resolved). Wrap only the quote body and re-append the link so it parses as a
    // footnote WITH its href. Skip when the body is already emphasised — this is also what prevents
    // infinite recursion, since the re-appended link keeps the value from ending in "*".
    const trimmed = value.trim();
    const trail = trimmed.match(/(\[[^\]\n]+\]\([^)\n]+\))\s*$/u);
    const body = trail ? trimmed.slice(0, trail.index).trim() : trimmed;
    if (!/^\*[\s\S]*\*$/u.test(body)) {
      return parseInlineFormatting(`*${stripOrphanDisplayMarkers(stripInlineMarkupSyntax(body))}*${trail ? trail[1] : ''}`, options);
    }
  }
  const attributionLine = attributionLineSegmentsFor(value, options);
  if (attributionLine) return attributionLine;

  const segments: InlineSegment[] = [];
  // An emphasis span (e.g. a blockquote/epigraph extracted as *...*) can contain a
  // footnote/reference link. The emphasis regex would otherwise swallow the link as
  // plain text, so it renders as raw markdown. Pull nested links out, converting note
  // links to footnote/reference markers and keeping the rest in the emphasis format.
  const pushEmphasisContent = (inner: string, format: InlineFormat) => {
    const linkRe = /\[([^\]]+)\]\s*\(([^)]+)\)/g;
    let last = 0;
    let linkMatch: RegExpExecArray | null;
    let matchedLink = false;
    while ((linkMatch = linkRe.exec(inner)) !== null) {
      matchedLink = true;
      if (linkMatch.index > last) segments.push({ text: inner.slice(last, linkMatch.index), format });
      const label = cleanNoteMarkerLabel(linkMatch[1]);
      const hasBodyBefore = inner.slice(0, linkMatch.index).trim().length > 0;
      if (options.internalNoteLinksAsFootnotes && hasBodyBefore && (isLikelyInternalNoteLink(label, linkMatch[2]) || isLikelyInternalRomanReferenceLink(label, linkMatch[2]))) {
        segments.push({ text: label, format: 'footnote', href: linkMatch[2] });
      } else if (options.internalNoteLinksAsFootnotes && isLikelyInternalRomanReferenceLink(label, linkMatch[2])) {
        segments.push({ text: label, format: 'referenceMarker', href: linkMatch[2] });
      } else {
        segments.push({ text: linkMatch[1], format: 'link', href: linkMatch[2] });
      }
      last = linkRe.lastIndex;
    }
    if (!matchedLink) {
      segments.push({ text: inner, format });
      return;
    }
    if (last < inner.length) segments.push({ text: inner.slice(last), format });
  };
  const leadingRomanReference = options.romanMarkersAsReferences
    ? value.match(/^\s*([ivxlcdm]{1,8})([.)])(?:\s|\u00a0)+(?=[\p{Lu}"“‘《])/iu)
    : null;
  let cursor = 0;
  if (leadingRomanReference) {
    segments.push({ text: `${cleanNoteMarkerLabel(leadingRomanReference[1])}${leadingRomanReference[2]}`, format: 'referenceMarker' });
    cursor = leadingRomanReference[0].length;
  }
  const pattern = /\[([^\]]+)\]\s*\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*/g;
  let match: RegExpExecArray | null;
  pattern.lastIndex = cursor;

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: value.slice(cursor, match.index), format: 'plain' });
    }
    if (match[1]) {
      const label = cleanNoteMarkerLabel(match[1]);
      const hasBodyTextBeforeLink = value.slice(0, match.index).trim().length > 0;
      // A body footnote marker can be SPLIT off into its own sentence when the annotated clause
      // ends in "…!**[2]" (terminal punctuation + a closing bold right before the marker), leaving
      // the marker alone with no text before it. Treat a marker that is alone (nothing before AND
      // nothing after) as a footnote too — only a note-ENTRY number ("[II] Adam Smith…", text
      // after, none before) should stay plain.
      const hasTextAfterLink = value.slice(pattern.lastIndex).trim().length > 0;
      const isBodyNoteMarker = hasBodyTextBeforeLink || !hasTextAfterLink;
      if (
        options.internalNoteLinksAsFootnotes && isBodyNoteMarker &&
        (isLikelyInternalNoteLink(label, match[2]) || isLikelyInternalRomanReferenceLink(label, match[2]))
      ) {
        // A note marker embedded in body prose — numeric OR Roman ("nomenklaturas,ᴵ") — navigates
        // to its note and back, exactly like a numbered footnote. Only a LEADING Roman label (a
        // note ENTRY, text after but none before) stays a non-interactive reference marker below.
        segments.push({ text: label, format: 'footnote', href: match[2] });
      } else if (options.internalNoteLinksAsFootnotes && isLikelyInternalRomanReferenceLink(label, match[2])) {
        const labelPunctuation = match[1].match(/[.)]\s*$/u)?.[0]?.trim() || '';
        const trailingPunctuation = labelPunctuation || (value[pattern.lastIndex] === '.' ? '.' : '');
        segments.push({ text: `${label}${trailingPunctuation}`, format: 'referenceMarker', href: match[2] });
        if (!labelPunctuation && trailingPunctuation) pattern.lastIndex += 1;
      } else {
        // A link's boundary whitespace belongs OUTSIDE the link: when a URL's annotation
        // rect covers the leading space ("…at [ https://…]"), keep that space as plain text
        // so the preceding word isn't glued to the link ("athttps://…").
        const parts = match[1].match(/^(\s*)([\s\S]*?)(\s*)$/);
        if (parts && (parts[1] || parts[3])) {
          if (parts[1]) segments.push({ text: parts[1], format: 'plain' });
          segments.push({ text: parts[2], format: 'link', href: match[2] });
          if (parts[3]) segments.push({ text: parts[3], format: 'plain' });
        } else {
          segments.push({ text: match[1], format: 'link', href: match[2] });
        }
      }
    } else if (match[3]) {
      pushEmphasisContent(match[3], 'bold');
    } else if (match[4]) {
      pushEmphasisContent(match[4], 'underline');
    } else if (match[5]) {
      pushEmphasisContent(match[5], 'strike');
    } else if (match[6]) {
      pushEmphasisContent(match[6], 'italic');
    }
    cursor = pattern.lastIndex;
  }

  if (cursor < value.length) segments.push({ text: value.slice(cursor), format: 'plain' });
  return segments
    .flatMap(segment => {
      if (segment.format === 'footnote' || segment.format === 'referenceMarker' || segment.format === 'lineBreak') return [segment];
      // A digit inside a link (a URL hash like "…59763136bdd7", or already-linked text) is part
      // of that link, not a footnote marker — never split a marker out of a link segment.
      if (segment.href) return [segment];
      if (options.inferBareFootnotes === false) return [segment];
      const split: InlineSegment[] = [];
      let localCursor = 0;
      let footnoteMatch: RegExpExecArray | null;
      FOOTNOTE_MARKER_PATTERN.lastIndex = 0;
      while ((footnoteMatch = FOOTNOTE_MARKER_PATTERN.exec(segment.text)) !== null) {
        const punctuation = footnoteMatch[1];
        const marker = footnoteMatch[2];
        const previous = segment.text[footnoteMatch.index - 1] || '';
        if (punctuation === '.' && /\d/u.test(previous)) continue;
        if (isBibleReferenceMarkerCandidate(segment.text, footnoteMatch.index, punctuation, marker)) continue;
        if (isNumericTextMarkerCandidate(segment.text, footnoteMatch.index, punctuation, marker)) continue;
        if (footnoteMatch.index > localCursor) {
          split.push({
            text: stripOrphanDisplayMarkers(segment.text.slice(localCursor, footnoteMatch.index)),
            format: segment.format,
            href: segment.href,
          });
        }
        split.push({ text: stripOrphanDisplayMarkers(punctuation), format: segment.format, href: segment.href });
        split.push({ text: marker, format: 'footnote' });
        localCursor = footnoteMatch.index + footnoteMatch[0].length;
      }
      if (localCursor < segment.text.length) {
        split.push({ text: stripOrphanDisplayMarkers(segment.text.slice(localCursor)), format: segment.format, href: segment.href });
      }
      return split.length > 0 ? split : [segment];
    })
    .map(segment => segment.format === 'footnote' || segment.format === 'referenceMarker' || segment.format === 'lineBreak'
      ? segment
      : { ...segment, text: stripOrphanDisplayMarkers(segment.text) }
    )
    .filter(segment => segment.text.length > 0);
};

const footnoteRefsForText = (value: string, options: InlineParseOptions = {}): FootnoteRef[] => {
  const refs: FootnoteRef[] = [];
  let seenContent = false;
  parseInlineFormatting(value, { internalNoteLinksAsFootnotes: true, ...options }).forEach(segment => {
    if (segment.format !== 'footnote' && segment.format !== 'attributionFootnote' && segment.format !== 'referenceMarker') {
      if (segment.text.trim().length > 0) seenContent = true;
      return;
    }
    // A leading roman reference marker (a list "i.") carries no href and isn't a
    // footnote — only inherit reference markers that link to a note.
    if (segment.format === 'referenceMarker' && !segment.href) { seenContent = true; return; }
    const marker = cleanNoteMarkerLabel(segment.marker || segment.text);
    if (!marker) return;
    const isReference = segment.format === 'referenceMarker';
    // A reference marker with no content before it labels the start of the line.
    const isLeading = isReference && !seenContent;
    seenContent = true;
    const exists = refs.some(ref => ref.marker === marker && (ref.href || '') === (segment.href || ''));
    if (!exists) refs.push({ marker, href: segment.href, isReference, isLeading, displayText: segment.text });
  });
  return refs;
};

const hasFootnoteRef = (value: string, ref: FootnoteRef, options: InlineParseOptions = {}): boolean =>
  footnoteRefsForText(value, options).some(candidate => candidate.marker === ref.marker);

const stripInheritedFootnoteMarkerText = (value: string, refs: FootnoteRef[]): string => {
  if (!value || refs.length === 0) return value;
  return refs.reduce((text, ref) => {
    const marker = cleanNoteMarkerLabel(ref.marker);
    if (!marker || !/^\d{1,3}$/u.test(marker)) return text;
    const source = `(?:\\[\\s*${escapeRegExp(marker)}\\s*\\]\\s*\\([^)]+\\)|\\[\\s*${escapeRegExp(marker)}\\s*\\]|${escapeRegExp(marker)})[.)]?`;
    return text
      .replace(new RegExp(`(?:\\s|\\u00a0)*${source}(?:\\s|\\u00a0)*$`, 'u'), '')
      .replace(new RegExp(`^(?:\\s|\\u00a0)*${source}(?=(?:\\s|\\u00a0|[,.，。;；:：!?！？]))`, 'u'), '')
      .trim();
  }, value);
};

const positionedFootnoteRefsForText = (value: string): PositionedFootnoteRef[] => {
  const sentences = splitIntoSentences(value);
  const sentenceTexts = sentences.length ? sentences : (value.trim() ? [value.trim()] : []);
  return sentenceTexts.flatMap((sentence, sentenceIndex) =>
    footnoteRefsForText(sentence).map(ref => ({ ...ref, sentenceIndex }))
  );
};

const leadingNoteRefForText = (value: string): LeadingNoteRef | null => {
  const clean = value.trimStart();
  const linked = clean.match(/^\[([0-9ivxlcdm]{1,8}[.)]?)\]\(([^)]+)\)(?:[.)])?(?:\s+|$)/iu);
  if (linked) {
    return {
      marker: cleanNoteMarkerLabel(linked[1]),
      href: linked[2],
      noteKey: noteKeyFromHref(linked[2]),
    };
  }
  const bare = clean.match(/^([0-9ivxlcdm]{1,8})[.)](?:\s+|$)/iu);
  if (!bare) return null;
  return { marker: cleanNoteMarkerLabel(bare[1]) };
};

const formatTime = (seconds: number): string => {
  if (!seconds || isNaN(seconds)) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const textFingerprint = (text: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length.toString(36)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const normalizeTranslationArray = (
  value: unknown,
  expectedCount: number,
  requireComplete: boolean
): string[] | null => {
  if (!Array.isArray(value)) return null;

  const translations = value.map(item => typeof item === 'string' ? item.trim() : '');
  if (requireComplete && translations.length < expectedCount) return null;
  while (translations.length < expectedCount) translations.push('');

  const sized = translations.slice(0, expectedCount);
  return sized.some(Boolean) ? sized : null;
};

const normalizeSentenceForCache = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sentenceSignatureFor = (sentenceMap: SentenceMap[]): string => {
  return textFingerprint(
    sentenceMap
      .map(mapping => `${mapping.globalIndex}:${normalizeSentenceForCache(mapping.text)}`)
      .join('\n')
  );
};

const parseCachedTranslationPayload = (
  value: unknown,
  allSentences: string[]
): string[] | null => {
  const expectedSources = allSentences.map(normalizeSentenceForCache);
  if (Array.isArray(value)) return null;
  if (!value || typeof value !== 'object') return null;

  const payload = value as { sourceSentences?: unknown; translations?: unknown };
  if (!Array.isArray(payload.sourceSentences)) return null;
  const cachedSources = payload.sourceSentences.map(item => typeof item === 'string' ? normalizeSentenceForCache(item) : '');
  if (
    cachedSources.length !== expectedSources.length ||
    cachedSources.some((source, index) => source !== expectedSources[index])
  ) {
    return null;
  }

  return normalizeTranslationArray(payload.translations, allSentences.length, true);
};

const leadingTopicHeadingFor = (chapter: Chapter, sourceText?: string, chapterText?: string): string => {
  const inferredFromExtractedText =
    sourceText && chapterText
      ? findTopicHeadingForExtractedText(sourceText, chapterText)
      : null;
  const inferredFromSource =
    sourceText && typeof chapter.sourceStart === 'number'
      ? findTopicHeadingAtOffset(sourceText, chapter.sourceStart) ||
        findTopicHeadingBeforeOffset(sourceText, chapter.sourceStart)
      : null;
  const candidates = [
    inferredFromExtractedText,
    inferredFromSource,
    chapter.sourceHeading,
    ...(chapter.sourceHeadingVariants || []),
    chapter.title,
  ].filter(Boolean) as string[];

  return candidates.find(candidate =>
    /^(?:#{1,6}\s*)?(?:(?:topic|day|lesson)\s+)?\d{1,3}[\).:\-–—|]\s+\S/iu.test(candidate.trim())
  ) || chapter.sourceHeading || chapter.title;
};

const processQueue = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  checkAbort?: () => boolean
): Promise<(R | null)[]> => {
  const results: (R | null)[] = new Array(items.length).fill(null);
  const queue = items.map((item, index) => ({ item, index }));
  const worker = async (workerIdx: number) => {
    // Stagger worker start to avoid simultaneous API bursts
    if (workerIdx > 0) await new Promise(resolve => setTimeout(resolve, workerIdx * 300));
    while (queue.length > 0) {
      if (checkAbort && checkAbort()) break;
      const task = queue.shift();
      if (!task) break;
      const { item, index } = task;
      try {
        const result = await fn(item, index);
        results[index] = result;
      } catch (e: any) {
        results[index] = null;
      }
    }
  };
  const workers = Array.from({ length: concurrency }).map((_, i) => worker(i));
  await Promise.all(workers);
  return results;
};

const buildPageSentenceData = (pageText: string): {
  paragraphData: ParagraphData[];
  flatSentenceMap: SentenceMap[];
} => {
  // Page markers ("[[PAGE n]]") are navigation metadata kept through cleanup/pagination
  // (they carry cross-page sentence continuations) but must never display. Drop them here,
  // at display-prep — after pagination is done — collapsing the surrounding spaces so an
  // inline marker ("…update on [[PAGE 54]] 01/04/00") closes up cleanly. (Notes and index
  // strip their own markers upstream; this covers the main reading body.)
  const cleanedPageText = pageText.replace(/[^\S\n]*\[\[PAGE\s+\d+\]\][^\S\n]*/gi, ' ');
  const rawParagraphs = cleanedPageText.split(/\n\s*\n/).filter(p => p.trim().length > 0)
    // A figure marker can arrive GLUED to its caption ("[[FIG p14n1]] To maximize comparability…").
    // Split it into two paragraphs — the marker (→ figure) and the caption (→ text) — so every
    // rawParagraph still maps to exactly ONE rendered paragraph, keeping sentence/translation/highlight
    // indexing aligned (pushing two paragraphs from one iteration would shift everything after it).
    .flatMap(p => {
      const m = p.trimStart().match(/^(\[\[FIG\s+[^\]]+\]\])\s*([\s\S]+)$/i);
      return m && m[2].trim() ? [m[1], m[2]] : [p];
    });

  const paragraphData: ParagraphData[] = [];
  const flatSentenceMap: SentenceMap[] = [];
  let globalIdx = 0;

  rawParagraphs.forEach((rawPText, pIndex) => {
    // Safety net: strip any figure marker still sitting INSIDE a text paragraph, so an internal marker
    // never surfaces to the reader as literal text. A LEADING marker glued to its caption is already
    // split into its own paragraph upstream (splitFigureMarkerParagraphs), preserving the 1
    // rawParagraph : 1 paragraph mapping the sentence/translation indexing relies on; this only catches
    // a stray mid-paragraph one. (Don't touch a paragraph that IS just the marker — handled next.)
    if (!/^\s*\[\[FIG\s+[^\]]+\]\]\s*$/i.test(rawPText) && /\[\[FIG\s+[^\]]+\]\]/i.test(rawPText)) {
      rawPText = rawPText.replace(/\[\[FIG\s+[^\]]+\]\]/gi, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!rawPText) return;
    }
    // An extracted figure marker "[[FIG id]]" — its own paragraph. No sentences (so it's invisible to
    // TTS/translation/highlighting); the renderer swaps it for the cached image.
    const figMatch = rawPText.trim().match(/^\[\[FIG\s+([^\]]+)\]\]$/i);
    if (figMatch) {
      paragraphData.push({ original: [], translated: [], figure: { id: figMatch[1].trim() } });
      return;
    }
    // A side-by-side two-column region, encoded by the extractor as U+E014 <left ¶s joined by U+E016>
    // U+E015 <right ¶s>. Split it into the two columns' paragraphs (stripping the role sentinels and
    // any page marker) and hand it to the renderer as a `columns` paragraph.
    if (rawPText.includes('\uE014')) {
      const [leftRaw, rightRaw = ''] = rawPText.replace(/\uE014/gu, '').split('\uE015');
      const toCol = (s: string): ColumnPara[] => s.split('\uE016')
        .map(p => p.replace(/[\uE010-\uE016]/gu, '').replace(/\[\[PAGE\s+\d+\]\]/gi, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .map(pText => ({ sentences: splitIntoSentences(pText).map(sent => { const gi = globalIdx++; flatSentenceMap.push({ pIndex, sIndex: gi, globalIndex: gi, text: stripInlineFormatSyntax(sent) }); return { text: sent, gi }; }) }));
      const left = toCol(leftRaw), right = toCol(rightRaw);
      paragraphData.push({ original: [], translated: [], columns: { left, right } });
      return;
    }
    // Block-role / alignment sentinels carried from extraction (private-use chars):
    // U+E010 centre, U+E011 right (display alignment); U+E012 list (block role). They may
    // sit just after a stripped page marker's whitespace, so allow leading space. Capture
    // them as para metadata, then strip every sentinel so none reaches text, TTS, or search.
    const ctrl = rawPText.match(/^\s*[\uE010-\uE013]+/);
    const ctrlChars = ctrl ? ctrl[0] : '';
    const align: 'right' | 'center' | undefined =
      ctrlChars.includes('\uE011') ? 'right' : ctrlChars.includes('\uE010') ? 'center' : undefined;
    const role: 'list' | 'heading' | undefined =
      ctrlChars.includes('\uE013') ? 'heading' : ctrlChars.includes('\uE012') ? 'list' : undefined;
    const alignStripped = rawPText.replace(/[\uE010-\uE013]/g, '');
    const indentMatch = alignStripped.match(/^ +/);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const pText = indent ? alignStripped.slice(indentMatch![0].length) : alignStripped;
    const lines = pText.split('\n').map(line => line.trim()).filter(Boolean);
    const sentences: string[] = [];

    lines.forEach((line, lineIndex) => {
      const lineSentences = splitIntoSentences(line);
      lineSentences.forEach((s, lineSentenceIndex) => {
        const sIndex = sentences.length;
        sentences.push(s);
        flatSentenceMap.push({
          pIndex,
          sIndex,
          globalIndex: globalIdx,
          text: stripInlineFormatSyntax(s),
          lineBreakAfter: lineIndex < lines.length - 1 && lineSentenceIndex === lineSentences.length - 1,
        });
        globalIdx++;
      });
    });

    if (lines.length === 0) {
      const fallbackSentences = splitIntoSentences(pText);
      fallbackSentences.forEach((s, sIndex) => {
        sentences.push(s);
        flatSentenceMap.push({ pIndex, sIndex, globalIndex: globalIdx, text: stripInlineFormatSyntax(s) });
        globalIdx++;
      });
    }

    paragraphData.push({ original: sentences, translated: [], indent, align, role });
  });

  return { paragraphData, flatSentenceMap };
};

const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve((r.result as string).split(',')[1] || '');
  r.onerror = reject;
  r.readAsDataURL(blob);
});

// Safety net: strip any internal translation placeholder ([[DBNAME_0]], [[DBSEG_0007]]) the model
// mangled and left behind, so a raw token never renders — covers already-cached bad translations too.
const stripLeakedTokens = (s: string): string => s.replace(/\[\[\s*DB(?:NAME|SEG)[^\]]*\]\]/gi, '').replace(/[ \t]{2,}/g, ' ').trim();

// Paint the translated labels over a copy of the figure: cover each label's box with its local
// background colour, then draw the translation fitted to the box. Rough but layout-preserving —
// good for diagram labels on solid backgrounds. Returns the composited JPEG.
const overlayTranslations = async (blob: Blob, labels: { box: [number, number, number, number]; translated: string }[]): Promise<Blob> => {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  // Gemini returns boxes on a 0..1000 scale (its native convention), or occasionally 0..1 fractions —
  // map either to image pixels. (Treating them as fractions drew every label off-canvas.)
  const maxV = Math.max(1, ...labels.flatMap(l => l.box.map(v => Math.abs(v || 0))));
  const div = maxV <= 1.5 ? 1 : 1000; // 0..1 fractions vs Gemini's native 0..1000
  for (const l of labels) {
    // Gemini native detection: box = [ymin, xmin, ymax, xmax] (top, left, bottom, right).
    const ymin = (l.box[0] || 0) / div, xmin = (l.box[1] || 0) / div, ymax = (l.box[2] || 0) / div, xmax = (l.box[3] || 0) / div;
    let px = xmin * bmp.width, py = ymin * bmp.height;
    let pw = Math.max(2, (xmax - xmin) * bmp.width), ph = Math.max(2, (ymax - ymin) * bmp.height);
    px = Math.max(0, Math.min(bmp.width - 2, px)); py = Math.max(0, Math.min(bmp.height - 2, py));
    pw = Math.min(bmp.width - px, pw); ph = Math.min(bmp.height - py, ph);
    // Robust background: MEDIAN colour of a ring of points just OUTSIDE the box, so one stray sample
    // landing on a line/glyph doesn't give a wrong patch colour (that was the "wrong background" bug).
    const ring: [number, number][] = [[px + pw / 2, py - 4], [px + pw / 2, py + ph + 4], [px - 4, py + ph / 2], [px + pw + 4, py + ph / 2], [px - 4, py - 4], [px + pw + 4, py + ph + 4]];
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    for (const [rx, ry] of ring) { const cx = Math.max(0, Math.min(bmp.width - 1, Math.round(rx))), cy = Math.max(0, Math.min(bmp.height - 1, Math.round(ry))); const d = ctx.getImageData(cx, cy, 1, 1).data; rs.push(d[0]); gs.push(d[1]); bs.push(d[2]); }
    const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
    const br = med(rs), bgc = med(gs), bb = med(bs);
    const lum = 0.299 * br + 0.587 * bgc + 0.114 * bb;
    const pad = Math.max(2, ph * 0.18);
    ctx.fillStyle = `rgb(${br},${bgc},${bb})`;
    ctx.fillRect(px - pad, py - pad, pw + 2 * pad, ph + 2 * pad);
    // Fit the translation to the box (width AND height), vertically centred, contrasting colour.
    ctx.fillStyle = lum > 145 ? '#111111' : '#f2f2f2';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    let fs = Math.min(ph * 0.74, 40); ctx.font = `600 ${fs}px sans-serif`;
    while (fs > 7 && ctx.measureText(l.translated).width > pw) { fs -= 0.5; ctx.font = `600 ${fs}px sans-serif`; }
    ctx.fillText(l.translated, px + 1, py + ph / 2);
  }
  return await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
};

// Trim uniform background margins the image model sometimes bakes around a redrawn figure, so it fills
// the frame and matches the original's size. Corner colour = background; crop the empty border rows/cols.
const trimBorders = async (blob: Blob): Promise<Blob> => {
  try {
    const bmp = await createImageBitmap(blob);
    const w = bmp.width, h = bmp.height;
    const c = new OffscreenCanvas(w, h); const ctx = c.getContext('2d'); if (!ctx) return blob;
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const bg = [data[0], data[1], data[2]];
    const isBg = (x: number, y: number) => { const i = (y * w + x) * 4; return Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) < 36; };
    const rowBg = (y: number) => { for (let x = 0; x < w; x++) if (!isBg(x, y)) return false; return true; };
    const colBg = (x: number) => { for (let y = 0; y < h; y++) if (!isBg(x, y)) return false; return true; };
    let top = 0, bottom = h - 1, left = 0, right = w - 1;
    while (top < bottom && rowBg(top)) top++;
    while (bottom > top && rowBg(bottom)) bottom--;
    while (left < right && colBg(left)) left++;
    while (right > left && colBg(right)) right--;
    const cw = right - left + 1, ch = bottom - top + 1;
    if (cw >= w - 2 && ch >= h - 2) return blob;      // no border to trim
    if (cw < w * 0.4 || ch < h * 0.4) return blob;    // suspicious over-crop — keep original
    const oc = new OffscreenCanvas(cw, ch); const octx = oc.getContext('2d'); if (!octx) return blob;
    octx.drawImage(bmp, left, top, cw, ch, 0, 0, cw, ch);
    return await oc.convertToBlob({ type: 'image/png', quality: 0.95 });
  } catch { return blob; }
};

// An extracted PDF figure rendered inline. Loads the cached blob ('figure-image'), reserves its
// aspect-ratio box so text doesn't jump on load, and offers Copy / Add to mem_log / Translate figure
// via a right-click / double-click / long-press menu. In split view it renders in both halves; the
// right half shows the translated figure (on demand). Carries no text — invisible to TTS/translation.
const PdfFigureBlock: React.FC<{ figId: string; bookId: string; meta?: PdfFigure; split: boolean; targetLang: string }> = ({ figId, bookId, meta, split, targetLang }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [tr, setTr] = useState<{ state: 'idle' | 'rendering' | 'done' | 'fail'; url?: string }>({ state: 'idle' });
  const blobRef = useRef<Blob | null>(null);
  const pressTimer = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true; let obj: string | null = null;
    (async () => {
      try {
        const rec = await getFile(buildCacheKey(bookId, 0, 'figure-image', figId));
        if (!alive) return;
        if (rec?.blob) { blobRef.current = rec.blob; obj = URL.createObjectURL(rec.blob); setUrl(obj); setState('ready'); }
        else setState('missing');
      } catch { if (alive) setState('missing'); }
    })();
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [figId, bookId]);
  useEffect(() => () => { if (tr.url) URL.revokeObjectURL(tr.url); }, [tr.url]);
  // Restore a previously-generated translation (redraw preferred, else overlay) on mount, so it
  // persists across page changes instead of reverting to the original until you click again.
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const seg of ['rdv4', 'trv3']) {
        try {
          const rec = await getFile(buildCacheKey(bookId, 0, 'figure-image', figId, seg, targetLang));
          if (rec?.blob) { if (!alive) return; setTr({ state: 'done', url: URL.createObjectURL(rec.blob) }); return; }
        } catch { /* ignore */ }
      }
    })();
    return () => { alive = false; };
  }, [figId, bookId, targetLang]);

  const aspect = meta && meta.wPx && meta.hPx ? meta.wPx / meta.hPx : 4 / 3;
  // Size the figure by its real fraction of the page's text column (from extraction), so it reads
  // proportionally to the surrounding text. Falls back to a nominal column width for older manifests.
  const widthPct = meta?.colFrac ? Math.max(40, Math.min(100, Math.round(meta.colFrac * 100)))
    : meta?.wPts ? Math.max(40, Math.min(100, Math.round((meta.wPts / 380) * 100)))
    : 100;
  const openMenu = (x: number, y: number) => setMenu({ x, y });
  const copyImage = async () => { setMenu(null); const b = blobRef.current; if (!b) return; try { await navigator.clipboard.write([new ClipboardItem({ [b.type]: b })]); } catch { /* clipboard image unsupported */ } };
  const saveToLog = async () => { setMenu(null); const b = blobRef.current; if (!b) return; try { await saveFile(buildCacheKey(bookId, 0, 'notebook-figure', figId), b, { filename: `${figId}.jpg`, mimeType: b.type, timestamp: Date.now(), bookId, chapterId: 0, componentSource: 'Reader_Figure', fileType: 'notebook-figure' }); } catch { /* ignore */ } };
  // Clicking a translate action again while it's rendering cancels the in-flight model call (aborts
  // the request so no further tokens are spent) and reverts to the original.
  const stopRender = () => { setMenu(null); abortRef.current?.abort(); abortRef.current = null; setTr({ state: 'idle' }); };
  const translateFigure = async () => {
    setMenu(null);
    const b = blobRef.current;
    if (!b || tr.state === 'rendering') return;
    const ctrl = new AbortController(); abortRef.current = ctrl;
    setTr({ state: 'rendering' });
    try {
      const key = buildCacheKey(bookId, 0, 'figure-image', figId, 'trv3', targetLang);
      const cached = await getFile(key);
      let out = cached?.blob || null;
      if (!out) {
        const b64 = await blobToBase64(b);
        const labels = await translateFigureText(b64, b.type, targetLang, ctrl.signal);
        if (ctrl.signal.aborted) return;
        out = labels.length ? await overlayTranslations(b, labels) : b;
        if (labels.length) await saveFile(key, out, { filename: `${figId}-${targetLang}.jpg`, mimeType: out.type, timestamp: Date.now(), bookId, chapterId: 0, componentSource: 'Reader_Figure', fileType: 'figure-image' }).catch(() => {});
      }
      if (ctrl.signal.aborted) return;
      setTr({ state: 'done', url: URL.createObjectURL(out) });
    } catch { if (ctrl.signal.aborted) return; setTr({ state: 'fail' }); }
  };
  const redrawFigure = async () => {
    setMenu(null);
    const b = blobRef.current;
    if (!b || tr.state === 'rendering') return;
    const ctrl = new AbortController(); abortRef.current = ctrl;
    setTr({ state: 'rendering' });
    try {
      const key = buildCacheKey(bookId, 0, 'figure-image', figId, 'rdv4', targetLang);
      const cached = await getFile(key);
      let out = cached?.blob || null;
      if (!out) {
        // Measure the original figure's exact pixels so the model is constrained to the same shape.
        let ow = meta?.wPx, oh = meta?.hPx;
        try { const bmp = await createImageBitmap(b); ow = bmp.width; oh = bmp.height; } catch { /* fall back to manifest */ }
        const dataUrl = await redrawFigureTranslated(await blobToBase64(b), b.type, targetLang, ctrl.signal, ow, oh);
        if (ctrl.signal.aborted) return;
        if (!dataUrl) { setTr({ state: 'fail' }); return; }
        out = await trimBorders(await (await fetch(dataUrl)).blob()); // trim any margin the model baked in
        await saveFile(key, out, { filename: `${figId}-${targetLang}-redraw.png`, mimeType: out.type, timestamp: Date.now(), bookId, chapterId: 0, componentSource: 'Reader_Figure', fileType: 'figure-image' }).catch(() => {});
      }
      if (ctrl.signal.aborted) return;
      setTr({ state: 'done', url: URL.createObjectURL(out) });
    } catch { if (ctrl.signal.aborted) return; setTr({ state: 'fail' }); }
  };

  // `natural`: size the box to the image's OWN aspect (used for a translated/redrawn image, whose
  // dimensions differ from the original) instead of forcing the original's aspect-ratio box, which
  // would letterbox it and make it look smaller.
  const imageBox = (src: string | null, loading: boolean, note: string, natural = false) => (
    <div
      className="relative w-full overflow-hidden rounded-sm border border-zinc-800/60 bg-[#0a0a0c] select-none"
      style={natural && src ? undefined : { aspectRatio: String(aspect) }}
      onContextMenu={e => { e.preventDefault(); openMenu(e.clientX, e.clientY); }}
      onDoubleClick={e => openMenu(e.clientX, e.clientY)}
      onTouchStart={e => { const t = e.touches[0]; pressTimer.current = window.setTimeout(() => openMenu(t.clientX, t.clientY), 500); }}
      onTouchEnd={() => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } }}
    >
      {src
        ? <img src={src} alt={`Figure ${figId}`} draggable={false} className={`w-full ${natural ? 'h-auto block' : 'h-full'} object-contain`} />
        : <div className={`w-full h-full flex items-center justify-center text-[11px] text-zinc-600 font-mono ${loading ? 'animate-pulse' : ''}`}>{note}</div>}
    </div>
  );

  const box = imageBox(state === 'ready' ? url : null, state === 'loading', state === 'loading' ? 'loading figure…' : 'figure unavailable');
  const trPane = tr.state === 'rendering' ? imageBox(null, true, 'rendering…')
    : tr.state === 'done' && tr.url ? imageBox(tr.url, false, '', true)
    : box;

  return (
    <div className="w-full my-4">
      {split
        // Split view: each half mirrors the text pane's padding (pr-6 / pl-6) and sizes the figure at
        // its book proportion, centred — so it matches the text measure instead of filling the half.
        ? <div className="w-full flex items-start">
            <div className="w-1/2 min-w-0 pr-2 md:pr-6 flex justify-center"><div style={{ width: `${widthPct}%`, maxWidth: '100%' }}>{box}</div></div>
            <div className="w-1/2 min-w-0 pl-2 md:pl-6 flex justify-center"><div style={{ width: `${widthPct}%`, maxWidth: '100%' }}>{trPane}</div></div>
          </div>
        // Single view: match the text's centering — justify-center around a max-w-3xl column, figure
        // centred within at its book proportion.
        : <div className="w-full flex justify-center"><div className="w-full max-w-3xl flex justify-center"><div style={{ width: `${widthPct}%`, maxWidth: '100%' }}>{box}</div></div></div>}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null); }} />
          <div className="fixed z-50 min-w-[160px] rounded-sm border border-zinc-700 bg-[#0f0f12] shadow-2xl py-1 text-xs text-zinc-200 font-mono" style={{ left: Math.min(menu.x, window.innerWidth - 170), top: Math.min(menu.y, window.innerHeight - 110) }}>
            <button className="w-full text-left px-3 py-1.5 hover:bg-zinc-800" onClick={copyImage}>Copy image</button>
            <button className="w-full text-left px-3 py-1.5 hover:bg-zinc-800" onClick={saveToLog}>Add to mem_log</button>
            {split && tr.state === 'rendering'
              ? <button className="w-full text-left px-3 py-1.5 hover:bg-zinc-800 text-amber-400" onClick={stopRender}>Stop rendering</button>
              : split && <>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-zinc-800" onClick={redrawFigure}>Translate figure (redraw)</button>
                  <button className="w-full text-left px-3 py-1.5 hover:bg-zinc-800 text-zinc-400" onClick={translateFigure}>Overlay only (rough)</button>
                </>}
          </div>
        </>
      )}
    </div>
  );
};

export const AudioBook: React.FC<Props> = ({ chapter, allChapters, fileContext, settings, onSettingsUpdate, bookId, initialPageTarget = 'first', onChapterChange }) => {
  const [pages, setPages] = useState<ReaderPage[]>([]);
  // The current chapter's cleaned source text, kept so we can RE-paginate on a text-size / viewport
  // change without re-fetching, preserving the reading position.
  const cleanTextRef = useRef<string>('');
  const [paragraphData, setParagraphData] = useState<ParagraphData[]>([]);
  const [flatSentenceMap, setFlatSentenceMap] = useState<SentenceMap[]>([]);
  const [translationState, setTranslationState] = useState<{ identity: string; byIndex: Record<number, string> }>({ identity: '', byIndex: {} });
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [isLoadingText, setIsLoadingText] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [viewMode, setViewMode] = useState<'single' | 'split'>(initialViewMode);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [timings, setTimings] = useState<ChunkTiming[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasInitiated, setHasInitiated] = useState(false);
  const [generationProgress, setGenerationProgress] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedVoice, setSelectedVoice] = useState(lastAudioVoice || 'Puck');
  const [audioLanguage, setAudioLanguage] = useState(initialAudioLanguage);
  const [autoScroll, setAutoScroll] = useState(initialAutoScroll);
  const [activeSentenceIndex, setActiveSentenceIndex] = useState<number>(-1);
  const [navigationSentenceIndex, setNavigationSentenceIndex] = useState<number>(-1);
  const [pendingNavigationTarget, setPendingNavigationTarget] = useState<ReaderPageTarget | null>(null);
  const [isModuleMinimized, setIsModuleMinimized] = useState(initialVoiceSynthMinimized);
  const [inkedSelections, setInkedSelections] = useState<InkedSelection[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const readerScrollRef = useRef<HTMLDivElement | null>(null);
  const abortGenerationRef = useRef<boolean>(false);
  const latestTranslationRequestRef = useRef<string>('');
  const animationRef = useRef<number | null>(null);
  const sentencePointerRef = useRef<{ x: number; y: number; time: number } | null>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const particlesRef = useRef<QuantumParticle[]>([]);

  const resetAudioState = () => {
    if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current.playbackRate = 1.0;
    }
    
    if (audioSrc) URL.revokeObjectURL(audioSrc);
    setAudioSrc(null);
    setTimings([]);
    setIsPlaying(false);
    setPlaybackProgress(0);
    setCurrentTime(0);
    setDuration(0);
    setPlaybackRate(1.0);
    setActiveSentenceIndex(-1);
    setGenerationProgress("");
    setHasInitiated(false);
  };

  const changePage = (next: boolean) => {
    const curIdx = allChapters.findIndex(c => c.id === chapter.id);
    if (next && currentPage < pages.length - 1) {
      setNavigationSentenceIndex(-1);
      setPendingNavigationTarget(null);
      setCurrentPage(prev => prev + 1);
    } else if (next && currentPage === pages.length - 1 && onChapterChange) {
      if (curIdx >= 0 && curIdx < allChapters.length - 1) {
        onChapterChange(allChapters[curIdx + 1].id, 'first');
      }
    } else if (!next && currentPage > 0) {
      setNavigationSentenceIndex(-1);
      setPendingNavigationTarget(null);
      setCurrentPage(prev => prev - 1);
    } else if (!next && currentPage === 0 && onChapterChange && curIdx > 0) {
      onChapterChange(allChapters[curIdx - 1].id, 'last');
    }
  };

  const pageIndexForNoteTarget = (
    target: Extract<ReaderPageTarget, { type: 'note' }>,
    readerPages: ReaderPage[]
  ): number => {
    // A note's anchor key uniquely identifies it even across chapters whose note
    // numbers restart at 1. Resolve by key first — this mirrors the active-note
    // highlight and avoids landing on a same-numbered note in the wrong chapter.
    if (target.noteKey) {
      const keyedPageIndex = readerPages.findIndex(page =>
        page.text
          .split(/\n+/)
          .some(line => sentenceStartsWithNoteMarker(line, target.marker, target.noteKey))
      );
      if (keyedPageIndex >= 0) return keyedPageIndex;
    }
    const combinedParts: string[] = [];
    const pageStarts: number[] = [];
    readerPages.forEach(page => {
      pageStarts.push(combinedParts.join('\n\n').length);
      combinedParts.push(page.text);
    });
    // Neutralise block-role/alignment sentinels (U+E010–E013) to spaces — SAME LENGTH so the
    // pageStarts offsets above stay valid. The notes' per-chapter "CHAPTER N: …" headers carry the
    // U+E013 heading sentinel, which the section-scope regex's `\s*[*_~]*` prefix does not allow, so
    // without this the resolver finds ZERO chapter sections and every key-less footnote (a
    // geometry-only marker with no anchor) fails to scope → SOURCE_REQUIRED.
    const combinedText = combinedParts.join('\n\n').replace(/[\uE010-\uE013]/g, ' ');
    const pageIndexAtOffset = (offset: number): number => {
      let index = 0;
      for (let i = 0; i < pageStarts.length; i++) {
        if (pageStarts[i] <= offset) index = i;
        else break;
      }
      return index;
    };
    const scopeNeedles = [
      target.sourceChapterHeading,
      target.sourceChapterTitle,
    ]
      .map(normalizeNoteScopeText)
      .filter(needle => needle.length >= 4);
    const sectionMatches = [...combinedText.matchAll(/(^|\n{2,})\s*[*_~]*(?:#{1,6}\s*)?((?:chapter\s+\d+|afterword|epilogue|prologue|introduction)\b[^\n*]{0,220})[*_~]*/giu)]
      .map(match => ({
        start: (match.index ?? 0) + match[1].length,
        title: match[2],
      }));
    const titleScopedSectionIndex = scopeNeedles.length > 0
      ? sectionMatches.findIndex(section => {
          const normalized = normalizeNoteScopeText(section.title);
          // Guard against empty/near-empty section titles (e.g. an italicized
          // heading truncated to "Chapter 9. "), which would otherwise match every
          // needle via needle.includes("") and pick the wrong section.
          return normalized.length >= 4 &&
            scopeNeedles.some(needle => normalized.includes(needle) || needle.includes(normalized));
        })
      : -1;
    const numberedChapterIndex = typeof target.sourceChapterIndex === 'number'
      ? allChapters
          .slice(0, target.sourceChapterIndex + 1)
          .filter(candidate =>
            !isNotesChapterTitle(candidate.title) &&
            !isNotesChapterTitle(candidate.sourceHeading || '') &&
            !isIndexChapterTitle(candidate.title) &&
            !isIndexChapterTitle(candidate.sourceHeading || '')
          ).length
      : -1;
    const targetChapterNumber = target.sourceChapterNumber || numberedChapterIndex;
    const orderScopedSectionIndex = titleScopedSectionIndex === -1 && numberedChapterIndex >= 0
      ? sectionMatches.findIndex(section => {
          const match = section.title.match(/^chapter\s+(\d+)/iu);
          if (!match) return false;
          return Number(match[1]) === targetChapterNumber;
        })
      : -1;
    const namedScopedSectionIndex = titleScopedSectionIndex === -1 && orderScopedSectionIndex === -1 && scopeNeedles.length > 0
      ? sectionMatches.findIndex(section => {
          const normalized = normalizeNoteScopeText(section.title);
          return /^(afterword|epilogue|prologue|introduction)\b/iu.test(section.title) &&
            scopeNeedles.some(needle => normalized.includes(needle) || needle.includes(normalized));
        })
      : -1;
    const scopedSectionIndex = titleScopedSectionIndex >= 0
      ? titleScopedSectionIndex
      : orderScopedSectionIndex >= 0
        ? orderScopedSectionIndex
        : namedScopedSectionIndex;
    if (scopedSectionIndex >= 0) {
      const sectionStart = sectionMatches[scopedSectionIndex].start;
      const sectionEnd = sectionMatches[scopedSectionIndex + 1]?.start ?? combinedText.length;
      const sectionText = combinedText.slice(sectionStart, sectionEnd);

      if (target.noteKey) {
        const localLines = sectionText.split(/\n+/);
        let cursor = sectionStart;
        for (const line of localLines) {
          if (sentenceStartsWithNoteMarker(line, target.marker, target.noteKey)) return pageIndexAtOffset(cursor);
          cursor += line.length + 1;
        }
      }

      const sectionPattern = noteStartPatternFor(target.marker);
      const sectionMatch = sectionText.match(sectionPattern);
      if (sectionMatch && typeof sectionMatch.index === 'number') {
        return pageIndexAtOffset(sectionStart + sectionMatch.index);
      }
    }

    if (target.noteKey) {
      const exactIndex = readerPages.findIndex(page =>
        page.text
          .split(/\n+/)
          .some(line => sentenceStartsWithNoteMarker(line, target.marker, target.noteKey))
      );
      if (exactIndex >= 0) return exactIndex;
      return -1;
    }

    const notePattern = noteStartPatternFor(target.marker);
    const matchingPageIndexes = readerPages
      .map((page, index) => notePattern.test(page.text) ? index : -1)
      .filter(index => index >= 0);
    const uniqueMatches = [...new Set(matchingPageIndexes)];
    return uniqueMatches.length === 1 ? uniqueMatches[0] : -1;
  };

  // Resolve a SOURCE page (1-based PDF page) to the reader page that displays it. The reader pages
  // drop the "[[PAGE n]]" markers, so match by content: take the readable words right after the
  // "[[PAGE n]]" marker in the full source and find the reader page whose text contains them.
  // Returns -1 when the page can't be located (caller falls back to the chapter start).
  const wordsOnly = (s: string): string =>
    s.replace(/[-]/gu, ' ').replace(/\[\[[^\]]*\]\]/gu, ' ').replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
  const pageIndexForSourcePage = (srcPage: number, readerPages: ReaderPage[]): number => {
    const content = fileContext.content || '';
    const token = `[[PAGE ${srcPage}]]`;
    const at = content.indexOf(token);
    if (at < 0) return -1;
    const anchor = wordsOnly(content.slice(at + token.length, at + token.length + 400)).split(' ').slice(0, 6).join(' ');
    if (anchor.length < 8) return -1;
    return readerPages.findIndex(p => wordsOnly(p.text).includes(anchor));
  };

  const pageIndexForTarget = (target: ReaderPageTarget, readerPages: ReaderPage[]): number => {
    if (target === 'last') return Math.max(0, readerPages.length - 1);
    if (target === 'first') return 0;
    if (target.type === 'page') {
      return Math.min(Math.max(0, target.pageIndex), Math.max(0, readerPages.length - 1));
    }
    if (target.type === 'source-page') {
      const idx = pageIndexForSourcePage(target.page, readerPages);
      return idx >= 0 ? idx : 0;
    }
    const foundIndex = pageIndexForNoteTarget(target, readerPages);
    return foundIndex >= 0 ? foundIndex : 0;
  };

  useEffect(() => {
    return () => { if (audioSrc) URL.revokeObjectURL(audioSrc); };
  }, [audioSrc]);

  // Paginate the current chapter's cleaned text with the reader's live page size (viewport + text/
  // line settings). Shared by the initial load and re-pagination so both stay identical.
  const paginateChapterText = (cleanText: string): ReaderPage[] => {
    const isNotes = isNotesChapterTitle(chapter.title) || isNotesChapterTitle(chapter.sourceHeading || '');
    const isIndex = isIndexChapterTitle(chapter.title) || isIndexChapterTitle(chapter.sourceHeading || '');
    return paginateReaderText(cleanText, computePageTargetSize(settings.textSize, settings.lineHeight), {
      topicsPerPage: 10,
      leadingHeading: leadingTopicHeadingFor(chapter, fileContext.content, cleanText),
      measureVisibleLength: isIndex, // index is link-dense; size by visible text so pages fill
      preferLineBreaks: isNotes || isIndex, // notes/index are item-per-line lists
    });
  };

  // Re-paginate the current chapter when the page size changes (text-size / line-height / viewport),
  // preserving the reading position: anchor on the first words of the current page, then land on the
  // new page that contains them. Kept in a ref so the resize listener always calls the latest closure
  // without re-subscribing every render.
  const repaginateRef = useRef<() => void>(() => {});
  repaginateRef.current = () => {
    const cleanText = cleanTextRef.current;
    if (!cleanText || pages.length === 0) return;
    const anchor = wordsOnly(pages[currentPage]?.text || '').split(' ').slice(0, 8).join(' ');
    const newPages = paginateChapterText(cleanText);
    if (newPages.length === 0) return;
    let newIdx = 0;
    if (anchor.length >= 8) {
      const found = newPages.findIndex(p => wordsOnly(p.text).includes(anchor));
      if (found >= 0) newIdx = found;
    }
    setPages(newPages);
    setPendingNavigationTarget(null);
    setNavigationSentenceIndex(-1);
    setCurrentPage(Math.min(newIdx, newPages.length - 1));
  };

  // Text-size / line-height change → re-paginate (skip first mount; loadContent handles that).
  useEffect(() => {
    if (cleanTextRef.current) repaginateRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.textSize, settings.lineHeight]);

  // Viewport resize (debounced) → re-paginate, so the reader's page count tracks the screen and stays
  // in step with the search index (which paginates with the same live page size). Only react to a
  // SIGNIFICANT height change (orientation, desktop resize) — mobile address-bar show/hide nudges the
  // height by tens of pixels while scrolling, which shouldn't re-flow the page.
  const lastViewportHeightRef = useRef<number>(typeof window !== 'undefined' ? window.innerHeight : 0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (Math.abs(window.innerHeight - lastViewportHeightRef.current) < 120) return;
        lastViewportHeightRef.current = window.innerHeight;
        repaginateRef.current();
      }, 250);
    };
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(timer); window.removeEventListener('resize', onResize); };
  }, []);

  const loadContent = async () => {
    setIsLoadingText(true);
    setSourceError(null);
    setPages([]);
    setCurrentPage(0);
    setNavigationSentenceIndex(-1);
    setPendingNavigationTarget(null);
    resetAudioState();
    try {
      const sourceFingerprint = fileContext.sourceHash || `legacy-${fileContext.content.length}`;
      const chapterScopeFingerprint = textFingerprint([
        chapter.title,
        chapter.sourceHeading || '',
        chapter.sourceStart ?? '',
        chapter.sourceEnd ?? '',
      ].join('|'));
      const textCacheKey = buildCacheKey(
        bookId,
        chapter.id,
        'chapter-text',
        CHAPTER_TEXT_CACHE_VERSION,
        // Tie the cached chapter text to the EXTRACTION version of the source it was derived from.
        // Without this, bumping PDF_TEXT_EXTRACTION_VERSION (a better extractor) never invalidates
        // the per-chapter cache — the reader keeps serving text extracted under an old version, so
        // extraction fixes silently never reach the render. Re-extracting the source to a new
        // version changes sourceExtractorVersion, which now changes this key and regenerates.
        (fileContext as any).sourceExtractorVersion || 'noext',
        sourceFingerprint,
        chapterScopeFingerprint
      );
      let cleanText = '';

      // Try loading cached chapter text first
      const cached = await getFile(textCacheKey).catch(() => null);
      if (cached) {
        cleanText = await cached.blob.text();
      } else {
        if (!fileContext.content) {
          throw new Error('Original source content is missing. Re-upload this book to extract full chapter text.');
        }
        const rawText = await extractChapterText(fileContext, chapter, allChapters);
        // An index is a structured list, not prose: rearrangeAndCleanText would
        // reflow its one-entry-per-line layout into joined paragraphs and strip the
        // sub-entry indentation. Use a light cleanup that preserves both.
        const isIndexChapterSource =
          isIndexChapterTitle(chapter.title) || isIndexChapterTitle(chapter.sourceHeading || '');
        // A PDF source (its extraction carries "[[PAGE n]]" markers) encodes index
        // sub-entry depth as leading non-breaking spaces and emits one entry per line, so
        // it needs its own entry-per-paragraph formatting; EPUB indexes keep the existing
        // light cleanup untouched.
        const isPdfSource = fileContext.content.includes('[[PAGE ');
        cleanText = isIndexChapterSource
          ? isPdfSource
            ? formatPdfIndexEntries(rawText)
            : normalizeInternalLinkMarkup(normalizeInternalLinkMarkup(rawText).replace(/\n{3,}/g, '\n\n').trim())
          : normalizeInternalLinkMarkup(rearrangeAndCleanText(normalizeInternalLinkMarkup(rawText)));
        // Cache the extracted text for future visits
        const textBlob = new Blob([cleanText], { type: 'text/plain' });
        saveFile(textCacheKey, textBlob, {
          filename: `text-ch${chapter.id}-${titleCase(chapter.title)}.txt`,
          mimeType: 'text/plain',
          timestamp: Date.now(),
          bookId,
          chapterId: chapter.id,
          componentSource: 'audiobook',
          fileType: 'chapter-text',
        }).catch(e => console.warn('Text cache save failed:', e));
      }

      if (isNotesChapterTitle(chapter.title) || isNotesChapterTitle(chapter.sourceHeading || '')) {
        cleanText = normalizeNotesReaderText(cleanText);
      }


      cleanTextRef.current = cleanText;
      const paginatedPages = paginateChapterText(cleanText);
      setPages(paginatedPages);
      if (typeof initialPageTarget === 'object' && initialPageTarget.type === 'note') {
        const notePageIndex = pageIndexForNoteTarget(initialPageTarget, paginatedPages);
        if (notePageIndex < 0) {
          setSourceError(`Could not locate note ${initialPageTarget.marker} in the chapter-specific notes section.`);
          setCurrentPage(0);
        } else {
          setCurrentPage(notePageIndex);
        }
      } else {
        setCurrentPage(pageIndexForTarget(initialPageTarget, paginatedPages));
      }
      setPendingNavigationTarget(initialPageTarget);
    } catch (err: any) {
      console.error(err);
      setSourceError(err?.message || 'Failed to extract chapter text from the original source.');
    } finally {
      setIsLoadingText(false);
    }
  };

  useEffect(() => { loadContent(); }, [chapter, fileContext, initialPageTarget]);


  const sourceFingerprint = fileContext.sourceHash || `legacy-${fileContext.content.length}`;
  const currentPageText = pages[currentPage]?.text || '';
  const translationIdentityFor = (
    pageIndex: number,
    pageText: string,
    sentenceMap: SentenceMap[],
    targetLanguage: string
  ): string => [
    bookId,
    chapter.id,
    sourceFingerprint,
    targetLanguage,
    `page${pageIndex}`,
    textFingerprint(pageText),
    sentenceSignatureFor(sentenceMap),
  ].join(':');
  const inkStorageKey = `decodebook_inked:${bookId}:${chapter.id}`;
  const audioCacheKeyFor = (pageIndex: number, pageText: string, voice: string, language: string): string => {
    return buildCacheKey(
      bookId,
      chapter.id,
      'audio',
      AUDIO_CACHE_VERSION,
      sourceFingerprint,
      `page${pageIndex}`,
      textFingerprint(pageText),
      voice,
      language
    );
  };
  const cleanInkSelectionText = (value: string): string => stripFootnoteMarkers(value).replace(/\s+/g, ' ').trim();
  const normalizeInkText = (value: string): string => cleanInkSelectionText(value).toLowerCase();

  const persistInkedSelections = (nextSelections: InkedSelection[]) => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(inkStorageKey, JSON.stringify(nextSelections));
    } catch {
      // Inking is visual state; notebook sync still records the saved item.
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = JSON.parse(window.localStorage.getItem(inkStorageKey) || '[]');
      const normalized = Array.isArray(stored)
        ? stored
            .map((entry): InkedSelection | null => {
              if (typeof entry === 'string') return null;
              if (!entry || typeof entry.text !== 'string' || typeof entry.sentenceIndex !== 'number') return null;
              return {
                text: entry.text,
                sentenceIndex: entry.sentenceIndex,
                startOffset: typeof entry.startOffset === 'number' ? entry.startOffset : undefined,
                source: entry.source
              };
            })
            .filter(Boolean) as InkedSelection[]
        : [];
      setInkedSelections(normalized);
    } catch {
      setInkedSelections([]);
    }
  }, [inkStorageKey]);

  useEffect(() => {
    const handleInkSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; source?: string; sentenceIndex?: number; startOffset?: number; inked?: boolean }>).detail;
      const text = cleanInkSelectionText(detail?.text || '');
      if (!text) return;

      const resolveSentenceIndex = (): number | undefined => {
        if (typeof detail?.sentenceIndex === 'number' && detail.sentenceIndex >= 0) return detail.sentenceIndex;

        const selected = normalizeInkText(text);
        const source = detail?.source || '';
        const candidates = flatSentenceMap
          .map(mapping => {
            const candidateText = /translated/i.test(source)
              ? translationState.byIndex[mapping.globalIndex] || ''
              : mapping.text;
            return {
              globalIndex: mapping.globalIndex,
              normalized: normalizeInkText(candidateText),
            };
          })
          .filter(candidate => candidate.normalized && candidate.normalized.includes(selected));

        const exact = candidates.filter(candidate => candidate.normalized === selected);
        if (exact.length > 0) return exact[0].globalIndex;
        return candidates.length === 1 ? candidates[0].globalIndex : undefined;
      };

      const resolvedSentenceIndex = resolveSentenceIndex();
      if (typeof resolvedSentenceIndex !== 'number') return;

      setInkedSelections(prev => {
        const matchesSelection = (item: InkedSelection) =>
          item.sentenceIndex === resolvedSentenceIndex &&
          normalizeInkText(item.text) === normalizeInkText(text) &&
          (typeof detail.startOffset !== 'number' || item.startOffset === detail.startOffset);
        const exists = prev.some(matchesSelection);
        const shouldInk = detail.inked !== undefined ? detail.inked : !exists;
        const next = shouldInk
          ? (exists ? prev : [...prev, { text, sentenceIndex: resolvedSentenceIndex, startOffset: detail.startOffset, source: detail.source }])
          : prev.filter(item => !matchesSelection(item));
        persistInkedSelections(next);
        return next;
      });
    };

    window.addEventListener('decodebook:ink-selection', handleInkSelection);
    return () => window.removeEventListener('decodebook:ink-selection', handleInkSelection);
  }, [inkStorageKey, flatSentenceMap, translationState.byIndex]);

  // Rebuild sentence data and reset audio/translation only when the page itself
  // changes — NOT when pendingNavigationTarget changes. Clicking a sentence clears
  // that target, and including it here used to re-fire this effect and wipe the
  // page's audio (play button dead, waveform gone) after any footnote/page jump.
  useEffect(() => {
     if (!pages[currentPage]) return;
     const { paragraphData: newParagraphData, flatSentenceMap: newSentenceMap } =
       buildPageSentenceData(pages[currentPage].text);

     setParagraphData(newParagraphData);
     setFlatSentenceMap(newSentenceMap);
     resetAudioState();
     setActiveSentenceIndex(-1);
     abortGenerationRef.current = true;
     latestTranslationRequestRef.current = '';
     setIsTranslating(false);
     setTranslationError(null);
     setTranslationState({ identity: '', byIndex: {} });
  }, [currentPage, pages]);

  // Resolve the navigation target (footnote/page jump) to a sentence to highlight.
  // Separate from the page reset above so it doesn't touch the audio.
  useEffect(() => {
    if (pendingNavigationTarget && typeof pendingNavigationTarget === 'object') {
      if (pendingNavigationTarget.type === 'page') {
        setNavigationSentenceIndex(pendingNavigationTarget.sentenceIndex ?? -1);
      } else if (pendingNavigationTarget.type === 'note') {
        const target = flatSentenceMap.find(mapping => sentenceStartsWithNoteMarker(mapping.text, pendingNavigationTarget.marker, pendingNavigationTarget.noteKey));
        setNavigationSentenceIndex(target?.globalIndex ?? -1);
      }
    } else {
      setNavigationSentenceIndex(-1);
    }
  }, [pendingNavigationTarget, flatSentenceMap]);

  useEffect(() => {
    let cancelled = false;
    const loadCached = async () => {
      if (!currentPageText) return;
      const key = audioCacheKeyFor(currentPage, currentPageText, selectedVoice, audioLanguage);
      try {
        const cached = await getFile(key);
        if (cached && !cancelled) {
          const url = URL.createObjectURL(cached.blob);
          setAudioSrc(url);
          setHasInitiated(true);
          // Restore timings from memory or localStorage; older cached audio may not have persisted timings.
          const cachedTimings = timingsCache.get(key) || readStoredTimings(key);
          if (cachedTimings) timingsCache.set(key, cachedTimings);
          setTimings(cachedTimings || []);
        }
      } catch (e) { /* cache miss is fine */ }
    };
    // Wait for pages to be loaded before attempting cache load,
    // otherwise resetAudioState() in the pages effect will clear audioSrc
    if (!isGenerating && !audioSrc && pages.length > 0) loadCached();
    return () => { cancelled = true; };
  }, [currentPage, selectedVoice, audioLanguage, bookId, chapter.id, pages, currentPageText, sourceFingerprint]);

  const translationCacheKeyFor = (pageIndex: number, pageText: string, sentenceMap: SentenceMap[]): string => {
    return buildCacheKey(
      bookId,
      chapter.id,
      'translation',
      TRANSLATION_CACHE_VERSION,
      sourceFingerprint,
      `page${pageIndex}`,
      textFingerprint(pageText),
      sentenceSignatureFor(sentenceMap),
      settings.targetLanguage
    );
  };

  const loadOrGeneratePageTranslation = async (
    pageIndex: number,
    pageText: string,
    sentenceMap: SentenceMap[]
  ): Promise<string[] | null> => {
    if (settings.targetLanguage === 'Original' || sentenceMap.length === 0) return null;

    const allSentences = sentenceMap.map(m => m.text);
    if (allSentences.length === 0) return null;

    const transCacheKey = translationCacheKeyFor(pageIndex, pageText, sentenceMap);
    const memoryCached = translationMemoryCache.get(transCacheKey);
    if (memoryCached) return [...memoryCached];

    const existingJob = translationJobMap.get(transCacheKey);
    if (existingJob) return existingJob.then(result => result ? [...result] : result);

    const job = (async () => {
      const cached = await getFile(transCacheKey).catch(() => null);
      let cachedTranslations: string[] | null = null;
      if (cached) {
        try {
          cachedTranslations = parseCachedTranslationPayload(
            JSON.parse(await cached.blob.text()),
            allSentences
          );
        } catch (cacheError) {
          console.warn('Ignoring invalid translation cache:', cacheError);
        }
      }

      if (cachedTranslations) {
        cachedTranslations = cachedTranslations.map(stripLeakedTokens);
        translationMemoryCache.set(transCacheKey, cachedTranslations);
        return [...cachedTranslations];
      }

      const generatedTranslations = normalizeTranslationArray(
        (await translateSentences(allSentences, settings.targetLanguage)).map(stripLeakedTokens),
        allSentences.length,
        true
      );
      if (!generatedTranslations) {
        throw new Error('Translation returned no readable content.');
      }

      const transBlob = new Blob([JSON.stringify({
        sourceSentences: allSentences,
        translations: generatedTranslations,
      })], { type: 'application/json' });
      translationMemoryCache.set(transCacheKey, generatedTranslations);
      await saveFile(transCacheKey, transBlob, {
        filename: `translation-ch${chapter.id}-pg${pageIndex + 1}-${titleCase(settings.targetLanguage, 20)}-${titleCase(chapter.title)}.json`,
        mimeType: 'application/json',
        timestamp: Date.now(),
        bookId,
        chapterId: chapter.id,
        componentSource: 'audiobook',
        fileType: 'translation',
      }).catch(e => {
        console.warn('Translation cache save failed:', e);
        throw e;
      });

      return [...generatedTranslations];
    })();

    translationJobMap.set(transCacheKey, job);
    try {
      return await job;
    } finally {
      translationJobMap.delete(transCacheKey);
    }
  };

  useEffect(() => {
    let ignore = false;
    const loadTranslation = async () => {
      if (settings.targetLanguage === 'Original' || flatSentenceMap.length === 0) {
        setIsTranslating(false);
        return;
      }

      const allSentences = flatSentenceMap.map(m => m.text);
      if (allSentences.length === 0) return;

      setIsTranslating(true);
      setTranslationError(null);
      try {
        const pageText = pages[currentPage]?.text || allSentences.join('\n');
        const requestSentenceMap = [...flatSentenceMap];
        const requestIdentity = translationIdentityFor(
          currentPage,
          pageText,
          requestSentenceMap,
          settings.targetLanguage
        );
        latestTranslationRequestRef.current = requestIdentity;
        const translations = await loadOrGeneratePageTranslation(currentPage, pageText, requestSentenceMap);
        if (!translations) {
          setIsTranslating(false);
          return;
        }

        if (ignore || latestTranslationRequestRef.current !== requestIdentity) return;

        setTranslationState(() => {
          const byIndex: Record<number, string> = {};
          requestSentenceMap.forEach((mapping, index) => {
            byIndex[mapping.globalIndex] = translations[index] || '';
          });
          return { identity: requestIdentity, byIndex };
        });
      } catch(e) {
        console.error("Translation error", e);
        if (!ignore) setTranslationError(e instanceof Error ? e.message : 'Translation failed.');
      } finally {
        if (!ignore) setIsTranslating(false);
      }
    };

    loadTranslation();
    return () => { ignore = true; };
  }, [
    bookId,
    chapter.id,
    chapter.title,
    currentPage,
    fileContext.content.length,
    fileContext.sourceHash,
    flatSentenceMap,
    pages,
    settings.targetLanguage,
  ]);

  useEffect(() => {
    let cancelled = false;

    const prefetchTranslations = async () => {
      if (settings.targetLanguage === 'Original' || pages.length === 0) return;

      const maxPage = Math.min(pages.length - 1, currentPage + 3);
      for (let pageIndex = currentPage + 1; pageIndex <= maxPage; pageIndex++) {
        if (cancelled) return;
        const page = pages[pageIndex];
        if (!page?.text) continue;

        const { flatSentenceMap: prefetchSentenceMap } = buildPageSentenceData(page.text);
        if (prefetchSentenceMap.length === 0) continue;

        try {
          await loadOrGeneratePageTranslation(pageIndex, page.text, prefetchSentenceMap);
        } catch (error) {
          console.warn(`Translation prefetch failed for page ${pageIndex + 1}:`, error);
        }
      }
    };

    prefetchTranslations();
    return () => { cancelled = true; };
  }, [
    bookId,
    chapter.id,
    chapter.title,
    currentPage,
    fileContext.content.length,
    fileContext.sourceHash,
    pages,
    settings.targetLanguage,
  ]);

  const initAudioVisualizer = () => {
    if (!audioRef.current || audioContextRef.current) return;
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512; 
      const source = ctx.createMediaElementSource(audioRef.current);
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;

      const particles: QuantumParticle[] = [];
      const particleCount = 200;
      for (let i = 0; i < particleCount; i++) {
        const typeRand = Math.random();
        particles.push({
          x: Math.random() * 1800,
          y: Math.random() * 250,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          size: Math.random() * 2 + 0.5,
          targetSize: 1,
          hue: 180 + Math.random() * 40,
          alpha: Math.random() * 0.4 + 0.1,
          intensity: 0,
          angle: Math.random() * Math.PI * 2,
          type: typeRand > 0.9 ? 'data' : typeRand > 0.7 ? 'shimmer' : 'pixel',
          life: Math.random()
        });
      }
      particlesRef.current = particles;
    } catch (e) { console.warn("Visualizer failed", e); }
  };

  useEffect(() => {
    if (audioRef.current) {
        audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, audioSrc]);

  // Synchronize state with audio element clock
  const handleTimeUpdate = () => {
    if (audioRef.current) {
      const audio = audioRef.current;
      const t = audio.currentTime;
      setCurrentTime(t);
      const d = audio.duration || 0;
      setDuration(d);
      setPlaybackProgress(d > 0 ? (t / d) * 100 : 0);
      // Remember where we are so returning to this audio resumes here.
      if (loadedAudioKeyRef.current && t > 0.1) audioPlaybackPositions.set(loadedAudioKeyRef.current, t);

      const activeIdx = timings.findIndex(chunk => !chunk.isWhitespace && t >= chunk.start && t < chunk.end);
      if (activeIdx !== -1 && activeIdx !== activeSentenceIndex) {
          setActiveSentenceIndex(activeIdx);
      }
    }
  };

  // Dedicated visualizer loop
  useEffect(() => {
    if (!isPlaying) return;
    
    const draw = () => {
        if (canvasRef.current && analyserRef.current && !isModuleMinimized) {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                const bufferLength = analyserRef.current.frequencyBinCount;
                const dataArray = new Uint8Array(bufferLength);
                analyserRef.current.getByteFrequencyData(dataArray);
                
                let bass = 0; 
                let mid = 0;
                let high = 0;
                const split1 = Math.floor(bufferLength * 0.1);
                const split2 = Math.floor(bufferLength * 0.4);

                for (let i = 0; i < split1; i++) bass += dataArray[i];
                for (let i = split1; i < split2; i++) mid += dataArray[i];
                for (let i = split2; i < bufferLength; i++) high += dataArray[i];

                bass = (bass / split1) / 255;
                mid = (mid / (split2 - split1)) / 255;
                high = (high / (bufferLength - split2)) / 255;

                ctx.fillStyle = 'rgba(2, 4, 8, 0.2)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                const centerX = canvas.width / 2;
                const centerY = canvas.height / 2;

                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                for (let w = 0; w < 3; w++) {
                    ctx.beginPath();
                    ctx.lineWidth = 1.5 + (w * 0.5);
                    ctx.strokeStyle = `hsla(${180 + w * 20}, 100%, 70%, ${0.2 + mid * 0.5})`;
                    const amplitude = (60 + w * 20) * (bass + mid * 0.5);
                    const freq = 0.005 + (w * 0.002);
                    const offset = Date.now() * 0.002 + (w * Math.PI);
                    ctx.moveTo(0, centerY);
                    for (let x = 0; x < canvas.width; x += 10) {
                        const y = centerY + Math.sin(x * freq + offset) * amplitude * Math.sin(x / canvas.width * Math.PI);
                        ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                }
                ctx.restore();

                const barWidth = (canvas.width / bufferLength) * 2.5;
                let barX = 0;
                ctx.save();
                ctx.globalCompositeOperation = 'screen';
                for (let i = 0; i < bufferLength / 2; i++) {
                    const barHeight = (dataArray[i] / 255) * 120;
                    const hue = 180 + (i / bufferLength) * 100;
                    const drawBar = (x: number) => {
                        const grad = ctx.createLinearGradient(x, centerY - barHeight/2, x, centerY + barHeight/2);
                        grad.addColorStop(0, `hsla(${hue}, 100%, 50%, 0)`);
                        grad.addColorStop(0.5, `hsla(${hue}, 100%, 70%, ${0.6 * mid})`);
                        grad.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
                        ctx.fillStyle = grad;
                        ctx.fillRect(x, centerY - barHeight/2, barWidth - 1, barHeight);
                    };
                    drawBar(centerX + barX);
                    drawBar(centerX - barX - barWidth);
                    barX += barWidth;
                }
                ctx.restore();
                
                particlesRef.current.forEach((p) => {
                    p.life -= 0.002;
                    if (p.life <= 0) { p.life = 1; p.x = Math.random() * canvas.width; p.y = Math.random() * canvas.height; }
                    const driftForce = (mid * 1.5) + 0.2;
                    p.vx += (Math.random() - 0.5) * driftForce; p.vy += (Math.random() - 0.5) * driftForce;
                    p.vx *= 0.98; p.vy *= 0.98; p.x += p.vx; p.y += p.vy;
                    const alpha = p.life * (0.1 + high * 0.8);
                    ctx.fillStyle = `hsla(${p.hue}, 100%, 80%, ${alpha})`;
                    if (p.type === 'data') { ctx.font = '6px monospace'; ctx.fillText(Math.random() > 0.5 ? '1' : '0', p.x, p.y); }
                    else { ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); }
                });
            }
        }
        animationRef.current = requestAnimationFrame(draw);
    };
    animationRef.current = requestAnimationFrame(draw);
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); };
  }, [isPlaying, isModuleMinimized]);

  useEffect(() => {
    const targetIndex = navigationSentenceIndex !== -1 ? navigationSentenceIndex : (autoScroll ? activeSentenceIndex : -1);
    if (targetIndex !== -1 && flatSentenceMap.some(mapping => mapping.globalIndex === targetIndex)) {
        const sentenceEl = document.getElementById(`original-sent-${targetIndex}`);
        const container = readerScrollRef.current;
        if (sentenceEl && container) {
            const elTop = sentenceEl.offsetTop;
            const elHeight = sentenceEl.offsetHeight;
            const containerHeight = container.clientHeight;
            const target = elTop - containerHeight / 2 + elHeight / 2;
            container.scrollTo({ top: target, behavior: 'smooth' });
        }
    }
  }, [activeSentenceIndex, navigationSentenceIndex, autoScroll, flatSentenceMap]);

  const audioGenKeyRef = useRef('');

  // The cache key of the audio currently loaded, kept in a ref so timeupdate/seek can
  // read it without recomputing the (hashed) key on every tick.
  const loadedAudioKeyRef = useRef('');
  useEffect(() => {
    loadedAudioKeyRef.current = currentPageText
      ? audioCacheKeyFor(currentPage, currentPageText, selectedVoice, audioLanguage)
      : '';
  }, [currentPage, currentPageText, selectedVoice, audioLanguage]);

  // On mount, re-attach to any in-flight generation for this page/voice/language
  useEffect(() => {
    if (!currentPageText) return;
    const key = audioCacheKeyFor(currentPage, currentPageText, selectedVoice, audioLanguage);
    audioGenKeyRef.current = key;
    const inflight = inflightAudioMap.get(key);
    if (inflight && !audioSrc) {
      setIsGenerating(true);
      setHasInitiated(true);
      setGenerationProgress("RESUMING...");
      inflight.promise.then(result => {
        if (audioGenKeyRef.current !== key) return; // stale
        if (result) {
          const url = URL.createObjectURL(result.blob);
          setTimings(result.timings);
          setAudioSrc(url);
        }
      }).catch(() => {
        setGenerationProgress("ERR_LINK_FAILED");
      }).finally(() => {
        if (audioGenKeyRef.current === key) setIsGenerating(false);
      });
    }
  }, [currentPage, selectedVoice, audioLanguage, bookId, chapter.id, currentPageText, sourceFingerprint, audioSrc]);

  const handleInitiateToggle = async () => {
    if (isGenerating) {
        abortGenerationRef.current = true;
        const key = audioGenKeyRef.current;
        const inflight = inflightAudioMap.get(key);
        if (inflight) inflight.abort();
        inflightAudioMap.delete(key);
        setIsGenerating(false);
        setHasInitiated(true);
        return;
    }
    generatePageAudio();
  };

  const generatePageAudio = async () => {
    if (isGenerating || !flatSentenceMap.length || !currentPageText) return;
    const genKey = audioCacheKeyFor(currentPage, currentPageText, selectedVoice, audioLanguage);
    audioGenKeyRef.current = genKey;

    // If already in-flight (e.g. double-click), just attach
    if (inflightAudioMap.has(genKey)) return;

    abortGenerationRef.current = false;
    setIsGenerating(true);
    setHasInitiated(true);
    setGenerationProgress("INIT_VOICE_CORE...");

    const BYTES_PER_SEC = 48000;

    const buildAudioFromResults = (results: (string | null)[], sentences: string[]) => {
      const audioBuffers: Uint8Array[] = [];
      const newTimings: ChunkTiming[] = [];
      let currentByteOffset = 0;

      for (let i = 0; i < results.length; i++) {
        const b64 = results[i];
        const startIndex = i * TTS_BATCH_SIZE;
        const endIndex = Math.min(startIndex + TTS_BATCH_SIZE, sentences.length);
        const batchSentencesSubset = sentences.slice(startIndex, endIndex);
        const sentenceCount = batchSentencesSubset.length;

        if (!b64) {
          for (let k = 0; k < sentenceCount; k++) {
            newTimings.push({ text: sentences[startIndex + k], start: currentByteOffset / BYTES_PER_SEC, end: currentByteOffset / BYTES_PER_SEC, isWhitespace: true });
          }
          continue;
        }

        const binaryString = atob(b64);
        const bytes = new Uint8Array(binaryString.length);
        for (let k = 0; k < binaryString.length; k++) bytes[k] = binaryString.charCodeAt(k);
        audioBuffers.push(bytes);

        const durationSec = bytes.length / BYTES_PER_SEC;
        const totalCharsInBatch = batchSentencesSubset.reduce((acc, s) => acc + s.length, 0);
        let batchOffset = 0;
        for (let k = 0; k < sentenceCount; k++) {
          const sText = batchSentencesSubset[k];
          const sDuration = (sText.length / (totalCharsInBatch || 1)) * durationSec;
          const startSec = (currentByteOffset / BYTES_PER_SEC) + batchOffset;
          newTimings.push({ text: sText, start: startSec, end: startSec + sDuration, isWhitespace: false });
          batchOffset += sDuration;
        }
        currentByteOffset += bytes.length;
      }

      const mergedBuffer = new Uint8Array(currentByteOffset);
      let offset = 0;
      for (const buf of audioBuffers) { mergedBuffer.set(buf, offset); offset += buf.length; }
      return { mergedBuffer, newTimings, totalBytes: currentByteOffset };
    };

    // Capture values needed by the generation closure (survives unmount)
    const capturedSentenceMap = [...flatSentenceMap];
    const capturedParagraphData = [...paragraphData];
    const capturedAudioLanguage = audioLanguage;
    const capturedVoice = selectedVoice;
    const capturedTargetLanguage = settings.targetLanguage;
    const capturedBookId = bookId;
    const capturedChapterId = chapter.id;
    const capturedPage = currentPage;
    const capturedChapterTitle = titleCase(chapter.title);

    // The core generation runs as a standalone promise stored at module level
    const genPromise = (async (): Promise<{ blob: Blob; timings: ChunkTiming[] } | null> => {
      try {
        let sentencesToSpeak: string[] = [];
        if (capturedAudioLanguage === 'Original') {
          sentencesToSpeak = capturedSentenceMap.map(m => m.text);
        } else {
          if (capturedAudioLanguage === capturedTargetLanguage && capturedParagraphData.every(p => p.translated.length > 0)) {
            sentencesToSpeak = capturedParagraphData.flatMap(p => p.translated);
          } else {
            setGenerationProgress("AUDIO_TRANS...");
            sentencesToSpeak = await translateSentences(capturedSentenceMap.map(m => m.text), capturedAudioLanguage);
          }
        }

        const batchedSentences: string[] = [];
        for (let i = 0; i < sentencesToSpeak.length; i += TTS_BATCH_SIZE) {
          batchedSentences.push(sentencesToSpeak.slice(i, i + TTS_BATCH_SIZE).join(' '));
        }

        const audioResults: (string | null)[] = new Array(batchedSentences.length).fill(null);
        let firstBatchPlayed = false;

        await processQueue<string, string | null>(
          batchedSentences,
          CONCURRENCY_LIMIT,
          async (batchText, idx) => {
            if (abortGenerationRef.current) return null;
            setGenerationProgress(`PACKET_${idx + 1}_OF_${batchedSentences.length}`);
            const result = await generateSpeech(batchText, capturedVoice);
            audioResults[idx] = result;

            // Stream: play first completed batch immediately
            if (!firstBatchPlayed && result) {
              firstBatchPlayed = true;
              const partial = buildAudioFromResults(audioResults, sentencesToSpeak);
              if (partial.totalBytes > 0) {
                const blob = pcmToWav(partial.mergedBuffer.buffer, 24000);
                const url = URL.createObjectURL(blob);
                setTimings(partial.newTimings);
                setAudioSrc(url);
              }
            }
            return result;
          },
          () => abortGenerationRef.current
        );

        if (abortGenerationRef.current) return null;

        // Build final complete audio
        const final = buildAudioFromResults(audioResults, sentencesToSpeak);
        const blob = pcmToWav(final.mergedBuffer.buffer, 24000);

        // Cache the complete result (runs even if component is unmounted)
        saveFile(genKey, blob, {
          filename: `voice-ch${capturedChapterId}-pg${capturedPage + 1}-${capturedChapterTitle}.wav`,
          mimeType: 'audio/wav',
          timestamp: Date.now(),
          bookId: capturedBookId,
          chapterId: capturedChapterId,
          componentSource: 'audiobook',
          fileType: 'audio',
        }).catch(e => console.warn('Cache save failed:', e));

        // Persist timings at module level so they survive remount
        timingsCache.set(genKey, final.newTimings);
        writeStoredTimings(genKey, final.newTimings);

        trackGeneration({ bookId: capturedBookId, chapterIndex: capturedChapterId, module: 'voice', provider: 'gemini', model: 'tts', inputChars: sentencesToSpeak.join('').length, outputDurationMs: Math.round((final.totalBytes / BYTES_PER_SEC) * 1000) });
        return { blob, timings: final.newTimings };
      } catch (e: any) {
        console.error('TTS generation failed:', e);
        trackGeneration({ bookId: capturedBookId, chapterIndex: capturedChapterId, module: 'voice', status: 'failed', errorMessage: e.message });
        setGenerationProgress(`ERR: ${e.message || 'Unknown error'}`);
        await new Promise(r => setTimeout(r, 4000));
        return null;
      } finally {
        inflightAudioMap.delete(genKey);
      }
    })();

    inflightAudioMap.set(genKey, { promise: genPromise, abort: () => { abortGenerationRef.current = true; } });

    try {
      const result = await genPromise;
      if (audioGenKeyRef.current === genKey && result) {
        const url = URL.createObjectURL(result.blob);
        setTimings(result.timings);
        setAudioSrc(url);
      }
    } catch (e: any) {
      setGenerationProgress(`ERR: ${e.message || 'Unknown error'}`);
    } finally {
      if (audioGenKeyRef.current === genKey) setIsGenerating(false);
    }
  };

  const togglePlay = async () => {
    if (!audioSrc || !audioRef.current) return;
    try {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        if (!audioContextRef.current) initAudioVisualizer();
        if (audioContextRef.current?.state === 'suspended') audioContextRef.current.resume();
        const playPromise = audioRef.current.play();
        if (playPromise !== undefined) {
          await playPromise.catch(e => { if (e.name !== 'AbortError') throw e; });
          setIsPlaying(true);
        }
      }
    } catch (err) {
      console.warn("Playback interrupted:", err);
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (audioRef.current && duration) {
       audioRef.current.currentTime = (val / 100) * duration;
    }
  };

  const currentReaderPage = pages[currentPage];
  const isNotesChapter = isNotesChapterTitle(chapter.title) || isNotesChapterTitle(chapter.sourceHeading || '');
  const isIndexChapter = isIndexChapterTitle(chapter.title) || isIndexChapterTitle(chapter.sourceHeading || '');
  const activeNoteTarget =
    typeof pendingNavigationTarget === 'object' && pendingNavigationTarget?.type === 'note'
      ? pendingNavigationTarget
      : typeof initialPageTarget === 'object' && initialPageTarget.type === 'note'
        ? initialPageTarget
        : null;
  const isStructuredPage =
    currentReaderPage?.mode === 'principle-topic' &&
    currentReaderPage.blocks.some(block => block.type === 'principle-topic');
  const currentChapterIndex = allChapters.findIndex(c => c.id === chapter.id);
  const canGoPrevious = currentPage > 0 || currentChapterIndex > 0;
  const canGoNext =
    currentPage < pages.length - 1 ||
    (onChapterChange && currentChapterIndex >= 0 && currentChapterIndex < allChapters.length - 1);

  const currentTranslationIdentity = translationIdentityFor(
    currentPage,
    currentPageText,
    flatSentenceMap,
    settings.targetLanguage
  );
  const translationByIndex = new Map<number, string>();
  if (translationState.identity === currentTranslationIdentity) {
    Object.entries(translationState.byIndex).forEach(([index, translated]) => {
      if (translated) translationByIndex.set(Number(index), translated);
    });
  }

  const seekToSentence = async (globalIdx: number) => {
    if (globalIdx < 0 || !audioRef.current || !timings[globalIdx]) return;
    audioRef.current.currentTime = timings[globalIdx].start;
    if (!isPlaying) {
      if (!audioContextRef.current) initAudioVisualizer();
      if (audioContextRef.current?.state === 'suspended') audioContextRef.current.resume();
      try {
        await audioRef.current.play();
        setIsPlaying(true);
      } catch (e) {
        // Browser autoplay policies can reject play() until the next user gesture.
      }
    }
  };

  const hasActiveTextSelection = (): boolean => {
    if (typeof window === 'undefined') return false;
    return Boolean(window.getSelection()?.toString().trim());
  };

  const handleSentencePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    sentencePointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      time: Date.now(),
    };
  };

  const shouldIgnoreSentenceClick = (event: React.MouseEvent<HTMLElement>): boolean => {
    if (event.detail > 1 || hasActiveTextSelection()) return true;
    // A click on a footnote/reference marker must navigate to the note, not be
    // treated as a click on the surrounding sentence (which would seek + play it).
    if ((event.target as HTMLElement)?.closest?.('[data-footnote-marker],[data-reference-marker]')) return true;

    const start = sentencePointerRef.current;
    if (!start) return false;

    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    const elapsed = Date.now() - start.time;
    sentencePointerRef.current = null;

    return moved > 6 || elapsed > 900;
  };

  const handleSentenceClick = (globalIdx: number, event: React.MouseEvent<HTMLElement>) => {
    if (shouldIgnoreSentenceClick(event)) return;
    setNavigationSentenceIndex(-1);
    setPendingNavigationTarget(null);
    seekToSentence(globalIdx);
  };

  const findNotesChapter = (): Chapter | null => {
    const currentIndex = allChapters.findIndex(candidate => candidate.id === chapter.id);
    const notes = allChapters
      .map((candidate, index) => ({ candidate, index }))
      .filter(entry => isNotesChapterTitle(entry.candidate.title) || isNotesChapterTitle(entry.candidate.sourceHeading || ''));
    if (notes.length === 0) return null;
    return (
      notes.find(entry => currentIndex === -1 || entry.index > currentIndex)?.candidate ||
      notes[notes.length - 1]?.candidate ||
      null
    );
  };

  const handleFootnoteNavigation = (
    marker: string,
    globalIndex: number,
    event: React.MouseEvent<HTMLElement>,
    targetHref?: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const noteTarget: Extract<ReaderPageTarget, { type: 'note' }> = {
      type: 'note',
      marker: cleanNoteMarkerLabel(marker),
      targetHref,
      noteKey: noteKeyFromHref(targetHref),
      sourceChapterId: chapter.id,
      sourceChapterIndex: currentChapterIndex,
      sourceChapterNumber: explicitChapterNumberFrom(chapter.sourceHeading, chapter.title),
      sourceChapterTitle: chapter.title,
      sourceChapterHeading: chapter.sourceHeading,
      returnTarget: {
        chapterId: chapter.id,
        pageIndex: currentPage,
        sentenceIndex: globalIndex >= 0 ? globalIndex : undefined,
      },
    };

    // Resolve the note IN THIS CHAPTER first — not only when we're already in a Notes chapter.
    // Page-bottom / chapter-end footnotes (this book's "fn3 …") live in the same chapter as their
    // marker, anchored with the marker's key, so the keyed lookup finds them here.
    //
    // BUT a KEYED footnote whose destination page lies OUTSIDE this chapter is a numbered ENDNOTE:
    // its note is in the separate Notes chapter. Scanning THIS chapter for it is not just useless —
    // pageIndexForNoteTarget's pattern fallback (noteStartPatternFor) would match an unrelated
    // numbered LIST item in the body ("1. There were rising returns…"), sending the reader to the
    // wrong place. Detect that by mapping the key's dest page to a content OFFSET (via the reliable
    // "[[PAGE n]]" markers) and testing it against THIS chapter's re-anchored offset range — offsets,
    // not the raw bookmark page numbers, which are broken in z-library PDFs. Keyless markers (Roman /
    // geometry in-chapter footnotes) have no dest page and still resolve locally, where their pattern
    // can't collide with a numeric list.
    // noteKey is the NORMALISED href (noteKeyFromHref strips non-alphanumerics), so "#pdffn-p537-y620"
    // arrives as "pdffnp537y620" — match that form, not the hyphenated raw href.
    const keyDestPage = Number(noteTarget.noteKey?.match(/^pdffn-?p(\d+)/u)?.[1]) || 0;
    let keyedEndnote = false;
    if (keyDestPage > 0 && chapter.sourceStart != null && chapter.sourceEnd != null) {
      const destOff = (fileContext.content || '').indexOf(`[[PAGE ${keyDestPage}]]`);
      if (destOff >= 0) keyedEndnote = destOff < chapter.sourceStart || destOff >= chapter.sourceEnd;
    }

    if (!keyedEndnote) {
      const localPageIndex = pageIndexForNoteTarget(noteTarget, pages);
      if (localPageIndex >= 0) {
        setPendingNavigationTarget(noteTarget);
        setNavigationSentenceIndex(-1);
        setCurrentPage(localPageIndex);
        return;
      }
    }

    const notesChapter = findNotesChapter();
    if (!notesChapter || !onChapterChange) return;
    onChapterChange(notesChapter.id, noteTarget);
  };

  const handleNoteBackNavigation = (
    event: React.MouseEvent<HTMLElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (!activeNoteTarget) return;
    const pageTarget: ReaderPageTarget = {
      type: 'page',
      pageIndex: activeNoteTarget.returnTarget.pageIndex,
      sentenceIndex: activeNoteTarget.returnTarget.sentenceIndex,
    };
    if (activeNoteTarget.returnTarget.chapterId === chapter.id) {
      setPendingNavigationTarget(pageTarget);
      setCurrentPage(pageTarget.pageIndex);
      setNavigationSentenceIndex(pageTarget.sentenceIndex ?? -1);
      return;
    }
    if (!onChapterChange) return;
    onChapterChange(activeNoteTarget.returnTarget.chapterId, pageTarget);
  };

  // A cross-reference ("… see Appendix 2 .") is a ONE-WAY jump to the chapter that contains the
  // link's destination page — no return marker, unlike a footnote. Resolve the destination page to
  // a content offset via the reliable "[[PAGE n]]" markers (kept through cleanup as navigation
  // metadata), then find the chapter whose source range spans that offset. This never trusts the
  // broken bookmark page numbers — it uses the page markers extraction actually emitted plus the
  // corrected chapter offsets.
  const handleCrossReferenceNavigation = (
    destPage: number,
    event: React.MouseEvent<HTMLElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (!onChapterChange) return;
    const content = fileContext.content || '';
    let pageStart = content.indexOf(`[[PAGE ${destPage}]]`);
    if (pageStart < 0) {
      const re = /\[\[PAGE\s+(\d+)\]\]/g;
      let m: RegExpExecArray | null;
      let best = -1;
      while ((m = re.exec(content)) !== null) {
        const p = Number(m[1]);
        if (p <= destPage && p > best) { best = p; pageStart = m.index; }
      }
    }
    if (pageStart < 0) return;
    // The destination page's offset span (up to the next page marker). A cross-reference points at
    // a chapter's START, and the chapter HEADING sits just after the "[[PAGE n]]" marker on that
    // page — so "the chapter whose source offset lands ON this page" is the target. (Using the raw
    // page offset instead resolves to the PREVIOUS chapter, because the page marker precedes the
    // heading — the off-by-one seen with Appendix 2 → Appendix 1.)
    const nextRel = content.slice(pageStart + 1).search(/\[\[PAGE\s+\d+\]\]/);
    const pageEnd = nextRel < 0 ? content.length : pageStart + 1 + nextRel;
    const startsOnPage = allChapters
      .filter(c => c.sourceStart != null && c.sourceStart >= pageStart && c.sourceStart < pageEnd)
      .sort((a, b) => (a.sourceStart ?? 0) - (b.sourceStart ?? 0))[0];
    // Fallback for a reference into the MIDDLE of a chapter (no chapter starts on that page): the
    // chapter whose range spans the page offset.
    const containing = allChapters.find(
      c => c.sourceStart != null && pageStart >= c.sourceStart && (c.sourceEnd == null || pageStart < c.sourceEnd)
    );
    const target = startsOnPage ?? containing ?? [...allChapters]
      .filter(c => c.sourceStart != null && c.sourceStart <= pageStart)
      .sort((a, b) => (b.sourceStart ?? 0) - (a.sourceStart ?? 0))[0];
    if (!target) return;
    if (target.id === chapter.id) {
      // Same chapter — scroll to the destination page within the current pages (a figure/table
      // referenced from its own chapter) rather than no-op.
      const idx = pageIndexForSourcePage(destPage, pages);
      if (idx >= 0 && idx !== currentPage) {
        setPendingNavigationTarget(null);
        setNavigationSentenceIndex(-1);
        setCurrentPage(idx);
      }
      return;
    }
    // Cross-chapter — land on the destination page inside the target chapter (page-precise for a
    // figure/table deep in the chapter; equals the chapter start for an Appendix/Chapter ref).
    onChapterChange(target.id, { type: 'source-page', page: destPage });
  };

  const readerTextClass = `${TEXT_SIZES[settings.textSize]} ${LINE_HEIGHTS[settings.lineHeight]} ${LETTER_SPACINGS[settings.letterSpacing]}`;
  const noIndentStyle: React.CSSProperties = { textIndent: 0, paddingLeft: 0, marginLeft: 0 };
  const noTextIndentStyle: React.CSSProperties = { textIndent: 0, marginLeft: 0 };
  const bodyParagraphStyle: React.CSSProperties = { textIndent: '1.75em', paddingLeft: 0, marginLeft: 0 };
  const sentenceHoverClass = 'hover:text-white hover:drop-shadow-[0_0_4px_rgba(255,255,255,0.45)] cursor-pointer';
  const normalizeSentenceForMatch = (value: string): string => stripInlineFormatSyntax(value).replace(/\s+/g, ' ').trim();
  const isPlainSubtitleParagraph = (sentences: string[]): boolean => {
    // Strip wrapping emphasis so an italic subtitle ("*Genius and Nemesis*") is detected.
    const text = stripOrphanDisplayMarkers(sentences.join(' ')).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 90 || sentences.length !== 1) return false;
    if (/[.!?。！？]$/u.test(text)) return false;
    if (/[;,]/u.test(text)) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 12) return false;
    const contentWords = words.filter(word => !/^(?:a|an|and|as|at|but|by|for|from|in|into|of|on|or|the|to|with)$/iu.test(word));
    return contentWords.length >= 2 && contentWords.every(word => /^[\p{Lu}\d"“‘]/u.test(word));
  };
  const looksLikeSignatureLine = (value: string): boolean => {
    const clean = stripInlineFormatSyntax(value).replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 120) return false;
    if (/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/u.test(clean)) return true;
    // ≥2 tokens: a lone capitalised word is a heading fragment, not a signature.
    if (/\s/.test(clean) && looksLikePersonName(clean)) return true;
    return /^(?:Los Angeles|New York|London|Paris|Berlin|Beijing|Shanghai|Tokyo|Hong Kong|Singapore|San Francisco|Washington(?:,\s*D\.C\.)?)$/u.test(clean);
  };
  const looksLikeNotesSectionHeading = (value: string): boolean => {
    const clean = stripInlineFormatSyntax(value)
      .replace(/^(?:[*_~]\s*)+/, '')
      .replace(/(?:\s*[*_~])+$/u, '')
      .replace(/\s+/g, ' ')
      .trim();
    return /^(?:chapter\s+\d+|afterword|epilogue|prologue|introduction)\b/iu.test(clean);
  };
  const isNotesSectionHeadingParagraph = (sentences: string[]): boolean =>
    isNotesChapter && sentences.length === 1 && looksLikeNotesSectionHeading(sentences[0]);
  const plainParagraphStyleFor = (sentences: string[], align?: 'right' | 'center'): React.CSSProperties => {
    const text = sentences.join(' ').replace(/\s+/g, ' ').trim();
    // Index entries are list items, not prose — no first-line indent.
    if (isIndexChapter) return noTextIndentStyle;
    if (isNotesSectionHeadingParagraph(sentences)) return noTextIndentStyle;
    // PRIOR (geometry): a right/centre-aligned block — carried from extraction as an alignment
    // sentinel, e.g. a right-aligned epigraph credit "—NORMAN COHN" — is set off, so no first-line
    // indent. Authoritative typographic signal; runs BEFORE the text heuristics below.
    if (align === 'right' || align === 'center') return noTextIndentStyle;
    // BACKUP (text), for lines geometry did not set off. A note is always a citation (never a
    // signature); and a citation that merely CONTAINS a date — recognisable by a URL or a quoted
    // title — is not a dateline (note 54 vs 55). Gate the heuristics on both so they can't misfire.
    const citationLike = /:\/\//u.test(text) || /["“][^"”\n]{3,}["”]/u.test(text);
    if (!isNotesChapter && !citationLike && (isPlainSubtitleParagraph(sentences) || looksLikeAttributionLine(text) || looksLikeSignatureLine(text))) return noTextIndentStyle;
    return bodyParagraphStyle;
  };
  const structuredParagraphStyleFor = (paragraph: string): React.CSSProperties => {
    const clean = paragraph.replace(/\s+/g, ' ').trim();
    if (!clean) return noTextIndentStyle;
    if (looksLikeAttributionLine(clean) || looksLikeSignatureLine(clean)) return noTextIndentStyle;
    return bodyParagraphStyle;
  };
  const looksLikeCitationParagraph = (value: string): boolean => {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 900) return false;
    // Allow any leading emphasis markers: a blockquote wrapping already-italic text
    // yields a quote that starts with "**" (tangled emphasis), which a single "\*?"
    // would miss — so the quote wouldn't get its citation spacing (blank line before).
    if (/^[*_~]*[“"‘']/.test(clean)) return true;
    return /^[*_~]{1,2}[^*]{20,900}[*_~]{1,2}$/.test(clean);
  };
  const paragraphSpacingClassFor = (value: string): string => {
    const clean = value.replace(/\s+/g, ' ').trim();
    // Index entries are a tight list — no prose/citation top margins (an entry like
    // "“Adult Literacy in America,” 227" would otherwise be treated as a quote).
    if (isIndexChapter) return '';
    if (isNotesChapter && looksLikeNotesSectionHeading(clean)) return 'mt-10 mb-3';
    // Each chapter-end NOTE is one structured line, stacked at space-y-0 with no gap, so adjacent
    // notes (80, 81, …) ran together. Give every note entry (a line opening with its number/roman +
    // ".)" ) a small top margin so consecutive notes read as separate entries.
    if (isNotesChapter && /^["'“]?\s*(?:\d{1,3}|[ivxlcdm]{1,4})[.)]\s/iu.test(clean)) return 'mt-3';
    // A section subtitle (e.g. "THE END OF NATIONS", "PROMETHEUS UNBOUND: ...") is
    // rendered bold but otherwise got no spacing, so it ran right into the
    // surrounding prose. Give it room above and a little below.
    if (isPlainSubtitleParagraph([clean])) return 'mt-8 mb-3';
    if (looksLikeCitationParagraph(clean)) return 'mt-5';
    // The author/attribution line already carries its own block margins
    // (mt-0.5 mb-4 from the 'attribution' segment style); adding paragraph-level
    // mt-2/mb-5 on top stacked them, leaving too much space above and below. Let
    // the segment's own margins stand so the author sits snugly under its quote.
    if (looksLikeAttributionLine(clean)) return '';
    if (looksLikeSignatureLine(clean)) return 'mt-1';
    return '';
  };
  const paragraphLineRunsFor = (pIdx: number, sentences: string[]): ParagraphLineRun[][] => {
    const lines: ParagraphLineRun[][] = [[]];
    sentences.forEach((sentence, sIdx) => {
      const mapping = flatSentenceMap.find(m => m.pIndex === pIdx && m.sIndex === sIdx);
      const run = {
        sentence,
        sIdx,
        globalIndex: mapping?.globalIndex ?? -1,
      };
      lines[lines.length - 1].push(run);
      if (mapping?.lineBreakAfter && sIdx < sentences.length - 1) {
        lines.push([]);
      }
    });
    return lines.filter(line => line.length > 0);
  };
  let structuredSentenceCursor = 0;

  const inkRangesForText = (text: string, globalIndex: number): { start: number; end: number }[] => {
    if (!text || globalIndex < 0) return [];
    const candidates = inkedSelections
      .filter(item => item.sentenceIndex === globalIndex && item.text.trim().length > 0)
      .map(item => ({ text: item.text.trim(), startOffset: item.startOffset }))
      .sort((a, b) => b.text.length - a.text.length);
    if (candidates.length === 0) return [];

    const lowerText = text.toLowerCase();
    const matches: { start: number; end: number }[] = [];
    for (const candidate of candidates) {
      const needle = candidate.text.toLowerCase();
      if (!needle) continue;
      if (typeof candidate.startOffset === 'number' && candidate.startOffset >= 0) {
        const offsetMatch = lowerText.indexOf(needle, candidate.startOffset);
        const start = offsetMatch >= 0 && Math.abs(offsetMatch - candidate.startOffset) <= 2
          ? offsetMatch
          : lowerText.indexOf(needle);
        if (start !== -1) {
          const end = start + needle.length;
          const overlaps = matches.some(match => start < match.end && end > match.start);
          if (!overlaps) matches.push({ start, end });
        }
        continue;
      }

      const start = lowerText.indexOf(needle);
      if (start !== -1) {
        const end = start + needle.length;
        const overlaps = matches.some(match => start < match.end && end > match.start);
        if (!overlaps) matches.push({ start, end });
      }
    }

    matches.sort((a, b) => a.start - b.start);
    return matches;
  };

  const splitTextByInk = (text: string, globalIndex: number): { text: string; inked: boolean }[] => {
    const matches = inkRangesForText(text, globalIndex);
    if (matches.length === 0) return [{ text, inked: false }];
    const parts: { text: string; inked: boolean }[] = [];
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) parts.push({ text: text.slice(cursor, match.start), inked: false });
      parts.push({ text: text.slice(match.start, match.end), inked: true });
      cursor = match.end;
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor), inked: false });
    return parts;
  };

  const inlineFormatClassFor = (format: InlineFormat): string => {
    switch (format) {
      case 'bold':
        return 'font-bold text-zinc-100';
      case 'italic':
        return 'italic text-zinc-200';
      case 'underline':
        return 'underline decoration-[#00f3ff]/70 underline-offset-4 text-zinc-100';
      case 'strike':
        return 'line-through decoration-[#ff003c]/70 text-zinc-500';
      case 'link':
        return LINK_STYLES[settings.highlightColor];
      case 'attribution':
      case 'attributionFootnote':
        return 'block mt-0.5 mb-4 leading-tight text-right text-zinc-500 italic text-[0.82em]';
      case 'footnote':
        return 'ml-[2px] text-[0.86em] leading-none text-[#00f3ff] not-italic';
      case 'referenceMarker':
        return 'ml-[2px] text-[0.86em] leading-none text-zinc-400 not-italic';
      default:
        return '';
    }
  };

  const renderTextLeaf = (
    text: string,
    key: string,
    format: InlineFormat,
    inked: boolean,
    href?: string,
    onFootnoteClick?: (marker: string, event: React.MouseEvent<HTMLElement>, href?: string) => void,
    playbackActive = false,
    marker?: string
  ) => {
    if (format === 'lineBreak') return <br key={key} />;
    const className = [
      inlineFormatClassFor(format),
      inked ? 'transition-colors text-zinc-300' : '',
    ].filter(Boolean).join(' ');
    const style = {
      ...(inked ? inkLineStyle(settings.inkLine || 'full', INK_LINE_COLORS[settings.highlightColor]) : {}),
      ...(playbackActive && format !== 'footnote' ? {
        color: HIGHLIGHT_TEXT_COLORS[settings.highlightColor],
      } : {}),
    } as React.CSSProperties;
    const leafStyle = Object.keys(style).length > 0 ? style : undefined;

    if (!['footnote', 'referenceMarker', 'link', 'attributionFootnote'].includes(format)) {
      const internalLinkPattern = /\[\s*([^\]\n]{1,80}?)\s*\]\s*\(([^)\n]+#[^)\n]+)\)/giu;
      const parts: React.ReactNode[] = [];
      let cursor = 0;
      let linkMatch: RegExpExecArray | null;
      while ((linkMatch = internalLinkPattern.exec(text)) !== null) {
        const before = text.slice(cursor, linkMatch.index);
        if (before) {
          parts.push(
            <span key={`${key}-safe-${parts.length}`} data-inked-selection={inked ? 'true' : undefined} className={className} style={leafStyle}>
              {before}
            </span>
          );
        }
        const label = cleanNoteMarkerLabel(linkMatch[1]);
        const hrefValue = linkMatch[2].trim();
        if (isRomanNoteMarkerText(label)) {
          parts.push(renderTextLeaf(label, `${key}-safe-${parts.length}`, 'referenceMarker', false, hrefValue, onFootnoteClick, playbackActive));
        } else if (isNumericNoteMarkerText(label)) {
          parts.push(renderTextLeaf(label, `${key}-safe-${parts.length}`, 'footnote', false, hrefValue, onFootnoteClick, playbackActive));
        } else {
          parts.push(
            <span key={`${key}-safe-${parts.length}`} className={className} style={leafStyle}>
              {linkMatch[1].replace(/\s+/g, ' ').trim()}
            </span>
          );
        }
        cursor = internalLinkPattern.lastIndex;
      }
      if (parts.length > 0) {
        const rest = text.slice(cursor);
        if (rest) {
          parts.push(
            <span key={`${key}-safe-${parts.length}`} data-inked-selection={inked ? 'true' : undefined} className={className} style={leafStyle}>
              {rest}
            </span>
          );
        }
        return <React.Fragment key={key}>{parts}</React.Fragment>;
      }
    }

    if (format === 'attributionFootnote') {
      return (
        <span key={key} className={className} style={leafStyle}>
          {text}
          {marker ? (
            <sub data-footnote-marker="true" className="align-sub leading-none select-none">
              {onFootnoteClick ? (
                <button
                  type="button"
                  className="ml-[2px] text-[0.86em] leading-none text-[#00f3ff] not-italic hover:text-white focus:outline-none focus:text-white"
                  title={`Go to note ${marker}`}
                  draggable={false}
                  onClick={(event) => onFootnoteClick(marker, event, href)}
                >
                  {marker}
                </button>
              ) : (
                <span className="ml-[2px] text-[0.86em] leading-none text-[#00f3ff] not-italic">{marker}</span>
              )}
            </sub>
          ) : null}
        </span>
      );
    }

    if (format === 'footnote') {
      if (onFootnoteClick) {
        return (
          <sub key={key} data-footnote-marker="true" className="align-sub leading-none select-none">
            <button
              type="button"
              className={`${className} select-none cursor-pointer hover:text-white focus:outline-none focus:text-white`}
              title={`Go to note ${text}`}
              draggable={false}
              onClick={(event) => onFootnoteClick(text, event, href)}
            >
              {text}
            </button>
          </sub>
        );
      }
      return (
        <sub key={key} data-footnote-marker="true" className={`align-sub select-none ${className}`}>
          {text}
        </sub>
      );
    }

    if (format === 'referenceMarker') {
      // Roman reference markers are non-interactive by design — they label the note,
      // they don't navigate. Render plain superscript text with no button/href.
      return (
        <sup key={key} data-reference-marker="true" className={`align-super select-none ${className}`}>
          {text}
        </sup>
      );
    }

    if (format === 'link' && href) {
      const isActiveNoteBacklink =
        activeNoteTarget &&
        isNotesChapter &&
        sentenceStartsWithNoteMarker(text, activeNoteTarget.marker, activeNoteTarget.noteKey);
      if (isActiveNoteBacklink) {
        return (
          <sup key={key} className="align-super leading-none">
            <button
              type="button"
              className="ml-[2px] text-[0.86em] leading-none text-[#00f3ff] not-italic hover:text-white focus:outline-none focus:text-white"
              title="Back to footnote"
              onClick={handleNoteBackNavigation}
            >
              {stripInlineFormatSyntax(text)}
            </button>
          </sup>
        );
      }
      const crossRefPage = href.match(/^#pdfref-p(\d+)$/iu);
      if (crossRefPage) {
        const destPage = Number(crossRefPage[1]);
        return (
          <button
            key={key}
            type="button"
            className={`${className} cursor-pointer hover:text-white focus:outline-none focus:text-white`}
            style={leafStyle}
            title="Go to referenced section"
            draggable={false}
            onClick={(event) => handleCrossReferenceNavigation(destPage, event)}
          >
            {text}
          </button>
        );
      }
      if (isInternalEbookHref(href)) {
        return (
          <span
            key={key}
            className="text-zinc-300"
            style={leafStyle}
            title="Internal ebook link is handled inside the reader"
          >
            {text}
          </span>
        );
      }
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer"
          className={className}
          style={leafStyle}
          onClick={(event) => event.stopPropagation()}
        >
          {renderUrlWithBreaks(text, key)}
        </a>
      );
    }

    return (
      <span key={key} data-inked-selection={inked ? 'true' : undefined} className={className} style={leafStyle}>
        {text}
      </span>
    );
  };

  const renderInkableText = (
    text: string,
    globalIndex: number,
    playbackActive = false,
    inheritedFootnotes: FootnoteRef[] = [],
    leadingNoteRef?: LeadingNoteRef | null,
    inlineOptions: InlineParseOptions = {}
  ) => {
    const shouldStripInheritedMarkerText =
      inheritedFootnotes.length > 0 &&
      inlineOptions.internalNoteLinksAsFootnotes === false &&
      inlineOptions.inferBareFootnotes === false;
    const displayText = shouldStripInheritedMarkerText
      ? stripInheritedFootnoteMarkerText(text, inheritedFootnotes)
      : text;
    const hasNotesLeadingMarker = Boolean(leadingNoteRef && isNotesChapter);
    const textWithInheritedLeadingMarker =
      leadingNoteRef && isNotesChapter && sentenceStartsWithNoteMarker(displayText, leadingNoteRef.marker)
        ? displayText
        : leadingNoteRef && isNotesChapter
          ? `${leadingNoteRef.marker}. ${displayText}`
          : displayText;
    const inheritedLeadingMarker = leadingNoteRef && isNotesChapter
      ? splitLeadingNoteMarker(textWithInheritedLeadingMarker, leadingNoteRef.marker)
      : null;
    const activeLeadingMatches =
      activeNoteTarget &&
      leadingNoteRef &&
      isNotesChapter &&
      activeNoteTarget.marker === leadingNoteRef.marker &&
      (!activeNoteTarget.noteKey || !leadingNoteRef.noteKey || activeNoteTarget.noteKey === leadingNoteRef.noteKey);
    const backLink =
      activeNoteTarget && sentenceStartsWithNoteMarker(textWithInheritedLeadingMarker, activeNoteTarget.marker, activeNoteTarget.noteKey)
        ? splitLeadingNoteMarker(textWithInheritedLeadingMarker, activeNoteTarget.marker, activeNoteTarget.noteKey)
        : activeLeadingMatches
          ? inheritedLeadingMarker
          : null;
    const textToRender = backLink
      ? backLink.rest
      : hasNotesLeadingMarker
        ? textWithInheritedLeadingMarker
        : text;
    const parseOptions = {
      internalNoteLinksAsFootnotes: !isNotesChapter && !isIndexChapter,
      inferBareFootnotes: !isIndexChapter,
      romanMarkersAsReferences: !isNotesChapter && !isIndexChapter,
      ...inlineOptions,
    };
    const segments = parseInlineFormatting(textToRender, {
      internalNoteLinksAsFootnotes: parseOptions.internalNoteLinksAsFootnotes,
      inferBareFootnotes: parseOptions.inferBareFootnotes,
      romanMarkersAsReferences: parseOptions.romanMarkersAsReferences,
    });
    // If this line is an attribution (e.g. translated author/source) and its footnote
    // was stripped from the translation, attach the inherited footnote inside the
    // attribution block so it sits at the end of the right-aligned author line — not
    // dumped on a new line after it.
    let consumedInheritedFootnote: FootnoteRef | undefined;
    if (inheritedFootnotes.length > 0) {
      const attributionSegment = [...segments].reverse().find(segment => segment.format === 'attribution');
      if (attributionSegment) {
        consumedInheritedFootnote = inheritedFootnotes[0];
        attributionSegment.format = 'attributionFootnote';
        attributionSegment.marker = consumedInheritedFootnote.marker;
        attributionSegment.href = consumedInheritedFootnote.href;
      }
    }
    const visibleText = segments
      .filter(segment => segment.format !== 'footnote' && segment.format !== 'lineBreak')
      .map(segment => segment.text)
      .join('');
    const inkRanges = inkRangesForText(visibleText, globalIndex);
    let visibleCursor = 0;
    const nodes: React.ReactNode[] = [];
    const footnoteClickHandler = !isNotesChapter
      ? (marker: string, event: React.MouseEvent<HTMLElement>, href?: string) => handleFootnoteNavigation(marker, globalIndex, event, href)
      : undefined;

    if (backLink) {
      nodes.push(
        <sup key="note-back-link" className="mr-1 align-super leading-none">
          <button
            type="button"
            className="text-[0.86em] leading-none text-[#00f3ff] hover:text-white focus:outline-none focus:text-white"
            title="Back to footnote"
            onClick={handleNoteBackNavigation}
          >
            {backLink.label}
          </button>
        </sup>
      );
    }

    segments.forEach((segment, segmentIndex) => {
      if (segment.format === 'footnote' || segment.format === 'lineBreak') {
        nodes.push(renderTextLeaf(segment.text, `${segmentIndex}-plain`, segment.format, false, segment.href, footnoteClickHandler, playbackActive, segment.marker));
        return;
      }
      if (segment.format === 'attributionFootnote') {
        nodes.push(renderTextLeaf(segment.text, `${segmentIndex}-plain`, segment.format, false, segment.href, footnoteClickHandler, playbackActive, segment.marker));
        visibleCursor += segment.text.length;
        return;
      }

      let localCursor = 0;
      const segmentStart = visibleCursor;
      const segmentEnd = segmentStart + segment.text.length;
      const relevantRanges = inkRanges.filter(range => range.start < segmentEnd && range.end > segmentStart);

      if (relevantRanges.length === 0) {
        nodes.push(renderTextLeaf(segment.text, `${segmentIndex}-plain`, segment.format, false, segment.href, footnoteClickHandler, playbackActive, segment.marker));
      } else {
        relevantRanges.forEach((range, rangeIndex) => {
          const localStart = Math.max(0, range.start - segmentStart);
          const localEnd = Math.min(segment.text.length, range.end - segmentStart);
          if (localStart > localCursor) {
            nodes.push(renderTextLeaf(segment.text.slice(localCursor, localStart), `${segmentIndex}-${rangeIndex}-pre`, segment.format, false, segment.href, footnoteClickHandler, playbackActive, segment.marker));
          }
          if (localEnd > localStart) {
            nodes.push(renderTextLeaf(segment.text.slice(localStart, localEnd), `${segmentIndex}-${rangeIndex}-ink`, segment.format, true, segment.href, footnoteClickHandler, playbackActive, segment.marker));
          }
          localCursor = Math.max(localCursor, localEnd);
        });
        if (localCursor < segment.text.length) {
          nodes.push(renderTextLeaf(segment.text.slice(localCursor), `${segmentIndex}-post`, segment.format, false, segment.href, footnoteClickHandler, playbackActive, segment.marker));
        }
      }
      visibleCursor = segmentEnd;
    });

    const inheritedToRender = inheritedFootnotes
      .filter(ref => ref !== consumedInheritedFootnote && !hasFootnoteRef(textToRender, ref, parseOptions));
    // A leading reference marker labels a note-definition line ("I. Nomenklaturas…").
    // Render it BEFORE the translated content so it mirrors the original's layout —
    // unless the notes-chapter leading-marker logic already prepended one.
    const leadingInherited = hasNotesLeadingMarker ? [] : inheritedToRender.filter(ref => ref.isReference && ref.isLeading);
    leadingInherited.forEach((ref, refIndex) => {
      nodes.unshift(
        <React.Fragment key={`inherited-leading-sp-${ref.marker}-${refIndex}`}>{' '}</React.Fragment>
      );
      nodes.unshift(renderTextLeaf(ref.displayText || ref.marker, `inherited-leading-${ref.marker}-${refIndex}`, 'referenceMarker', false, ref.href, footnoteClickHandler, playbackActive));
    });
    inheritedToRender
      .filter(ref => !leadingInherited.includes(ref))
      .forEach((ref, refIndex) => {
        // Roman reference markers render as a superscript (referenceMarker) to match
        // the original; numeric footnotes as a subscript (footnote).
        const inheritedFormat = ref.isReference ? 'referenceMarker' : 'footnote';
        nodes.push(renderTextLeaf(ref.marker, `inherited-footnote-${ref.marker}-${refIndex}`, inheritedFormat, false, ref.href, footnoteClickHandler, playbackActive));
      });

    return nodes;
  };

  const buildStructuredRuns = (text: string): SentenceRun[] => {
    const split = splitIntoSentences(text);
    const sentences = split.length ? split : (text.trim() ? [text.trim()] : []);
    return sentences.map(sentence => {
      const normalized = normalizeSentenceForMatch(sentence);
      let foundIndex = -1;
      for (let i = structuredSentenceCursor; i < flatSentenceMap.length; i++) {
        if (normalizeSentenceForMatch(flatSentenceMap[i].text) === normalized) {
          foundIndex = i;
          break;
        }
      }
      if (foundIndex === -1 && structuredSentenceCursor < flatSentenceMap.length) {
        foundIndex = structuredSentenceCursor;
      }
      if (foundIndex !== -1) structuredSentenceCursor = foundIndex + 1;
      return {
        text: sentence,
        globalIndex: foundIndex !== -1 ? flatSentenceMap[foundIndex].globalIndex : -1,
      };
    });
  };

  const renderOriginalRuns = (runs: SentenceRun[], className = '') => runs.map((run, idx) => {
    const isAudioActive = autoScroll && run.globalIndex === activeSentenceIndex;
    return (
      <span
        key={`o-${currentTranslationIdentity}-${run.globalIndex}-${idx}-${run.text.slice(0, 8)}`}
        id={run.globalIndex >= 0 ? `original-sent-${run.globalIndex}` : undefined}
        data-source="Original_Layer"
        data-sentence-index={run.globalIndex}
        className={`transition-all duration-300 px-[2px] ${className} ${isAudioActive ? HIGHLIGHT_STYLES[settings.highlightColor] : sentenceHoverClass}`}
        onPointerDown={handleSentencePointerDown}
        onClick={(event) => handleSentenceClick(run.globalIndex, event)}
      >
        {renderInkableText(run.text, run.globalIndex, isAudioActive)}{' '}
      </span>
    );
  });

  const renderTranslatedRuns = (runs: SentenceRun[]) => {
    const hasTranslation = runs.some(run => translationByIndex.has(run.globalIndex));
    if (isTranslating && !hasTranslation) {
      return <span className="animate-pulse text-[10px] font-mono text-zinc-700 uppercase">Decrypting_Matrix...</span>;
    }
    if (translationError && !hasTranslation) {
      return <span className="text-[10px] font-mono text-[#ff003c]/80 uppercase">{translationError}</span>;
    }
    return runs.map((run, idx) => {
      const isActive = autoScroll && run.globalIndex === activeSentenceIndex;
      const translatedText = translationByIndex.get(run.globalIndex) || '';
      const translatedSentences = splitIntoSentences(translatedText);
      const translatedParts = translatedSentences.length
        ? translatedSentences
        : (translatedText.trim() ? [translatedText] : ['']);
      const positionedRefs = isIndexChapter ? [] : positionedFootnoteRefsForText(run.text);
      const leadingNoteRef = isNotesChapter ? leadingNoteRefForText(run.text) : null;
      // Match the original's italic/bold so the translation reads as the same quote.
      const emphasisWrapper = wholeSentenceEmphasisWrapper(run.text);
      const refsForTranslatedPart = (partIndex: number): FootnoteRef[] =>
        positionedRefs.filter(ref =>
          Math.min(ref.sentenceIndex, translatedParts.length - 1) === partIndex
        );
      return (
        <span
          key={`t-${currentTranslationIdentity}-${run.globalIndex}-${idx}-${run.text.slice(0, 8)}`}
          data-source="Translated_Layer"
          data-sentence-index={run.globalIndex}
          className={`transition-all duration-300 px-[2px] ${isActive ? HIGHLIGHT_STYLES[settings.highlightColor] : sentenceHoverClass}`}
          onPointerDown={handleSentencePointerDown}
          onClick={(event) => handleSentenceClick(run.globalIndex, event)}
        >
          {translatedParts.map((part, partIndex) => (
            <React.Fragment key={`tp-${partIndex}`}>
              {renderInkableText(
                emphasisWrapper && part.trim() ? `${emphasisWrapper}${part}${emphasisWrapper}` : part,
                run.globalIndex,
                isActive,
                refsForTranslatedPart(partIndex),
                partIndex === 0 ? leadingNoteRef : null,
                { internalNoteLinksAsFootnotes: false, inferBareFootnotes: false, romanMarkersAsReferences: false }
              )}
              {partIndex < translatedParts.length - 1 ? ' ' : ''}
            </React.Fragment>
          ))}{' '}
        </span>
      );
    });
  };

  const renderStructuredTextParagraphs = (text: string, tone: 'body' | 'muted' = 'body') => {
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    return paragraphs.map((paragraph, idx) => {
      const lines = paragraph.split('\n').map(line => line.trim()).filter(Boolean);
      return (
        <div key={`${currentTranslationIdentity}-structured-p-${idx}`} className="w-full space-y-0">
          {lines.map((line, lineIdx) => {
            const runs = buildStructuredRuns(line);
            const spacingClass = paragraphSpacingClassFor(line);
            return (
              <div key={`${currentTranslationIdentity}-structured-p-${idx}-line-${lineIdx}`} className={`w-full ${spacingClass} ${viewMode === 'split' ? 'flex items-start' : ''}`}>
                <p
                  className={`${viewMode === 'split' ? 'w-1/2 pr-2 md:pr-6 border-r border-zinc-800/20' : 'w-full p-0'} ${readerTextClass} text-zinc-300 font-medium text-left m-0 break-words min-w-0`}
                  style={structuredParagraphStyleFor(line)}
                >
                  {renderOriginalRuns(runs)}
                </p>
                {viewMode === 'split' && (
                  <p className={`w-1/2 pl-2 md:pl-6 ${readerTextClass} text-zinc-300 font-medium text-left m-0`} style={structuredParagraphStyleFor(line)}>
                    {renderTranslatedRuns(runs)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      );
    });
  };

  const renderStructuredSection = (
    label: string,
    text: string,
    tone: 'principle' | 'interpretation'
  ) => {
    const labelRuns = buildStructuredRuns(label);

    return (
      <section className="space-y-1.5">
        <p className={`${readerTextClass} font-bold text-zinc-100 text-left m-0 p-0`} style={noIndentStyle}>
          {renderOriginalRuns(labelRuns)}
        </p>
        <div className="space-y-0">
          {renderStructuredTextParagraphs(text)}
        </div>
      </section>
    );
  };

  const renderTopicBlock = (block: ReaderTopicBlock, index: number) => {
    const displayHeading = block.headingText.includes('\n')
      ? `${block.number}. ${block.title}`
      : block.headingText;
    const titleRuns = buildStructuredRuns(displayHeading);
    return (
      <article key={`${currentTranslationIdentity}-topic-${block.number}-${index}`} className="space-y-3">
        <header className={`w-full ${viewMode === 'split' ? 'flex items-start' : 'space-y-1'}`}>
          <h4
            className={`${viewMode === 'split' ? 'w-1/2 pr-2 md:pr-6 border-r border-zinc-800/20' : 'w-full p-0'} ${readerTextClass} text-zinc-100 font-bold text-left m-0 break-words min-w-0`}
            style={viewMode === 'split' ? noTextIndentStyle : noIndentStyle}
          >
            {renderOriginalRuns(titleRuns, 'text-zinc-100')}
          </h4>
          {viewMode === 'split' && (
            <div className={`w-1/2 pl-2 md:pl-6 ${readerTextClass} text-zinc-300 font-medium text-left m-0`} style={noTextIndentStyle}>
              {renderTranslatedRuns(titleRuns)}
            </div>
          )}
        </header>
        <div className="space-y-3">
          {renderStructuredSection(block.principleLabel, block.principle, 'principle')}
          {renderStructuredSection(block.interpretationLabel, block.interpretation, 'interpretation')}
        </div>
      </article>
    );
  };

  const renderStructuredBlock = (block: ReaderBlock, index: number) => {
    if (block.type === 'principle-topic') return renderTopicBlock(block, index);
    return (
      <div key={`${currentTranslationIdentity}-paragraph-${index}`} className="space-y-3">
        {renderStructuredTextParagraphs(block.text, 'muted')}
      </div>
    );
  };

  const renderStructuredPage = (page: ReaderPage) => {
    structuredSentenceCursor = 0;
    return (
      <div className={`w-full flex ${viewMode === 'split' ? '' : 'justify-center'}`}>
        <div className={`${viewMode === 'split' ? 'w-full' : 'w-full max-w-3xl'} space-y-4 md:space-y-6 text-left`} style={noIndentStyle}>
          {page.blocks.map(renderStructuredBlock)}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col gap-4 animate-fade-in relative font-sans text-zinc-100 text-left overflow-hidden">
      <audio 
        ref={audioRef} 
        src={audioSrc || undefined} 
        onEnded={() => setIsPlaying(false)} 
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={() => {
          if (!audioRef.current) return;
          const d = audioRef.current.duration || 0;
          setDuration(d);
          // Restore the saved playback position so progress isn't lost when returning
          // to this audio after leaving the module (e.g. via a footnote).
          const saved = loadedAudioKeyRef.current ? audioPlaybackPositions.get(loadedAudioKeyRef.current) : undefined;
          if (saved !== undefined && saved > 0.1 && saved < d - 0.1) {
            audioRef.current.currentTime = saved;
            setCurrentTime(saved);
            setPlaybackProgress(d > 0 ? (saved / d) * 100 : 0);
          }
        }}
        onPlay={() => { if(audioRef.current) audioRef.current.playbackRate = playbackRate; }}
        className="hidden" 
      />

      {/* Controller Toolbar */}
      <div className="bg-zinc-950/80 p-2 md:p-3 rounded-lg border border-cyan-900/40 flex items-center justify-between shrink-0 shadow-[0_0_15px_rgba(0,243,255,0.05)] w-full flex-wrap gap-2 z-20">
          <div className="hidden md:flex items-center gap-4">
              <div className="flex items-center gap-2 text-white font-bold tracking-widest uppercase font-mono text-xs">
                 <Headphones size={18} className="text-[#00f3ff]" />
                 <span>Voice_Synth</span>
              </div>
          </div>
          <div className="flex items-center gap-2 md:gap-4 flex-1 md:flex-none justify-between md:justify-end">
              <div className="flex items-center gap-1 md:gap-2 bg-black/50 p-1 rounded-sm border border-zinc-800">
                 <div className="p-1 md:p-1.5 text-zinc-500"><Settings2 size={14} /></div>
                 <select value={selectedVoice} onChange={(e) => { setSelectedVoice(e.target.value); lastAudioVoice = e.target.value; resetAudioState(); }} className="bg-transparent text-[10px] md:text-xs text-[#00f3ff] outline-none cursor-pointer font-mono uppercase w-[80px] md:w-[120px] bg-[#050505]">
                    {VOICES.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
                 </select>
                 <div className="w-[1px] h-4 bg-zinc-700"></div>
                 <div className="p-1 md:p-1.5 text-zinc-500"><Globe size={14} /></div>
                 <select value={audioLanguage} onChange={(e) => { setAudioLanguage(e.target.value); lastAudioLanguage = e.target.value; writeStoredValue('audiobook_audio_language', e.target.value); resetAudioState(); }} className="bg-transparent text-[10px] md:text-xs text-[#00f3ff] outline-none font-mono uppercase w-[80px] md:w-[120px] bg-[#050505] cursor-pointer">
                    {LANGUAGES.map(lang => <option key={lang} value={lang}>{lang}</option>)}
                 </select>
              </div>
              <button
                onClick={handleInitiateToggle}
                className={`flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-1.5 rounded-sm text-[10px] md:text-xs font-bold font-mono uppercase transition-all shadow-[0_0_10px_rgba(0,243,255,0.3)] justify-center ${isGenerating ? 'bg-[#ff003c] text-white hover:bg-rose-600' : 'bg-[#00f3ff] text-black hover:bg-[#00c2cc]'}`}
              >
                 {isGenerating ? <Square size={14} fill="currentColor" /> : hasInitiated ? <RefreshCw size={14} /> : <Play size={14} fill="currentColor" />}
                 {isGenerating ? "STOP" : hasInitiated ? "REGENERATE" : "INITIATE"}
              </button>
          </div>
      </div>

      {/* Advanced Visualizer Module */}
      <div className={`bg-[#0a0a0c] border border-zinc-800 rounded-lg p-0 relative overflow-hidden shrink-0 flex flex-col shadow-2xl transition-all duration-300 ease-in-out ${isModuleMinimized ? 'h-auto' : 'h-[277px]'}`}>
          {!isModuleMinimized && (
              <div className="flex-1 bg-[#010102] w-full flex items-center justify-center overflow-hidden relative group border-b border-zinc-900">
                 <div className="absolute inset-0 bg-[linear-gradient(rgba(0,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(0,255,255,0.02)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none"></div>
                 {isGenerating ? (
                    <div className="z-20 scale-75 animate-fade-in"><Loader text={generationProgress} /></div>
                 ) : audioSrc ? (
                    <>
                        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none animate-fade-in">
                            <div className="relative max-w-[90%] px-8 py-4 overflow-hidden">
                                <span className="content-font font-black text-[#ff003c] uppercase drop-shadow-[0_0_12px_rgba(255,0,60,0.8)] italic flex items-center gap-4 justify-center text-center leading-tight whitespace-nowrap" style={{ fontSize: 'clamp(10px, 2.5vw, 16px)', letterSpacing: '0.2em' }}>
                                    <div className="w-3 h-3 rounded-full bg-[#ff003c] shadow-[0_0_10px_#ff003c] animate-pulse shrink-0"></div>
                                    {chapter.title} — PG.{String(currentPage + 1).padStart(2,'0')}
                                </span>
                            </div>
                        </div>
                        <canvas ref={canvasRef} width={1800} height={250} className="w-full h-full opacity-100" />
                    </>
                 ) : (
                    <div className="flex flex-col items-center gap-2 text-zinc-700 font-mono text-xs">
                        <Activity size={32} className="opacity-20" />
                        <span>AWAITING_HOLOGRAPHIC_DATA</span>
                    </div>
                 )}
                 <div className="absolute bottom-0 left-0 w-full h-1 bg-zinc-900 z-30 group cursor-pointer">
                    <input type="range" min="0" max="100" step="0.01" value={playbackProgress} onChange={handleSeek} disabled={!audioSrc} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-40" />
                    <div className="h-full bg-[#00f3ff] relative transition-none shadow-[0_0_10px_#00f3ff]" style={{ width: `${playbackProgress}%` }} />
                 </div>
              </div>
          )}

          <div className="bg-[#020202] p-2 md:p-3 flex items-center gap-1 overflow-hidden min-w-0">
              <div className="flex-1 flex items-center gap-1 min-w-0">
                  <select value={playbackRate} onChange={(e) => setPlaybackRate(Number(e.target.value))} className="md:hidden bg-[#050505] text-[10px] text-[#00f3ff] font-mono uppercase outline-none border border-zinc-800 rounded-sm px-1.5 py-1 w-[56px] shrink-0">{RATES.map(s => <option key={s} value={s}>{s.toFixed(2)}x</option>)}</select>
                  <span className="md:hidden text-[8px] font-mono text-zinc-600 shrink-0">{formatTime(currentTime)}/{formatTime(duration)}</span>
                  <div className="hidden md:flex items-center gap-3 text-[10px] font-mono uppercase overflow-hidden">
                       {RATES.map(s => (
                         <button key={s} onClick={() => setPlaybackRate(s)} className={`transition-colors font-mono ${playbackRate === s ? 'text-[#00f3ff] font-bold underline underline-offset-4' : 'text-zinc-600 hover:text-zinc-400'}`}>{s.toFixed(2)}x</button>
                       ))}
                  </div>
              </div>
              <div className="flex items-center justify-center gap-2 md:gap-6 shrink-0">
                  <button onClick={() => { if(audioRef.current) audioRef.current.currentTime -= 15; }} disabled={!audioSrc} className="p-1 md:p-2 text-zinc-500 hover:text-cyan-400 transition-colors hover:bg-zinc-900 rounded-full disabled:opacity-30"><RotateCcw size={16} /></button>
                  <button onClick={togglePlay} disabled={!audioSrc} className={`w-9 h-9 md:w-10 md:h-10 rounded-full flex items-center justify-center border-2 shrink-0 ${isPlaying ? 'bg-transparent border-[#00f3ff] text-[#00f3ff] shadow-[0_0_15px_rgba(0,243,255,0.3)]' : 'bg-[#00f3ff] border-[#00f3ff] text-black shadow-[0_0_20px_rgba(0,243,255,0.6)] hover:scale-105'}`}>
                    {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
                  </button>
                  <button onClick={() => { if(audioRef.current) audioRef.current.currentTime += 15; }} disabled={!audioSrc} className="p-1 md:p-2 text-zinc-500 hover:text-cyan-400 transition-colors hover:bg-zinc-900 rounded-full disabled:opacity-30"><RotateCw size={16} /></button>
              </div>
              <div className="flex-1 flex items-center justify-end gap-0.5 md:gap-2 min-w-0">
                  <span className="hidden md:inline text-[10px] font-mono text-zinc-600 shrink-0">{formatTime(currentTime)}/{formatTime(duration)}</span>
                  <a href={audioSrc || '#'} download={`voice-ch${chapter.id}-pg${currentPage + 1}-${titleCase(chapter.title)}.wav`} className={`p-1 md:p-2 text-zinc-600 transition-colors rounded-full shrink-0 ${audioSrc ? 'hover:text-[#00f3ff] hover:bg-zinc-900' : 'opacity-30'}`} onClick={(e) => !audioSrc && e.preventDefault()}><Download size={16} /></a>
                  <button onClick={async () => { if (!audioSrc) return; const r = await fetch(audioSrc); const b = await r.blob(); const fn = `voice-ch${chapter.id}-pg${currentPage + 1}-${titleCase(chapter.title)}.wav`; shareFile(b, fn, `${chapter.title} - Page ${currentPage + 1}`); }} disabled={!audioSrc} className={`p-1 md:p-2 text-zinc-600 transition-colors rounded-full shrink-0 ${audioSrc ? 'hover:text-[#00f3ff] hover:bg-zinc-900' : 'opacity-30'}`} title="Share"><Share2 size={16} /></button>
                  <button onClick={() => {
                    const nextMinimized = !isModuleMinimized;
                    setIsModuleMinimized(nextMinimized);
                    lastVoiceSynthMinimized = nextMinimized;
                    writeStoredValue('voice_synth_player_minimized', String(nextMinimized));
                  }} className="p-1 md:p-2 text-zinc-600 hover:text-[#00f3ff] transition-colors rounded-full bg-zinc-900/50 shrink-0">{isModuleMinimized ? <Maximize2 size={16} /> : <Minimize2 size={16} />}</button>
              </div>
          </div>
      </div>

      {isLoadingText ? (
        <div className="flex-1 flex items-center justify-center min-h-[200px]">
           <Loader text="DECODING_TEXT_BLOCK..." />
        </div>
      ) : sourceError ? (
        <div className="flex-1 flex items-center justify-center min-h-[220px] rounded-sm border border-[#ff003c]/30 bg-[#050505] text-center px-6">
          <div className="max-w-md space-y-3">
            <div className="text-[#ff003c] text-xs font-mono uppercase tracking-[0.25em]">SOURCE_REQUIRED</div>
            <p className="text-zinc-400 text-sm leading-relaxed content-font">{sourceError}</p>
            <p className="text-zinc-600 text-[10px] font-mono uppercase tracking-widest">
              Cached metadata cannot reproduce original chapters.
            </p>
          </div>
        </div>
      ) : (
        <>
           {/* Reader Mode Controls */}
           <div className="flex shrink-0 border border-zinc-800 bg-[#0a0a0c]/90 backdrop-blur-md rounded-sm z-10 w-full flex-col overflow-hidden">
              <div className="flex items-center justify-between p-1.5 md:p-2 gap-1">
                   <div className="flex items-center gap-1 md:gap-2">
                      <button onClick={() => changePage(false)} disabled={!canGoPrevious} className="flex items-center justify-center w-8 md:w-10 py-1 md:py-1.5 rounded-sm bg-zinc-900 border border-zinc-800 hover:border-[#00f3ff] text-zinc-400 disabled:opacity-30 transition-all"><ChevronLeft size={14} /></button>
                      <h3 className="text-[9px] md:text-[10px] font-bold text-[#00f3ff] font-tech uppercase tracking-widest px-2 md:px-4 flex items-center gap-2">
                        <span>PG.{String(currentPage + 1).padStart(2,'0')}</span>
                        {currentReaderPage?.label && <span className="hidden sm:inline text-zinc-600">{currentReaderPage.label}</span>}
                      </h3>
                      <button onClick={() => changePage(true)} disabled={!canGoNext} className="flex items-center justify-center w-8 md:w-10 py-1 md:py-1.5 rounded-sm bg-zinc-900 border border-zinc-800 hover:border-[#00f3ff] text-zinc-400 disabled:opacity-30 transition-all"><ChevronRight size={14} /></button>
                  </div>
                  <div className="flex items-center gap-1 md:gap-2">
                      <button onClick={() => {
                        const nextMode = viewMode === 'split' ? 'single' : 'split';
                        setViewMode(nextMode);
                        lastViewMode = nextMode;
                        writeStoredValue('audiobook_view_mode', nextMode);
                      }} className={`flex items-center gap-1 md:gap-2 px-2 md:px-4 py-1 md:py-1.5 rounded-sm text-[9px] md:text-[10px] font-bold font-mono uppercase transition-all justify-center ${viewMode === 'split' ? 'text-[#00f3ff] bg-[#00f3ff]/5' : 'text-zinc-500 hover:text-zinc-300'}`}><Columns size={12} /> <span className="hidden sm:inline">SPLIT</span></button>
                      <button onClick={() => {
                        const nextAutoScroll = !autoScroll;
                        setAutoScroll(nextAutoScroll);
                        lastAutoScroll = nextAutoScroll;
                        writeStoredValue('audiobook_auto_scroll', String(nextAutoScroll));
                      }} className={`flex items-center gap-1 md:gap-2 px-2 md:px-4 py-1 md:py-1.5 rounded-sm text-[9px] md:text-[10px] font-bold font-mono uppercase transition-all justify-center ${autoScroll ? 'text-[#00f3ff] bg-[#00f3ff]/5' : 'text-zinc-500 hover:text-zinc-300'}`}><Eye size={12} /> <span className="hidden sm:inline">SYNC</span></button>
                   </div>
              </div>
          </div>

          <div className="flex-1 overflow-hidden rounded-sm border border-zinc-800 bg-[#050505] relative flex flex-col hud-border text-left">
             <div ref={readerScrollRef} className="flex-1 overflow-y-auto custom-scrollbar p-3 md:p-6 space-y-0 pb-32 content-font">
                {isStructuredPage && currentReaderPage ? renderStructuredPage(currentReaderPage) : paragraphData.map((para, pIdx) => {
                  // An extracted PDF figure — inline image loaded from the cache.
                  if (para.figure) {
                    return <PdfFigureBlock key={`fig-${pIdx}`} figId={para.figure.id} bookId={bookId} meta={fileContext.pdfFigures?.find(f => f.id === para.figure!.id)} split={viewMode === 'split'} targetLang={settings.targetLanguage} />;
                  }
                  // A side-by-side two-column region. Original columns render side by side; in split
                  // view the TRANSLATED columns render in the right half (original-L | original-R ||
                  // translated-L | translated-R). Sentences carry a global index so they highlight
                  // and translate like any other.
                  if (para.columns) {
                    const colClass = `${TEXT_SIZES[settings.textSize]} ${LINE_HEIGHTS[settings.lineHeight]} ${LETTER_SPACINGS[settings.letterSpacing]} text-zinc-300 font-medium break-words min-w-0`;
                    const renderCol = (col: ColumnPara[], translated: boolean) => (
                      <div className="flex-1 min-w-0 space-y-2">
                        {col.map((cp, i) => (
                          <div key={i} className={colClass}>
                            {cp.sentences.map(({ text, gi }) => {
                              const active = autoScroll && gi === activeSentenceIndex;
                              if (translated) return <span key={gi} className={`px-[2px] ${active ? HIGHLIGHT_STYLES[settings.highlightColor] : ''}`}>{translationByIndex.get(gi) || ''}{' '}</span>;
                              return (
                                <span key={gi} id={`original-sent-${gi}`} data-sentence-index={gi} onClick={(e) => handleSentenceClick(gi, e)} className={`transition-all duration-300 px-[2px] ${active ? HIGHLIGHT_STYLES[settings.highlightColor] : sentenceHoverClass}`}>{renderInkableText(text, gi, active)}{' '}</span>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    );
                    const twoCols = (translated: boolean) => (
                      <div className="flex flex-col sm:flex-row gap-3 sm:gap-5">{renderCol(para.columns!.left, translated)}{renderCol(para.columns!.right, translated)}</div>
                    );
                    if (viewMode === 'split') {
                      return (
                        <div key={`cols-${pIdx}`} className="w-full flex items-start my-2">
                          <div className="w-1/2 pr-2 md:pr-6 border-r border-zinc-800/20 min-w-0">{twoCols(false)}</div>
                          <div className="w-1/2 pl-2 md:pl-6 min-w-0">{twoCols(true)}</div>
                        </div>
                      );
                    }
                    return (
                      <div key={`cols-${pIdx}`} className="w-full max-w-3xl mx-auto my-2">{twoCols(false)}</div>
                    );
                  }
                  const lineRuns = paragraphLineRunsFor(pIdx, para.original);
                  // Trust the geometry-decided block role (carried from extraction as
                  // para.role) BEFORE any prose heuristic: a 'list' block — a table of
                  // contents, an "also by" list — renders uniformly (body weight, no
                  // first-line indent), instead of letting isPlainSubtitleParagraph bold some
                  // of its entries as if they were section subtitles.
                  const isListRole = para.role === 'list';
                  // Trust the geometry-decided heading role (carried from extraction as U+E013):
                  // a block set in the heading font family renders as a heading (bold, no indent),
                  // regardless of whether a prose wording heuristic recognises it — this is what
                  // styles a notes-section header ("CHAPTER 7: PERIL") the wording rules miss. It is
                  // safe to bold by role because the role is now assigned by FONT FAMILY, so it
                  // covers only genuine headings — epigraphs, quotes, and attributions stay in the
                  // body family and never carry it (the v31 over-bold regression came from a
                  // size-based role that swept those in).
                  // A geometry-tagged 'heading' that is actually a long prose SENTENCE is a
                  // mis-tag — e.g. a drop-cap body paragraph whose decorative initial sits in the
                  // display/heading font family, so the extractor flags its first line as a heading
                  // and the reader merges it into the paragraph. A real heading is short and does
                  // not end in sentence punctuation; a long line ending in "." / "?" / "!" is prose,
                  // so do not render it (bold, no-indent) as a heading.
                  const headingRoleText = para.original.join(' ').replace(/\s+/g, ' ').trim();
                  const isHeadingRole = para.role === 'heading'
                    && !(headingRoleText.length > 90 && /[.!?。！？]["'”’)\]]?$/u.test(headingRoleText));
                  // The first paragraph of a page that pagination split MID-paragraph is a continuation
                  // of the previous page's last paragraph — render it flush (no first-line indent) so it
                  // doesn't read as a spurious new paragraph.
                  const isParagraphContinuation = pIdx === 0 && !!currentReaderPage?.continuesParagraph;
                  const paragraphStyle = (isListRole || isHeadingRole || isParagraphContinuation) ? noTextIndentStyle : plainParagraphStyleFor(para.original, para.align);
                  const paragraphTextClass = !isListRole && (isHeadingRole || isNotesSectionHeadingParagraph(para.original) || isPlainSubtitleParagraph(para.original))
                    ? 'text-zinc-100 font-bold'
                    : 'text-zinc-300 font-medium';
                  const hasParagraphTranslation = para.original.some((_, sIdx) => {
                    const mapping = flatSentenceMap.find(m => m.pIndex === pIdx && m.sIndex === sIdx);
                    return mapping ? translationByIndex.has(mapping.globalIndex) : false;
                  });
                  const showTranslationPlaceholder = isTranslating && !hasParagraphTranslation;
                  const showTranslationError = Boolean(translationError) && !hasParagraphTranslation;
                  // Index and table-of-contents entries carry an indent depth (4 non-breaking
                  // spaces per level, captured upstream from the PDF x-position); render it as
                  // left padding.
                  const indexIndentStyle = (isIndexChapter || isListRole) && para.indent
                    ? { paddingLeft: `${(para.indent / 4) * 1.5}em` }
                    : undefined;
                  // A display block (title page, "also by" list, dedication) keeps its
                  // original right/centre alignment, captured upstream as para.align. A display
                  // block's FIRST line can lose its alignment sentinel upstream (the chapter slice
                  // begins just after it), leaving it left-aligned while the rest of the block
                  // centres. If a short single-line body paragraph directly precedes an aligned
                  // display paragraph, inherit that alignment so the block stays coherent (e.g. a
                  // dedication's opening "To …" line above its centred epigraph).
                  const neighborAlign = paragraphData[pIdx + 1]?.align;
                  const isStrayDisplayLine = !para.role
                    && para.original.length === 1
                    && stripInlineFormatSyntax(para.original.join(' ')).replace(/\s+/g, ' ').trim().length <= 90;
                  const effectiveAlign = para.align || (neighborAlign && isStrayDisplayLine ? neighborAlign : undefined);
                  const alignStyle = effectiveAlign ? { textAlign: effectiveAlign } : undefined;
                  // Body-text alignment. 'auto' mirrors the source (justify + hyphenation when the PDF
                  // is justified, else the default left); 'justify'/'left' force it. Never applied to a
                  // heading, list, index, or an explicitly aligned display block.
                  const alignPref = settings.textAlign ?? 'auto';
                  const justifyBody = !isListRole && !isHeadingRole && !isIndexChapter && !effectiveAlign
                    && !isNotesSectionHeadingParagraph(para.original)
                    && (alignPref === 'justify' || (alignPref === 'auto' && fileContext.sourceJustified === true));
                  const justifyStyle: React.CSSProperties = justifyBody
                    ? ({ textAlign: 'justify', hyphens: 'auto', WebkitHyphens: 'auto', overflowWrap: 'break-word' } as React.CSSProperties)
                    : (alignPref === 'left' && !effectiveAlign ? { textAlign: 'left' } : {});

                  return (
                    <div key={`${currentTranslationIdentity}-plain-p-${pIdx}`} className="w-full space-y-0" style={indexIndentStyle}>
                      {lineRuns.map((line, lineIdx) => {
                        const lineText = line.map(run => run.sentence).join(' ');
                        const spacingClass = isListRole ? '' : paragraphSpacingClassFor(lineText);
                        return (
                        <div key={`${currentTranslationIdentity}-plain-p-${pIdx}-line-${lineIdx}`} className={`w-full flex ${spacingClass} ${viewMode === 'split' ? 'items-start' : isIndexChapter || (isListRole && !para.align) ? 'justify-start' : 'justify-center'}`}>
                          <div
                            lang={justifyBody ? 'en' : undefined}
                            className={`${viewMode === 'split' ? 'w-1/2 pr-2 md:pr-6 border-r border-zinc-800/20' : isIndexChapter ? 'w-full' : 'w-full max-w-3xl'} ${TEXT_SIZES[settings.textSize]} ${LINE_HEIGHTS[settings.lineHeight]} ${LETTER_SPACINGS[settings.letterSpacing]} ${paragraphTextClass} break-words min-w-0`}
                            style={{ ...paragraphStyle, ...alignStyle, ...justifyStyle }}
                          >
                            {line.map(({ sentence, sIdx, globalIndex }) => {
                              const isAudioActive = autoScroll && globalIndex === activeSentenceIndex;
                              return (
                                <span
                                  key={`o-${currentTranslationIdentity}-${globalIndex}-${pIdx}-${sIdx}`}
                                  id={globalIndex >= 0 ? `original-sent-${globalIndex}` : undefined}
	                                  data-source="Original_Layer"
	                                  data-sentence-index={globalIndex}
	                                  className={`transition-all duration-300 px-[2px] ${isAudioActive ? HIGHLIGHT_STYLES[settings.highlightColor] : sentenceHoverClass}`}
	                                  onPointerDown={handleSentencePointerDown}
	                                  onClick={(event) => handleSentenceClick(globalIndex, event)}
	                                >
                                  {renderInkableText(sentence, globalIndex, isAudioActive)}{' '}
                                </span>
                              );
                            })}
                          </div>
                          {viewMode === 'split' && (
                            <div
                              className={`w-1/2 pl-2 md:pl-6 ${TEXT_SIZES[settings.textSize]} ${LINE_HEIGHTS[settings.lineHeight]} ${LETTER_SPACINGS[settings.letterSpacing]} ${paragraphTextClass}`}
                              style={paragraphStyle}
                            >
                              {showTranslationPlaceholder && lineIdx === 0 ? (
                                <span className="animate-pulse text-[10px] font-mono text-zinc-700 uppercase">Decrypting_Matrix...</span>
                              ) : showTranslationError && lineIdx === 0 ? (
                                <span className="text-[10px] font-mono text-[#ff003c]/80 uppercase">{translationError}</span>
                              ) : !showTranslationPlaceholder && !showTranslationError ? (
                                line.map(({ sentence, sIdx, globalIndex }) => {
                                  const isActive = autoScroll && globalIndex === activeSentenceIndex;
                                  const tText = translationByIndex.get(globalIndex) || "";
                                  const translatedSentences = splitIntoSentences(tText);
                                  const translatedParts = translatedSentences.length
                                    ? translatedSentences
                                    : (tText.trim() ? [tText] : ['']);
                                  const positionedRefs = isIndexChapter ? [] : positionedFootnoteRefsForText(sentence);
                                  const leadingNoteRef = isNotesChapter ? leadingNoteRefForText(sentence) : null;
                                  // Match the original's italic/bold in the translation.
                                  const emphasisWrapper = wholeSentenceEmphasisWrapper(sentence);
                                  const refsForTranslatedPart = (partIndex: number): FootnoteRef[] =>
                                    positionedRefs.filter(ref =>
                                      Math.min(ref.sentenceIndex, translatedParts.length - 1) === partIndex
                                    );
                                  return (
                                    <span
                                      key={`t-${currentTranslationIdentity}-${globalIndex}-${pIdx}-${sIdx}`}
	                                      data-source="Translated_Layer"
	                                      data-sentence-index={globalIndex}
	                                      className={`transition-all duration-300 px-[2px] ${isActive ? HIGHLIGHT_STYLES[settings.highlightColor] : sentenceHoverClass}`}
	                                      onPointerDown={handleSentencePointerDown}
	                                      onClick={(event) => handleSentenceClick(globalIndex, event)}
	                                    >
                                      {translatedParts.map((part, partIndex) => (
                                        <React.Fragment key={`tp-${partIndex}`}>
                                          {renderInkableText(
                                            emphasisWrapper && part.trim() ? `${emphasisWrapper}${part}${emphasisWrapper}` : part,
                                            globalIndex,
                                            isActive,
                                            refsForTranslatedPart(partIndex),
                                            partIndex === 0 ? leadingNoteRef : null,
                                            { internalNoteLinksAsFootnotes: false, inferBareFootnotes: false, romanMarkersAsReferences: false }
                                          )}
                                          {partIndex < translatedParts.length - 1 ? ' ' : ''}
                                        </React.Fragment>
                                      ))}{' '}
                                    </span>
                                  );
                                })
                              ) : null}
                            </div>
                          )}
                        </div>
                      );})}
                    </div>
                  );
                })}
             </div>
          </div>
        </>
      )}
    </div>
  );
};
