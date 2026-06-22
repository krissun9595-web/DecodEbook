import assert from 'node:assert/strict';
import {
  detectPrincipleTopicPages,
  findTopicHeadingForExtractedText,
  findTopicHeadingAtOffset,
  findTopicHeadingBeforeOffset,
  normalizeNotesReaderText,
  paginateReaderText,
  paginatePlainText,
} from '../utils/readerStructure.ts';
import { splitIntoSentences } from '../utils/sentenceSplit.ts';
import { rearrangeAndCleanText } from '../utils/textCleanup.ts';
import {
  isBibleReferenceAtEnd,
  isBibleReferenceMarkerCandidate,
  isNumericTextMarkerCandidate,
  isStandaloneYearAtEnd,
} from '../utils/footnotes.ts';

const makeTopic = (index: number): string => [
  `${index}. Topic ${index}`,
  'Principle',
  `Principle text for topic ${index}. It stays with the topic heading.`,
  'Interpretation',
  `Interpretation text for topic ${index}. It must not be flattened into a neighboring topic.`,
].join('\n');

{
  const text = '1 The first note ends here. 2 The second note should become reachable. 3 The third note should also be reachable.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(normalized.includes('here.\n2 The second note'), 'plain flattened note 2 should receive a note line break');
  assert.ok(normalized.includes('reachable.\n3 The third note'), 'plain flattened note 3 should receive a note line break');
}

{
  const text = '[1](part0007_split_000.html#ch01en1). First linked note. [2](part0007_split_000.html#ch01en2). Second linked note.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(normalized.includes('note.\n[2](part0007_split_000.html#ch01en2). Second'), 'linked flattened note markers should receive a note line break');
}

{
  // A following note number glued to the previous note's terminal period
  // (e.g. "Ibid.12.", "op. cit.17.") must still start a new note line.
  const text = '11. Ibid.12. Durant, op. cit., p. 43. 13. Ramsay MacMullen, Corruption and the Decline of Rome (New Haven: Yale University Press, 1988), p. 192. 16. Lane, “Economic Consequences of Organized Violence,” op. cit.17. Ibid.18. Susan Ailing Gregg, Foragers and Farmers (Chicago: University of Chicago Press, 1988), p. 9.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(normalized.includes('Ibid.\n12. Durant'), 'note number glued after "Ibid." should start a new line');
  assert.ok(normalized.includes('op. cit.\n17. Ibid.'), 'note number glued after "op. cit." should start a new line');
  assert.ok(normalized.includes('Ibid.\n18. Susan'), 'note number glued after a second "Ibid." should start a new line');
  assert.ok(normalized.includes('p. 192.\n16. Lane'), 'space-separated notes should remain on their own lines');
}

{
  // A notes section heading with an italicized keyword ("<i>Chapter</i> 5" ->
  // "*Chapter* 5") must still be detected and split onto its own line, not merged
  // into the previous note.
  const text = '[68](x#ch04en68). Tilly, *op. cit.,* p. 20. [69](x#ch04en69). *Ibid.,* p. 22.\n\n*Chapter* 5. *The Life and Death of the Nation-State: Democracy and Nationalism*\n\n[1](x#ch05en1). Quoted in Tilly, *op. cit.,* p. 84.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(/p\. 22\.\n\nChapter 5\./.test(normalized), 'italicized "Chapter N" heading should split onto its own line after the previous note');
  assert.ok(/Nationalism\*\n\n\[1\]/.test(normalized), 'the next chapter\'s notes should start on their own line after the heading');
}

{
  // A page label italicized through the page number boundary ("*op. cit., p.* 173")
  // must still be recognized so the page number isn't misread as the next note's
  // marker (which split the note and broke the following footnote's link).
  const text = '[32](x#ch11en32). Hirshleifer, *op. cit., p.* 173. [33](x#ch11en33). Tanzi, *op. cit.,* pp. 167, 170.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(/p\.\* 173\.\n\[33\]/.test(normalized), 'an italicized "p." page label must keep its page number, not start a new note at it');
  assert.ok(!/p\.\*\n173/.test(normalized), 'the page number must not be split onto its own line');
}

{
  // Notes/index are item-per-line: pagination must break between items, not mid-item
  // (e.g. inside "op. cit." or after an initial like "V.H.").
  const notes = Array.from({ length: 20 }, (_, i) =>
    `[${i + 80}](x#en${i + 80}). See V.H. Atrill, How All Economies Work (Calgary, Canada: Dimensionless Science Publications, ${1979 + i}), p. 27f.`
  ).join('\n');
  const pages = paginatePlainText(notes, 200, false, true);
  assert.ok(pages.every(p => !/V\.H\.$/.test(p.text.trim())), 'pages must not end mid-note at "V.H."');
  // Same content without the flag is allowed to break mid-note (proves the flag matters).
  const naive = paginatePlainText(notes, 200, false, false);
  assert.ok(naive.some(p => /V\.H\.$/.test(p.text.trim())), 'sanity: without preferLineBreaks pagination does break mid-note');
}

{
  // An italic span (e.g. a blockquote) covering several sentences must keep each
  // sentence individually wrapped after splitting, or the quote renders plain.
  const quote = '*“It feels like something big is about to happen. They all soar up to an asymptote. The end of everything we know. The beginning of something we may never understand.”*[1](x#ch01-en1)';
  const parts = splitIntoSentences(quote);
  assert.ok(parts.length >= 3, 'the multi-sentence quote should split into several sentences');
  parts.forEach(p => {
    const stars = (p.replace(/\[[^\]]*\]\([^)]*\)/g, '').match(/\*/g) || []).length;
    assert.equal(stars % 2, 0, `each quote sentence must have balanced italic markers: ${JSON.stringify(p)}`);
    assert.ok(p.trimStart().startsWith('*'), `each quote sentence must stay italic: ${JSON.stringify(p)}`);
  });
}

