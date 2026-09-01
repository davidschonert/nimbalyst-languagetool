/**
 * The personal dictionary.
 *
 * Words are filtered out of the results rather than sent to the service. The
 * `dicts` request parameter belongs to a LanguageTool account and is silently
 * ignored by a self-hosted server, and `disabledRules=MORFOLOGIK_RULE_EN_US`
 * turns off spell checking altogether, so neither is a per-word control.
 * Filtering client-side behaves the same on both backends and needs no account.
 *
 * The list lives in configuration rather than in the encrypted secret store.
 * Words are not secret, and configuration is the one persistent store a
 * contributed Lexical extension can actually reach. Writes go through
 * `writeSetting`, which is user-scoped, so the dictionary follows the user
 * across workspaces.
 */

import { KEYS, readArray, writeSetting } from './config';

/**
 * Words are compared case-insensitively but stored as the user added them, so
 * the settings list reads the way they typed it.
 */
function normalize(word: string): string {
  return word.trim().toLocaleLowerCase();
}

/** The stored words, in the order they were added. */
export function dictionaryWords(): string[] {
  return readArray(KEYS.dictionary);
}

/**
 * Whether a flagged fragment should be suppressed.
 *
 * Compares the whole fragment rather than the words inside it. A dictionary
 * entry says "this word is fine", which cannot justify dropping a grammar match
 * that happens to span it along with several others.
 */
export function isIgnored(flagged: string): boolean {
  const candidate = normalize(flagged);
  if (!candidate) return false;
  return dictionaryWords().some((word) => normalize(word) === candidate);
}

/** Returns false when the word is empty or already present. */
export async function addWord(word: string): Promise<boolean> {
  const trimmed = word.trim();
  if (!trimmed || isIgnored(trimmed)) return false;

  await writeSetting(KEYS.dictionary, [...dictionaryWords(), trimmed]);
  return true;
}

export async function removeWord(word: string): Promise<void> {
  const target = normalize(word);
  const remaining = dictionaryWords().filter((entry) => normalize(entry) !== target);
  await writeSetting(KEYS.dictionary, remaining);
}
