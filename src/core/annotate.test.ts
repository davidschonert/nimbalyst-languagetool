import { createHeadlessEditor } from '@lexical/headless';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import { describe, expect, it } from 'vitest';

import { buildAnnotatedDocument, resolveRange, type AnnotatedDocument } from './annotate';

/** Build a document from a Lexical tree, the way the extension does at runtime. */
function annotate(build: () => void): AnnotatedDocument {
  const editor = createHeadlessEditor({
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
