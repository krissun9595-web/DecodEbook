import assert from 'node:assert/strict';
import { buildChaptersFromOutline, buildSourceIndexedChapters, expandTopicSectionsIntoChapters, extractChapterFromSource, findHeadingOffsetByTitle, isUsablePdfOutline, splitDetectedBackMatter } from '../utils/sourceIndex.ts';
import type { Chapter } from '../types.ts';

const chapterBody = (name: string) => [
  `${name} begins with a real paragraph that is not a table of contents entry.`,
  'It has multiple sentences and enough body text for the extractor to distinguish prose from a navigation list.',
  'The chapter continues with source characters like **bold markers**, quotes, and punctuation that must remain intact.',
].join(' ');

{
  const content = [
    'Contents',
    'The Signal ........ 5',
    'Deep Work ........ 12',
    '',
    'Chapter 1',
    'The Signal',
    chapterBody('The Signal'),
    '',
    'Chapter 2',
    'Deep Work',
    chapterBody('Deep Work'),
  ].join('\n');

  const chapters: Chapter[] = [
    { id: 1, title: 'The Signal' },
    { id: 2, title: 'Deep Work' },
  ];
  const indexed = buildSourceIndexedChapters(content, chapters);
  const first = indexed[0];
  const extracted = extractChapterFromSource(content, first, indexed);

  assert.ok(first.sourceStart != null, 'first chapter should be indexed');
  assert.ok(first.sourceStart > content.indexOf('Chapter 1'), 'TOC occurrence must not be accepted as the chapter body');
  assert.ok(extracted?.includes('real paragraph'), 'body prose should be extracted');
  assert.ok(!extracted?.includes('Deep Work ........ 12'), 'TOC entries should be excluded');
}

{
  const content = [
    'CHAPTER TWO - The Vanishing Point',
    chapterBody('The Vanishing Point'),
    '',
    'CHAPTER THREE - Return',
    chapterBody('Return'),
  ].join('\n');

  const chapters: Chapter[] = [
    { id: 2, title: 'The Vanishing Point' },
    { id: 3, title: 'Return' },
  ];
  const indexed = buildSourceIndexedChapters(content, chapters);

  assert.equal(indexed[0].sourceHeading, 'CHAPTER TWO - The Vanishing Point');
  assert.ok(extractChapterFromSource(content, indexed[0], indexed)?.includes('The Vanishing Point begins'));
}

{
  const content = [
    'Chapter One',
    chapterBody('Chapter One'),
    '',
    'Chapter Two',
    chapterBody('Chapter Two'),
  ].join('\n');

  const chapters: Chapter[] = [
    { id: 1, title: 'Chapter One' },
    { id: 2, title: 'Chapter Two' },
  ];
  const indexed = buildSourceIndexedChapters(content, chapters);

  assert.equal(indexed[0].sourceHeading, 'Chapter One');
  assert.ok(extractChapterFromSource(content, indexed[0], indexed)?.includes('Chapter One begins'));
  assert.ok(!extractChapterFromSource(content, indexed[0], indexed)?.includes('Chapter Two begins'));
}

{
  const content = [
    '1. Exact Strange-Heading',
    chapterBody('Exact Strange-Heading'),
    '',
    '2. Next Heading',
    chapterBody('Next Heading'),
  ].join('\n');

  const chapters: Chapter[] = [
    { id: 1, title: 'Semantic model title', sourceHeading: 'Exact Strange-Heading' },
    { id: 2, title: 'Next Heading' },
  ];
  const indexed = buildSourceIndexedChapters(content, chapters);

  assert.ok(indexed[0].sourceStart != null, 'exact sourceHeading should anchor semantic title mismatches');
  assert.ok(extractChapterFromSource(content, indexed[0], indexed)?.includes('**bold markers**'));
}

{
  const content = [
    '[[PAGE 10]]',
    'This page is the full chapter body. It has enough sentences to be a valid PDF page extraction target.',
    'More source text remains on page ten.',
    '',
    '[[PAGE 11]]',
    'The next page belongs to a different chapter and must not be included.',
  ].join('\n');

  const chapters: Chapter[] = [
    { id: 1, title: 'Page Anchored', pageStart: 10, pageEnd: 10 },
    { id: 2, title: 'Next Page', pageStart: 11, pageEnd: 11 },
  ];
  const indexed = buildSourceIndexedChapters(content, chapters);
  const extracted = extractChapterFromSource(content, indexed[0], indexed);

  assert.ok(extracted?.includes('full chapter body'));
  assert.ok(!extracted?.includes('different chapter'));
}

