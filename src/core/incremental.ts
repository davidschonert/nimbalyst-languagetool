/**
 * Which blocks actually need checking.
 *
 * Chunking made a check several requests instead of one, but every check still
 * sent every chunk. Editing one paragraph re-sent the whole file, which on a
 * long document is most of the traffic and all of the latency.
 *
 * A block's matches are anchored to a node key and an in-node offset, which is
 * a coordinate space that does not depend on how the document was chunked. So
 * a block whose content and nodes are both unchanged can keep the matches it
 * had, and only the rest need to go to the service.
 *
 * Two things this gets wrong if done naively, and both are guarded here:
 *
 *   - Identical text in a node that was recreated is a different anchor. The
 *     fingerprint therefore covers the node keys and their offsets, not just
 *     the text, so a rebuilt node counts as stale rather than reusing an
 *     anchor that points at a node which no longer exists.
 *   - LanguageTool judges a paragraph partly by the ones around it, and its
 *     repetition and style rules reach across paragraph breaks. Sending a
 *     stale block on its own would silently drop those, and a match found on
 *     the document's first check would disappear for good the moment its block
 *     was re-checked alone. Every stale block is therefore padded with its
 *     immediate neighbours, and only the matches landing in a stale block are
 *     kept, since the neighbours' own results are already cached.
 */

import type { DocumentBlock } from './annotate';
import type { AnchoredMatch } from './types';

/** What a block said last time it was checked, keyed by `fingerprint`. */
export type BlockCache = Map<string, AnchoredMatch[]>;

/**
 * Length-prefixed, so no value can contain something that reads as the end of
 * itself. A separator character would have to be one the text cannot hold, and
 * document text can hold anything.
 */
function part(value: string): string {
  return value.length + ':' + value;
}

/**
 * A block's identity for caching: everything that decides whether its previous
 * matches are still usable.
 *
 * The whole content goes into the key rather than a hash of it. A collision
 * here would serve one block's matches for another block's text, which is a
 * wrong underline over something nobody checked, and that is the failure this
 * module exists to prevent rather than to introduce. Documents are small
 * enough that the honest key costs less than the risk.
 */
export function fingerprint(block: DocumentBlock): string {
  const items = block.annotation
    .map((item) =>
      'text' in item
        ? 't' + part(item.text)
        : 'm' + part(item.markup) + part(item.interpretAs ?? ''),
    )
    .join('');

  // Where the matches will anchor. The same text in a different node is not
  // the same block, because those anchors would point at a node that is gone.
  const anchors = block.segments
    .map((segment) => part(segment.nodeKey) + segment.nodeOffset + ',' + segment.length + ';')
    .join('');

  return items + '|' + anchors;
}

export interface CheckPlan {
  /** One per block, in document order, for reading and writing the cache. */
  fingerprints: string[];
  /** Blocks with no cached result. These are what the check is for. */
  stale: number[];
  /**
   * Contiguous runs of block indices to send, in document order. Each stale
   * block is padded with its immediate neighbours so the service still sees
   * the paragraphs around it, and pads that overlap are merged rather than
   * sent twice.
   */
  runs: number[][];
}

/** Work out what has to be sent, given what the cache already holds. */
export function planCheck(
  blocks: readonly DocumentBlock[],
  cached: ReadonlySet<string>,
): CheckPlan {
  const fingerprints = blocks.map(fingerprint);

  const stale: number[] = [];
  for (const [index, print] of fingerprints.entries()) {
    if (!cached.has(print)) stale.push(index);
  }

  const send = new Set<number>();
  for (const index of stale) {
    if (index > 0) send.add(index - 1);
    send.add(index);
    if (index + 1 < blocks.length) send.add(index + 1);
  }

  const runs: number[][] = [];
  for (const index of [...send].sort((a, b) => a - b)) {
    const open = runs[runs.length - 1];
    if (open && open[open.length - 1] === index - 1) open.push(index);
    else runs.push([index]);
  }

  return { fingerprints, stale, runs };
}

/**
 * The node keys a set of blocks covers.
 *
 * A run is sent for context but only its stale blocks are kept, and a match
 * says which node it landed on, so the node keys are what separates the two.
 * Each text node belongs to exactly one block, since the walk visits it once.
 */
export function nodeKeysOf(blocks: Iterable<DocumentBlock>): Set<string> {
  const keys = new Set<string>();
  for (const block of blocks) {
    for (const segment of block.segments) keys.add(segment.nodeKey);
  }
  return keys;
}

/**
 * Drop everything the current document does not contain any more.
 *
 * Called once a check settles, so the cache holds one entry per live block
 * rather than growing by a version of every paragraph the user passes through.
 */
export function prune(cache: BlockCache, keep: Iterable<string>): void {
  const live = new Set(keep);
  for (const print of [...cache.keys()]) {
    if (!live.has(print)) cache.delete(print);
  }
}
