# gws-axi

Agent-ergonomic CLI for Google Workspace — Gmail, Calendar, Docs, Drive, Slides, Sheets, and Chat behind a single command, built to the [AXI standard](https://axi.md): [TOON](https://toonformat.dev/)-formatted output, contextual next-step suggestions, idempotent mutations, and multi-account safety by default.

Designed for use by AI agents. Every response is structured, every error names a specific fix, and write operations lock to the explicit account when multiple are authenticated — so two agents in parallel sessions can't silently touch the wrong mailbox.

## Contents

- [Status](#status)
- [Requirements](#requirements)
- [Getting started](#getting-started)
  - [1. Install](#1-install)
  - [2. Let an agent walk you through setup](#2-let-an-agent-walk-you-through-setup)
  - [3. Check it works](#3-check-it-works)
  - [4. Make gws-axi your agent's default](#4-make-gws-axi-your-agents-default-for-google-workspace)
  - [Prefer to drive it manually?](#prefer-to-drive-it-manually)
- [How it works](#how-it-works)
  - [Output and errors](#output-and-errors)
  - [Accounts](#accounts) · [Write protection](#write-protection) · [Pinning an agent to one account](#pinning-an-agent-to-one-account)
- [Usage](#usage)
  - [Home, auth, and health](#home-auth-and-health) · [Signing in from a phone or remote machine](#signing-in-from-a-phone-or-remote-machine)
  - [Calendar](#calendar)
  - [Gmail](#gmail)
  - [Docs](#docs) · [Reading](#reading-docs) · [Writing Markdown](#writing-markdown) · [Tabs](#tabs) · [Editing in place](#editing-in-place)
  - [Drive](#drive)
  - [Slides](#slides)
  - [Sheets](#sheets)
  - [Chat](#chat)
- [Known issues & roadmap](#known-issues--roadmap)
- [Design docs](#design-docs)
- [Contributing](#contributing) · [License](#license)

## Status

Read coverage is complete across all seven services; write coverage is rolling out service by service.

| Service | Reads | Writes |
| --- | --- | --- |
| **Calendar** | ✅ events · get · calendars · search · freebusy | ✅ create · update · delete · respond |
| **Gmail** | ✅ search · read · labels · download | ✅ triage · draft · labels · filters &nbsp;·&nbsp; ✋ `send` out of scope |
| **Docs** | ✅ read · find · comments · download · revisions · diff · tabs | ✅ create · write · append · replace-text · edit-cell · tabs update/delete &nbsp;·&nbsp; 🚧 insert-text · delete-range · style-text · style-paragraph · insert-table · comment writes |
| **Drive** | ✅ ls · get · search · permissions · download · revisions · activity | ✅ upload · mkdir · rename · move · trash · untrash · share · unshare &nbsp;·&nbsp; 🚧 create · copy &nbsp;·&nbsp; ✋ permanent delete |
| **Slides** | ✅ get · page · summarize · comments | ✅ skip · unskip &nbsp;·&nbsp; 🚧 create · update |
| **Sheets** | ✅ read · cell · comments | ✅ update · append · clear · create · add-tab · note |
| **Chat** | ✅ spaces · messages · search · members · download · wait · watch | ✅ send · react · unreact · mark-read · mark-unread |

<sub>✅ shipped · 🚧 planned · ✋ out of scope by design</sub>

Auth (including the single-developer `auth publish` walkthrough that retires the 7-day Testing-token expiry, and sign-in from a phone or over SSH), `doctor` with live per-account API probes, and multi-account write protection are stable. Gmail **`send` is intentionally out of scope** — gws-axi drafts mail for human review but never sends it. Chat **does** send: it has no drafts, so there is nothing to stop at. Drive has no permanent delete — `trash` is reversible for 30 days.

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

The explicit `gws-axi auth setup` in the prompt matters: this is your very first session, so the agent doesn't yet have any ambient context about `gws-axi`. Naming the first command gets the agent into the structured flow, where the CLI's output takes over. Once you install the SessionStart hook (see [step 4](#4-make-gws-axi-your-agents-default-for-google-workspace)), every subsequent session auto-loads a compact `gws-axi` status line — so after that, you can skip the command and just say "use gws-axi to ..." and the agent knows.

Expect ~10 minutes end-to-end for a fresh Google Cloud project; ~3 minutes if you already have one you want to reuse.

**What happens during setup:** you create your own Google Cloud project with OAuth credentials, enable the Workspace APIs, configure the consent screen, and add your Google accounts as test users. This is the [**bring-your-own OAuth client**](docs/shared-client-future.md) model — avoids public-app verification overhead and keeps the blast radius of any token revocation scoped to you. Tokens live locally at `~/.config/gws-axi/`.

The CLI generates an auto-refreshing HTML helper page (`~/.config/gws-axi/setup.html`) with clickable Console deep-links — so you never copy long URLs from terminal to browser and you stay in the right browser profile throughout.

**Joining a colleague's OAuth client instead:** if someone on your team already runs a gws-axi OAuth client and has added you as a test user, they can hand you its `credentials.json` and you skip the Console steps entirely:

```bash
gws-axi auth join ~/Downloads/credentials.json            # marks setup steps 1–6 done
gws-axi auth join ~/Downloads/credentials.json --published  # if their consent screen is in Production
gws-axi auth login --account you@example.com
```

The distributor's side is in [`docs/shared-client-onboarding.md`](docs/shared-client-onboarding.md).

### 3. Check it works

```bash
gws-axi doctor                           # setup + live API health
gws-axi calendar events                  # upcoming 7 days on your primary calendar
```

### 4. Make gws-axi your agent's default for Google Workspace

gws-axi gives agents two complementary ways to pick up ambient context (per [AXI principle 7](https://axi.md) — context is delivered through hooks and installable skills, and installation is always explicit opt-in, never a side effect of ordinary commands):

```bash
gws-axi setup hooks
```

This installs a **SessionStart hook** into your agent's config — Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/hooks.json`), and OpenCode. From then on, every new agent session sees a compact `gws-axi` status line in ambient context — authenticated accounts, write-protection status, setup health. The command is idempotent and self-repairing: re-run it any time (e.g. after upgrading or moving the install) and it repairs a stale executable path without duplicating entries. There is no auto-install — the hook only appears when you run `setup hooks`.

The hook and an installable skill are the two ambient-context paths: the hook injects current state at session start, while a skill can teach the agent the full command surface on demand. Run `gws-axi setup hooks` to get the hook in place.

To make sure agents reach for `gws-axi` instead of stale alternatives, also consider:

- **Remove existing Google Workspace MCP servers and skills.** If you already have Gmail / Calendar / Drive / Docs / Slides integrations installed (community MCP servers, bespoke skills, etc.), disable them. Keeping both creates ambiguity — agents may pick whichever they noticed first, and the tools have different auth models, flag names, and output shapes. Typical candidates to disable: `google-calendar-mcp`, `gmail-mcp`, `google-docs-mcp`, any `@modelcontextprotocol/server-google-*`, and skills with similar names.

- **Add a directive to your `CLAUDE.md`.** A short note in your project-level (`.claude/CLAUDE.md`) or user-level (`~/.claude/CLAUDE.md`) file nudges agents to consistently use `gws-axi`. Example:

  ```markdown
  ## Google Workspace

  Use `gws-axi` for ALL Google Calendar, Gmail, Docs, Drive, Slides, Sheets, and
  Chat interactions. Check the SessionStart `gws-axi` line for current auth
  state; run `gws-axi --help` for the command surface. Prefer this over
  any other Google integrations.
  ```

### Prefer to drive it manually?

The CLI works fine without an agent — each `gws-axi auth setup` invocation prints its own instructions and updates `setup.html`. Run it repeatedly as you complete each step; no state is lost between invocations.

## How it works

Every command shares the same output shape and the same account rules, so these apply to all of [Usage](#usage) below.

### Output and errors

Output is TOON: a few header fields, then compact tables, then `help[]` lines suggesting what to run next.

```
account: you@example.com
account_source: default
count: 3
range: "2026-04-20T10:00:00-04:00 → 2026-04-27T10:00:00-04:00"
events[3]{id,summary,start,end,my_response}:
  abc123,Team standup,"2026-04-21T10:00:00-04:00","2026-04-21T10:15:00-04:00",accepted
  def456,1:1 with Ari,"2026-04-22T11:30:00-04:00","2026-04-22T12:00:00-04:00",accepted
  ghi789,Board meeting,2026-04-25,2026-04-26,needsAction
help[2]:
  Run `gws-axi calendar get <id>` for full event details (id is the first column)
  Add `--fields attendees,location,status` to show more columns
```

Errors are structured too: a stable `code` (`ACCOUNT_REQUIRED`, `SCOPE_MISSING`, `MULTIPLE_MATCHES`, …) and suggestions naming the fix. An unknown flag is an error, never silently ignored — a misspelled `--free` can't be reported as a success that didn't do what was asked.

### Accounts

#### Write protection

gws-axi supports multiple Google accounts under one OAuth client. When two or more are authenticated, write operations require `--account <email>` explicitly — silent wrong-account mutations are impossible:

```bash
gws-axi calendar events                         # read: uses default account
gws-axi calendar create --summary "..."         # write: ACCOUNT_REQUIRED error
gws-axi calendar create --account you@example.com --summary "..."  # OK
```

#### Pinning an agent to one account

`GWS_AXI_ACCOUNT` pins every command in an environment to one authenticated account. Unlike the default account, nothing inside that environment can change it, and unlike `--account`, the agent doesn't get to choose per call:

```bash
export GWS_AXI_ACCOUNT=you@example.com

gws-axi calendar events                          # acts as you@example.com
gws-axi calendar create --summary "..."          # OK — no --account needed
gws-axi calendar events --account other@x.com    # ACCOUNT_LOCKED — refused, not overridden
```

The pin beats `default_account`, and it **satisfies write protection**: it is already the explicit account choice, made once by whoever configured the environment. Every response says so with `account_source: env`. A pin naming an account that isn't authenticated fails every command with `ACCOUNT_LOCK_INVALID` rather than quietly falling back — a typo must not become "acted as somebody else."

This is an **accident boundary, not a security boundary** — anything that can run `gws-axi` can also `unset GWS_AXI_ACCOUNT`. For a real boundary, give the agent a config directory holding only that account's tokens, and use both together:

```bash
export XDG_CONFIG_HOME=/srv/agent-home/config   # bounds which accounts exist at all
export GWS_AXI_ACCOUNT=you@example.com          # bounds which one is used
```

Apart from `SSH_CONNECTION`, which only changes the sign-in instructions, these two are the only environment variables gws-axi reads.

## Usage

Every subcommand supports `--help`. The bare `gws-axi` command prints current state, authenticated accounts, and top suggestions.

### Home, auth, and health

```bash
gws-axi                                  # home view — current state + suggestions
gws-axi auth accounts                    # list authenticated Google accounts
gws-axi auth status                      # terse one-line status
gws-axi auth login --account <email>     # add or re-auth an account (blocks on callback)
gws-axi auth login --account <email> --no-wait  # agent-friendly split: prepare now…
gws-axi auth login --wait                       # …then block on the callback in a separate call
gws-axi auth use <email>                 # set the default account
gws-axi auth revoke <email>              # delete an account's tokens
gws-axi auth publish                     # walk Testing → Production to retire 7-day token expiry
gws-axi doctor                           # prerequisites + setup + live API probes
```

When a new feature needs a scope your account doesn't have yet, the command fails with `SCOPE_MISSING` and `doctor` names the account to re-auth — run `gws-axi auth login --account <email>` once to re-consent.

#### Signing in from a phone or remote machine

The sign-in callback goes to `http://127.0.0.1:<port>/` on the machine running gws-axi. While `auth login --wait` listens (up to 9 minutes, and safe to re-run), that same address also serves the setup page, so a single forward is enough over SSH:

```bash
ssh -L <port>:127.0.0.1:<port> <host>     # port is in the --no-wait output
```

When the browser approving the sign-in can't reach the machine at all — a phone, or a laptop that isn't forwarding — Google's redirect lands on a `127.0.0.1/callback?code=…` page that fails to load. Copy that address and finish with it:

```bash
gws-axi auth login --callback-url 'http://127.0.0.1:<port>/callback?code=…&state=…'
```

A prepared sign-in stays valid for 30 minutes. Under SSH, the prepare output also includes `auth_url`, Google's sign-in link, for the agent to hand you directly.

### Calendar

**Reads:**

```bash
gws-axi calendar events                  # upcoming 7 days on primary
gws-axi calendar events --today          # or --this-week
gws-axi calendar events --from 2026-04-20 --to 2026-04-20   # all of Apr 20 (a date-only --to closes at end of day)
gws-axi calendar events --from today --to +2w               # tokens: now, today, tomorrow, yesterday, +Nd, +Nw, +Nh
gws-axi calendar events --fields attendees,location,status,availability
gws-axi calendar events --fields join_url,conference  # provider-uniform join link (Meet/Zoom/Teams/Webex)
gws-axi calendar get <event-id>          # full detail + attendees + conference block
gws-axi calendar get <event-id> --full   # don't truncate description
gws-axi calendar calendars               # list calendars accessible to this account
gws-axi calendar search --query "standup"  # primary calendar by default
gws-axi calendar search --query "review" --include-shared  # include delegated + subscribed
gws-axi calendar freebusy --calendars primary,team@example.com --this-week  # cross-calendar availability
```

**Writes:**

```bash
gws-axi calendar create \
  --summary "Team sync" --start 2026-04-22T14:00 --duration 30m

gws-axi calendar create --summary "Focus block" --start 2026-04-22T09:00 --duration 2h --free

gws-axi calendar create --summary "Planning" --start 2026-04-22T10:00 \
  --attendees ana@example.com,raj@example.com --recurrence "RRULE:FREQ=WEEKLY;BYDAY=MO"

gws-axi calendar update <event-id> \
  --summary "Team sync (rescheduled)" --start 2026-04-22T15:00

gws-axi calendar update <event-id> --add-attendees eve@example.com   # or --remove-attendees / --replace-attendees

gws-axi calendar delete <event-id>       # idempotent (404/410 → noop)

gws-axi calendar respond <event-id> --response accepted
```

Writes default `--send-updates` to `none` so agent-created events don't spam attendees. Pass `--send-updates all` for production-style invite behavior. `--free` / `--busy` set whether the event blocks your availability.

Every time is shown with your local offset, whatever zone the calendar or event was set in; a differing zone is noted (`set in <zone>`) rather than applied. Join links for Teams, Zoom, and Webex meetings organized outside Google are often only in the description — gws-axi pulls them from there and says when it did (`conference_source`).

### Gmail

**Reads:**

```bash
gws-axi gmail search                              # in:inbox by default
gws-axi gmail search --query "from:alice has:attachment"
gws-axi gmail search --page <token>               # paginate
gws-axi gmail read <thread-or-message-id>         # whole thread, text/plain preferred
gws-axi gmail read <id> --message-only            # just one message
gws-axi gmail read <id> --headers                 # plus the full RFC 2822 header set
gws-axi gmail read <id> --raw                     # the message exactly as Gmail stores it
gws-axi gmail read <id> --out ./thread.md         # write the full thread to a markdown file
gws-axi gmail labels                              # list labels with IDs
gws-axi gmail download <message-id> <attachment-id>  # fetch attachment bytes
```

**Writes** (triage, drafting, labels, filters — but never *send*):

```bash
# Triage — Gmail state IS labels, so archive/read/star are label edits:
gws-axi gmail modify <message-id> --remove-label INBOX        # archive
gws-axi gmail modify <message-id> --remove-label UNREAD       # mark read
gws-axi gmail modify <message-id> --add-label STARRED         # star
gws-axi gmail modify <message-id> --add-label "Work/Clients" --remove-label INBOX
gws-axi gmail modify <thread-id> --thread --remove-label UNREAD  # whole thread

# Bulk triage by query:
gws-axi gmail batch-modify --query "from:news@x.com" --remove-label INBOX
gws-axi gmail batch-modify --query "is:unread older_than:30d" --remove-label UNREAD

# Drafts (composed for you; you send from Gmail):
gws-axi gmail draft --to alice@x.com --subject "Re: budget" --body "Approved."
gws-axi gmail draft --to rfp@agency.gov --subject "RFI response" --body-file ./cover.md --attach ./response.docx   # with attachments (25 MB total)
gws-axi gmail draft --to a@x.com,b@x.com --subject Hi --body-file ./note.txt --thread <id> --plain

# Label management:
gws-axi gmail label-create --name "Work/Clients"
gws-axi gmail label-update <label-id|name> --name "Archive"
gws-axi gmail label-delete <label-id|name>

# Server-side auto-sort filters:
gws-axi gmail filter-list
gws-axi gmail filter-create --from news@x.com --remove-label INBOX --add-label News
gws-axi gmail filter-delete <filter-id>
```

Draft bodies are Markdown, sent as HTML; `--plain` sends the body as literal text with indentation kept. Each message in `gmail read` carries `sent` (local-offset time) beside the verbatim `Date` header. Bodies are decoded per declared `Content-Type` charset (UTF-8, latin-1, ascii, utf-16). HTML-only messages convert to markdown via turndown. Address headers parse with `addressparser` so display names with commas don't get split.

**On `send`:** gws-axi has no `send` command by design — an agent can triage, label, and draft replies, but a human reviews and sends from Gmail. This is a guardrail against *accidental* sends, not a hard security boundary (the OAuth token is send-capable; there is no Gmail scope that grants drafting + label edits while withholding send). `gws-axi gmail send` returns a `NOT_SUPPORTED` error pointing at `draft`. The one exception is `filter-create --forward`, which forwards matching mail automatically, but only to an address you have already verified in Gmail's forwarding settings.

**Scope note:** the filter commands need the `gmail.settings.basic` scope, which `gmail.modify` does not include. Accounts authenticated before filters shipped get `SCOPE_MISSING` (403) on filter commands until they re-auth once.

### Docs

#### Reading Docs

```bash
gws-axi docs read <documentId>                    # full Doc as markdown (+ recent revisions inline)
gws-axi docs read <documentId> --tab t.0 --out ./tab.md   # one tab, written to a file
gws-axi docs find <documentId> --query "deadline" # search inside one Doc, tables included
gws-axi docs comments <documentId>                # threaded comments + suggestions
gws-axi docs revisions <documentId>               # version history (id, modified, author)
gws-axi docs diff <documentId> <revA> [revB]      # unified diff between two revisions (revB defaults to head)
gws-axi docs download <documentId> --as application/pdf   # native export (pdf, docx, odt, txt, html, epub, rtf)
gws-axi docs download <documentId> --revision <id>        # fetch a past revision's content (markdown by default)
```

Every `docs read` carries the document's recent revisions and points at `docs revisions` / `docs download --revision` / `docs diff` — so an agent always knows which version it read. Non-native files (uploaded `.docx`, `.pdf`, etc.) get pointed at `docs download` automatically rather than failing with a cryptic Google API error.

#### Writing Markdown

```bash
gws-axi docs create --title "Sprint notes" ./notes.md --account you@example.com        # new Doc from Markdown (--parent <folderId> to file it)
gws-axi docs write <documentId> ./tab.md --tab t.0 --account you@example.com           # replace ONE tab's content
gws-axi docs write <documentId> ./notes.md --new-tab "Decisions" --account you@example.com   # add a tab and fill it
gws-axi docs append <documentId> --content "## Update" --tab t.0 --account you@example.com   # add to the end of a tab
```

`docs create` / `write` / `append` turn Markdown into a Doc through gws-axi's own converter and touch exactly one tab, so `docs read --tab` → edit → `docs write --tab` is a safe loop on a multi-tab Doc. The write is refused if the Doc changed since it was read. Prefer these over `drive upload --convert` for Markdown: the result reads back with `docs read`, and it doesn't leave the gap Google's importer puts above a first heading.

What the converter handles:

- **Text:** headings, emphasis, code, links, lists, tasks, quotes, images by URL, footnotes.
- **Rules and page breaks:** `---` is a rule; two in a row (blank lines between) are a page break.
- **Tables:** `<br>` and `- item` lines inside cells; merged cells in the [`marked-extended-tables`](https://github.com/calculuschild/marked-extended-tables) syntax (`| wide |||` spans columns, `| ^|` continues the cell above, several header rows); and column widths from a hint on the line above the table — `<!-- cols: 1 3 -->`, `<!-- cols: 25% 75% -->`, or `<!-- cols: fit 1 -->` to size a column to its content. `docs read` writes these hints back.
- **Frontmatter:** a leading YAML block is metadata, not content. It is stripped and reported by default; `--frontmatter keep` writes it as text, `--frontmatter table` as a label/value table at the top. `drive upload --convert` strips it too.
- **Spacing:** space between paragraphs comes from paragraph styles, never empty paragraphs. If a tab's Normal text has no paragraph spacing at all, the write sets Docs' own 10pt default and says how to undo it.

What the Docs API can't represent (a checked task, a code block's language) is written as text and listed under `lossy[]`. `gws-axi docs write --help` documents the full dialect.

#### Tabs

```bash
gws-axi docs tabs <documentId>                                                               # list tabs (id, title, index, parent, emoji)
gws-axi docs write <documentId> ./round-3.md --new-tab "Round 3" --first --emoji 📝 --account you@example.com   # new tab, placed first, with an icon
gws-axi docs tabs update <documentId> t.k3j2 --first --title "Current" --account you@example.com   # move / rename / mark a tab
gws-axi docs tabs delete <documentId> t.k3j2 --account you@example.com                       # delete a tab (children need --with-children)
```

`--new-tab` takes a placement — `--first`, `--last`, `--before <tabId>`, `--after <tabId>`, `--under <tabId>` — and `--emoji`, so a "regenerate into a new tab each round" workflow lands the newest round where readers open the Doc. `docs tabs update` moves, nests, renames or marks an existing tab with the same flags (plus `--top-level`, `--no-emoji`, and `--paragraph-spacing <pt>` for a tab whose Normal text runs paragraphs together), is idempotent, and lists the resulting order with an undo line. `docs tabs delete` lists everything it removed and points at version history.

#### Editing in place

```bash
gws-axi docs replace-text <documentId> --find "Generating" --replace "Refining" --tab t.0 --account you@example.com   # change text in place, formatting kept
gws-axi docs edit-cell <documentId> --row "State" --text "**Refining**" --account you@example.com   # replace one table cell by its row label
```

`docs replace-text` is the surgical alternative to rewriting a tab: a literal find/replace scoped to one tab, keeping every style around it (a bold cell stays bold). It counts matches first — more than one is refused unless `--all`, none is `action: no_match` — and lists each occurrence as it read before the change. `--ignore-case` relaxes the match; `--replace ""` deletes.

`docs edit-cell` replaces one table cell, found by the label in its row's first cell (or `#n` for a row number), with `--table n` / `--col n` to pick others. The cell gets the same Markdown handling as a new table's cells; column widths and every other cell are left alone. The response shows the cell's previous content, so the undo is one command.

### Drive

**Reads:**

```bash
gws-axi drive ls                                  # top of My Drive
gws-axi drive ls <folder-id> --recursive          # depth-unbounded; bounded by --limit instead
gws-axi drive get <fileId>                        # metadata for one file
gws-axi drive search --query "name contains 'budget'"
gws-axi drive permissions <fileId>                # who has access
gws-axi drive revisions <fileId>                  # version history (any file type)
gws-axi drive activity <itemId>                   # attributed change timeline (Drive Activity API)
gws-axi drive activity <folderId> --folder --action permission_change,delete --since -30d   # a whole folder tree, filtered
gws-axi drive download <fileId> --out ./file      # fetch bytes / export a native file
```

`drive activity` names the people involved from your own directory; outside collaborators stay as `people/<id>`, and the response says how many it couldn't name.

**Writes:**

```bash
gws-axi drive mkdir "Reports" --parent <folderId> --account you@example.com   # create a folder (--parent also works on upload)
gws-axi drive rename <id> --name "New name" --account you@example.com
gws-axi drive move <fileId> --to <folderId> --account you@example.com   # file it in another folder
gws-axi drive trash <fileId> --account you@example.com           # to the trash (drive untrash restores; no permanent delete)
gws-axi drive share <id> --with lead@school.org --role reader --account you@example.com   # emails them by default; --no-notify, --group
gws-axi drive unshare <id> --with lead@school.org --account you@example.com
gws-axi drive upload ./report.pdf --account you@example.com     # upload a local file
echo '# Notes' | gws-axi drive upload - --name notes.md --convert --account you@example.com   # stdin → native Doc
gws-axi drive upload --content '# Notes' --name notes.md --convert --account you@example.com   # inline content → native Doc
gws-axi drive upload ./edited.md --convert --update <docId> --account you@example.com          # replace a Doc's content (new revision)
```

`drive upload` takes content from a local path, `-` (stdin), or `--content`; `--convert` hands it to Google's importer for the matching native format. With `--update` it replaces an existing file's content — and when that file is already the matching native type, `--convert --update` writes edited markdown back into the same Doc as a new revision. That replaces the whole file: a Doc with several tabs or a spreadsheet with several sheets is refused (`MULTI_TAB_TARGET`) unless you pass `--replace-all-tabs`, because the import would collapse them to one. For one tab, use `docs write --tab`; for one sheet, `sheets update --tab`.

`drive share` only grants access to named people and groups. Making a file public or domain-wide is refused, with no override.

### Slides

```bash
gws-axi slides get <presentationId>               # deck metadata + slide list
gws-axi slides page <presentationId> <slideId>    # one slide's content
gws-axi slides summarize <presentationId>         # all slides condensed to text per slide
gws-axi slides comments <presentationId>          # review comments (Drive comments)
gws-axi slides skip <presentationId> <slideId>... --account you@example.com   # hide slides in presentation mode (unskip to show)
```

<sub>Embedded hyperlinks in slide text resolve inline as markdown `[text](url)` (with `links_resolved: N` in the header); images/videos are counted, not inlined. Skipped slides are marked in every read.</sub>

### Sheets

A spreadsheet's tabs are its sheets, so `sheets read` mirrors `docs read`: it lists the tabs, and renders one tab's grid into context. Embedded links resolve inline as markdown `[text](url)`; cell notes come back in a `notes[]` block, formulas in `formulas[]`, and formula errors in `errors[]` with a runnable fix line each.

```bash
gws-axi sheets read <spreadsheetId>                       # single tab renders; multi-tab lists tabs to pick
gws-axi sheets read <spreadsheetId> --tab Costs           # by tab title (or numeric gid)
gws-axi sheets read <spreadsheetId> --tab Costs --range A1:D50   # scope to an A1 range
gws-axi sheets read <spreadsheetId> --header-row          # promote row 1 to column names (auto for a frozen top row; --raw to force letters)
gws-axi sheets read <spreadsheetId> --tab Costs --formulas       # formulas in the grid instead of their values
gws-axi sheets read <spreadsheetId> --tab Costs --full    # don't cap at 50 rows
gws-axi sheets cell <spreadsheetId> D2 --tab Costs        # one cell: formula, value, error, and the values it reads
gws-axi sheets comments <spreadsheetId>                   # review comments (Drive comments)
```

The writes put **values** into one tab and leave everything else — formats, widths, validation, other tabs — as it was. Values come as CSV (default), TSV, or a JSON 2-D array (`null` leaves a cell as it is), from a file, `-`, or `--content`. Strings are parsed as typed (`=formulas`, dates, currencies) unless `--raw`.

```bash
gws-axi sheets update <id> --tab Costs --range B2 costs.csv --account <email>    # a block anchored at B2
gws-axi sheets update <id> --tab Costs --cell B5=4800 --cell D2='=B2*C2' --account <email>
gws-axi sheets append <id> --tab Tasks --json --content '[{"Name":"Ship","Status":"open"}]' --account <email>   # keyed by row 1
gws-axi sheets update <id> --tab Tasks --json --key Name --content '[{"Name":"Ship","Status":"done"}]' --account <email>   # edit the row labelled Ship
gws-axi sheets clear  <id> --tab Costs --range B2:D9 --account <email>          # values only
gws-axi sheets create --title "Q4" costs.csv --tab Costs --tab Notes --header --parent <folderId> --account <email>
gws-axi sheets add-tab <id> --title Q4 q4.csv --after Q3 --account <email>
```

Every write reads back what Sheets made of it: each formula's result or error (`formulas[]`), the cells it replaced with their previous values (`written[]` — the undo), and any formula errors it caused anywhere in the tab (`errors[]`, with a fix line each). Re-running an `update` that changes nothing is `action: unchanged`; `--header` freezes row 1 so `sheets read` names columns by it.

<sub>Cell values are the displayed strings. `drive upload --convert` is the other way in from CSV — Google's importer, whole-file; the `sheets` writers write values, one tab at a time.</sub>

A cell's **note** — the annotation `sheets read` lists in `notes[]` and `sheets cell` shows — is set, replaced or cleared one cell at a time. Only the note changes; the value and its format stay. The previous note comes back as `note.before` with an undo line, and the same text again is `action: unchanged`.

```bash
gws-axi sheets note <id> B2 --tab Costs --text 'source: Q3 invoice' --account <email>
gws-axi sheets note <id> 'Costs!B2' --clear --account <email>
```

### Chat

Reads Google Chat over the ordinary Chat API — no Workspace Developer Preview enrollment, and it works for personal `@gmail.com` accounts as well as Workspace ones.

```bash
gws-axi chat spaces                               # conversations, most recently active first
gws-axi chat spaces --type dm --name bob          # narrow by kind and by name
gws-axi chat messages <space>                     # the latest 50, shown oldest first
gws-axi chat messages --with bob@example.com      # the 1:1 direct message with someone
gws-axi chat messages <space> --since today       # --since/--until take dates and tokens (today, -7d, now)
gws-axi chat messages <space> --fields attachments,reactions
gws-axi chat search budget --since -7d            # across every conversation
gws-axi chat search --space <space> --has-attachment   # or --has-link
gws-axi chat search --mentions-me --unread
gws-axi chat members <space>
gws-axi chat download <space> <messageId>        # save a message's attachments
gws-axi chat wait <space> --thread <id>          # block until the next reply arrives, then exit
gws-axi chat watch --all --mentions-me           # one line per new message, for a line-per-event monitor

gws-axi chat send <space> --text "Feed is back up — @bob@example.com can you confirm?" --account you@example.com   # SENDS; @email mentions
gws-axi chat send <space> --thread <id> --body-file reply.md --account you@example.com
gws-axi chat send <space> - --request-id deploy-4821 --account you@example.com  # stdin; safe to retry
gws-axi chat react <space> <messageId> --emoji 👍 --account you@example.com  # unreact takes it back
gws-axi chat mark-read <space> --account you@example.com
gws-axi chat mark-unread <space> --from <messageId> --account you@example.com
```

Conversations are addressed by id (from `chat spaces`) or by `--with <email>` — never by name, since names aren't unique and direct messages have none. Direct messages and unnamed group chats are listed under a name derived from their members.

<sub>Message text is Markdown, with mentions as `@Name`. Reading never changes what is marked read. Search has gaps — it omits app messages, muted conversations, and has been seen to miss recent direct messages — and says so on every response. Uploaded attachments save with `chat download`; Drive-file ones point at `docs download`. The new Chat scopes mean existing accounts must `gws-axi auth login` once.</sub>

<sub>`chat wait` and `chat watch` poll (every 15s; 30s with `--all`), skip your own messages unless `--include-mine`, and never mark anything read. Every run ends with a cursor; `--after <cursor>` resumes with nothing skipped or repeated. Default timeouts — 9m for `wait`, 29m for `watch` — sit just under common agent-harness limits, and a timeout exits 0.</sub>

<sub>`chat send` posts immediately to **one** conversation and can't be undone from gws-axi. The body is Markdown; mention someone with `@` + their email (`@bob@example.com`) — they must be in the conversation, or nothing is sent. Pass `--request-id` to make a send safe to retry — a second send with the same id posts nothing. Sending needs a Chat app configured on your Google Cloud project (Chat API → Configuration); its name appears beside each message. Marking read is conversation-level only: Google's API can't mark a thread read.</sub>

## Known issues & roadmap

- **Gmail `send`**: intentionally unsupported — gws-axi drafts mail but leaves sending to a human in the Gmail UI. See [Gmail](#gmail).
- **Docs writes**: `create` / `write` / `append` (Markdown into one tab), `replace-text`, `edit-cell` and `tabs` management are shipped; positional edits (`insert-text`, `delete-range`, `style-*`, `insert-table`) and comment writes are scaffolded as `NOT_IMPLEMENTED`.
- **Docs API gaps** — Docs has these, and Google's own importer (`drive upload --convert`) produces them, but the Docs API can't write them, so the Markdown writers can't either. Each write lists what it dropped under `lossy[]`; each gap is tracked until Google adds it ([`upstream-blocked`](https://github.com/JarvusInnovations/gws-axi/labels/upstream-blocked)):
  - native code blocks and their language — written as monospace lines ([#83](https://github.com/JarvusInnovations/gws-axi/issues/83))
  - checked tasks — written unchecked, and `docs read` can't see the state either ([#84](https://github.com/JarvusInnovations/gws-axi/issues/84))
  - image alt text ([#85](https://github.com/JarvusInnovations/gws-axi/issues/85))
  - a native horizontal rule — written as a bordered empty paragraph ([#86](https://github.com/JarvusInnovations/gws-axi/issues/86))
- **Revision exports cover every tab**: `docs diff` and `docs download --revision` export the whole Doc, so on a multi-tab Doc they include all tabs ([#110](https://github.com/JarvusInnovations/gws-axi/issues/110)).
- **Drive writes**: `upload`, `mkdir`, `rename`, `move`, `trash`, `untrash`, `share`, and `unshare` are shipped; `create` / `copy` are still scaffolded as `NOT_IMPLEMENTED`. There is no permanent delete by design — `trash` is reversible for 30 days.
- **Slides writes**: `skip` / `unskip` (hide slides in presentation mode) are shipped; `create` / `update` are still scaffolded as `NOT_IMPLEMENTED`.
- **Sheets writes** set values and the top-row freeze only: no formatting, widths, validation, tab rename/reorder/delete, or row/column insertion yet. Sheets exposes no revision id, so the undo is the `written[]` block plus the editor's version history.
- **Sheets notes**: `sheets note` writes one cell's note per call; there is no batch form. Comments (`sheets comments`) are read-only.
- **Testing-mode tokens** still expire every 7 days *if* you haven't published your OAuth app yet. Run `gws-axi auth publish` for the walkthrough — it covers the single-developer Production flow and removes the expiry once you've re-auth'd each account.

## Design docs

- [`docs/design.md`](https://github.com/JarvusInnovations/gws-axi/blob/main/docs/design.md) — architecture, auth model, doctor tiers, command surface
- [`docs/shared-client-future.md`](https://github.com/JarvusInnovations/gws-axi/blob/main/docs/shared-client-future.md) — why BYO-only for v1, what a shared-client public distribution would involve
- [`docs/shared-client-onboarding.md`](https://github.com/JarvusInnovations/gws-axi/blob/main/docs/shared-client-onboarding.md) — running a client your teammates `auth join`
- [`specs/`](https://github.com/JarvusInnovations/gws-axi/tree/main/specs) — per-command behavior specs, the source of truth for what each command does

## Contributing

Issues and PRs welcome at [github.com/JarvusInnovations/gws-axi](https://github.com/JarvusInnovations/gws-axi).

## License

MIT — see [LICENSE](LICENSE).