{
  const content = [
    '[[PAGE 6]]',
    'Previous page pull quote should not become part of the heading.',
    '',
    '[[PAGE 7]]',
    'Introduction',
    'First body words must not be skipped by the exact heading matcher.',
    'The introduction continues with enough prose to score as body text.',
    '',
    '[[PAGE 8]]',
    'Reality in an unfamiliar guise',
    'Since time immemorial, these first words must remain readable.',
    'The section continues with enough prose to score as body text.',
  ].join('\n');

  const chapters: Chapter[] = [
    { id: 1, title: 'Introduction' },
    { id: 2, title: 'Reality in an unfamiliar guise' },
  ];
  const indexed = buildSourceIndexedChapters(content, chapters);
  const intro = extractChapterFromSource(content, indexed[0], indexed);
  const reality = extractChapterFromSource(content, indexed[1], indexed);

  assert.equal(indexed[0].sourceHeading, 'Introduction');
  assert.equal(indexed[1].sourceHeading, 'Reality in an unfamiliar guise');
  assert.ok(intro?.startsWith('First body words must not be skipped'));
  assert.ok(reality?.startsWith('Since time immemorial'));
  assert.ok(!intro?.includes('Previous page pull quote'));
}

{
  const content = [
    '[[PAGE 7]]',
    'Introduction',
    'Message to the Master',
    'Once, in the distant past, the Universe forgot itself.',
    'The introduction continues with enough prose to score as body text.',
    'More body text confirms this is not the table of contents.',
    '',
    '[[PAGE 8]]',
    'Reality in an unfamiliar guise',
    'Since time immemorial, these first words must remain readable.',
    'The section continues with enough prose to score as body text.',
  ].join('\n');

  const chapters: Chapter[] = [
    {
      id: 1,
      title: 'Introduction',
      sourceStart: 999999,
      sourceEnd: 1000000,
    },
    { id: 2, title: 'Reality in an unfamiliar guise' },
  ];
  const intro = extractChapterFromSource(content, chapters[0], chapters);

  assert.ok(intro?.includes('Message to the Master'));
  assert.ok(intro?.includes('Once, in the distant past'));
}

{
  const makePrincipleTopic = (heading: string) => [
    heading,
    'Principle',
    `${heading} principle text has enough source prose for body scoring. It must stay attached to its numbered heading.`,
    'Interpretation',
    `${heading} interpretation text continues with normal sentences. It should not be merged into a neighboring chunk.`,
  ].join('\n');

  const content = [
    makePrincipleTopic('1. Alternatives Flow'),
    '',
    makePrincipleTopic('11. Confidence'),
    '',
    makePrincipleTopic('21. The Master'),
  ].join('\n');

  const chapters: Chapter[] = [
    { id: 1, title: 'Topics 1-10', sourceHeading: '1. Alternatives Flow' },
    { id: 2, title: 'Topics 11-20', sourceHeading: '11. Confidence' },
    { id: 3, title: 'Topics 21-30', sourceHeading: '21. The Master' },
  ];
  const indexed = buildSourceIndexedChapters(content, chapters);
  const extracted = extractChapterFromSource(content, indexed[1], indexed);

  assert.equal(indexed[1].sourceStart, content.indexOf('11. Confidence'));
  assert.ok(extracted?.startsWith('11. Confidence\nPrinciple'));
  assert.ok(!extracted?.includes('21. The Master'));
}

