import { createHeadlessEditor } from '@lexical/headless';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isTextNode,
} from 'lexical';
import { describe, expect, it } from 'vitest';

import type { AnnotatedDocument } from './annotate';
import type { RawMatch } from './client';
import {
  anchorMatches,
  carryOver,
  diffText,
  flaggedText,
  kindFor,
  reanchor,
  replaceCovered,
} from './matches';
import type { AnchoredMatch } from './types';

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

/** An anchor with just enough of a match on it to tell one from another. */
function anchorAt(nodeKey: string, offset: number, length: number, word: string): AnchoredMatch {
  return {
    nodeKey,
    offset,
    length,
    match: {
      title: 'Spelling mistake',
      detail: 'Possible spelling mistake found.',
      replacements: [],
      ruleId: 'RULE_ID',
      category: 'Typo',
      kind: 'spelling',
      word,
    },
  };
}

/** One paragraph of one text node, and the key that node was given. */
function editorWith(...paragraphs: string[]): {
  editor: ReturnType<typeof createHeadlessEditor>;
  keys: string[];
} {
  const editor = createHeadlessEditor({
    onError: (error) => {
      throw error;
    },
  });

  const keys: string[] = [];
  editor.update(
    () => {
      $getRoot().clear();
      for (const text of paragraphs) {
        const node = $createTextNode(text);
        const block = $createParagraphNode();
        block.append(node);
        $getRoot().append(block);
        keys.push(node.getKey());
      }
    },
    { discrete: true },
  );

  return { editor, keys };
}

describe('diffText', () => {
  it('reports nothing when the text did not change', () => {
    expect(diffText('same', 'same')).toBeNull();
  });

  it('reports an insertion as an empty range at the point it went in', () => {
    expect(diffText('cat', 'cart')).toEqual({ start: 2, end: 2, delta: 1 });
  });

  it('reports a deletion as the range that went', () => {
    expect(diffText('hello world', 'hello')).toEqual({ start: 5, end: 11, delta: -6 });
  });

  it('reports a replacement as the range it covered', () => {
    expect(diffText('teh', 'the')).toEqual({ start: 1, end: 3, delta: 0 });
  });

  it('reports a keystroke at the end as an insertion there', () => {
    expect(diffText('word', 'words')).toEqual({ start: 4, end: 4, delta: 1 });
  });
});

describe('reanchor', () => {
  // Five characters replaced by eight, starting at offset 10.
  const edit = { start: 10, end: 15, delta: 3 };

  it('returns a match ending before the edit as itself, so identity holds', () => {
    const untouched = anchorAt('k1', 4, 6, 'before');
    expect(reanchor(untouched, edit)).toBe(untouched);
  });

  it('slides a match that begins where the edit ends', () => {
    expect(reanchor(anchorAt('k1', 15, 4, 'after'), edit)?.offset).toBe(18);
  });

  it('slides a match back when the edit deleted text', () => {
    const deletion = { start: 5, end: 10, delta: -5 };
    expect(reanchor(anchorAt('k1', 20, 4, 'after'), deletion)?.offset).toBe(15);
  });

  it('drops a match the edit ran through', () => {
    expect(reanchor(anchorAt('k1', 12, 4, 'inside'), edit)).toBeNull();
  });

  it('drops a match the edit began inside', () => {
    expect(reanchor(anchorAt('k1', 8, 4, 'straddling'), edit)).toBeNull();
  });
});
/**
 * Run one edit and carry the matches across it the way the extension does:
 * from the update listener's own dirty set and editor states, rather than from
 * a hand-made guess at what Lexical marks dirty.
 */
function editAndCarry(
  editor: ReturnType<typeof createHeadlessEditor>,
  current: AnchoredMatch[],
  mutate: () => void,
): AnchoredMatch[] {
  let carried = [...current];

  const unregister = editor.registerUpdateListener(
    ({ dirtyLeaves, prevEditorState, editorState }) => {
      if (dirtyLeaves.size === 0) return;
      carried = carryOver(carried, dirtyLeaves, prevEditorState, editorState);
    },
  );

  editor.update(mutate, { discrete: true });
  unregister();

  return carried;
}

