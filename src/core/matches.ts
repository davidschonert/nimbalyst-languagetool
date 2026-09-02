/**
 * LanguageTool matches to anchored ranges the overlay can paint.
 *
 * This is the seam the whole design was built around: the API reports offsets
 * into the annotated document, and `resolveRange` turns those into Lexical
 * positions. Nothing here has to understand markdown.
 *
 * An anchor is a node key and an offset inside that node, so it goes stale the
 * moment the text ahead of it changes. `carryOver` is what keeps a paragraph's
 * underlines on screen across an edit instead of blanking it until the next
 * check answers: it moves each anchor to where its text now is, and drops only
 * the one the edit ran through.
 */

import { $getNodeByKey, $isTextNode } from 'lexical';
import type { EditorState, NodeKey } from 'lexical';

import { resolveRange, type AnnotatedDocument } from './annotate';
import type { RawMatch } from './client';
import type { AnchoredMatch, CheckMatch, MatchKind } from './types';

/**
 * Rules whose whole job is spelling. A free server reports these as category
 * TYPOS, but premium replaces MORFOLOGIK with an orthography rule whose
 * category is GRAMMAR, so on premium the rule id is the only thing left that
 * identifies a spelling error.
 */
const SPELLING_RULE = /ORTHOGRAPHY|MORFOLOGIK|SPELLER|HUNSPELL/;

/**
 * The three underline colors, matched to LanguageTool's own editor.
 *
 * Derived by running one paragraph through both and pairing the colors against
 * the API metadata, because neither field alone predicts them:
 *
 *   - `issueType: misspelling` covers both "minthly" (TYPOS, red) and "Org"
 *     (CASING, amber), so it cannot decide red.
 *   - `category` cannot either, since premium reports "minthly" as GRAMMAR
 *     while still coloring it red.
 *   - `issueType: style` does hold for blue across STYLE, REDUNDANCY and
 *     REPETITIONS_STYLE, so it is the right key there.
 *
 * Amber is everything else: grammar, punctuation, casing, articles, word
 * choice. That is where LanguageTool puts the bulk of its findings too.
 */
export function kindFor(rule: RawMatch['rule']): MatchKind {
  if (rule.category?.id === 'TYPOS' || SPELLING_RULE.test(rule.id)) return 'spelling';
  if (rule.issueType === 'style') return 'style';
  return 'grammar';
}

/**
 * The fragment the service flagged, taken from `context` rather than by reading
 * the editor. `context.offset` and `context.length` index into `context.text`,
 * so this stays correct even where the service elided the surrounding text.
 */
export function flaggedText(raw: RawMatch): string {
  const context = raw.context;
  if (!context || typeof context.text !== 'string') return '';
  const { text, offset, length } = context;
  if (typeof offset !== 'number' || typeof length !== 'number') return '';
  return text.slice(offset, offset + length);
}

function toCheckMatch(raw: RawMatch): CheckMatch {
  return {
    // shortMessage is often empty on style rules, where message is the useful one.
    title: raw.shortMessage?.trim() || raw.message,
    detail: raw.message,
    replacements: (raw.replacements ?? []).map((entry) => entry.value).filter(Boolean),
    ruleId: raw.rule.id,
    category: raw.rule.category?.name?.trim() || 'LanguageTool',
    kind: kindFor(raw.rule),
    word: flaggedText(raw),
  };
}

/**
 * Anchor each match, discarding any that does not begin in editable prose.
 * A match starting inside markup has no position the user could act on.
 *
 * `isIgnored` is the personal dictionary, passed in rather than imported so
 * this stays a pure function of its arguments.
 */
export function anchorMatches(
  doc: AnnotatedDocument,
  raw: readonly RawMatch[],
  isIgnored: (flagged: string) => boolean = () => false,
): AnchoredMatch[] {
  const anchored: AnchoredMatch[] = [];

  for (const match of raw) {
    const word = flaggedText(match);
    if (word && isIgnored(word)) continue;

    const range = resolveRange(doc, match.offset, match.length);
    if (!range) continue;

    anchored.push({
      nodeKey: range.nodeKey,
      offset: range.offset,
      length: range.length,
      match: toCheckMatch(match),
    });
  }

  return anchored;
}

