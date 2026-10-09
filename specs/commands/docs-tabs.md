# Command group: docs tabs, docs tabs update, docs tabs delete

## Summary

Manage a Doc's tabs as objects: list them, change one's position, parent, title or emoji, or
delete one. From issue #101, whose motivating workflow is **regenerate per round**: an agent
writes each new draft into a fresh tab so earlier rounds and the comments on them survive, and
readers must land on the newest round when they open the Doc. The placement flags here are
the same ones `docs write --new-tab` takes ([docs-write.md](docs-write.md) § Placing a new
tab), so an agent learns one vocabulary for "where does this tab go".

No new scope: the existing `documents` grant covers `documents.get` and every tab request in
`documents.batchUpdate`.

## Invocation

```
gws-axi docs tabs <documentId>
gws-axi docs tabs update <documentId> <tabId> [--title <title>] [--emoji <emoji> | --no-emoji]
                                              [--first | --last | --before <tabId> | --after <tabId>]
                                              [--under <tabId> | --top-level]
gws-axi docs tabs delete <documentId> <tabId> [--with-children]
```

Tabs are addressed by id as `docs read` and `docs tabs` list them (`t.0`, `t.abc…`) — never by
title, which is not unique ([ids-are-first-class](../principles.md#ids-are-first-class)).

## Upstream behavior relied on

Every row was observed live on scratch Docs before this spec was written.

| Fact | Status |
| --- | --- |
| `updateDocumentTabProperties` with a `fields` mask updates `title`, `iconEmoji`, `index` and `parentTabId`; these four are the complete set of mutable tab properties | Observed 2026-10-08 |
| `index` is zero-based **within the parent** and means "insert before the tab currently at this position": on `[A,B,C,D]`, A→1 is a no-op, A→3 gives `[B,C,A,D]`, A→4 (= count) gives `[B,C,D,A]` | Observed |
| An index greater than the sibling count is a 400 (`Index must be less than or equal to the number of unnested tabs`) | Observed |
| `parentTabId` in the mask with no value moves a child tab to the end of the top level; combined with `index` it lands at that position | Observed |
| Nesting a tab under one of its own descendants is a 400 (`Cannot move a parent tab to be nested under one of its own child tabs`) | Observed |
| `iconEmoji` in the mask with no value clears the icon; a string that is not exactly one emoji is a 400 (`Not a valid emoji input`) | Observed |
| An empty `title` is a 400 | Observed |
| `deleteTab` removes the tab **and its child tabs**; deleting a Doc's only tab is a 400 (`Cannot delete the only tab in a document`) | Observed |
| An unknown tab id in either request is a 400 naming the id | Observed |
| A property update that changes nothing returns 200 with an empty reply — nothing upstream reports "unchanged" | Observed |
| `addDocumentTab` accepts `index`, `parentTabId` and `iconEmoji` alongside `title` | Observed |

## Behavior

### `docs tabs <documentId>` (read)

Lists every tab, depth-first in document order, with properties only — no content is fetched,
so this is cheap on a long Doc where `docs read` would render a tab's body. The id is the
value every other command takes.

### `docs tabs update` (write)

One `documents.get` for the tab tree and `revisionId`, then one `updateDocumentTabProperties`
whose field mask is exactly the properties the flags name, under
`writeControl.requiredRevisionId` from the read.

**Placement** — at most one of `--first`, `--last`, `--before <tabId>`, `--after <tabId>`:

- `--first` / `--last` — within the tab's current parent, or within `--under <tabId>` /
  the top level with `--top-level` when given.
- `--before X` / `--after X` — the position adjacent to `X`, **in `X`'s parent**: these
  also nest or un-nest when `X` is at another level. Cannot be combined with `--under` or
  `--top-level` (the anchor decides the parent).
- `--under <tabId>` alone — last child of that tab. `--top-level` alone — last at the top
  level.
- Index sent: `--first` → 0; `--last` → the destination parent's sibling count, counting the
  tab itself when it is already there (on `[A,B,C,D]`, A→4 is what puts A last);
  `--before X` → `X.index`; `--after X` → `X.index + 1`. No further adjustment — see the
  upstream table.

**Title** — `--title <title>`; empty is a `VALIDATION_ERROR` before any call.

**Emoji** — `--emoji <emoji>` sets the icon; `--no-emoji` clears it; both together is a
`VALIDATION_ERROR`. The value is passed through — Google decides what is one emoji — and its
refusal is translated to `INVALID_EMOJI`.

**Idempotent**: the desired state is compared with the read state before writing. When every
named property already holds (same title, same emoji, and the placement already describes the
tab's current position), nothing is sent, `action: unchanged`, exit 0. When some do and some
do not, only the differing fields go in the mask. No flags at all is a `VALIDATION_ERROR`
listing the flags — never a prompt.

**Order and anchors are resolved locally** from the read: an unknown target or anchor is
`TAB_NOT_FOUND` naming which one, and `--under`/`--before`/`--after` pointing at the tab
itself or one of its descendants is `TAB_CYCLE` — both before any write. Depth is capped by
the three-level fetch; a target at depth 4+ is reported as not found, which the listing makes
visible.

### `docs tabs delete` (write)

One `documents.get`, then one `deleteTab` under `writeControl.requiredRevisionId`.

- A tab with child tabs is refused with `TAB_HAS_CHILDREN`, naming them, unless
  `--with-children` is passed — the API deletes them silently, and a tab's children are not
  something the caller necessarily saw.
- A Doc always keeps at least one tab: the only tab, or a parent whose subtree is every tab
  in the Doc, is `LAST_TAB`; the suggestion is `docs write <id> --tab <tabId> --content ""`
  to empty it, or `drive trash <id>` for the whole Doc.
- An unknown id is `TAB_NOT_FOUND`, naming the available ids. It is **not** a no-op: a tab
  that was already deleted and a mistyped id look the same, and the mistyped id is the
  likelier one.
- The content is gone from the live Doc but remains in version history; the response says
  so and points at `docs revisions`.

## Output

### `docs tabs`

```
account: alice@example.com
document:
  id: 1BxAbc…
  title: Roadmap
  revision_id: ALBJ4Lt…
tabs[4]{id,title,index,parent,emoji}:
  t.0,Round 3,0,,📝
  t.k3j2,Round 2,1,,
  t.9pq1,Appendix,2,t.k3j2,
  t.m4ws,Round 1,2,,✅
help[3]:
  Run `gws-axi docs read 1BxAbc… --tab <id>` to read one
  Run `gws-axi docs tabs update 1BxAbc… <id> --first|--title "<title>"|--emoji <emoji> --account <email>` to move, rename or mark a tab
  Run `gws-axi docs tabs delete 1BxAbc… <id> --account <email>` to delete one
```

`tabs[N]{id,title,index,parent,emoji}` — `docs read`'s listing without `active`, plus
`emoji` (empty when none). `index` is the position within `parent`; `parent` is empty at the
top level. A single-tab Doc lists its one tab; the listing never collapses to the empty shape
because a Doc always has at least one tab.

### `docs tabs update`

```
account: alice@example.com
action: updated
changed[2]: index, title
tab:
  id: t.m4ws
  title: Round 4
  index: 0
  parent:
  emoji: 📝
revision_id: ALBJ4Lu…
tabs[4]{id,title,index,parent,emoji}:
  …
help[2]:
  Run `gws-axi docs read 1BxAbc… --tab t.m4ws` to read it
  Run `gws-axi docs tabs update 1BxAbc… t.m4ws --after t.0 --title "Round 3 (old)" --account alice@example.com` to undo
```

`action` is `updated` or `unchanged`. `changed[]` names the properties written (`index`,
`parent`, `title`, `emoji`); omitted when unchanged. `tab{}` is the tab's state after the
call, `revision_id` the head revision after it ([provenance-by-default](../principles.md#provenance-by-default)),
and `tabs[N]` the whole listing afterwards so a move is confirmed without a second read. The
undo line restores exactly the properties this call changed: the previous title/emoji, and
the previous position as `--after <previous predecessor>` or `--first` (with `--under`/
`--top-level` when the parent changed).

### `docs tabs delete`

```
account: alice@example.com
action: deleted
deleted[2]{id,title}:
  t.k3j2,Round 2
  t.9pq1,Appendix
revision_id: ALBJ4Lv…
tabs[2]{id,title,index,parent,emoji}:
  …
help[2]:
  The content is out of the live Doc but stays in version history: `gws-axi docs revisions 1BxAbc…`
  Run `gws-axi docs tabs 1BxAbc…` to list what remains
```

`deleted[N]` lists the tab and every descendant removed with it, the tab first.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Missing id; unknown subcommand or flag; two placement flags; `--under`/`--top-level` with `--before`/`--after`; `--emoji` with `--no-emoji`; empty `--title`; `update` with no property flags |
| `DOCUMENT_NOT_FOUND`, `NON_NATIVE_DOCUMENT` | As `docs write` |
| `TAB_NOT_FOUND` | The target, or a `--before`/`--after`/`--under` anchor, names no tab; says which and names the available ids. Nothing is written |
| `TAB_CYCLE` | `--under`, `--before` or `--after` points at the tab itself or one of its descendants. Nothing is written |
| `TAB_HAS_CHILDREN` | `delete` without `--with-children` on a tab that has child tabs; names them |
| `LAST_TAB` | `delete` that would leave the Doc with no tab: its only tab, or a parent whose subtree is every tab |
| `INVALID_EMOJI` | Google refused the `--emoji` value |
| `DOCUMENT_CHANGED` | The Doc's revision moved between the read and the write; nothing written |

All Google failures pass through `translateGoogleError`.

## Dispatcher

`docs tabs` is a read (`mutation: false`); `docs tabs update` and `docs tabs delete` are
writes, each with its own flag declaration and `--help`, resolved as two-word subcommands by
the `docs` dispatcher so write protection applies to exactly the two that write.

## Out of scope

- **Creating an empty tab.** `docs write <id> --new-tab <title> --content ""` does it; a
  verb for it would be a second spelling of the same call.
- **Retitling a new Doc's first tab from `docs create`.** `docs tabs update <id> t.0 --title`
  afterwards; add a flag to `create` when someone asks.
- **A tab's content.** `docs read --tab` / `docs write --tab`.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
  — `update` and `delete` are `mutation: true`; the listing is not.
- [ids-are-first-class](../principles.md#ids-are-first-class) — tabs and anchors by id only.
- [provenance-by-default](../principles.md#provenance-by-default) — `revision_id` after every
  write.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — the undo line
  names exactly what changed; the delete response points at version history.
- [fail-loud-on-unknown-flags](../principles.md#fail-loud-on-unknown-flags) — per-subcommand
  declarations.

**Local:**

- **A move shows the order it produced.** Every `update` and `delete` response carries the
  full `tabs[N]` listing after the write.

  > **Why:** the point of reordering is where the tab ended up, and nothing upstream reports
  > it — the reply is empty. Without the listing the agent's next call is always a read.

- **Collateral deletion is named, never implied.** Children go only with `--with-children`,
  and the response lists every tab removed.

  > **Why:** `deleteTab` takes a subtree silently. The same rule as `--replace-all-tabs` on
  > `drive upload`: a flag spells out the extra loss, and the output records it.
