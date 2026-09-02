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
 *
 * Two edits move text between nodes rather than within one, and both are
 * ordinary enough that ignoring them would blank half a paragraph: splitting
 * one with Enter, and merging two with Backspace. `movesFor` recognises those
 * from the shape of the change and hands the anchors to their new node.
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

/**
 * Swap a chunk's fresh matches in, dropping only the old ones that sat in text
 * that chunk actually checked.
 *
 * Node keys alone are too coarse. Splitting an oversized block cuts inside a
 * text run, so one node key can appear in two chunks, and dropping by key would
 * take out the anchors the previous chunk had just contributed for the first
 * half of that node. The chunk's own segments carry the in-node ranges it
 * covered, so they are what the filter keys on.
 */
export function replaceCovered(
  current: readonly AnchoredMatch[],
  fresh: readonly AnchoredMatch[],
  chunk: AnnotatedDocument,
): AnchoredMatch[] {
  const covered = new Map<NodeKey, Array<[number, number]>>();

  for (const segment of chunk.segments) {
    const ranges = covered.get(segment.nodeKey);
    const range: [number, number] = [segment.nodeOffset, segment.nodeOffset + segment.length];
    if (ranges) ranges.push(range);
    else covered.set(segment.nodeKey, [range]);
  }

  const kept = current.filter((anchor) => {
    const ranges = covered.get(anchor.nodeKey);
    if (!ranges) return true;

    const end = anchor.offset + anchor.length;
    return !ranges.some(([from, to]) => anchor.offset < to && end > from);
  });

  return [...kept, ...fresh];
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

/**
 * A run of text that one edit moved from one node into another.
 *
 * Splitting and merging paragraphs is not an edit to a node's text, it is text
 * changing hands, so `reanchor` alone cannot follow it: the matches in the
 * moved run belong to a node that no longer holds them.
 */
interface TextMove {
  from: NodeKey;
  /** Where the run started in the old text of `from`. */
  fromOffset: number;
  to: NodeKey;
  /** Where the run starts in the new text of `to`. */
  toOffset: number;
  length: number;
}

/**
 * The runs of text this update handed from one node to another.
 *
 * Only two shapes are recognised, and both were confirmed against Lexical
 * rather than assumed:
 *
 *   - A split, which is Enter in the middle of a paragraph. The node keeps its
 *     head, and a node that did not exist before holds the tail verbatim.
 *   - A merge, which is Backspace at the start of one. A node is destroyed and
 *     its whole text is inserted into one that survived.
 *
 * Anything else is left alone and its matches are dropped as before. Guessing
 * where text went is how an anchor ends up on the wrong word, and a wrong
 * anchor rewrites the wrong characters when its replacement is applied.
 */
function movesFor(
  was: ReadonlyMap<NodeKey, string>,
  now: ReadonlyMap<NodeKey, string>,
  edits: ReadonlyMap<NodeKey, TextEdit | null>,
): TextMove[] {
  const moves: TextMove[] = [];

  const appeared: NodeKey[] = [];
  for (const key of now.keys()) if (!was.has(key)) appeared.push(key);

  if (appeared.length > 0) {
    for (const [key, edit] of edits) {
      const oldText = was.get(key);
      const newText = now.get(key);
      if (!edit || oldText === undefined || newText === undefined) continue;

      // A pure truncation: the change ran to the end of the old text and
      // nothing replaced it. Anything else is not a split.
      if (edit.end !== oldText.length || newText.length !== edit.start) continue;

      const tail = oldText.slice(edit.start);
      if (tail.length === 0) continue;

      const found = appeared.filter((candidate) => now.get(candidate) === tail);
      // Exactly one, or there is no telling which node the text went to.
      if (found.length !== 1) continue;

      moves.push({ from: key, fromOffset: edit.start, to: found[0]!, toOffset: 0, length: tail.length });
    }
  }

  for (const key of was.keys()) {
    if (now.has(key)) continue;

    const text = was.get(key);
    if (!text) continue;

    const found: TextMove[] = [];
    for (const [candidate, edit] of edits) {
      // A pure insertion, of exactly this node's text and nothing else.
      if (!edit || edit.start !== edit.end || edit.delta !== text.length) continue;
      if (now.get(candidate)?.slice(edit.start, edit.start + text.length) !== text) continue;
      found.push({ from: key, fromOffset: 0, to: candidate, toOffset: edit.start, length: text.length });
    }

    if (found.length === 1) moves.push(found[0]!);
  }

  return moves;
}

/** Follow an anchor into the node the text under it moved to. */
function relocate(anchor: AnchoredMatch, moves: readonly TextMove[]): AnchoredMatch | null {
  for (const move of moves) {
    if (move.from !== anchor.nodeKey) continue;
    // Wholly inside the run that moved. One straddling its edge was cut by the
    // same edit, so there is no single place for it to land.
    if (anchor.offset < move.fromOffset) continue;
    if (anchor.offset + anchor.length > move.fromOffset + move.length) continue;

    return {
      ...anchor,
      nodeKey: move.to,
      offset: move.toOffset + (anchor.offset - move.fromOffset),
    };
  }

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
  let affected = false;
  for (const anchor of current) {
    if (dirtyLeaves.has(anchor.nodeKey)) affected = true;
  }
  if (!affected) return [...current];

  // The whole dirty set, not only the nodes carrying a match: the node a split
  // hands its tail to has none of its own yet, and it is the destination.
  const was = textOf(before, dirtyLeaves);
  const now = textOf(after, dirtyLeaves);

  // A key absent from this map is a node with no text to re-anchor onto. A key
  // present with a null value is one that was dirtied without its text
  // changing, by a format or a sibling's reconciliation.
  const edits = new Map<NodeKey, TextEdit | null>();
  for (const key of dirtyLeaves) {
    const from = was.get(key);
    const to = now.get(key);
    if (from !== undefined && to !== undefined) edits.set(key, diffText(from, to));
  }

  const moves = movesFor(was, now, edits);

  const kept: AnchoredMatch[] = [];
  for (const anchor of current) {
    if (!dirtyLeaves.has(anchor.nodeKey)) {
      kept.push(anchor);
      continue;
    }

    // Text that changed hands is followed first. Against its old node the same
    // match reads as deleted, so `reanchor` would drop it.
    const relocated = relocate(anchor, moves);
    if (relocated) {
      kept.push(relocated);
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
