---
status: done
depends: [api-enablement-drift, people-resolver]
specs:
  - specs/commands/chat-read.md
  - specs/architecture.md
  - specs/api/conventions.md
issues: [71]
pr: 72
---

# Plan: Chat service — reads

## Scope

Stand up the `chat` service and ship its read commands: `spaces`, `messages`, `search`,
`members`, rendering people as the Chat API names them and falling back to the shared people
resolver for anyone it does not.

**In scope:**

- Service scaffold: scopes, APIs, `chatClient`, live doctor probe, dispatcher, `cli.ts`
  registration.
- The four read commands and the shared conversation-address parser.
- The identity renderer: Chat's names first, the shared resolver from
  [`people-resolver`](people-resolver.md) as fallback, and the disclosure when neither names
  someone.
- `send`, `mark-read`, `mark-unread` registered as scaffolded stubs with signposts, so the
  surface is visible while [`chat-write`](chat-write.md) is pending.

**Out of scope:**

- Sending and read state — [`chat-write`](chat-write.md).
- Downloading message attachments. No plan yet.
- Naming `drive activity`'s actors, and the resolver itself —
  [`people-resolver`](people-resolver.md).
- Reactions, editing or deleting messages, creating conversations.

## Implements

- `specs/commands/chat-read.md` — all of it.
- `specs/architecture.md` — `chat` top-level command; `chatClient`; Chat's scopes and the
  broad-`chat.messages` rule.
- `specs/api/conventions.md` — `chat messages` / `chat search` as range-flag commands; service
  availability vs. scope gaps.

## Approach

### 0. Live gates — before any handler is written

Issue #71 was written against facts that have since moved (reads no longer need a Chat app;
cross-conversation search now exists in REST), and two earlier plans in this repo were built on
an issue premise that live data contradicted. So the unknowns are resolved first, against real
accounts, and the spec is amended **before** code if any answer differs.

These need the account owner at a browser, so they are scheduled at the start rather than
discovered at closeout — `drive activity` shipped unverified for exactly that reason.

1. Land the scope and API changes (step 1 below) and run `auth setup` so the Chat API is
   recorded as enabled.
2. Re-authenticate the Workspace account and confirm the token carries every Chat scope.
3. **Consumer-account gate.** All scopes are requested in one consent. Re-authenticate one
   `@gmail.com` account and record: whether consent completes, which scopes the token is granted,
   whether Gmail/Calendar/Drive still work for it afterwards, and what a Chat call returns. If
   requesting Chat scopes breaks or degrades sign-in for a consumer account, **stop**: the scope
   model needs per-account scope sets, which is a spec change to `specs/architecture.md` made
   before anything else in this plan.
4. With a Workspace token, call each upstream method once by hand and record the answers to every
   "verify live" row in `specs/commands/chat-read.md`.

### 1. Scopes and APIs

`SERVICE_SCOPES.chat`, the three `ADDITIONAL_SCOPE_INFO` entries (parent service `chat`), `chat`
in `SERVICES`, `REQUIRED_APIS.chat`.

### 2. Client library

`googleapis` 173.0.0 — installed — has neither `spaces.messages.search` nor `markupSyntax`
(confirmed by inspecting its type definitions). Bump with `bun add googleapis@latest` in a commit
of its own, command in the body. Check the `google-auth-library` `overrides` pin still resolves,
and run the full suite before building on it.

### 3. Probe and availability

A live conversation-list probe. The service
list in the token-refresh-failure fallback is a hard-coded array — derive it from `SERVICES`.

### 4. Shared helpers

- Conversation-address parser: `spaces/ID`, bare id, URL, and the `--with` exclusivity rule.
- Identity renderer: name and email from the response's user objects, the shared resolver for
  anyone the response does not name, `users/{id}` and the `unresolved:` disclosure when neither
  does, bot handling, same-name disambiguation, and mentions
  rendered from `text` by annotation offsets. Member lookups for derived names go through
  `withRateLimitRetry`.
- Chat error classifier, applied before `translateGoogleError`.

### 5. Handlers

