# CLAUDE.md — repo root

Standing context and rules for Claude Code working in this repository. Read this file first, then
the module the task points to. Keep it in sync with `README.md`.

`ROADMAP.md` holds everything known to be missing, and is the only place unimplemented work is
recorded. Add to it rather than leaving an intention in a commit message or a pull request, since
two requirements from the original brief were lost that way before it existed.

## What this project is

A Nimbalyst extension that puts LanguageTool grammar, style and spell checking inside the built-in
markdown editor: squiggly underlines on flagged text, a correction card with an explanation, and
click-to-apply replacements.

It is a contributed Lexical extension rather than a standalone app. The host hands it the live
`LexicalEditor` and a small services bag, and everything else is built on top of that one handle.

Two backends, switchable in settings:

- Local (default). A self-hosted LanguageTool HTTP Server at `http://localhost:8081`. It runs while
  you type, and nothing leaves the machine.
- Cloud. `api.languagetoolplus.com`, with a Premium username and access token. It has the
  premium-only rules and is rate limited per day.

## The pipeline

Every feature sits somewhere on this line. Know which stage you are in before changing anything:

```
Lexical node tree
  └─ core/annotate.ts   buildDocumentBlocks()    → DocumentBlock[]
       └─ core/incremental.ts  planCheck()       → only the blocks that changed
            └─ core/chunk.ts  chunkDocument()    → AnnotatedDocument[]  (one per request)
              └─ core/client.ts  check()         → POST /v2/check  → RawMatch[]
                 └─ core/matches.ts  anchorMatches() → AnchoredMatch[]  (nodeKey + in-node offset)
                      └─ ui/UnderlineLayer.ts    → absolutely positioned squiggles
                           └─ ui/MatchPopover.ts → the correction card
```

`lexical/CheckerExtension.ts` is the orchestrator: debounce, supersede, repaint, hit-test, apply.
`settings/SettingsPanel.tsx` and `core/config.ts` feed it options, and `core/secrets.ts` supplies
the cloud token and nothing else.

## Module map

| Path                           | Holds                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `src/index.ts`                 | `activate` / `deactivate`, and the exports the manifest names.               |
| `src/core/annotate.ts`         | Lexical tree → blocks, blocks → AnnotatedText, and the offset mapping back.  |
| `src/core/chunk.ts`            | Blocks → request-sized chunks. The split rule and the size budget.          |
| `src/core/incremental.ts`      | Which blocks need re-checking, and the cache of what each one said.         |
| `src/core/client.ts`           | The one HTTP call. Two backends, one request shape. `CheckError` taxonomy.   |
| `src/core/matches.ts`          | `RawMatch` → `AnchoredMatch`, and carrying an anchor across an edit.         |
| `src/core/config.ts`           | Typed reads over the host's config bag. Defaults live here, not in manifest. |
| `src/core/secrets.ts`          | The cloud token, over the host's encrypted store. Read the header.           |
| `src/lexical/CheckerExtension.ts` | Registration, debounce, supersede, event wiring, teardown.                |
| `src/ui/UnderlineLayer.ts`     | The overlay. No document mutation.                                           |
| `src/ui/MatchPopover.ts`       | The correction card. Plain DOM, `position: fixed`, appended to `<body>`.    |
| `src/settings/SettingsPanel.tsx` | The settings UI. The extension owns it, and the host renders nothing.      |
| `scripts/validate.mjs`         | Pre-flights the built bundle and the contribution rules the host applies.     |

## Commands

```bash
npm test          # vitest run, which uses vitest.config.ts and NOT vite.config.ts
npm run typecheck # tsc --noEmit
npm run build     # vite build && node scripts/validate.mjs
npm run dev       # vite build --watch
npm run validate  # manifest + bundle checks without rebuilding
```

CI runs typecheck, then test, then build, on Node 20.19 and 22. Node 20.19 is the lower bound vite 7
requires, so it is worth proving.

`vitest.config.ts` is deliberately separate from `vite.config.ts`. The SDK's vite plugin asserts
that the built bundle matches `manifest.main`, so tests that inherited the build config failed on
any clean checkout where `dist/` was absent. Do not merge them back.

## Hard invariants

Breaking one of these produces a silent wrong result rather than an error. They are the reason the
tests in `src/core/*.test.ts` exist. If you change one, change its test in the same commit.

**Offsets**

- A `markup` item contributes its raw length to the offset space, never the length of its
  `interpretAs`. A match at offset N indexes the concatenation of every item exactly as supplied.
  This was confirmed against a live LanguageTool 6.6 server, and `annotate.test.ts` guards it.
