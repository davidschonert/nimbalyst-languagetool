/**
 * The hook everything else hangs off.
 *
 * Nimbalyst feeds contributed Lexical extensions into the markdown editor's
 * extension graph, so `register` receives the live `LexicalEditor`. That is the
 * only handle an extension gets on the built-in editor.
 *
 * Spike 1 (passed) established that `register` fires for the built-in markdown
 * editor, that the root element is not mounted at that point, and that
 * `dirtyLeaves` is 0 on the first update.
 *
 * Spike 2 (passed) established that an absolutely positioned overlay holds its
 * position through typing, scrolling and reflow, provided repositioning and
 * re-checking do not share a debounce.
 *
 * Matches are still generated locally. Nothing talks to LanguageTool yet, so
 * the card and the apply/ignore paths can be judged before the client exists.
 */

import {
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isTextNode,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical';

import { buildAnnotatedDocument } from '../core/annotate';
import { triggerMode } from '../core/config';
import type { AnchoredMatch, CheckMatch, MatchKind } from '../core/types';
import { MatchPopover } from '../ui/MatchPopover';
import { UnderlineLayer, type UnderlineHit } from '../ui/UnderlineLayer';

/** Real checking will idle for 1.5-2s. Shorter here to make the spike easier to poke at. */
const DEBOUNCE_MS = 400;

/** Keep the fake set small enough that the card stays judgeable. */
const MAX_FAKE_MATCHES = 40;

/** Grace period so moving from an underline onto the card does not close it. */
const HOVER_CLOSE_MS = 140;

interface FakeRule {
  id: string;
  pattern: RegExp;
  kind: MatchKind;
  category: string;
  title: string;
  detail: string;
  replacements: (found: RegExpExecArray) => string[];
}

/**
 * Stand-ins shaped like real LanguageTool matches. The first reproduces the
 * decapitalize case from the reference screenshot.
 */
const FAKE_RULES: FakeRule[] = [
  {
    id: 'FAKE_UPPERCASE_SENTENCE_START',
    pattern: /\b[a-z]+\s+([A-Z][a-z]{2,})\b/g,
    kind: 'spelling',
    category: 'Correct',
    title: 'Spelling mistake',
    detail: 'Decapitalize word',
    replacements: (found) => [String(found[1]).toLowerCase()],
  },
  {
    id: 'FAKE_WORD_REPEAT',
    pattern: /\b(\w+)\s+\1\b/gi,
    kind: 'grammar',
    category: 'Grammar',
    title: 'Word repetition',
    detail: 'You repeated a word here.',
    replacements: (found) => [String(found[1])],
  },
  {
    id: 'FAKE_INTENSIFIER',
    pattern: /\b(?:very|really|quite)\s+([a-z]{3,})\b/gi,
    kind: 'style',
    category: 'Clarity',
    title: 'Wordiness',
    detail: 'Consider a stronger word instead of an intensifier.',
    replacements: (found) => [String(found[1])],
  },
];

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

/** Stable enough to dismiss one occurrence without dismissing its neighbours. */
function anchorId(anchor: AnchoredMatch): string {
  return anchor.nodeKey + ':' + anchor.offset + ':' + anchor.match.ruleId;
}

export const LanguageToolExtension = defineExtension({
  name: 'io.github.davidschonert.languagetool/lexical',

  register: (editor: LexicalEditor) => {
    const layer = new UnderlineLayer(editor);

    let matches: AnchoredMatch[] = [];
    const ignoredAnchors = new Set<string>();
    const ignoredRules = new Set<string>();

    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    const popover = new MatchPopover({
      onApply: (anchor, replacement) => {
        editor.update(() => {
          const node = $getNodeByKey(anchor.nodeKey);
          if (!$isTextNode(node)) return;
          node.spliceText(anchor.offset, anchor.length, replacement, true);
        });
      },
      onIgnore: (anchor) => {
        ignoredAnchors.add(anchorId(anchor));
        matches = matches.filter((entry) => entry !== anchor);
        layer.setMatches(matches);
      },
      onIgnoreRule: (anchor) => {
        ignoredRules.add(anchor.match.ruleId);
        matches = matches.filter((entry) => entry.match.ruleId !== anchor.match.ruleId);
        layer.setMatches(matches);
      },
    });

    const recompute = (): void => {
      editor.getEditorState().read(() => {
        const next: AnchoredMatch[] = [];

        scan: for (const node of collectTextNodes()) {
          const nodeKey = node.getKey();
          const text = node.getTextContent();

          for (const rule of FAKE_RULES) {
            if (ignoredRules.has(rule.id)) continue;

            rule.pattern.lastIndex = 0;
            let found: RegExpExecArray | null;
            while ((found = rule.pattern.exec(text)) !== null) {
              // Anchor to the captured group, not the whole match, so the
              // underline sits under the offending word, not its lead-in.
              const captured = String(found[1] ?? found[0]);
              const offset = found.index + found[0].indexOf(captured);

              const match: CheckMatch = {
                title: rule.title,
                detail: rule.detail,
                replacements: rule.replacements(found),
                ruleId: rule.id,
                category: rule.category,
                kind: rule.kind,
              };
              const anchor: AnchoredMatch = { nodeKey, offset, length: captured.length, match };

              if (!ignoredAnchors.has(anchorId(anchor))) next.push(anchor);
              if (next.length >= MAX_FAKE_MATCHES) break scan;
            }
          }
        }

        matches = next;
        layer.setMatches(matches);

        // TEMPORARY. The annotation cannot be judged without a server to send
        // it to, so it is published for inspection until the client lands.
        // In DevTools: copy(__ltAnnotation)
        const doc = buildAnnotatedDocument();
        const suppressed = doc.annotation.filter((item) => 'markup' in item);
        (window as Window & { __ltAnnotation?: unknown }).__ltAnnotation = doc.annotation;
        console.info('[languagetool] annotation', {
          items: doc.annotation.length,
          proseRuns: doc.segments.length,
          suppressed: suppressed.length,
          sample: suppressed.slice(0, 8),
        });
      });
    };

    const closeCard = (): void => {
      popover.hide();
      layer.setActive(null);
    };

    const scheduleClose = (): void => {
      if (closeTimer) return;
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        closeCard();
      }, HOVER_CLOSE_MS);
    };

    const cancelClose = (): void => {
      if (!closeTimer) return;
      clearTimeout(closeTimer);
      closeTimer = undefined;
    };

    const openFor = (hit: UnderlineHit): void => {
      if (popover.current === hit.anchor) return;
      popover.show(hit.anchor, hit.rect);
      layer.setActive(hit.anchor);
    };

    // The overlay stays pointer-events:none so it never interferes with text
    // selection. Both modes resolve the target by testing the pointer against
    // the rects the layer already computed.

    const onClick = (event: MouseEvent): void => {
      if (triggerMode() !== 'click') return;
      if (popover.contains(event.target)) return;

      const hit = layer.hitTest(event.clientX, event.clientY);
      if (!hit) {
        if (popover.isOpen) closeCard();
        return;
      }
      openFor(hit);
    };

    const onPointerMove = (event: MouseEvent): void => {
      if (triggerMode() !== 'hover') return;

      if (popover.contains(event.target)) {
        cancelClose();
        return;
      }

      const hit = layer.hitTest(event.clientX, event.clientY);
      if (!hit) {
        if (popover.isOpen) scheduleClose();
        return;
      }

      cancelClose();
      openFor(hit);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && popover.isOpen) closeCard();
    };

    // Rects go stale the instant anything scrolls, so the card closes rather
    // than floating away from its word. Capture catches inner scrollers too.
    const onScrollCapture = (): void => {
      if (popover.isOpen) closeCard();
    };

    // Both listeners stay attached and each checks the mode, so switching the
    // setting never requires re-wiring.
    document.addEventListener('click', onClick);
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScrollCapture, true);

    const unregisterRoot = editor.registerRootListener((root, prevRoot) => {
      if (prevRoot) layer.detach();
      if (root) {
        layer.attach(root);
        recompute();
      }
    });

    const unregisterUpdate = editor.registerUpdateListener(({ dirtyLeaves }) => {
      // Edited nodes invalidate their own anchors. Everything else only moved,
      // so it repaints immediately and the user never sees a stale underline.
      if (dirtyLeaves.size > 0) {
        matches = matches.filter((anchor) => !dirtyLeaves.has(anchor.nodeKey));
        if (popover.current && dirtyLeaves.has(popover.current.nodeKey)) closeCard();
      }
      layer.setMatches(matches);

      clearTimeout(checkTimer);
      checkTimer = setTimeout(recompute, DEBOUNCE_MS);
    });

    return () => {
      clearTimeout(checkTimer);
      cancelClose();
      document.removeEventListener('click', onClick);
      document.removeEventListener('mousemove', onPointerMove);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScrollCapture, true);
      unregisterUpdate();
      unregisterRoot();
      popover.destroy();
      layer.detach();
    };
  },
});
