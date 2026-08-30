/**
 * The underline overlay.
 *
 * Lexical has no decoration API, so flagged ranges are painted as absolutely
 * positioned elements in a sibling layer rather than by mutating the document.
 * Mutating would dirty the file, pollute undo history, and have to survive
 * markdown export. The approach follows the one Nimbalyst (MIT) uses for its
 * own find-in-document highlights.
 *
 * Spike 1 established that the root element is NOT mounted when `register`
 * runs, so the layer is attached from `registerRootListener` instead.
 */

import type { LexicalEditor } from 'lexical';

import type { AnchoredMatch, MatchKind } from '../core/types';

/** A painted rect kept so the pointer can be tested against it. */
export interface UnderlineHit {
  anchor: AnchoredMatch;
  /** Viewport coordinates, valid until the next repaint. */
  rect: { left: number; top: number; right: number; bottom: number };
}

const STROKE: Record<MatchKind, string> = {
  spelling: '%23d6453d',
  grammar: '%23d19a2c',
  style: '%233d7bd6',
};

function squiggleFor(kind: MatchKind): string {
  return (
    `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' ` +
    `width='6' height='3'><path d='M0 2 Q1.5 0 3 2 T6 2' stroke='${STROKE[kind]}' ` +
    `fill='none' stroke-width='1'/></svg>")`
  );
}

/**
 * Walk the text nodes of `element` and build a DOM Range covering
 * [offset, offset + length) in its combined text. A Lexical text node can map
 * to several DOM text nodes once formatting splits it, so this cannot assume a
 * single child.
 */
function resolveRange(element: HTMLElement, offset: number, length: number): Range | null {
  if (offset < 0 || length <= 0) return null;

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const end = offset + length;

  let consumed = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  let node = walker.nextNode() as Text | null;
  while (node) {
    const nodeEnd = consumed + node.length;
    if (startNode === null && offset < nodeEnd) {
      startNode = node;
      startOffset = offset - consumed;
    }
    if (startNode !== null && end <= nodeEnd) {
      endNode = node;
      endOffset = end - consumed;
      break;
    }
    endNode = node;
    endOffset = node.length;
    consumed = nodeEnd;
    node = walker.nextNode() as Text | null;
  }

  if (!startNode || !endNode) return null;

  const range = document.createRange();
  try {
    range.setStart(startNode, Math.min(startOffset, startNode.length));
    range.setEnd(endNode, Math.min(endOffset, endNode.length));
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

/** Nearest scrollable ancestor, or null if the page itself scrolls. */
function findScroller(from: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = from.parentElement;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
    el = el.parentElement;
  }
  return null;
}

export class UnderlineLayer {
  private readonly editor: LexicalEditor;
  private readonly wrapper: HTMLDivElement;

  private anchors: readonly AnchoredMatch[] = [];
  private painted: Array<{ element: HTMLElement; hit: UnderlineHit }> = [];
  private active: AnchoredMatch | null = null;
  private parent: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frame = 0;

  private readonly repaint = () => this.schedule();

  constructor(editor: LexicalEditor) {
    this.editor = editor;
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'lt-underline-layer';
  }

  attach(root: HTMLElement): void {
    const parent = root.parentElement;
    if (!parent) return;

    this.detach();
    this.parent = parent;
    parent.insertBefore(this.wrapper, parent.firstChild);

    // Rects are viewport coordinates, so anything that moves the text
    // invalidates them: scrolling, resizing, or the editor reflowing.
    this.scroller = findScroller(root);
    (this.scroller ?? window).addEventListener('scroll', this.repaint, { passive: true });

    this.resizeObserver = new ResizeObserver(this.repaint);
    this.resizeObserver.observe(parent);

    this.schedule();
  }

  detach(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;

    (this.scroller ?? window).removeEventListener('scroll', this.repaint);
    this.scroller = null;

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.clear();
    this.wrapper.remove();
    this.parent = null;
  }

  setMatches(anchors: readonly AnchoredMatch[]): void {
    this.anchors = anchors;
    this.schedule();
  }

  /** Tint the match whose card is open, as LanguageTool does. */
  setActive(anchor: AnchoredMatch | null): void {
    if (this.active === anchor) return;
    this.active = anchor;
    for (const { element, hit } of this.painted) {
      element.dataset['active'] = String(hit.anchor === anchor);
    }
  }

  /** The match under the pointer, in viewport coordinates. */
  hitTest(clientX: number, clientY: number): UnderlineHit | null {
    for (const { hit } of this.painted) {
      const { left, top, right, bottom } = hit.rect;
      if (clientX >= left && clientX <= right && clientY >= top && clientY <= bottom) {
        return hit;
      }
    }
    return null;
  }

  /** Coalesce bursts of scroll and update events into one paint per frame. */
  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private clear(): void {
    for (const { element } of this.painted) element.remove();
    this.painted = [];
  }

  private paint(): void {
    const parent = this.parent;
    if (!parent) return;

    this.clear();
    if (this.anchors.length === 0) return;

    const { left: parentLeft, top: parentTop } = parent.getBoundingClientRect();

    this.editor.getEditorState().read(() => {
      for (const anchor of this.anchors) {
        const element = this.editor.getElementByKey(anchor.nodeKey);
        if (!element) continue;

        const range = resolveRange(element, anchor.offset, anchor.length);
        if (!range) continue;

        // One rect per visual line, so a range that wraps gets an underline
        // segment on each line rather than one box spanning both.
        for (const rect of Array.from(range.getClientRects())) {
          const mark = document.createElement('div');
          mark.className = 'lt-underline';
          mark.dataset['kind'] = anchor.match.kind;
          mark.dataset['active'] = String(anchor === this.active);
          mark.style.left = `${rect.left - parentLeft}px`;
          mark.style.top = `${rect.top - parentTop}px`;
          mark.style.width = `${rect.width}px`;
          mark.style.height = `${rect.height}px`;
          mark.style.backgroundImage = squiggleFor(anchor.match.kind);

          this.wrapper.appendChild(mark);
          this.painted.push({
            element: mark,
            hit: {
              anchor,
              rect: {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
              },
            },
          });
        }
      }
    });
  }
}