- Inline markup always carries an `interpretAs`. Without one, LanguageTool collapses the surrounding
  whitespace and reports `CONSECUTIVE_SPACES` over a range the user cannot act on.
- A match that begins inside markup is dropped rather than clipped, since its start offset is not a
  position the user can edit. A match that overruns from prose into markup is clipped to the prose.
- Nothing is serialized to markdown and re-parsed. The annotation is built from the node tree, so
  offsets never round-trip.
- A chunk is a document in its own right. Its offsets start at zero and a match from it is resolved
  against it, never against the whole file. `assembleDocument()` is the only thing that builds an
  offset space, which is why chunking reuses it instead of doing the arithmetic a second time.

**Anchors across an edit**

- An anchor kept through an edit is moved to where its text now is, never left where it was. Its
  replacement splices at `offset` and `length`, so an anchor that is one character stale rewrites
  the wrong characters and the document is silently corrupted. `carryOver()` in `matches.ts` is the
  only place this happens, and `matches.test.ts` holds it.
- A match the edit ran through is dropped rather than clipped or shifted. The text the service
  judged is not the text there any more, so there is nothing to keep.
- Splitting a paragraph with Enter and merging two with Backspace move text between nodes rather
  than within one, so `reanchor` alone cannot follow them and half a paragraph goes bare.
  `movesFor()` recognises both from the shape of the change: a split leaves the head on the
  original node and the tail verbatim in a node that did not exist before, and a merge destroys a
  node and inserts its whole text into one that survived. Both shapes were confirmed against
  Lexical, and the tests drive real `insertParagraph` and `deleteCharacter` calls rather than a
  hand-made dirty set. Anything that does not match a shape exactly is left alone and its matches
  are dropped, because guessing where text went is how an anchor lands on the wrong word.
- A response is discarded rather than re-anchored when the text under it moved while it was in
  flight. That question is asked per chunk, against the set of nodes dirtied since the run began,
  not per document: editing one node cannot move another node's in-node offsets, so a chunk covering
  untouched nodes is still good. It used to be a document-wide version counter, which was safe but
  meant one keystroke abandoned every chunk still to come and a long document's tail was never
  reached. Carrying anchors is for what is already painted, not for results in flight.

**Chunk boundaries**

- A chunk ends only between blocks, which is where the rendered document already has a paragraph
  break. LanguageTool judges a sentence by the whole sentence, so a seam inside one produces false
  positives on both sides of it.
- The one exception is a block larger than the entire budget, which has to be split somewhere or it
  can never be checked at all. That falls back to the last sentence end that fits, then to the last
  word boundary, then to starting a fresh part so the whole budget is available to look in, and only
  then through a token. `cutPoint` reports "no boundary" rather than cutting, because the token cut
  is the last resort of the whole split and not of one call: a markup piece placed earlier can leave
  a few characters of room, and cutting there splits a word nowhere near budget length. Those parts
  are never packed next to a neighbour,
  because the break between them is only a sentence end in the best case.
- Size is measured twice. The service's cap counts the text it sees, which is prose plus the
  `interpretAs` substitutes; the raw length is what a match offset indexes. A chunk is under the
  limit on both.
- The packer is told which blocks were padded for context and backs up to a boundary that does not
  separate one from its neighbours. It can only back up while the blocks it moves still fit in the
  chunk they move to, so a run long enough to need a boundary in an awkward place still gets one,
  and that block is checked without the context on one side. `chunk.test.ts` holds both the case
  where backing up works and the case where the budget refuses it.

**Incremental checking**

- A block is only reused when its content and its node keys both match. Identical text in a
  recreated node is a different anchor, so the fingerprint covers the node keys and their offsets
  as well as the items. `fingerprint()` in `incremental.ts` is the only place this is decided.
- The fingerprint holds the block's whole content rather than a hash of it. A collision would serve
  one block's matches for another block's text, which is an underline over something nobody
  checked, and that is the failure the module exists to prevent rather than to cause.
- A stale block is always sent with its immediate neighbours, and only the matches landing in the
  stale block are kept. LanguageTool's repetition and style rules reach across paragraph breaks, so
  a block sent alone loses them silently, and a match found on the document's first check would
  disappear the moment its block was re-checked by itself.
- The map a run assembles the document from is carried across an edit exactly as the painted list
  is. It is what `settle()` rebuilds from, so leaving it on the pre-edit anchors silently undoes
  every `carryOver` the listener did mid-run and puts an anchor back over text the service never
  judged. Neither the token nor the per-chunk guard catches that: they stop a chunk's answer being
  applied, not the reassembly after it.
- The neighbours are context, not work. Their own cached matches are kept as they are, so a
  cross-paragraph match that a neighbour holds *about* the edited block is not refreshed until that
  neighbour changes on its own. That is the accepted residual of checking incrementally, and
  widening it would mean re-checking a block's neighbours on every edit.
