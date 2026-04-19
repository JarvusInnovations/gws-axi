# gws-axi

Agent-ergonomic CLI for Google Workspace — Gmail, Calendar, Docs, Drive, and Slides behind a single command, built to the [AXI standard](https://axi.md): [TOON](https://toonformat.dev/)-formatted output, contextual next-step suggestions, idempotent mutations, and multi-account safety by default.

Designed for use by AI agents. Every response is structured, every error names a specific fix, and write operations lock to the explicit account when multiple are authenticated — so two agents in parallel sessions can't silently touch the wrong mailbox.

> **Status:** early release. **Calendar reads** (`calendar events`) are implemented with real TOON output. Other subcommands (`calendar get|create|update|…`, `gmail`, `docs`, `drive`, `slides`) are scaffolded but return `NOT_IMPLEMENTED`. Auth, doctor, and multi-account management are complete.

## Requirements

- Node.js ≥ 20
- A Google account (personal or Workspace)
- `gcloud` CLI (optional — speeds up initial setup, not required)

## Install

```bash
npm install -g gws-axi
```

## First-run setup

`gws-axi` uses a **bring-your-own OAuth client** model: you create your own Google Cloud project with OAuth credentials, and tokens live locally at `~/.config/gws-axi/`. This avoids verification/CASA overhead for public apps and keeps the blast radius of any token revocation scoped to you.

The setup is progressive — run `gws-axi auth setup` repeatedly and each invocation walks you through the next step:

```bash
gws-axi auth setup   # start or continue — 7 steps, mostly automated
gws-axi doctor       # check setup + live API health at any time
```

The CLI generates a styled, auto-refreshing HTML helper page at `~/.config/gws-axi/setup.html` with clickable Console deep-links — so you never copy long URLs from terminal to browser and you stay in the right browser profile throughout.

Typical flow: set project → enable APIs → create OAuth client → download JSON → configure consent screen → add test users → authenticate. See the in-CLI guidance as you go; every step tells you exactly what to do next.

## Usage

Every subcommand supports `--help`. The bare `gws-axi` command prints current state, authenticated accounts, and top suggestions.

```bash
gws-axi                                  # home view
gws-axi calendar events                  # list upcoming events
gws-axi calendar events --query standup  # full-text search
gws-axi calendar events --fields attendees,location
gws-axi auth accounts                    # list authenticated Google accounts
gws-axi auth login --account <email>     # add another account
gws-axi doctor                           # full health check
```

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

## Known issues

- **Testing-mode tokens expire every 7 days.** Google's OAuth policy. Re-run `gws-axi auth login --wait` when it happens. A future `gws-axi auth publish` helper will walk single-developer verification to eliminate this.
- **Most service subcommands are not yet implemented.** Only `calendar events` does real work as of v0.1. The rest will follow — see the design doc for the order.

## Contributing

Issues and PRs welcome at [github.com/JarvusInnovations/gws-axi](https://github.com/JarvusInnovations/gws-axi).

## License

MIT — see [LICENSE](LICENSE).
