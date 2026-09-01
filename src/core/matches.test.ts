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
  it('maps misspellings to spelling', () => {
    expect(kindFor('misspelling')).toBe('spelling');
  });

  it('maps taste-based issue types to style', () => {
    // DASH_RULE reports typographical, and is a house-style disagreement
    // rather than an error.
    for (const issueType of ['style', 'typographical', 'register', 'whitespace']) {
      expect(kindFor(issueType)).toBe('style');
    }
  });

  it('falls back to grammar for anything else, including absent', () => {
    expect(kindFor('grammar')).toBe('grammar');
    expect(kindFor('duplication')).toBe('grammar');
    expect(kindFor(undefined)).toBe('grammar');
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