- The cache holds unfiltered matches. The dictionary and the dismissals are applied where the
  document is assembled, so adding a word or ignoring a rule does not have to discard a document's
  worth of answers, and cannot leave the cache disagreeing with what is painted.
- Any change to what is asked, meaning the language, `picky`, the mother tongue, the disabled rules
  and categories, or the backend, empties the cache. An answer is only good for the request that
  produced it.

**Privacy**

- Document text leaves the machine only when the cloud backend is explicitly selected. Local is the
  default and must stay the default.
- The personal dictionary's account push is the one exception, and it is meant to stay the only one.
  With `languagetool.dictionaryPushToCloud` turned on, `dictionary.ts` sends a single added word to
  `api.languagetoolplus.com` on either backend, because the account dictionary it writes to is a
  cloud object and applies to every LanguageTool client the user runs, not just this one. It is off
  by default, it fires per word at the moment the user asks for it, and it sends nothing but that
  word. Anything that would widen it — a batch upload, a background sync, a read-back — is a new
  decision, not a continuation of this one. `README.md` states the same exception in the user's
  words, and the two move together.
- The access token never goes into configuration, into the repo, or into a settings file. It goes
  only into Nimbalyst's encrypted secret store. `config.test.ts` asserts that `checkOptions()`
  carries no `apiKey`.
- Cloud credentials are sent both or neither. One alone makes the service reject the request.

**Host workarounds, which should not be cleaned up**

- `contributions.configuration.properties` is declared and empty on purpose. The block has to exist
  or `services.configuration` is never handed out. However, any declared property makes the host
  render its own field UI, which disables each input while it saves and so drops focus on every
  keystroke. `scripts/validate.mjs` fails the build if `properties` goes missing.
- The secret key is `nimbalyst_io_github_davidschonert_languagetool_apiKey`, with letters, digits
  and underscores only. The SDK's own scheme uses colons, the host's sanitizer keeps them, and NTFS
  reads `name:stream` as an Alternate Data Stream, so a colon key fails with ENOENT on Windows.
  Tracked upstream at <https://github.com/nimbalyst/nimbalyst/issues/1408>, and the reason the
  runtime cannot use `ExtensionStorage` at all is
  <https://github.com/nimbalyst/nimbalyst/issues/1407>.
- Config is read lazily at the point of use. The host loads its cache once at activation and emits
  no change event, so an eager read during startup returns defaults forever.
- The editor root is not mounted when `register` runs. Attach the overlay from
  `registerRootListener`, never from `register`.
- Repositioning and re-checking must not share a debounce. The overlay repaints per animation frame,
  and checks wait for a real pause.

## Workspace and workflow

- Conventional Commits, with branch prefixes `feature/`, `fix/`, `chore/` and `docs/`.
- Protect `main`: a PR and green CI before merge. Keep PRs small and reviewable.
- The tests cover what runs without an editor: the tree walk, the offset mapping, the chunk split,
  the match anchoring, and the request the client builds. The overlay and the settings panel are
  verified by running the app, so a change to either needs a manual pass before it ships.

## Code review

Review is tied to units of work rather than to a calendar, and it runs in a session that did not
write the code.

That second part is the method. A session reviewing its own diff still has every justification it
invented sitting in context, including the comments it wrote asserting the thing holds, so it is
primed to confirm rather than to falsify. It is not a second opinion. A fresh session sees what a
reviewer sees, which is the diff, the code around it, and this file.

The order:

1. Before pushing, run the mechanical gate only: `npm run typecheck`, `npm test`, `npm run build`.
   This is not a review. Pushing a red branch spends the reviewer's attention on what CI catches for
   free.
2. Open the PR. CI runs on Node 20.19 and 22, and the diff becomes a fixed thing with an address.
3. Review from a new session, pointed at the PR number rather than at a branch or a working tree:
   `/code-review high 4`. The PR carries the description, the commit messages and the CI result,
   which is the same evidence a human reviewer would have.
4. Findings go onto the PR with `--comment`, and into the report described below. Never into the
   chat as a list. A finding in a transcript is gone when the session ends, and a finding on the PR
   is still there in a month.
5. The session that wrote the code fixes the findings. The reviewing session does not, because a
   reviewer that fixes starts arguing itself out of its own findings.

Tiers, by what a mistake would cost:

- Every PR, required. `/code-review` at medium.
- Invariant changes. `/code-review high` for anything touching the offset model in `annotate.ts`,
  the anchor carry-over in `matches.ts`, the request contract in `client.ts`, the secret key in
  `secrets.ts`, or the `manifest.json` contributions. Those are the places where a mistake is
  silent.