{
  // An italic title whose period sits inside the span ("*The Great Reckoning.*")
  // leaves the closing "*" orphaned on the next sentence; the rebalancer must move it
  // back, not combine it with a reopened marker into "**" (which turned text bold).
  const para = '*The Sovereign Individual* builds on *Blood in the Streets* and *The Great Reckoning.* Like those books, it does more.';
  const parts = splitIntoSentences(para);
  assert.ok(parts.some(p => /\*The Great Reckoning\.\*/.test(p)), 'the italic title keeps its own balanced markers');
  parts.forEach(p => assert.ok(!/\*\*/.test(p), `no sentence should gain bold "**": ${JSON.stringify(p)}`));
  assert.ok(parts.some(p => /^\s*Like those books/.test(p)), 'the following sentence stays plain');
}

{
  // A stray (unbalanced overall) marker must NOT be "balanced" into wrapping the rest.
  const stray = 'The formula a * b is shown. Then we compute the result here.';
  assert.deepEqual(splitIntoSentences(stray), ['The formula a * b is shown.', 'Then we compute the result here.'],
    'a stray asterisk must not be turned into an emphasis span');
}

{
  // "no. N" inside a citation (a journal issue: "vol. 1, no. 1") is not a note start
  // and must not truncate the note.
  const text = '[27](x#en27). Quoted by West, *op. cit.,* p. 58; see also Williamson, *Journal of Economic Behaviour,* vol. 1, no. 1. [28](x#en28). Next note, op. cit., p. 5.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(/vol\. 1, no\. 1\.\n\[28\]/.test(normalized), '"no. 1" in a citation must stay inside its note');
  assert.ok(!/\nno\. 1\./.test(normalized), '"no. 1" must not become its own line');
}

{
  // A book title containing "Introduction" ("An Introduction to the Principles...")
  // must not be mistaken for an inline section heading and split with blank lines.
  const text = '[16](x#en16). Prior note, op. cit., p. 1.\n[17](x#en17). Jeremy Bentham, *An Introduction to the Principles of Morals and Legislation,* J. H. Burns and H. L. A. Hart, eds. (London: Methuen, 1982), p. 296, cited by Billig, *op. cit.,* p. 84.\n[18](x#en18). Next, op. cit., p. 5.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(/Bentham, \*An Introduction to the Principles/.test(normalized), 'the italic book title must stay on one line');
  assert.ok(!/\*An\n/.test(normalized), '"An" and "Introduction" must not be split by a blank line');
  // But a genuine inline section heading after a note IS still set off.
  const heading = 'Some note ends here. Chapter 5. The Title Of The Chapter 1. First note of chapter five here.';
  assert.ok(/here\.\n\nChapter 5\. The Title Of The Chapter\n\n1\. First note/.test(normalizeNotesReaderText(heading)),
    'a real inline "Chapter N" heading should still be separated with blank lines');
}

{
  // Guard against false positives: decimals and page refs must not gain note breaks.
  assert.equal(normalizeNotesReaderText('The ratio was 3.14 in the study and held steady.'),
    'The ratio was 3.14 in the study and held steady.', 'decimals must not be split into note lines');
}

{
  // Real EPUB shape (The Sovereign Individual endnotes): a note whose final element
  // is italic ends with a markdown "*" (e.g. "*Ibid.*", "*op. cit.*"). The trailing
  // emphasis marker must not cause the NEXT note marker to be treated as running text.
  const text = '[11](x.html#ch02en11). *Ibid.* [12](x.html#ch02en12). Durant, *op. cit.,* p. 43. [13](x.html#ch02en13). Ramsay MacMullen, *Corruption and the Decline of Rome* (New Haven: Yale University Press, 1988), p. 192. [16](x.html#ch02en16). Lane, “Economic Consequences of Organized Violence,” *op. cit.* [17](x.html#ch02en17). *Ibid.* [18](x.html#ch02en18). Susan Ailing Gregg, Foragers (Chicago, 1988), p. 9.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(normalized.includes('*Ibid.*\n[12]'), 'note after an italic-ending "*Ibid.*" should start a new line');
  assert.ok(normalized.includes('*op. cit.*\n[17]'), 'note after an italic-ending "*op. cit.*" should start a new line');
  assert.ok(normalized.includes('*Ibid.*\n[18]'), 'note after a second italic-ending "*Ibid.*" should start a new line');
  assert.ok(normalized.includes('p. 192.\n[16]'), 'period-ending notes must still break normally');
}

{
  // Principled rule: a linked/bracketed marker is explicit note notation, so it must
  // start a new line regardless of how the PREVIOUS note ended — including an italic
  // term with a trailing comma ("*op. cit.,*" -> ",*") or a missing final period.
  const text = '[14](x.html#ch03en14). See Bois, *op. cit.,* [15](x.html#ch03en15). See Frances and Joseph Gies, *Cathedral, Forge, and Waterwheel* (New York: HarperCollins, 1994), p. 40. [25](x.html#ch03en25). *Ibid.,* p. 150 [26](x.html#ch03en26). Gies, *op. cit.,* p. 2.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(normalized.includes('*op. cit.,*\n[15]'), 'note after italic term + trailing comma must start a new line');
  assert.ok(normalized.includes('p. 150\n[26]'), 'note after a missing-period entry must start a new line');
}

{
  // Bare numbers in running prose must still NOT be treated as note starts.
  const prose = 'The army grew rapidly. By 1850 the force had 12 divisions and kept expanding for years.';
  assert.equal(normalizeNotesReaderText(prose), prose, 'bare prose numbers must not be split into note lines');
}

