/**
 * Blocks to request-sized chunks.
 *
 * LanguageTool rejects a single request over 20,000 characters on the free
 * tier and 60,000 on Premium, and a document over the cap fails outright: the
 * underlines disappear and the only explanation the user gets is an HTTP
 * error. That is what makes chunking necessary rather than an optimization. It
 * pays twice more, though — the top of a long document comes back while the
 * rest is still in flight, and a check stops being all or nothing.
 *
 * The split rule is where the whole risk sits. LanguageTool judges a sentence
 * by the whole sentence, so a boundary inside one produces false positives at
 * every seam. Chunks therefore end only between blocks, which is where the
 * rendered document already has a paragraph break and where `annotate.ts` has
 * already put one.
 *
 * The single exception is a block larger than the entire budget: a paste with
 * no paragraph breaks in it. That has to be split somewhere or it can never be
 * checked at all, so it falls back to the last sentence end that fits, then to
 * the last word boundary, and only then straight through a token.
 *
 * Size is measured twice, because two different things are bounded. The
 * service's cap counts the text it actually sees, which is prose plus the
 * `interpretAs` substitutes; the raw length is what the request body carries
 * and what a match offset indexes. A chunk stays under the limit on both.
 */

import {
  assembleDocument,
  BlockBuilder,
  BLOCK_BREAK,
  type AnnotationItem,
  type DocumentBlock,
} from './annotate';

