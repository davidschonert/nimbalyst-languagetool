import { createHeadlessEditor } from '@lexical/headless';
import { $createParagraphNode, $createTextNode, $getRoot, ElementNode } from 'lexical';
import { describe, expect, it } from 'vitest';

import {
  buildAnnotatedDocument,
  buildDocumentBlocks,
  resolveRange,
  type AnnotatedDocument,
  type DocumentBlock,
} from './annotate';
import { chunkDocument, packBlocks } from './chunk';

/**
 * A block whose whole content is markup, standing in for the code block the
 * real editor supplies. `OPAQUE_BLOCK_TYPES` keys off the type name, so the
 * name is the only part of it that matters here.
 */
class CodeBlock extends ElementNode {
  static getType(): string {
    return 'code';
  }
  static clone(node: CodeBlock): CodeBlock {
    return new CodeBlock(node.__key);
  }
  createDOM(): HTMLElement {
    return document.createElement('pre');
  }
  updateDOM(): boolean {
    return false;
  }
}

interface Walked {
  blocks: DocumentBlock[];
  document: AnnotatedDocument;
}

function walk(build: () => void): Walked {
  const editor = createHeadlessEditor({
    nodes: [CodeBlock],
    onError: (error) => {
      throw error;
    },
  });

  editor.update(
    () => {
      $getRoot().clear();
      build();
    },
    { discrete: true },
  );

  let walked!: Walked;
  editor.getEditorState().read(() => {
    walked = { blocks: buildDocumentBlocks(), document: buildAnnotatedDocument() };
  });
  return walked;
}

function paragraph(text: string): void {
  const node = $createParagraphNode();
  node.append($createTextNode(text));
  $getRoot().append(node);
}

function code(text: string): void {
  const node = new CodeBlock();
  node.append($createTextNode(text));
  $getRoot().append(node);
}

/** The chunk as LanguageTool indexes it: every item's raw source, joined. */
function flatten(doc: AnnotatedDocument): string {
  return doc.annotation.map((item) => ('text' in item ? item.text : item.markup)).join('');
}

describe('a limit the document already fits under', () => {
  it('produces the same single document the walk builds', () => {
    const { blocks, document } = walk(() => {
      paragraph('First sentence.');
      paragraph('Second sentence.');
    });

    const chunks = chunkDocument(blocks, 10_000);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.annotation).toEqual(document.annotation);
    expect(chunks[0]?.segments).toEqual(document.segments);
  });
});

describe('where a chunk is allowed to end', () => {
  const SENTENCE = 'Alpha beta gamma.'; // 17 characters
  const build = (): void => {
    for (let index = 0; index < 5; index += 1) paragraph(SENTENCE);
  };

  it('ends between blocks, never inside one', () => {
    const { blocks } = walk(build);

    // Two of these plus the paragraph break is 36, and a third would be 55.
    const chunks = chunkDocument(blocks, 40);

    expect(chunks.map(flatten)).toEqual([
      [SENTENCE, SENTENCE].join('\n\n'),
      [SENTENCE, SENTENCE].join('\n\n'),
      SENTENCE,
    ]);
  });

  it('counts the paragraph break it inserts against the budget', () => {
    const { blocks } = walk(build);

    for (const chunk of chunkDocument(blocks, 40)) {
      expect(flatten(chunk).length).toBeLessThanOrEqual(40);
    }
  });

  it('resolves a match against the chunk it came from, not the document', () => {
    // The whole point of assembling each chunk in its own offset space. If a
    // later chunk kept document offsets, every match in it would anchor to the
    // wrong node and the underline would land somewhere else entirely.
    const { blocks } = walk(build);
    const chunks = chunkDocument(blocks, 40);
    const last = chunks[chunks.length - 1];

    const resolved = resolveRange(last!, flatten(last!).indexOf('gamma'), 5);

    expect(resolved?.offset).toBe('Alpha beta '.length);
    expect(resolved?.nodeKey).toBe(last?.segments[0]?.nodeKey);
    // And it is genuinely the fifth paragraph, not the first.
    expect(resolved?.nodeKey).not.toBe(chunks[0]?.segments[0]?.nodeKey);
  });
});