describe('carryOver', () => {
  const PARAGRAPH = 'Teh quick brown fox jumpd over.';

  it('keeps the rest of the paragraph when a correction is applied', () => {
    // The whole point. Applying the fix for "Teh" used to take "jumpd" down
    // with it, and the paragraph stayed bare until the next check answered.
    const { editor, keys } = editorWith(PARAGRAPH);
    const key = keys[0]!;

    const kept = editAndCarry(
      editor,
      [anchorAt(key, 0, 3, 'Teh'), anchorAt(key, 20, 5, 'jumpd')],
      () => {
        const node = $getNodeByKey(key);
        if ($isTextNode(node)) node.spliceText(0, 3, 'The');
      },
    );

    expect(kept).toHaveLength(1);
    expect(kept[0]?.match.word).toBe('jumpd');
    // Same length in, same length out, so it did not have to move.
    expect(kept[0]?.offset).toBe(20);
  });

  it('slides the matches after text typed in front of them', () => {
    const { editor, keys } = editorWith(PARAGRAPH);
    const key = keys[0]!;

    const kept = editAndCarry(editor, [anchorAt(key, 20, 5, 'jumpd')], () => {
      const node = $getNodeByKey(key);
      if ($isTextNode(node)) node.spliceText(0, 0, 'Very ');
    });

    expect(kept[0]?.offset).toBe(25);
  });

  it('leaves the matches of a node the edit did not touch', () => {
    const { editor, keys } = editorWith(PARAGRAPH, 'Anuther paragraph.');
    const [first, second] = keys as [string, string];
    const elsewhere = anchorAt(second, 0, 7, 'Anuther');

    const kept = editAndCarry(editor, [anchorAt(first, 0, 3, 'Teh'), elsewhere], () => {
      const node = $getNodeByKey(first);
      if ($isTextNode(node)) node.spliceText(0, 3, 'The');
    });

    expect(kept).toEqual([elsewhere]);
    // Untouched means the same object, which is what the popover compares on.
    expect(kept[0]).toBe(elsewhere);
  });

  it('follows the tail into the new node when Enter splits a paragraph', () => {
    // Lexical keeps the head on the original node and puts the tail in one
    // that did not exist a moment ago, so every match in the second half has
    // no node to sit on unless it is handed over.
    const { editor, keys } = editorWith(PARAGRAPH);
    const key = keys[0]!;

    const kept = editAndCarry(
      editor,
      [anchorAt(key, 0, 3, 'Teh'), anchorAt(key, 20, 5, 'jumpd')],
      () => {
        const node = $getNodeByKey(key);
        // Just before "jumpd", so the tail is "jumpd over.".
        if ($isTextNode(node)) node.select(20, 20).insertParagraph();
      },
    );

    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({ nodeKey: key, offset: 0, length: 3 });

    const tail = kept[1]!;
    expect(tail.match.word).toBe('jumpd');
    expect(tail.nodeKey).not.toBe(key);
    // First thing in the new node.
    expect(tail.offset).toBe(0);
  });

  it('follows the text into the surviving node when Backspace merges two', () => {
    const { editor, keys } = editorWith('Teh quick ', 'jumpd over.');
    const [first, second] = keys as [string, string];

    const kept = editAndCarry(
      editor,
      [anchorAt(first, 0, 3, 'Teh'), anchorAt(second, 0, 5, 'jumpd')],
      () => {
        const node = $getNodeByKey(second);
        if ($isTextNode(node)) node.select(0, 0).deleteCharacter(true);
      },
    );

    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({ nodeKey: first, offset: 0 });

    const merged = kept[1]!;
    expect(merged.match.word).toBe('jumpd');
    expect(merged.nodeKey).toBe(first);
    // "Teh quick " is ten characters, and the second paragraph landed after it.
    expect(merged.offset).toBe(10);
  });

  it('drops a match the split ran through', () => {
    // Enter inside "jumpd" cuts the word in half, so neither half is the word
    // the service judged and there is nowhere honest to put the underline.
    const { editor, keys } = editorWith(PARAGRAPH);
    const key = keys[0]!;

    const kept = editAndCarry(editor, [anchorAt(key, 20, 5, 'jumpd')], () => {
      const node = $getNodeByKey(key);
      if ($isTextNode(node)) node.select(22, 22).insertParagraph();
    });

    expect(kept).toEqual([]);
  });

  it('keeps the matches of a node dirtied without its text changing', () => {
    // A format change, or a sibling's reconciliation. Nothing moved.
    const { editor, keys } = editorWith(PARAGRAPH);
    const key = keys[0]!;
    const state = editor.getEditorState();

    const anchor = anchorAt(key, 0, 3, 'Teh');
    const kept = carryOver([anchor], new Set([key]), state, state);

    expect(kept[0]).toBe(anchor);
  });

  it('drops the matches of a node that is gone', () => {
    const { editor, keys } = editorWith(PARAGRAPH);
    const key = keys[0]!;
    const before = editor.getEditorState();

    editor.update(() => $getRoot().clear(), { discrete: true });

    // Clearing the root reports no dirty leaves of its own, so this states the
    // rule directly: a key with no text behind it any more keeps nothing.
    const kept = carryOver(
      [anchorAt(key, 0, 3, 'Teh')],
      new Set([key]),
      before,
      editor.getEditorState(),
    );

    expect(kept).toEqual([]);
  });
});

describe('replaceCovered', () => {
  /** A chunk holding the second half of one node, from offset 20 of it. */
  const chunk: AnnotatedDocument = {
    annotation: [{ text: 'second half here' }],
    segments: [{ start: 0, length: 16, nodeKey: 'k1', nodeOffset: 20 }],
  };

  it('keeps anchors in the part of the node another chunk covered', () => {
    // Splitting an oversized block cuts inside a text run, so one node key can
    // appear in two chunks. Dropping by key alone took out what the first chunk
    // had just contributed, and the first half of the paragraph blinked out.
    const fromTheChunkBefore = anchorAt('k1', 3, 4, 'firsthalf');
    const stale = anchorAt('k1', 22, 6, 'stale');
    const fresh = anchorAt('k1', 25, 4, 'fresh');

    expect(replaceCovered([fromTheChunkBefore, stale], [fresh], chunk)).toEqual([
      fromTheChunkBefore,
      fresh,
    ]);
  });

  it('drops an anchor that only overlaps the checked range', () => {
    // It straddles the seam, so this chunk's answer is the current word on it.
    const straddling = anchorAt('k1', 18, 5, 'straddling');
    expect(replaceCovered([straddling], [], chunk)).toEqual([]);
  });

  it('leaves every other node alone', () => {
    const elsewhere = anchorAt('k2', 22, 6, 'elsewhere');
    expect(replaceCovered([elsewhere], [], chunk)[0]).toBe(elsewhere);
  });
});
