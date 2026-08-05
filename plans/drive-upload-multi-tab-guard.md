---
status: done
depends: [drive-upload-update-convert]
specs:
  - specs/commands/drive-upload.md
issues: []
pr: 46
---

# Plan: guard `drive upload --update` against silently collapsing a multi-tab Doc

## Scope

`drive upload --update <docId>` replaces a native Doc's content wholesale. Drive's
import produces a **single-tab** document, so pushing content over a multi-tab Doc
destroys every tab but the first — silently, with no signal in the output.

This is the sharp edge of an asymmetry: `docs read` is tab-aware to the point of
*refusing* to render a multi-tab doc without `--tab`, while the only write path is
tab-blind. The natural read→edit→write-back loop (`docs read --tab X` → edit →
`drive upload --convert --update`) therefore silently discards the tabs the agent
never read.

In scope: a tab-count preflight on `--update` when the target is a native Doc, a
`--replace-all-tabs` opt-in that acknowledges the collapse, disclosure in the
success output when a collapse actually happened, and the spec amendment. Out:
writing to a *specific* tab, adding tabs, or preserving tab structure through an
upload — all of those need Docs `batchUpdate`, not Drive media (see Follow-ups).

## Verified behavior (live, before implementing)

Against a scratch 3-tab Doc (`docs read` → `tab_count: 3`):

- `drive upload --content … --convert --update <docId>` → the Doc came back with
  `tabs[1]`, only `t.0` surviving; the content of "Tab Two" / "Tab Three" was gone.
- The **same collapse happens without `--convert`** — Drive converts the media
  implicitly on a native target. So the guard cannot live in the `--convert`
  branch; it must cover every `--update` whose target is a Doc.
- The pre-update revision does retain the lost content: `docs download --revision 7`
  returned all three tabs' text (flattened into `#` headings by the markdown
  export — content recoverable, tab *structure* only via the editor's version
  history).
- `documents.get` with `includeTabsContent: true` + a `fields` mask over
  `tabProperties`/`childTabs` returns the tab tree in ~200 bytes, so the preflight
  is cheap even on a large doc.

## Implements

- **specs/commands/drive-upload.md** — new `--replace-all-tabs` flag; the
  `--update` preflight section gains the Doc tab-count rule; `MULTI_TAB_TARGET`
  in Errors; the collapse disclosure in Display Rules.

## Approach

1. `--replace-all-tabs` added to `ParsedFlags` / `parseFlags`; `validateFlags`
   rejects it without `--update` (pure, unit-testable).
2. The `files.get` preflight moves out of the `flags.update && flags.convert`
   branch to run on **every** `--update` (it already had to run for convert; the
   non-convert path needs the target's mimeType now too).
3. When the target's mimeType is `application/vnd.google-apps.document`, count its
   tabs via a new shared helper (`src/commands/docs/tabs.ts`). >1 and no
   `--replace-all-tabs` → `MULTI_TAB_TARGET` naming the count, listing the tab
   titles, and pointing at both the opt-in and `docs read --tab`.
4. On a completed collapse, a `help[]` line states how many tabs were replaced and
   where the prior version lives ([surface-completeness-limits]).

## Validation

- [x] Multi-tab Doc + `--update` (with and without `--convert`) → `MULTI_TAB_TARGET`,
      document unmodified (re-read after both refusals: still `tab_count: 3`).
- [x] Same call + `--replace-all-tabs` → succeeds, output discloses the collapse
      ("Replaced 3 tabs with a single imported tab …").
- [x] Single-tab Doc `--update` → unchanged behavior, no extra friction.
- [x] Nested child tabs count toward the total — live fixture was 2 root tabs +
      1 child and reported `has 3 tabs`.
- [x] `--replace-all-tabs` without `--update` → `VALIDATION_ERROR`.
- [x] Non-Doc `--update` target (a `text/plain` file) skips the tab preflight;
      a missing target still yields `FILE_NOT_FOUND` from the new preflight.
- [x] `bun run build` clean; `bun run test` green (208 tests) incl. new tests.

## Risks / unknowns

- The preflight adds a `files.get` to every `--update`, including binary ones that
  previously went straight to `files.update`. Accepted: one metadata call against
  a silent data-loss class, and it improves the not-found error for those targets.
- Tab counting masks three nesting levels; a hypothetical deeper tree would
  undercount the *reported* number but cannot change the >1 verdict (any deep
  child implies ≥2 tabs above it), so the guard stays sound.

## Follow-ups

- **Sheets has the identical hazard, unguarded**: `--convert --update` of a CSV
  over a multi-sheet Spreadsheet collapses it the same way. Same shape of fix,
  different API for the count — deliberately not bundled here.
- **Tab-targeted writes** (`docs append --tab`, adding a tab) need Docs
  `batchUpdate`; `Schema$AddDocumentTabRequest` and per-request `tabId` locations
  do exist in the API, so the deferred `docs` write surface can reach tabs
  properly — this guard is the stopgap until it does.
