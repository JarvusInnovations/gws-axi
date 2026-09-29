# Command group: chat reads (`spaces`, `messages`, `search`, `members`)

## Summary

Reads Google Chat through the Chat REST API under ordinary user OAuth: list the account's
conversations, read a conversation's messages, search messages across conversations, and list a
conversation's members. The write side is specified separately —
[`chat send`](chat-send.md) and [`chat mark-read` / `mark-unread`](chat-read-state.md).

People are rendered by name and email as the Chat API returns them. Anyone it does not name goes
to the shared people resolver, and renders as `users/{id}` if that cannot name them either — see
[Identities](#identities).

## Upstream behavior relied on

Each row is a fact about Google's side that this spec depends on. "Documented" rows cite Google's
reference; "verify live" rows are load-bearing assumptions the implementing plan must confirm
against real data before the dependent behavior ships, amending this spec first if one is false.

| Fact | Status |
| --- | --- |
| Read calls under user auth need only the API enabled and an OAuth client — no configured Chat app | **Observed 2026-09-28.** Every read below succeeded on a project with no Chat app configured |
| `sender`, `member`, and mention users carry only `name` + `type` under user auth | **Documented, and contradicted by observation.** See below |
| `spaces.messages.search` searches across conversations under user auth | **Observed.** `POST spaces/-/messages:search` with a JSON body; results are `results[].message` |
| `markupSyntax: MARKUP_SYNTAX_MARKDOWN` returns `formattedText` as Markdown | **Observed** on list and search. Links arrive as `[text](url)`; a mention arrives as an empty `<chat-user data-user="users/{id}"></chat-user>` tag |
| The People API resolves `users/{id}` to a name | **Observed: inside the account's directory only.** 8 of 8 in-domain people resolved, 0 of 4 outside it. Used as the fallback for anyone Chat does not name |
| A consumer (`@gmail.com`) account cannot use the Chat API | **Expected by issue #71 and by Google's guides; contradicted by observation.** See below |

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

### Observed against a consumer account, 2026-09-29

- **A consumer account signs in and uses Chat like any other.** One consent with the full scope
  set completed, every requested scope was granted, and Gmail, Calendar, and Drive probed healthy
  afterwards.
- **Every read worked**: 204 conversations listed (161 direct messages, 38 group chats, 5
  spaces), messages and members read, search returned results, read state was readable. Senders
  and members carried names and emails, as for the Workspace account.
- So requesting all scopes in one consent is sound, and no account type has been observed that
  cannot use Chat.

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
  chats) is **derived from its other members' names**: one name for a direct message; for
  a group, the first two names plus `+N`. When any rendered name was derived, the summary carries
  `names_derived: <n>` so a reader knows those labels are gws-axi's, not Google's. A derived name
  whose members the response did not name renders the raw `users/{id}` — never blank.
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
- `--thread <id>` narrows to one thread.
- The `thread` column appears when it carries information: some thread in the rendered set holds
  more than one message, or any message is a thread reply. Rows sharing a value belong to one
  thread. When every message is its own thread the column is omitted, and `--fields thread`
  brings it back. A conversation's threading state cannot decide this — direct messages report
  as threaded while every message in them is its own thread.
- `time` renders in local-offset ISO, matching the `range:` echo.
- `text` is the message's formatted content as **Markdown**, with links inline as
  `[text](url)` and user mentions rendered as `@<name>` (raw `@users/{id}` when the
  response names no one). Truncated to 500 chars unless `--full`; truncation never splits a Markdown link.
- `sender` is the display name. When two senders in one response share a display name,
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
  apps, app direct messages, messages from blocked users, and muted conversations — and was
  observed to omit recent direct messages altogether, for reasons unknown. A `note` states this
  on every response, including the empty one — `messages: no messages matched` must not read as
  "nothing was said" — and names `chat messages <space>` as the way to read a conversation
  directly.
- `--from <email>` matches the sender by address. Search returned nothing when the same sender
  was named by id, so the address is the only form offered.
- The window is sent to search in UTC; the `range:` echo stays in local-offset ISO.

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

## Identities

Names and emails come first from the Chat API response itself — the `sender` on a message, the
`member` on a membership, the user on a mention annotation. That covers nearly everyone,
including people outside the account's domain, whom no directory lookup can name.

This inverts what issue #71 assumed. Google's reference says user authentication returns only an
id, which would make a lookup the primary source; observed behavior is otherwise (see
[above](#observed-against-a-workspace-account-2026-09-28)). The lookup is therefore the
**fallback**, not the source.

- One renderer serves every identity in every chat command — senders, mentions, members, and
  derived conversation names.
- **Chat's answer wins.** A person the response names is rendered from the response, and is
  never looked up.
- **A person the response does not name goes to the shared resolver**
  ([conventions.md § People](../api/conventions.md#people)), with everything that contract
  carries: directory-only coverage, the cache, and never failing the read.
- **A person neither source names is disclosed, never invented.** They render as `users/{id}`,
  the summary carries `unresolved: <n>`, and a `note` says why a name can be missing. A missing
  email leaves the `email` column empty for that row.
- **The reference says Chat's names may be absent.** If Google's behavior comes to match its
  documentation, every identity falls through to the resolver, and people outside the directory
  degrade to ids with the disclosure above. The read still succeeds.
- Bots are not people: they render as `bot` with their id and whatever name the response gives,
  and are never looked up.
- A mention is rendered from the message's `text`, where it reads `@Name`, using the
  annotation's offsets. The Markdown form carries only an empty tag holding the id.

## Errors

| Code | When | Suggestions lead with |
| --- | --- | --- |
| `SPACE_NOT_FOUND` | The conversation does not exist or the account is not in it | `chat spaces --name <text>` |
| `DM_NOT_FOUND` | `--with <email>` names someone with no existing 1:1 conversation | Statement that no gws-axi command starts one |
| `THREAD_NOT_FOUND` | `--thread` names a thread not in the conversation | `chat messages <space>` to list threads |
| `SCOPE_MISSING` | The Chat scopes were not granted | `auth login --account <email> --no-wait` |
| `API_NOT_ENABLED` | The Chat API is not enabled on the project | `auth setup` for an owned install; the distributor for a joined one |

Chat-specific failures are classified **before** the generic Google error translation, so an
app-not-configured response is never reported as a scope problem with re-authentication advice
that cannot fix it.

## Doctor

`doctor` probes Chat with a live conversation-list call per account, and reports a missing Chat
scope as a failing check with the per-account re-auth command, like any other scope gap.

There is no "not available" status. Issue #71 expected consumer accounts to need one; a consumer
account was observed to work fully, so there is nothing to classify. If an account is ever found
that cannot use Chat — a Workspace whose admin has turned Chat off is the likeliest — its failure
is classified from what it actually returns, as a spec change, and not guessed at in advance.

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
  renderer and one conversation-address parser, shared by every chat command.

**Local:**

- **Names are decoration; ids are the record.** A name makes output legible, but Google documents
  it as something user authentication does not return, and names are not unique. Nothing in
  gws-axi accepts a display name as an address, and no command's success depends on a name being
  present.

  > **Why:** The Chat API's identity is the id. The name arrives today against the letter of
  > Google's own reference, so it can stop arriving without notice, and the fallback behind it
  > covers only the account's own directory. Letting names become
  > load-bearing — as an address, or as a condition of a read succeeding — would make every chat
  > command depend on undocumented behavior, and would send a message to whichever of two
  > same-named conversations happened to match first.
