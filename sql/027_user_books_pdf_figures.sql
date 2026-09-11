-- Sync the PDF figure MANIFEST across devices.
--
-- WHY: figure image bytes now sync (Storage, sql/026), but the manifest — each figure's pixel
-- dimensions (aspect) and column-width fraction — did not. So a figure pulled on a second device
-- had no size info and the reader fell back to a 4/3 box at full column width, rendering it
-- letterboxed and wider than the source. This column carries that lightweight metadata (NO image
-- bytes) so a synced figure matches the original exactly. See services/librarySync.ts.

alter table public.user_books add column if not exists pdf_figures jsonb;
