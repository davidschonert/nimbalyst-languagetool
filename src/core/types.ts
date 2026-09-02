/**
 * The shapes the UI works in. These deliberately mirror the fields of a
 * LanguageTool `/v2/check` match, so swapping the fake generator for the real
 * client later is a mapping step and not a refactor.
 */

/** Drives underline color and the card's accent. Derived from `rule.issueType`. */
export type MatchKind = 'spelling' | 'grammar' | 'style';

export interface CheckMatch {
  /** `shortMessage`, e.g. "Spelling mistake". Falls back to `message`. */
  title: string;
  /** `message`, the fuller explanation. */
  detail: string;
  /** `replacements[].value`, best first. May be empty. */
  replacements: string[];
  /** `rule.id`, used by the ignore-this-rule action. */
  ruleId: string;
  /** `rule.category.name`, shown in the card header. */
  category: string;
  /** The flagged fragment itself. Empty when the service omitted the context. */
  word: string;
  kind: MatchKind;
}

/**
 * A match anchored the way Lexical addresses text: a node key plus an offset
 * inside that node. There is no whole-document offset space to use.
 */
export interface AnchoredMatch {
  nodeKey: string;
  offset: number;
  length: number;
  match: CheckMatch;
}