{
  const makePrincipleTopic = (heading: string) => [
    heading,
    'Principle',
    `${heading} principle text has enough source prose for deterministic indexing. It must stay attached to its numbered heading.`,
    'Interpretation',
    `${heading} interpretation text continues with enough normal sentences to score as body text.`,
  ].join('\n');

  const content = [
    'Contents',
    'Reality in an unfamiliar guise',
    'Topics 1-10',
    '1. Awakening',
    '11. Confidence',
    '21. The Master',
    '',
    'Reality in an unfamiliar guise',
    chapterBody('Reality in an unfamiliar guise'),
    '',
    'Transurfing Principles',
    makePrincipleTopic('1. Awakening'),
    '',
    makePrincipleTopic('11. Confidence'),
    '',
    makePrincipleTopic('21. The Master'),
  ].join('\n');

  const chapters: Chapter[] = [
    { id: 1, title: 'Reality in an unfamiliar guise' },
    { id: 2, title: 'Topics 1-10' },
    { id: 3, title: 'Topics 11-20' },
    { id: 4, title: 'Topics 21-30' },
  ];
  const indexed = buildSourceIndexedChapters(content, chapters);
  const reality = extractChapterFromSource(content, indexed[0], indexed);
  const firstChunk = extractChapterFromSource(content, indexed[1], indexed);
  const secondChunk = extractChapterFromSource(content, indexed[2], indexed);

  assert.equal(indexed[1].sourceHeading, '1. Awakening');
  assert.equal(indexed[2].sourceHeading, '11. Confidence');
  assert.ok(reality?.startsWith('Reality in an unfamiliar guise begins'));
  assert.ok(!reality?.includes('1. Awakening'));
  assert.ok(firstChunk?.startsWith('1. Awakening\nPrinciple'));
  assert.ok(secondChunk?.startsWith('11. Confidence\nPrinciple'));
}

{
  const makePrincipleTopic = (index: number) => [
    `${index}. Topic ${index}`,
    'Principle',
    `Topic ${index} principle text has enough source prose for deterministic chunking. It must stay attached to its numbered heading.`,
    'Interpretation',
    `Topic ${index} interpretation text continues with enough normal sentences to score as body text.`,
  ].join('\n');

  const content = [
    'Introduction',
    chapterBody('Introduction'),
    '',
    'Transurfing Principles',
    Array.from({ length: 21 }, (_, index) => makePrincipleTopic(index + 1)).join('\n\n'),
  ].join('\n');

  const initialChapters: Chapter[] = [
    { id: 1, title: 'Introduction' },
    { id: 2, title: 'Transurfing Principles' },
  ];

  const indexed = buildSourceIndexedChapters(content, initialChapters);
  const chunked = expandTopicSectionsIntoChapters(content, indexed, 10);
  const reindexed = buildSourceIndexedChapters(content, chunked);

  assert.deepEqual(reindexed.map(chapter => chapter.title), [
    'Introduction',
    'Topics 1-10',
    'Topics 11-20',
    'Topic 21',
  ]);
  assert.equal(reindexed[1].sourceHeading, '1. Topic 1');
  assert.equal(reindexed[2].sourceHeading, '11. Topic 11');
  assert.equal(reindexed[3].sourceHeading, '21. Topic 21');
  assert.ok(extractChapterFromSource(content, reindexed[1], reindexed)?.startsWith('1. Topic 1\nPrinciple'));
  assert.ok(!extractChapterFromSource(content, reindexed[1], reindexed)?.includes('11. Topic 11'));
}

{
  const content = [
    'Contents',
    'The Signal ........ 5',
    'Deep Work ........ 12',
  ].join('\n');

  const chapters: Chapter[] = [
    { id: 1, title: 'The Signal' },
    { id: 2, title: 'Deep Work' },
  ];
  const indexed = buildSourceIndexedChapters(content, chapters);

  assert.equal(indexed[0].sourceStart, undefined, 'TOC-only content should fail closed');
  assert.equal(extractChapterFromSource(content, indexed[0], indexed), null);
}

{
  // A standalone "Index" back-matter section has a TOC-like body (terms + page
  // numbers). It must still resolve as its own chapter, not be swallowed by the
  // preceding Notes chapter.
  const content = [
    'Chapter 1: The First',
    chapterBody('Chapter one'),
    '',
    'Chapter 2: The Second',
    chapterBody('Chapter two'),
    '',
    'NOTES',
    '1. First note here. 2. Second note here. 3. Third note about a topic.',
    '',
    'INDEX',
    'Abu-Lughod, Janet, 213, 215',
    'Africa, 388',
    'Afro-Americans, 317',
    '',
    'Copyright',
    'All rights reserved.',
  ].join('\n');

  const chapters: Chapter[] = [
    { id: 1, title: 'Chapter 1: The First' },
    { id: 2, title: 'Chapter 2: The Second' },
    { id: 3, title: 'Notes' },
    { id: 4, title: 'Index' },
    { id: 5, title: 'Copyright' },
  ];
  const indexed = buildSourceIndexedChapters(content, chapters);
  const index = indexed.find(c => c.title === 'Index')!;
  const notes = indexed.find(c => c.title === 'Notes')!;

  assert.equal(typeof index.sourceStart, 'number', 'Index section must resolve to its own source range');
  const indexText = extractChapterFromSource(content, index, indexed) || '';
  assert.ok(indexText.startsWith('Abu-Lughod'), 'Index chapter should start at the index entries');
  const notesText = extractChapterFromSource(content, notes, indexed) || '';
  assert.ok(!notesText.includes('Abu-Lughod'), 'Notes chapter must not swallow the Index entries');
}

