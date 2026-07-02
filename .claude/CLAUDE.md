# gws-axi — Claude Code instructions

Agent-ergonomic CLI for Google Workspace (Gmail, Calendar, Docs, Drive, Slides) built to the [AXI standard](https://axi.md). Published on npm as [`gws-axi`](https://www.npmjs.com/package/gws-axi). Source repo owned by JarvusInnovations.

## Commands

| Task | Command |
| --- | --- |
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
- **Auth login default vs split**: `auth login --account X` runs prepare + wait in one command (default — best for humans who can see their own browser). For agent-driven re-auth, pass `--no-wait` on the first call to get fast prepare-only output, relay instructions to the user, then run `auth login --wait` in a SEPARATE bash turn — the wait command binds the callback server and must be listening before the user clicks. Never run the default (blocking) form from an agent context: it'll sit on the callback for up to 5 min while the user can't see what's happening.

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
- When adding a service subcommand, test: (1) empty result collapses to `<name>: <human message>` (scalar value under the list's field name — AXI canonical empty-list shape, set in `renderListResponse`); (2) populated result renders default schema; (3) error translation for 401/403/404; (4) account resolution honors write-protection

## Spec-driven development (specops)

This repo uses [specops](https://github.com/JarvusInnovations/specops): **specs are the source of truth; code follows.** Start every feature by updating `specs/`, not by editing code.

- `specs/` — the authoritative desired state. `specs/principles.md` (decisive cross-cutting rules — read these first), `specs/architecture.md` (structure/models), `specs/api/conventions.md` (cross-command contracts), `specs/commands/<service>-<cmd>.md` (per-command). Read the relevant spec before implementing; if it's ambiguous or wrong, fix the spec, don't work around it in code.
- `plans/` — work-in-flight as a micro-DAG (motion, not state). A chunk of work starts with a plan file (`status: planned`), flips to `in-progress`, and the last commit before merge flips it to `done` with `pr:` + checked validation. Protocol: `.agents/skills/specops/references/plans-protocol.md`.
- Plans dashboard: `.agents/skills/specops/scripts/specops` (also `next`, `dag`). A project SessionStart hook in `.claude/settings.json` loads it each session.
- **Spec drift auditing**: run `/audit-spec-drift` to launch the auditor comparing `specs/` against the implementation.
- Spec↔code divergence is a bug, not debt — a PR that changes behavior updates the spec in the same PR.

## Docs

- `docs/design.md` — architecture, auth model, doctor tiers, command surface, multi-account + write-protection spec
- `docs/shared-client-future.md` — deferred shared-client decision with re-assessment triggers
- `docs/shared-client-onboarding.md` — distributor runbook for the `auth join` shared-client flow (consent-screen config, teammate steps, no-Console-access rule)
- `README.md` — npm page audience (end users)

## References

- `.scratch/references/axi` - sources for the AXI SDK and documentation of design principals
- `.scratch/references/chrome-devtools-axi` - sources for the AXI reference implementation for Chrome Devtools
- `.scratch/references/gh-axi` - sources for the AXI reference implementation for GitHub

## Current implementation status (check before adding features)

- ✅ Auth setup (7 steps), multi-account, write protection, doctor with live probes
- ✅ `auth publish` helper to walk through Testing→Production (eliminates 7-day token expiry)
- ✅ Calendar reads: `events`, `get`, `calendars`, `search`, `freebusy`
- ✅ Calendar writes: `create`, `update`, `delete`, `respond`
- ✅ Docs reads: `read`, `find`, `comments`, `download`, `revisions` (alias of `drive revisions`), `diff`
  - `read` inlines the 5 most recent revisions (`revisions[N]{id,modified,author}`) on every read and funnels help to `revisions`/`download --revision`/`diff` — provenance shown by default (`specs/principles.md#provenance-by-default`), best-effort so a failed revisions fetch never fails the content read.
  - `diff <fileId> <revA> [revB]` (revB→head) exports both revisions to markdown and diffs locally (no Google diff API); native Docs only, discloses the lossy-markdown-export caveat. Shared revision-export logic lives in `src/commands/docs/revision-content.ts`. Spec: `specs/commands/docs-diff.md`; `docs read` spec: `specs/commands/docs-read.md`.
- ✅ Gmail reads: `search`, `read` (incl. `--headers` full RFC 2822 header set + `--raw` source), `labels`, `download`
- ✅ Gmail writes: `draft`, `modify`, `batch-modify`, `label-create/update/delete`, `filter-list/create/delete`
  - ❌ `send` is intentionally OUT OF SCOPE — short-circuits with `NOT_SUPPORTED` redirecting to `draft`. No Gmail scope grants drafting+label edits while withholding send, so the boundary is a code/product decision, not a scope (the token is send-capable). Don't "implement" send.
  - Filters need the `gmail.settings.basic` scope (added to `src/auth/scopes.ts` as `ADDITIONAL_SCOPES`; NOT covered by `gmail.modify`) — pre-existing accounts must re-auth once.
  - Shared label name↔id resolution lives in `src/commands/gmail/labels-shared.ts` (used by search + all write commands)
- ✅ Drive reads: `search`, `get`, `ls`, `permissions`, `download`, `revisions`, `activity`
  - `revisions <fileId>` lists version history (native files carry an incompleteness note; `docs revisions` is an alias); `docs download --revision <id>` fetches historical content (markdown-default for native via exportLinks, `alt=media` for binary). No new scope.
  - `activity <itemId>` is the Drive Activity API v2 timeline (create/edit/move/rename/delete/permission_change/comment; `--folder`, `--since/--until`, `--action`). Needs the `drive.activity.readonly` scope (added to `ADDITIONAL_SCOPES`; NOT implied by `auth/drive`) + `driveactivity.googleapis.com` (in `ADDITIONAL_APIS`) — **pre-existing accounts must re-auth once**.
- ✅ Slides reads: `get`, `page`, `summarize`, `comments`
  - Content extraction (`src/commands/slides/text.ts`) resolves embedded hyperlinks **inline as markdown** `[text](url)` (external `url`; internal slide links → `slide:<pageObjectId>`; nav-only links left plain), coalescing adjacent same-target runs; `page`/`summarize` report `links_resolved: N`. `comments` aliases the parameterized `docsCommentsCommand` (`resource: presentation`, `PRESENTATION_NOT_FOUND`) — Drive comments, no new scope. Spec: `specs/commands/slides-read.md`; plan: `plans/slides-links-comments.md`.
- ✅ Sheets reads: `read` — mirrors `docs read`'s tab model (a spreadsheet's sheets *are* its tabs). Always lists `sheets[N]{gid,title,index,rows,cols}`; single-tab auto-renders, multi-tab without `--tab` returns the listing to disambiguate. Grid renders as `cells[N]{row,A,B,…}` (real sheet row numbers + A1 column letters, addressing preserved for future writes) or, with `--header-row`, promotes row 1 to `rows[N]{…}`. `--range` scopes within a tab (tab-qualified range makes `--tab` optional); the default (no `--range`/`--full`) fetch is **bounded to the render window** (fast on tall sheets) and reports `cells_note` instead of a precise total when capped. FORMATTED_VALUE only (no formulas). Needs the new `spreadsheets` scope (added to `SERVICE_SCOPES` + `sheets.googleapis.com` in `REQUIRED_APIS`) — **pre-existing accounts must re-auth once**. `src/commands/sheets/read.ts`; spec: `specs/commands/sheets-read.md`; plan: `plans/sheets-read.md`.
- 🚧 Sheets writes (`update`, `append`, `clear`, `create`, `add-tab`): scaffolded stubs, `NOT_IMPLEMENTED`
- ✅ Drive writes: `upload` — push content to Drive from a local file, **stdin (`-`), or `--content <string>`** (exactly one source; stdin/`--content` require `--name`, and `--mime` defaults from the name's extension). `--parent`, `--name`, `--mime`, `--convert` (→ native Doc/Sheet/Slides), `--update <fileId>` (replace content + optional rename). **`--convert` + `--update`** is allowed when the target is already the native type the source converts to (markdown → existing Doc as a new revision — the write side of `docs read`/`diff`/`revisions`); a `files.get` rejects non-native/type-mismatch targets. No new scope (rides the full `drive` grant). Logic split into `src/util/mime-types.ts` (extension→MIME + conversion map) + `src/commands/drive/upload.ts`. Spec: `specs/commands/drive-upload.md`.
- ✅ Drive writes: `mkdir <name>` — create a folder (`files.create` with the folder MIME, no media); `--parent` nests it. Produces the folder ID `drive upload --parent` consumes. Non-idempotent (re-run → duplicate), disclosed in help. `src/commands/drive/mkdir.ts`; spec: `specs/commands/drive-mkdir.md`.
- 🚧 Drive writes (`create`, `copy`, `move`, `rename`, `delete`) and Slides writes (`create`, `update`): scaffolded stubs, `NOT_IMPLEMENTED`
- 🚧 Docs writes: `append`, `insert-text`, `delete-range`, etc. (planned, all stubbed)
- ✅ Vitest test coverage (mime, paths, gmail compose + label resolution, gmail read flags, drive revisions + activity helpers, docs download flags)
