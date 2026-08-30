import { defineConfig } from 'vite';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

// createExtensionConfig sets the externals Nimbalyst provides at runtime
// (react, lexical, @nimbalyst/runtime, ...) and the output shape the loader
// expects. Do not hand-roll rollup options here.
export default defineConfig(
  createExtensionConfig({
    entry: './src/index.ts',
  }),
);
