---
status: in-progress
depends: []
specs:
  - specs/commands/drive-move-trash.md
issues: [70]
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

- [ ] Unit: flag parsing; ancestor-walk refusal; idempotent actions from stubbed reads.
- [ ] Live (scratch folder): move a file into a subfolder and back; `unchanged` on a repeat;
      `NOT_A_FOLDER`; `MOVE_INTO_SELF` for the scratch folder into its child; trash and untrash
      a file; `already_trashed`; trash a folder and `TRASHED_WITH_FOLDER` on its child.
- [ ] build, lint, format:check, test.

## Risks / unknowns

- Shared-drive moves change ownership and need organizer rights; errors pass through translated.

## Notes

_Populated at closeout._

## Follow-ups

_Populated at closeout._
