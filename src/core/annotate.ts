/**
 * Lexical tree to LanguageTool AnnotatedText.
 *
 * The document is a node tree, not a markdown string, so the annotation is
 * built directly from the tree. Nothing is serialised to markdown and re-parsed,
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

class AnnotationBuilder {
  private readonly items: AnnotationItem[] = [];
  private readonly segments: TextSegment[] = [];
  private cursor = 0;

  text(value: string, nodeKey: string, nodeOffset: number): void {
    if (value.length === 0) return;
    this.items.push({ text: value });
    this.segments.push({ start: this.cursor, length: value.length, nodeKey, nodeOffset });
    this.cursor += value.length;
  }

  markup(raw: string, interpretAs?: string): void {
    if (raw.length === 0) return;
    this.items.push(interpretAs === undefined ? { markup: raw } : { markup: raw, interpretAs });
    // Raw length, not interpretAs length. See the offset model above.
    this.cursor += raw.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** How far the offset space has advanced, for deciding on a separator. */
  get length(): number {
    return this.cursor;
  }

  build(): AnnotatedDocument {
    return { annotation: this.items, segments: this.segments };
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
 * Build the annotation for the current editor state.
 * Must be called inside `editorState.read()`.
 */
export function buildAnnotatedDocument(): AnnotatedDocument {
  const builder = new AnnotationBuilder();

  for (const block of $getRoot().getChildren()) {
    // A paragraph break between blocks, so LanguageTool sees sentence
    // boundaries that exist in the rendered document but not in the tree.
    if (!builder.isEmpty) builder.markup('\n\n', '\n\n');

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
      if (builder.length > start) builder.markup('\n\n', '\n\n');

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
