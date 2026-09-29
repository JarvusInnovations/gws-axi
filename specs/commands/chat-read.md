# Command group: chat reads (`spaces`, `messages`, `search`, `members`)

## Summary

Reads Google Chat through the Chat REST API under ordinary user OAuth: list the account's
conversations, read a conversation's messages, search messages across conversations, and list a
conversation's members. The write side is specified separately —
[`chat send`](chat-send.md) and [`chat mark-read` / `mark-unread`](chat-read-state.md).

Under user authentication the Chat API identifies people only as `users/{id}` — no display name,
no email — on message senders, mentions, and members alike. Every command here therefore routes
identities through one shared resolver ([Identity resolution](#identity-resolution)) so output
carries real names, and says so when it cannot.

## Upstream behavior relied on

Each row is a fact about Google's side that this spec depends on. "Documented" rows cite Google's
reference; "verify live" rows are load-bearing assumptions the implementing plan must confirm
against real data before the dependent behavior ships, amending this spec first if one is false.

| Fact | Status |
| --- | --- |
| Read calls under user auth need only the API enabled and an OAuth client — no configured Chat app | **Observed 2026-09-28.** Every read below succeeded on a project with no Chat app configured |
| `sender`, `member`, and mention users carry only `name` + `type` under user auth | **Documented, and contradicted by observation.** See below |
| `users/{id}` is the same identifier as People API `people/{id}` | Documented (User reference) |
| `spaces.messages.search` searches across conversations under user auth | **Observed.** `POST spaces/-/messages:search` with a JSON body; results are `results[].message` |
| `markupSyntax: MARKUP_SYNTAX_MARKDOWN` returns `formattedText` as Markdown | **Observed** on list and search. Links arrive as `[text](url)`; a mention arrives as an empty `<chat-user data-user="users/{id}"></chat-user>` tag |
| `directory.readonly` alone resolves in-domain `people/{id}` to name + email | **Observed, partially.** Of two members the Chat API had already named, the People API resolved one and returned an empty person for the other |
| What a non-Workspace (consumer) account receives from the Chat API, and whether requesting Chat scopes changes its sign-in | Verify live |

### Observed against a Workspace account, 2026-09-28

Sampled: 180 conversations listed; 266 messages across 29 of them; 49 memberships across 12.

- **The Chat API returns names and emails itself.** All 25 distinct senders carried
  `displayName`; 23 of 24 human senders carried `email`, 17 of them outside the account's
  domain. All 49 members carried both. Mention annotations carry the same full user object.
  This contradicts Google's reference, which says user auth populates only `name` and `type`.
- **Threading state does not say whether a conversation has threads.** Direct messages and
  group chats report `THREADED_MESSAGES`, yet in every sampled conversation each message was its
  own thread and `threadReply` was never true.
- **Direct messages and group chats have no `displayName`**: 0 of 26 and 0 of 5.
- **A mention's text lives in `text`, not in the Markdown tag.** The annotation's `startIndex`
  and `length` index into `text`, where the mention reads `@Name`.
- **Search filters are not spelled the way the reference spells them.** The time field is
  `create_time`, quoted, in UTC `Z` form; `createTime` is rejected in every form tried.
  `space.name = spaces/{id}` works; `space.name:` does not. `sender.name` matched by
  `users/{email}` and returned nothing by `users/{id}`.
- **Search appears to omit recent direct messages.** Ordered newest-first, the newest direct
  message search returned was from 2025-10-06, while the same account's direct messages were
  active on 2026-09-28. Cause unknown. `chat messages <space>` read those messages normally.
- **`findDirectMessage` by email works**, returns `404` when no such conversation exists, and
  `400 INVALID_ARGUMENT` when the address is not a user.
- **Attachments are mostly Drive files**: 102 `DRIVE_FILE` to 8 `UPLOADED_CONTENT`.

## Addressing a conversation

Everywhere a command takes `<space>`:

- `spaces/AAAA…` or the bare id `AAAA…` — both forms are accepted; output always renders the bare
  id, and `help[]` lines use whichever form the command accepts positionally (the bare id).
- A Google Chat URL containing the id is accepted and reduced to the id.
- `--with <email>` replaces the positional and names the **1:1 direct message** with that person.
  No such conversation → `DM_NOT_FOUND`, which states that gws-axi cannot start a new direct
  message (no alternative exists) rather than suggesting a command that would fail the same way.
- Passing both a positional and `--with` is a `VALIDATION_ERROR`.

Conversations are **not** addressable by display name. Names are not unique and direct messages
have none; `chat spaces --name <text>` is the lookup that produces the id.

## `chat spaces`

`gws-axi chat spaces [--type <space|group|dm>] [--name <text>] [--with <email>] [--limit <n>]`

Lists the conversations the account belongs to.

```
account: alice@example.com
count: 50 of 212
spaces[50]{id,type,name,last_active}:
  AAAAxyz,space,Transit Data,2026-09-27T16:02:11-04:00
  BBBBabc,dm,Bob Tran,2026-09-27T15:40:00-04:00
  CCCCdef,group,"Bob Tran, Carol Wu, +2",2026-09-26T09:12:45-04:00
```

- `type` is `space` (named space), `group` (group chat), or `dm` (direct message).
- **Sorted by `last_active`, newest first.** The sort applies to the account's full conversation
  set, not to one upstream page — a list truncated by `--limit` is the *most recently active* N,
  never an arbitrary N.
- `--limit` defaults to 50. `count` always reports the rendered count against the total.
- `--name <text>` keeps rows whose `name` contains the text, case-insensitively — including
  derived names (below).
- `--with <email>` returns the single 1:1 direct message with that person.
- `name` for a conversation with no display name of its own (direct messages, unnamed group
  chats) is **derived from its other members' resolved names**: one name for a direct message; for
  a group, the first two names plus `+N`. When any rendered name was derived, the summary carries
  `names_derived: <n>` so a reader knows those labels are gws-axi's, not Google's. A derived name
  whose members could not be resolved renders the raw `users/{id}` — never blank.
- Upstream omits direct messages and group chats that have never had a message sent; a `help[]`
  line states this.

## `chat messages`

`gws-axi chat messages <space> [--since <t>] [--until <t>] [--thread <id>] [--limit <n>] [--page <token>] [--fields <list>] [--full]`

Reads one conversation.

```
account: alice@example.com
space{id,type,name}: AAAAxyz,space,Transit Data
count: 50 (latest 50; older messages exist)
order: oldest → newest
messages[50]{id,time,sender,thread,text}:
  Hk2…,2026-09-27T15:58:03-04:00,Bob Tran,t8Q…,"Feed is back up — see [the run](https://…)"
senders[3]{id,name,email,type}:
  users/1123…,Bob Tran,bob@example.com,human
```

- **Selection is newest-first; rendering is oldest-first.** The rendered set is the most recent
  `--limit` messages inside the window, displayed in conversation order. Upstream's own default
  (oldest-first from the beginning of the conversation) is never the default here: it would answer
  "what's happening in this space" with the space's first messages. `order:` states the rendering
  order on every response.
- `--limit` defaults to 50. When more messages exist than were rendered, `count` says so and the
  header carries `next_page`; `help[]` echoes the complete next command with the token filled in.
  The next page is the next-**older** set.
- `--since` / `--until` are range flags under
  [conventions.md § Time ranges](../api/conventions.md#time-ranges): day-precision expansion per
  edge, relative tokens, the `range:` echo in local-offset ISO, and an empty window as a
  `VALIDATION_ERROR` rather than an empty list. With neither flag there is no window and no
  `range:` line.
- `--thread <id>` narrows to one thread. The `thread` column is present only for conversations
  that thread their messages; rows sharing a value belong to one thread.
- `time` renders in local-offset ISO, matching the `range:` echo.
- `text` is the message's formatted content as **Markdown**, with links inline as
  `[text](url)` and user mentions rendered as `@<resolved name>` (raw `@users/{id}` when
  unresolved). Truncated to 500 chars unless `--full`; truncation never splits a Markdown link.
- `sender` is the resolved display name. When two senders in one response share a display name,
  their rows render `name <email>` so the column stays unambiguous.
- `senders[N]{id,name,email,type}` lists each distinct sender once — the handoff from a name in a
  row to an id or address another command can use. `type` is `human` or `bot`.
- Deleted messages are excluded. System messages are excluded upstream.
- `--fields` opts into `attachments` (count), `reactions` (count), `edited` (last-edit time),
  and `quoted` (the quoted message's sender and text). When the rendered messages carry
  attachments and the column was not requested, a `help[]` line reports how many and names the
  flag.
- **Attachments are not downloadable through gws-axi.** An attachment that is a Drive file is
  surfaced with its file id and a `drive get <id>` suggestion; for uploaded attachments the output
  says no gws-axi command retrieves them.

## `chat search`

`gws-axi chat search [<keywords>] [--space <space>] [--from <email>] [--type <space|group|dm>] [--unread] [--mentions-me] [--has-link] [--has-attachment] [--since <t>] [--until <t>] [--limit <n>] [--page <token>] [--full]`

Searches messages **across every conversation** the account can see, newest first.

```
account: alice@example.com
count: 25 (more available)
messages[25]{space,id,time,sender,text}:
  AAAAxyz,Hk2…,2026-09-27T15:58:03-04:00,Bob Tran,"Feed is back up…"
spaces[4]{id,type,name}:
  AAAAxyz,space,Transit Data
senders[6]{id,name,email,type}:
  users/1123…,Bob Tran,bob@example.com,human
```

- At least one of `<keywords>` or a filter flag is required; a bare `chat search` is a
  `VALIDATION_ERROR` naming `chat spaces` and `chat messages <space>` as the browsing commands.
- `--limit` defaults to 25, maximum 100 (the upstream ceiling). `--page` and the `next_page`
  echo behave as in `chat messages`.
- `--since` / `--until` follow the same range contract.
- `spaces[N]` and `senders[N]` are legends: each conversation and sender in the result appears
  once, so rows stay narrow while every id remains resolvable.
- **Coverage disclosure (required).** Upstream search omits private messages, messages posted by
  apps, app direct messages, messages from blocked users, and muted conversations. A `note` states
  this on every response, including the empty one — `messages: no messages matched` must not read
  as "nothing was said".

## `chat members`

`gws-axi chat members <space> [--include-invited] [--include-groups] [--limit <n>]`

```
account: alice@example.com
space{id,type,name}: AAAAxyz,space,Transit Data
count: 12 of 12
members[12]{id,name,email,type,role}:
  users/1123…,Bob Tran,bob@example.com,human,manager
```

- `--limit` defaults to 100. `role` is `member` or `manager`; `type` is `human`, `bot`, or
  `group`.
- `--include-invited` adds people invited but not yet joined and adds a `state` column
  (`joined` / `invited`). `--include-groups` adds Google Group memberships.

## Identity resolution

One resolver serves every identity in every chat command — senders, mentions, members, and
derived conversation names.

- Resolution is by People API lookup of `people/{id}`, batched, under the
  `directory.readonly` scope.
- The account's own identity resolves from its stored profile, with no lookup.
- Resolved identities are **cached per account**, with a fetch timestamp and an expiry, in a file
  of their own beside the account's tokens — not inside `profile.json`, which sign-in rewrites
  wholesale. A corrupt or unreadable cache is a cache miss, never an error. An empty name from
  upstream is a failed resolution, not a cached name.
- **Resolution can never fail the read it decorates.** If the People API is unreachable, not
  enabled, or the scope was not granted, the command still returns its content with raw
  `users/{id}` identities and a `note` naming the specific fix (re-authenticate, or enable the
  API).
- **Unresolved identities are disclosed.** People outside the account's directory, deleted
  users, and hidden profiles may not resolve. They render as `users/{id}`, and the summary carries
  `unresolved: <n>` with a `note` explaining why a name can be missing. Bots are not people and
  render as `bot` with their id.

## Errors

| Code | When | Suggestions lead with |
| --- | --- | --- |
| `SPACE_NOT_FOUND` | The conversation does not exist or the account is not in it | `chat spaces --name <text>` |
| `DM_NOT_FOUND` | `--with <email>` names someone with no existing 1:1 conversation | Statement that no gws-axi command starts one |
| `THREAD_NOT_FOUND` | `--thread` names a thread not in the conversation | `chat messages <space>` to list threads |
| `CHAT_NOT_AVAILABLE` | The account's type cannot use the Chat API | Statement that Chat needs a Workspace account, plus the other authenticated accounts |
| `SCOPE_MISSING` | The Chat scopes were not granted | `auth login --account <email> --no-wait` |
| `API_NOT_ENABLED` | The Chat or People API is not enabled on the project | `auth setup` for an owned install; the distributor for a joined one |

Chat-specific failures are classified **before** the generic Google error translation, so a
Chat-unavailable or app-not-configured response is never reported as a scope problem with
re-authentication advice that cannot fix it.

## Service availability

Chat is the first service an authenticated account may be categorically unable to use.

- `doctor` probes Chat with a live conversation-list call per account.
- An account that cannot use Chat is reported as **not available**. That is not a failing check:
  it does not change `doctor`'s exit code, does not produce a re-authentication suggestion, and
  suppresses the Chat additional-scope rows for that account.
- An account that *can* use Chat but has not granted its scopes is a failing check with the
  per-account re-auth command, like any other scope gap.

## Principles

**Inherited:**

- [surface-completeness-limits](../principles.md#surface-completeness-limits) — search coverage,
  unresolved identities, derived names, and never-messaged conversations are each stated in the
  output that is affected.
- [ids-are-first-class](../principles.md#ids-are-first-class) — conversation, message, thread,
  and user ids are never truncated; the `senders[]` / `spaces[]` legends keep them reachable
  without widening every row.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — attachments, reactions,
  edit times, and quotes are `--fields` opt-ins; text is capped at 500 chars.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — reading a
  conversation never changes its read state. Marking read is a separate, write-protected command.
- [canonical-empty-list-shape](../principles.md#canonical-empty-list-shape) — every empty list
  here collapses to a scalar under its own field name.
- [single-source-of-truth-helpers](../principles.md#single-source-of-truth-helpers) — one identity
  resolver and one conversation-address parser, shared by every chat command.

**Local:**

- **Names are decoration; ids are the record.** A resolved name makes output legible, but it is
  best-effort, cached, and possibly stale. Nothing in gws-axi accepts a display name as an
  address, and no command's success depends on a name resolving.

  > **Why:** The Chat API's identity is the id; the name comes from a second system with its own
  > visibility rules and its own failure modes. Letting names become load-bearing — as an
  > address, or as a condition of a read succeeding — would make every chat command as reliable
  > as its least reliable lookup, and would send a message to whichever of two same-named
  > conversations happened to match first.
