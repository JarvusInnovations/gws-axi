---
status: planned
depends: [api-enablement-drift]
specs:
  - specs/commands/chat-read.md
  - specs/architecture.md
  - specs/api/conventions.md
issues: [71]
---

# Plan: Chat service — reads

## Scope

Stand up the `chat` service and ship its read commands: `spaces`, `messages`, `search`,
`members`, with identity resolution through the People API.

**In scope:**

- Service scaffold: scopes, APIs, `chatClient` / `peopleClient`, live doctor probe with the
  not-available classification, dispatcher, `cli.ts` registration.
- The four read commands and the shared conversation-address parser.
- The identity resolver and its per-account cache.
- `send`, `mark-read`, `mark-unread` registered as scaffolded stubs with signposts, so the
  surface is visible while [`chat-write`](chat-write.md) is pending.

**Out of scope:**

- Sending and read state — [`chat-write`](chat-write.md).
- Downloading message attachments. No plan yet.
- Adopting the identity resolver in `drive activity`, which prints raw `people/{id}` today.
  Follow-up once the resolver has proven out.
- Reactions, editing or deleting messages, creating conversations.

## Implements

- `specs/commands/chat-read.md` — all of it.
- `specs/architecture.md` — `chat` top-level command; `chatClient` / `peopleClient`; Chat's
  scopes and the narrow-scope rule; `people.json` cache; the not-available probe status.
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

1. Land the scope and API changes (step 1 below) and run `auth setup` so both APIs enable.
2. Re-authenticate the Workspace account and confirm the token carries every Chat scope and
   `directory.readonly`.
3. **Consumer-account gate.** All scopes are requested in one consent. Re-authenticate one
   `@gmail.com` account and record: whether consent completes, which scopes the token is granted,
   whether Gmail/Calendar/Drive still work for it afterwards, and what a Chat call returns. If
   requesting Chat scopes breaks or degrades sign-in for a consumer account, **stop**: the scope
   model needs per-account scope sets, which is a spec change to `specs/architecture.md` made
   before anything else in this plan.
4. With a Workspace token, call each upstream method once by hand and record the answers to every
   "verify live" row in `specs/commands/chat-read.md`.

### 1. Scopes and APIs

`SERVICE_SCOPES.chat`, the five `ADDITIONAL_SCOPE_INFO` entries (parent service `chat`), `chat`
in `SERVICES`, `REQUIRED_APIS.chat`, `people.googleapis.com` in `ADDITIONAL_APIS`.

### 2. Client library

`googleapis` 173.0.0 — installed — has neither `spaces.messages.search` nor `markupSyntax`
(confirmed by inspecting its type definitions). Bump with `bun add googleapis@latest` in a commit
of its own, command in the body. Check the `google-auth-library` `overrides` pin still resolves,
and run the full suite before building on it.

### 3. Probe and availability

A live conversation-list probe. Add the not-available status to the probe result and teach
`doctor`'s tally, exit code, re-auth hints, and additional-scope rows to honor it. The service
list in the token-refresh-failure fallback is a hard-coded array — derive it from `SERVICES`.

### 4. Shared helpers

- Conversation-address parser: `spaces/ID`, bare id, URL, and the `--with` exclusivity rule.
- Identity resolver: batch lookup, per-account cache file, self-resolution from the stored
  profile, bot handling, and the never-fails-the-read contract. Lookups go through
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
conversation names; every resolver fallback and the cache lifecycle (cold, fresh, expired,
corrupt, empty-name-not-cached); each error classification; each empty-list scalar; and the
dispatcher emitting `account_source`.

## Validation

**Gates (step 0):**

- [ ] Workspace account re-authenticated; token carries all six new scopes.
- [ ] Consumer-account sign-in with the full scope set recorded, and Gmail, Calendar, and Drive
      confirmed still working for that account afterwards.
- [ ] Each "verify live" row in `specs/commands/chat-read.md` is resolved, and the spec's table
      updated to say what was observed.

**Build:**

- [ ] `bun run build`, `bun run lint`, `bun run format:check`, `bun run test` all pass.

**Live, against real conversations:**

- [ ] `chat spaces` lists conversations newest-active first; a direct message and an unnamed
      group chat each show a derived name and `names_derived` counts them.
- [ ] `chat spaces --with <email>` returns the one direct message; an address with no
      conversation returns `DM_NOT_FOUND`.
- [ ] `chat messages <space>` returns the latest 50 rendered oldest-first, with `order:` and
      `next_page`; following the echoed command returns the next-older set with no overlap.
- [ ] `chat messages <space> --since today` echoes `range:` in local-offset ISO;
      `--since D --until D` covers that whole day; inverted bounds fail with `VALIDATION_ERROR`
      naming both flags.
- [ ] A message containing a link and a mention renders `[text](url)` and `@<name>`.
- [ ] `chat messages <space> --thread <id>` returns only that thread.
- [ ] `chat search <keyword>` returns matches from more than one conversation, with the
      coverage `note`; a query with no matches returns the scalar empty shape **with** the note.
- [ ] `chat members <space>` shows names, emails, and roles.
- [ ] A conversation containing someone outside the directory renders their `users/{id}`,
      with `unresolved:` and the explanatory note.
- [ ] With `people.json` deleted, a read repopulates it; with it present, a second read makes no
      People API call.
- [ ] With the People API disabled on the project, `chat messages` still returns content, with
      raw ids and a note naming the fix.
- [ ] `gws-axi doctor` shows a live `chat` row for the Workspace account, and for a consumer
      account reports Chat as not available with exit code unaffected and no re-auth suggestion.
- [ ] With 2+ accounts and no `--account`, every chat read emits `account_source: default`.
- [ ] `chat send --help` and the `NOT_IMPLEMENTED` error both signpost per
      `specs/api/conventions.md` § Unimplemented and unsupported surfaces.

## Risks / unknowns

- **Message reads require a restricted scope.** `chat.messages.readonly` is restricted, like
  `gmail.modify` and `drive`. It adds lines to a consent screen that is already in restricted
  territory, and for a shared client it counts toward the same verification posture. Note it in
  the onboarding runbook.
- **Consumer accounts and single-consent sign-in** — gated in step 0; the fallback is a spec
  change, not a workaround.
- **Workspace admins can restrict third-party access to Chat.** A Workspace account may fail for
  policy reasons that look like neither a scope gap nor an unavailable service. Classify what is
  observed; do not guess at a code for it in advance.
- **Deriving names costs a members lookup per unnamed conversation** on a cold cache. Bounded by
  labeling only the rows rendered, except under `--name`, which must label everything it filters.
- **The per-conversation read quota is 15 requests per second**; search is 300 per minute per
  project. Both are reachable by an agent in a loop.
- **Spec clauses whose absence is invisible.** A missing `unresolved:` line, coverage note, or
  `account_source` line looks identical to the case where none was needed. Each has a test.
- **Hand-maintained counts** — `flags[N]` headers and the `TOP_HELP` command count drift
  silently.

## Notes

## Follow-ups
