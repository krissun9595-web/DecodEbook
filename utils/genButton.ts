// Single source of truth for the generate-button state across every module, so labels can't drift.
// Explanation lives in `title` (hover tooltip) — never as extra on-button text.
//   generating        → STOP
//   pending > 0        → RESUME   (unfinished, already-paid parts remain → only the rest is charged)
//   resultExists       → REGENERATE (make a new version → full charge)
//   otherwise          → INITIATE
export type GenLabel = 'INITIATE' | 'STOP' | 'RESUME' | 'REGENERATE';

export function genButton(
  { generating, pending = 0, resultExists = false }:
  { generating: boolean; pending?: number; resultExists?: boolean }
): { label: GenLabel; title: string } {
  if (generating)    return { label: 'STOP',       title: 'Stop — finished parts are kept' };
  if (pending > 0)   return { label: 'RESUME',     title: 'Resume - credits will be consumed from where you left.' };
  if (resultExists)  return { label: 'REGENERATE', title: 'Regenerate — creates a new version, uses credits' };
  return { label: 'INITIATE', title: 'Generate — uses credits' };
}
