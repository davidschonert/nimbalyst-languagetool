# Roadmap

Everything known to be missing, in roughly the order I would do it. This is the single place
unimplemented work is recorded. The Status section in `README.md` says what works, and does not
repeat this list, because two lists drift apart.

Each entry carries the constraint behind it rather than only a title. The numbers and the reasons
are the part that is expensive to recover later.

## Re-check only the blocks that changed

Chunking splits the document, but a check still sends every chunk. Editing one paragraph re-sends
the whole file, which is the third thing chunking was meant to buy and the one still outstanding.

The seam it needs already exists. Matches come back anchored to a node key and an in-node offset,
which is a coordinate space that does not depend on how the document was chunked, so a cache keyed
on a block's content would let an unchanged block keep its matches while only the dirty ones go to
the service. `CheckerExtension.ts` already knows which nodes those are, from `dirtyLeaves`.

The cache key has to cover the node keys as well as the text. Identical text in a recreated node is
a different anchor, and reusing the old one would underline a node that no longer exists.

## A check that survives a keystroke

Raised by the review of #4, and left alone on purpose until the chunking has had some use.

`runCheck` abandons the whole remaining sequence when `docVersion` moves, and one keystroke moves
it. A 100,000 character document on local is five sequential requests, so during active editing the
tail is rarely reached, and every attempt re-sends chunk 1 from the start. Before chunking, one
uninterrupted window covered the whole document. Now the window has to cover the debounce plus every
round trip.

The guard itself is right and must not simply be relaxed. It is what stops a response built from an
older tree being anchored to offsets that have already moved, and that failure is a wrong splice
rather than a visible error.

So the fix is to narrow it. Either resume the sequence where it stopped instead of restarting at
chunk 1, or discard a response only when a node that its own chunk covers was dirtied since the run
began. The second is the better answer and it wants the per-block cache above to exist first, since
both are the same idea: stop treating the document as one unit of invalidation.

Finding 5 of the same review compounds with this one. A node split across two chunks blinks out
until the sequence finishes, and while the sequence keeps being abandoned it does not finish.


## Rate limiting

The service allows 20 requests and 75,000 characters per minute on the free tier, and 80 and
300,000 on Premium. Characters per minute used to bind first, because every check sent the whole
document: a 20,000 character document allowed a check every 16 seconds on free and every 4 seconds
on Premium.

Chunking changes that. A check of a long document is now several requests in a row rather than one,
so requests per minute is worth counting again, and the figure to rate limit against is the chunk
rather than the file.

The cloud debounce is still one fixed value, which is both too slow for Premium and too fast for
free. A rate limit that accounts for how much is actually being sent would replace it.

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

## Import an existing LanguageTool account dictionary

Words can be pushed to the account when the user turns that on, but nothing is
ever read back, so words already saved in a LanguageTool account are still
reported here. `GET /v2/words` would fetch them, with the same credentials the
push already uses.

Deliberately left out for now because it is only worth building for someone who
already has a populated account dictionary. The two lists are not synchronised
and are not meant to be: an import would be a one-off action the user asks for,
not a background reconciliation.

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