{
  const text = '*Chapter 1. The Transition of the Year 2000: The Fourth Stage of Human Society* [1](part0007_split_000.html#ch01en1). Danny Hillis, “The Millennium Clock,” Wired, Special Edition, Fall 1995, p. 48. [2](part0007_split_001.html#ch01en2). Ericka Cheetham, The Final Prophecies of Nostradamus, p. 424.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(
    normalized.includes('Society*\n\n[1](part0007_split_000.html#ch01en1). Danny'),
    'italic notes section heading should split before the first linked note'
  );
  assert.ok(
    normalized.includes('p. 48.\n[2](part0007_split_001.html#ch01en2). Ericka'),
    'second linked note should still receive a note line break after first-note splitting'
  );
}

{
  const note = '[1](part0023_split_001.html#ch01-en1). Danny Hillis, “The Millennium Clock,” Wired, Special Edition, Fall 1995, p. 48.';
  assert.deepEqual(splitIntoSentences(note), [note], 'bibliographic p. locator should stay inside one note sentence');
}

{
  // A markdown footnote/reference link glued to a sentence-ending period must NOT be
  // torn across the segmentation boundary, or it renders as raw "[ II](...html#ch01fn2)".
  const romanFootnote = 'Adam Smith and Karl Marx, who died before almost everyone now living was born.[ II](part0007split010.html#ch01fn2) The industrial worldview is still the commonsense intuition.';
  assert.deepEqual(splitIntoSentences(romanFootnote), [
    'Adam Smith and Karl Marx, who died before almost everyone now living was born.[ II](part0007split010.html#ch01fn2)',
    'The industrial worldview is still the commonsense intuition.',
  ], 'roman footnote link must stay intact and attach to its sentence');

  const numericFootnote = 'He paused for breath.[3](part01.html#fn3) She walked away without a word.';
  assert.deepEqual(splitIntoSentences(numericFootnote), [
    'He paused for breath.[3](part01.html#fn3)',
    'She walked away without a word.',
  ], 'numeric footnote link must stay intact and attach to its sentence');

  const lowercaseAfter = 'It was over.[ IV](c.html#fn4) the lowercase continues here.';
  assert.deepEqual(splitIntoSentences(lowercaseAfter), [lowercaseAfter],
    'reconstituted link with no following capital should remain a single intact sentence');
}

{
  const text = [
    '*“The beginning of something we may never understand.”*[1](part0023_split_001.html#ch01-en1)',
    '',
    '—— DANNY HILLIS*',
  ].join('\n');
  const cleaned = rearrangeAndCleanText(text);
  assert.ok(
    cleaned.includes('*“The beginning of something we may never understand.”*[1](part0023_split_001.html#ch01-en1)'),
    'citation cleanup must preserve linked footnote 1 outside italic markup'
  );
}

{
  const text = '—— MICHAEL GRASSO[4](part0023_split_001.html#ch01-en4)*';
  const cleaned = rearrangeAndCleanText(text);
  assert.equal(
    cleaned,
    '—— MICHAEL GRASSO[4](part0023_split_001.html#ch01-en4)',
    'attribution cleanup must preserve linked footnote 4'
  );
}

{
  const text = [
    '[1](part0023_split_001.html#ch01-en1). Danny Hillis, “The Millennium Clock,” Wired, Special Edition, Fall 1995, p.',
    '48.',
    '[2](part0023_split_001.html#ch01-en2). Ericka Cheetham, The Final Prophecies of Nostradamus (New York: Putnam, 1989), p.',
    '424.',
  ].join('\n');
  const normalized = normalizeNotesReaderText(text);
  assert.ok(normalized.includes('p. 48.'), 'hard line break inside p. 48 should collapse to a space');
  assert.ok(normalized.includes('p. 424.'), 'hard line break inside p. 424 should collapse to a space');
  assert.ok(
    normalized.includes('48.\n[2](part0023_split_001.html#ch01-en2)'),
    'single newline before linked note 2 should remain a note line break'
  );
}

{
  const text = '7. James George Frazer, The Golden Bough: A Study in Magic and Religion (New York: Macmillan, 1951), p.\n105.';
  const normalized = normalizeNotesReaderText(text);
  assert.equal(
    normalized,
    '7. James George Frazer, The Golden Bough: A Study in Magic and Religion (New York: Macmillan, 1951), p. 105.',
    'single extracted note entries should collapse hard line breaks inside bibliographic locators'
  );
}

{
  const normalized = normalizeNotesReaderText('Chapter 1. The Transition of the Year 2000: The Fourth Stage of Human Society 1. Danny Hillis, “The Millennium Clock,” Wired, Special Edition, Fall 1995, p. 48.');
  assert.equal(
    normalized,
    'Chapter 1. The Transition of the Year 2000: The Fourth Stage of Human Society\n\n1. Danny Hillis, “The Millennium Clock,” Wired, Special Edition, Fall 1995, p. 48.'
  );
}

{
  const text = [
    '9. The German GPI index stood at 33. on December 31, 1948, and 112. on June 30, 1995, which represents a compound annual depreciation of 2. percent. The U.S. CPI stood at',
    '',
    '24 on December 31, 1948, and 152. on June 30, 1995. The cumulative U.S. inflation was',
    '',
    '635 percent for the period.',
    '',
    '10. The next note starts here.',
  ].join('\n');
  const normalized = normalizeNotesReaderText(text);
  assert.ok(
    normalized.includes('The U.S. CPI stood at 24 on December 31, 1948'),
    'blank lines inside note 9 should collapse before 24'
  );
  assert.ok(
    normalized.includes('inflation was 635 percent for the period.'),
    'blank lines inside note 9 should collapse before 635'
  );
  assert.ok(
    normalized.includes('period.\n10. The next note starts here.'),
    'the next note marker should remain a note line break'
  );
}

