/**
 * Pre-flight the built extension.
 *
 * Two layers, because they cover different things:
 *
 *   1. The SDK's own `validateExtensionBundle` — missing id/name/main, an
 *      entry file that does not exist, and an accidentally bundled copy of
 *      React or Lexical.
 *   2. Contribution rules the HOST loader enforces but the SDK validator does
 *      not. These matter more, because the host reaction to a bad manifest is
 *      to skip the entire extension with a console error. Nothing looks wrong
 *      at build time and everything is wrong at run time.
 *
 * The SDK is imported by file path rather than package name: its barrel
 * re-exports modules that import react and yjs, which the host provides and
 * which are not installed for tooling. validate.js itself needs only fs/path.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const validateUrl = new URL(
  '../node_modules/@nimbalyst/extension-sdk/dist/validate.js',
  import.meta.url,
);
const { validateExtensionBundle } = await import(validateUrl.href);

const distPath = fileURLToPath(new URL('../dist', import.meta.url));
const manifestUrl = new URL('../manifest.json', import.meta.url);

const errors = [];
const warnings = [];

const result = await validateExtensionBundle(distPath);
errors.push(...(result.errors ?? []));
warnings.push(...(result.warnings ?? []));

const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const contributions = manifest.contributions ?? {};

// The host rejects the whole manifest when `configuration` is declared without
// a `properties` object. An EMPTY object is valid, and is what we want: it
// keeps services.configuration alive while stopping the host rendering its own
// field UI, whose inputs lose focus on every keystroke.
if (contributions.configuration !== undefined) {
  const properties = contributions.configuration.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    errors.push(
      "contributions.configuration is missing a 'properties' object, so the host " +
        'skips the entire extension. Use "properties": {} when there are none.',
    );
  }
}

for (const warning of warnings) console.warn(`warning: ${warning}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}

console.log('manifest ok');
