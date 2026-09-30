# Command group: drive share and unshare

## Summary

Grants and removes one person's or group's access to a Drive file or folder. These are the most
consequential writes gws-axi makes: they decide who can read other people's material, and a
share can reach people outside the organization. The design follows from that.

- **Only named people and groups.** There is no way here to make anything public or shared
  across a domain.
- **The result says exactly who has what**, read back from Drive.
- **Folder shares say they cover everything inside.**

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `permissions.create` for someone who already has that role returns the existing permission and creates nothing | **Observed 2026-09-30** |
| `permissions.create` with a **higher** role upgrades the existing permission | **Observed**: reader → writer |
| `permissions.create` with a **lower** role is **ignored** — the existing, higher role stays | **Observed**: commenter requested for a writer left them a writer. So a role change goes through `permissions.update`, never `create` |
| Sharing with an address that has no Google account is refused unless a notification is sent | **Observed**: `400 invalidSharingRequest` with notifications off |
| An `anyone` permission is a single call | **Observed** (created and removed at once on an empty scratch folder). The reason `share` refuses it |
| Access inherited from a parent folder cannot be removed on the child | **Observed**: `403 cannotDeletePermission` |
| Deleting a permission that no longer exists is `404` | Observed |
| The existing `auth/drive` scope covers all of it | Observed |

## `drive share`

```
gws-axi drive share <file-id> --with <email>[,<email>…] --role <reader|commenter|writer>
                    [--group] [--no-notify] [--message <text>] [--account <email>]
```

- `--with` — one or more addresses, comma-separated or by repeating the flag. Each must be an
  email address. **`anyone`, a bare domain, or anything that isn't an address is refused** with
  `PUBLIC_SHARING_REFUSED`, which says gws-axi does not make files public or domain-wide and
  that the Drive UI can. There is no flag to override it.
- `--role` — required. `reader`, `commenter`, or `writer`. Ownership transfer is not offered.
  Drive doesn't give folders a commenter role; `--role commenter` on a folder is refused before
  any call.
- `--group` — the addresses are Google Groups rather than people.
- `--no-notify` — don't email the people shared with. **Default: notify**, because being told you
  now have access is safer than silently having it. Drive refuses `--no-notify` for an address
  without a Google account; that is reported for that address and the others proceed.
- `--message` — text for the notification email. Refused with `--no-notify`.

For each address:

| It already has | Result |
| --- | --- |
| Nothing | Access granted: `shared` |
| The requested role | Nothing changes: `already_shared` |
| A different direct role | The role is set to the requested one — up **or down** — through `permissions.update`: `role_changed`, showing both roles |
| Access only through a parent folder | A direct permission is added: `shared`. The inherited access stays, and the row notes it |

Addresses are handled one at a time. One failing doesn't stop the rest; its row says why, and the
command exits 1 if any row failed.

## `drive unshare`

```
gws-axi drive unshare <file-id> --with <email>[,<email>…] [--account <email>]
```

For each address:

| It has | Result |
| --- | --- |
| A direct permission | Removed: `unshared` |
| No access | Nothing changes: `not_shared` |
| Access only through a parent folder | Nothing changes, and the row says so: `inherited` — "remove it from the parent folder". Drive refuses the removal on the child |
| Ownership | Refused: `owner` — an owner can't be unshared |

## Output

```
account: alice@example.com
file{id,name,type}: 1AbC…,Slate — Lincoln HS,folder
results[2]{email,status,role,note}:
  lead1@lincoln.edu,shared,reader,""
  lead2@lincoln.edu,role_changed,reader,"was writer"
note: This is a folder: everything in it is shared the same way.
help[2]:
  Run `gws-axi drive permissions 1AbC…` to see everyone with access
  Run `gws-axi drive unshare 1AbC… --with lead1@lincoln.edu --account alice@example.com` to undo
```

`role` is what the address has after the command, read back from Drive.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Missing `--with` or `--role`; an unknown role; `--message` with `--no-notify`; commenter on a folder |
| `PUBLIC_SHARING_REFUSED` | `--with` names `anyone`, a domain, or anything that isn't an address |
| `FILE_NOT_FOUND` | Unknown file, or no access to it |
| `FORBIDDEN` | The account may not change sharing on this file |

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
  — both are `mutation: true`.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — inherited access
  and folder-wide reach are stated, not left for the caller to discover.
- Idempotent mutations — repeating either command changes nothing and says so.

**Local:**

- **gws-axi never makes anything public.** Sharing with "anyone with the link" or a whole domain
  is not a capability of this tool, and no flag unlocks it.

  > **Why:** The callers are agents, acting on instructions that can be mistaken or injected. A
  > named share reaches the people named; a public one reaches everyone, cannot be recalled from
  > whoever already saw it, and is one call away in Drive's API. The narrow cases that need it
  > are rare and belong to a person in the Drive UI.
- **A share never lowers or raises someone's access by accident.** The requested role is the
  role they end up with, and the output says what it was before.

  > **Why:** Drive's `permissions.create` upgrades silently and ignores downgrades silently, so a
  > naive share can leave someone with more access than the caller asked for and report success.
