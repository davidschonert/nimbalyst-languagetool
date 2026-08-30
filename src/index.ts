/**
 * LanguageTool for Nimbalyst — extension entry point.
 *
 * Both feasibility spikes have passed. Matches are still generated locally;
 * nothing talks to LanguageTool yet.
 */

import './ui/styles.css';

import type { ExtensionContext } from '@nimbalyst/extension-sdk';

import { bindConfiguration } from './core/config';
import { LanguageToolExtension } from './lexical/CheckerExtension';

/**
 * Declared in manifest.json as `contributions.lexicalExtensions`. The loader
 * matches these export names against that array; a mismatch is a silent
 * console warning, not a build error.
 */
export const lexicalExtensions = {
  LanguageToolExtension,
};

export async function activate(context: ExtensionContext): Promise<void> {
  // A contributed Lexical extension never sees the ExtensionContext, so the
  // services it needs are handed to module-level holders here.
  bindConfiguration(context.services.configuration);
  console.info('[languagetool] activated');
}

export async function deactivate(): Promise<void> {
  bindConfiguration(undefined);
  console.info('[languagetool] deactivated');
}
