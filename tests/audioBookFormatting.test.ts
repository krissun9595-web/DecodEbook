import assert from 'node:assert/strict';
import {
  normalizeSourceAttributionMarkup,
  parseInlineFormatting,
  shouldSuppressPraiseBodyItalic,
  sourcePraiseRhythmFor,
} from '../components/AudioBook.tsx';
import { rearrangeAndCleanText } from '../utils/textCleanup.ts';

{
  const cleaned = rearrangeAndCleanText('\uE011*—Sean Falconer, head of AI, Confluent*');
  assert.equal(
    cleaned,
    '\uE011*— Sean Falconer, head of AI, Confluent*',
    'chapter cleanup must preserve the PDF attribution font-run markup and alignment sentinel',
  );
}

{
  const normalized = normalizeSourceAttributionMarkup('*—Sean Falconer, head of AI, Confluent*');
  assert.equal(
    normalized,
    '*— Sean Falconer, head of AI, Confluent*',
    'normalizing a source credit must preserve its extracted italic wrapper',
  );
}

{
  const cleaned = rearrangeAndCleanText('\uE011*—Sean Falconer, head of AI, Confluent*').replace('\uE011', '');
  const segments = parseInlineFormatting(cleaned, {
    sourceFaithfulAttributionLine: true,
    suppressBroadItalic: true,
    inferBareFootnotes: false,
  });
  assert.deepEqual(
    segments.map(({ text, format }) => ({ text, format })),
    [{ text: '— Sean Falconer, head of AI, Confluent', format: 'italic' }],
    'the complete cleanup-to-render path must keep a source attribution italic',
  );
}

{
  const cleaned = rearrangeAndCleanText(
    '\uE011— Ole Olesen-Bagneux, chief evangelist, Actian, and O’Reilly author of *Fundamentals of Metadata Management* and *The Enterprise Data Catalog*',
  );
  assert.equal(
    cleaned,
    '\uE011— Ole Olesen-Bagneux, chief evangelist, Actian, and O’Reilly author of *Fundamentals of Metadata Management* and *The Enterprise Data Catalog*',
    'a Roman EPUB attribution must retain italic book titles from its source markup',
  );
  const segments = parseInlineFormatting(cleaned.replace('\uE011', ''), {
    sourceFaithfulAttributionLine: true,
    inferBareFootnotes: false,
  });
  assert.deepEqual(
    segments.map(({ text, format }) => ({ text, format })),
    [
      { text: '— Ole Olesen-Bagneux, chief evangelist, Actian, and O’Reilly author of ', format: 'plain' },
      { text: 'Fundamentals of Metadata Management', format: 'italic' },
      { text: ' and ', format: 'plain' },
      { text: 'The Enterprise Data Catalog', format: 'italic' },
    ],
    'EPUB attribution rendering must keep its Roman credit and italic title runs distinct',
  );
}

{
  const segments = parseInlineFormatting('*and O’Reilly author of* Fundamentals of Metadata Management', {
    suppressBroadItalic: false,
    inferBareFootnotes: false,
  });
  assert.deepEqual(
    segments.map(({ text, format }) => ({ text, format })),
    [
      { text: 'and O’Reilly author of', format: 'italic' },
      { text: ' Fundamentals of Metadata Management', format: 'plain' },
    ],
    'mixed attribution continuations must retain italic credit text and Roman book titles',
  );
}

{
  const segments = parseInlineFormatting('*A praise quote that inherited broad italic markup from a container.*', {
    suppressBroadItalic: true,
    inferBareFootnotes: false,
  });
  assert.deepEqual(
    segments.map(({ text, format }) => ({ text, format })),
    [{ text: 'A praise quote that inherited broad italic markup from a container.', format: 'plain' }],
    'praise-body cleanup must continue to suppress broad non-source italic styling',
  );
}

{
  assert.equal(
    shouldSuppressPraiseBodyItalic('pdf', true),
    true,
    'PDF praise bodies may suppress broad extractor-created italic markup',
  );
  assert.equal(
    shouldSuppressPraiseBodyItalic('epub', true),
    false,
    'EPUB praise bodies must preserve the publisher’s structural italic styling',
  );

  assert.deepEqual(
    sourcePraiseRhythmFor({
      isAttribution: false,
      isContinuation: false,
      hasContinuation: false,
      isFirstLine: true,
      isLastLine: true,
    }),
    { lineHeight: 1.2, marginTopEm: 0, marginBottomEm: 0 },
    'praise quote lines must retain the source 10/12 typography without invented paragraph margins',
  );
  assert.deepEqual(
    sourcePraiseRhythmFor({
      isAttribution: true,
      isContinuation: false,
      hasContinuation: false,
      isFirstLine: true,
      isLastLine: true,
    }),
    { lineHeight: 1.2, marginTopEm: 0.4, marginBottomEm: 2 },
    'a one-block praise attribution must reproduce the source 4pt-before/20pt-after rhythm',
  );
  assert.deepEqual(
    sourcePraiseRhythmFor({
      isAttribution: true,
      isContinuation: false,
      hasContinuation: true,
      isFirstLine: true,
      isLastLine: true,
    }),
    { lineHeight: 1.2, marginTopEm: 0.4, marginBottomEm: 0 },
    'a continued praise attribution must not close the block before its continuation',
  );
  assert.deepEqual(
    sourcePraiseRhythmFor({
      isAttribution: true,
      isContinuation: true,
      hasContinuation: false,
      isFirstLine: true,
      isLastLine: true,
    }),
    { lineHeight: 1.2, marginTopEm: 0, marginBottomEm: 2 },
    'the final attribution continuation must close the praise block without a second top gap',
  );
}

console.log('AudioBook source-formatting regression tests passed');
