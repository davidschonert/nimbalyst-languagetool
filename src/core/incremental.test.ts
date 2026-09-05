import { createHeadlessEditor } from '@lexical/headless';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import { describe, expect, it } from 'vitest';

import { buildDocumentBlocks, type DocumentBlock } from './annotate';
import { fingerprint, planCheck, prune, type BlockCache } from './incremental';
import type { AnchoredMatch } from './types';

function blocksOf(...paragraphs: string[]): DocumentBlock[] {
  const editor = createHeadlessEditor({
    onError: (error) => {
      throw error;
    },
  });

  editor.update(
    () => {
      $getRoot().clear();
      for (const text of paragraphs) {
        const block = $createParagraphNode();
        block.append($createTextNode(text));
        $getRoot().append(block);
      }
    },
    { discrete: true },
  );

  let blocks!: DocumentBlock[];
  editor.getEditorState().read(() => {
    blocks = buildDocumentBlocks();
  });
  return blocks;
}

describe('fingerprint', () => {
  it('is the same for a block that did not change', () => {
    const [first] = blocksOf('The same words.');
    const [again] = blocksOf('The same words.');

    // Two editors, so different node keys, and therefore different anchors.
    expect(fingerprint(first!)).not.toBe(fingerprint(again!));

    // The same block twice over is what a cache hit actually looks like.
    expect(fingerprint(first!)).toBe(fingerprint(first!));
  });

  it('changes when the text changes', () => {
    const [before] = blocksOf('The same words.');
    const [after] = blocksOf('The same word.');
    expect(fingerprint(before!)).not.toBe(fingerprint(after!));
  });

  it('separates two blocks whose text only differs in where it is split', () => {
    // Length-prefixed for exactly this: without it "ab" + "c" and "a" + "bc"
    // can produce the same key, and one block would serve the other's matches.
    const run = (...parts: string[]): string => {
      const editor = createHeadlessEditor({
        onError: (error) => {
          throw error;
        },
      });
      editor.update(
        () => {
          $getRoot().clear();
          const block = $createParagraphNode();
          for (const part of parts) block.append($createTextNode(part));
          $getRoot().append(block);
        },
        { discrete: true },
      );
      let print = '';
      editor.getEditorState().read(() => {
        print = fingerprint(buildDocumentBlocks()[0]!);
      });
      return print;
    };

    expect(run('ab', 'c')).not.toBe(run('a', 'bc'));
  });
});

describe('planCheck', () => {
  const blocks = blocksOf('One.', 'Two.', 'Three.', 'Four.', 'Five.');

  it('sends everything when nothing is cached', () => {
    const plan = planCheck(blocks, new Set());

    expect(plan.stale).toEqual([0, 1, 2, 3, 4]);
    expect(plan.runs).toEqual([[0, 1, 2, 3, 4]]);
  });

  it('sends nothing when every block is cached', () => {
    const cached = new Set(blocks.map(fingerprint));
    const plan = planCheck(blocks, cached);

    expect(plan.stale).toEqual([]);
    expect(plan.runs).toEqual([]);
  });

  it('pads a stale block with its neighbours so the service keeps the context', () => {
    // Without the pad, LanguageTool never sees the paragraphs either side and
    // its cross-paragraph rules stop firing for the edited one.
    const cached = new Set(blocks.map(fingerprint).filter((_, index) => index !== 2));
    const plan = planCheck(blocks, cached);

    expect(plan.stale).toEqual([2]);
    expect(plan.runs).toEqual([[1, 2, 3]]);
  });

  it('does not pad past the ends of the document', () => {
    const cached = new Set(blocks.map(fingerprint).filter((_, index) => index !== 0));
    expect(planCheck(blocks, cached).runs).toEqual([[0, 1]]);
  });

  it('merges pads that overlap rather than sending a block twice', () => {
    const cached = new Set(
      blocks.map(fingerprint).filter((_, index) => index !== 1 && index !== 2),
    );
    const plan = planCheck(blocks, cached);

    expect(plan.stale).toEqual([1, 2]);
    expect(plan.runs).toEqual([[0, 1, 2, 3]]);
  });

  it('keeps runs apart when the stale blocks are not adjacent', () => {
    const cached = new Set(
      blocks.map(fingerprint).filter((_, index) => index !== 0 && index !== 4),
    );
    const plan = planCheck(blocks, cached);

    expect(plan.runs).toEqual([
      [0, 1],
      [3, 4],
    ]);
  });
});

describe('prune', () => {
  it('drops the entries the document no longer has', () => {
    const anchor = [] as AnchoredMatch[];
    const cache: BlockCache = new Map([
      ['live', anchor],
      ['gone', anchor],
    ]);

    prune(cache, ['live']);

    expect([...cache.keys()]).toEqual(['live']);
  });
});
