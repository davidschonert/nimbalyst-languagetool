# nimbalyst-languagetool

LanguageTool grammar, style, and spell checking inside the [Nimbalyst](https://nimbalyst.com) markdown editor. Underlines on flagged text, a correction card explaining each one, and replacement suggestions you can click to apply.

It works and I use it. The Status section below lists what is still missing.

## Requirements

- Nimbalyst 0.75.5 or later. The extension is built against extension SDK 0.5.0, and I have not tested it against any earlier version.
- Node.js 20.19 or later, for building.
- A LanguageTool backend, either a local server or a LanguageTool Premium account.

## Backends

Two backends, switchable from the settings panel.

**Local.** A self-hosted LanguageTool HTTP Server, by default at `http://localhost:8081`. Nothing leaves the machine, so it is the one to use for anything you would not hand to a third party.

**Cloud.** `api.languagetoolplus.com`, which needs a Premium username and access token. It has the premium-only rules and the AI-based rules that LanguageTool only runs in the cloud, so it finds a good deal more than a self-hosted server does. It is rate limited per minute and per day.

Both run while you type. Local is the default because it is the private one, but cloud is what I use for most work, since the better checking is worth more to me than the privacy on a document that is not sensitive. Which one you want is a question about the document, not about a stage of writing.

Document text is sent to the cloud backend only when you choose it. There is one exception, and it is one you have to turn on: if you switch on adding new words to your LanguageTool account, then each word you add goes to LanguageTool, whichever backend you are checking with. That is what makes the word work in the browser extension too. It is off by default, it happens only at the moment you add a word, and it sends that word and nothing else.

The access token is kept in Nimbalyst's encrypted secret store, so it is never written into this repository or into a settings file.

### Running the local server

Follow [LanguageTool's own instructions](https://dev.languagetool.org/http-server) for downloading
and starting the server, and keep the `--allow-origin` flag they show:

```bash
java -cp languagetool-server.jar org.languagetool.server.HTTPServer --config server.properties --port 8081 --allow-origin
```

That flag is the one to watch. Without it the server answers normally but sends no
`Access-Control-Allow-Origin` header, so the browser blocks the response before this extension ever
sees it. A blocked response and a server that is not running look identical from here, so the editor
says it could not reach LanguageTool and you go looking at the wrong thing.

The local server also does not have the AI-based rules, which LanguageTool only runs in the cloud.
That is a second reason the cloud backend finds things the local one does not, on top of the premium
rules.

Its caches are off by default, and turning them on is worth it for this extension in particular.
Editing one paragraph re-sends the paragraphs on either side of it as context, so the rules that
reach across a paragraph break still work, which means the same text goes to the server again and
again. A `server.properties` along these lines makes those repeats cheap:

```properties
cacheSize=1000
cacheTTLSeconds=600
pipelineCaching=true
pipelinePrewarming=true
```

## Status

- [x] Underlines in the markdown editor, with a correction card and click to apply
- [x] Markdown-aware checking, built from the Lexical node tree so syntax is not flagged
- [x] Both backends, with local as the default
- [x] Settings panel: backend, credentials, language, rule and category disabling, `picky`
- [x] Personal dictionary, so your own vocabulary stops being reported as misspellings, with an
      option to add new words to your LanguageTool account as well
- [x] Chunking, so a document larger than the service will accept in one request still gets
      checked, and a long one underlines from the top down instead of all at once
- [x] Incremental checking, so editing one paragraph re-checks that paragraph rather than the file
- [x] Rate limiting on the cloud backend, which defers a check rather than having one rejected

Everything still missing is in [ROADMAP.md](ROADMAP.md), with the constraint behind each item.

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
chunk split, the match anchoring, and the request the client builds. The overlay and the settings
panel are verified by running the app.

## Credits

Informed by [obsidian-languagetool-plugin](https://github.com/Clemens-E/obsidian-languagetool-plugin) (AGPL-3.0) and [vscode-languagetool-linter](https://github.com/davidlday/vscode-languagetool-linter) (Apache-2.0). No code was copied from either. The underline overlay follows the approach [Nimbalyst](https://github.com/nimbalyst/nimbalyst) (MIT) uses for its own find-in-document highlights.

Unofficial. Not affiliated with LanguageTool GmbH.

## License

MIT. See [LICENSE](LICENSE).
