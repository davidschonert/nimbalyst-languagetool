/**
 * Extension configuration.
 *
 * `services.configuration` only exists when the manifest declares
 * `contributions.configuration`. The block is declared with no properties on
 * purpose: the host renders its own field UI for every declared property, and
 * that UI disables each input while it saves, which drops focus on every
 * keystroke in a text field. With no properties declared the host panel renders
 * nothing and the extension's own settings panel is the only one.
 *
 * Nothing is lost by that. Config is stored as a plain key/value bag per
 * extension id, so undeclared keys persist exactly the same way; only the
 * host-rendered fields and the manifest-declared defaults go away, and the
 * defaults live here instead.
 *
 * The host loads saved values into a cache once at activation and emits no
 * change event. Writing through `update()` refreshes that cache, so a change
 * made in our own panel applies immediately. Values are read lazily at the
 * point of use, which also avoids the startup race where the cache has not
 * resolved yet and every read returns a default.
 *
 * The cloud access token is deliberately absent. See secrets.ts.
 */

import type { ExtensionConfigurationService } from '@nimbalyst/extension-sdk';

import type { Backend, CheckOptions } from './client';

/** How the correction card opens. */
export type TriggerMode = 'click' | 'hover';

export const KEYS = {
  triggerMode: 'languagetool.triggerMode',
  backend: 'languagetool.backend',
  localUrl: 'languagetool.localUrl',
  cloudUrl: 'languagetool.cloudUrl',
  language: 'languagetool.language',
  motherTongue: 'languagetool.motherTongue',
  picky: 'languagetool.picky',
  disabledRules: 'languagetool.disabledRules',
  disabledCategories: 'languagetool.disabledCategories',
  username: 'languagetool.username',
  dictionary: 'languagetool.dictionary',
  dictionaryEnabled: 'languagetool.dictionaryEnabled',
  dictionaryPushToCloud: 'languagetool.dictionaryPushToCloud',
} as const;

export const DEFAULTS = {
  triggerMode: 'click' as TriggerMode,
  backend: 'local' as Backend,
  localUrl: 'http://localhost:8081',
  cloudUrl: 'https://api.languagetoolplus.com',
  language: 'en-US',
};

let service: ExtensionConfigurationService | undefined;

/** Called from `activate`, which is the only place the services are handed out. */
export function bindConfiguration(next: ExtensionConfigurationService | undefined): void {
  service = next;
}

export function readString(key: string, fallback = ''): string {
  const value = service?.get<string>(key, fallback);
  return typeof value === 'string' ? value : fallback;
}

export function readBoolean(key: string, fallback = false): boolean {
  const value = service?.get<boolean>(key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * A stored list. The host keeps configuration as JSON, so an array round-trips
 * without the escaping a delimited string would need for words containing one.
 */
export function readArray(key: string): string[] {
  const value = service?.get<unknown>(key, []);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Comma-separated, because a single text field is the whole editor we need. */
function readList(key: string): string[] {
  return readString(key)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Writes through to the host and refreshes its cache, so the change is live. */
export async function writeSetting(key: string, value: unknown): Promise<void> {
  await service?.update(key, value, 'user');
}

export function triggerMode(): TriggerMode {
  return readString(KEYS.triggerMode, DEFAULTS.triggerMode) === 'hover' ? 'hover' : 'click';
}

export function backend(): Backend {
  return readString(KEYS.backend, DEFAULTS.backend) === 'cloud' ? 'cloud' : 'local';
}

export function baseUrlFor(selected: Backend): string {
  return selected === 'cloud'
    ? readString(KEYS.cloudUrl, DEFAULTS.cloudUrl) || DEFAULTS.cloudUrl
    : readString(KEYS.localUrl, DEFAULTS.localUrl) || DEFAULTS.localUrl;
}

/**
 * The largest single request each backend is given, in characters.
 *
 * LanguageTool rejects a request over 20,000 characters on the free tier and
 * 60,000 on Premium. The cloud backend here always carries Premium
 * credentials, because `check()` refuses to send without both a username and a
 * token, so it gets the higher figure.
 *
 * A self-hosted server has no cap by default, but it is commonly run with
 * `--maxTextLength`, so local takes the conservative one. It is not only
 * defensive: a limit is also what makes a long document paint from the top
 * rather than all at once, and the local backend is the one that runs while
 * you type. Neither is exposed as a setting, because the host renders no field
 * UI for undeclared keys and an unreachable setting is worse than a constant.
 */
export const CHUNK_LIMIT: Record<Backend, number> = {
  local: 20_000,
  cloud: 60_000,
};

export function chunkLimit(): number {
  return CHUNK_LIMIT[backend()];
}

/**
 * Assemble the request options. `apiKey` is left for the caller to supply,
 * since configuration is not somewhere a credential may be stored.
 */
export function checkOptions(): CheckOptions {
  const selected = backend();
  const options: CheckOptions = {
    backend: selected,
    baseUrl: baseUrlFor(selected),
    language: readString(KEYS.language, DEFAULTS.language) || DEFAULTS.language,
    picky: readBoolean(KEYS.picky),
    disabledRules: readList(KEYS.disabledRules),
    disabledCategories: readList(KEYS.disabledCategories),
  };

  const motherTongue = readString(KEYS.motherTongue).trim();
  if (motherTongue) options.motherTongue = motherTongue;

  const username = readString(KEYS.username).trim();
  if (username) options.username = username;

  return options;
}