/** The change one edit made to a single node's text, in the old text's coordinates. */
export interface TextEdit {
  /** First offset that differs. */
  start: number;
  /** End of the replaced range in the old text. Equal to `start` for an insertion. */
  end: number;
  /** How much longer the new text is. Negative for a deletion. */
  delta: number;
}

/**
 * What changed between two versions of one node's text.
 *
 * A common prefix and a common suffix are enough for what this has to survive:
 * a keystroke, a deletion, and the splice that applies a replacement, each of
 * which is one contiguous change. Anything more tangled only widens the
 * changed range, which drops more matches, and that is the safe direction.
 *
 * Null when the text did not change, which is what a node marked dirty for
 * some other reason looks like.
 */
export function diffText(before: string, after: string): TextEdit | null {
  if (before === after) return null;

  const shorter = Math.min(before.length, after.length);

  let prefix = 0;
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return { start: prefix, end: before.length - suffix, delta: after.length - before.length };
}

/**
 * Carry one anchor across an edit, or drop it.
 *
 *   - Entirely before the change, so it did not move.
 *   - Entirely after it, so it slid by the length difference.
 *   - Overlapping it, so the text the service judged is not the text there
 *     now. This is the only one dropped, and for an applied correction it is
 *     exactly the match that should go.
 *
 * An anchor that did not move is returned as itself rather than as a copy, so
 * identity still tells the popover whether it is looking at the same match.
 */
export function reanchor(anchor: AnchoredMatch, edit: TextEdit): AnchoredMatch | null {
  if (anchor.offset + anchor.length <= edit.start) return anchor;
  if (anchor.offset >= edit.end) return { ...anchor, offset: anchor.offset + edit.delta };
  return null;
}

/** The text of each of `keys`, skipping any that is gone or is not a text node. */
function textOf(state: EditorState, keys: Iterable<NodeKey>): Map<NodeKey, string> {
  const texts = new Map<NodeKey, string>();

  state.read(() => {
    for (const key of keys) {
      const node = $getNodeByKey(key);
      if ($isTextNode(node)) texts.set(key, node.getTextContent());
    }
  });

  return texts;
}

/**
 * Move the matches in the edited nodes to where their text now is.
 *
 * The alternative, and what this replaced, is dropping every match in a dirty
 * node. That blanked a whole paragraph on one keystroke and left it bare until
 * the next check answered, so applying a correction took the rest of the
 * paragraph's underlines down with the one it fixed.
 *
 * Matches outside `dirtyLeaves` are untouched. A node that is gone, or that is
 * no longer a text node, loses its matches: there is nothing left to anchor to.
 */
export function carryOver(
  current: readonly AnchoredMatch[],
  dirtyLeaves: ReadonlySet<NodeKey>,
  before: EditorState,
  after: EditorState,
): AnchoredMatch[] {
  const edited = new Set<NodeKey>();
  for (const anchor of current) {
    if (dirtyLeaves.has(anchor.nodeKey)) edited.add(anchor.nodeKey);
  }
  if (edited.size === 0) return [...current];

  const was = textOf(before, edited);
  const now = textOf(after, edited);

  // A key absent from this map is a node with no text to re-anchor onto. A key
  // present with a null value is one that was dirtied without its text
  // changing, by a format or a sibling's reconciliation.
  const edits = new Map<NodeKey, TextEdit | null>();
  for (const key of edited) {
    const from = was.get(key);
    const to = now.get(key);
    if (from !== undefined && to !== undefined) edits.set(key, diffText(from, to));
  }

  const kept: AnchoredMatch[] = [];
  for (const anchor of current) {
    if (!dirtyLeaves.has(anchor.nodeKey)) {
      kept.push(anchor);
      continue;
    }
    if (!edits.has(anchor.nodeKey)) continue;

    const edit = edits.get(anchor.nodeKey);
    if (!edit) {
      kept.push(anchor);
      continue;
    }

    const moved = reanchor(anchor, edit);
    if (moved) kept.push(moved);
  }

  return kept;
}
