/**
 * LanguageTool matches to anchored ranges the overlay can paint.
 *
 * This is the seam the whole design was built around: the API reports offsets
 * into the annotated document, and `resolveRange` turns those into Lexical
 * positions. Nothing here has to understand markdown.
 */

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
