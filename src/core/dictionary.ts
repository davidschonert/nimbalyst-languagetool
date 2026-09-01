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
 *
 * LanguageTool accounts have their own dictionary, which the cloud service
 * applies on its own and which is shared with the browser extension. The two
 * are deliberately NOT synchronised. Adding a word can push it to the account
 * as well, but only when the user has turned that on, and nothing is ever read
 * back or deleted remotely. Sync would mean conflict resolution and deletion
 * propagation for a list edited a few times a year, and a word wrongly removed
 * from the account would affect every other LanguageTool client.
 */

import { addWordToAccount } from './client';
import {
  baseUrlFor,
  KEYS,
  readArray,
  readBoolean,
  readString,
  writeSetting,
} from './config';
import { readApiKey } from './secrets';

/** What happened to the account copy, which is reported separately. */
export type CloudResult =
  /** The user has not turned the account push on. */
  | 'off'
  /** Turned on, but no username and token are configured. */
  | 'unavailable'
  | 'added'
  | 'failed';

export interface AddResult {
  /** Whether the word joined the local list. */
  added: boolean;
  cloud: CloudResult;
}

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
 * Whether the list is being applied. Turning it off leaves every word in place,
 * so someone using the cloud backend can rely on their account dictionary alone
 * without losing what they have collected here.
 */
export function dictionaryEnabled(): boolean {
  return readBoolean(KEYS.dictionaryEnabled, true);
}

export function pushesToCloud(): boolean {
  return readBoolean(KEYS.dictionaryPushToCloud, false);
}

/** Present in the list, whether or not the list is currently applied. */
function contains(word: string): boolean {
  const candidate = normalize(word);
  return Boolean(candidate) && dictionaryWords().some((entry) => normalize(entry) === candidate);
}

/**
 * Whether a flagged fragment should be suppressed.
 *
 * Compares the whole fragment rather than the words inside it. A dictionary
 * entry says "this word is fine", which cannot justify dropping a grammar match
 * that happens to span it along with several others.
 */
export function isIgnored(flagged: string): boolean {
  return dictionaryEnabled() && contains(flagged);
}

/**
 * Push a word to the LanguageTool account. Never throws: the local add has
 * already succeeded by this point, and the account copy is a bonus rather than
 * the thing that makes the word work.
 */
async function pushWord(word: string): Promise<CloudResult> {
  if (!pushesToCloud()) return 'off';

  const username = readString(KEYS.username).trim();
  const apiKey = await readApiKey();
  if (!username || !apiKey) return 'unavailable';

  try {
    await addWordToAccount(word, { baseUrl: baseUrlFor('cloud'), username, apiKey });
    return 'added';
  } catch (error) {
    console.warn('[languagetool] Could not add the word to your account:', error);
    return 'failed';
  }
}

/**
 * Add a word locally, and to the account when that is turned on.
 *
 * The local list is written first and independently, so a word always works
 * immediately even when the account copy fails or is not configured.
 */
export async function addWord(word: string): Promise<AddResult> {
  const trimmed = word.trim();
  if (!trimmed || contains(trimmed)) return { added: false, cloud: 'off' };

  await writeSetting(KEYS.dictionary, [...dictionaryWords(), trimmed]);
  return { added: true, cloud: await pushWord(trimmed) };
}

/**
 * Removes from the local list only. The account copy is deliberately left
 * alone, since deleting from it would change what every other LanguageTool
 * client reports.
 */
export async function removeWord(word: string): Promise<void> {
  const target = normalize(word);
  const remaining = dictionaryWords().filter((entry) => normalize(entry) !== target);
  await writeSetting(KEYS.dictionary, remaining);
}
