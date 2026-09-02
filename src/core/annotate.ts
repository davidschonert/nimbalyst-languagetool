/**
 * Lexical tree to LanguageTool AnnotatedText.
 *
 * The document is a node tree, not a markdown string, so the annotation is
 * built directly from the tree. Nothing is serialized to markdown and re-parsed,
 * which means match offsets never have to be reverse-mapped through a
 * round trip: every emitted run of prose records where it came from.
 *
 * Offset model, confirmed against a live LanguageTool 6.6 server:
 * a `markup` item contributes its RAW length to the offset space, not the
 * length of its `interpretAs`. A match reported at offset N therefore indexes
 * into the concatenation of every item exactly as supplied.
 *
 * Two failure modes this exists to avoid, both reproduced before writing it:
 *   - Markup with no `interpretAs` collapses the surrounding whitespace and
 *     LanguageTool reports CONSECUTIVE_SPACES across a range the user cannot
 *     act on. Inline markup therefore always carries a substitute.
 *   - A match can begin inside markup and run into real prose. Those are
 *     dropped rather than clipped, because their start offset is not a
 *     position the user can edit.
 *
 * The walk emits blocks rather than one flat annotation, and `assembleDocument`
 * joins them back up. That is what makes chunking possible without a second
 * implementation of the offset model: a chunk is the same assembly over a
 * slice of the blocks, so its offsets are internally consistent by
 * construction. See `chunk.ts`.
 */

import { $getRoot, $isElementNode, $isLineBreakNode, $isTextNode } from 'lexical';
import type { ElementNode, LexicalNode } from 'lexical';

export type AnnotationItem = { text: string } | { markup: string; interpretAs?: string };

/** A run of real prose, and the Lexical position it came from. */
export interface TextSegment {
  /** Offset of this run within the annotated document. */
  start: number;
  length: number;
  nodeKey: string;
  /** Offset of this run within its TextNode. */
  nodeOffset: number;
}

export interface AnnotatedDocument {
  /** The `data` payload for POST /v2/check. */
  annotation: AnnotationItem[];
  /** Ordered and non-overlapping, so a match offset resolves by scan. */
  segments: TextSegment[];
}

/**
 * One run of block content, in an offset space of its own that starts at zero.
 *
 * Blocks are the unit chunking works in, because a chunk may only end where
 * the rendered document already has a paragraph break. Anywhere else splits a
 * sentence, and LanguageTool needs the whole sentence to judge it.
 */
export interface DocumentBlock extends AnnotatedDocument {
  /** Length in the offset space, which is what a match offset indexes. */
  rawLength: number;
  /** Length of the text the service sees, which is what its size cap measures. */
  textLength: number;
}

/** An anchored range, in the coordinates the underline layer uses. */
export interface ResolvedRange {
  nodeKey: string;
  offset: number;
  length: number;
}

/**
 * GitBook directives. Confirmed present in real documents and rendered as
 * ordinary paragraph text by Nimbalyst, so there is no node type to key off.
 */
const GITBOOK_DIRECTIVE = /\{%.*?%\}/gs;

/**
 * Substitutes for inline markup. These only have to keep the sentence
 * well-formed and the spacing intact. Any match landing on one is discarded,
 * because its start offset falls inside markup.
 */
const INLINE_CODE_AS = 'code';
const DECORATOR_AS = 'item';

/** Block types whose entire content is markup rather than prose. */
const OPAQUE_BLOCK_TYPES = new Set(['code', 'horizontalrule', 'table']);

/**
 * The paragraph break between blocks. It is markup rather than prose, so no
 * match can be anchored inside it, and it is the only place a chunk may end.
 */
export const BLOCK_BREAK = '\n\n';

/**
 * Assembles one offset space: items in, an offset-consistent block out.
 *
 * This is the single place the offset model is implemented, which is why
 * chunking reuses it rather than doing its own arithmetic. A markup item
 * contributes its raw length to the offset space and its substitute's length
 * to the text the service measures, and those two numbers are tracked
 * separately because the size cap is measured in the second one.
 */
