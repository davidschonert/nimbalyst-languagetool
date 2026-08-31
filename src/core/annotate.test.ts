import { createHeadlessEditor } from '@lexical/headless';
import { $createParagraphNode, $createTextNode, $getRoot, ElementNode } from 'lexical';
import { describe, expect, it } from 'vitest';

import { buildAnnotatedDocument, resolveRange, type AnnotatedDocument } from './annotate';

/**
 * Stand-ins for the containers the real editor supplies. Nimbalyst's ListNode
 * and LinkNode are not installed here, and what the tree walk keys off is
 * isInline(), not the concrete type — so a pair that differ only in that
 * answer is exactly the fixture the walk needs.
 */
class BlockContainer extends ElementNode {
  static getType(): string {
    return 'test-block';
  }
  static clone(node: BlockContainer): BlockContainer {
    return new BlockContainer(node.__key);
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): boolean {
    return false;
  }
}

class InlineContainer extends ElementNode {
  static getType(): string {
    return 'test-inline';
  }
  static clone(node: InlineContainer): InlineContainer {
    return new InlineContainer(node.__key);
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): boolean {
    return true;
  }
}

/** Build a document from a Lexical tree, the way the extension does at runtime. */
function annotate(build: () => void): AnnotatedDocument {
  const editor = createHeadlessEditor({
    nodes: [BlockContainer, InlineContainer],
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

  let doc!: AnnotatedDocument;
  editor.getEditorState().read(() => {
    doc = buildAnnotatedDocument();
  });
  return doc;
}

function paragraph(...text: string[]): void {
  const node = $createParagraphNode();
  for (const value of text) node.append($createTextNode(value));
  $getRoot().append(node);
}

/** The document as LanguageTool indexes it: every item's raw source, joined. */
function flatten(doc: AnnotatedDocument): string {
  return doc.annotation.map((item) => ('text' in item ? item.text : item.markup)).join('');
}

/** Where a text run sits in the annotated document, for building match offsets. */
function offsetOf(doc: AnnotatedDocument, needle: string): number {
  const index = flatten(doc).indexOf(needle);
  if (index < 0) throw new Error(`not found: ${needle}`);
  return index;
}

describe('the offset space', () => {
  it('counts a markup item by its raw length, not its interpretAs', () => {
    // This is the property the whole design rests on. A match reported at
    // offset N indexes the concatenation of every item exactly as supplied,
    // so a markup item cannot contribute the length of its substitute.
    const doc = annotate(() => {
      const node = $createParagraphNode();
      const code = $createTextNode('teh');
      code.toggleFormat('code');
      node.append($createTextNode('Set the '), code, $createTextNode(' flag.'));
      $getRoot().append(node);
    });

    const total = doc.annotation.reduce(
      (sum, item) => sum + ('text' in item ? item.text : item.markup).length,
      0,
    );
    expect(total).toBe(flatten(doc).length);

    const codeItem = doc.annotation.find((item) => 'markup' in item && item.markup === 'teh');
    expect(codeItem).toEqual({ markup: 'teh', interpretAs: 'code' });
  });

  it('separates blocks so sentences do not run together', () => {
    const doc = annotate(() => {
      paragraph('First sentence.');
      paragraph('Second sentence.');
    });

    expect(flatten(doc)).toBe('First sentence.\n\nSecond sentence.');
    // The break is markup, not prose, so no match can be anchored inside it.
    expect(doc.segments).toHaveLength(2);
  });
});

describe('markup suppression', () => {
  it('suppresses GitBook directives, which render as ordinary paragraph text', () => {
    const doc = annotate(() => {
      paragraph('{% hint style="info" %}');
      paragraph('Real prose here.');
      paragraph('{% endhint %}');
    });

    const markup = doc.annotation.filter((item) => 'markup' in item);
    expect(markup).toContainEqual({ markup: '{% hint style="info" %}' });
    expect(markup).toContainEqual({ markup: '{% endhint %}' });

    // Only the prose is offerable to the checker.
    expect(doc.segments.map((segment) => segment.length)).toEqual(['Real prose here.'.length]);
  });

  it('splits a directive out of the middle of a text node', () => {
    const doc = annotate(() => paragraph('Before {% hint %} after'));

    expect(doc.annotation).toEqual([
      { text: 'Before ' },
      { markup: '{% hint %}' },
      { text: ' after' },
    ]);
    // The second run records its offset inside the source node, not the document.
    expect(doc.segments[1]?.nodeOffset).toBe('Before {% hint %}'.length);
  });

  it('gives inline markup a substitute so whitespace does not collapse', () => {
    // Markup with no interpretAs makes LanguageTool see two adjacent spaces
    // and report CONSECUTIVE_SPACES over a range the user cannot act on.
    const doc = annotate(() => {
      const node = $createParagraphNode();
      const code = $createTextNode('x');
      code.toggleFormat('code');
      node.append($createTextNode('a '), code, $createTextNode(' b'));
      $getRoot().append(node);
    });

    const markup = doc.annotation.find((item) => 'markup' in item);
    expect(markup).toHaveProperty('interpretAs');
  });
});

describe('resolveRange', () => {
  it('maps an offset back to the node and in-node offset it came from', () => {
    const doc = annotate(() => {
      paragraph('First paragraph.');
      paragraph('The server are running.');
    });

    const offset = offsetOf(doc, 'are');
    const resolved = resolveRange(doc, offset, 3);

    expect(resolved).not.toBeNull();
    expect(resolved?.length).toBe(3);
    expect(resolved?.offset).toBe('The server '.length);
    // Second paragraph, so not the node the first run came from.
    expect(resolved?.nodeKey).not.toBe(doc.segments[0]?.nodeKey);
  });

  it('drops a match that begins inside markup', () => {
    // Its start offset is not a position the user can edit.
    const doc = annotate(() => paragraph('{% hint %} after'));
    const offset = offsetOf(doc, '{% hint %}');

    expect(resolveRange(doc, offset, 4)).toBeNull();
  });

  it('clips a match that overruns from prose into markup', () => {
    const doc = annotate(() => paragraph('Before {% hint %}'));
    const offset = offsetOf(doc, 'Before');

    // Asks for far more than the prose run holds.
    const resolved = resolveRange(doc, offset, 50);
    expect(resolved?.length).toBe('Before '.length);
  });

  it('returns null for an empty range', () => {
    const doc = annotate(() => paragraph('Anything.'));
    expect(resolveRange(doc, 0, 0)).toBeNull();
  });
});

describe('nested blocks', () => {
  it('separates the items of a list, which are blocks in their own right', () => {
    // Without the separator these join into "Buy milkTeh bread", LanguageTool
    // reports a spelling match across the seam, and resolveRange clips it onto
    // the tail of item one — an underline whose replacement rewrites the
    // wrong word, on a typo that is really in item two.
    const doc = annotate(() => {
      const list = new BlockContainer();
      for (const line of ['Buy milk', 'Teh bread']) {
        const item = new BlockContainer();
        item.append($createTextNode(line));
        list.append(item);
      }
      $getRoot().append(list);
    });

    expect(flatten(doc)).toBe('Buy milk\n\nTeh bread');
    expect(doc.segments).toHaveLength(2);
  });

  it('separates a nested list from the text of the item holding it', () => {
    const doc = annotate(() => {
      const list = new BlockContainer();
      const item = new BlockContainer();
      item.append($createTextNode('Top level'));

      const nested = new BlockContainer();
      const nestedItem = new BlockContainer();
      nestedItem.append($createTextNode('Nested'));
      nested.append(nestedItem);
      item.append(nested);

      list.append(item);
      $getRoot().append(list);
    });

    expect(flatten(doc)).toBe('Top level\n\nNested');
  });

  it('does NOT break a sentence at an inline container', () => {
    // The other half of the same decision: a link is an ElementNode too, so a
    // walk that separated every element child would put a paragraph break
    // inside this sentence and shift every offset after it.
    const doc = annotate(() => {
      const paragraph = $createParagraphNode();
      const link = new InlineContainer();
      link.append($createTextNode('the docs'));
      paragraph.append($createTextNode('Visit '), link, $createTextNode(' for more.'));
      $getRoot().append(paragraph);
    });

    expect(flatten(doc)).toBe('Visit the docs for more.');
    expect(doc.annotation.every((item) => 'text' in item)).toBe(true);
  });

  it('leaves no separator before the first item that carries prose', () => {
    const doc = annotate(() => {
      const list = new BlockContainer();
      list.append(new BlockContainer()); // empty item
      const second = new BlockContainer();
      second.append($createTextNode('Only line.'));
      list.append(second);
      $getRoot().append(list);
    });

    expect(flatten(doc)).toBe('Only line.');
  });
});
