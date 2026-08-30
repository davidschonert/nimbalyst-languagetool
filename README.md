# nimbalyst-languagetool

LanguageTool grammar, style, and spell checking inside the [Nimbalyst](https://nimbalyst.com) markdown editor. Underlines on flagged text, an explanation on hover, and replacement suggestions you can click to apply.

This is early and it does not check anything yet. The code currently in `src/` only tries to prove that Nimbalyst hands an extension the live markdown editor, which is what everything else depends on.

## Requirements

- Nimbalyst 0.75.5 or later. The extension is built against extension SDK 0.5.0, and I have not tested it against any earlier version.
- Node.js 18 or later, for building.
- A LanguageTool backend, either a local server or a LanguageTool Premium account.

## Backends

Two backends, switchable from settings, with the active one shown in the editor.

**Local.** A self-hosted LanguageTool HTTP Server, by default at `http://localhost:8081`. This is the default, and it is the only backend that runs while you type. Nothing leaves the machine.

**Cloud.** `api.languagetoolplus.com`, which needs a Premium username and access token and gives you the premium-only rules. It is rate limited per day, so it is manual only and meant for a final pass.

Document text is sent to the cloud backend only when you choose it. The access token is kept in Nimbalyst's encrypted secret store, so it is never written into this repository or into a settings file.

## Status

- [x] Project scaffold, building against the extension SDK
- [x] Confirm the host calls `register(editor)` for the built-in markdown editor
- [x] Draw an underline over a document range and keep it positioned through editing and scrolling
- [ ] Build AnnotatedText from the Lexical node tree, so markdown syntax is not flagged
- [ ] The `/v2/check` client, for both backends
- [ ] Underlines, hover explanations, and click to apply
- [ ] Settings, personal dictionary, rule and category disabling, and the `picky` level

## Development

```bash
npm install
npm run build
```

Then enable Extension Dev Tools in Settings > Advanced and install the built extension from this folder. `npm run dev` rebuilds on change.

## Credits

Informed by [obsidian-languagetool-plugin](https://github.com/Clemens-E/obsidian-languagetool-plugin) (AGPL-3.0) and [vscode-languagetool-linter](https://github.com/davidlday/vscode-languagetool-linter) (Apache-2.0). No code was copied from either. The underline overlay follows the approach [Nimbalyst](https://github.com/nimbalyst/nimbalyst) (MIT) uses for its own find-in-document highlights.

Unofficial. Not affiliated with LanguageTool GmbH.

## License

MIT. See [LICENSE](LICENSE).
