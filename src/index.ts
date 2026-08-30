/**
 * LanguageTool for Nimbalyst — extension entry point.
 */

import './ui/styles.css';

import type { ExtensionContext } from '@nimbalyst/extension-sdk';

import { bindConfiguration } from './core/config';
import { clearApiKey, writeApiKey } from './core/secrets';
import { LanguageToolExtension } from './lexical/CheckerExtension';

/**
 * Declared in manifest.json as `contributions.lexicalExtensions`. The loader
 * matches these export names against that array; a mismatch is a silent
 * console warning, not a build error.
 */
export const lexicalExtensions = {
  LanguageToolExtension,
};

/**
 * TEMPORARY, until the settings panel exists.
 *
 * The cloud access token has to be written to the encrypted store somehow, and
 * there is no UI yet. From DevTools:
 *
 *   await __ltSetApiKey('your-token')
 *   await __ltClearApiKey()
 *
 * Deliberately write-only. There is no read helper, so the token cannot be
 * pulled back out through the console.
 */
function exposeTokenHelpers(): void {
  const target = window as unknown as Record<string, unknown>;
  target['__ltSetApiKey'] = (value: string) => writeApiKey(value);
  target['__ltClearApiKey'] = () => clearApiKey();
}

function removeTokenHelpers(): void {
  const target = window as unknown as Record<string, unknown>;
  delete target['__ltSetApiKey'];
  delete target['__ltClearApiKey'];
}

export async function activate(context: ExtensionContext): Promise<void> {
  // A contributed Lexical extension never sees the ExtensionContext, so the
  // services it needs are handed to module-level holders here.
  bindConfiguration(context.services.configuration);
  exposeTokenHelpers();
  console.info('[languagetool] activated');
}

export async function deactivate(): Promise<void> {
  bindConfiguration(undefined);
  removeTokenHelpers();
  console.info('[languagetool] deactivated');
}
