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
 */

import type { ExtensionConfigurationService } from '@nimbalyst/extension-sdk';

/** How the correction card opens. */
export type TriggerMode = 'click' | 'hover';

export const TRIGGER_MODE_KEY = 'languagetool.triggerMode';

const DEFAULT_TRIGGER_MODE: TriggerMode = 'click';

let service: ExtensionConfigurationService | undefined;

/** Called from `activate`, which is the only place the services are handed out. */
export function bindConfiguration(next: ExtensionConfigurationService | undefined): void {
  service = next;
}

export function triggerMode(): TriggerMode {
  const value = service?.get<string>(TRIGGER_MODE_KEY, DEFAULT_TRIGGER_MODE);
  return value === 'hover' ? 'hover' : DEFAULT_TRIGGER_MODE;
}
