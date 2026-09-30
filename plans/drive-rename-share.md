---
status: in-progress
depends: []
specs:
  - specs/commands/drive-rename.md
  - specs/commands/drive-share.md
---

# Plan: drive rename, share, and unshare

## Scope

Implement the `drive rename` stub, and add `drive share` / `drive unshare` for named people and
groups. Requested by a teammate session to rename and share folders under a shared root, on the
owner's instruction; confirmed with the owner before starting.

**Out of scope:** public and domain-wide sharing (refused by design), ownership transfer,
expiring access, `move` / `copy` / `delete`.

## Implements

- `specs/commands/drive-rename.md`, `specs/commands/drive-share.md` — all of both.

## Approach

1. `src/commands/drive/rename.ts`: read the current name; same → `unchanged`; else
   `files.update` with `name` only.
2. `src/commands/drive/share.ts`: address parsing and the public-sharing refusal; role
   validation; per-address: list permissions, then create,
   update, or no-op by the table in the spec; `unshare` by the same lookup, with inherited and
   owner cases reported rather than attempted.
3. Dispatcher: `rename` gets its handler; `share` and `unshare` are new, all `mutation: true`.
4. Tests for parsing, the refusal, and the per-address decision table.

## Validation

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Live, on a scratch folder in the owner's Drive, shared only with the owner's own second
      account: `share` reader → `shared`; again → `already_shared`; `--role writer` →
      `role_changed`; back to reader → `role_changed` (a downgrade that `create` would ignore);
      `unshare` → `unshared`; again → `not_shared`.
- [ ] `unshare` on a child folder reports `inherited` and removes nothing.
- [ ] `--with anyone` and `--with example.com` are refused before any call.
- [ ] `rename` → `renamed`; the same name again → `unchanged`.
- [ ] Without `--account` (2+ accounts) all three return `ACCOUNT_REQUIRED`.
- [ ] No one outside the owner's own accounts is shared with during testing.

## Risks / unknowns

- **Default notification emails the people shared with.** Intended. Testing uses `--no-notify`
  except for one run to the owner's own account.

## Notes

- Probing made the empty scratch folder public ("anyone with the link") for the instant between
  creating and deleting that permission, to confirm it is one call. Nothing was in it.

## Follow-ups
