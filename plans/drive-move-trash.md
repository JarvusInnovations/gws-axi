---
status: done
depends: []
specs:
  - specs/commands/drive-move-trash.md
issues: [70]
pr: 89
---

# Plan: drive move, trash, untrash

## Scope

Item 1 of #70: `drive move --to`, `drive trash`, `drive untrash`. `drive delete` stays a stub
pointing at `trash`. Items 2–4 of #70 (`gmail draft --attach`, sent-thread fields, upload
revision id) are separate.

## Implements

- `specs/commands/drive-move-trash.md`

## Approach

1. `src/commands/drive/move.ts`: flag parsing via the shared `parseArgs`; preflight reads;
   ancestor walk for folders; `files.update`.
2. Same file: `trash` / `untrash` with the idempotent reads.
3. Dispatcher entries, `delete`'s `instead[]` → `trash`, help, README, CLAUDE.md.

## Validation

- [x] Unit: flag parsing; ancestor-walk refusal; idempotent actions from stubbed reads.
- [x] Live (scratch folder): move a file into a subfolder and back; `unchanged` on a repeat;
      `NOT_A_FOLDER`; `MOVE_INTO_SELF` for the scratch folder into its child; trash and untrash
      a file; `already_trashed`; trash a folder and `TRASHED_WITH_FOLDER` on its child.
- [x] build, lint, format:check, test.

## Risks / unknowns

- Shared-drive moves change ownership and need organizer rights; errors pass through translated.

## Notes

- Probed before the spec: `addParents` without `removeParents` silently moves rather than
  adding a parent; a non-folder target is a 403 with a clear message; a folder into its own
  child is a bare 400, which is why the ancestor walk exists; a trashed folder's contents
  read `trashed` only after a few seconds.
- Verified live in the scratch folder: move into the child and back with the undo line,
  `unchanged` on repeat, `NOT_A_FOLDER`, `MOVE_INTO_SELF` (the scratch folder into its own
  child), trash / `already_trashed` / restore / `not_trashed`, folder trash then
  `TRASHED_WITH_FOLDER` on its child, and the `delete` stub pointing at `trash`.
- The scratch folder had no other collaborators, so the inherited-access change on a move was
  not observed live; it rests on Drive's documented behavior and the drive-share findings.

## Follow-ups

- Issue: #70 items 2–4 remain — `gmail draft --attach`, sent-thread date/size fields, and
  `drive upload --update` printing the revision id.
- Tracked as: the shared `notImplemented` helper says "not yet implemented / planned surface"
  even for `drive delete`, which is not planned; a "not offered" variant would read better.
