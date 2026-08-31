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
 * `rule.issueType` is a long open list. It collapses to three underline
 * colors: red for things that are wrong, amber for grammar, blue for taste.
 */
const STYLE_ISSUE_TYPES = new Set([
  'style',
  'register',
  'locale-violation',
  'formatting',
  'whitespace',
  'typographical',
  'redundancy',
]);

export function kindFor(issueType: string | undefined): MatchKind {
  if (issueType === 'misspelling') return 'spelling';
  if (issueType && STYLE_ISSUE_TYPES.has(issueType)) return 'style';
  return 'grammar';
}

function toCheckMatch(raw: RawMatch): CheckMatch {
  return {
    // shortMessage is often empty on style rules, where message is the useful one.
    title: raw.shortMessage?.trim() || raw.message,
    detail: raw.message,
    replacements: (raw.replacements ?? []).map((entry) => entry.value).filter(Boolean),
    ruleId: raw.rule.id,
    category: raw.rule.category?.name?.trim() || 'LanguageTool',
    kind: kindFor(raw.rule.issueType),
  };
}

/**
 * Anchor each match, discarding any that does not begin in editable prose.
 * A match starting inside markup has no position the user could act on.
 */
export function anchorMatches(doc: AnnotatedDocument, raw: readonly RawMatch[]): AnchoredMatch[] {
  const anchored: AnchoredMatch[] = [];

  for (const match of raw) {
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