export class BlockBuilder {
  private readonly items: AnnotationItem[] = [];
  private readonly segments: TextSegment[] = [];
  private raw = 0;
  private plain = 0;

  /** Length in the offset space, which is what a match offset indexes. */
  get rawLength(): number {
    return this.raw;
  }

  /** Length of the text the service sees, which is what its size cap measures. */
  get textLength(): number {
    return this.plain;
  }

  text(value: string, nodeKey: string, nodeOffset: number): void {
    if (value.length === 0) return;
    this.items.push({ text: value });
    this.segments.push({ start: this.raw, length: value.length, nodeKey, nodeOffset });
    this.raw += value.length;
    this.plain += value.length;
  }

  markup(raw: string, interpretAs?: string): void {
    if (raw.length === 0) return;
    this.items.push(interpretAs === undefined ? { markup: raw } : { markup: raw, interpretAs });
    // Raw length into the offset space, substitute length into the text. See
    // the offset model above.
    this.raw += raw.length;
    this.plain += interpretAs?.length ?? 0;
  }

  /** Append a finished block, rebasing its segments onto this offset space. */
  append(block: DocumentBlock): void {
    const base = this.raw;
    for (const item of block.annotation) this.items.push(item);
    for (const segment of block.segments) {
      this.segments.push({ ...segment, start: segment.start + base });
    }
    this.raw += block.rawLength;
    this.plain += block.textLength;
  }

  build(): DocumentBlock {
    return {
      annotation: this.items,
      segments: this.segments,
      rawLength: this.raw,
      textLength: this.plain,
    };
  }
}

/**
 * The tree walk's accumulator. It records where the blocks are as it goes, so
 * chunking never has to re-derive the boundaries from the flat item list.
 */
class AnnotationBuilder {
  private readonly blocks: DocumentBlock[] = [];
  private current = new BlockBuilder();
  /** Document-wide, separators included, so the walk's own tests still hold. */
  private cursor = 0;

  text(value: string, nodeKey: string, nodeOffset: number): void {
    if (value.length === 0) return;
    this.current.text(value, nodeKey, nodeOffset);
    this.cursor += value.length;
  }

  markup(raw: string, interpretAs?: string): void {
    if (raw.length === 0) return;
    this.current.markup(raw, interpretAs);
    this.cursor += raw.length;
  }

  /**
   * Close the current block and open the next. Every call site is a place the
   * rendered document has a paragraph break, so this doubles as the record of
   * where a chunk is allowed to end.
   */
  blockBreak(): void {
    this.blocks.push(this.current.build());
    this.current = new BlockBuilder();
    this.cursor += BLOCK_BREAK.length;
  }

  get isEmpty(): boolean {
    return this.cursor === 0;
  }

  /** How far the offset space has advanced, for deciding on a separator. */
  get length(): number {
    return this.cursor;
  }

  build(): DocumentBlock[] {
    return [...this.blocks, this.current.build()];
  }
}

/**
 * Emit a text node, splitting out any GitBook directives it contains so they
 * are never offered to the spell checker.
 */
function emitProse(builder: AnnotationBuilder, text: string, nodeKey: string): void {
  GITBOOK_DIRECTIVE.lastIndex = 0;
  let consumed = 0;
  let found: RegExpExecArray | null;

  while ((found = GITBOOK_DIRECTIVE.exec(text)) !== null) {
    if (found.index > consumed) {
      builder.text(text.slice(consumed, found.index), nodeKey, consumed);
    }
    // A directive occupies its own line, so eliding it entirely cannot run two
    // sentences together and needs no substitute.
    builder.markup(found[0]);
    consumed = found.index + found[0].length;
  }

  if (consumed < text.length) {
    builder.text(text.slice(consumed), nodeKey, consumed);
  }
}

