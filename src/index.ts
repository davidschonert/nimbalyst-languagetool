/**
 * LanguageTool for Nimbalyst — extension entry point.
 *
 * Spike 1 scope: prove the host hands us the live markdown editor. Nothing
 * here talks to LanguageTool yet.
 */

import { LanguageToolExtension } from './lexical/CheckerExtension';

/**
 * Declared in manifest.json as `contributions.lexicalExtensions`. The loader
 * matches these export names against that array; a mismatch is a silent
 * console warning, not a build error.
 */
export const lexicalExtensions = {
  LanguageToolExtension,
};

export async function activate(): Promise<void> {
  console.info('[languagetool] activated');
}

export async function deactivate(): Promise<void> {
  console.info('[languagetool] deactivated');
}