{
  const text = '43. Boyden, op. cit., p. 118. Chapter 4. The Last Days of Politics: Parallels Between the Senile Decline of the Holy Mother Church and the Nanny State 1. Clarke, op. cit., p. 9. 2. Martin van Creveld, The Transformation of War (New York: The Free Press, 1991), p. 52.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(
    normalized.includes('43. Boyden, op. cit., p. 118.\n\nChapter 4. The Last Days of Politics'),
    'embedded chapter notes heading should become its own paragraph'
  );
  assert.ok(
    normalized.includes('Nanny State\n\n1. Clarke, op. cit., p. 9.\n2. Martin van Creveld'),
    'chapter-scoped note numbering should restart after the notes heading with single-line note spacing'
  );
}

{
  const normalized = normalizeNotesReaderText('19. Ibid. 20. Ibid., p. 128.');
  assert.equal(normalized, '19. Ibid.\n20. Ibid., p. 128.');
}

{
  const normalized = normalizeNotesReaderText('11.\u00a0Ibid.\u00a012.\u00a0Durant, op. cit., p. 43.');
  assert.equal(
    normalized,
    '11. Ibid.\n12. Durant, op. cit., p. 43.',
    'non-breaking spaces between flattened notes should still become line breaks'
  );
}

{
  const normalized = normalizeNotesReaderText('11.Ibid. 12.Durant, op. cit., p. 43.');
  assert.equal(
    normalized,
    '11. Ibid.\n12. Durant, op. cit., p. 43.',
    'compact flattened notes without spaces after note numbers should still split'
  );
}

{
  const text = '[I](part0007_split_004.html#ch01-fn1). Local note. [II](part0007_split_004.html#ch01-fn2). Second local note.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(normalized.includes('note.\n[II](part0007_split_004.html#ch01-fn2). Second'), 'roman linked note markers should receive a note line break');
}

{
  const text = '[ I] (part0007_split_004.html#ch01-fn1). Local note. [ II] (part0007_split_010.html#ch01-fn2). Second local note.';
  const normalized = normalizeNotesReaderText(text);
  assert.ok(
    normalized.includes('note.\n[ II] (part0007_split_010.html#ch01-fn2). Second'),
    'spaced roman internal links should still be recognized as note boundaries'
  );
}

{
  const cleaned = rearrangeAndCleanText('The marker appears as [ II] (part0007_split_010.html#ch01-fn2). Adam Smith died in 1790.');
  assert.ok(
    cleaned.includes('[ II] (part0007_split_010.html#ch01-fn2). Adam Smith'),
    'cleanup should preserve malformed internal links for the renderer instead of stripping surrounding text'
  );
}

{
  const text = [
    'Principles Section',
    '',
    ...Array.from({ length: 12 }, (_, i) => makeTopic(i + 1)),
  ].join('\n\n');

  const pages = paginateReaderText(text, 100000, { topicsPerPage: 10 });
  assert.equal(pages.length, 2);
  assert.equal(pages[0].mode, 'principle-topic');
  assert.equal(pages[0].label, 'Topics 1-10');
  assert.equal(pages[1].label, 'Topics 11-12');

  const topicBlocks = pages[0].blocks.filter(block => block.type === 'principle-topic');
  assert.equal(topicBlocks.length, 10);
  const first = topicBlocks[0];
  assert.equal(first.type, 'principle-topic');
  assert.equal(first.title, 'Topic 1');
  assert.ok(first.principle.includes('Principle text for topic 1'));
  assert.ok(first.interpretation.includes('Interpretation text for topic 1'));
}

{
  const text = [
    'Principles Section',
    '',
    ...Array.from({ length: 12 }, (_, i) => makeTopic(i + 1)),
  ].join('\n\n');

  const pages = paginateReaderText(text, 360, { topicsPerPage: 10 });
  assert.ok(pages.length > 2, 'structured topics should still paginate by audiobook page size');
  assert.ok(
    pages.every(page => page.blocks.filter(block => block.type === 'principle-topic').length <= 3),
    'small page targets should not render all 10 topics as one page'
  );
}

{
  const text = [
    '1. First Topic',
    'Principle: Inline principle text.',
    'Interpretation: Inline interpretation text.',
    '',
    '2. Second Topic',
    'Principle: Another principle.',
    'Interpretation: Another interpretation.',
    '',
    '3. Third Topic',
    'Principle: Third principle.',
    'Interpretation: Third interpretation.',
  ].join('\n');

  const pages = detectPrincipleTopicPages(text, { topicsPerPage: 10 });
  assert.ok(pages);
  const blocks = pages![0].blocks.filter(block => block.type === 'principle-topic');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].principle, 'Inline principle text.');
  assert.equal(blocks[0].interpretation, 'Inline interpretation text.');
}

{
  const text = [
    '1',
    'First Standalone Number Topic',
    'Principle',
    'The topic title can appear after a standalone number.',
    'Interpretation',
    'The parser should still keep this topic together.',
    '',
    '2',
    'Second Standalone Number Topic',
    'Principle',
    'The second principle.',
    'Interpretation',
    'The second interpretation.',
    '',
    '3',
    'Third Standalone Number Topic',
    'Principle',
    'The third principle.',
    'Interpretation',
    'The third interpretation.',
  ].join('\n');

  const pages = detectPrincipleTopicPages(text);
  assert.ok(pages);
  const blocks = pages![0].blocks.filter(block => block.type === 'principle-topic');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].headingText, '1\nFirst Standalone Number Topic');
}

{
  const plain = [
    '1. This is a numbered paragraph, not a topic.',
    'It has ordinary prose but no labeled structure.',
    '2. This is another numbered paragraph.',
    'It should stay in the plain reader mode.',
  ].join('\n');

  const pages = paginateReaderText(plain, 100);
  assert.equal(pages[0].mode, 'plain');
}

