import { describe, expect, it } from 'vitest';

import type { AnnotatedDocument } from './annotate';
import type { RawMatch } from './client';
import { anchorMatches, flaggedText, kindFor } from './matches';

/**
 * "Alpha beta." as markup, then " gamma delta." as prose. Offsets 0-10 are
 * markup; 11 onwards are editable.
 */
const doc: AnnotatedDocument = {
  annotation: [{ markup: 'Alpha beta.', interpretAs: 'x' }, { text: ' gamma delta.' }],
  segments: [{ start: 11, length: 13, nodeKey: 'k1', nodeOffset: 4 }],
};

function match(overrides: Partial<RawMatch> = {}): RawMatch {
  return {
    offset: 12,
    length: 5,
    message: 'Possible spelling mistake found.',
    shortMessage: 'Spelling mistake',
    replacements: [{ value: 'gamma' }],
    context: { text: ' gamma delta.', offset: 1, length: 5 },
    rule: { id: 'RULE_ID', issueType: 'misspelling', category: { id: 'TYPOS', name: 'Typo' } },
    ...overrides,
  };
}

describe('kindFor', () => {
  /**
   * Every row was observed by running one paragraph through both LanguageTool's
   * editor and this extension, then pairing the color against the metadata.
   * They are the reason the mapping keys off what it does.
   */
  const observed = [
    // Red. Free servers say TYPOS; premium replaces it with an orthography
    // rule whose category is GRAMMAR, and still colors it red.
    { id: 'MORFOLOGIK_RULE_EN_US', issueType: 'misspelling', category: { id: 'TYPOS' }, kind: 'spelling' },
    { id: 'QB_NEW_EN_ORTHOGRAPHY_ERROR_IDS_1', issueType: 'grammar', category: { id: 'GRAMMAR' }, kind: 'spelling' },

    // Amber. Note the first: issueType says misspelling, LanguageTool shows
    // amber, which is why issueType cannot decide red.
    { id: 'QB_NEW_EN_DECAPITALIZE_ERROR_IDS_6', issueType: 'misspelling', category: { id: 'CASING' }, kind: 'grammar' },
    { id: 'DASH_RULE', issueType: 'typographical', category: { id: 'PUNCTUATION' }, kind: 'grammar' },
    { id: 'EN_A_VS_AN', issueType: 'misspelling', category: { id: 'MISC' }, kind: 'grammar' },
    { id: 'ITS_TO_IT_S', issueType: 'grammar', category: { id: 'GRAMMAR' }, kind: 'grammar' },
    { id: 'ENGLISH_WORD_REPEAT_RULE', issueType: 'duplication', category: { id: 'MISC' }, kind: 'grammar' },

    // Blue. The categories differ, the issue type does not.
    { id: 'EN_WORDINESS_PREMIUM_DUE_TO_THE_FACT_THAT', issueType: 'style', category: { id: 'STYLE' }, kind: 'style' },
    { id: 'IN_ORDER_TO_PREMIUM', issueType: 'style', category: { id: 'REDUNDANCY' }, kind: 'style' },
    { id: 'EN_REPEATEDWORDS_AFFECT', issueType: 'style', category: { id: 'REPETITIONS_STYLE' }, kind: 'style' },
  ] as const;

  for (const { kind, ...rule } of observed) {
    it(`colors ${rule.id} as ${kind}`, () => {
      expect(kindFor(rule)).toBe(kind);
    });
  }

  it('falls back to grammar when the service sends no issue type', () => {
    expect(kindFor({ id: 'UNKNOWN_RULE' })).toBe('grammar');
  });
});

describe('flaggedText', () => {
  it('slices the fragment out of the context the service returned', () => {
    expect(flaggedText(match())).toBe('gamma');
  });

  it('returns empty when the service omitted the context', () => {
    expect(flaggedText(match({ context: undefined }))).toBe('');
  });
});

describe('anchorMatches', () => {
  it('anchors a match to the node and in-node offset it came from', () => {
    const [anchored] = anchorMatches(doc, [match()]);

    expect(anchored?.nodeKey).toBe('k1');
    // 12 is one past the segment start, and the run began at nodeOffset 4.
    expect(anchored?.offset).toBe(5);
    expect(anchored?.length).toBe(5);
  });

  it('discards a match that begins inside markup', () => {
    expect(anchorMatches(doc, [match({ offset: 0, length: 5 })])).toHaveLength(0);
  });

  it('carries the fields the correction card renders', () => {
    const [anchored] = anchorMatches(doc, [match()]);

    expect(anchored?.match).toMatchObject({
      title: 'Spelling mistake',
      detail: 'Possible spelling mistake found.',
      replacements: ['gamma'],
      ruleId: 'RULE_ID',
      category: 'Typo',
      kind: 'spelling',
    });
  });

  it('falls back to the full message when shortMessage is empty', () => {
    // Style rules routinely return an empty shortMessage.
    const [anchored] = anchorMatches(doc, [match({ shortMessage: '' })]);
    expect(anchored?.match.title).toBe('Possible spelling mistake found.');
  });

  it('carries the flagged word, which is what the dictionary acts on', () => {
    const [anchored] = anchorMatches(doc, [match()]);
    expect(anchored?.match.word).toBe('gamma');
  });

  it('drops a match whose word is in the dictionary', () => {
    const ignored = (word: string) => word.toLocaleLowerCase() === 'gamma';
    expect(anchorMatches(doc, [match()], ignored)).toHaveLength(0);
  });

  it('keeps a match the dictionary does not cover', () => {
    const ignored = (word: string) => word === 'something else';
    expect(anchorMatches(doc, [match()], ignored)).toHaveLength(1);
  });

  it('cannot drop a match whose context is missing, since there is no word', () => {
    // Falling back to "ignore it" would silently hide real matches.
    const ignored = () => true;
    expect(anchorMatches(doc, [match({ context: undefined })], ignored)).toHaveLength(1);
  });

  it('tolerates a match with no replacements', () => {
    const [anchored] = anchorMatches(doc, [match({ replacements: undefined })]);
    expect(anchored?.match.replacements).toEqual([]);
  });
});
