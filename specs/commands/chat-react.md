# Command group: chat reactions (`react`, `unreact`)

## Summary

Adds or removes the account's own emoji reaction on a Google Chat message. Both are **writes**:
a reaction is visible to everyone in the conversation, and notifies the message's author.

Reading reactions is part of [`chat messages`](chat-read.md#chat-messages) (`--fields reactions`).

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| Creating and deleting a reaction under user auth is covered by the `chat.messages` scope | Documented (reactions reference lists `chat.messages` among accepted scopes). **Observed 2026-09-29** with a token granting no reaction-specific scope |
| Adding a reaction the account already made is refused with `409 ALREADY_EXISTS` | **Observed** |
| Any Unicode emoji is accepted, including skin-tone variants, which are distinct reactions | **Observed**: 👍 and 👍🏽 coexisted on one message |
| Text that is not an emoji is refused with `400 INVALID_ARGUMENT` naming an invalid Unicode emoji | **Observed** |
| The reactions endpoint refuses a client-assigned message id (`client-…`) | **Observed**: `400`, malformed message resource name. Fetching the message by that id does work |
| Reactions can be listed filtered by `emoji.unicode` and `user.name = "users/{id}"` | **Observed**. `user.name = "users/me"` returned `500` |
| Deleting a reaction that no longer exists returns `403` | **Observed** |
| Custom (workspace-uploaded) emoji | Not supported here |

## Invocation

```
gws-axi chat react   <space> <message> --emoji <emoji> [--account <email>]
gws-axi chat unreact <space> <message> --emoji <emoji> [--account <email>]
```

- `<space>` — as in [chat-read.md § Addressing a conversation](chat-read.md#addressing-a-conversation).
  `--with <email>` works in its place.
- `<message>` — a message id as `chat messages` prints it, `spaces/{space}/messages/{id}`, or a
  client-assigned id (`client-…`, as `chat send --request-id` produces). A full resource name may
  be given alone, with no `<space>`.
- `--emoji` — one Unicode emoji, exactly as it should appear, e.g. `👍` or `👍🏽`. Shortcodes such
  as `:thumbsup:` and custom emoji are refused before any API call, with that reason.
- `--account` — required with 2+ accounts, unless `GWS_AXI_ACCOUNT` pins the session.

## Behavior

- **Both are idempotent.** Reacting with an emoji the account already used is `action:
  already_reacted`, exit 0. Removing a reaction the account hasn't made is `action:
  not_reacted`, exit 0. Neither changes anything.
- **Only the account's own reaction is ever removed.** Other people's reactions with the same
  emoji are untouched.
- A client-assigned id is resolved to the message's system id before the reaction call, since the
  reactions endpoint refuses it.
- **Skin-tone variants are different emoji.** `unreact --emoji 👍` does not remove a 👍🏽.

## Output

```
account: alice@example.com
action: reacted
message:
  space: AAQAPRZPq1Y
  id: vgyelv3Ty8g.vgyelv3Ty8g
emoji: 👍
reactions: 👍 2 · 🎉 1
help[1]:
  Run `gws-axi chat unreact AAQAPRZPq1Y vgyelv3Ty8g.vgyelv3Ty8g --emoji 👍 --account alice@example.com` to take it back
```

`action` is `reacted`, `already_reacted`, `unreacted`, or `not_reacted`. `reactions` is the
message's reaction summary read back after the change — `reactions: none` when there are none.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Missing message or emoji; a shortcode or plain text given as `--emoji` |
| `INVALID_EMOJI` | Chat refused the emoji as not a valid Unicode emoji |
| `MESSAGE_NOT_FOUND` | No such message in the conversation |
| `SPACE_NOT_FOUND`, `DM_NOT_FOUND`, `ACCOUNT_REQUIRED`, `SCOPE_MISSING` | As in [chat-read.md § Errors](chat-read.md#errors) |

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
  — both are `mutation: true`.
- [ids-are-first-class](../principles.md#ids-are-first-class) — the response names the message
  by the id `chat messages` prints, and `help[]` carries the exact command to reverse it.
- Idempotent mutations (AXI §6) — repeating either command is a reported no-op, not an error.