{
  // When structure analysis omits "Index", the preceding Notes chapter runs to the
  // end and swallows the index. splitDetectedBackMatter must split it back out.
  const content = [
    'Chapter 1: The First',
    chapterBody('Chapter one'),
    '',
    'NOTES',
    '1. First note here. 2. Second note about a topic.',
    '',
    'INDEX',
    'A note about the index: page numbers refer to the print edition and are clickable.',
    'Abu-Lughod, Janet, 213, 215',
    'Africa, 388',
  ].join('\n');
  const chapters: Chapter[] = [
    { id: 1, title: 'Chapter 1: The First' },
    { id: 2, title: 'Notes' }, // note: no Index in the list
  ];
  const resolved = buildSourceIndexedChapters(content, chapters);
  const split = splitDetectedBackMatter(content, resolved);

  const index = split.find(c => c.title === 'Index');
  assert.ok(index, 'an Index chapter should be split off the Notes chapter');
  const indexText = extractChapterFromSource(content, index!, split) || '';
  assert.ok(indexText.includes('Abu-Lughod'), 'Index chapter should contain the index entries');
  const notes = split.find(c => c.title === 'Notes')!;
  const notesText = extractChapterFromSource(content, notes, split) || '';
  assert.ok(!notesText.includes('Abu-Lughod'), 'Notes chapter should no longer contain the index entries');
  assert.ok(!notesText.includes('A note about the index'), 'Notes chapter should end before the INDEX heading');
}

{
  // A chapter with no embedded index heading must be left untouched.
  const content = ['Chapter 1', chapterBody('Chapter one')].join('\n');
  const resolved = buildSourceIndexedChapters(content, [{ id: 1, title: 'Chapter 1' }]);
  const split = splitDetectedBackMatter(content, resolved);
  assert.equal(split.length, 1, 'chapters without an embedded index must not be split');
}

{
  // A chapter title that repeats as a running header on every page must still
  // resolve to the real "CHAPTER N ..." heading, not a later running header — or
  // the chapter's opening (and its first footnotes) get absorbed into the previous
  // chapter.
  const content = [
    'CHAPTER 4 THE LAST DAYS OF POLITICS',
    chapterBody('Chapter four'),
    '',
    'CHAPTER 5 THE LIFE AND DEATH OF THE NATION-STATE Democracy and Nationalism as Resource Strategies in the Age of Violence',
    'The opening sentence of chapter five begins its first real paragraph of prose content here.',
    'It continues with several more sentences so the body reads as genuine chapter prose rather than a list.',
    '',
    'The Life and Death of the Nation-State',
    'The fall of the Berlin Wall was more than a visible symbol; it marked a turning point discussed here.',
    'A second paragraph of prose continues the chapter past the running-header page break with more text.',
    '',
    'CHAPTER 6 THE MEGAPOLITICS OF THE INFORMATION AGE',
    chapterBody('Chapter six'),
  ].join('\n');
  const chapters: Chapter[] = [
    { id: 1, title: 'Chapter 4: The Last Days of Politics' },
    { id: 2, title: 'The Life and Death of the Nation-State' }, // title only, matches running headers too
    { id: 3, title: 'Chapter 6: The Megapolitics of the Information Age' },
  ];
  const out = buildSourceIndexedChapters(content, chapters);
  const ch5Text = extractChapterFromSource(content, out[1], out) || '';
  const ch4Text = extractChapterFromSource(content, out[0], out) || '';
  assert.ok(ch5Text.includes('opening sentence of chapter five'), 'Chapter 5 must resolve at its real heading, not a later running header');
  assert.ok(!ch4Text.includes('opening sentence of chapter five'), 'Chapter 4 must not absorb Chapter 5\'s opening');
}

