# CLAUDE.md — repo root

Standing context and rules for Claude Code working in this repository. Read this file first, then
the module the task points to. Keep it in sync with `README.md`.

## What this project is

A Nimbalyst extension that puts **LanguageTool grammar, style and spell checking inside the
built-in markdown editor** — squiggly underlines on flagged text, a correction card with
explanation, and click-to-apply replacements.

It is a **contributed Lexical extension**, not a standalone app. The host hands it the live
`LexicalEditor` and a small services bag; everything else is built on top of that one handle.

Two backends, switchable in settings:

- **Local** (default) — a self-hosted LanguageTool HTTP Server, `http://localhost:8081`. Runs while
  you type. Nothing leaves the machine.
- **Cloud** — `api.languagetoolplus.com`, Premium username + access token, premium-only rules, rate
  limited per day.

## The pipeline

Every feature sits somewhere on this line. Know which stage you are in before changing anything:

```
Lexical node tree
  └─ core/annotate.ts    buildAnnotatedDocument()  → AnnotationItem[] + TextSegment[]
       └─ core/client.ts  check()                  → POST /v2/check  → RawMatch[]
            └─ core/matches.ts  anchorMatches()    → AnchoredMatch[]  (nodeKey + in-node offset)
                 └─ ui/UnderlineLayer.ts           → absolutely positioned squiggles
                      └─ ui/MatchPopover.ts        → the correction card
```

`lexical/CheckerExtension.ts` is the orchestrator: debounce, supersede, repaint, hit-test, apply.
`settings/SettingsPanel.tsx` and `core/config.ts` feed it options; `core/secrets.ts` supplies the
cloud token and nothing else.

## Module map

| Path                           | Holds                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `src/index.ts`                 | `activate` / `deactivate`, and the exports the manifest names.               |
| `src/core/annotate.ts`         | Lexical tree → LanguageTool AnnotatedText, and the offset mapping back.      |
| `src/core/client.ts`           | The one HTTP call. Two backends, one request shape. `CheckError` taxonomy.   |
| `src/core/matches.ts`          | `RawMatch` → `AnchoredMatch`. Issue types collapse to three underline kinds. |
| `src/core/config.ts`           | Typed reads over the host's config bag. Defaults live here, not in manifest. |
| `src/core/secrets.ts`          | The cloud token, over the host's encrypted store. **Read the header.**       |
| `src/lexical/CheckerExtension.ts` | Registration, debounce, supersede, event wiring, teardown.                |
| `src/ui/UnderlineLayer.ts`     | The overlay. No document mutation.                                           |
| `src/ui/MatchPopover.ts`       | The correction card. Plain DOM, `position: fixed`, appended to `<body>`.    |
| `src/settings/SettingsPanel.tsx` | The settings UI. The extension owns it; the host renders nothing.          |
| `scripts/validate.mjs`         | Pre-flights the built bundle **and** the contribution rules the host applies. |

## Commands

```bash
npm test          # vitest run — uses vitest.config.ts, NOT vite.config.ts
npm run typecheck # tsc --noEmit
npm run build     # vite build && node scripts/validate.mjs
npm run dev       # vite build --watch
npm run validate  # manifest + bundle checks without rebuilding
```

CI runs typecheck → test → build on Node 20.19 and 22. Node 20.19 is the lower bound vite 7
requires, so it is worth proving.

`vitest.config.ts` is deliberately separate from `vite.config.ts`: the SDK's vite plugin asserts the
built bundle matches `manifest.main`, so tests inheriting the build config failed on any clean
checkout where `dist/` was absent. Do not merge them back.

## Hard invariants

Breaking one of these produces a silent wrong result, not an error. They are the reason the tests
in `src/core/*.test.ts` exist — if you change one, change its test in the same commit.

**Offsets**

- A `markup` item contributes its **raw** length to the offset space, never the length of its
  `interpretAs`. A match at offset N indexes the concatenation of every item exactly as supplied.
  Confirmed against a live LanguageTool 6.6 server. `annotate.test.ts` guards it.
- Inline markup **always** carries an `interpretAs`. Without one, LanguageTool collapses the
  surrounding whitespace and reports `CONSECUTIVE_SPACES` over a range the user cannot act on.
- A match that **begins** inside markup is dropped, not clipped — its start offset is not a position
  the user can edit. A match that **overruns** from prose into markup is clipped to the prose.
- Nothing is serialised to markdown and re-parsed. The annotation is built from the node tree so
  offsets never round-trip.

**Privacy**

- Document text leaves the machine **only** when the cloud backend is explicitly selected. Local is
  the default and must stay the default.
- The access token never goes into configuration, into the repo, or into a settings file — only
  Nimbalyst's encrypted secret store. `config.test.ts` asserts `checkOptions()` carries no `apiKey`.
- Cloud credentials are sent **both or neither**. One alone makes the service reject the request.

**Host workarounds — do not "clean these up"**

- `contributions.configuration.properties` is declared and **empty**, on purpose. The block must
  exist or `services.configuration` is never handed out; any declared property makes the host render
  its own field UI, which disables each input while it saves and so drops focus on every keystroke.
  `scripts/validate.mjs` fails the build if `properties` goes missing.
