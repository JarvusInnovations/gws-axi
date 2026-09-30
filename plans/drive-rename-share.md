---
status: done
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

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Live, on a scratch folder in the owner's Drive, shared only with the owner's own second
      account: `share` reader → `shared`; again → `already_shared`; `--role writer` →
      `role_changed`; back to reader → `role_changed` (a downgrade that `create` would ignore);
      `unshare` → `unshared`; again → `not_shared`.
- [x] `unshare` on a child folder reports `inherited` and removes nothing.
- [x] `--with anyone` and `--with example.com` are refused before any call.
- [x] `rename` → `renamed`; the same name again → `unchanged`.
- [x] Without `--account` (2+ accounts) all three return `ACCOUNT_REQUIRED`.
- [x] No one outside the owner's own accounts is shared with during testing.

## Risks / unknowns

- **Default notification emails the people shared with.** Intended. Testing uses `--no-notify`
  except for one run to the owner's own account.

## Notes

- Probing made the empty scratch folder public ("anyone with the link") for the instant between
  creating and deleting that permission, to confirm it is one call. Nothing was in it.
- **A spec claim was wrong and caught before code**: the first draft said folders can't take a
  commenter role. A probe granted it; the spec was corrected in its own commit.
- **Verified live** on a scratch folder in the owner's Drive, shared only with the owner's other
  account: every row of both decision tables, including a downgrade that `permissions.create`
  would have ignored, the inherited case on a child folder, and one run with the notification
  on — which arrived in the owner's inbox. The folder ended with only its owner.
- **Inherited roles lag.** The child still listed writer moments after the parent went to
  reader. Recorded in the spec.
- The scratch folder "gws-axi share test (safe to delete)" and its "child" remain in the owner's
  Drive; gws-axi has no delete yet.

## Follow-ups

- Tracked as: expiring access, and ownership transfer.
