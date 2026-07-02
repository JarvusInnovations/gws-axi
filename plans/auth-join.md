---
status: in-progress
depends: []
specs:
  - specs/commands/auth-join.md
issues: []
pr:
---

# Plan: auth join — onboard onto a shared OAuth client

## Scope

Add `gws-axi auth join <path>` so a teammate handed a distributor's
`credentials.json` (a Desktop OAuth client for an already-provisioned GCP project —
consent screen configured, APIs enabled, and for a team typically published) can get
to a working state in one command + their own login, instead of fighting the
from-scratch `auth setup` wizard (which would try to make them create a project they
don't own).

Motivated by sharing the Jarvus `jarvus-mcp` client across the @jarv.us team: today
`auth login` works with just `credentials.json` in place, but `setup.json` reads
"incomplete", so `doctor`/`auth status`/the SessionStart line nag and `auth setup`
misfires. `join` closes that gap by marking steps 1–6 satisfied-by-the-shared-client.

In scope: the `join` subcommand (validate → install file → mark steps 1–6 → optional
`--published`), reading the file from **any** path (e.g. `~/Downloads`) and copying
it into place, a shared Desktop-credentials parse/validate helper, `AUTH_HELP`
update, tests, and the spec. Out: any embedded/shipped shared client (still BYO),
server-side probing of APIs or publish status, multi-client management.

## Implements

- **specs/commands/auth-join.md** — full behavior, flags, output, errors, principles.

## Approach

1. Extract the Desktop-credentials parse+validate now inlined in
   `advanceCredentialsSaved` (and partially duplicated in `runSetup`'s oauth_client
   auto-confirm) into a shared helper in `src/auth/steps.ts`, e.g.
   `parseDesktopCredentials(path): { client_id, client_secret, project_id? } | { error, code }`.
   Route `advanceCredentialsSaved`, the `runSetup` auto-confirm block, and the new
   `runJoin` through it ([single-source-of-truth-helpers]).
2. Add `runJoin(args)` in `src/commands/auth.ts`: parse the positional `<path>`
   (expand `~`) + `--published`; validate via the helper; copy to `credentialsPath()`
   (skip when src === dest); `markStepDone` for steps 1–6 with `via: "team-join"`
   metadata (project_id/client_id from the parsed file); set `state.published` when
   `--published`; return the `status: joined` header + `help[]`.
3. Wire `case "join"` into `authCommand`; extend `AUTH_HELP` (subcommand list → 9,
   a `join flags` block, an example line).
4. Tests in `src/commands/auth.test.ts` (new), isolating config via
   `XDG_CONFIG_HOME` to a temp dir.

## Validation

- [x] `auth join <downloads-path>` on a fresh config: copies the file to
      `~/.config/gws-axi/credentials.json`, marks steps 1–6 done (each `via:
      "team-join"`), leaves `tokens_obtained` not done → `setupProgress` = 6/7.
      (Unit test + live smoke test with the built binary.)
- [x] `project_id`/`client_id` in output + state come from the JSON's `installed`.
- [x] `--published` sets `state.published`; without it, publish state is untouched.
- [x] Re-running `join` after a (simulated) `tokens_obtained` keeps step 7 done.
- [x] Missing path → `VALIDATION_ERROR`; missing file → `FILE_NOT_FOUND`;
      bad JSON → `INVALID_JSON`; Web/Service client → `WRONG_CLIENT_TYPE`.
- [x] Source path already == destination → no self-copy error, steps still marked.
- [x] `advanceCredentialsSaved` still passes its existing behavior via the shared helper
      (all 141 tests green, including the pre-existing setup suite).
- [x] `bun run build` clean; `bun run test` green (141); oxlint + oxfmt --check clean.

## Risks / unknowns

- **Wrong "permanent token" claim.** Mitigated by the [Publish status is asserted,
  not detected](../specs/commands/auth-join.md#publish-status-is-asserted-not-detected)
  local principle — `--published` is opt-in, never inferred.
- Overwriting a teammate's partial *real* setup — intended semantic (join is
  declarative). `tokens_obtained` is deliberately never overwritten.

## Notes

(Closeout.)

## Follow-ups

(Closeout.)