{
  // Endnotes are commonly grouped under per-chapter labels inside the Notes
  // section, e.g. "Chapter 4: ...\n1. Author... 2. ...". Such a label is a
  // "Chapter N" heading and would otherwise win the same +50 bonus the real
  // chapter heading gets — resolving Chapter 4 into the back matter, swallowing
  // the chapters in between and leaving Notes itself unlocatable. The real
  // chapter (prose body) must win; the Notes label must not.
  // The real chapter heading is title-only (the "Chapter N" marker did not survive
  // extraction), while the Notes label carries the marker — so absent the fix the
  // label, not the real heading, wins the +50 "Chapter N" bonus.
  const content = [
    'The Reckoning',
    chapterBody('Chapter four'),
    '',
    'The Aftermath',
    chapterBody('Chapter five'),
    '',
    'NOTES',
    'Chapter 4. The Reckoning',
    '1. Smith, John, A History of Things (Press, 1999), 12.',
    '2. Jones, Mary, "An Article Title," Journal 4 (2001): 33.',
    '3. Ibid., 41.',
    '4. Doe, Jane, Another Book (Press, 2003), 88.',
    '',
    'INDEX',
    'Aardvark, 12',
    'Zebra, 88',
  ].join('\n');
  const chapters: Chapter[] = [
    { id: 1, title: 'The Reckoning' },
    { id: 2, title: 'The Aftermath' },
    { id: 3, title: 'Notes' },
    { id: 4, title: 'Index' },
  ];
  const out = buildSourceIndexedChapters(content, chapters);
  const ch4 = out.find(c => c.title === 'The Reckoning')!;
  const ch4Text = extractChapterFromSource(content, ch4, out) || '';
  assert.ok(ch4Text.includes('Chapter four begins with a real paragraph'),
    'Chapter 4 must resolve to its real prose body, not the Notes group label');
  assert.ok(!ch4Text.includes('Smith, John, A History of Things'),
    'Chapter 4 must not resolve into the Notes section');

  const notes = out.find(c => c.title === 'Notes')!;
  assert.equal(typeof notes.sourceStart, 'number', 'Notes chapter must remain locatable');
  const notesText = extractChapterFromSource(content, notes, out) || '';
  assert.ok(notesText.includes('Smith, John, A History of Things'),
    'Notes chapter should contain the grouped endnotes');
}

console.log('sourceIndex regression tests passed');

