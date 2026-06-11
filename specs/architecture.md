# Architecture

Foundational, concrete structure and model decisions for `gws-axi`. These are facts an implementer can rely on. Value judgments that resolve trade-offs live in [principles.md](principles.md); this file is the "what is" of the system.

## Tech stack & runtime constraints

- TypeScript **strict mode**, **ESM** (`"type": "module"`), **Node16** module resolution, target **ES2022**.
- **Runs under Node, not bun.** Bun is the dev/build tool only; implementations must avoid bun-specific runtime APIs because consumers run under Node. Engine requirement: `node >=20`.
- Build: `tsc` then `chmod +x dist/bin/gws-axi.js`. Dev: run TS directly via bun. Test: Vitest.
- Published unscoped on npm as `gws-axi`. Successor to four Google MCP servers (calendar, docs, slides, gmail); v1 bar is feature parity with those reads plus the documented write surface.
- Load-bearing deps: `axi-sdk-js` (CLI runtime, `AxiError`, hook install), `googleapis`, `google-auth-library`, `@toon-format/toon`.

## Entry → dispatch → handler

- Entry `bin/gws-axi.ts` → `src/cli.ts`, which calls `runAxiCli(...)` from `axi-sdk-js` with: description, version (from `package.json`), `TOP_HELP`, a `home` handler, a `commands` map, and `getCommandHelp`.
- Top-level commands: `(none)=home`, `auth`, `doctor`, `calendar`, `gmail`, `docs`, `drive`, `slides`.
- Per service: dispatcher `src/commands/<service>.ts` routes to per-subcommand handlers `src/commands/<service>/<sub>.ts`.
- A subcommand handler is `(account: string, args: string[]) => Promise<string>`: it parses its own flags (hand-rolled loop over `args`, no arg-parsing library), does the work, and returns a rendered TOON string. Each handler exports a `<SUB>_HELP` constant.
- Hooks can be disabled via `GWS_AXI_DISABLE_HOOKS=1`.

## Google API client layer (`src/google/`)

- **`client.ts`** — per-service factory functions `calendarClient` / `gmailClient` / `docsClient` / `driveClient` / `slidesClient`, each `(email) => Promise<client>`, all built on `oauthClientForAccount(email)` which seeds a `google-auth-library` `OAuth2Client` with stored tokens (access + refresh + `expiry_date` + scope) for proactive/mid-request refresh. Also exports `translateGoogleError`.
- **`tokens.ts`** — token lifecycle. `getValidAccessToken(email)` refreshes before expiry with a 5-minute safety buffer. Reads OAuth client creds from `credentials.json`; throws `CREDENTIALS_MISSING` if absent. Tokens written `0600`.
- **`probe.ts`** — doctor's live per-service read probes via raw `fetch` + bearer token; classifies `ok | warn | fail`. Scope-presence checks (`hasScope`) key off the single representative scope per service.
- **`account.ts`** — `resolveAccount` (account resolution + write-protection; single source of truth) and `accountHeaderFields`.

## Auth model

- **BYO single-user OAuth**: each user creates their own GCP project + Desktop OAuth client. No shared/embedded client in v1.
- One BYO client authenticates **multiple Google accounts**; each is added as a test user (while in Testing) and authenticates via its own loopback run.
- **Progressive setup (steps 0–7)** driven by `setup.json`: `auth setup` finds the first incomplete step, performs it (if automatable via `gcloud`) or prints a Console deep-link + instructions, marks it done, re-invokes. Automatable: project create, API enable, credentials save, loopback token grant. Manual: Desktop OAuth client creation, consent screen, test-user add.
- **Loopback prepare/wait split**: `auth login --account X` runs prepare + wait in one blocking command (for humans). Agents use `--no-wait` (prepare-only, fast) then `auth login --wait` in a separate turn to bind the callback server.
- **ID-token identity**: post-OAuth the lowercased ID-token `email` claim is the authoritative storage key; a `--account` mismatch refuses tokens (`ACCOUNT_MISMATCH`).
- **`auth publish`** walks Testing→Production to eliminate the 7-day Testing-state refresh-token expiry; doctor warns on `publishing_status=testing`.
- Lifecycle: `auth login`, `auth accounts`, `auth use <email>`, `auth revoke <email>`, `auth status`, `auth reset [--from N]`. First account auto-promotes to default; revoking the default auto-promotes another.

## Scope model (`src/auth/scopes.ts`)

