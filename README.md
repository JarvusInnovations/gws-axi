# gws-axi

Agent-ergonomic CLI for Google Workspace — Gmail, Calendar, Docs, Drive, and Slides behind a single command, built to the [AXI standard](https://axi.md): [TOON](https://toonformat.dev/)-formatted output, contextual next-step suggestions, idempotent mutations, and multi-account safety by default.

Designed for use by AI agents. Every response is structured, every error names a specific fix, and write operations lock to the explicit account when multiple are authenticated — so two agents in parallel sessions can't silently touch the wrong mailbox.

> **Status (v0.3):** **Calendar is complete** — all 9 subcommands (5 reads + 4 writes) are implemented. Gmail, Docs, Drive, and Slides are scaffolded stubs that exercise auth + account resolution but return `NOT_IMPLEMENTED` on their concrete operations. Auth, doctor (with live per-account API probes), and multi-account management are stable.

## Requirements

- Node.js ≥ 20
- A Google account (personal or Workspace)
- `gcloud` CLI (optional — speeds up initial setup, not required)

## Getting started

### 1. Install

```bash
npm install -g gws-axi
```

### 2. Let an agent walk you through setup

`gws-axi` is designed to be driven by an AI coding agent (Claude Code, Cursor, anything that can run shell commands). The setup flow is progressive — the CLI emits structured TOON output telling the agent what to do next, and the agent coordinates with you through the handful of Google Cloud Console steps that can't be automated.

Start a fresh agent session and paste a prompt like:

```
Run `gws-axi auth setup` and walk me through the progressive setup
flow it describes. The CLI's output will tell you exactly what to do
at each step — relay the instructions to me, and run follow-up
commands as you go.

I want to authenticate the following Google accounts:
  - you@example.com
  - personal@gmail.com
```

The explicit `gws-axi auth setup` in the prompt matters: this is your very first session, so the agent doesn't yet have any ambient context about `gws-axi`. Naming the first command gets the agent into the structured flow, where the CLI's output takes over. Every subsequent session auto-loads a compact `gws-axi` status line via a session-start hook (installed on first invocation) — so after this one, you can skip the command and just say "use gws-axi to ..." and the agent knows.

Expect ~10 minutes end-to-end for a fresh Google Cloud project; ~3 minutes if you already have one you want to reuse.

**What happens during setup:** you create your own Google Cloud project with OAuth credentials, enable the Workspace APIs, configure the consent screen, and add your Google accounts as test users. This is the [**bring-your-own OAuth client**](docs/shared-client-future.md) model — avoids public-app verification overhead and keeps the blast radius of any token revocation scoped to you. Tokens live locally at `~/.config/gws-axi/`.

The CLI generates an auto-refreshing HTML helper page (`~/.config/gws-axi/setup.html`) with clickable Console deep-links — so you never copy long URLs from terminal to browser and you stay in the right browser profile throughout.

### 3. Check it works

```bash
gws-axi doctor                           # setup + live API health
gws-axi calendar events                  # upcoming 7 days on your primary calendar
```

### 4. Make gws-axi your agent's default for Google Workspace

On first invocation (which already happened during step 2), `gws-axi` auto-installed a **SessionStart hook** into your agent's config (Claude Code's `~/.claude/settings.json`, Codex's `~/.codex/hooks.json`). From now on, every new agent session will see a compact `gws-axi` status line in ambient context — authenticated accounts, write-protection status, setup health — with no extra wiring. Nothing for you to configure.

To make sure agents reach for `gws-axi` instead of stale alternatives, also consider:

- **Remove existing Google Workspace MCP servers and skills.** If you already have Gmail / Calendar / Drive / Docs / Slides integrations installed (community MCP servers, bespoke skills, etc.), disable them. Keeping both creates ambiguity — agents may pick whichever they noticed first, and the tools have different auth models, flag names, and output shapes. Typical candidates to disable: `google-calendar-mcp`, `gmail-mcp`, `google-docs-mcp`, any `@modelcontextprotocol/server-google-*`, and skills with similar names.

- **Add a directive to your `CLAUDE.md`.** A short note in your project-level (`.claude/CLAUDE.md`) or user-level (`~/.claude/CLAUDE.md`) file nudges agents to consistently use `gws-axi`. Example:

  ```markdown
  ## Google Workspace

  Use `gws-axi` for ALL Google Calendar, Gmail, Docs, Drive, and Slides
  interactions. Check the SessionStart `gws-axi` line for current auth
  state; run `gws-axi --help` for the command surface. Prefer this over
  any other Google integrations.
  ```

### Prefer to drive it manually?

The CLI works fine without an agent — each `gws-axi auth setup` invocation prints its own instructions and updates `setup.html`. Run it repeatedly as you complete each step; no state is lost between invocations.

## Usage

Every subcommand supports `--help`. The bare `gws-axi` command prints current state, authenticated accounts, and top suggestions.

### Home / auth / health

```bash
gws-axi                                  # home view — current state + suggestions
gws-axi auth accounts                    # list authenticated Google accounts
gws-axi auth login --account <email>     # add another account (prepare + --wait)
gws-axi auth use <email>                 # set the default account
gws-axi doctor                           # prerequisites + setup + live API probes
```

### Calendar reads

```bash
gws-axi calendar events                  # upcoming 7 days on primary
gws-axi calendar events --from 2026-04-20T00:00 --to 2026-04-27T00:00
gws-axi calendar events --fields attendees,location,status
gws-axi calendar get <event-id>          # full detail + attendees
gws-axi calendar get <event-id> --full   # don't truncate description
gws-axi calendar calendars               # list calendars accessible to this account
gws-axi calendar search --query "standup"  # primary calendar by default
gws-axi calendar search --query "chris" --include-shared  # include delegated + subscribed
gws-axi calendar freebusy --calendars primary,team@jarv.us  # cross-calendar availability
```

### Calendar writes

```bash
gws-axi calendar create \
  --summary "Team sync" --start 2026-04-22T14:00 --duration 30m

gws-axi calendar update <event-id> \
  --summary "Team sync (rescheduled)" --start 2026-04-22T15:00

gws-axi calendar delete <event-id>       # idempotent (404/410 → noop)

gws-axi calendar respond <event-id> --response accepted
```

Writes default `--send-updates` to `none` so agent-created events don't spam attendees. Pass `--send-updates all` for production-style invite behavior.

### Multi-account with write protection

gws-axi supports multiple Google accounts under one OAuth client. When two or more are authenticated, write operations require `--account <email>` explicitly — silent wrong-account mutations are impossible:

```bash
gws-axi calendar events                         # read: uses default account
gws-axi calendar create --summary "..."         # write: ACCOUNT_REQUIRED error
gws-axi calendar create --account chris@jarv.us --summary "..."  # OK
```

### Example output

```
account: chris@jarv.us
count: 3
range: 2026-04-20T14:00:00.000Z → 2026-04-27T14:00:00.000Z
events[3]{id,summary,start,end,my_response}:
  abc123,Team standup,2026-04-21T14:00:00-04:00,2026-04-21T14:15:00-04:00,accepted
  def456,1:1 with Ari,2026-04-22T15:30:00-04:00,2026-04-22T16:00:00-04:00,accepted
  ghi789,Board meeting,2026-04-25,2026-04-26,needsAction
help[2]:
  Run `gws-axi calendar get <id>` for full event details
  Add `--fields attendees,location,status` to show more columns
```

## Design docs

- [`docs/design.md`](https://github.com/JarvusInnovations/gws-axi/blob/main/docs/design.md) — architecture, auth model, doctor tiers, command surface
- [`docs/shared-client-future.md`](https://github.com/JarvusInnovations/gws-axi/blob/main/docs/shared-client-future.md) — why BYO-only for v1, what a shared-client public distribution would involve

## Known issues & roadmap

- **Testing-mode tokens expire every 7 days.** Google's OAuth policy for unpublished apps. Re-run `gws-axi auth login --account <email>` + `auth login --wait` when it happens. A future `gws-axi auth publish` helper will walk single-developer verification to eliminate this.
- **Gmail, Docs, Drive, Slides**: not yet implemented. Stubs exercise auth + account resolution so write-protection errors still surface correctly; actual operations return `NOT_IMPLEMENTED`. Gmail is next.
- **Tests**: not yet — coming alongside Gmail.

## Contributing

Issues and PRs welcome at [github.com/JarvusInnovations/gws-axi](https://github.com/JarvusInnovations/gws-axi).

## License

MIT — see [LICENSE](LICENSE).