{
  // Phase A: build chapters directly from a PDF outline (bookmarks). Page destinations
  // map to "[[PAGE n]]" offsets; each chapter runs to the next; order is by offset.
  const content = [
    '[[PAGE 1]]', 'Cover', '',
    '[[PAGE 2]]', 'Chapter One', chapterBody('Chapter one'), '',
    '[[PAGE 5]]', 'Chapter Two', chapterBody('Chapter two'), '',
    '[[PAGE 9]]', 'Notes', '1. A note here about something.',
  ].join('\n');
  const outline = [
    { title: 'Cover', page: 1, level: 0 },
    { title: 'Chapter One', page: 2, level: 0 },
    { title: 'Chapter Two', page: 5, level: 0 },
    { title: 'Notes', page: 9, level: 0 },
  ];
  assert.equal(isUsablePdfOutline(content, outline), true, 'a 4-entry resolvable outline is usable');
  assert.equal(isUsablePdfOutline(content, []), false, 'empty outline is not usable');
  assert.equal(isUsablePdfOutline(content, [{ title: 'Cover', page: 1, level: 0 }]), false, 'a 1-entry outline is not usable');

  const chapters = buildChaptersFromOutline(content, outline);
  assert.equal(chapters.length, 4, 'one chapter per resolvable outline entry');
  assert.deepEqual(chapters.map(c => c.title), ['Cover', 'Chapter One', 'Chapter Two', 'Notes']);
  assert.equal(chapters[0].sourceStart, content.indexOf('[[PAGE 1]]'), 'chapter starts at its page marker');
  assert.equal(chapters[1].sourceStart, content.indexOf('[[PAGE 2]]'));
  assert.equal(chapters[1].sourceEnd, content.indexOf('[[PAGE 5]]'), 'chapter ends where the next begins');
  assert.equal(chapters[3].sourceEnd, content.length, 'last chapter runs to the end');
  assert.ok(chapters.every((c, i) => i === 0 || c.sourceStart! > chapters[i - 1].sourceStart!), 'offsets are strictly increasing');
  assert.equal(chapters[0].sourceMethod, 'outline');

  // Missing page marker (e.g. an image-only page) falls back to the nearest following page.
  const gap = ['[[PAGE 1]]', 'A', '', '[[PAGE 4]]', 'B body text here.', '', '[[PAGE 7]]', 'C body text here.'].join('\n');
  const gapCh = buildChaptersFromOutline(gap, [
    { title: 'A', page: 1, level: 0 }, { title: 'B', page: 3, level: 0 }, { title: 'C', page: 7, level: 0 },
  ]);
  assert.equal(gapCh[1].sourceStart, gap.indexOf('[[PAGE 4]]'), 'page 3 (no marker) resolves to nearest following page 4');

  // Multiple bookmarks on one text page collapse to the first (page-granularity).
  const same = ['[[PAGE 1]]', 'Intro', '', '[[PAGE 2]]', 'Lesson one and two share this page.'].join('\n');
  const sameCh = buildChaptersFromOutline(same, [
    { title: 'Intro', page: 1, level: 0 }, { title: 'Lesson 1', page: 2, level: 0 }, { title: 'Lesson 2', page: 2, level: 0 },
  ]);
  assert.equal(sameCh.length, 2, 'two bookmarks on the same page collapse to one chapter');
  assert.equal(sameCh[1].title, 'Lesson 1', 'the first bookmark on the shared page wins');

  // An image-only front-matter page (a title page/cover with no extractable text — only a
  // page marker) is dropped, not surfaced as a chapter that errors with SOURCE_REQUIRED.
  const frontMatter = ['[[PAGE 1]]', '[[PAGE 2]]', 'The real first chapter body begins here.', '', '[[PAGE 3]]', 'Second chapter body text here.'].join('\n');
  const fmCh = buildChaptersFromOutline(frontMatter, [
    { title: 'Title Page', page: 1, level: 0 },
    { title: 'Chapter 1', page: 2, level: 0 },
    { title: 'Chapter 2', page: 3, level: 0 },
  ]);
  assert.deepEqual(fmCh.map(c => c.title), ['Chapter 1', 'Chapter 2'], 'an image-only title page (no text) is not a chapter');
  assert.ok(fmCh.every((c, i) => c.id === i + 1), 'survivors are renumbered from 1');
}

{
  // Phase A — Y-resolved heading offsets: when outline entries carry an explicit `offset`
  // (resolved from the bookmark's Y during extraction), it is preferred over the page
  // marker, so multiple bookmarks on the same text page no longer collapse.
  const content = [
    '[[PAGE 28]]', 'Transurfing Principles', 'Intro line for principles here.',
    '1. Awakening', 'Body of awakening lesson goes here with enough words.',
    '2. Hacking the Dream', 'Body of the hacking lesson goes here with words.',
  ].join('\n');
  const oStart = content.indexOf('1. Awakening');
  const oTwo = content.indexOf('2. Hacking the Dream');
  const chapters = buildChaptersFromOutline(content, [
    { title: 'Transurfing Principles', page: 28, level: 0, offset: content.indexOf('Transurfing Principles') },
    { title: '1. Awakening', page: 28, level: 0, offset: oStart },
    { title: '2. Hacking the Dream', page: 28, level: 0, offset: oTwo },
  ]);
  assert.equal(chapters.length, 3, 'distinct Y-resolved offsets keep same-page bookmarks separate');
  assert.equal(chapters[1].sourceStart, oStart, 'chapter starts at its Y-resolved heading offset, not the page top');
  assert.equal(chapters[1].sourceEnd, oTwo);
  assert.deepEqual(chapters.map(c => c.title), ['Transurfing Principles', '1. Awakening', '2. Hacking the Dream']);
}

