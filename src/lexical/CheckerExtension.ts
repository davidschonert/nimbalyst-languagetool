/**
 * The hook everything else hangs off.
 *
 * Nimbalyst feeds contributed Lexical extensions into the markdown editor's
 * extension graph, so `register` receives the live `LexicalEditor`. That is the
 * only handle an extension gets on the built-in editor.
 *
 * Spike 1 (passed) established three things:
 *   1. `register` does fire for the built-in markdown editor.
 *   2. The root element is NOT mounted yet at that point, so the overlay has to
 *      attach from `registerRootListener` rather than directly.
 *   3. `dirtyLeaves` is 0 on the first update and non-zero afterwards, so the
 *      initial load has to be treated as "check everything" separately from
 *      incremental edits.
 *
 * Spike 2 (passed) asked whether an absolutely positioned overlay can hold its
 * position through typing, scrolling, and reflow. It can. It also showed that
 * repositioning and re-checking must not share a debounce:
 *
 *   - Repositioning is pure geometry. Text that did not change keeps valid
 *     anchors, so it repaints on the next frame.
 *   - Re-checking is what costs an HTTP request, so only that is debounced.
 *
 * Anchors inside edited text are dropped as soon as the edit lands, because we
 * no longer know whether the match still holds. They come back with the next
 * check. The ranges below are still fake; nothing talks to LanguageTool yet.
 */

import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical';

import { UnderlineLayer, type AnchoredRange, type MatchKind } from '../ui/UnderlineLayer';

const TAG = '[languagetool]';

/** Real checking will idle for 1.5-2s. Shorter here to make the spike easier to poke at. */
const DEBOUNCE_MS = 400;

/** Stand-in for real matches: any reasonably long word. */
const FAKE_MATCH = /\b[A-Za-z]{7,}\b/g;

const KINDS: MatchKind[] = ['spelling', 'grammar', 'style'];

function collectTextNodes(): TextNode[] {
  const found: TextNode[] = [];
  const visit = (node: LexicalNode): void => {
    if ($isTextNode(node)) {
      found.push(node);
      return;
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) visit(child);
    }
  };
  for (const child of $getRoot().getChildren()) visit(child);
  return found;
}

export const LanguageToolExtension = defineExtension({
  name: 'io.github.davidschonert.languagetool/lexical',

  register: (editor: LexicalEditor) => {
    const layer = new UnderlineLayer(editor);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let kindCursor = 0;
    let ranges: AnchoredRange[] = [];

    const recompute = (): void => {
      editor.getEditorState().read(() => {
        ranges = [];
        for (const node of collectTextNodes()) {
          const key = node.getKey();
          const text = node.getTextContent();
          FAKE_MATCH.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = FAKE_MATCH.exec(text)) !== null) {
            ranges.push({
              nodeKey: key,
              offset: match.index,
              length: match[0].length,
              kind: KINDS[kindCursor++ % KINDS.length]!,
            });
          }
        }
        layer.setRanges(ranges);
      });
    };

    const unregisterRoot = editor.registerRootListener((root, prevRoot) => {
      if (prevRoot) layer.detach();
      if (root) {
        console.info(`${TAG} root mounted, attaching overlay`);
        layer.attach(root);
        recompute();
      }
    });

    const unregisterUpdate = editor.registerUpdateListener(({ dirtyLeaves }) => {
      // Edited nodes invalidate their own anchors. Everything else only moved,
      // so it repaints immediately and the user never sees a stale underline.
      if (dirtyLeaves.size > 0) {
        ranges = ranges.filter((range) => !dirtyLeaves.has(range.nodeKey));
      }
      layer.setRanges(ranges);

      clearTimeout(timer);
      timer = setTimeout(recompute, DEBOUNCE_MS);
    });

    return () => {
      clearTimeout(timer);
      unregisterUpdate();
      unregisterRoot();
      layer.detach();
    };
  },
});
