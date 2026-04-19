---
description: Cut a new gws-axi release — bumps version, drafts notes, tags, creates GitHub release (CI publishes to npm).
argument-hint: [version]  e.g. 0.2.0 or patch|minor|major
---

You're cutting a new release of `gws-axi`. The GitHub Actions workflow at `.github/workflows/publish-npm.yml` auto-publishes to npm on `release.published`, so your job is to end up with a properly-tagged GitHub release — the rest is automated.

**Argument**: `$ARGUMENTS` is either a semver string (`0.2.0`) or a bump keyword (`patch`, `minor`, `major`). If empty, ask the user which bump they want.

## Steps

### 1. Verify clean state

Run in parallel and confirm before proceeding:

- `git status` — must be clean, on `main`, up to date with origin
- `npm view gws-axi version` — current published version
- `git describe --tags --abbrev=0` — last tagged version locally
- `bun run build` — must succeed

If anything's off (dirty tree, not on main, build fails), STOP and surface to the user.

### 2. Determine next version

Based on `$ARGUMENTS`:

- If a semver string like `0.2.0`, use it directly
- If `patch`/`minor`/`major`, bump from the current published version
- If empty, ask the user what kind of bump is appropriate — summarize the commits since the last tag to help them decide

Confirm the chosen version with the user before continuing (unless they passed an explicit semver string).

### 3. Review commits and draft notes

Get the list of commits since the last tag:

```bash
git log <last-tag>..HEAD --oneline
```

Group them by conventional-commit type (feat, fix, docs, chore, refactor, test, ci). Discard noise like lockfile updates if they don't affect users.

Write release notes to `/tmp/gws-axi-release-<version>.md` using the template below. Keep it concise — bullets, not prose. Link commit SHAs only if they're referenced for context.

#### Release notes template

```markdown
npm: https://www.npmjs.com/package/gws-axi/v/<VERSION>

## Added
- <feat commits — user-visible behavior, not internals>

## Fixed
- <fix commits — what was broken and is now working>

## Changed
- <refactor commits with user-visible impact; breaking changes GET THEIR OWN SECTION BELOW instead>

## Internal
- <chore/ci/refactor that doesn't affect users but is worth noting for contributors>

## Breaking changes

<Only include this section if there are breaking changes. Otherwise delete.>
- <describe the break>
- <describe the migration path>

## Install / upgrade

\`\`\`bash
npm install -g gws-axi@<VERSION>
# or, if already installed:
npm update -g gws-axi
```

See the [README](https://github.com/JarvusInnovations/gws-axi#readme) for setup.

```

If the release is a pre-release (version like `0.2.0-rc.1`), pass `--prerelease` to `gh release create` in step 5.

### 4. Create annotated git tag

```bash
cd /Users/chris/Repositories/gws-axi
git tag -a v<VERSION> -m "gws-axi v<VERSION>"
git push origin v<VERSION>
```

Note: package.json version is NOT bumped locally. The CI workflow reads the tag and runs `npm version --no-git-tag-version "${RELEASE_TAG#v}"` on the build server before publishing — keeps the repo clean without "chore: bump version" commits.

### 5. Create GitHub release

Use the raw `gh` CLI (not `gh-axi`, which has trouble with em-dashes and some character combos in titles):

```bash
gh release create v<VERSION> \
  --title "gws-axi v<VERSION>" \
  --notes-file /tmp/gws-axi-release-<version>.md \
  --repo JarvusInnovations/gws-axi
```

Add `--prerelease` for RC/beta/alpha tags. Add `--draft` if the user wants to review before publishing (they'd then manually publish in the GitHub UI, which fires the same `release.published` event).

The output is the release URL. Paste it back to the user.

### 6. Watch the CI workflow

The release publishing immediately kicks off the `Publish npm package` workflow run. Show the user the workflow run:

```bash
gh-axi run list --workflow publish-npm.yml --limit 1
```

If they want to watch it live:

```bash
gh run watch --repo JarvusInnovations/gws-axi
```

### 7. Verify npm

Once the workflow completes (usually ~90 seconds):

```bash
npm view gws-axi version               # should show the new version
npm view gws-axi@<VERSION>             # confirms the tarball + provenance
```

Flag anything unexpected to the user.

## Troubleshooting

- **Workflow fails on publish**: check that trusted publishing is configured at <https://www.npmjs.com/package/gws-axi/access> linking this repo + `publish-npm.yml`. Without it, the OIDC-based publish can't authenticate.
- **Tag already exists**: means someone pushed a tag but didn't create a release. Delete the tag (`git tag -d` + `git push origin :refs/tags/vX.Y.Z`) and retry, OR just create the release on the existing tag: `gh release create vX.Y.Z --title ... --notes-file ...`.
- **`gh release create` errors with "no matches found"**: zsh glob-expanding a special character in the title or notes. Use `--notes-file` (as the template does) rather than `--notes "<long inline string>"`, and keep titles plain ASCII.
