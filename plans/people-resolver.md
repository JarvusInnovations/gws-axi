---
status: done
depends: [api-enablement-drift]
specs:
  - specs/api/conventions.md
  - specs/commands/drive-activity.md
  - specs/architecture.md
issues: [71]
pr: 72
---

# Plan: Shared people resolver, and named actors in `drive activity`

## Scope

`drive activity` has printed raw `people/<id>` for every actor since it shipped, because the
Drive Activity API returns no names. This plan adds the one shared resolver that turns such ids
into people, and adopts it in `drive activity`.

It was reinstated on the owner's request after being dropped from [`chat-read`](chat-read.md),
where the Chat API turned out to name people itself. Here there is no such luck: the resolver is
the only source.

**In scope:**

- `directory.readonly` and `people.googleapis.com`; `peopleClient`.
- The resolver: batched lookup, per-account cache, self-resolution, never failing its caller.
- `drive activity`: names in the `actor` column, the `actors[]` legend, the `unresolved:`
  disclosure.

**Out of scope:**

- Naming people outside the account's directory. Measured coverage is the directory and nothing
  else; that is stated in output, not worked around.
- Chat's use of the resolver as a fallback — [`chat-read`](chat-read.md), which depends on this
  plan.
- Feeding the cache from names other services reveal (Chat names external people the directory
  cannot). See Follow-ups.

## Implements

- `specs/api/conventions.md` § People — the whole contract.
- `specs/commands/drive-activity.md` — resolved `actor`, the `actors[]` legend, the disclosure.
- `specs/architecture.md` — `peopleClient`, the scope and API, the `people.json` cache.

## Approach

1. **Scopes and APIs**: `directory.readonly` in `ADDITIONAL_SCOPE_INFO` under parent service
   `drive`; `people.googleapis.com` in `ADDITIONAL_APIS`.
2. **`peopleClient`** in `src/google/client.ts`.
3. **Resolver** in `src/google/people.ts`. Given an account and a set of ids in either spelling
   (`people/{id}`, `users/{id}`), return a map of what resolved plus the reason when nothing
   could be looked up. Pure helpers for id normalization, response parsing, and cache
   read/merge/expiry, so they are testable without a client. Lookups batch at the API's limit
   and go through `withRateLimitRetry`.
4. **Cache** at `accounts/<email>/people.json`, modeled on the `weekStart` cache: fetch
   timestamps, expiry, merge-on-write, corrupt-is-a-miss.
5. **`drive activity`**: collect distinct known-user actors, resolve once, render names in rows
   and the legend. The existing pure extractors keep returning ids; naming is applied after.
6. **Tests**: id normalization; response parsing including the empty-person shape the API
   returns for someone it cannot name; cache lifecycle; every degraded path returning ids and a
   reason rather than throwing; `drive activity` row and legend rendering, resolved and not.

## Validation

- [x] `bun run build`, `bun run lint`, `bun run format:check`, `bun run test` all pass.
- [x] `gws-axi auth setup` reports complete with `people.googleapis.com` recorded.
- [x] `gws-axi drive activity <id>` on a file edited by colleagues shows their names in `actor`
      and lists them in `actors[]` with ids and emails.
- [x] An actor outside the directory renders as `people/<id>`, appears in `actors[]` with empty
      name and email, and the response carries `unresolved: <n>` with the note.
- [x] A second run makes no People API call for people already cached.
- [x] With `people.json` deleted, a run repopulates it.
- [x] Against an account whose token lacks `directory.readonly`, the timeline still renders,
      with raw ids and a note naming re-authentication as the fix.
- [x] `gws-axi doctor` reports `directory.readonly` per account under `drive`.

## Risks / unknowns

- **Coverage will disappoint on externally-shared files.** Of 11 distinct actors in this
  account's recent activity, 5 resolved. The feature names colleagues; it does not name clients
  or collaborators at other organizations.
- **A consumer account has no directory**, so it will likely resolve only itself.
- **The cache holds names and emails of other people** on disk, in the account's config
  directory. Same exposure as the tokens beside it, but it is new personal data at rest.
- **Accounts signed in before this lands lack the scope** until they re-authenticate. The
  degraded path is what they see in the meantime, so it has to read well.

## Notes

- **Verified live on a Workspace account.** On a document edited by colleagues, all four actors
  resolved to names and addresses. On one shared with outside collaborators, one of three
  resolved; the other two rendered as `people/<id>` with `unresolved: 2` and the
  outside-directory note.
- **Coverage, measured before the spec was written**: 8 of 8 people inside the account's domain,
  0 of 4 outside it, and 5 of 11 distinct actors across the account's recent Drive activity.
  Requesting all four People API read sources did not change the result.
- **Cache verified**: a second run left `people.json` unmodified; deleting it and re-running
  repopulated it. The file is written `0600`.
- **The degraded path verified** against a consumer account whose token predates the scope: the
  timeline rendered, with ids, `unresolved: 2`, and a note naming the re-auth command.
- **`unresolved:` sits inside the `item{}` header block**, beside `scope` and `range`, rather
  than as a sibling line — that block is `drive activity`'s summary.
- **A scope missing from the stored token is detected before any call.** The token's own scope
  list is authoritative and free to read, and it lets the note name re-authentication precisely
  rather than inferring it from a 403.
- **Three of four authenticated accounts lack the scope** and show a failing `doctor` row under
  `drive` until they re-authenticate.
- **`chatClient` landed in this plan's scope commit**, ahead of the chat handlers that use it.

## Follow-ups

- Tracked as: feeding the cache from names other services reveal. Chat names external people the
  directory cannot, and two of this account's unresolved Drive actors were people Chat had named.
  It would make `drive activity` output depend on which chat commands had run before, so it
  wants a decision, not a quiet addition.
- Tracked as: `drive activity`'s `time` column still renders UTC while `range:` renders
  local-offset ISO (carried from [`api-enablement-drift`](api-enablement-drift.md)).