/** A sentence end: a terminator, any closing quote or bracket, then whitespace. */
const SENTENCE_END = /[.!?…]["'”’»)\]]*\s+/g;

/** The fallback boundary, which at least leaves every word whole. */
const WORD_END = /\s+/g;

/** An item's contribution to the offset space. */
function rawLengthOf(item: AnnotationItem): number {
  return 'text' in item ? item.text.length : item.markup.length;
}

/**
 * The document sliced into requests, each no larger than `limit` characters.
 *
 * A chunk with nothing checkable in it — a lone code block, a run of images —
 * is dropped rather than sent, since the service would have nothing to say
 * about it and any match it did return would be unanchorable anyway.
 *
 * Given a limit larger than the document, this returns exactly what
 * `buildAnnotatedDocument()` builds, in one chunk.
 */
export function chunkDocument(
  blocks: readonly DocumentBlock[],
  limit: number,
  padded: ReadonlySet<number> = new Set(),
): DocumentBlock[] {
  return packBlocks(blocks, limit, padded)
    .map(assembleDocument)
    .filter((chunk) => chunk.segments.length > 0);
}

/** What a run of block positions costs once assembly has joined them. */
function measure(
  blocks: readonly DocumentBlock[],
  positions: readonly number[],
): { raw: number; text: number } {
  let raw = 0;
  let text = 0;

  for (const [order, position] of positions.entries()) {
    if (order > 0) {
      raw += BLOCK_BREAK.length;
      text += BLOCK_BREAK.length;
    }
    const block = blocks[position]!;
    raw += block.rawLength;
    text += block.textLength;
  }

  return { raw, text };
}

/**
 * Group consecutive blocks into chunks, splitting any single block that is
 * larger than the budget on its own.
 *
 * `padded` names the positions that were given neighbours for context, in the
 * caller's coordinates. A boundary immediately before or after one of those
 * takes that context away again, which is a silent loss of exactly the rules
 * the pad was added for, so the packer backs up to an earlier boundary when it
 * can.
 *
 * It cannot always. Blocks only move into the next chunk while they still fit
 * there, so a run long enough to need a boundary in an awkward place gets one.
 * That residual is recorded in CLAUDE.md rather than pretended away: a pad the
 * budget cannot honour will always be possible.
 */
export function packBlocks(
  blocks: readonly DocumentBlock[],
  limit: number,
  padded: ReadonlySet<number> = new Set(),
): DocumentBlock[][] {
  const budget = Math.max(1, Math.floor(limit));
  const chunks: DocumentBlock[][] = [];

  /** A boundary after `position` separates it from the block that follows. */
  const separates = (position: number): boolean =>
    padded.has(position) || padded.has(position + 1);

  const fits = (positions: readonly number[]): boolean => {
    const { raw, text } = measure(blocks, positions);
    return raw <= budget && text <= budget;
  };

  let current: number[] = [];
  let raw = 0;
  let text = 0;

  const take = (positions: number[]): void => {
    current = positions;
    const size = measure(blocks, positions);
    raw = size.raw;
    text = size.text;
  };

  const flush = (): void => {
    if (current.length > 0) chunks.push(current.map((position) => blocks[position]!));
    take([]);
  };

  for (const [position, block] of blocks.entries()) {
    if (block.rawLength > budget || block.textLength > budget) {
      // Oversized, so it is split, and each part becomes a chunk on its own.
      // Packing a part next to a neighbour would put a paragraph break at
      // whatever the split rule had to settle for, and that is only a sentence
      // end in the best case.
      flush();
      for (const part of splitBlock(block, budget)) chunks.push([part]);
      continue;
    }

    // Assembly puts a paragraph break between each pair, so the join itself
    // costs two characters that have to be budgeted for.
    const gap = current.length === 0 ? 0 : BLOCK_BREAK.length;
    const overflows =
      raw + gap + block.rawLength > budget || text + gap + block.textLength > budget;

    if (current.length > 0 && overflows) {
      // How many blocks stay behind. All of them is the greedy answer, and the
      // right one whenever the boundary it leaves does not strip a pad.
      let keep = current.length;

      if (separates(current[keep - 1]!)) {
        for (let candidate = keep - 1; candidate >= 1; candidate -= 1) {
          // Whatever moves forward has to fit in the chunk it moves to.
          if (!fits([...current.slice(candidate), position])) break;
          if (!separates(current[candidate - 1]!)) {
            keep = candidate;
            break;
          }
        }
      }

      const carry = current.slice(keep);
      chunks.push(current.slice(0, keep).map((index) => blocks[index]!));
      take(carry);
    }

    if (current.length > 0) {
      raw += BLOCK_BREAK.length;
      text += BLOCK_BREAK.length;
    }
    current.push(position);
    raw += block.rawLength;
    text += block.textLength;
  }

  flush();
  return chunks;
}

/**
 * One item of a block, with the position of a prose run carried alongside it
 * so a split can put both halves back where they came from.
 */
type Piece =
  | { text: string; nodeKey: string; nodeOffset: number }
  | { markup: string; interpretAs?: string };

function piecesOf(block: DocumentBlock): Piece[] {
  const byStart = new Map(block.segments.map((segment) => [segment.start, segment]));
  const pieces: Piece[] = [];
  let cursor = 0;

  for (const item of block.annotation) {
    if ('text' in item) {
      // Every text item was recorded with a segment starting at its own
      // offset, so the lookup holds by construction. Treating a run with no
      // segment as markup would keep the offsets right and lose the underline.
      const segment = byStart.get(cursor);
      pieces.push(
        segment
          ? { text: item.text, nodeKey: segment.nodeKey, nodeOffset: segment.nodeOffset }
          : { markup: item.text, interpretAs: item.text },
      );
    } else if (item.interpretAs === undefined) {
      pieces.push({ markup: item.markup });
    } else {
      pieces.push({ markup: item.markup, interpretAs: item.interpretAs });
    }
    cursor += rawLengthOf(item);
  }

  return pieces;
}

function* splitBlock(block: DocumentBlock, budget: number): Generator<DocumentBlock> {
  let builder = new BlockBuilder();

  for (const piece of piecesOf(block)) {
    if ('markup' in piece) {
      // Markup is opaque: it is placed, never split. One larger than the whole
      // budget therefore ends up alone in a chunk, which carries no segments
      // and so is never sent.
      const plain = piece.interpretAs?.length ?? 0;
      const room =
        builder.rawLength + piece.markup.length <= budget &&
        builder.textLength + plain <= budget;

      if (!room && builder.rawLength > 0) {
        yield builder.build();
        builder = new BlockBuilder();
      }
      builder.markup(piece.markup, piece.interpretAs);
      continue;
    }

    let text = piece.text;
    let nodeOffset = piece.nodeOffset;

    while (text.length > 0) {
      if (builder.rawLength >= budget || builder.textLength >= budget) {
        yield builder.build();
        builder = new BlockBuilder();
      }

      // At least one character, so consuming the run always makes progress.
      const room = Math.max(1, Math.min(budget - builder.rawLength, budget - builder.textLength));

      if (text.length <= room) {
        builder.text(text, piece.nodeKey, nodeOffset);
        break;
      }

      const cut = cutPoint(text, room);

      // No boundary fits the room left. Start a part instead of cutting here,
      // since a fresh one gets the whole budget and will usually hold one. A
      // markup piece placed earlier can leave only a few characters, and
      // cutting there would split a word that is nowhere near budget-length.
      if (cut === 0 && builder.rawLength > 0) {
        yield builder.build();
        builder = new BlockBuilder();
        continue;
      }

      // Only now is it a token longer than the entire budget.
      const taken = cut === 0 ? room : cut;

      builder.text(text.slice(0, taken), piece.nodeKey, nodeOffset);
      yield builder.build();
      builder = new BlockBuilder();
      nodeOffset += taken;
      text = text.slice(taken);
    }
  }

  if (builder.rawLength > 0) yield builder.build();
}

/**
 * Where to cut a prose run that does not fit, as an index into it, or 0 when
 * neither rung of the ladder lands inside `room`.
 *
 * Reporting 0 rather than falling back to `room` here is what lets the caller
 * try a fresh part first. Cutting through a token is the last resort in the
 * whole split, not the last resort in one call.
 */
function cutPoint(text: string, room: number): number {
  const sentence = lastBoundary(text, room, SENTENCE_END);
  if (sentence > 0) return sentence;

  // No sentence end fits. A word boundary at least leaves every word whole, so
  // the seam cannot invent a spelling match out of half of one.
  return lastBoundary(text, room, WORD_END);
}

/** The end of the last `pattern` match at or before `room`, or 0 if there is none. */
function lastBoundary(text: string, room: number, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let best = 0;
  let found: RegExpExecArray | null;

  while ((found = pattern.exec(text)) !== null) {
    const end = found.index + found[0].length;
    if (end > room) break;
    best = end;
  }

  return best;
}
