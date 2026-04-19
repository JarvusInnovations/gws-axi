# gws-axi — design

`gws-axi` is an AXI-compliant CLI for Google Workspace. This document specifies v1: BYO auth, progressive setup, `doctor` diagnostics, and the command surface across all supported services.

## Goals

1. **Single CLI, unified auth** — one command (`gws-axi`), one OAuth client, one token store covers Gmail, Calendar, Docs, Drive, and Slides
2. **Agent-first output** — every response is TOON-formatted with contextual next-step hints, readable by LLM agents without re-querying
3. **Progressive setup** — Google's OAuth onboarding pain is distributed across multiple agent-guided turns, not compressed into one overwhelming wizard
4. **Self-diagnostic** — `doctor` shows prerequisites, setup progress, and live API health in one read-only view. Every failure suggests a specific fix
5. **Replace our MCP servers** — gws-axi is the successor to the four Google MCP servers (google-calendar-mcp, google-docs-mcp, google-slides, gmail). Feature parity is the v1 bar

## Non-goals

- Google Cloud Platform tools (GCE, BigQuery, GKE, etc.) — that's a separate domain
- Google Workspace admin APIs (directory, licensing) — maybe later, not v1
- Shared OAuth client distribution — see [shared-client-future.md](shared-client-future.md)

## Configuration directory

All user state lives under `$XDG_CONFIG_HOME/gws-axi/` (default `~/.config/gws-axi/`):

```
~/.config/gws-axi/
├── setup.json              # progressive setup state (see below)
├── config.json             # user preferences (default_account, etc.)
├── credentials.json        # user's downloaded OAuth client JSON (desktop type)
├── setup.html              # locally generated HTML page with Console deep-links
└── accounts/
    ├── chris@jarv.us/
    │   ├── tokens.json     # refresh + access tokens (mode 0600)
    │   └── profile.json    # email, name, picture, sub, verified_email
    └── chris@personal.com/
        └── ...
```

Rationale: XDG-compliant, easy to reset (`rm -rf ~/.config/gws-axi && gws-axi auth setup`), single location for all auth state. Per-account subdirectories support multi-account use from a single OAuth client.

## Authentication model (v1 — BYO)

Each user creates their own Google Cloud project and OAuth client. `gws-axi` walks them through the parts that can be automated (project creation, API enablement via `gcloud` if installed) and deep-links for the parts that cannot (Desktop OAuth client creation, consent screen configuration).

A single BYO OAuth client can authenticate **multiple Google accounts** (e.g., personal + work). Each account needs to be added as a test user while the app is in Testing publishing status, and each authenticates independently via its own OAuth loopback run. Tokens are stored per-account at `~/.config/gws-axi/accounts/<email>/tokens.json`.

### Why BYO

See [shared-client-future.md](shared-client-future.md) for the full rationale. Short version: shipping a shared client with Gmail scopes requires $3K+/year CASA forever; BYO eliminates all ongoing compliance overhead and scopes suspension risk to the individual user.

### What the user goes through (8 steps)

