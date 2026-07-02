# Command: auth join

## Summary

One-shot onboarding onto an **already-provisioned OAuth client** — the shared-team
case. A teammate is handed the distributor's `credentials.json` (the Desktop OAuth
client for a GCP project someone else set up, its consent screen already configured
and its APIs already enabled). `auth join <path>` ingests that file, installs it in
the config dir, and marks setup steps 1–6 as satisfied-by-the-shared-client so the
from-scratch wizard (`auth setup`) never tries to walk the teammate through creating
a project they don't own. All that remains is the teammate's own OAuth grant
(`auth login`), which is step 7.

This does **not** contradict [byo-oauth-single-user](../principles.md#byo-oauth-single-user):
there is still no embedded shared client shipped in the binary. The client is
brought by the user — just copied from a colleague rather than freshly created. One
OAuth client legitimately serves many accounts (each added as a test user, or the
consent screen published); `join` is the ergonomic path onto an existing one.

## Invocation

`gws-axi auth join <path> [flags]`

- `<path>` — REQUIRED. Path to the shared `credentials.json` (the downloaded Desktop
  OAuth client JSON). Accepts a file at **any** location — `~/Downloads/credentials.json`,
  a vault mount, anywhere — and copies it into the config dir itself. The teammate
  does not pre-place the file. `~/` is expanded (matching `auth setup --credentials-json`).

## Flags

- `--published` — assert that this client's consent screen is already published to
  "In Production". Sets the `published` flag in setup state so login messaging and
  `auth publish` reporting reflect it. Optional and **opt-in**: publish status is a
  server-side fact this command cannot observe from the JSON, so `join` never infers
  it — the distributor, who knows the client's state, bakes `--published` into the
  paste-command they hand teammates. Omitting it leaves publish state untouched
  (teammates can still run `auth publish` later). See [Publish status is asserted, not detected](#publish-status-is-asserted-not-detected).

## Behavior

1. **Validate** the file is a Desktop OAuth client — parseable JSON with
   `installed.client_id` and `installed.client_secret`. This is the *same*
   validation `auth setup --credentials-json` applies; both route through one shared
   helper ([single-source-of-truth-helpers](../principles.md#single-source-of-truth-helpers)).
   A Web/Service-account client is rejected with `WRONG_CLIENT_TYPE`.
2. **Install** the credentials by copying `<path>` to `credentialsPath()`
   (`~/.config/gws-axi/credentials.json`), creating the config dir if needed. If
   `<path>` already resolves to that destination, the copy is skipped (no self-copy
   error) — supports a teammate who happened to save it there first.
3. **Mark steps 1–6 done**, each tagged `via: "team-join"` so the provenance of the
   short-circuit is auditable in `setup.json`:
   - `gcp_project` — `{ project_id, created_by_us: false, via: "team-join" }`, where
     `project_id` is read from the JSON's `installed.project_id` when present.
   - `apis_enabled` — `{ via: "team-join" }` (the shared project's APIs are enabled
     by definition; `join` cannot and does not probe them).
   - `oauth_client` — `{ via: "team-join", client_id }`.
   - `credentials_saved` — `{ via: "team-join", client_id, path: <dest> }`.
   - `consent_screen` — `{ via: "team-join" }`.
   - `test_user_added` — `{ via: "team-join" }`.
4. **Leave `tokens_obtained` (step 7) untouched.** That is the teammate's own grant,
   obtained via `auth login`. `join` never fabricates it.
5. If `--published`, set `state.published = { confirmed_at: <now> }`.

`join` is **declarative and idempotent**: it sets state to "joined to this client."
Re-running overwrites steps 1–6 with fresh timestamps and never touches
`tokens_obtained` — so a teammate who re-runs `join` after logging in keeps their
authenticated account. It freely overwrites any half-built local setup (that is the
intended semantic: "forget my partial setup, I'm joining this client").

## Output

Header object then `help[]`:

```
status: joined
project_id: jarvus-mcp
client_id: 1065467392851-…apps.googleusercontent.com
credentials: ~/.config/gws-axi/credentials.json
steps_ready: 6 of 7 (only your own sign-in remains)
help[3]:
  Run `gws-axi auth login --account you@jarv.us` to authenticate your account
  Do NOT run `gws-axi auth setup` — this client is already provisioned; join handled steps 1–6
  Run `gws-axi doctor` after login to verify auth + runtime health
```

- `project_id` omitted when the JSON carried no `installed.project_id`.
- When `--published` was passed, add a line noting the client is marked published so
  the teammate's refresh token will be permanent (no `auth publish` needed).
- Paths are home-collapsed (`~/…`) per the existing `collapseHome` convention.

## Errors

- Missing `<path>` → `VALIDATION_ERROR` with a `gws-axi auth join <path>` usage suggestion.
- File not found at `<path>` → `FILE_NOT_FOUND`.
- Not valid JSON → `INVALID_JSON` (suggest re-downloading from the distributor).
- Not a Desktop client (`installed.client_id`/`client_secret` absent) → `WRONG_CLIENT_TYPE`
  with the same guidance as `auth setup` ("must be a Desktop app OAuth client").

All are `AxiError` on stdout ([structured-errors-to-stdout](../principles.md#structured-errors-to-stdout)).

## Dispatcher

New `join` case in `authCommand`'s switch → `runJoin(rest)`. Listed in `AUTH_HELP`
subcommands (bringing it to 9), with a `join` flags block documenting `--published`
and an example line. `auth` stays out of `COMMAND_HELP`-driven subcommand routing as
today (it returns `AUTH_HELP` when no subcommand is given).

## Principles

**Inherited:**

- [byo-oauth-single-user](../principles.md#byo-oauth-single-user) — no shared client
  is embedded; the client is still user-brought, just copied from a colleague. `join`
  is the ergonomic on-ramp to an existing BYO client, not a second auth model.
- [single-source-of-truth-helpers](../principles.md#single-source-of-truth-helpers) —
  the Desktop-client parse+validate is one helper shared with `credentials_saved`;
  `join` must not fork a second copy of that logic.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — output
  names the exact `auth login --account <email>` next step and steers the teammate
  away from `auth setup`.
- [never-auto-launch-browsers](../principles.md#never-auto-launch-browsers) — `join`
  touches no browser; the subsequent `auth login` uses the existing setup-page surface.
- [structured-errors-to-stdout](../principles.md#structured-errors-to-stdout) — every
  failure is a coded `AxiError` on stdout.

**Local:**

### Publish status is asserted, not detected

`join` never infers publish status from the credentials file, because the JSON does
not carry it — publish is a server-side property of the consent screen. Guessing
would risk telling a teammate their token is permanent when it expires in 7 days (or
vice-versa). So publish state is only ever set by an explicit human assertion:
`--published` on `join` (the distributor bakes in what they know) or the existing
`auth publish --confirm`. Absent that assertion, `join` leaves publish state alone.

> **Why:** A wrong "permanent token" claim is a silent trap — the teammate builds on
> access that vanishes a week later with no warning. Better to under-claim (they
> re-run `auth publish` or just re-auth) than to assert a server state we can't see.
