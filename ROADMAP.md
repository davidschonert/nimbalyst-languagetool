# Roadmap

Everything known to be missing, in roughly the order I would do it. This is the single place
unimplemented work is recorded. The Status section in `README.md` says what works, and does not
repeat this list, because two lists drift apart.

Each entry carries the constraint behind it rather than only a title. The numbers and the reasons
are the part that is expensive to recover later.

## Chunking

The service rejects a single request over 20,000 characters on the free tier and 60,000 on Premium.
A document over the cap fails outright, the underlines disappear, and the only explanation is an
HTTP error. That alone makes chunking necessary rather than an optimization.

It also earns its place twice more. Results for the top of a long document arrive sooner, and an
edit can re-check only the block it touched instead of the whole file, which composes with the
`dirtyLeaves` invalidation already in `CheckerExtension.ts`.

Chunk on block boundaries and never mid-sentence. LanguageTool needs sentence context, so a split
inside one produces false positives at every seam.

## Rate limiting

The service allows 20 requests and 75,000 characters per minute on the free tier, and 80 and
300,000 on Premium. Because every check sends the whole document, characters per minute binds before
requests per minute: a 20,000 character document allows a check every 16 seconds on free and every 4
seconds on Premium.

The cloud debounce is currently one fixed value, which is both too slow for Premium and too fast for
free. A rate limit that accounts for document size would replace it. Chunking changes this
calculation, so it is probably worth doing chunking first.

## A visible indicator of the active backend

From the original brief, and never built. The settings panel shows which backend is selected, but
nothing in the editor does, so there is no way to tell at a glance whether the document being typed
is going to LanguageTool's servers. That matters more than convenience, given the privacy rule in
`CLAUDE.md`.

## Check on save

The brief asked for a check on pause or on save. Only the pause exists.

A contributed Lexical extension has no obvious save hook. `EditorHost.onSaveRequested` belongs to
custom editors, and this extension is not one, so this needs a look at what the host exposes before
it can be estimated.

## A one-off cloud check

From the brief: a command that runs a full-document check against the cloud regardless of which
backend is selected. The intended workflow is local while writing and cloud for a final pass before
something ships, so this is the piece that makes the cloud backend useful without switching to it.

`contributions.commands` is described as reserved for future contributions in the manifest
reference, so a slash command may be the only route available today. Worth confirming.

## Move secrets onto ExtensionStorage, once the host allows it

Not work to schedule, but work to notice when it becomes possible.

`core/secrets.ts` reaches the host's encrypted store over IPC rather than
through `ExtensionStorage`, for two reasons. One of them is now fixed upstream
and the other is not.

[#1408](https://github.com/nimbalyst/nimbalyst/issues/1408), where colons in a
scoped key made every write fail on Windows, is fixed but not yet in a release.
When it ships, the stored token migrates on its own: the new filename carries a
hash of the key, a read falls back to the pre-fix filename, and ours already is
that filename.

[#1407](https://github.com/nimbalyst/nimbalyst/issues/1407), where
`ExtensionServices` carries no storage, is still open. It is the one that
matters here, because it is why the runtime cannot read the token at load. Until
it moves, the workaround stays.

There is a trap in between. Once #1408 ships, the settings panel could switch to
`storage.setSecret`, since panels do receive `storage`, and it would look like
the supported fix. It would break the token: the host would write under a
different key, so a different file from the one the runtime reads, and the panel
would report success while the checker saw no token. Reading and writing move
together or not at all.

## Inline suppression comments

`@LT-IGNORE:<rule>(<text>)@` inside an HTML comment, borrowed from `vscode-languagetool-linter`.

This is a spike before it is a feature. It assumes an HTML comment survives Nimbalyst's markdown
round-trip as something the tree walk can recognize, and that has not been verified. If it does not
survive, the persisted ignore list and the personal dictionary already cover most of the same need
without putting anything in the document.
