# Command group: drive move, drive trash, drive untrash

## Summary

Filing verbs for Drive, from issue #70: an agent that iterates on a working copy and then files
it as the record copy needs to **move** it, and an agent that made something in the wrong place
needs to **trash** it. Both are `files.update` calls under the existing `drive` scope.

- **`drive move <id> --to <folder-id>`** puts a file or folder in another folder.
- **`drive trash <id>`** moves it to the trash, where Drive keeps it for 30 days.
- **`drive untrash <id>`** restores it.

Permanent deletion stays out of scope: `drive delete` remains scaffolded and points at `trash`.

## Invocation

```
gws-axi drive move    <file-id> --to <folder-id> [--account <email>]
gws-axi drive trash   <file-id> [--account <email>]
gws-axi drive untrash <file-id> [--account <email>]
```

One item per invocation. `--to root` names My Drive's root.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `files.update` with `addParents` and `removeParents` moves an item, keeping its id | **Observed 2026-10-02** |
| A My Drive item has exactly one parent: `addParents` alone *moves* it rather than adding a second parent, with no error | Observed |
| A move whose target is a file, not a folder, is a 403 "The specified parent is not a folder." | Observed |
| Moving a folder into its own subfolder is a bare 400 "Bad Request" | Observed — so the command checks first and says why |
| `files.update` with `trashed: true` / `false` trashes and restores; `trashed` and `explicitlyTrashed` read back | Observed |
| Trashing a folder trashes its contents, which read `trashed: true, explicitlyTrashed: false` — after a few seconds' lag | Observed: still untrashed when read immediately, trashed 4s later |
| A trashed item keeps its parent, and can be moved while trashed (it stays trashed) | Observed |
| Access inherited from a folder follows the folder: after a move, the item inherits from its new folder instead | Documented; see [drive-share.md](drive-share.md) for inherited-role lag |

## `drive move`

- Reads the item (`id,name,mimeType,parents,trashed`) and the target (`id,name,mimeType`) first.
  A target that is not a folder is `NOT_A_FOLDER`; nothing moves.
- **Idempotent**: an item already in the target folder is `action: unchanged`, no write.
- Otherwise `files.update` with `addParents: <to>`, `removeParents: <every current parent>`.
- A folder cannot go into itself or anything beneath it: the target's ancestors are walked
  (`parents` up to the root, at most 20 levels) before the write, and a hit is
  `MOVE_INTO_SELF`.
- A trashed item can be moved and stays trashed; the output says so.

Output:

```
account: alice@example.com
action: moved
file{id,name,mime_type,from,to}: 1AbC…,Response v3.docx,application/vnd…,1Root…,1Sub…
help[3]:
  Access inherited from the old folder no longer applies; the item now inherits from Submitted Volumes — check with `gws-axi drive permissions 1AbC…`
  Run `gws-axi drive ls 1Sub…` to see the folder
  Run `gws-axi drive move 1AbC… --to 1Root… --account alice@example.com` to undo
```

`from` and `to` are folder ids; `to` comes with the folder's name in the access line, since the
move's side effect on sharing is the thing a reader can miss.

## `drive trash` and `drive untrash`

- **Idempotent**: trashing a trashed item is `action: already_trashed`; untrashing one that is not
  in the trash is `action: not_trashed`. No write either way.
- `trash` on a folder says its contents go with it.
- `untrash` on an item that is in the trash only because its folder is
  (`trashed: true, explicitlyTrashed: false`) is `TRASHED_WITH_FOLDER`, naming the folder to
  restore instead — restoring the one item would pull it out of the folder's undo.
- Help on `trash` gives the `untrash` command and says Drive empties the trash after 30 days.

Output: `action` (`trashed` | `already_trashed` | `restored` | `not_trashed`) and
`file{id,name,mime_type}`.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | No id, more than one, or `move` without `--to` |
| `FILE_NOT_FOUND` | The item or the target folder is unknown or not visible to the account |
| `NOT_A_FOLDER` | `--to` names a file |
| `MOVE_INTO_SELF` | `--to` is the folder itself or beneath it |
| `TRASHED_WITH_FOLDER` | `untrash` on an item trashed by its folder |
| `FORBIDDEN` (translated) | No edit access; the suggestion says moving and trashing need it |

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account) — `mutation: true`.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — every change carries
  its undo command.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — the sharing side
  effect of a move and the contents of a trashed folder are stated, not left to be discovered.

**Local:**

- **Trash, never destroy.** gws-axi's delete verb is `trash`: reversible for 30 days, by
  `untrash`. A permanent delete would be the only Drive write an agent could not take back, and
  nothing in the filing workflow needs one.