| # | Step | Automatable? | Output |
|---|---|---|---|
| 0 | Choose auth mode | `--mode byo` flag (only option in v1) | `setup.json.auth_mode = "byo"` |
| 1 | Pick or create GCP project | `gcloud projects create` if installed; else deep-link | `setup.json.steps.gcp_project` |
| 2 | Enable required APIs | `gcloud services enable ...` if installed; else deep-link | `setup.json.steps.apis_enabled` |
| 3 | **Create Desktop OAuth client** | **Manual — Console only** (Google doesn't expose Desktop client creation via CLI/API) | `setup.json.steps.oauth_client` |
| 4 | Download + save credentials JSON | `gws-axi auth setup --credentials-json <path>` | `~/.config/gws-axi/credentials.json` |
| 5 | Configure OAuth consent screen | Manual — External, Testing mode initially | `setup.json.steps.consent_screen` |
| 6 | Add self as test user | Manual — Console | `setup.json.steps.test_user_added` |
| 7 | Run OAuth loopback flow | Automatic — browser opens, localhost callback | `~/.config/gws-axi/tokens.json` |

### Required scopes (v1)

All requested at login time (single consent screen):

- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/documents`
- `https://www.googleapis.com/auth/drive`
- `https://www.googleapis.com/auth/presentations`
- `openid email profile` (for account identification)

Later we may support incremental authorization (`include_granted_scopes=true`) for just-in-time scope requests, but v1 requests everything up front for simplicity.

### Testing mode token expiry (known pain point)

OAuth clients in "Testing" publishing status issue refresh tokens that expire after 7 days. Users hit this every week until they push their app to "Production." `gws-axi doctor` surfaces this as a warning; a future `gws-axi auth publish` helper can walk through the self-verification flow (for self-use, single-developer verification is lightweight compared to public distribution).

## Multi-account model

### Account lifecycle

- **Add an account**: `gws-axi auth login --account <email>` — runs the OAuth loopback with `login_hint`, verifies post-auth identity via `userinfo.email`, rejects if the returned email doesn't match the expected one (prevents accidentally authenticating as the wrong Google account)
- **List accounts**: `gws-axi auth accounts`
- **Switch default**: `gws-axi auth use <email>`
- **Remove**: `gws-axi auth revoke <email>` — deletes the local tokens. Auto-promotes another account to default if the revoked one was default.

First account authenticated auto-promotes to default. Single-account users don't interact with the account machinery at all.

### Write-protection rule

When 2+ accounts are authenticated:

- **Reads** use the default account if `--account` is not provided
- **Writes** REQUIRE `--account <email>` — `ACCOUNT_REQUIRED` error otherwise

When 1 account is authenticated: no requirement, sole account is always used.

This prevents the "Agent A reads personal calendar, Agent B switches default to work, Agent A writes to work by accident" failure mode when parallel agent sessions share the same config.

Mutations marked per subcommand in each service's dispatcher map:

```ts
// src/commands/calendar.ts
buildServiceStub("calendar", [
  { name: "events", mutation: false },    // read
  { name: "create", mutation: true },     // write — needs --account if 2+
  { name: "respond", mutation: true },    // RSVP is a write
  ...
]);
```

Resolution flows through `resolveAccount(flags.account, { mutation, commandName })` in `src/google/account.ts` — single source of truth.

### Output header

Every command's TOON output includes `account: <email>` so the agent always sees which account was used:

```
account: chris@jarv.us
events[3]{id,summary,start}:
  ...
```

Keeps responses self-describing regardless of which default is currently set.

### ID-token verification

When OAuth completes, Google returns an ID token whose `email` claim identifies the authenticated user. We always use that email (normalized to lowercase) as the storage directory name — never a user-provided string. If `--account` was passed as an expected identity and the returned email doesn't match, we refuse to write tokens and return `ACCOUNT_MISMATCH`.

Prevents spoofing via flag, and catches the common error of clicking the wrong account in Google's account-chooser.

## Progressive setup state file

`~/.config/gws-axi/setup.json`:

```json
{
  "version": 1,
  "auth_mode": "byo",
  "steps": {
    "gcp_project": {
      "done": true,
      "at": "2026-04-19T14:02:10Z",
      "project_id": "gws-axi-chris-9f3a",
      "created_by_us": true
    },
    "apis_enabled": {
      "done": true,
      "at": "2026-04-19T14:03:22Z",
      "apis": ["gmail", "calendar", "docs", "drive", "slides"]
    },
    "oauth_client": { "done": false },
    "credentials_saved": { "done": false },
    "consent_screen": {
      "done": false,
      "publishing_status": "testing"
    },
    "test_user_added": { "done": false, "email": "chris@jarv.us" },
    "tokens_obtained": {
      "done": false,
      "scopes_granted": []
    }
  },
  "last_action": "waiting_for_user:oauth_client_creation",
  "resume_hint": "Open setup.html or run `gws-axi auth setup` to continue"
}
```

### `gws-axi auth setup` behavior

Each invocation:

1. Read `setup.json` (create if missing)
2. Find first step where `done: false`
3. Either perform it (if automatable) or print deep-link + instructions and update `last_action`
4. On success: mark step `done: true`, set `at`, re-invoke to find next step
5. On final completion: print success confirmation + home view hint

Output is always TOON-formatted so the agent can parse progress and guide the user through each step in its own turn.

### Generated HTML helper (`setup.html`)

Because Google Cloud Console URLs are long and agent terminals tend to mangle them when wrapped, `gws-axi auth setup` writes an HTML file at `~/.config/gws-axi/setup.html` with clickable buttons for each pending step's Console destination, regenerated on each invocation to reflect current state. The CLI prints `file:///Users/.../setup.html` which the user can click from their terminal.

## `doctor` command

Read-only diagnostic across three tiers. Safe to run anytime, including in SessionStart hooks.

### Output format

```
bin: ~/.local/bin/gws-axi
description: Google Workspace AXI — checking setup, auth, and API health

prerequisites[3]{check,status,detail}:
  gcloud CLI,ok,version 512.0.0
  node runtime,ok,v22.22.0
  config dir,ok,~/.config/gws-axi (rw)

setup[8]{step,status,detail}:
  mode_chosen,ok,byo
  gcp_project,ok,gws-axi-chris-9f3a
  apis_enabled,ok,gmail calendar docs drive slides
  oauth_client,ok,client ends in ...apps.googleusercontent.com
  credentials_saved,ok,~/.config/gws-axi/credentials.json
  consent_screen,warn,publishing_status=testing (tokens expire every 7 days)
  test_user_added,ok,chris@jarv.us
  tokens_obtained,ok,5 of 5 scopes granted

runtime[5]{service,status,detail}:
  gmail,ok,chris@jarv.us quota=91% remaining
  calendar,ok,12 calendars accessible
  docs,fail,401 insufficient_scope — docs.readonly missing
  drive,ok,
  slides,ok,

summary: 1 failing, 1 warning
help[2]:
  Run `gws-axi auth setup` to re-run auth with missing scopes (fixes: docs)
  Run `gws-axi auth publish` for production mode (fixes: consent_screen warning)
```

### Tiers

**prerequisites** — system-level requirements

- `gcloud CLI` — optional, warns if missing with note it makes setup faster
- `node runtime` — confirms version meets `>=20` engine requirement
- `config dir` — confirms `~/.config/gws-axi/` exists and is readable/writable

**setup** — state file-driven progress

- Reads `setup.json`
- Reports each step's `done` status
- Surfaces `consent_screen.publishing_status=testing` as a warning (7-day token expiry)

**runtime** — live API probes

- Cheap reads per service: `users.getProfile` (Gmail), `calendarList.list` (Calendar), `about.get` (Drive), `documents.get` on a known-public doc (Docs — skipped if no reference), `presentations.get` (similar)
- Detects revoked tokens, missing scopes, quota issues that the state file wouldn't know about

### Flags

- `--check <tier>` — run only one tier (e.g., `--check runtime`)
- `--check <tier>.<name>` — run one specific check (e.g., `--check runtime.gmail`)
- `--summary` — one-line output (used by SessionStart hook)
- `--json` — emit JSON instead of TOON (debugging only)
- `--fix` — (v2, deferred) auto-resolve safe failures

### Exit codes

- `0` — all ok (including warnings)
- `1` — at least one failing check
- `2` — usage error (bad flag, etc.)

## Command surface (v1)

Flat top-level service subcommands:

```
gws-axi                                      # home view (state + top suggestions)
gws-axi auth setup                           # progressive setup wizard
gws-axi auth login [--account <email>]       # run OAuth loopback; add/re-auth an account
gws-axi auth accounts                        # list authenticated accounts
gws-axi auth use <email>                     # set default account
gws-axi auth revoke <email>                  # delete an account's tokens
gws-axi auth status                          # terse: "ok" or "broken: <reason>"
gws-axi auth reset [--from N]                # clear state, optionally from step N
gws-axi doctor                               # comprehensive diagnostic
gws-axi calendar ... [--account <email>]     # Calendar subcommands
gws-axi gmail ... [--account <email>]        # Gmail subcommands
gws-axi docs ... [--account <email>]         # Docs subcommands
gws-axi drive ... [--account <email>]        # Drive subcommands
gws-axi slides ... [--account <email>]       # Slides subcommands
```

`--account` is required for write operations when 2+ accounts are authenticated; see the Multi-account model section.

### Per-service surface

Each service subcommand exposes the operations we currently use across the four MCP servers. First-pass command lists (refined during implementation):

**calendar** — list events, get event, create event, update event, delete event, respond to event, list calendars, search events, free/busy

**gmail** — search, read, send, draft, list labels, modify labels, batch-modify, create label, update label, delete label, create filter, list filters, delete filter, download attachment

**docs** — read (markdown), append, insert text, delete range, apply text style, apply paragraph style, insert table, edit table cell, find element, list comments, add comment, reply to comment, resolve comment

**drive** — search files, get file, create file, copy file, move file, rename file, delete file, create folder, list folder contents, get file permissions, download file content

**slides** — create presentation, get presentation, get page, batch update, summarize

## Error handling

All errors follow the AXI pattern: structured, written to stdout, with specific fixes suggested.

```
error: OAuth token expired or revoked
code: auth_token_invalid
help[2]:
  Run `gws-axi auth login` to refresh tokens
  Run `gws-axi doctor` to see full auth state
```

Non-zero exit codes for unrecoverable errors; zero exit for idempotent no-ops (e.g., closing something already closed).

## Session hook (SessionStart)

On first invocation, `gws-axi` self-installs a SessionStart hook in `~/.claude/settings.json` and `~/.codex/hooks.json` (via `installSessionStartHooks` from `axi-sdk-js`). The hook runs `gws-axi --summary` which emits a compact state line:

- If setup incomplete: `gws-axi: setup 3/8 — run 'gws-axi auth setup' to continue`
- If setup complete and healthy: `gws-axi: ok (5 services, chris@jarv.us)`
- If setup complete with failures: `gws-axi: 1 failing check — run 'gws-axi doctor'`

Token-budget-aware — single-line output in the healthy case.

## Testing strategy

- **Unit tests** (vitest) for state-file manipulation, TOON output shape, error formatting
- **Integration tests** for doctor output with mocked API responses
- **Manual E2E** for OAuth flow (not automatable — browser involvement)
- No tests hit real Google APIs in CI; use recorded fixtures or mocks

## Deferred / future

- `gws-axi auth publish` — walks single-developer verification for pushing own OAuth app to production (eliminates 7-day token expiry)
- `gws-axi auth mode` — switch between BYO / shared / hybrid (when shared-client shipped)
- `--all-accounts` merged views (e.g., combined calendar, cross-account search)
- Admin / directory APIs
- Google Forms, Google Sites, Google Keep (lower-priority Workspace apps)

See [shared-client-future.md](shared-client-future.md) for shared-client deferral details.
