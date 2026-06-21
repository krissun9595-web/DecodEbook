import assert from 'node:assert/strict';
import {
  buildLocalTextStructure,
  buildStructureAnalysisText,
  isReadableChapterTitle,
  looksLikeStructureHeading,
} from '../utils/structureAnalysis.ts';

const paragraph = [
  'This section begins with real body prose and enough text to distinguish it from a list entry.',
  'It continues with multiple sentences so extraction has a plausible body sample after the heading.',
].join(' ');

assert.equal(looksLikeStructureHeading('Chapter One'), true);
assert.equal(looksLikeStructureHeading('Chapter One ........ 15'), false);
assert.equal(looksLikeStructureHeading('Foreword'), true);
assert.equal(looksLikeStructureHeading('Afterword'), true);
assert.equal(looksLikeStructureHeading('part of the exponential curve, and the pace of innovation is'), false);
assert.equal(looksLikeStructureHeading('book can hope to be up to date.'), false);
assert.equal(looksLikeStructureHeading('[11] But the latest advances in large language models have'), false);
assert.equal(looksLikeStructureHeading('2020: $191.00'), false);
assert.equal(looksLikeStructureHeading('i. Wire the neural net randomly; or'), false);
assert.equal(looksLikeStructureHeading('Index-Report_2023.pdf.'), false);
assert.equal(looksLikeStructureHeading('index-2021; Democracy Index 2022: Frontline Democracy and the Battle'), false);
assert.equal(looksLikeStructureHeading('3. But this kind of logic has much broader applications than'), false);
assert.equal(looksLikeStructureHeading('1. The infection that requires therapy is'), false);
assert.equal(looksLikeStructureHeading('7. As we detailed in The Great Reckoning, some of the Protestant sects'), false);
assert.equal(looksLikeStructureHeading('1. a common language'), false);
assert.equal(looksLikeStructureHeading('3. similar phenotypic characteristics'), false);
assert.equal(looksLikeStructureHeading('1. Introduction'), true);
assert.equal(looksLikeStructureHeading('1. Exact Strange-Heading'), true);
assert.equal(looksLikeStructureHeading('Reality in an unfamiliar guise'), true);
assert.equal(
  looksLikeStructureHeading('1. Danny Hillis, "The Millennium Clock," Wired, Special Edition, Fall 1995, p. 48.'),
  false
);
assert.equal(
  looksLikeStructureHeading('I. Nomenklaturas are the entrenched elites that ruled the former Soviet Union and other state-run economies.'),
  false
);
assert.equal(looksLikeStructureHeading('17. Ibid.'), false);
assert.equal(looksLikeStructureHeading('14. See Bois, op. cit., p. 12.'), false);
assert.equal(isReadableChapterTitle('Title Page'), false);
assert.equal(isReadableChapterTitle('Tittle Page'), false);
assert.equal(isReadableChapterTitle('Contents'), false);
assert.equal(isReadableChapterTitle('Contents Page'), false);
assert.equal(isReadableChapterTitle('Table of Contents'), false);
assert.equal(isReadableChapterTitle('Introduction'), true);

{
  const content = [
    'The Sovereign Individual',
    'Chapter One',
    paragraph,
    '',
    'Chapter Two',
    paragraph,
  ].join('\n');

  const structure = buildLocalTextStructure(content);
  assert.equal(structure.title, 'The Sovereign Individual');
  assert.deepEqual(structure.chapters.map(chapter => chapter.title), ['Chapter One', 'Chapter Two']);
}

{
  const content = [
    'Transurfing in 78 Days',
    'Title Page',
    'Publication metadata that should not be a reading chapter.',
    '',
    'Contents',
    'Introduction',
    'Reality in an unfamiliar guise',
    '',
    'Introduction',
    paragraph,
    '',
    'Reality in an unfamiliar guise',
    paragraph,
  ].join('\n');

  const structure = buildLocalTextStructure(content);
  assert.deepEqual(structure.chapters.map(chapter => chapter.title), [
    'Introduction',
    'Reality in an unfamiliar guise',
  ]);
}

{
  const filler = `\n${'body text '.repeat(80000)}`;
  const content = [
    'Reality Transurfing',
    '',
    'Foreword',
    paragraph,
    filler,
    'Chapter One',
    paragraph,
    filler,
    'Afterword',
    paragraph,
  ].join('\n');

  const outline = buildStructureAnalysisText(content);
  assert.ok(outline.includes('LONG_SOURCE_OUTLINE'));
  assert.ok(outline.includes('offset'));
  assert.ok(outline.includes('Foreword'));
  assert.ok(outline.includes('Chapter One'));
  assert.ok(outline.includes('Afterword'));
}

{
  const content = [
    'Chapter 1',
    paragraph,
    'Chapter 2',
    paragraph,
    'Chapter 3',
    paragraph,
    'NOTES',
    'CHAPTER 1',
    '1. Ibid.',
    'CHAPTER 2',
    '2. See Example, op. cit., p. 1.',
    'INDEX',
    'ABOUT THE AUTHOR',
  ].join('\n');

  const structure = buildLocalTextStructure(content);
  assert.deepEqual(structure.chapters.map(chapter => chapter.title), [
    'Chapter 1',
    'Chapter 2',
    'Chapter 3',
    'NOTES',
    'INDEX',
    'ABOUT THE AUTHOR',
  ]);
}

{
  const content = [
    'Chapter 6: The Megapdlitics of the Informatidn Age',
    'CHAPTER 6',
    'The Megapolitics of the Information Age',
    paragraph,
  ].join('\n');

  const structure = buildLocalTextStructure(content);
  assert.equal(structure.chapters.length, 1);
  assert.ok(structure.chapters[0].sourceHeadingVariants?.includes('CHAPTER 6'));
  assert.ok(structure.chapters[0].sourceHeadingVariants?.includes('CHAPTER 6: The Megapolitics of the Information Age'));
}

console.log('structureAnalysis regression tests passed');
