# Command: drive rename

## Summary

Changes a Drive file's or folder's name. Content, location, sharing, and id are untouched.

## Invocation

`gws-axi drive rename <file-id> --name <new-name> [--account <email>]`

- `<file-id>` — a file or folder id.
- `--name` — the new name, exactly as it should read. Required, and not blank.
- `--account` — required with 2+ accounts, unless `GWS_AXI_ACCOUNT` pins the session.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `files.update` with only `name` in the body renames and changes nothing else | **Observed 2026-09-30** on a folder |
| The existing `auth/drive` scope covers it | Observed |

## Behavior

- **Idempotent.** A file that already has that name is `action: unchanged`, exit 0, with no
  write.
- Works in shared drives (`supportsAllDrives`).
- Drive allows duplicate names in a folder; renaming to a name a sibling already has is allowed,
  and the output does not claim otherwise.

## Output

```
account: alice@example.com
action: renamed
file{id,name,previous_name,mime_type}: 1AbC…,Slate — Lincoln HS,Slate — school 3,application/vnd.google-apps.folder
help[2]:
  Run `gws-axi drive get 1AbC…` for its details
  Run `gws-axi drive rename 1AbC… --name "Slate — school 3" --account alice@example.com` to undo
```

## Errors

- Missing or blank `--name` → `VALIDATION_ERROR`.
- Unknown file or no access → `FILE_NOT_FOUND`, as `drive get`.
- No permission to edit → the translated `FORBIDDEN`, with a note that renaming needs edit
  access.

## Principles

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
  — `mutation: true`.
- Idempotent mutations — renaming to the current name is a reported no-op.
