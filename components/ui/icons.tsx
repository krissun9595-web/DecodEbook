import React from 'react';

/**
 * DecodEbook custom icon set — a drop-in replacement for the lucide-react icons
 * we used. Same component names + props (size / className / fill / strokeWidth /
 * color), so imports can be repointed here with no other changes. Icons use
 * `currentColor`, so existing text-* classNames keep controlling color — this
 * swaps FIGURES only, never colors.
 */
type IProps = {
  size?: number | string;
  className?: string;
  strokeWidth?: number;
  color?: string;
  fill?: string;
  [k: string]: any;
};

const svg = (children: React.ReactNode) =>
  function Icon({ size = 24, className = '', strokeWidth = 2, color, ...rest }: IProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color || 'currentColor'}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        {...rest}
      >
        {/* scale the figure up ~12% around center so the glyphs fill the box like
            lucide did (they were drawn a touch small) — no change to footprint */}
        <g transform="translate(-1.44 -1.44) scale(1.12)">{children}</g>
      </svg>
    );
  };

/* ── transport / media ── */
export const Play = svg(<path d="M8 5.5v13l11-6.5z" />);
export const Pause = svg(<><rect x="8" y="5" width="3.2" height="14" rx="1" /><rect x="12.8" y="5" width="3.2" height="14" rx="1" /></>);
export const Square = svg(<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />);
export const StopCircle = svg(<><circle cx="12" cy="12" r="9" /><rect x="9" y="9" width="6" height="6" rx="1" /></>);
export const PlayCircle = svg(<><circle cx="12" cy="12" r="9" /><path d="M10 8.5l5 3.5-5 3.5z" /></>);
export const RotateCcw = svg(<><path d="M4 12a8 8 0 1 1 3 6.2" /><path d="M4 8v4h4" /></>);
export const RotateCw = svg(<><path d="M20 12a8 8 0 1 0-3 6.2" /><path d="M20 8v4h-4" /></>);
export const Volume2 = svg(<><path d="M4 9.5v5h3l4.5 3.5v-12L7 9.5z" /><path d="M15 9.5a4 4 0 0 1 0 5" /><path d="M17.5 7a7.5 7.5 0 0 1 0 10" /></>);
export const VolumeX = svg(<><path d="M4 9.5v5h3l4.5 3.5v-12L7 9.5z" /><path d="M15 10l4 4M19 10l-4 4" /></>);
export const AudioLines = svg(<path d="M4 10v4M8 7v10M12 9v6M16 6v12M20 11v2" />);
export const MonitorPlay = svg(<><rect x="3" y="4.5" width="18" height="12" rx="1.2" /><path d="M10.5 8.5l4 2.5-4 2.5z" /><path d="M8.5 20h7M12 16.5V20" /></>);
export const Gauge = svg(<><path d="M4 15a8 8 0 0 1 16 0" /><path d="M12 15l4.5-3.5" /><circle cx="12" cy="15" r="1.3" /></>);
export const Radio = svg(<><rect x="3" y="10" width="18" height="9" rx="1.2" /><path d="M7 10l10-5" /><circle cx="8" cy="14.5" r="1.6" /><path d="M13 13h4M13 16h2" /></>);
export const Mic = svg(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v3M9 20h6" /></>);
export const Mic2 = svg(<><circle cx="8" cy="9" r="2.3" /><path d="M4.3 17.5a3.7 3.7 0 0 1 7.4 0" /><circle cx="16" cy="9" r="2.3" /><path d="M12.3 17.5a3.7 3.7 0 0 1 7.4 0" /><path d="M12 3.2v2.4M10.2 4.1h3.6" /></>);

/* ── modules ── */
export const Headphones = svg(<><path d="M4 6.5h9" /><path d="M4 10h13" /><path d="M4 15.5h1.4l1.1-4 2 8 2-8 1.3 5 1-3h5.2" /></>);
export const Film = svg(<><rect x="4" y="5" width="16" height="14" rx="1.4" /><path d="M4 8.3h2.2M4 12h2.2M4 15.7h2.2M17.8 8.3H20M17.8 12H20M17.8 15.7H20" /><path d="M10.8 9.4l4.2 2.6-4.2 2.6z" /></>);
export const HardDrive = svg(<><path d="M9 4h6l3 3" opacity=".5" /><path d="M7 7.5h7l3 3v3" opacity=".7" /><path d="M5 11h7l3 3v6H5z" /></>);
const _visual = <><path d="M12 3.2l7.6 4.4v8.8L12 20.8 4.4 16.4V7.6z" /><circle cx="12" cy="12" r="2.3" /><path d="M12 5.4V3.6M18.1 8.6l1.5-.9M18.1 15.4l1.5.9M12 18.6v1.8M5.9 15.4l-1.5.9M5.9 8.6l-1.5-.9" /></>;
export const Image = svg(_visual);
export const ImageIcon = svg(_visual);
const _memlog = <><path d="M6 3.5h9l3 3v14l-6-3.6L6 20.5z" opacity=".55" /><circle cx="12" cy="9" r="1.7" /><circle cx="9" cy="14.5" r="1.3" /><circle cx="15" cy="14.5" r="1.3" /><path d="M12 10.7l-2.2 2.5M12 10.7l2.2 2.5" /></>;
export const Notebook = svg(_memlog);

/* ── reading / language ── */
export const Languages = svg(<><rect x="3.4" y="5" width="7.2" height="7.2" rx="1" /><path d="M7 6.4v4.4M5.2 8h3.6M5.6 10.4l2.8-1.8" /><rect x="13.4" y="11.8" width="7.2" height="7.2" rx="1" /><path d="M15.4 17.2l1.6-3.4 1.6 3.4M15.9 15.9h2.2" /><path d="M11 11l2.4 2.4M13.4 11.2v2.2h-2.2" opacity=".85" /></>);
export const Columns = svg(<><rect x="4" y="5" width="16" height="14" rx="1.4" /><path d="M12 5.4v13.2" strokeDasharray="2 2.4" /><path d="M6.6 9h3.2M6.6 12h3.6M6.6 15h2.6" /><path d="M14.4 9h3.2M14.4 12h3.6M14.4 15h2.6" opacity=".5" /></>);
export const Highlighter = svg(<><path d="M4 17.6c3.2 0 5-1.3 8-1.3s4.8 1.3 8 1.3" /><path d="M14.6 5.3l3.6 3.6-7.4 7.4-3.6.4.4-3.6z" /><path d="M13 6.9l3.6 3.6" opacity=".6" /></>);
export const PenLine = svg(<><path d="M4 20h16" /><path d="M14.5 4.5l4 4L9 18l-4.5.5L5 14z" /><path d="M12.5 6.5l4 4" /></>);
export const Book = svg(<><path d="M6 4h11a1 1 0 0 1 1 1v13H8a2 2 0 0 0-2 2z" /><path d="M6 18a2 2 0 0 1 2-2h10" /></>);
export const BookOpen = svg(<><path d="M12 6.5C10 5 6.5 5 4.5 5.8V18c2-.8 5.5-.8 7.5.7 2-1.5 5.5-1.5 7.5-.7V5.8C17.5 5 14 5 12 6.5z" /><path d="M12 6.5V19" /></>);
export const BookA = svg(<><path d="M6 4h11a1 1 0 0 1 1 1v13H8a2 2 0 0 0-2 2z" /><path d="M9.5 14l2-6 2 6M10 12.2h3" /></>);
export const Library = svg(<><path d="M6 5v14M10 5v14" /><path d="M13.5 5.5l4 13.5" /><path d="M4 19h16" /></>);
export const Bookmark = svg(<path d="M7 4h10v16l-5-3.5L7 20z" />);
export const Tag = svg(<><path d="M4 4h7.5l8.5 8.5-7.5 7.5L4 11.5z" /><circle cx="8" cy="8" r="1.4" /></>);
export const Quote = svg(<path d="M5 8.5C5 7 6 6 7.5 6H10v5c0 2.5-1.5 4-4 4.5M14 8.5C14 7 15 6 16.5 6H19v5c0 2.5-1.5 4-4 4.5" />);
export const Type = svg(<path d="M5 6h14M12 6v13M9 19h6" />);
export const Brain = svg(<><path d="M12 5a3 3 0 0 0-5.6 1.5A3 3 0 0 0 5 12a3 3 0 0 0 2 4.7A2.6 2.6 0 0 0 12 18zM12 5a3 3 0 0 1 5.6 1.5A3 3 0 0 1 19 12a3 3 0 0 1-2 4.7A2.6 2.6 0 0 1 12 18z" /><path d="M12 5v13" /></>);
export const Sparkles = svg(<><path d="M12 3.5l1.6 4.9 4.9 1.6-4.9 1.6L12 16.5l-1.6-4.9L5.5 10l4.9-1.6z" /><path d="M18 15l.7 2 2 .7-2 .7L18 20.4l-.7-2-2-.7 2-.7z" /></>);
export const Lightbulb = svg(<><path d="M9.5 18h5M10.5 21h3" /><path d="M12 3a6 6 0 0 0-3.8 10.6c.7.6 1.3 1.4 1.3 2.4h5c0-1 .6-1.8 1.3-2.4A6 6 0 0 0 12 3z" /></>);
export const MessageSquare = svg(<><path d="M4.5 5.5h15v10H10l-4 3.2V15.5H4.5z" /><path d="M8.5 10h7M8.5 12.8h4" /></>);
export const Send = svg(<><path d="M4.5 12L20 5l-6.5 15-2.3-6.2z" /><path d="M11.2 13.8L20 5" /></>);
export const Scan = svg(<><path d="M4 8V6a2 2 0 0 1 2-2h2M20 8V6a2 2 0 0 0-2-2h-2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M4 12h16" /></>);

/* ── file / data ── */
export const Download = svg(<><path d="M12 4v10M8 10.5l4 4 4-4" /><path d="M5 19h14" /></>);
export const Upload = svg(<><path d="M12 15V5M8 8.5l4-4 4 4" /><path d="M5 19h14" /></>);
export const Share2 = svg(<><circle cx="6" cy="12" r="2.2" /><circle cx="17" cy="6" r="2.2" /><circle cx="17" cy="18" r="2.2" /><path d="M8 11l7-4M8 13l7 4" /></>);
export const Save = svg(<><path d="M5 5h11l3 3v11H5z" /><path d="M8 5v5h6V6M8 19v-5h8v5" /></>);
export const Copy = svg(<><rect x="8" y="8" width="11" height="12" rx="1.2" /><path d="M5 16V4h10" /></>);
export const Trash2 = svg(<><path d="M4 7h16M9.5 7l.5-3h4l.5 3M6.5 7l1 13h9l1-13" /><path d="M10 11v6M14 11v6" /></>);
export const FileText = svg(<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M9 12h6M9 15.5h6M9 8.5h2" /></>);
export const FileDown = svg(<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M12 10.5v5.5M9.5 13.5l2.5 2.5 2.5-2.5" /></>);
export const ImageDown = svg(<><rect x="4" y="4" width="16" height="11" rx="1.2" /><circle cx="8.5" cy="8" r="1.4" /><path d="M4 12l4-3 4 3" /><path d="M15 15v5M12.5 17.5l2.5 2.5 2.5-2.5" /></>);
export const StickyNote = svg(<><path d="M5 4h9l5 5v11H5z" /><path d="M14 4v5h5" /><path d="M8 12h6M8 15h4" /></>);
export const Archive = svg(<><rect x="4" y="5" width="16" height="4" rx="1" /><path d="M5.5 9v10h13V9" /><path d="M10 13h4" /></>);
export const Package = svg(<><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>);
export const Database = svg(<><ellipse cx="12" cy="6" rx="7" ry="2.8" /><path d="M5 6v12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V6" /><path d="M5 12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8" /></>);
export const Map = svg(<><path d="M9 4L4 6v14l5-2 6 2 5-2V4l-5 2z" /><path d="M9 4v14M15 6v14" /></>);
export const ExternalLink = svg(<><path d="M14 4h6v6" /><path d="M11 13L20 4" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>);

/* ── navigation / window ── */
export const Menu = svg(<path d="M4 7h16M4 12h16M4 17h16" />);
export const X = svg(<path d="M6 6l12 12M18 6L6 18" />);
export const Search = svg(<><circle cx="10.5" cy="10.5" r="6" /><path d="M20 20l-5-5" /></>);
export const ChevronLeft = svg(<path d="M15 6l-6 6 6 6" />);
export const ChevronRight = svg(<path d="M9 6l6 6-6 6" />);
export const ChevronUp = svg(<path d="M6 15l6-6 6 6" />);
export const ChevronDown = svg(<path d="M6 9l6 6 6-6" />);
export const ArrowRight = svg(<path d="M4 12h15M13 6l6 6-6 6" />);
export const MoveHorizontal = svg(<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M4 12h16" />);
export const Move = svg(<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />);
export const Maximize = svg(<path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4" />);
export const Maximize2 = svg(<path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4" />);
export const Minimize2 = svg(<path d="M4 8h4V4M20 8h-4V4M4 16h4v4M20 16h-4v4" />);
export const ZoomIn = svg(<><circle cx="10.5" cy="10.5" r="6" /><path d="M20 20l-5-5M10.5 7.5v6M7.5 10.5h6" /></>);
export const ZoomOut = svg(<><circle cx="10.5" cy="10.5" r="6" /><path d="M20 20l-5-5M7.5 10.5h6" /></>);
export const AlignJustify = svg(<path d="M4 6h16M4 10h16M4 14h16M4 18h12" />);
export const Plus = svg(<path d="M12 5v14M5 12h14" />);
export const Minus = svg(<path d="M5 12h14" />);

/* ── system / chrome ── */
export const Settings = svg(<><circle cx="12" cy="12" r="3.2" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" /></>);
export const Settings2 = svg(<><path d="M4 8h9M17 8h3M4 16h3M11 16h9" /><circle cx="15" cy="8" r="2.2" /><circle cx="9" cy="16" r="2.2" /></>);
export const Globe = svg(<><circle cx="12" cy="12" r="8.2" /><path d="M3.8 12h16.4" /><path d="M12 3.8c3 3 3 13.4 0 16.4M12 3.8c-3 3-3 13.4 0 16.4" /></>);
export const Network = svg(<><circle cx="12" cy="5" r="2.2" /><circle cx="5" cy="18" r="2.2" /><circle cx="19" cy="18" r="2.2" /><path d="M12 7.2v3.8M11 11l-4.5 5M13 11l4.5 5" /></>);
export const Hexagon = svg(<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />);
export const Terminal = svg(<><rect x="3.5" y="5" width="17" height="14" rx="1.2" /><path d="M7 9.5l3 2.5-3 2.5M13 14.5h4" /></>);
export const Cpu = svg(<><rect x="7" y="7" width="10" height="10" rx="1" /><rect x="10" y="10" width="4" height="4" /><path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3" /></>);
export const Activity = svg(<path d="M3 12h4l3 7 4-15 3 8h4" />);
export const Shield = svg(<><path d="M12 3l6.8 2.4v6.1c0 4.3-2.9 7.4-6.8 8.9-3.9-1.5-6.8-4.6-6.8-8.9V5.4z" /><path d="M8.2 6.4L12 5.1l3.8 1.3" opacity=".45" /><circle cx="12" cy="10.6" r="1.7" /><path d="M12 12.3v3" /></>);
export const Crown = svg(<><path d="M6 3.4h12l3.6 5.7L12 20.6 2.4 9.1z" /><path d="M2.4 9.1h19.2" /><path d="M6 3.4l2.4 5.7L12 3.4l3.6 5.7L18 3.4M8.4 9.1L12 20.6l3.6-11.5" /></>);

/* ── status / feedback ── */
export const Check = svg(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const AlertCircle = svg(<><circle cx="12" cy="12" r="8.2" /><path d="M12 7.5v5" /><circle cx="12" cy="16.2" r=".9" /></>);
export const AlertTriangle = svg(<><path d="M12 4l8.5 15H3.5z" /><path d="M12 10v4" /><circle cx="12" cy="16.6" r=".9" /></>);
export const Loader = svg(<path d="M12 4v3.5M12 16.5V20M4 12h3.5M16.5 12H20M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />);
export const Loader2 = Loader;
export const RefreshCw = svg(<><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M20 4.5v4h-4" /></>);
export const Eye = svg(<><path d="M2.5 12s3.6-6 9.5-6 9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6z" /><circle cx="12" cy="12" r="2.6" /></>);
export const EyeOff = svg(<><path d="M4 5l16 14" /><path d="M9.6 9.7a2.6 2.6 0 0 0 3.4 3.7" /><path d="M6.3 7.4C4 9 2.5 12 2.5 12s3.6 6 9.5 6c1.5 0 2.9-.4 4.1-1M10.8 6.2C11.2 6.1 11.6 6 12 6c5.9 0 9.5 6 9.5 6s-.8 1.3-2.2 2.7" /></>);
export const Clock = svg(<><circle cx="12" cy="12" r="8.2" /><path d="M12 7.5V12l3.2 2" /></>);
export const Calendar = svg(<><rect x="4" y="5" width="16" height="15" rx="1.2" /><path d="M4 9.5h16M8.5 3v4M15.5 3v4" /></>);
export const BarChart3 = svg(<path d="M4 20h16M7 20v-7M12 20V6M17 20v-9" />);
export const Zap = svg(<path d="M13 3L5.5 13H11l-1 8 8-10.5H12z" />);
export const Gift = svg(<><rect x="4" y="9.5" width="16" height="10.5" rx="1" /><path d="M4 13.5h16M12 9.5V20" /><path d="M12 9.5c-1-2-4-3-4.5-1s2 2.5 4.5 1c2.5 1.5 5 .5 4.5-1s-3.5-1-4.5 1z" /></>);

/* ── account / auth ── */
export const User = svg(<><circle cx="12" cy="8" r="3.6" /><path d="M5 20a7 7 0 0 1 14 0" /></>);
export const UserPlus = svg(<><circle cx="9.5" cy="8" r="3.4" /><path d="M3.5 20a6 6 0 0 1 12 0" /><path d="M18 8v6M15 11h6" /></>);
export const LogIn = svg(<><path d="M13 4h6v16h-6" /><path d="M4 12h9M9.5 8l4 4-4 4" /></>);
export const LogOut = svg(<><path d="M11 4H5v16h6" /><path d="M20 12h-9M15.5 8l4.5 4-4.5 4" /></>);
export const Mail = svg(<><rect x="3" y="5" width="18" height="14" rx="1.2" /><path d="M3.5 6.5l8.5 6 8.5-6" /></>);
export const Key = svg(<><circle cx="8" cy="9" r="3.3" /><path d="M10.3 11.3L20 21M16.5 17.5l2-2M13.5 14.5l2-2" /></>);

/* ── brand mark (kept official) ── */
export const Github = svg(<path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.32 6.84 9.67.5.1.68-.22.68-.48l-.01-1.7c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.59.69.48A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2z" fill="currentColor" stroke="none" />);