{
  const text = [
    '1. First Topic',
    'Principle',
    'The first principle.',
    'Interpretation',
    'This interpretation includes a numbered list.',
    '1. Internal List Item',
    'The internal list text must stay inside the first topic.',
    '',
    '2. Second Topic',
    'Principle',
    'The second principle.',
    'Interpretation',
    'The second interpretation.',
    '',
    '3. Third Topic',
    'Principle',
    'The third principle.',
    'Interpretation',
    'The third interpretation.',
  ].join('\n');

  const pages = detectPrincipleTopicPages(text);
  assert.ok(pages);
  const blocks = pages![0].blocks.filter(block => block.type === 'principle-topic');
  assert.equal(blocks.length, 3);
  assert.ok(blocks[0].interpretation.includes('Internal List Item'));
  assert.ok(blocks[0].interpretation.includes('must stay inside the first topic'));
}

{
  const text = [
    '1. Soft Break Topic',
    'Principle',
    'The first principle.',
    'Interpretation',
    'So first, come down into the audience hall,',
    '',
    'take a good look around and wake up.',
    '',
    '2. Second Topic',
    'Principle',
    'The second principle.',
    'Interpretation',
    'The second interpretation.',
    '',
    '3. Third Topic',
    'Principle',
    'The third principle.',
    'Interpretation',
    'The third interpretation.',
  ].join('\n');

  const pages = detectPrincipleTopicPages(text);
  assert.ok(pages);
  const blocks = pages![0].blocks.filter(block => block.type === 'principle-topic');
  assert.ok(blocks[0].interpretation.includes('hall, take a good look'));
  assert.ok(!blocks[0].interpretation.includes('hall,\n\ntake'));
}

{
  const thankYou = 'When the definitive “History of the Thank-You Note Through the Ages” is\ncompiled, this whole book could well be an exhibit.';
  assert.deepEqual(splitIntoSentences(thankYou), [
    'When the definitive “History of the Thank-You Note Through the Ages” is compiled, this whole book could well be an exhibit.',
  ]);

  const informationAge = 'It is the third we have done\ntogether on various aspects of the great transformation to the Information Age\nnow under way.';
  assert.deepEqual(splitIntoSentences(informationAge), [
    'It is the third we have done together on various aspects of the great transformation to the Information Age now under way.',
  ]);
}

{
  const acknowledgementList = [
    'We also acknowledge the special friendship of Alan Lindsay; Brian, Donald,',
    'and Scott Lines; Robert Lloyd George; Jane Collis; Carter Beese; Andy Miller;',
    'Scott Hill; Nils Taube; Gilbert de Botton; Michael Geltner; Mark Ford; David',
    'Keating; Pete Sepp; Curtin Winsor, III; V. Harwood Bocker, III; Guillermo',
    'Cervino; Eduardo Maschwitz; Michael Reynal; Jorge Gamarci; Jackie Locke;',
    'Douglas Reid; Jose Pascar; Luis Kenny; Robert Lawrence, III; Ken Klein; Kim',
    'Saull; Jim Moloney; Mike Geltner; Lee Euler; Tom Crema; Nancy Lazar; Greg',
    'Barnhill; Becky Mangus; Nancy Oppenlander; Wayne Livingstone; Hans',
    'Kuppers; Michael Baybak; Allan Zschlag; David Hale; Lisa Eden; Mel Lieberman;',
    'Glenn Blaugh; Sir Roger Douglas; Michael Smorch; Jimmie Rogers; Ambrose',
    'Evans-Pritchard; Chris Wood; Marc Faber; Ronnie Chan; William F. Nicklin;',
    'Lenny Smith; Jack Wheeler; Jim Bennett; Gordon Tullock; Jay Bernstein; Gary',
    'Vernier; Jenny Mitchel; Julia Guth; Lisa Young; Mia; Mark Frasier; Lisa Bernard;',
    'Rita Smith; Ruth Lyons; Yarah Chiekh; Fabian Dilaimy; Tim Hoese; and our',
    'families.',
  ].join('\n');
  const split = splitIntoSentences(acknowledgementList);
  assert.equal(split.length, 1);
  assert.ok(split[0].includes('Ken Klein; Kim Saull; Jim Moloney'));
  assert.ok(split[0].endsWith('and our families.'));
}

{
  const pageBreakInsideList = [
    'Robert Lawrence, III; Ken Klein; Kim',
    '',
    'Saull; Jim Moloney; Mike Geltner;',
  ].join('\n');
  assert.equal(
    rearrangeAndCleanText(pageBreakInsideList),
    'Robert Lawrence, III; Ken Klein; Kim Saull; Jim Moloney; Mike Geltner;'
  );
}

