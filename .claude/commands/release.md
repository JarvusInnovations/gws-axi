---
description: Draft and publish release notes for the open release PR — merging fires release-publish + publish-npm.yml.
---

# Release

Draft and publish release notes for the latest open release PR.

Pushes to `develop` auto-open/update a release PR against `main` via `release-prepare.yml`. Your job here: find that PR, draft clean notes, recommend a version, update the PR, and merge. The `release-publish` workflow then creates the GitHub release, which fires `publish-npm.yml` and ships to npm.

## Steps

1. **Find the release PR**: Run `gh pr list --state open --json number,title --repo JarvusInnovations/gws-axi` and find the PR whose title matches "Release: v*". If none found, stop and tell the user — they may need to push a commit to `develop` to trigger `release-prepare`.

2. **Get PR details**: Run `gh pr view <number> --json title,body,number,url --repo JarvusInnovations/gws-axi` to get the current PR state.

3. **Get the changelog comment**: Run `gh api repos/JarvusInnovations/gws-axi/issues/<number>/comments --jq '.[] | select(.body | contains("## Changelog")) | .body'` to extract the bot-generated changelog. Parse the commit lines from inside the markdown code block.

4. **Sort commits into two sections** based on whether agents/developers using gws-axi would care about the change, or only contributors to the tool would:
   - **What's New**: New commands, new subcommands, new flags, new output schema fields, auth/setup improvements, behavior fixes that affect what agents see when they run the CLI. These matter to people running gws-axi.
   - **Technical**: CI/CD, refactoring, internal tooling, dependency bumps, chores. Note: `feat(ci)` and similar contributor-scoped `feat` commits are Technical. `docs` commits are Technical unless they clearly change user-facing guidance (e.g. a README install-flow rewrite).

   Keep the commit lines exactly as formatted in the changelog (including `@username` suffixes).

5. **Draft release notes** in this format:

   ```markdown
   <Narrative intro — 2-4 sentences in prose, written for npm/GitHub readers who don't follow the repo day-to-day. Lead with the headline capability, then call out anything else users should know. Include this for any release shipping meaningful new capability (new service, new commands, significant UX shift). Skip entirely for releases that are only minor patches/fixes/internals — let the bullets speak for themselves.>

   ## What's New

   - commit line
   - commit line

   ## Technical

   - commit line
   - commit line
   ```

   The narrative intro is the marketing-copy layer — it's what a reader sees first on the GitHub release page and the npm versions listing. Write it in plain English, not as a commit-log echo. Reference concrete capabilities ("Calendar writes — create, update, delete, respond events") rather than commit counts. Omit section headers that have no commits (no empty `## Technical`).

   When in doubt about whether this release warrants a narrative intro: if the version recommendation in step 6 is a minor or major bump, write one. If it's a patch, skip it.

6. **Recommend version**: Look at the current version in the PR title.
   - Significant new capabilities (new commands/flags, meaningful behavior changes) → next minor (e.g. v0.3.1 → v0.4.0)
   - Only fixes and internals → keep the current patch
   - Breaking changes → major bump (and add a `## Breaking changes` section to the notes with the migration path)

   Explain your reasoning briefly.

7. **Present the draft** to the user showing:
   - The formatted release notes
   - Your version recommendation
   - Ask if they want to: approve as-is, request edits, or switch to a different version bump

8. **On approval**:
   - Update the PR description: `gh pr edit <number> --body "<approved body>" --repo JarvusInnovations/gws-axi`
   - If the user requested a different version, also update the PR title: `gh pr edit <number> --title "Release: v<new_version>" --repo JarvusInnovations/gws-axi`
   - Merge the PR: `gh pr merge <number> --merge --repo JarvusInnovations/gws-axi`
   - Show the user the PR URL for confirmation

9. **Watch the npm publish**: Merging fires `release-publish` (which creates the GitHub release) which fires `publish-npm.yml`. Surface the run to the user:

   ```bash
   gh-axi run list --workflow publish-npm.yml --limit 1
   ```

   Once it completes (~90 seconds), verify:

   ```bash
   npm view gws-axi version         # should show the new version
   npm view gws-axi@<VERSION>       # confirms tarball + provenance
   ```

   Flag anything unexpected.

## Troubleshooting

- **No release PR exists**: no commits have been pushed to `develop` since the last release, or `release-prepare` failed. Check the Actions tab and push a commit if needed.
- **Workflow fails on publish**: check that trusted publishing is configured at <https://www.npmjs.com/package/gws-axi/access> linking this repo + `publish-npm.yml`. Without it, the OIDC-based publish can't authenticate.
- **`gh` errors with "no matches found"**: zsh glob-expanding a special character in the title or body. Pass bodies via `--body-file` rather than `--body "<long inline string>"` for anything with em-dashes, backticks, or brackets.
