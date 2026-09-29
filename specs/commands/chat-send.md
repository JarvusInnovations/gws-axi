# Command: chat send

## Summary

Posts a message to one Google Chat conversation as the authenticated account. This is a real
send: the message is delivered and visible to the conversation's members the moment the command
returns.

That makes it the one place gws-axi sends on a person's behalf, and the reason is structural, not
a relaxation — see [Why Chat sends when Gmail does not](#why-chat-sends-when-gmail-does-not).

## Invocation

`gws-axi chat send <space> (--text <string> | --body-file <path> | -) [--thread <id>] [--request-id <key>] [--account <email>]`

- `<space>` or `--with <email>` — the destination, per
  [chat-read.md § Addressing a conversation](chat-read.md#addressing-a-conversation).
- Exactly one body source: `--text`, `--body-file <path>`, or `-` (stdin). Zero or several is a
  `VALIDATION_ERROR`.
- `--thread <id>` — reply inside an existing thread.
- `--request-id <key>` — caller-chosen idempotency key (see [Retries](#retries)).
- `--account <email>` — required when 2+ accounts are authenticated, unless `GWS_AXI_ACCOUNT`
  pins the session.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| Creating a message under user auth requires a Chat app configured on the Cloud project | Documented (Chat API configuration guide) |
| The response when no Chat app is configured | **Cannot be observed here** — the project already had a Chat app when this was built. Classified from a third-party report of a 404 "Google Chat app not found"; unverified |
| The message is attributed to the user, with the Chat app's name displayed beside it | Documented (create-messages guide) — verify live |
| `markupSyntax: MARKUP_SYNTAX_MARKDOWN` on create renders standard Markdown | Documented (GA 2026-08-07) — verify live |
| A message may carry a client-assigned id (`client-…`), unique within its conversation, under user auth | Documented — verify live |
| Creating a message whose client-assigned id already exists is refused, and creates nothing | Documented — verify live |
| Message size limit is 32,000 bytes | Documented |
| Thread replies via `messageReplyOption` are supported only in named spaces | Documented — verify live what `--thread` does in a direct message |

## Body

- The body is **standard Markdown** and is sent with the Markdown markup syntax, so `**bold**`,
  `*italic*`, `~~strike~~`, inline code, fenced code, lists, block quotes, and `[text](url)` render
  as formatting. Chat's legacy markup (`*bold*`, `<url|text>`) is not the input format.
- A user mention is written as Chat's mention tag, documented in `--help`. There is no
  `@name` shorthand: a name is not an address
  ([chat-read.md § Principles](chat-read.md#principles)).
- The body is validated against the 32,000-byte limit **before** any API call
  (`MESSAGE_TOO_LARGE`, stating the actual size).
- There is no literal-text mode in this version: characters that are Markdown syntax are
  interpreted as Markdown. `--help` says so and names the characters.

## Destination

Before sending, the command resolves the destination conversation and **echoes it in the
response**. A caller must be able to see where a message went without trusting its own id.

- `--thread <id>` replies in that thread and **fails if the thread does not exist**
  (`THREAD_NOT_FOUND`). It never falls back to starting a new thread: a reply that lands as a new
  top-level message has gone to the wrong place, in front of the wrong audience.
- `--thread` against a conversation that does not thread its messages is a `VALIDATION_ERROR`
  raised before sending.
- **One conversation per invocation.** There is no multi-destination form and no flag that fans a
  message out.

## Retries

A timed-out or failed send is the one case where an agent cannot tell whether its mutation
happened, and a blind retry posts a duplicate that gws-axi cannot delete.

- Every send carries a request id: the caller's `--request-id`, or one gws-axi generates. A
  caller's id is lowercase letters, digits, and hyphens, at most 56 characters.
- **The request id becomes the message's client-assigned id.** Chat refuses a second message
  with the same id in the same conversation, so a replay is recognized by Chat's own answer
  rather than inferred from timing.
- The response always echoes `request_id`.
- **A replay is a no-op**: exit 0, the existing message returned, `action: already_sent`.
  Nothing is posted.
- **When a send fails after the request may have reached Google** (timeout, network error, 5xx),
  the error's first suggestion is the complete command to retry, carrying the same request id. A
  retry with that id cannot duplicate the message.
- A failure Chat answered with a refusal (4xx) did not post anything, and says so.
- Re-running the command **without** a request id sends a second message. `--help` and the
  success response's `help[]` both say so.
- A request id is scoped to its conversation: the same id in a different conversation is a
  different message.

## Output

```
account: alice@example.com
action: sent
space{id,type,name}: AAAAxyz,space,Transit Data
message{id,thread,time,request_id}: Hk2…,t8Q…,2026-09-28T10:14:07-04:00,5f1c…
text: "Feed is back up — see [the run](https://…)"
note: Delivered. Members see this as sent by alice@example.com, with the Chat app's name shown beside it.
help[2]:
  Run `gws-axi chat messages AAAAxyz --thread t8Q…` to read the thread
  Re-running this command without --request-id 5f1c… sends the message again
```

`text` is the message **as Chat stored it**, read from the response rather than echoed from the
input, so the caller sees what the markup became.

## Errors

| Code | When | Suggestions lead with |
| --- | --- | --- |
| `CHAT_APP_NOT_CONFIGURED` | The Cloud project has no Chat app configured | Owned install: the Console configuration page and the three required fields. Joined install: ask the distributor — never a Console link |
| `SPACE_NOT_FOUND` | Destination missing or not a member | `chat spaces --name <text>` |
| `DM_NOT_FOUND` | `--with <email>` has no existing conversation | Statement that no gws-axi command starts one |
| `THREAD_NOT_FOUND` | `--thread` does not exist | `chat messages <space>` |
| `MESSAGE_TOO_LARGE` | Body exceeds 32,000 bytes | The actual size |
| `ACCOUNT_REQUIRED` | 2+ accounts and no explicit account | One runnable line per account |

## Chat app configuration

Sending is the only gws-axi capability that needs a Chat app configured on the Cloud project.
Reads do not.

- It is **not a numbered setup step.** Setup stays seven steps, and an install that never sends
  is complete without it.
- gws-axi cannot detect the configuration without attempting a send, and never sends to find
  out. The first `chat send` on an unconfigured project fails with `CHAT_APP_NOT_CONFIGURED`.
- `setup.html` carries the Console link under an optional "Enable Chat sending" section for an
  owned install. A joined install shows no link and names the distributor instead
  ([auth-join.md](auth-join.md)).
- The configured app name is visible to every recipient of every message sent. `--help` and the
  configuration guidance both say so, because it is chosen once and seen by everyone.

## Why Chat sends when Gmail does not

[gmail-send-out-of-scope-by-design](../principles.md#gmail-send-out-of-scope-by-design) withholds
`gmail send` so that an agent composes and a human sends. That boundary is drawn around a
**draft** — a saved, reviewable intermediate the human opens in Gmail and sends themselves.

Google Chat has no drafts. There is no intermediate object the API can create for a human to
review and release: a message either exists in the conversation or it does not. Withholding send
here would not move the send to a human — it would remove the capability entirely, and the
agent's next move would be to leave the tool and call the API with the raw token
([no-dead-end-surfaces](../principles.md#no-dead-end-surfaces)).

So the two surfaces apply one rule and reach different answers: **where a reviewable intermediate
exists, gws-axi stops there; where none exists, gws-axi sends, and spends its caution on the send
being deliberate, singular, and visible.** Do not "align" either command with the other.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
  — `mutation: true`. With 2+ accounts, a message is never sent as an implicit default.
- [composed-output-is-wire-final](../principles.md#composed-output-is-wire-final) — the body's
  format is one gws-axi controls end to end, and the response reports what was stored, not what
  was typed.
- [ids-are-first-class](../principles.md#ids-are-first-class) — message id, thread id, and request
  id are all returned and echoed into `help[]`.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — a failed send's
  first suggestion is the safe retry, fully formed.

**Local:**

- **A send is deliberate, singular, and visible.** With no draft to review, the safeguards are
  that the account was chosen explicitly, the destination is one conversation that the response
  names back, and a reply fails rather than landing somewhere else. Anything that makes a send
  broader or less certain of its destination — multiple destinations, thread fallback, addressing
  by name — is out.

  > **Why:** A sent chat message cannot be reviewed first and gws-axi cannot take it back. The
  > cost of a wrong send is social and immediate, paid by the account's owner in front of their
  > colleagues. Each safeguard here closes one way a message reaches an audience nobody chose.