// findHeadingOffsetByTitle must resolve a chapter title emitted as a markdown LINK
// "[The World Before Brains](#pdfref-…)" (its Contents back-link) — the bracket wrapping made real PDF/EPUB
// openers unfindable, dropping the chapter to a figure-cluster fallback (title absorbed into the previous
// chapter). Also: a "N: Title" bookmark separator, and the number on its own line above the title.
{
  const content = [
    'Contents',
    '    [1: The World Before Brains](#pdfref-a)',
    '    [Introduction](#pdfref-b)',
    '',
    '[[PAGE 29]]',
    '            **1**',
    '',
    '            [The World Before Brains](#pdfref-p7)',
    '',
    'LIFE EXISTED ON Earth for a long time and this chapter has plenty of lowercase prose so the real opener passes the prose gate and is distinguished from the table of contents entry above it.',
  ].join('\n');
  const off = findHeadingOffsetByTitle(content, '1: The World Before Brains', 0);
  assert.ok(off != null, 'a link-wrapped chapter title is found, not undefined');
  assert.ok(content.slice(off!).includes('LIFE EXISTED'), 'anchors the real opener (prose follows), not the Contents entry');
  assert.ok(content.slice(0, off!).lastIndexOf('Contents') === content.indexOf('Contents'), 'offset is AFTER the Contents list, not on the TOC line');
}

// A chapter title that WRAPS across two display lines is emitted as TWO adjacent markdown links, so between
// two of its words sits a link SEAM "](#pdfref-p7)\n\n   [" (BHI ch.6 "The Evolution of Temporal Difference"
// | "Learning"). The href content broke the word-gap → the opener was unfindable → ch.5 swallowed ch.6.
{
  const content = [
    'Contents',
    '    [6: The Evolution of Temporal Difference Learning](#pdfref-p114)',
    '',
    '[[PAGE 114]]',
    '            **6**',
    '',
    '       [The Evolution of Temporal Difference](#pdfref-p7)',
    '',
    '            [Learning](#pdfref-p7)',
    '',
    'THE FIRST REINFORCEMENT learning computer algorithm was built in 1951 and this opener has ample lowercase prose so it passes the prose gate and is not mistaken for the table of contents entry above.',
  ].join('\n');
  const off = findHeadingOffsetByTitle(content, '6: The Evolution of Temporal Difference Learning', 0);
  assert.ok(off != null, 'a title split across two link-wrapped lines is found (mid-title link seam crossed)');
  assert.ok(content.slice(off!).includes('THE FIRST REINFORCEMENT'), 'anchors the real ch.6 opener, not the Contents entry');
}

// The LAST wrapped line is often emphasised, so the title ends "…Breakthrough**](#pdfref-p8)": the closing
// "**" sits between the final word and the link-close bracket (BHI "Conclusion: The Sixth Breakthrough").
{
  const content = [
    'Contents',
    '    [Conclusion: The Sixth Breakthrough](#pdfref-p364)',
    '',
    '[[PAGE 364]]',
    '            [Conclusion](#pdfref-p8)',
    '',
    '            [**The Sixth Breakthrough**](#pdfref-p8)',
    '',
    'WITH THE EMERGENCE of the modern human brain in our ancestors, we have reached the conclusion of our long evolutionary story and this opener has plenty of lowercase prose to pass the gate.',
  ].join('\n');
  const off = findHeadingOffsetByTitle(content, 'Conclusion: The Sixth Breakthrough', 0);
  assert.ok(off != null, 'a title whose final wrapped segment is emphasised (**word**](href)) is found');
  assert.ok(content.slice(off!).includes('WITH THE EMERGENCE'), 'anchors the real Conclusion opener, not the Contents entry');
}

// A PART container heading numbers itself with a literal hash the body prints ("Breakthrough #3"), and its
// title wraps to a second link line. Both the "#" between the word and its number AND the link seam must be
// crossed, else every Part went unresolved → collapsed onto a figure-cluster fallback and grabbed the
// previous chapter's tail (BHI: Breakthrough #3's page opened with ch.9's Figure 9.3 + closing paragraph).
{
  const content = [
    'Contents',
    '    [Breakthrough #3: Simulating and the First Mammals](#pdfref-p165)',
    '',
    '[[PAGE 165]]',
    '[Breakthrough #3](#pdfref-p8)',
    '',
    '[Simulating and the First Mammals](#pdfref-p8)',
    '',
    'THE MAMMALS THAT scurried beneath the feet of dinosaurs evolved a new trick and this Part opener carries ample lowercase prose so it passes the prose gate rather than matching the contents list above it.',
  ].join('\n');
  const off = findHeadingOffsetByTitle(content, 'Breakthrough #3: Simulating and the First Mammals', 0);
  assert.ok(off != null, 'a "Breakthrough #N" Part heading (literal # + wrapped title) is found');
  assert.ok(content.slice(off!).includes('THE MAMMALS THAT'), 'anchors the real Part opener, not the Contents entry');
}
