-- ============================================================================
-- 020: Sync the book OUTLINE to the cloud (user_books.pdf_outline).
--
-- On reload / another device, chapters are re-derived from content. The correct
-- derivation uses the book's outline (PDF bookmarks / EPUB nav); without it, hydrate
-- falls back to a lossy heuristic that produces fewer, mis-split chapters (the "41
-- blocks / lost titles" bug). The outline was never synced, so cloud-loaded copies
-- lost it. Store it so every device rebuilds the same chapters the upload produced.
--
-- Run on STAGING first, then prod. Safe/idempotent.
-- ============================================================================

ALTER TABLE user_books ADD COLUMN IF NOT EXISTS pdf_outline jsonb;