{
  assert.equal(
    rearrangeAndCleanText('The argument continues across a page\n\nand should not become a new paragraph.'),
    'The argument continues across a page and should not become a new paragraph.'
  );
  assert.equal(
    rearrangeAndCleanText('The committee thanked Jane,\n\nwho had organized the archive.'),
    'The committee thanked Jane, who had organized the archive.'
  );
  assert.equal(
    rearrangeAndCleanText('In that sense, we should probably repeat all of our\n\nacknowledgments to the friends and accomplices who helped us in crucial ways in\n\nour two previous books.'),
    'In that sense, we should probably repeat all of our acknowledgments to the friends and accomplices who helped us in crucial ways in our two previous books.'
  );
  assert.equal(
    rearrangeAndCleanText([
      'The German GPI index stood at',
      '',
      '33. on December 31, 1948, and 112. on June 30, 1995, which represents a compound annual depreciation of 2. percent. The U.S. CPI stood at',
      '',
      '24 on December 31, 1948, and 152. on June 30, 1995. The cumulative U.S. inflation was',
      '',
      '635 percent for the period.',
    ].join('\n')),
    'The German GPI index stood at 33. on December 31, 1948, and 112. on June 30, 1995, which represents a compound annual depreciation of 2. percent. The U.S. CPI stood at 24 on December 31, 1948, and 152. on June 30, 1995. The cumulative U.S. inflation was 635 percent for the period.'
  );
  assert.equal(
    rearrangeAndCleanText('We are grateful to Elizabeth\n\nWarren for the introduction.'),
    'We are grateful to Elizabeth Warren for the introduction.'
  );
  assert.equal(
    rearrangeAndCleanText('This is a complete paragraph.\n\nThis is the next real paragraph.'),
    'This is a complete paragraph.\n\nThis is the next real paragraph.'
  );
  assert.equal(
    rearrangeAndCleanText('This section ends cleanly.\n\n11. Confidence\n\nPrinciple\nThe topic begins.'),
    'This section ends cleanly.\n\n11. Confidence\n\nPrinciple\n\nThe topic begins.'
  );
  assert.equal(
    rearrangeAndCleanText('The next day, move on to the next\nprinciple, remembering to practice the principles you have covered\npreviously.'),
    'The next day, move on to the next principle, remembering to practice the principles you have covered previously.'
  );
  assert.equal(
    rearrangeAndCleanText('For example, the neighbours’ music is driving you mad. Your task is to\n‘unhook’ from the situation.'),
    'For example, the neighbours’ music is driving you mad. Your task is to ‘unhook’ from the situation.'
  );
  assert.equal(
    rearrangeAndCleanText('This section ends cleanly.\n\nACKNOWLEDGMENTS\n\nThe thanks begin here.'),
    'This section ends cleanly.\n\nACKNOWLEDGMENTS\n\nThe thanks begin here.'
  );
}

{
  const transurfingIntro = [
    'Introduction',
    ' Message to the Master',
    '  Once, in the distant past, or perhaps it was the future (it is difficult to say',
    'for certain), the Universe forgot itself.',
    '  “Who am I?” Nothing asked itself.',
    '  “You are a Mirror... Mirror… Mirror...” Reflection responded in a',
    'gazillion flecks of light.',
    '  “Who are you?” Mirror asked.',
  ].join('\n');
  const cleaned = rearrangeAndCleanText(transurfingIntro);

  assert.ok(cleaned.includes('Introduction\n\nMessage to the Master\n\nOnce, in the distant past'));
  assert.ok(cleaned.includes('“Who am I?” Nothing asked itself.\n“You are a Mirror... Mirror… Mirror...” Reflection responded in a gazillion flecks of light.'));
  assert.ok(cleaned.includes('light.\n“Who are you?” Mirror asked.'));
}

{
  const flattenedParagraphStarts = [
    'The world was created in the dialogue between the Mirror, which we call',
    'God, and Reflection. Welcome, dear Master. I am writing you this message',
    'because you are reading these lines, which means you intend to become the',
    'ruler of your own world and destiny.',
    'In ancient times, everyone was a master inasmuch as they knew that there',
    'are two sides to reality: one physical, the other metaphysical. The masters',
    'saw and understood the nature of the mirror world. They knew how to',
    'create their own reality with the power of thought. Things did not stay that',
    'way for long though. With time, the masters’ attention became locked in',
    'material reality. They stopped being able to see and unlearned their power.',
    'Nonetheless, their knowledge was not lost. From the depths of time, it',
    'survived over millennia to the present day.',
  ].join('\n');
  const cleaned = rearrangeAndCleanText(flattenedParagraphStarts);

  assert.ok(cleaned.includes('ruler of your own world and destiny.\n\nIn ancient times, everyone was a master'));
  assert.ok(cleaned.includes('unlearned their power. Nonetheless, their knowledge was not lost.'));
}

{
  const sentence = 'The next day, move on to the next principle, remembering to practice the principles you have covered previously.';
  const pages = paginatePlainText(`Before. ${sentence} After.`, 92);
  assert.ok(
    pages.some(page => page.text.includes(sentence)),
    'nearby sentence endings should be preferred over splitting the Transurfing practice sentence'
  );
  assert.ok(
    !pages.some(page => /covere\s*$/.test(page.text)),
    'pagination must not leave a partial word at the end of a page'
  );
}

{
  const citation = 'Danny Hillis, “The Millennium Clock,” Wired, Special Edition, Fall 1995, p. 48.';
  const pages = paginatePlainText(`Before. ${citation} After.`, 72);
  assert.ok(
    pages.some(page => page.text.includes('p. 48.')),
    'pagination should not split a bibliographic p. locator from its page number'
  );
}

{
  const prefix = 'Filler sentence. '.repeat(14);
  const linkedNote = '[7](part0023_split_001.html#ch08-en7). Robert H. Frank and Philip J. Cook, The Winner-Take-All Society.';
  const text = `${prefix}\n${linkedNote}`;
  const markerEnd = text.indexOf('). Robert') + 2;
  const pages = paginatePlainText(text, markerEnd);
  assert.ok(
    !pages.some(page => /\[7\]\([^)]+\)\.?$/u.test(page.text.trim())),
    'pagination must not leave a linked note marker alone at the bottom of a page'
  );
}

{
  const prefix = 'Filler sentence. '.repeat(14);
  const bareNote = '7. Robert H. Frank and Philip J. Cook, The Winner-Take-All Society.';
  const text = `${prefix}\n${bareNote}`;
  const markerEnd = text.indexOf('7.') + 2;
  const pages = paginatePlainText(text, markerEnd);
  assert.ok(
    !pages.some(page => /(?:^|\n)\s*7\.?$/u.test(page.text.trim())),
    'pagination must not leave a bare note marker alone at the bottom of a page'
  );
}