`spaces`, `messages`, `search`, `members`, each with its `<SUB>_HELP`. `messages` and `search`
reuse the range resolver behind `drive activity --since/--until`.

### 6. Dispatcher and registration

Copy the `sheets` dispatcher shape, including the `withAccountSource` call. Register in `cli.ts`
and keep `chat` out of `COMMAND_HELP`. Update the hand-maintained surfaces: `DESCRIPTION`,
`TOP_HELP` and its command count, the home view, README, `docs/design.md`, the project
`CLAUDE.md` status list, and `docs/shared-client-onboarding.md` (two new APIs the distributor
must enable).

### 7. Tests

Address parsing; range-to-filter construction; newest-selected / oldest-rendered ordering;
mention and link rendering; link-safe truncation; same-name sender disambiguation; derived
conversation names; the resolver fallback and the unresolved disclosure; the thread-column rule;
each error classification; each empty-list scalar; and the dispatcher emitting `account_source`.

## Validation

**Gates (step 0):**

- [x] Workspace account re-authenticated; token carries every Chat scope.
- [x] Consumer-account sign-in with the full scope set recorded, and Gmail, Calendar, and Drive
      confirmed still working for that account afterwards.
- [x] Each "verify live" row in `specs/commands/chat-read.md` is resolved, and the spec's table
      updated to say what was observed.

**Build:**

- [x] `bun run build`, `bun run lint`, `bun run format:check`, `bun run test` all pass.

**Live, against real conversations:**

- [x] `chat spaces` lists conversations newest-active first; a direct message and an unnamed
      group chat each show a derived name and `names_derived` counts them.
- [x] `chat spaces --with <email>` returns the one direct message; an address with no
      conversation returns `DM_NOT_FOUND`.
- [x] `chat messages <space>` returns the latest 50 rendered oldest-first, with `order:` and
      `next_page`; following the echoed command returns the next-older set with no overlap.
- [x] `chat messages <space> --since today` echoes `range:` in local-offset ISO;
      `--since D --until D` covers that whole day; inverted bounds fail with `VALIDATION_ERROR`
      naming both flags.
- [x] A message containing a link and a mention renders `[text](url)` and `@<name>`.
- [x] `chat messages <space> --thread <id>` returns only that thread.
- [x] `chat search <keyword>` returns matches from more than one conversation, with the
      coverage `note`; a query with no matches returns the scalar empty shape **with** the note.
- [x] `chat members <space>` shows names, emails, and roles.
- [x] People outside the account's domain render by name and email, as the response gives them.
- [x] An identity the response does not name is looked up, and one that still has no name
      renders as `users/{id}` with `unresolved:` and the explanatory note. Verified by unit test
      if no such identity exists in live data.
- [x] A conversation where every message is its own thread omits the `thread` column, and
      `--fields thread` restores it.
- [x] `chat search` with `--since`/`--until` returns matches inside the window and echoes
      `range:` in local-offset ISO.
- [x] `gws-axi doctor` shows a live `chat` row, passing, for both the Workspace account and the
      consumer account.
- [x] With 2+ accounts and no `--account`, every chat read emits `account_source: default`.
- [x] `chat send --help` and the `NOT_IMPLEMENTED` error both signpost per
      `specs/api/conventions.md` § Unimplemented and unsupported surfaces.

## Risks / unknowns

- **Message access requires a restricted scope.** `chat.messages` is restricted, like
  `gmail.modify` and `drive` — and so is its read-only variant, so there was no lighter option.
  It adds a line to a consent screen that is already in restricted territory, and for a shared
  client it counts toward the same verification posture. Note it in the onboarding runbook.
- **The token can edit and delete messages; no command does.** That boundary is code, not scope.
  Anything added to the chat surface later inherits the capability without a consent prompt to
  mark the moment.
- **Consumer accounts work**, against expectation — one was observed signing in and using Chat
  fully. The not-available handling was dropped from the spec as unneeded.
- **Workspace admins can restrict third-party access to Chat.** A Workspace account may fail for
  policy reasons that look like neither a scope gap nor an unavailable service. Classify what is
  observed; do not guess at a code for it in advance.
