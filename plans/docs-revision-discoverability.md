---
status: done
depends: []
specs:
  - specs/commands/docs-read.md
  - specs/commands/docs-diff.md
  - specs/commands/drive-revisions.md
  - specs/principles.md
issues: []
pr: 28
---

# Plan: Doc revision discoverability + diff

## Scope

Make Google Doc version history discoverable from the natural entry point and
cheap to compare. Two additive, read-only capabilities:

1. **`docs read` surfaces provenance by default** — every read inlines the most
   recent 5 revisions (`{id,modified,author}`, newest first) and adds version-history
   commands to its `help[]` (`docs revisions`, `docs download --revision`, `docs diff`).
2. **New `docs diff <fileId> <revA> [revB]` command** — fetches a unified diff between
   two revisions (revB defaults to head) by exporting each to markdown server-side and
   diffing locally, so an agent never downloads both and diffs them itself.

Picks up the `revision --diff` deferral recorded in the (now frozen)
[`workspace-history-exploration`](workspace-history-exploration.md) plan's Follow-ups.

In scope: the two specs above, the new `provenance-by-default` principle, reuse of the
existing revision-export path, and Vitest coverage. Explicitly out (stated in
docs-diff.md "Out of scope"): word-level/HTML diffs, binary-file diffs, three-way merge,
faithful editorial diffs.

## Implements

- **specs/commands/docs-read.md** — best-effort `revisions[N]{id,modified,author}` block
  (recent 5, newest first) shown by default; head `revision_id` already present; new
  help suggestions for `revisions` / `download --revision` / `diff`; native-completeness
  caveat; graceful degrade when the secondary revisions fetch fails.
- **specs/commands/docs-diff.md** — `docs diff <fileId> <revA> [revB]`, revB→head default,
  `document`/`from`/`to`/`summary`/`diff` output, `--full`/`--out`, fidelity disclosure,
  `NON_NATIVE_DOCUMENT` / `REVISION_NOT_FOUND` / `EXPORT_FORMAT_REQUIRED` / `VALIDATION_ERROR`.
- **specs/commands/drive-revisions.md** — out-of-scope diff line now points at `docs diff`.
- **specs/principles.md** — new `provenance-by-default` principle (overrides
  minimal-default-schemas for provenance fields on content reads).

## Approach

Three commits, lowest-risk first.

1. **Extract a shared revision-export helper.** `docs download --revision` (in
   `src/commands/docs/download.ts`, `downloadRevision`) already resolves a revision's
   `exportLinks`, picks markdown (fallback `text/plain`), and does the authenticated GET.
   Lift the markdown-export-of-a-revision logic into a shared helper (e.g.
   `src/commands/docs/revision-content.ts` → `exportRevisionMarkdown(account, fileId, revisionId)`
   returning `{markdown, modified, author}`), and a shared recent-revisions fetch
   (`listRecentRevisions(account, fileId, limit)`) factored from `src/commands/drive/revisions.ts`.
   Refactor `download.ts` to use it — no behavior change; tests stay green.

2. **`docs read` inline revisions.** In `src/commands/docs/read.ts`, after the
   `documents.get`, call `listRecentRevisions(account, documentId, 5)` wrapped in
   try/catch. On success render the `revisions[N]` list (reuse `drive revisions`'
   minimal schema) + completeness caveat help line; on failure push a
   `revisions: history unavailable` note + a `drive revisions` help line. Add the three
   version-history `help[]` suggestions (interpolating the newest listed revision id into
   the `download --revision` / `diff` examples). Update `READ_HELP` output description.

3. **`docs diff` command.** New `src/commands/docs/diff.ts`: parse `<fileId> <revA> [revB]`
   - `--full`/`--out`/`--account`; `files.get` to reject non-native (`NON_NATIVE_DOCUMENT`);
   default revB to head (newest from `listRecentRevisions`/`revisions.list`); export both
   sides via `exportRevisionMarkdown`; compute a unified diff. Add a small diff dependency
   (`bun add diff`, well-established, types via `@types/diff`) and use `createTwoFilesPatch`/
   `structuredPatch` for the unified body + add/remove line counts. Register `diff` in the
   `docs` dispatcher (`src/commands/docs.ts`) and add `DIFF_HELP`. Note: `docs` will need a
   real `--help` router entry for `diff` (see CLAUDE.md note on COMMAND_HELP).

Each commit: implement → `bun run build` → `bun run test` → add/extend tests.

## Validation

