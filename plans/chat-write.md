---
status: planned
depends: [chat-read]
specs:
  - specs/commands/chat-send.md
  - specs/commands/chat-read-state.md
  - specs/principles.md
issues: [71]
---

# Plan: Chat service — send and read state

## Scope

Replace the three stubs left by [`chat-read`](chat-read.md) with real commands: `chat send`,
`chat mark-read`, `chat mark-unread`.

**In scope:**

- `chat send` with Markdown bodies, thread replies, request-id retries, and the destination echo.
- `CHAT_APP_NOT_CONFIGURED` and its owned-vs-joined guidance; the optional "Enable Chat sending"
  section on `setup.html`.
- `chat mark-read` / `chat mark-unread` at conversation level.

**Out of scope:**

- A literal-text mode for bodies whose Markdown characters are meant literally. Tracked as a
  follow-up; `gmail draft --plain` is the precedent if it proves necessary.
- Guarding or refusing mention-all. Left unguarded in this version and called out in Risks.
- Editing, deleting, or reacting to messages; attachments on send.
- Thread-level read state — the REST API cannot write it.

## Implements

- `specs/commands/chat-send.md` — all of it.
- `specs/commands/chat-read-state.md` — all of it.
- `specs/principles.md` — `composed-output-is-wire-final` (promoted from `gmail-draft.md`) and
  the clarification appended to `gmail-send-out-of-scope-by-design`.

## Approach

### 0. Live gates

1. **Configure the Chat app** on the Cloud project — Console only, done by the project owner.
   Choose the app name deliberately: every recipient sees it beside every message sent.
2. Before configuring, attempt one send to a direct message with oneself and **record the exact
   failure**. The only description of it found so far comes from a third-party issue tracker;
   `CHAT_APP_NOT_CONFIGURED` is classified from what is actually observed.
3. After configuring, resolve every "verify live" row in both specs, in a conversation where test
   messages disturb nobody.

### 1. Send

Body-source validation and the size guard run before any API call. Resolve the destination,
refuse `--thread` on a conversation that does not thread, then create with the Markdown markup
syntax, `REPLY_MESSAGE_OR_FAIL` when replying, and the request id. Render `text` from the
response.

### 2. Retry path

Classify failures into "did not reach Google" and "may have reached Google". Only the second
gets the retry-with-same-request-id suggestion as its first line.

### 3. Read state

`mark-read` sets the read position past the latest message and reports the value read back.
`mark-unread --from` reads the message's create time and sets the position just before it.
Multiple conversations are processed independently into a results table.

### 4. Dispatcher

All three are `mutation: true`. Remove each stub's `instead` lines in the same commit that lands
its handler. Write-command `--account` help lines carry the `GWS_AXI_ACCOUNT` wording used by
the other write commands.

### 5. Tests

Body-source exclusivity; size guard at the boundary; thread refusal; request id generated and
echoed; retry suggestion present only on the ambiguous failure class; replay handling;
read-state no-ops; partial failure across several conversations; write-protection on all three.

## Validation

**Gates (step 0):**

- [ ] The unconfigured-project failure is recorded verbatim and `CHAT_APP_NOT_CONFIGURED`
      classifies it.
- [ ] Each "verify live" row in `chat-send.md` and `chat-read-state.md` is resolved and the
      spec tables updated.

**Build:**

- [ ] `bun run build`, `bun run lint`, `bun run format:check`, `bun run test` all pass.

**Live — every send verified by reading the message back *and* viewing it in the Chat UI:**

- [ ] A body with bold, a list, inline code, and a link renders as formatting in Chat, and
      `chat messages` returns the same Markdown.
- [ ] The message is attributed to the account, with the Chat app's name shown as the spec's
      `note` describes.
- [ ] `--thread <id>` lands inside that thread; a nonexistent thread id returns
      `THREAD_NOT_FOUND` and **no message is created**.
- [ ] `--thread` against a direct message is refused before sending.
- [ ] Re-running a send with the same `--request-id` creates no second message.
- [ ] A send forced to time out returns an error whose first suggestion is the retry command
      carrying the request id, and running it yields exactly one message in the conversation.
- [ ] With 2+ accounts and no `--account`, `chat send` returns `ACCOUNT_REQUIRED` and sends
      nothing; under a `GWS_AXI_ACCOUNT` pin it sends as the pinned account.
- [ ] A 32,001-byte body returns `MESSAGE_TOO_LARGE` without an API call.
- [ ] `chat mark-read` on an unread conversation clears it in the Chat UI; a second run reports
      `already_read` and exits 0.
- [ ] `chat mark-unread --from <messageId>` shows that message and later ones as unread in the
      Chat UI.
- [ ] `chat messages` run between the two leaves read state unchanged.
- [ ] A joined install's `CHAT_APP_NOT_CONFIGURED` names the distributor and contains no Console
      URL; `setup.html` for a joined install has no "Enable Chat sending" link.
- [ ] Every test message sent during validation is listed in Notes with its conversation, since
      gws-axi cannot delete them.

## Risks / unknowns

- **Sent messages cannot be taken back by gws-axi.** Validation runs in a direct message with
  oneself or a scratch space, never a working conversation.
- **Mention-all is unguarded.** The hosted Chat MCP server prohibits it; this version neither
  guards nor offers it. An agent that writes the tag by hand notifies the whole conversation.
  Whether to refuse it is a product decision left to the owner.
- **A replay may be indistinguishable from a first send.** The spec allows for either and says
  which was observed.
- **Agents write Markdown by habit**, which is why the body format is Markdown — but a body whose
  `*`, `_`, or `#` are literal will be reformatted. Same hazard `gmail draft --plain` answered.
- **The Chat app name is a one-time, highly visible choice**, made in a Console page that gives
  no hint it will appear on every message.
- **A per-conversation write quota of one request per second** makes any future bulk send slow by
  construction. Consistent with one-destination-per-invocation.

## Notes

## Follow-ups