- **Names arrive against the letter of Google's reference.** The plan builds on observed
  behavior the documentation says should not occur. If it stops, output degrades to ids with a
  disclosure; it does not fail.
- **Deriving names costs a members lookup per unnamed conversation**, every time — conversation
  names are not cached. Bounded by labeling only the rows rendered, except under `--name`, which must label
  everything it filters.
- **Search omits recent direct messages**, cause unknown. Disclosed in output; not worked
  around.
- **The per-conversation read quota is 15 requests per second**; search is 300 per minute per
  project. Both are reachable by an agent in a loop.
- **Spec clauses whose absence is invisible.** A missing `unresolved:` line, coverage note, or
  `account_source` line looks identical to the case where none was needed. Each has a test.
- **Hand-maintained counts** — `flags[N]` headers and the `TOP_HELP` command count drift
  silently.

## Notes

- **Three premises in issue #71 were false, and live checks caught all three before code was
  built on them.** Reads need no configured Chat app. A consumer `@gmail.com` account signs in
  and uses Chat fully. And the Chat API returns names and emails itself. Each is recorded in
  `specs/commands/chat-read.md` with what was observed. The gates were scheduled first for this
  reason, and earned it.
- **Names arrive against Google's own reference, and the client library agrees with the
  reference.** `Schema$User` has no `email` field; the API returns one anyway. `ChatUser`
  widens the type to read it as optional.
- **The identity decision changed twice.** The People API was the source (issue), then dropped
  (Chat names people itself), then reinstated as the fallback once
  [`people-resolver`](people-resolver.md) existed for `drive activity`. In this account's data
  the fallback never fired: no human arrived unnamed. It is covered by unit tests.
- **Upstream's Markdown is wrapped at 80 columns and escaped.** Found only by reading rendered
  output, where sentences broke mid-line. `unwrapSoftBreaks` joins them; escapes are left, since
  they are correct Markdown and removing them could turn punctuation into structure.
- **`withRateLimitRetry` hid Chat's errors from their classifier.** It translates on the way
  out, so `THREAD_NOT_FOUND` surfaced as `GOOGLE_API_ERROR_400` until the chat calls moved to
  `retryingChat`, which rethrows untouched. Caught live, not by the unit tests, which exercised
  `chatError` directly.
- **Two kinds of conversation the member list cannot name**: an app (unnamed as a member, named
  as a sender), and a direct message that returns 403 to `spaces.get` and `members.list` while
  serving its messages. Both are named from recent senders.
- **Search's filter language is not the one documented.** `create_time`, not `createTime`;
  sender by `users/<email>`, not by id. `messages.list` does use `createTime`, and accepts only
  `>` and `<`, so an inclusive lower edge is sent as strictly-after the millisecond before.
- **Search omits recent direct messages**, cause unknown: newest-first, the newest it returned
  was from October 2025 on an account whose direct messages were active that day. Disclosed on
  every response.
- **Verified live on two accounts**, one Workspace and one consumer, with read-only calls.
  Validation printed response shapes and counts; message content was not recorded anywhere.
- **`[text](url)` links were confirmed** in app-posted messages (99 in one conversation's
  latest 100). Human-written messages in the sample carried bare URLs, which arrive as
  autolinks.
- **`googleapis` 173 → 182** was required: 173 has neither `spaces.messages.search` nor
  `markupSyntax`. The `google-auth-library` override pin held.

## Follow-ups

- Deferred to [`chat-write`](chat-write.md) — `send`, `mark-read`, `mark-unread`, currently
  stubs. That plan already owns them; nothing to absorb.
- Tracked as: downloading uploaded attachments. The Chat media endpoint exists; no command uses
  it. Drive-file attachments are already reachable through `drive get`.
- Tracked as: help lines do not carry `--account`. A read run as a non-default account suggests
  follow-up commands that would run as the default. Pre-existing across every service — the
  dispatcher strips the flag before the handler sees it — and wants one fix in one place.
- Tracked as: why search omits recent direct messages. Worth a second look if Google documents
  an indexing delay or a history setting that explains it.
