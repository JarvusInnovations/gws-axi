---
status: done
depends: []
specs:
  - specs/commands/drive-upload.md
issues: []
pr: 30
---

# Plan: update a native Doc's content from markdown (`--convert` + `--update`)

## Scope

Close the read→edit→write-back round trip: let an agent replace the content of an
**existing native Google Doc** from a convertible source (markdown, docx, etc.) as
a new revision. Today `drive upload` rejects `--convert` + `--update` together
(in-place type conversion is out of scope), so there is no clean way to push edited
markdown back into the *same* Doc — the only path creates a second file.

Surfaced as a follow-up during `docs-revision-discoverability`: `docs read` exports
a Doc to markdown and `docs diff` compares revisions, but nothing writes markdown
back into an existing Doc as a new revision.

In scope: allow `--convert` with `--update <fileId>` when the target is already a
native Google file and the source converts to that same native type (markdown →
existing Doc); the spec amendment; the new-revision semantics (this is what makes
the change show up in `drive revisions` / `docs diff`). Out: changing a file's type
in place (e.g. turning a stored `.pdf` into a Doc), folder moves on update.

## Implements

- **specs/commands/drive-upload.md** — replace the blanket "`--convert` + `--update`
  is rejected" rule with: permitted when the existing file's `mimeType` is the
  native target the source converts to (else `UNSUPPORTED_CONVERSION` / a type-mismatch
  error). Document that the result is a new revision of the same fileId.

## Approach

(Detailed when picked up — spec amendment first.) Likely: on `--update` +
`--convert`, `files.get` the target's `mimeType`; if it equals
`googleConversionTarget(sourceMime)`, issue `files.update` with `media` as the source
bytes and no `requestBody.mimeType` change (Drive converts the media into the
existing native type, creating a new revision); otherwise structured error. Reuse
`googleConversionTarget` from `src/util/mime-types.ts`.

## Validation

- [x] `gws-axi drive upload edited.md --convert --update <docId>` replaces the Doc's
      content and produces a new revision (visible in `drive revisions <docId>`).
- [x] Source/target type mismatch (e.g. markdown source, existing Sheet) → structured error.
- [x] Non-native `--update` target with `--convert` → clear error (no silent type change).
- [x] Existing `--update` (no convert) and `--convert` (no update) behavior unchanged.
- [x] `bun run build` clean; `bun run test` green incl. new tests.

## Risks / unknowns

- Whether Drive's `files.update` with mismatched media + native type behaves as a
  clean conversion-to-revision in all cases — verify against a real Doc.
- Round-trip fidelity: markdown → Doc → markdown is lossy; the round trip is for
  content edits, not byte-faithful preservation (consistent with docs-diff's
  relevance-not-forensics stance).

## Notes

- Shipped in PR #30 alongside [`drive-upload-inline-content`](drive-upload-inline-content.md).
- Confirmed live that `files.update` with source media + the file's native
  `mimeType` produces a clean conversion-to-new-revision (resolved the open
  risk): a markdown `--content` update bumped a Doc 1→2 revisions with replaced
  content, and the prior revision is fetchable via `docs download --revision` /
  `docs diff`.
- The legality check (target must already be the matching native type) lives in
  the command, not the pure `validateFlags`, because it needs a `files.get`.
- **Not triggered live:** the non-native-target branch (binary file + `--convert
  --update`) — no binary target on hand; it rides the same `files.get` type
  check as the verified mismatch case (csv→Sheet onto a Doc, which *was* live-
  rejected).

## Follow-ups

- **None.** Changing a file's *type* in place (binary→native, or one native
  type→another) stays out of scope, documented in the spec.