- `BASE_SCOPES` = `openid email profile`.
- `SERVICE_SCOPES` = one representative scope per service: gmail→`gmail.modify`, calendar→`calendar`, docs→`documents`, drive→`drive`, slides→`presentations`.
- `ADDITIONAL_SCOPES` = scopes layered on top of a representative service scope but **not** implied by it, kept separate so per-service probes keep keying off the single representative scope. Currently `gmail.settings.basic` (Gmail filter management). Adding an entry here means pre-existing accounts must re-auth once.
- `allScopes()` = base ∪ service ∪ additional, requested together at login (single consent screen). `REQUIRED_APIS` maps each service to its `*.googleapis.com` API.

## Config layout (XDG)

All state under `$XDG_CONFIG_HOME/gws-axi/` (default `~/.config/gws-axi/`):

- `setup.json` — progressive setup state.
- `config.json` — preferences incl. `default_account`.
- `credentials.json` — the user's downloaded Desktop OAuth client JSON.
- `setup.html` — generated Console deep-link page (regenerated each `auth setup`; the only browser surface).
- `accounts/<email>/{tokens.json,profile.json}` — per-account; `tokens.json` is `0600`.

Reset = remove the config dir (or `auth reset`).

## Output system (TOON) — `src/output/`

- All output is TOON via `@toon-format/toon` `encode()`. Builders in `schema.ts`, renderers in `render.ts`, re-exported from `index.js`.
- **Schema builders** produce `FieldDef = { name, extract(item) }`: `field(name)`, `lower(name)`, `pluck(parent, child, alias?)`, `mapEnum(name, mapping, fallback, alias?)`, `computed(name, fn)`, `truncated(name, max, alias?)`. Missing values coerce to `""`.
- **Renderers**: `renderList(name, items, schema)` → `name[N]{cols}:` table; `renderObject(value)` → key/value; `renderHelp(suggestions)` → `help[N]:` block (`""` if empty); `joinBlocks(...)` → join non-empty blocks; `renderListResponse({header?, summary?, name, items, schema, suggestions?, emptyMessage?})` → composes header + summary + list (or empty scalar) + help.
- **Canonical empty-list shape**: empty `items` collapses to `{ [name]: emptyMessage ?? "0 <name> found" }`. Handlers not using `renderListResponse` replicate this by hand. (See [principles.md#canonical-empty-list-shape](principles.md#canonical-empty-list-shape).)
- **Self-describing header**: output includes `account: <email>`; `account_source: default` is added when 2+ accounts and the default was used implicitly (`accountHeaderFields`).
- `--json` exists on `doctor` only.

## Error model

- All errors are `AxiError(message, code, suggestions[])` on **stdout**; unrecoverable → non-zero exit, idempotent no-ops → exit 0.
- `translateGoogleError(err, { account, operation })` maps Google errors to `AxiError`: 401/`UNAUTHENTICATED` → `TOKEN_INVALID` (+ publish nudge when not published); 403/`PERMISSION_DENIED` insufficient-scope branch; 404 → `NOT_FOUND`, which handlers re-wrap into domain codes (e.g. `DOCUMENT_NOT_FOUND`) with access-check suggestions.
- Validation failures throw `AxiError(..., "VALIDATION_ERROR", [usage])`. Account-resolution codes: `NO_ACCOUNTS`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_REQUIRED`, `NO_DEFAULT_ACCOUNT`, `ACCOUNT_MISMATCH`.
- `doctor` exit codes: `0` ok (incl. warnings), `1` failing check, `2` usage error.

## Account resolution & write-protection (`src/google/account.ts`)

`resolveAccount(requestedAccount, { mutation, commandName })` is the single source of truth:

- 0 accounts → `NO_ACCOUNTS`.
- explicit `--account` → validate authenticated (`ACCOUNT_NOT_FOUND` else).
- exactly 1 account → use it (no flag needed).
- 2+ accounts + `mutation: true` + no `--account` → `ACCOUNT_REQUIRED`.
- 2+ accounts + read + no `--account` → use default; if none set → `NO_DEFAULT_ACCOUNT`.

The `mutation` flag is declared per subcommand in each service's dispatcher.

## --help routing

Services with a real dispatcher (e.g. Calendar) handle `--help` themselves so `<service> <sub> --help` shows subcommand-specific help; these are **omitted** from `COMMAND_HELP` in `cli.ts`. Pure help-printing stubs (`auth`, `doctor`) stay in `COMMAND_HELP` and use the SDK auto-help map. `TOP_HELP` is itself TOON-shaped.

## SessionStart hook

On first invocation, `gws-axi` self-installs a SessionStart hook (via `axi-sdk-js`) into `~/.claude/settings.json` and `~/.codex/hooks.json`. The hook runs `gws-axi --summary`, emitting one compact state line (setup progress / healthy / failing).