- The secret key is `nimbalyst_io_github_davidschonert_languagetool_apiKey` — letters, digits and
  underscores only. The SDK's own scheme uses colons, the host's sanitiser keeps them, and NTFS
  reads `name:stream` as an Alternate Data Stream, so a colon key fails with ENOENT on Windows.
  Tracked upstream at <https://github.com/nimbalyst/nimbalyst/issues/1407>.
- Config is read **lazily at the point of use**. The host loads its cache once at activation and
  emits no change event, so an eager read during startup returns defaults forever.
- The editor root is **not mounted** when `register` runs. Attach the overlay from
  `registerRootListener`, never from `register`.
- Repositioning and re-checking must not share a debounce. The overlay repaints per animation
  frame; checks wait for a real pause.

## Workspace & workflow

- **Conventional Commits**; branch prefixes `feature/`, `fix/`, `chore/`, `docs/`.
- Protect `main`: PR + green CI before merge. Keep PRs small and reviewable.
- The tests cover what runs without an editor — the tree walk, the offset mapping, the match
  anchoring, the request the client builds. The overlay and the settings panel are verified by
  running the app, so a change to either needs a manual pass before it ships.

## Code review

Review is tied to units of work, not a calendar. Run the right tier for the stakes:

- **Every PR (required)** → `/code-review` at **medium** effort on the working diff, before opening
  or merging. Fix findings, then merge on green CI. Pairs with the "small PR" rule — small diffs
  keep the review sharp.
- **Invariant changes** → bump to `/code-review high`. Use for anything touching the offset model
  in `annotate.ts`, the request contract in `client.ts`, the secret key in `secrets.ts`, or
  `manifest.json` contributions — the four places where a mistake is silent.
- **Release boundaries** → `/code-review max` on the branch or PR. `max` is the top tier this
  project uses; the codebase is small enough that a wider sweep buys nothing.
- **Anything touching what leaves the machine** — the cloud path, the token, the client request —
  also gets `/security-review` on the pending branch changes.
- Review complements, never replaces, the manual pass on the overlay and settings panel. Review
  finds correctness issues; only running the app proves the UI works.

### Reporting findings (binding — this is the deliverable, not a nicety)

Every review is **one HTML Artifact plus `ReportFindings`**, never a list of findings in the chat.
The chat gets three lines: the link, the count by severity, and how many need an owner decision.

The report exists to be **decided on in about a minute**. A wall of findings that takes ten minutes
to parse gets skipped, and a skipped review is worse than no review, because it was paid for.

**Every finding carries all six fields:**

| Field            | Rule                                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | `Critical` (data loss, document corruption, a broken invariant above, a leaked credential) · `High` (wrong behaviour a user will hit) · `Medium` (wrong behaviour behind a condition, or a real maintainability cost) · `Low` (cleanup, clarity, convention). Most severe first, always. |
| **Claim**        | One sentence naming the defect. Not "consider refactoring X" — say what is wrong.                                                                                                                                   |
| **Where**        | `path/to/file.ts:line`, as a link.                                                                                                                                                                                  |
| **Why it bites** | The concrete failure: inputs or state → wrong output. **If you cannot write one, the finding is not confirmed and does not belong in the report.**                                                                  |
| **Fix**          | The actual change, with a snippet where a snippet beats prose. Enough that approving it needs no further thinking.                                                                                                   |
| **Verdict**      | **`Fix`** (default — assume yes; token cost is not a constraint) · **`Fix with care`** (do it, but the named risk has to be handled) · **`Don't fix`** (the change would cost more than the defect — say what it would break, and what to do instead). |

**`Don't fix` and `Fix with care` are the point of the format.** The owner's standing instruction is
_fix everything_, so the only thing genuinely needing their attention is where that instruction is
wrong. Surface those at the top, before the severity list, under a heading that says how many there
are. Never bury a "this fix would do more harm than good" in a Low-severity row.

**Layout — keep it identical run to run.** A report you already know how to read is faster than a
prettier one you have to learn.

1. Verdict first: counts by severity.
2. Then the decisions needed.
3. Then the findings.

- Severity colour-coded **and** labelled — never colour alone.
- One finding per card, scannable at a glance; long evidence in a `<details>`.
- Self-contained (Artifact CSP blocks every external request) and theme-aware.
- Ground it in this project's own palette — the underline scale doubles as the severity scale:
  spelling red `#d6453d`, grammar amber `#d19a2c`, style blue `#3d7bd6`; text `#1a1a1a` / `#e6e6ea`,
  muted `#6b7280` / `#9a9aa6`, borders `#e2e4e9` / `#3a3b45`, grounds `#ffffff` / `#1c1c22`.

**Verify a finding before you report it.** A failure scenario you reasoned out but never observed is
a hypothesis. Most of this codebase is reachable from `vitest` and a headless editor — **reproduce
it** and put the observed output in the report. One line of real evidence outranks a paragraph of
plausible mechanism. Findings that turn out to be wrong cost more than the ones you miss, because
they get fixed.

**After the fixes land**, redeploy the **same** artifact (same file path keeps the same URL) with
each finding marked `Fixed`, `Skipped (reason)` or `No change needed`, so the record of what was
decided lives with the findings rather than in chat scrollback. Commit messages still carry the
summary.

## When unsure

Surface a single focused question instead of guessing — especially if a change would touch one of
the hard invariants above, or a host workaround whose reason is recorded in a module header. Those
headers are the decision log; read the header before changing the module.
