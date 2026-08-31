/**
 * The correction card.
 *
 * Structure follows LanguageTool's Chrome popup: a header carrying the rule
 * category and a close control, the issue title with a disable-this-rule
 * control aligned right, the explanation beneath it, then replacements as
 * filled pills next to a ghost Ignore.
 *
 * It is a plain DOM component appended to <body> and positioned `fixed`,
 * because the rects it anchors to are viewport coordinates and because the
 * editor's own overflow would otherwise clip it.
 */

import type { AnchoredMatch } from '../core/types';

export interface PopoverActions {
  /** Replace the matched text with the chosen replacement. */
  onApply: (anchor: AnchoredMatch, replacement: string) => void;
  /** Dismiss this one occurrence. */
  onIgnore: (anchor: AnchoredMatch) => void;
  /** Stop reporting this rule entirely. */
  onIgnoreRule: (anchor: AnchoredMatch) => void;
  /** The card closed, by whichever route. */
  onClose: () => void;
}

/** Where the flagged text sits, in viewport coordinates. */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const GAP = 6;
const VIEWPORT_MARGIN = 8;

export class MatchPopover {
  private readonly actions: PopoverActions;
  private readonly root: HTMLDivElement;
  private readonly category: HTMLSpanElement;
  private readonly mark: HTMLSpanElement;
  private readonly title: HTMLParagraphElement;
  private readonly detail: HTMLParagraphElement;
  private readonly actionRow: HTMLDivElement;

  private anchor: AnchoredMatch | null = null;

  constructor(actions: PopoverActions) {
    this.actions = actions;

    this.root = document.createElement('div');
    this.root.className = 'lt-card';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Correction');
    this.root.hidden = true;

    const header = document.createElement('div');
    header.className = 'lt-card__header';

    this.mark = document.createElement('span');
    this.mark.className = 'lt-card__mark';
    this.mark.setAttribute('aria-hidden', 'true');

    this.category = document.createElement('span');
    this.category.className = 'lt-card__category';

    const close = this.iconButton('×', 'Close');
    close.addEventListener('click', () => this.hide());

    header.append(this.mark, this.category, close);

    const body = document.createElement('div');
    body.className = 'lt-card__body';

    const titleRow = document.createElement('div');
    titleRow.className = 'lt-card__title-row';

    this.title = document.createElement('p');
    this.title.className = 'lt-card__title';

    const ignoreRule = this.iconButton('⊘', 'Never suggest this rule');
    ignoreRule.addEventListener('click', () => {
      if (this.anchor) this.actions.onIgnoreRule(this.anchor);
      this.hide();
    });

    titleRow.append(this.title, ignoreRule);

    this.detail = document.createElement('p');
    this.detail.className = 'lt-card__detail';

    this.actionRow = document.createElement('div');
    this.actionRow.className = 'lt-card__actions';

    body.append(titleRow, this.detail, this.actionRow);
    this.root.append(header, body);
    document.body.appendChild(this.root);

    // Escape closes, matching every other dismissible surface in the app.
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.hide();
      }
    });
  }

  private iconButton(glyph: string, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lt-card__icon-button';
    button.textContent = glyph;
    button.title = label;
    button.setAttribute('aria-label', label);
    return button;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** True when the pointer is over the card, so hover-out should not close it. */
  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.root.contains(target);
  }

  /** The match currently shown, so the caller can tint its underline. */
  get current(): AnchoredMatch | null {
    return this.anchor;
  }

  show(anchor: AnchoredMatch, rect: AnchorRect): void {
    this.anchor = anchor;
    const { match } = anchor;

    this.mark.dataset['kind'] = match.kind;
    this.mark.textContent = match.category.charAt(0).toUpperCase();
    this.category.textContent = match.category;
    this.title.textContent = match.title;
    this.detail.textContent = match.detail;

    this.actionRow.replaceChildren();
    if (match.replacements.length === 0) {
      const none = document.createElement('p');
      none.className = 'lt-card__empty';
      none.textContent = 'No suggestions for this one.';
      this.actionRow.append(none);
    } else {
      // LanguageTool can return dozens; the tail is rarely useful and makes
      // the card unusable, so show the best few.
      for (const replacement of match.replacements.slice(0, 3)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'lt-card__replacement';
        button.textContent = replacement;
        button.addEventListener('click', () => {
          this.actions.onApply(anchor, replacement);
          this.hide();
        });
        this.actionRow.append(button);
      }
    }

    const ignore = document.createElement('button');
    ignore.type = 'button';
    ignore.className = 'lt-card__ignore';
    ignore.textContent = 'Ignore';
    ignore.addEventListener('click', () => {
      this.actions.onIgnore(anchor);
      this.hide();
    });
    this.actionRow.append(ignore);

    this.root.hidden = false;
    this.position(rect);
  }

  /**
   * Every close route lands here — the close button, Escape, applying a
   * replacement, the caller — so onClose is the single place the underline
   * tint gets cleared.
   */
  hide(): void {
    const had = this.anchor;
    this.root.hidden = true;
    this.anchor = null;
    if (had) this.actions.onClose();
  }

  /** Below the text by preference, flipped above when there is no room. */
  private position(rect: AnchorRect): void {
    const { offsetWidth: width, offsetHeight: height } = this.root;

    let top = rect.bottom + GAP;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
      const above = rect.top - GAP - height;
      if (above >= VIEWPORT_MARGIN) top = above;
    }

    // Neither side fits when the card is taller than the room above and below.
    // Clamping keeps its buttons reachable instead of running off the edge.
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, maxTop));

    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft));

    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  destroy(): void {
    this.root.remove();
  }
}