{
  assert.equal(
    rearrangeAndCleanText('“The future is disorder.”1\n\n—DANNY HILLIS'),
    '*“The future is disorder.”1*\n\n—— DANNY HILLIS'
  );
  assert.equal(
    rearrangeAndCleanText('“I know of no more encouraging fact than the unquestionable ability of man to elevate his life by conscious endeavor.” —HENRY DAVID THOREAU'),
    '*“I know of no more encouraging fact than the unquestionable ability of man to elevate his life by conscious endeavor.”*\n\n—— HENRY DAVID THOREAU'
  );
  assert.deepEqual(
    splitIntoSentences('*“The future is disorder.”1*'),
    ['*“The future is disorder.”1*']
  );
  assert.deepEqual(
    splitIntoSentences('*“I know of no more encouraging fact than the unquestionable ability of man to elevate his life by conscious endeavor.”*'),
    ['*“I know of no more encouraging fact than the unquestionable ability of man to elevate his life by conscious endeavor.”*']
  );
  assert.equal(
    rearrangeAndCleanText('*“The* *future* *is disorder.”1*\n\n—DANNY HILLIS'),
    '*“The future is disorder.”1*\n\n—— DANNY HILLIS'
  );
  // Real PDF extraction of a multi-line italic epigraph: each visual line carries its
  // own emphasis, the superscript footnote lands AFTER the closing marker
  // ("disorder.”*1", not "disorder.”1*"), and the attribution is on the very next line
  // (a single newline, so the same paragraph). The footnote must glue back inside the
  // quote and the attribution must split onto its own block.
  assert.equal(
    rearrangeAndCleanText('*“The* *future* *is disorder.”*1\n—DANNY HILLIS'),
    '*“The future is disorder.”1*\n\n—— DANNY HILLIS'
  );
  // PDF extraction now emits a detected superscript as a structural note link
  // ("[1](#pdfnote-<page>-<n>)", the same shape an EPUB <a href="#…"> footnote produces)
  // so the renderer recognises it via the internal-note-link path rather than the
  // ambiguous bare-digit heuristic. The inline epigraph (quote + single-newline
  // attribution) must still split, keeping the note link on the quote.
  assert.equal(
    rearrangeAndCleanText('*“The* *future* *is disorder.”*[1](#pdfnote-11-1)\n—DANNY HILLIS'),
    '*“The future is disorder.”*[1](#pdfnote-11-1)\n\n—— DANNY HILLIS'
  );
  assert.equal(
    rearrangeAndCleanText('—MICHAEL GRASSO[4](part0023_split_001.html#ch01-en4)'),
    '—— MICHAEL GRASSO[4](part0023_split_001.html#ch01-en4)'
  );
  assert.equal(
    rearrangeAndCleanText('—MICHAEL GRASSO4'),
    '—— MICHAEL GRASSO4'
  );
  assert.equal(isBibleReferenceAtEnd('MATTHEW 10:26'), true);
  assert.equal(isBibleReferenceAtEnd('—— MATTHEW 10:26'), true);
  assert.equal(isBibleReferenceAtEnd('—— GALATIANS 6:7'), true);
  assert.equal(isBibleReferenceAtEnd('马太福音 10:26'), true);
  assert.equal(isBibleReferenceAtEnd('—— 马太福音 10:26'), true);
  assert.equal(isBibleReferenceAtEnd('——《加拉太书》6:7'), true);
  assert.equal(isBibleReferenceAtEnd('MICHAEL GRASSO4'), false);
  assert.equal(isBibleReferenceMarkerCandidate('—— MATTHEW 10:26', '—— MATTHEW 10'.length, ':', '26'), true);
  assert.equal(isBibleReferenceMarkerCandidate('—— 马太福音 10:26', '—— 马太福音 10'.length, ':', '26'), true);
  assert.equal(isBibleReferenceMarkerCandidate('——《加拉太书》6:7', '——《加拉太书》6'.length, ':', '7'), true);
  assert.equal(isBibleReferenceMarkerCandidate('The sentence ends.26', 'The sentence ends.'.length - 1, '.', '26'), false);
  assert.equal(isStandaloneYearAtEnd('—— MARSHALL McLUHAN, 1964'), true);
  assert.equal(isStandaloneYearAtEnd('—— MICHAEL GRASSO4'), false);
  assert.equal(isNumericTextMarkerCandidate('There are 25,000 millionaires for every billionaire.', 'There are 25'.length, ',', '000'), true);
  assert.equal(isNumericTextMarkerCandidate('less than $200,000 a year.', 'less than $200'.length, ',', '000'), true);
  assert.equal(isNumericTextMarkerCandidate('income of $21,000 annually.', 'income of $21'.length, ',', '000'), true);
  assert.equal(isNumericTextMarkerCandidate('The sentence ends.9', 'The sentence ends'.length, '.', '9'), false);
  assert.equal(
    rearrangeAndCleanText('“It feels like something big is about to happen: graphs show us the yearly growth of populations, atmospheric concentrations of carbon dioxide, Net addresses, and Mbytes per dollar. They all soar up to an asymptote just beyond the turn of the century: The Singularity. The end of everything we know. The beginning of something we may never understand.”1 —— DANNY HILLIS*'),
    '*“It feels like something big is about to happen: graphs show us the yearly growth of populations, atmospheric concentrations of carbon dioxide, Net addresses, and Mbytes per dollar. They all soar up to an asymptote just beyond the turn of the century: The Singularity. The end of everything we know. The beginning of something we may never understand.”1*\n\n—— DANNY HILLIS'
  );
  assert.equal(
    rearrangeAndCleanText('Peter Thiel\nJanuary 6, 2020\nLos Angeles'),
    'Peter Thiel\n\nJanuary 6, 2020\n\nLos Angeles'
  );
}

