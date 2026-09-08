# Roadmap

Everything known to be missing, in roughly the order I would do it. This is the single place
unimplemented work is recorded. The Status section in `README.md` says what works, and does not
repeat this list, because two lists drift apart.

Each entry carries the constraint behind it rather than only a title. The numbers and the reasons
are the part that is expensive to recover later.

## One rate meter across every Nimbalyst window

The extension is loaded once per window, and each copy holds its own rate meter, so two windows
spend two budgets against one LanguageTool account.

Established by testing the deferral by hand with the budget lowered to two requests a minute. With
two windows open the log carried `[languagetool] activated` twice in the same second from two
`blob:` URLs, and deferral lines from both of them on independent schedules:

```
11:47:59  d793afbe  deferring for 58s
11:48:02  77782605  deferring for 58s
11:48:58  d793afbe  deferring for 1s
11:49:01  77782605  deferring for 59s
11:49:01  d793afbe  deferring for 56s
11:50:02  77782605  deferring for 60s
```

Closing one window and running it again gave one `activated` line, one `blob:` URL, and every
deferral from it. So it is one copy per window, not one per editor and not a settings panel loading
its own, and the copies are not duplicating each other's work: each window checks its own documents.
The cost is the budget alone, multiplied by however many windows are open.

The meter is already at module scope, which is as far as this can be taken inside one copy. Going
further means putting it somewhere every window can see, which for this host is the configuration
bag or a `BroadcastChannel`, and both need the windows to agree on a single count rather than each
keeping their own.

Worth weighing before building that. The consequence of the overrun is bounded: the account's real
limit is reached, the service answers 429, and the backoff added in #7 handles it. So two windows
turn a limiter that avoids refusals into one that recovers from them, which is worse but not broken.
A third window makes it worse again.

## A debounce that accounts for what is being sent

Left behind when the rest of the rate limiting entry was implemented, and nearly lost with it.

`CHECK_DEBOUNCE_MS` in `CheckerExtension.ts` is still one fixed value per backend, 400ms local and
2500ms cloud. It is too slow for a Premium account and too fast for a document that was just pasted
in.

The cloud figure matters more than it looks. It was chosen on the assumption that cloud was a rare
final pass, where a long wait costs nothing. Cloud is in fact the backend in daily use, because the
premium and AI rules find a good deal more, so that two and a half seconds is felt on every pause of
every document. It is the most visible thing left on this list.

The meter answers whether there is room to send right now. It does not answer how long to wait
before asking, which is what the debounce is for, and a single number cannot account for how much a
given check is about to send. The two compose: the debounce decides when to look, and the meter
decides whether to go.

## Clear the underline when a correction is applied

Found while using the extension. Click a replacement in the card and the word stays underlined until
the next check answers. It should go the moment the text changes, since the thing it was reporting
is no longer there.

The cause is that nothing tells `carryOver` which match was applied. It infers what to drop from a
common prefix and suffix comparison of the node's old and new text, and that comparison is
deliberately minimal. When the replacement shares a prefix or a suffix with the flagged text, the
changed range narrows to a sub-range the anchor does not overlap, so the anchor reads as untouched
and is kept.

Reproduced against a headless editor, applying each correction the way `onApply` does:

| Flagged | Replacement | Result |
| ------- | ----------- | ------ |
| `a` in "a apple" | `an` | underline stays on the `a` of `an` |
| ` and` in "hello and world" | `, and` | underline stays, now on ` and` |
| `Teh` | `The` | clears correctly |
| `recieve` | `receive` | clears correctly |
| `the the` | `the` | clears correctly |

The two behaviors are the same rule, which is why it looks intermittent rather than broken. A
replacement that changes the first character clears; one that only inserts around the existing text
does not.

The fix is not to make the diff wider. Inference is right for typing, where nothing announces what
changed, and widening it would drop neighbouring matches that are still perfectly good. It is simply
unnecessary here: `onApply` already knows exactly which anchor it is applying, so it should drop that
one itself and leave `carryOver` to handle everything else.

There is an ordering trap in that. The drop has to happen before `editor.update()` rather than after,
so that the update listener's `carryOver` runs on the already-filtered list. Filtering afterwards
would be overwritten by whatever the listener assigned.

Left unfixed for now on purpose, so it can go in with whatever else the chunking work turns up.

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
backend is selected.

The brief assumed local while writing and cloud for a final pass, and that is not the workflow in
practice: cloud is the daily driver and local is for documents that should not leave the machine. So
the value of this has moved. It is no longer the thing that makes cloud reachable, it is the thing
that lets one document be checked properly without turning the private default off for everything.

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

## Whether the suggestion cap applies to Premium

The public API documents that only the first 30 misspelled words in a request get suggestions.
Anything past that comes back as a match with an empty `replacements` array. That is documented for
the free public endpoint, and I could not find anything saying either way about Premium, so this is
a question rather than a finding.

If it does apply to Premium, the cloud chunk limit is what decides how often it bites. It is 60,000
characters, which is easily enough to hold more than 30 misspellings, so the tail of a long chunk
would underline without offering a fix. The card renders that the same way it renders a match that
genuinely has no suggestion, so it would read as LanguageTool having no idea rather than as the
request being too large.

Testing it is one request: a document with 40 deliberate misspellings, sent to
api.languagetoolplus.com with real credentials, then count how many of the returned matches carry
replacements. If the cap is there, the fix is a lower `CHUNK_LIMIT.cloud`, which trades against the
rate meter, since the same document then costs more requests. Worth measuring before choosing a
number.

## More of the match than the card shows

`RawMatch` in `core/client.ts` names the fields the popover uses. The response carries four more
that it does not: `rule.urls`, `rule.description`, `rule.subId`, and a top-level `sentence`.

`urls` is the one worth having. It links to LanguageTool's own page for the rule, which explains the
rule at a length the card has no room for, so a "Learn more" link would cover the case where the
message alone does not say what is actually wrong. It is optional in the response, so the link only
appears when the rule has one.

The other three can stay out. `sentence` repeats what `context` already carries, `subId` only
distinguishes variants of one rule, and `description` names the rule itself, which would be a third
line of text on a card that already shows the category name, the short message and the message.

The card is plain DOM in the renderer, so an external link has to be handed to the host to open
rather than followed in place. That is the part to check before starting.

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
