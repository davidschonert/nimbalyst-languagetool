/**
 * The hook everything else hangs off.
 *
 * Nimbalyst feeds contributed Lexical extensions into the markdown editor's
 * extension graph, so `register` receives the live `LexicalEditor`. That is the
 * only handle an extension gets on the built-in editor.
 *
 * Spike 1 established that `register` fires for the built-in markdown editor,
 * that the root element is not mounted at that point, and that `dirtyLeaves` is
 * 0 on the first update. Spike 2 established that an absolutely positioned
 * overlay holds its position through typing, scrolling and reflow, provided
 * repositioning and re-checking do not share a debounce.
 */

import { $getNodeByKey, $isTextNode, defineExtension, type LexicalEditor } from 'lexical';

import { buildAnnotatedDocument, type AnnotatedDocument } from '../core/annotate';
import { check, CheckError, type Backend, type CheckErrorKind } from '../core/client';
import { backend, checkOptions, triggerMode } from '../core/config';
import { anchorMatches } from '../core/matches';
import type { AnchoredMatch } from '../core/types';
import { MatchPopover } from '../ui/MatchPopover';
import { UnderlineLayer, type UnderlineHit } from '../ui/UnderlineLayer';

/**
 * Long enough that a pause in typing triggers a check, not a keystroke.
 *
 * A local server is unmetered and answers a full document in roughly half a
 * second, so it can afford to feel responsive. The cloud backend is rate
 * limited per day, so it waits for a real pause rather than a gap between
 * words. Superseded checks are aborted either way, so a short wait costs
 * cancelled requests rather than duplicated work.
 */
const CHECK_DEBOUNCE_MS: Record<Backend, number> = {
  local: 400,
  cloud: 2500,
};

/** Grace period so moving from an underline onto the card does not close it. */
const HOVER_CLOSE_MS = 140;

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

    // Supersede rather than queue: only the newest check matters.
    let checkToken = 0;
    let inFlight: AbortController | undefined;
    /** Only report a distinct failure once, so a stopped server does not spam. */
    let reportedFailure: CheckErrorKind | undefined;
    let hasChecked = false;

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

    const closeCard = (): void => {
      popover.hide();
      layer.setActive(null);
    };

    const runCheck = async (): Promise<void> => {
      const token = ++checkToken;
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;

      let doc: AnnotatedDocument | undefined;
      editor.getEditorState().read(() => {
        doc = buildAnnotatedDocument();
      });
      if (!doc) return;

      const options = checkOptions();
      // Rules dismissed with the card's disable control are declined at the
      // server, so it never spends work finding them again.
      if (ignoredRules.size > 0) {
        options.disabledRules = [...(options.disabledRules ?? []), ...ignoredRules];
      }

      try {
        const raw = await check(doc, options, controller.signal);
        if (token !== checkToken) return;

        reportedFailure = undefined;
        matches = anchorMatches(doc, raw).filter(
          (anchor) => !ignoredAnchors.has(anchorId(anchor)),
        );
        layer.setMatches(matches);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (token !== checkToken) return;

        // A local server that is not running is an expected state, not an
        // error to shout about. Go quiet and try again on the next pause.
        matches = [];
        layer.setMatches(matches);
        closeCard();

        const kind = error instanceof CheckError ? error.kind : 'http';
        if (kind !== reportedFailure) {
          reportedFailure = kind;
          console.warn('[languagetool] check failed:', (error as Error).message);
        }
      }
    };

    const scheduleCheck = (): void => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        hasChecked = true;
        void runCheck();
      }, CHECK_DEBOUNCE_MS[backend()]);
    };

    const openFor = (hit: UnderlineHit): void => {
      if (popover.current === hit.anchor) return;
      popover.show(hit.anchor, hit.rect);
      layer.setActive(hit.anchor);
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
      if (root) layer.attach(root);
    });

    const unregisterUpdate = editor.registerUpdateListener(({ dirtyLeaves }) => {
      // Edited nodes invalidate their own anchors. Everything else only moved,
      // so it repaints immediately and the user never sees a stale underline.
      if (dirtyLeaves.size > 0) {
        matches = matches.filter((anchor) => !dirtyLeaves.has(anchor.nodeKey));
        if (popover.current && dirtyLeaves.has(popover.current.nodeKey)) closeCard();
      }
      layer.setMatches(matches);

      // Moving the caret changes no text, so it is not worth a request. The
      // first update is the initial load, which reports no dirty leaves.
      if (dirtyLeaves.size === 0 && hasChecked) return;
      scheduleCheck();
    });

    return () => {
      clearTimeout(checkTimer);
      cancelClose();
      inFlight?.abort();
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
