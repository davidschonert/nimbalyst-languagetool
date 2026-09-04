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

import { buildDocumentBlocks, type DocumentBlock } from '../core/annotate';
import { CLOUD_BUDGET, RateMeter } from '../core/budget';
import { chunkDocument } from '../core/chunk';
import { check, CheckError, type Backend, type CheckErrorKind, type CheckOptions } from '../core/client';
import { backend, checkOptions, chunkLimit, triggerMode, warnOnRateLimit } from '../core/config';
import { addWord, dictionaryEnabled, isIgnored } from '../core/dictionary';
import { planCheck, prune, type BlockCache } from '../core/incremental';
import { anchorMatches, carryOver } from '../core/matches';
import { readApiKey } from '../core/secrets';
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
 * canceled requests rather than duplicated work.
 */
const CHECK_DEBOUNCE_MS: Record<Backend, number> = {
  local: 400,
  cloud: 2500,
};

/** Grace period so moving from an underline onto the card does not close it. */
const HOVER_CLOSE_MS = 140;

/** Stable enough to dismiss one occurrence without dismissing its neighbors. */
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
    /**
     * Nodes edited while a check is in flight, collected by the update
     * listener for whichever run is open.
     *
     * The token alone does not catch an edit made mid-run, because an edit does
     * not start a new check until the debounce fires, so a response built from
     * the older tree would be anchored to offsets that have already moved. This
     * used to be a document-wide version counter, which meant one keystroke
     * threw away every chunk still to come and a long document's tail was never
     * reached. An anchor is a node key and an offset inside that node, so
     * editing one node cannot move another node's offsets: the question is per
     * chunk, and asking it per chunk is both safe and survivable.
     */
    let dirtiedDuringRun: Set<string> | undefined;
    /**
     * The open run's per-block view of the document, so an edit moves it too.
     *
     * `settle()` rebuilds what is painted from this map, so leaving it on the
     * pre-edit anchors would undo every `carryOver` the listener performed
     * while the run was in flight, and put an anchor back over text the service
     * never judged. Replacing an entry never touches the cache's own array,
     * which is right: an edited block's fingerprint has changed, so it is stale
     * on the next check regardless.
     */
    let heldDuringRun: Map<number, AnchoredMatch[]> | undefined;
    /** What each block said last time, so an unchanged one is not re-sent. */
    const cache: BlockCache = new Map();
    /** Every cached answer assumes the request that produced it. */
    let cachedFor: string | undefined;
    /**
     * Only the cloud backend is metered. A self-hosted server is unmetered, and
     * throttling it would only make the local experience worse for nothing.
     */
    const meter = new RateMeter(CLOUD_BUDGET);
    /** Only report a distinct failure once, so a stopped server does not spam. */
    let reportedFailure: CheckErrorKind | undefined;
    let hasChecked = false;

    const popover = new MatchPopover({
      onClose: () => layer.setActive(null),
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
      canAddToDictionary: dictionaryEnabled,
      onAddToDictionary: (anchor) => {
        // Resolves on the local write. The account copy is its own promise and
        // is deliberately not awaited, so an unreachable account never leaves
        // the word underlined.
        void addWord(anchor.match.word).then((result) => {
          if (!result.added) return;
          // Drop every occurrence now rather than leaving them underlined
          // until the next check. isIgnored is the single source of truth for
          // what counts as a match, so the filter cannot drift from it.
          matches = matches.filter((entry) => !isIgnored(entry.match.word));
          layer.setMatches(matches);
        });
      },
      onIgnoreRule: (anchor) => {
        ignoredRules.add(anchor.match.ruleId);
        matches = matches.filter((entry) => entry.match.ruleId !== anchor.match.ruleId);
        layer.setMatches(matches);
      },
    });

    // hide() reports the close, which is what clears the underline tint.
    const closeCard = (): void => popover.hide();

    /**
     * Everything about a request that changes what comes back. A cached answer
     * is only good while this holds, so changing the language or turning on
     * picky throws the whole cache away rather than mixing the results of two
     * different settings into one document.
     */
    const requestShape = (options: CheckOptions): string =>
      JSON.stringify([
        options.backend,
        options.baseUrl,
        options.language,
        options.picky ?? false,
        options.motherTongue ?? '',
        options.preferredVariants ?? [],
        options.disabledRules ?? [],
        options.disabledCategories ?? [],
        options.username ?? '',
      ]);

    /**
     * Applied here rather than baked into what is cached, so adding a word to
     * the dictionary or dismissing one occurrence takes effect without
     * discarding a document's worth of answers.
     *
     * Ignoring a whole rule is not one of those. It joins `disabledRules`, which
     * is part of the request, so the next run finds a different `requestShape`
     * and empties the cache. That is correct rather than wasteful, since the
     * answers were all computed with that rule enabled.
     */
    const visible = (anchor: AnchoredMatch): boolean =>
      !ignoredAnchors.has(anchorId(anchor)) &&
      !ignoredRules.has(anchor.match.ruleId) &&
      !(anchor.match.word !== '' && isIgnored(anchor.match.word));

    const runCheck = async (): Promise<void> => {
      const token = ++checkToken;
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;

      const dirtied = new Set<string>();
      dirtiedDuringRun = dirtied;

      let blocks: DocumentBlock[] = [];
      editor.getEditorState().read(() => {
        blocks = buildDocumentBlocks();
      });

      const options = checkOptions();
      // Rules dismissed with the card's disable control are declined at the
      // server, so it never spends work finding them again.
      if (ignoredRules.size > 0) {
        options.disabledRules = [...(options.disabledRules ?? []), ...ignoredRules];
      }
      // Read only when the cloud backend is actually selected, so the token is
      // never fetched for a workflow that does not use it.
      if (options.backend === 'cloud') {
        const apiKey = await readApiKey();
        if (apiKey) options.apiKey = apiKey;
      }
      if (token !== checkToken) return;

      const shape = requestShape(options);
      if (shape !== cachedFor) {
        cache.clear();
        cachedFor = shape;
      }

      const plan = planCheck(blocks, new Set(cache.keys()));
      const stale = new Set(plan.stale);

      // Each text node belongs to exactly one block, since the walk visits it
      // once, so this is what sorts a returned match into the block it came
      // from and separates a run's stale blocks from its context.
      const blockOfNode = new Map<string, number>();
      blocks.forEach((block, index) => {
        for (const segment of block.segments) blockOfNode.set(segment.nodeKey, index);
      });

      // The document is assembled from this, one entry per block, so a repaint
      // is always the union of every block's current answer.
      const byBlock = new Map<number, AnchoredMatch[]>();
      plan.fingerprints.forEach((print, index) => {
        // Copied, not aliased. The cache's array must not be reachable from
        // anything that carries anchors across an edit or replaces an answer.
        if (!stale.has(index)) byBlock.set(index, [...(cache.get(print) ?? [])]);
      });
      // A block waiting on its answer keeps what is painted on it, so editing a
      // paragraph does not blank it until the service replies.
      for (const anchor of matches) {
        const index = blockOfNode.get(anchor.nodeKey);
        if (index === undefined || !stale.has(index)) continue;
        const held = byBlock.get(index);
        if (held) held.push(anchor);
        else byBlock.set(index, [anchor]);
      }

      const settle = (): AnchoredMatch[] => {
        const all: AnchoredMatch[] = [];
        for (let index = 0; index < plan.fingerprints.length; index += 1) {
          for (const anchor of byBlock.get(index) ?? []) {
            if (visible(anchor)) all.push(anchor);
          }
        }
        return all;
      };

      // A block is only replaced by the first chunk that answers for it. An
      // oversized block is split across chunks, so clearing on each one would
      // let the second wipe what the first had just contributed.
      heldDuringRun = byBlock;

      const replaced = new Set<number>();
      const skipped = new Set<number>();
      /** Whether the service answered at all, which is not the same as replacing a block. */
      let anyAnswer = false;
      /** Set when the budget ran out, so the run is resumed rather than lost. */
      let deferredBy = 0;

      try {
        // Sequential, so the underlines land top down and a long document does
        // not fire every one of its requests at the service at once.
        for (const run of plan.runs) {
          const sending = run.map((index) => blocks[index]!);
          // Where the stale blocks sit within this run, so the packer can avoid
          // cutting one off from the neighbour that was added to give it
          // context.
          const padded = new Set<number>();
          run.forEach((index, position) => {
            if (stale.has(index)) padded.add(position);
          });

          for (const chunk of chunkDocument(sending, chunkLimit(), padded)) {
            // The service counts the text it sees, which is the prose plus the
            // markup substitutes, so that is what the meter is charged.
            const cost = options.backend === 'cloud' ? chunk.textLength : 0;
            const wait = options.backend === 'cloud' ? meter.waitFor(cost) : 0;

            if (wait > 0) {
              // Deferred, not dropped. Everything not yet answered stays stale,
              // so this picks up here rather than starting over.
              if (warnOnRateLimit()) {
                console.warn(
                  `[languagetool] rate limit reached, deferring the rest of this check for ${Math.ceil(wait / 1000)}s`,
                );
              }
              deferredBy = Math.max(deferredBy, wait);
              break;
            }

            if (cost > 0) meter.record(cost);
            const raw = await check(chunk, options, controller.signal);
            if (token !== checkToken) return;
            anyAnswer = true;
            meter.accepted();

            // Which of this chunk's blocks the answer is actually for. The rest
            // of the run went along for sentence context, and their own results
            // are already cached.
            const answered = new Set<number>();
            let moved = false;
            for (const segment of chunk.segments) {
              if (dirtied.has(segment.nodeKey)) moved = true;
              const index = blockOfNode.get(segment.nodeKey);
              if (index !== undefined && stale.has(index)) answered.add(index);
            }

            // The text under this chunk changed while it was in flight, so its
            // offsets have moved and the answer is not about this document any
            // more. Leave those blocks stale for the next check rather than
            // abandoning every chunk still to come.
            if (moved) {
              for (const index of answered) skipped.add(index);
              continue;
            }

            for (const index of answered) {
              if (replaced.has(index)) continue;
              replaced.add(index);
              byBlock.set(index, []);
            }
            for (const anchor of anchorMatches(chunk, raw)) {
              const index = blockOfNode.get(anchor.nodeKey);
              if (index === undefined || !answered.has(index)) continue;
              byBlock.get(index)?.push(anchor);
            }

            matches = settle();
            layer.setMatches(matches);
          }

          // Every chunk covering this run has answered, so its blocks are
          // settled and can be cached. Caching per chunk would not be safe,
          // since an oversized block is split across several of them and the
          // first would store half an answer if a later one failed. A block the
          // budget stopped this run from reaching was never asked about, so
          // `replaced` is what separates an empty answer from no answer.
          for (const index of run) {
            if (!stale.has(index) || skipped.has(index) || !replaced.has(index)) continue;
            cache.set(plan.fingerprints[index]!, byBlock.get(index) ?? []);
          }

          // The budget stopped the chunk loop, so it stops the runs too.
          if (deferredBy > 0) break;
        }

        // Every chunk answered, so whatever was wrong is over. Resetting inside
        // the loop would let a chunk that fails every time warn on every check,
        // since an earlier chunk succeeding would clear the flag first.
        reportedFailure = undefined;

        matches = settle();
        layer.setMatches(matches);

        if (deferredBy > 0) scheduleRetry(deferredBy);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (token !== checkToken) return;

        // The service knows better than the meter does. Back off, and come back
        // rather than waiting for the user to type something.
        if (error instanceof CheckError && error.kind === 'rate') {
          meter.refuse(error.retryAfterMs);
          const wait = meter.waitFor(0);
          if (warnOnRateLimit()) {
            console.warn(
              `[languagetool] the service refused for rate, backing off ${Math.ceil(wait / 1000)}s`,
            );
          }
          scheduleRetry(wait);
        }

        // Settle on what did answer. A chunk failing partway through no longer
        // throws away the chunks before it, which on a long document is most of
        // the work and, on cloud, the expected shape of hitting a rate limit.
        matches = settle();
        layer.setMatches(matches);

        // Nothing answered at all, which is what a local server that is not
        // running looks like. That is an expected state rather than an error to
        // shout about, so go quiet and try again on the next pause.
        if (!anyAnswer) closeCard();

        const kind = error instanceof CheckError ? error.kind : 'http';
        if (kind !== reportedFailure) {
          reportedFailure = kind;
          console.warn('[languagetool] check failed:', (error as Error).message);
        }
      } finally {
        if (dirtiedDuringRun === dirtied) dirtiedDuringRun = undefined;
        if (heldDuringRun === byBlock) heldDuringRun = undefined;
        // Outside the try, so a failure partway through still leaves the cache
        // holding one entry per live block rather than a version of every
        // paragraph the user has passed through.
        prune(cache, plan.fingerprints);
      }
    };

    /**
     * Come back when the budget allows it, rather than on the next keystroke.
     * The blocks this run did not reach are still stale, so the next run picks
     * up where this one stopped instead of starting again at the top.
     */
    const scheduleRetry = (delayMs: number): void => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => void runCheck(), Math.max(delayMs, CHECK_DEBOUNCE_MS[backend()]));
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

    const unregisterUpdate = editor.registerUpdateListener(
      ({ dirtyLeaves, editorState, prevEditorState }) => {
        // An edit moves the text out from under the anchors in the node it
        // touched, so those are carried to where their text now is rather than
        // dropped. Only the match the edit ran through goes, which leaves the
        // rest of the paragraph underlined and clickable while the next check
        // is still in flight. Everything outside the node only moved on screen,
        // so it repaints immediately.
        if (dirtyLeaves.size > 0) {
          // A check in flight needs to know which nodes moved under it, so it
          // can discard the chunks that covered them and keep the rest.
          if (dirtiedDuringRun) {
            for (const key of dirtyLeaves) dirtiedDuringRun.add(key);
          }
          if (heldDuringRun) {
            for (const [index, held] of heldDuringRun) {
              heldDuringRun.set(index, carryOver(held, dirtyLeaves, prevEditorState, editorState));
            }
          }
          matches = carryOver(matches, dirtyLeaves, prevEditorState, editorState);
          if (popover.current && dirtyLeaves.has(popover.current.nodeKey)) closeCard();
        }
        layer.setMatches(matches);

        // Moving the caret changes no text, so it is not worth a request. The
        // first update is the initial load, which reports no dirty leaves.
        if (dirtyLeaves.size === 0 && hasChecked) return;
        scheduleCheck();
      },
    );

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