- Release boundaries. `/code-review ultra` on the PR, which is the same method run wider. It has to
  be started by hand and it is billed, so it is not something a session can reach for on its own.
- Anything touching what leaves the machine, meaning the cloud path, the token and the client
  request, also gets `/security-review` on the PR.
- Review complements the manual pass on the overlay and the settings panel rather than replacing it.
  Review finds correctness issues, but only running the app proves the UI works.

Two things follow from the reviewer having no context.

The first is that this file is the only briefing it gets. A fresh session does not know that the
offset model was confirmed against a live LanguageTool 6.6 server, or why the secret key has no
colons in it, unless the repo says so. So an invariant belongs here or in a module header, never in
a session, and the Hard invariants section above is written for that reader.

The second is that the small-PR rule matters more here than it would with a human colleague, who
would arrive with months of ambient knowledge of the codebase. Around 300 lines of source is where a
review stays sharp. Past that, split the branch, or say in the description which commits to read and
in what order.

### Reporting findings

The deliverable is three things, and they are not redundant. Each is read at a different moment:

- **One HTML Artifact.** The report I actually read, and the only one of the three built to be
  decided on in a single pass.
- **`ReportFindings`.** So the findings render in the session's own UI rather than as prose.
- **One inline PR comment per finding**, on the line it concerns, plus a summary comment. This is
  the copy that outlives the session and the one the fixing session works from.

The chat gets three lines and no more: the Artifact link, the count by severity, and how many
findings need a decision from me.

Every finding carries all six of these, in the Artifact and in its PR comment alike:

| Field            | Rule                                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | `Critical` (data loss, document corruption, a broken invariant above, a leaked credential) · `High` (wrong behavior a user will hit) · `Medium` (wrong behavior behind a condition, or a real maintainability cost) · `Low` (cleanup, clarity, convention). Most severe first, always. |
| **Claim**        | One sentence naming the defect. Say what is wrong rather than "consider refactoring X".                                                                                                                              |
| **Where**        | `path/to/file.ts:line`, as a link.                                                                                                                                                                                  |
| **Why it bites** | The concrete failure: inputs or state, then wrong output. If you cannot write one, the finding is not confirmed and does not belong in the report.                                                                   |
| **Fix**          | The actual change, with a snippet where a snippet beats prose. Enough that approving it needs no further thinking.                                                                                                   |
| **Verdict**      | `Fix` (the default; assume yes, since token cost is not a constraint) · `Fix with care` (do it, but the named risk has to be handled) · `Don't fix` (the change would cost more than the defect, so say what it would break and what to do instead). |

`Don't fix` and `Fix with care` are the point of the format. My standing instruction is to fix
everything, so the only thing that genuinely needs my attention is where that instruction is wrong.
Surface those at the top, before the severity list, under a heading that says how many there are.
Never bury a "this fix would do more harm than good" in a Low-severity row.

The report exists to be decided on in about a minute. A report that takes ten minutes to parse gets
skipped, and the review was still paid for. So keep the layout identical from run to run, and do not
make it something that has to be learned again each time:

1. Verdict first: counts by severity.
2. Then the decisions needed.
3. Then the findings.

- Severity color-coded and labeled, never color alone.
- One finding per card, scannable at a glance, with long evidence in a `<details>`.
- Self-contained, since the Artifact CSP blocks every external request, and theme-aware.
- Ground it in this project's own palette, where the underline scale doubles as the severity scale:
  spelling red `#d6453d`, grammar amber `#d19a2c`, style blue `#3d7bd6`; text `#1a1a1a` / `#e6e6ea`,
  muted `#6b7280` / `#9a9aa6`, borders `#e2e4e9` / `#3a3b45`, grounds `#ffffff` / `#1c1c22`.

The PR summary comment carries the same three sections in the same order, in plain markdown.

Verify a finding before you report it. A failure scenario you reasoned out but never observed is a
hypothesis. Most of this codebase is reachable from `vitest` and a headless editor, so reproduce it
and put the observed output in the report. A finding that turns out to be wrong is more expensive
than one you missed, because someone will act on it.

After the fixes land, redeploy the same Artifact, since the same file path keeps the same URL, with
each finding marked `Fixed`, `Skipped (reason)` or `No change needed`. Resolve the matching PR
comments at the same time. That keeps the record of what was decided with the findings rather than
in chat scrollback. Commit messages still carry the summary.

## When unsure

Surface a single focused question instead of guessing, especially if a change would touch one of the
hard invariants above, or a host workaround whose reason is recorded in a module header. Those
headers are the decision log, so read the header before changing the module.
