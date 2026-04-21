# gws-axi — Claude Code instructions

Agent-ergonomic CLI for Google Workspace (Gmail, Calendar, Docs, Drive, Slides) built to the [AXI standard](https://axi.md). Published on npm as [`gws-axi`](https://www.npmjs.com/package/gws-axi). Source repo owned by JarvusInnovations.

## Commands

| Task | Command |
|---|---|
| Install deps | `bun install` |
| Build | `bun run build` (runs `tsc` + `chmod +x dist/bin/gws-axi.js`) |
| Run locally | `bun run dev <args>` (runs TS directly via bun) |
| Run built binary | `node dist/bin/gws-axi.js <args>` |
| Test | `bun run test` |

Tool versions are pinned in `.tool-versions` (bun 1.3.11 / nodejs 22.22.0 via asdf).

## Architecture at a glance

- **Entry**: `bin/gws-axi.ts` → `src/cli.ts` (uses `runAxiCli` from `axi-sdk-js`)
- **Subcommand handlers**: `src/commands/<service>.ts` dispatcher + `src/commands/<service>/<sub>.ts` per-subcommand handlers
- **Auth**: `src/auth/` — 7-step progressive BYO OAuth setup, OAuth loopback split into prepare + wait phases so agents can relay instructions before callback wait
- **Google API layer**: `src/google/client.ts` (factories), `src/google/tokens.ts` (lifecycle + refresh), `src/google/probe.ts` (doctor probes), `src/google/account.ts` (resolve + write-protection)
- **Output**: `src/output/` — TOON schema builders (`field`, `pluck`, `mapEnum`, `truncated`, etc.) and renderers (`renderList`, `renderListResponse`, `renderObject`, `renderHelp`)
- **Config**: `src/config.ts` — XDG-compliant `~/.config/gws-axi/` with `setup.json`, `config.json` (default_account), `accounts/<email>/{tokens,profile}.json`, `credentials.json`, `setup.html`

## Key design decisions

- **AXI principles**: TOON output, minimal default schemas, contextual `help[]` suggestions, idempotent mutations, structured errors — see `docs/design.md`
- **BYO OAuth client** (single-user, no shared client) — see `docs/shared-client-future.md` for when/if we ship a public shared client
- **Multi-account**: one OAuth client handles many accounts (each added as a test user). Write operations require explicit `--account <email>` when 2+ accounts are authenticated — prevents silent wrong-account mutations. Reads default to `default_account` from `config.json`. Central rule lives in `resolveAccount()` in `src/google/account.ts`.
- **Setup UX**: setup.html is the single browser surface — the CLI never auto-launches browsers (avoids wrong-profile issues). All Google Cloud Console links live on the HTML page, which auto-refreshes every 10s.
- **Auth login split**: `auth login --account X` prepares (fast), `auth login --wait` blocks on the callback. Agents should run them in two bash turns with instructions-relayed-to-user between.

## Conventions

- **Commits**: conventional commits (`type(scope): description`); commit often; stage specific files (never `git add -A`); keep generated-from-command changes in their own commit with the command in the body
- **TypeScript**: strict mode, ESM (`type: module`), Node16 module resolution, target ES2022; avoid bun-specific runtime APIs since consumers run under Node
- **Output**: never leak dependency noise (e.g. `gcloud` stderr) into stdout; all errors are AXI structured (`AxiError` with code + suggestions)
- **--help routing**: for services with real dispatchers (currently Calendar), `<service> <sub> --help` shows subcommand-specific help — requires the service NOT to be in `COMMAND_HELP` in `src/cli.ts`

## Publishing

- **npm**: `gws-axi` unscoped, owners `themightychris` + `jarvus` org, `access: public`
- **Trigger**: creating a GitHub release fires `.github/workflows/publish-npm.yml` which bumps `package.json` to match the tag, builds, and publishes via `npm publish --provenance` (uses OIDC trusted publishing, no `NPM_TOKEN` needed)
- **Flow**: use `/release` slash command — it drafts notes from commits, creates the tag, opens the GitHub release, and CI takes it from there

## Testing approach

- Vitest for unit tests (state mutations, flag parsing, output shape)
- No tests hit real Google APIs in CI — use mocks or recorded fixtures
- Manual E2E for the OAuth flow (can't automate browser consent)
- When adding a service subcommand, test: (1) empty result renders as `<name>[0]:` + message sibling, not string-valued field; (2) populated result renders default schema; (3) error translation for 401/403/404; (4) account resolution honors write-protection

## Docs

- `docs/design.md` — architecture, auth model, doctor tiers, command surface, multi-account + write-protection spec
- `docs/shared-client-future.md` — deferred shared-client decision with re-assessment triggers
- `README.md` — npm page audience (end users)

## References

- `.scratch/references/axi` - sources for the AXI SDK and documentation of design principals
- `.scratch/references/chrome-devtools-axi` - sources for the AXI reference implementation for Chrome Devtools
- `.scratch/references/gh-axi` - sources for the AXI reference implementation for GitHub

## Current implementation status (check before adding features)

- ✅ Auth setup (7 steps), multi-account, write protection, doctor with live probes
- ✅ Calendar reads: `events`, `get`, `calendars`
- 🚧 Calendar remaining: `search`, `freebusy`, `create`, `update`, `delete`, `respond`
- 🚧 Gmail, Docs, Drive, Slides: scaffolded stubs with real account resolution but `NOT_IMPLEMENTED` handlers
- 🚧 `auth publish` helper to exit Testing mode (eliminates 7-day token expiry)
- 🚧 Vitest test coverage