describe('a single block larger than the whole budget', () => {
  const SENTENCE = 'One two three. '; // 15 characters
  const PASTED = SENTENCE.repeat(6).trimEnd(); // 89 characters, one paragraph

  it('splits at a sentence end rather than mid-sentence', () => {
    const { blocks } = walk(() => paragraph(PASTED));

    const chunks = chunkDocument(blocks, 40);

    // 40 leaves room for two sentences, so the cut lands after the second.
    expect(chunks.map(flatten)).toEqual([
      SENTENCE.repeat(2),
      SENTENCE.repeat(2),
      SENTENCE.repeat(2).trimEnd(),
    ]);
  });

  it('loses nothing across the seams, and adds nothing either', () => {
    const { blocks } = walk(() => paragraph(PASTED));

    expect(
      chunkDocument(blocks, 40)
        .map(flatten)
        .join(''),
    ).toBe(PASTED);
  });

  it('keeps the in-node offset right on the far side of a seam', () => {
    // A match in the second chunk has to anchor into the middle of the one
    // TextNode the paragraph is made of, not to its start.
    const { blocks } = walk(() => paragraph(PASTED));
    const chunks = chunkDocument(blocks, 40);

    const resolved = resolveRange(chunks[1]!, 0, 3);

    expect(resolved?.offset).toBe(SENTENCE.repeat(2).length);
    expect(resolved?.nodeKey).toBe(chunks[0]?.segments[0]?.nodeKey);
  });

  it('falls back to a word boundary when no sentence end fits', () => {
    // Nothing here terminates a sentence, so the only boundary left is the one
    // that at least keeps every word whole.
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    const { blocks } = walk(() => paragraph(words));

    const chunks = chunkDocument(blocks, 20);

    expect(chunks.map(flatten).join('')).toBe(words);
    for (const chunk of chunks) {
      expect(flatten(chunk).length).toBeLessThanOrEqual(20);
      // No half words at either end.
      expect(flatten(chunk).trim().split(/\s+/).every((word) => words.includes(word))).toBe(true);
    }
    expect(chunks.map(flatten)).toEqual([
      'alpha bravo charlie ',
      'delta echo foxtrot ',
      'golf hotel india ',
      'juliet',
    ]);
  });

  it('cuts through a token only when there is no boundary at all', () => {
    const token = 'x'.repeat(25);
    const { blocks } = walk(() => paragraph(token));

    const chunks = chunkDocument(blocks, 10);

    expect(chunks.map(flatten)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('does not pack a split part next to its neighbour', () => {
    // Each part came out of one paragraph, so joining two of them would insert
    // a paragraph break at a point the split rule only settled for.
    const { blocks } = walk(() => paragraph(PASTED));

    for (const chunk of packBlocks(blocks, 40)) {
      expect(chunk).toHaveLength(1);
    }
  });
});

describe('chunks with nothing to check in them', () => {
  it('drops a chunk that is all markup', () => {
    const { blocks } = walk(() => code('const answer = 42;'));

    expect(chunkDocument(blocks, 1000)).toEqual([]);
  });

  it('drops an empty document', () => {
    expect(chunkDocument(walk(() => {}).blocks, 1000)).toEqual([]);
  });

  it('keeps the prose around one', () => {
    const { blocks } = walk(() => {
      paragraph('Before the code.');
      code('const answer = 42;');
      paragraph('After the code.');
    });

    const chunks = chunkDocument(blocks, 20);

    expect(chunks.map(flatten)).toEqual(['Before the code.', 'After the code.']);
  });
});

describe('the room left in a part', () => {
  it('starts a new part rather than cutting a word when little room is left', () => {
    // Regression. A markup piece can leave a handful of characters of budget,
    // and the token fallback used to fire there, splitting a word that is
    // nowhere near budget length while the next part had the whole budget free.
    const PADDING = 'x'.repeat(95);
    const PROSE = 'Antidisestablishmentarianism is a long word and so on forever more';

    const { blocks } = walk(() => {
      const node = $createParagraphNode();
      const code = $createTextNode(PADDING);
      code.toggleFormat('code');
      node.append(code, $createTextNode(PROSE));
      $getRoot().append(node);
    });

    const chunks = chunkDocument(blocks, 100);

    // The padding is markup, so its part carries no segments and is never sent.
    // What matters is that the prose arrives whole.
    expect(chunks.map(flatten)).toEqual([PROSE]);
  });
});

describe('keeping a padded block with its neighbours', () => {
  /** A paragraph of an exact length, so the packing arithmetic is checkable. */
  const sized = (length: number, mark: string): string => mark.repeat(length);

  it('backs up to a boundary that does not strip the pad', () => {
    // Block 2 is the stale one and blocks 1 and 3 are its context. Packing
    // greedily would close after block 1 and cut block 2 off from its left
    // neighbour, so the boundary moves back one.
    const { blocks } = walk(() => {
      paragraph(sized(50, 'a'));
      paragraph(sized(40, 'b'));
      paragraph(sized(40, 'c'));
      paragraph(sized(10, 'd'));
    });

    const greedy = chunkDocument(blocks, 100);
    expect(greedy.map((chunk) => flatten(chunk)[0])).toEqual(['a', 'c']);

    const padded = chunkDocument(blocks, 100, new Set([2]));

    // The stale block now travels with both of its neighbours.
    expect(padded.map((chunk) => flatten(chunk)[0])).toEqual(['a', 'b']);
    expect(flatten(padded[1]!)).toBe(
      [sized(40, 'b'), sized(40, 'c'), sized(10, 'd')].join('\n\n'),
    );
  });

  it('gives up on the pad when the budget leaves no boundary that keeps it', () => {
    // Straight from the review. The run is 916 characters against a budget of
    // 700, and the stale block is padded on both sides, so whichever boundary
    // is chosen takes one of them away. The packer settles rather than looping.
    const { blocks } = walk(() => {
      paragraph(sized(601, 'a'));
      paragraph(sized(14, 'b'));
      paragraph(sized(301, 'c'));
    });

    const chunks = chunkDocument(blocks, 700, new Set([1]));

    expect(chunks.map((chunk) => flatten(chunk).length)).toEqual([617, 301]);
    for (const chunk of chunks) expect(flatten(chunk).length).toBeLessThanOrEqual(700);
  });

  it('does not move a block into a chunk it does not fit', () => {
    // Backing up is only worth doing while the blocks that move still fit
    // where they are going. Here they do not, so the greedy boundary stands.
    const { blocks } = walk(() => {
      paragraph(sized(30, 'a'));
      paragraph(sized(60, 'b'));
      paragraph(sized(60, 'c'));
    });

    const chunks = chunkDocument(blocks, 100, new Set([1]));

    expect(chunks.map((chunk) => flatten(chunk).length)).toEqual([92, 60]);
  });

  it('changes nothing when no block is padded', () => {
    const { blocks } = walk(() => {
      paragraph(sized(50, 'a'));
      paragraph(sized(40, 'b'));
      paragraph(sized(40, 'c'));
    });

    expect(chunkDocument(blocks, 100).map(flatten)).toEqual(
      chunkDocument(blocks, 100, new Set()).map(flatten),
    );
  });
});
