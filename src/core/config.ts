/**
 * Extension configuration.
 *
 * Two host behaviours shape this file:
 *
 *   1. `services.configuration` only exists when the manifest declares
 *      `contributions.configuration`. Without that block it is undefined.
 *   2. The host loads the saved values into a cache once, asynchronously, at
 *      activation, and there is no change notification. A value edited in
 *      Settings is therefore picked up on the next extension reload rather
 *      than immediately.
 *
 * Values are read lazily at the point of use rather than captured at
 * activation. That does not fix (2), but it does avoid the startup race where
 * the cache has not resolved yet and every read returns the default.
 *
 * The cloud access token is deliberately absent. It belongs in Nimbalyst's
 * encrypted secret store, which a contributed Lexical extension cannot reach:
 * `ExtensionStorage` hangs off EditorHost, PanelHost and SettingsPanelProps,
 * and `ExtensionServices` carries no storage. Putting it here instead would
 * mean writing it to plain configuration, which is exactly what it must not be.
 */

import type { ExtensionConfigurationService } from '@nimbalyst/extension-sdk';

import type { Backend, CheckOptions } from './client';

/** How the correction card opens. */
export type TriggerMode = 'click' | 'hover';

const KEYS = {
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
} as const;

const DEFAULTS = {
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

function readString(key: string, fallback: string): string {
  const value = service?.get<string>(key, fallback);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readBoolean(key: string): boolean {
  return service?.get<boolean>(key, false) === true;
}

/** Comma-separated in the settings UI, because the host has no list editor. */
function readList(key: string): string[] {
  return readString(key, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function triggerMode(): TriggerMode {
  return service?.get<string>(KEYS.triggerMode, DEFAULTS.triggerMode) === 'hover'
    ? 'hover'
    : 'click';
}

export function backend(): Backend {
  return service?.get<string>(KEYS.backend, DEFAULTS.backend) === 'cloud' ? 'cloud' : 'local';
}

/**
 * Assemble the request options. `apiKey` is left for the caller to supply,
 * since configuration is not somewhere a credential may be stored.
 */
export function checkOptions(): CheckOptions {
  const selected = backend();
  const options: CheckOptions = {
    backend: selected,
    baseUrl:
      selected === 'cloud'
        ? readString(KEYS.cloudUrl, DEFAULTS.cloudUrl)
        : readString(KEYS.localUrl, DEFAULTS.localUrl),
    language: readString(KEYS.language, DEFAULTS.language),
    picky: readBoolean(KEYS.picky),
    disabledRules: readList(KEYS.disabledRules),
    disabledCategories: readList(KEYS.disabledCategories),
  };

  const motherTongue = readString(KEYS.motherTongue, '');
  if (motherTongue) options.motherTongue = motherTongue;

  const username = readString(KEYS.username, '');
  if (username) options.username = username;

  return options;
}
