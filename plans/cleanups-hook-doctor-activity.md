---
status: done
depends: []
specs:
  - specs/architecture.md
  - specs/commands/drive-activity.md
---

# Plan: three logged cleanups

## Scope

1. Specs and docs said the SessionStart hook runs `gws-axi --summary`; it runs bare `gws-axi`
   (and `gws-axi --summary` is a usage error). Corrected in `specs/architecture.md`,
   `docs/design.md`, `specs/api/conventions.md`.
2. `doctor --summary` exited 0 with failing checks; it now shares the full report's exit code.
3. `drive activity`'s `time` column printed UTC while its range echo is local; now local-offset
   ISO per conventions § Displayed times.

## Validation

- [x] `doctor --summary` exits 1 on devbox (11 failing checks — known re-auths).
- [x] `drive activity` prints `-04:00` times.
- [x] build, lint, test.

## Notes

The 11 failing checks are the known re-auths: admin@save-the-academy.org and
savetheacademy1812@gmail.com lack the Chat scopes and `directory.readonly`;
themightychris@gmail.com lacks `directory.readonly`.

## Follow-ups

None.