function emitInline(builder: AnnotationBuilder, node: LexicalNode): void {
  if ($isTextNode(node)) {
    const text = node.getTextContent();
    if (node.hasFormat('code')) {
      builder.markup(text, INLINE_CODE_AS);
      return;
    }
    emitProse(builder, text, node.getKey());
    return;
  }

  if ($isLineBreakNode(node)) {
    builder.markup('\n', '\n');
    return;
  }

  // Links and other inline containers hold their prose as child text nodes.
  // The URL is a node property rather than text, so unlike markdown source
  // there is nothing to suppress.
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) emitInline(builder, child);
    return;
  }

  // Decorators (images, math, embeds) render no prose. A substitute keeps the
  // surrounding sentence intact.
  builder.markup(node.getTextContent() || ' ', DECORATOR_AS);
}

/**
 * Walk the current editor state into its blocks.
 * Must be called inside `editorState.read()`.
 */
export function buildDocumentBlocks(): DocumentBlock[] {
  const builder = new AnnotationBuilder();

  for (const block of $getRoot().getChildren()) {
    // A paragraph break between blocks, so LanguageTool sees sentence
    // boundaries that exist in the rendered document but not in the tree.
    if (!builder.isEmpty) builder.blockBreak();

    if (OPAQUE_BLOCK_TYPES.has(block.getType())) {
      builder.markup(block.getTextContent());
      continue;
    }

    if ($isElementNode(block)) {
      emitBlock(builder, block);
    }
  }

  return builder.build();
}

/**
 * Join blocks back into one document, in one offset space, with the paragraph
 * break between each pair restored.
 *
 * Given every block, this is the document the walk used to return directly.
 * Given a slice of them it is a chunk: a request-sized document whose offset
 * space is its own, so matches from it resolve against it and never against
 * the whole file.
 */
export function assembleDocument(blocks: readonly DocumentBlock[]): DocumentBlock {
  const builder = new BlockBuilder();

  blocks.forEach((block, index) => {
    if (index > 0) builder.markup(BLOCK_BREAK, BLOCK_BREAK);
    builder.append(block);
  });

  return builder.build();
}

/**
 * Build the whole document as one annotation.
 * Must be called inside `editorState.read()`.
 */
export function buildAnnotatedDocument(): AnnotatedDocument {
  return assembleDocument(buildDocumentBlocks());
}

function emitBlock(builder: AnnotationBuilder, block: ElementNode): void {
  const start = builder.length;

  for (const child of block.getChildren()) {
    // A nested block — a list item, a blockquote's paragraph, a nested list —
    // is its own sentence context, exactly like a top-level block, so it gets
    // the same paragraph break. Without one, "Buy milk" and "Teh bread" join
    // into "Buy milkTeh bread" and every match across the seam is wrong.
    //
    // isInline() is what separates those from an inline container such as a
    // link, which is NOT a sentence boundary: breaking there would split a
    // sentence and shift every offset after it.
    if ($isElementNode(child) && !child.isInline()) {
      // Only once something precedes it, so a leading empty item adds nothing.
      if (builder.length > start) builder.blockBreak();

      if (OPAQUE_BLOCK_TYPES.has(child.getType())) {
        builder.markup(child.getTextContent());
        continue;
      }
      emitBlock(builder, child);
      continue;
    }
    emitInline(builder, child);
  }
}

/**
 * Map a match reported against the annotated document back to a Lexical
 * position. Returns null when the match begins inside markup, which is not a
 * position the user can act on.
 */
export function resolveRange(
  doc: AnnotatedDocument,
  offset: number,
  length: number,
): ResolvedRange | null {
  if (length <= 0) return null;

  const segment = doc.segments.find(
    (candidate) => offset >= candidate.start && offset < candidate.start + candidate.length,
  );
  if (!segment) return null;

  const withinSegment = offset - segment.start;
  // Clip to the end of this run. A match that overruns into markup keeps only
  // the part that maps to editable text.
  const clipped = Math.min(length, segment.length - withinSegment);
  if (clipped <= 0) return null;

  return {
    nodeKey: segment.nodeKey,
    offset: segment.nodeOffset + withinSegment,
    length: clipped,
  };
}
