
export interface Chapter {
  id: number;
  title: string;
  pageStart?: number; // Optional, AI estimated
  pageEnd?: number;   // Optional, AI estimated
  description?: string;
}

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

export interface FileContext {
  content: string; // Base64 string for PDF, or raw text string for text files
  mimeType: string;
  isText: boolean; // Flag to determine how to send to Gemini
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
  UPLOAD = 'UPLOAD',
  DASHBOARD = 'DASHBOARD'
}

export enum Tab {
  AUDIOBOOK = 'AUDIOBOOK',
  CONCEPTS = 'CONCEPTS',
  PODCAST = 'PODCAST',
  ANIMATION = 'ANIMATION',
  NOTEBOOK = 'NOTEBOOK'
}

export type ThemeColor = 'indigo' | 'emerald' | 'rose' | 'amber' | 'violet';

export interface AppSettings {
  targetLanguage: string;
  highlightColor: ThemeColor;
  textSize: 'sm' | 'base' | 'lg' | 'xl';
  lineHeight: 'tight' | 'normal' | 'relaxed' | 'loose';
  letterSpacing: 'tighter' | 'normal' | 'wide' | 'wider';
  font: 'Inter' | 'Merriweather' | 'Playfair Display' | 'Roboto Mono' | 'Open Sans' | 'Orbitron' | 'Cinzel' | 'Source Code Pro' | 'Crimson Text';
}

export interface LibraryItem {
  book: BookStructure;
  fileContext: FileContext;
  uploadDate: number;
}

export type CachedFileType = 'audio' | 'podcast-audio' | 'podcast-script' | 'video' | 'concept-image' | 'sticky-note' | 'mind-map-pdf' | 'mind-map-docx' | 'mind-map-xmind' | 'chapter-text' | 'translation';

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