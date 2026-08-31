# nimbalyst-languagetool

LanguageTool grammar, style, and spell checking inside the [Nimbalyst](https://nimbalyst.com) markdown editor. Underlines on flagged text, a correction card explaining each one, and replacement suggestions you can click to apply.

It works and I use it. The Status section below lists what is still missing.

## Requirements

- Nimbalyst 0.75.5 or later. The extension is built against extension SDK 0.5.0, and I have not tested it against any earlier version.
- Node.js 20.19 or later, for building.
- A LanguageTool backend, either a local server or a LanguageTool Premium account.

## Backends

Two backends, switchable from the settings panel.

**Local.** A self-hosted LanguageTool HTTP Server, by default at `http://localhost:8081`. This is the default, and it is the only backend that runs while you type. Nothing leaves the machine.

**Cloud.** `api.languagetoolplus.com`, which needs a Premium username and access token and gives you the premium-only rules. It is rate limited per day, so it is manual only and meant for a final pass.

Document text is sent to the cloud backend only when you choose it. The access token is kept in Nimbalyst's encrypted secret store, so it is never written into this repository or into a settings file.

## Status

- [x] Underlines in the markdown editor, with a correction card and click to apply
- [x] Markdown-aware checking, built from the Lexical node tree so syntax is not flagged
- [x] Both backends, with local as the default
- [x] Settings panel: backend, credentials, language, rule and category disabling, `picky`
- [ ] Personal dictionary. Product names are currently reported as misspellings, so this
      is the next thing worth doing
- [ ] Chunking, so a long document is checked in blocks. The service rejects a single request
      over 20,000 characters on the free tier and 60,000 on Premium, and chunking would also
      return results for the top of a document sooner and let an edit re-check only its own block
- [ ] Rate limiting. The cloud debounce is one fixed value, which is too slow for Premium and
      too fast for the free tier
- [ ] A visible indicator of the active backend in the editor
- [ ] Inline suppression comments

## Development

```bash
npm install
npm test
npm run build
```

Then enable Extension Dev Tools in Settings > Advanced and install the built extension from this
folder. `npm run dev` rebuilds on change.

`npm run build` also validates the manifest against the rules Nimbalyst applies when it loads an
extension. An invalid manifest makes the host skip the extension entirely, which looks like the
extension being absent rather than broken, so it is worth failing the build instead.

The tests cover the parts that can run without the editor: the tree walk, the offset mapping, the
match anchoring, and the request the client builds. The overlay and the settings panel are verified
by running the app.

## Credits

Informed by [obsidian-languagetool-plugin](https://github.com/Clemens-E/obsidian-languagetool-plugin) (AGPL-3.0) and [vscode-languagetool-linter](https://github.com/davidlday/vscode-languagetool-linter) (Apache-2.0). No code was copied from either. The underline overlay follows the approach [Nimbalyst](https://github.com/nimbalyst/nimbalyst) (MIT) uses for its own find-in-document highlights.

Unofficial. Not affiliated with LanguageTool GmbH.

## License

MIT. See [LICENSE](LICENSE).
