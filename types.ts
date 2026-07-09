
export interface Chapter {
  id: number;
  title: string;
  pageStart?: number; // Optional, AI estimated
  pageEnd?: number;   // Optional, AI estimated
  description?: string;
  sourceStart?: number;
  sourceEnd?: number;
  sourceHeading?: string;
  sourceHeadingVariants?: string[];
  sourcePageStart?: number;
  sourcePageEnd?: number;
  sourceMethod?: 'heading' | 'page' | 'hybrid' | 'outline';
}

// A PDF's built-in outline (bookmarks) entry, resolved to a 1-based page number.
// Captured during PDF extraction so chapters can be built from the document's own
// structure instead of heuristic chapter resolution.
export interface PdfOutlineItem {
  title: string;
  page: number;            // 1-based page number the bookmark points to
  level: number;           // 0 = top-level chapter/section, 1+ = nested sub-heading
  offset?: number;         // exact heading offset in the extracted content (Y-resolved), if found
}

export type ReaderPageTarget =
  | 'first'
  | 'last'
  | {
      type: 'page';
      pageIndex: number;
      sentenceIndex?: number;
    }
  | {
      type: 'note';
      marker: string;
      targetHref?: string;
      noteKey?: string;
      sourceChapterId?: number;
      sourceChapterIndex?: number;
      sourceChapterNumber?: number;
      sourceChapterTitle?: string;
      sourceChapterHeading?: string;
      returnTarget: {
        chapterId: number;
        pageIndex: number;
        sentenceIndex?: number;
      };
    };

export interface BookStructure {
  id: string; // Unique ID for the book in library
  title: string;
  author: string;
  chapters: Chapter[];
  bookmarks: number[]; // Array of chapter IDs
}

export interface Concept {
  term: string;
  definition: string;
  visualPrompt: string;
}

export interface DictionaryEntry {
  word: string;
  context: string;
  definition: string;
}

export interface PodcastState {
  audioUrl: string | null;
  isLoading: boolean;
  script: string | null;
}

export interface VisualState {
  concepts: Concept[];
  generatedImages: Record<string, string>; // term -> base64/url
  isLoading: boolean;
}

export interface DictionaryState {
  entries: DictionaryEntry[];
  isLoading: boolean;
}

export interface VideoState {
  videoUrl: string | null;
  isLoading: boolean;
  progressMessage: string;
}

// A figure (raster image) extracted from a PDF page. The image bytes live in the file cache
// (fileType 'figure-image', keyed by bookId + id); this is the lightweight manifest carried on the
// FileContext. The reader locates the figure in the flow by the [[FIG id]] marker in `content`.
export interface PdfFigure {
  id: string;            // stable id, e.g. "p42n1"
  page: number;          // 1-based source page
  wPts: number;          // placed size on the page, in PDF points (for column-proportion sizing)
  hPts: number;
  wPx: number;           // intrinsic pixel size of the stored (capped) image (aspect + max sharpness)
  hPx: number;
  mimeType: string;      // 'image/jpeg' | 'image/png'
  colFrac?: number;      // figure width as a fraction of its page's text-column width (for sizing)
}

export interface FileContext {
  content: string; // Base64 string for PDF, or raw text string for text files
  mimeType: string;
  isText: boolean; // Flag to determine how to send to Gemini
  sourceHash?: string;
  sourceKind?: 'pdf' | 'epub' | 'text';
  sourceExtractorVersion?: string;
  pdfOutline?: PdfOutlineItem[]; // PDF bookmarks (top-level), if the document has them
  docTitle?: string; // the PDF's own metadata Title, preferred over an inferred one
  pdfFigures?: PdfFigure[]; // figures extracted from the PDF; bytes cached separately
}

export interface NotebookItem {
  id: string;
  text: string;
  type: 'word' | 'phrase' | 'sentence';
  definition?: string;
  timestamp: number;
  sourceChapter?: string;
  bookTitle?: string;
  bookAuthor?: string;
  comment?: string;
  contextSource?: string; // e.g. "Neural_Podcast", "Input_Stream", "Decoded_Layer"
  inked?: boolean;
}

export interface MindMapNode {
  id: string;
  label: string;
  children?: MindMapNode[];
  type?: 'root' | 'category' | 'item' | 'detail';
  note?: string; // Additional context
  isCollapsed?: boolean; // UI state
}

export enum AppView {
  LANDING = 'LANDING',
  UPLOAD = 'UPLOAD',
  DASHBOARD = 'DASHBOARD'
}

export enum Tab {
  AUDIOBOOK = 'AUDIOBOOK',
  CONCEPTS = 'CONCEPTS',
  PODCAST = 'PODCAST',
  ANIMATION = 'ANIMATION',
  NOTEBOOK = 'NOTEBOOK',
  GEN_FILES = 'GEN_FILES'
}

export type ThemeColor = 'indigo' | 'emerald' | 'rose' | 'amber' | 'violet' | 'pink';

export interface AppSettings {
  targetLanguage: string;
  highlightColor: ThemeColor;
  inkLine: 'full' | 'curvy' | 'dotted';
  textSize: 'sm' | 'base' | 'lg' | 'xl';
  lineHeight: 'tight' | 'normal' | 'relaxed' | 'loose';
  letterSpacing: 'tighter' | 'normal' | 'wide' | 'wider';
  font: string;
  llmModel: string;
  ttsModel: string;
  imageModel: string;
  videoModel: string;
  geminiKey?: string;
  openrouterKey?: string;
}

export interface LibraryItem {
  book: BookStructure;
  fileContext: FileContext;
  uploadDate: number;
}

export type CachedFileType = 'source-file' | 'audio' | 'podcast-audio' | 'podcast-script' | 'video' | 'concept-image' | 'sticky-note' | 'mind-map-pdf' | 'mind-map-docx' | 'mind-map-xmind' | 'chapter-text' | 'translation' | 'figure-image' | 'notebook-figure';

export interface CachedFileMetadata {
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  timestamp: number;
  bookId: string;
  chapterId: number;
  componentSource: string;
  fileType: CachedFileType;
}

export interface CachedFile {
  metadata: CachedFileMetadata;
  blob: Blob;
}