- [x] `docs read <nativeDoc>` inlines `revisions[N]{id,modified,author}` (≤5, newest first)
      by default with untruncated ids, plus a native-completeness caveat line.
- [x] `docs read` `help[]` includes runnable `docs revisions`, `docs download --revision <id>`,
      and `docs diff <id> <revA> <revB>` suggestions with a real revision id interpolated.
- [x] When the revisions fetch fails, `docs read` still returns content with a
      `revisions: history unavailable`-style note (read never fails on the secondary call).
- [x] `docs read` still marks nothing read (read-only preserved; revisions.list is a read).
- [x] `docs diff <fileId> <revA> <revB>` emits `document`/`from`/`to`/`summary`/`diff`
      with a unified diff of the two markdown exports; identical exports → `summary.changed=false`
      and `diff: no differences`.
- [x] `docs diff <fileId> <rev>` (revB omitted) diffs that revision against head.
- [x] `docs diff` respects argument order (no chronological reordering); `--full`/`--out`
      behave like `docs read` (cap 8000, save full to file).
- [x] `docs diff` carries the markdown-export fidelity caveat in help/notes.
- [x] Error paths: non-native → `NON_NATIVE_DOCUMENT`; bad revision → `REVISION_NOT_FOUND`;
      missing markdown export → `EXPORT_FORMAT_REQUIRED`; missing revA → `VALIDATION_ERROR`.
- [x] `docs diff --help` routes to `DIFF_HELP` (dispatcher wired; not shadowed by COMMAND_HELP).
- [x] `bun run build` clean; `bun run test` green incl. new specs for read-inline shape,
      diff output shape, revB-default, argument-order, and error translation.
- [x] CLAUDE.md "Current implementation status" updated; spec-drift auditor run and findings resolved.

## Risks / unknowns

- **Extra API call on every `docs read`.** Mitigated: best-effort + graceful degrade, minimal
  fields, capped at 5. The token/latency cost is the deliberate price of `provenance-by-default`.
- **New `diff` dependency** — confirmed: add the `diff` npm package (small, ubiquitous,
  Node-safe) rather than hand-rolling an LCS diff. Consumers run under Node, so avoid bun-only APIs.
- **`exportLinks` markdown absence** on some revisions — same fallback chain as `docs download`
  (`text/plain`, then `EXPORT_FORMAT_REQUIRED`).
- **`docs` dispatcher / `--help` routing** — adding a real subcommand help path for `diff` must
  follow the Calendar precedent (service kept out of `COMMAND_HELP` in `src/cli.ts`).

## Notes

- Verified live against a real multi-tab Doc (`ARC AI Strategy: Running
  Minutes`): `docs read` inline `revisions[4]` block + help funnel; `docs diff`
  two-revision diff, `revB`→head default, identical-revision `changed:false`,
  `REVISION_NOT_FOUND`, `VALIDATION_ERROR`, and `docs diff --help` routing.
- **Not triggered live** (ride the shared, behavior-preserving
  `fetchNativeRevisionExport` path that `docs download --revision`'s existing
  tests cover): `NON_NATIVE_DOCUMENT` (test doc was native) and
  `EXPORT_FORMAT_REQUIRED` (markdown export was available). Both are simple,
  unit-reasoned branches.
- The multi-line `diff` value renders with escaped `\n` via `renderObject`,
  consistent with how `docs read` renders its `content` block (same path).
- Added the `diff` npm package (+ `@types/diff`) — first non-Google runtime
  dep of this kind; confirmed with the maintainer before adding.
- Spec-drift audit run before closeout: 0 unimplemented items, no behavior
  bugs; all findings were spec-wording clarifications, resolved by tightening
  the specs to the shipped (correct) behavior.

## Follow-ups

- Deferred to [`drive-upload-inline-content`](drive-upload-inline-content.md) —
  upload from stdin/`--content` (no temp file). Plan authored in this branch;
  scope + validation absorb the work.
- Deferred to [`drive-upload-update-convert`](drive-upload-update-convert.md) —
  allow `--convert` + `--update` so an existing native Doc's content can be
  replaced from markdown as a new revision (closes the read→edit→write-back
  loop). Plan authored in this branch; scope + validation absorb the work.
- **None required** for the two error paths not triggered live
  (`NON_NATIVE_DOCUMENT`, `EXPORT_FORMAT_REQUIRED`) — they ride the shared
  `fetchNativeRevisionExport` path covered by `docs download`'s tests.