{
  const spacedInitial = 'Curtin Winsor, III; V. Harwood Bocker, III; Guillermo Cervino; Robert Lawrence, III; Ken Klein.';
  assert.deepEqual(splitIntoSentences(spacedInitial), [
    'Curtin Winsor, III; V. Harwood Bocker, III; Guillermo Cervino; Robert Lawrence, III; Ken Klein.',
  ]);

  const tightInitial = 'Curtin Winsor, III; V.Harwood Bocker, III; Guillermo Cervino; Robert Lawrence, III; Ken Klein.';
  assert.deepEqual(splitIntoSentences(tightInitial), [
    'Curtin Winsor, III; V. Harwood Bocker, III; Guillermo Cervino; Robert Lawrence, III; Ken Klein.',
  ]);

  const pages = paginatePlainText(
    'Alan Lindsay; Brian Lines; Curtin Winsor, III; V. Harwood Bocker, III; Guillermo Cervino; Robert Lawrence, III; Ken Klein.',
    55
  );
  assert.ok(pages.length > 1);
  assert.ok(!pages.some(page => /;\s*V\.$/.test(page.text)), 'pagination must not leave a single-letter initial at page end');
  assert.ok(pages.some(page => page.text.endsWith('Curtin Winsor, III;')), 'semicolon list page break should occur before the next name item');
}

{
  const text = [
    'Principle',
    'The first principle starts immediately because extraction removed the topic heading.',
    'Interpretation',
    'The first interpretation should still belong to topic one.',
    '',
    '2. Second Topic',
    'Principle',
    'The second principle.',
    'Interpretation',
    'The second interpretation.',
    '',
    '3. Third Topic',
    'Principle',
    'The third principle.',
    'Interpretation',
    'The third interpretation.',
  ].join('\n');

  const pages = detectPrincipleTopicPages(text, { leadingHeading: '1. First Topic' });
  assert.ok(pages);
  const blocks = pages![0].blocks.filter(block => block.type === 'principle-topic');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].number, '1');
  assert.equal(blocks[0].title, 'First Topic');
  assert.ok(blocks[0].principle.includes('extraction removed the topic heading'));
}

{
  const source = [
    '10. Release',
    'Principle',
    'Previous topic text.',
    'Interpretation',
    'Previous interpretation.',
    '',
    '11. Confidence',
    'Principle',
    'Topic eleven starts immediately after the heading.',
    'Interpretation',
    'Topic eleven interpretation.',
    '',
    '12. Balance',
    'Principle',
    'The next topic.',
    'Interpretation',
    'The next interpretation.',
    '',
    '13. Coordination',
    'Principle',
    'The third topic in this extracted chunk.',
    'Interpretation',
    'The third interpretation.',
  ].join('\n');
  const sourceStart = source.indexOf('Principle', source.indexOf('11. Confidence'));
  const extracted = source.slice(sourceStart);
  const inferred = findTopicHeadingBeforeOffset(source, sourceStart);
  const pages = detectPrincipleTopicPages(extracted, {
    leadingHeading: inferred || 'Topics 11-20',
  });

  assert.equal(inferred, '11. Confidence');
  assert.ok(pages);
  const blocks = pages![0].blocks.filter(block => block.type === 'principle-topic');
  assert.equal(blocks[0].number, '11');
  assert.equal(blocks[0].title, 'Confidence');
}

{
  const source = [
    '[[PAGE 30]]',
    '11. Confidence',
    'Principle',
    'Topic eleven starts on a page boundary.',
  ].join('\n');
  const sourceStart = source.indexOf('[[PAGE 30]]');
  assert.equal(findTopicHeadingAtOffset(source, sourceStart), '11. Confidence');
}

{
  const source = [
    '10. Release',
    'Principle',
    'Previous topic text.',
    'Interpretation',
    'Previous interpretation.',
    '',
    '11. Confidence',
    'Principle',
    'Topic eleven starts immediately after the heading.',
    'Interpretation',
    'Topic eleven interpretation.',
    '',
    '12. Balance',
    'Principle',
    'The next topic.',
    'Interpretation',
    'The next interpretation.',
    '',
    '13. Coordination',
    'Principle',
    'The third topic.',
    'Interpretation',
    'The third interpretation.',
  ].join('\n');
  const extracted = source.slice(source.indexOf('Principle', source.indexOf('11. Confidence')));
  const inferred = findTopicHeadingForExtractedText(source, extracted);
  const pages = detectPrincipleTopicPages(extracted, { leadingHeading: inferred || 'Topics 11-20' });

  assert.equal(inferred, '11. Confidence');
  assert.ok(pages);
  const blocks = pages![0].blocks.filter(block => block.type === 'principle-topic');
  assert.equal(blocks[0].number, '11');
  assert.equal(blocks[0].title, 'Confidence');
}

{
  const source = [
    '11. Confidence',
    'Principle',
    'Topic eleven starts before a page marker and the cached text removes that marker.',
    '[[PAGE 38]]',
    'The words after the marker must still match the source so the missing leading heading can be restored.',
    'More words keep the normalized query long enough to cross the page marker boundary reliably.',
    'Interpretation',
    'Topic eleven interpretation.',
    '',
    '12. Balance',
    'Principle',
    'The next topic.',
    'Interpretation',
    'The next interpretation.',
    '',
    '13. Coordination',
    'Principle',
    'The third topic.',
    'Interpretation',
    'The third interpretation.',
  ].join('\n');
  const extracted = source
    .slice(source.indexOf('Principle'))
    .replace(/\[\[PAGE\s+\d+\]\]/g, '');
  const inferred = findTopicHeadingForExtractedText(source, extracted);

  assert.equal(inferred, '11. Confidence');
}

console.log('readerStructure regression tests passed');
