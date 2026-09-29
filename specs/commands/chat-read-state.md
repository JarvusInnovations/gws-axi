# Command group: chat read state (`mark-read`, `mark-unread`)

## Summary

Changes whether a Google Chat conversation appears read or unread for the authenticated account.
Both commands are **writes**: they change what the account's owner sees in Chat, and an agent
that marks a conversation read can hide a message from the person it was meant for.

Reading a conversation with [`chat messages`](chat-read.md#chat-messages) never changes read
state ([read-only-stays-read-only](../principles.md#read-only-stays-read-only)).

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| A conversation's read state is one `lastReadTime`; it appears unread when that time precedes the latest message | **Observed 2026-09-29**: moving it before a message made that message match an unread search |
| Setting `lastReadTime` past the latest message is coerced to the latest message's time | **Observed**: set to the current time, returned as the latest message's create time |
| Conversation read state covers the top-level conversation only; thread replies are tracked separately | **Observed**: with the read position moved before both a message and its thread reply, an unread search returned only the top-level message |
| Thread read state can be read but **not written** through the REST API | Documented (no update method exists) |
| Writing read state requires the `chat.users.readstate` scope | Documented |

## `chat mark-read`

`gws-axi chat mark-read <space> [<space>…] [--account <email>]`

Marks each named conversation read up to its latest message.

```
account: alice@example.com
action: marked_read
results[2]{space,name,status,last_read}:
  AAAAxyz,Transit Data,marked_read,2026-09-28T10:02:41-04:00
  BBBBabc,Bob Tran,already_read,2026-09-27T15:40:00-04:00
note: Thread replies are tracked separately and are not affected.
```

- A conversation already read is a no-op reported as `already_read`; the command exits 0.
- `action` reports the outcome, not the command: `marked_read` when any conversation changed,
  `no_change` when none did. The same holds for `mark-unread`.
- `last_read` is the value **read back from the response**, not the value requested.
- Several conversations are processed independently. One failing does not stop the rest: its row
  carries `status: failed` and a `reason` column appears, and the command exits non-zero only
  if any row failed. A failure that would repeat for every conversation — a missing scope, an
  invalid token — stops the command instead of filling the table with it.

## `chat mark-unread`

`gws-axi chat mark-unread <space> (--from <messageId> | --at <time>) [--account <email>]`

Marks one conversation unread from a point.

- `--from <messageId>` — that message and everything after it appear unread.
- `--at <time>` — everything after that moment appears unread. `--at` names a single moment,
  so it is parsed literally and is not a range flag
  ([conventions.md § Time ranges](../api/conventions.md#time-ranges)).
- Exactly one of the two is required. There is no default point: "mark unread" with no anchor
  would have to guess how far back to go.
- A point at or after the current read position changes nothing and is reported as
  `status: already_unread_from_earlier`, exit 0.

## Thread read state is not writable

The REST API exposes no way to write a thread's read state, so neither command accepts
`--thread`. Every response carries the `note` shown above, because a conversation marked read may
still show unread thread replies in Chat and the caller must not conclude the command failed.

## Errors

`SPACE_NOT_FOUND`, `SCOPE_MISSING`, `ACCOUNT_REQUIRED`, and
`VALIDATION_ERROR`, as specified in [chat-read.md § Errors](chat-read.md#errors). `mark-unread
--from` naming a message not in the conversation is `MESSAGE_NOT_FOUND`.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
  — both commands are `mutation: true`.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — the thread
  limitation is stated on every response rather than left for the caller to discover in Chat.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — the reason these are
  separate commands and not a side effect or a flag on `chat messages`.
