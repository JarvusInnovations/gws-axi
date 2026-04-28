import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { AxiError } from "axi-sdk-js";
import {
  credentialsPath,
  getDefaultAccount,
  hasAccount,
  listAccounts,
  normalizeEmail,
  profilePathForAccount,
  readSetupState,
  removeAccount,
  setDefaultAccount,
  setupProgress,
  tokensPathForAccount,
  writeSetupState,
  SETUP_STEP_ORDER,
  type SetupStepKey,
} from "../config.js";
import { readFileSync } from "node:fs";
import { markStepDone, resetFrom } from "../auth/state.js";
import {
  advanceApisEnabled,
  advanceConsentScreen,
  advanceCredentialsSaved,
  advanceGcpProject,
  advanceOauthClient,
  advanceTestUserAdded,
  consoleUrl,
  type SetupFlags,
  type StepOutcome,
} from "../auth/steps.js";
import {
  advanceTokensObtained,
  awaitPendingAuth,
  preparePendingAuth,
} from "../auth/loopback.js";
import { readPendingAuth } from "../auth/pending.js";
import { setupHtmlPath, writeSetupHtml } from "../auth/setup-html.js";
import { probeRestrictedScope, summarizeAccountHealth } from "../auth/health.js";
import { readTokens } from "../google/tokens.js";
import { getValidAccessToken } from "../google/tokens.js";

export const AUTH_HELP = `usage: gws-axi auth <subcommand> [flags]
subcommands[8]:
  setup     Progressive agent-guided OAuth setup (run repeatedly until complete)
  login     Authenticate or re-auth an account (prepares + blocks on callback by default)
  publish   Walk through publishing the consent screen to "In Production"
            (lifts the 7-day Testing-state refresh-token expiry)
  accounts  List authenticated accounts
  use       Set the default account: gws-axi auth use <email>
  revoke    Delete an account's tokens: gws-axi auth revoke <email>
  status    Terse one-line status
  reset     Clear setup state, optionally from a specific step
setup flags[6]:
  --project <id>              Use existing GCP project (step 1)
  --create-project <id>       Create new GCP project (step 1, needs gcloud)
  --project-name <name>       Display name when creating (step 1)
  --credentials-json <path>   Path to downloaded OAuth client JSON (step 4)
  --test-user <email>         Record test user email (step 6 metadata)
  --confirm-step <step>       Mark a manual step done (consent_screen, test_user_added)
login flags[3]:
  --account <email>           Authenticate or re-auth a specific account
  --no-wait                   Prepare only and return fast (for agent flows
                              that want to relay instructions to the user
                              before binding the callback server). Pair
                              with a follow-up \`auth login --wait\`.
  --wait                      Block on the callback for a previously
                              prepared session (paired with --no-wait).
publish flags[1]:
  --confirm                   Mark the consent screen as published in
                              setup state (after clicking "PUBLISH APP"
                              in the Console).
reset flags[1]:
  --from <step>               Clear from this step forward
examples:
  gws-axi auth setup
  gws-axi auth setup --create-project gws-axi-chris-9f3a
  gws-axi auth setup --credentials-json ~/Downloads/client_secret_xxx.json
  gws-axi auth login --account chris@personal.com           # prepares + blocks (default)
  gws-axi auth login --account chris@personal.com --no-wait # agent prepare-only
  gws-axi auth login --wait                                 # agent block-only
  gws-axi auth publish                                      # show publish walkthrough
  gws-axi auth publish --confirm                            # mark consent screen as published
  gws-axi auth accounts
  gws-axi auth use chris@jarv.us
  gws-axi auth revoke chris@personal.com
flow:
  Humans: \`gws-axi auth login --account <email>\` is one command that
  prepares, prints a brief instruction, and waits for the OAuth
  callback (up to 5 min).
  Agents: pass --no-wait so the prepare returns immediately, relay the
  instructions to the user, then call \`gws-axi auth login --wait\` in
  a SEPARATE bash turn — the wait command binds the callback server
  and must be listening before the user clicks.
`;

interface ParsedArgs {
  flags: SetupFlags;
  confirmStep?: SetupStepKey;
  resetFromKey?: SetupStepKey;
  account?: string;
  wait: boolean;
  noWait: boolean;
  confirm: boolean;
  positional: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const flags: SetupFlags = {};
  const positional: string[] = [];
  let confirmStep: SetupStepKey | undefined;
  let resetFromKey: SetupStepKey | undefined;
  let account: string | undefined;
  let wait = false;
  let noWait = false;
  let confirm = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--project":
        flags.projectId = next;
        i++;
        break;
      case "--create-project":
        flags.createProject = next;
        i++;
        break;
      case "--project-name":
        flags.projectName = next;
        i++;
        break;
      case "--credentials-json":
        flags.credentialsJson = expandHome(next);
        i++;
        break;
      case "--test-user":
        flags.testUserEmail = next;
        i++;
        break;
      case "--confirm-step":
        confirmStep = next as SetupStepKey;
        i++;
        break;
      case "--from":
        resetFromKey = next as SetupStepKey;
        i++;
        break;
      case "--account":
        account = next;
        i++;
        break;
      case "--wait":
        wait = true;
        break;
      case "--no-wait":
        noWait = true;
        break;
      case "--confirm":
        confirm = true;
        break;
      default:
        if (!arg.startsWith("--")) {
          positional.push(arg);
        }
    }
  }
  return { flags, confirmStep, resetFromKey, account, wait, noWait, confirm, positional };
}

function expandHome(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

async function runSetup(args: string[]): Promise<Record<string, unknown>> {
  const { flags, confirmStep } = parseArgs(args);

  if (confirmStep) {
    if (!SETUP_STEP_ORDER.includes(confirmStep)) {
      throw new AxiError(
        `Unknown step: ${confirmStep}`,
        "VALIDATION_ERROR",
        [`Valid steps: ${SETUP_STEP_ORDER.join(", ")}`],
      );
    }
    const extra: Record<string, unknown> = {};
    if (confirmStep === "test_user_added" && flags.testUserEmail) {
      extra.email = flags.testUserEmail;
    }
    markStepDone(confirmStep, extra);
  }

  // Auto-confirm step 3 (oauth_client) when the user provides a valid Desktop
  // OAuth JSON — the file couldn't exist unless they completed the manual
  // Console step. Prevents the common footgun of running
  //   `gws-axi auth setup --credentials-json <path>`
  // and having it stall on step 3 because the agent forgot to also pass
  //   `--confirm-step oauth_client`.
  if (flags.credentialsJson && !readSetupState().steps.oauth_client.done) {
    if (existsSync(flags.credentialsJson)) {
      try {
        const parsed = JSON.parse(
          readFileSync(flags.credentialsJson, "utf-8"),
        ) as { installed?: { client_id?: string; client_secret?: string } };
        if (parsed.installed?.client_id && parsed.installed?.client_secret) {
          markStepDone("oauth_client", {
            auto_confirmed: true,
            via: "credentials-json",
            client_id: parsed.installed.client_id,
          });
        }
      } catch {
        // fall through; advanceCredentialsSaved will surface the JSON error
      }
    }
  }

  const advanced: Array<{ step: SetupStepKey; detail: string }> = [];
  let nextOutcome: StepOutcome | null = null;

  for (let i = 0; i < SETUP_STEP_ORDER.length; i++) {
    const state = readSetupState();
    const { nextStep } = setupProgress(state);
    if (!nextStep) break;

    const handler = handlerFor(nextStep);
    const outcome = await handler(flags, state);
    if (outcome.advanced) {
      advanced.push({
        step: outcome.step,
        detail: summarizeDetail(outcome.detail),
      });
      continue;
    }

    nextOutcome = outcome;
    break;
  }

  writeSetupHtml();
  const state = readSetupState();
  const { done, total } = setupProgress(state);

  const output: Record<string, unknown> = {
    progress: `${done} of ${total} steps complete`,
  };

  if (advanced.length > 0) {
    output.advanced = advanced;
  }

  if (!nextOutcome) {
    const accounts = listAccounts();
    output.status = "complete";
    output.accounts = accounts;
    output.help = [
      "All setup steps complete",
      "Run `gws-axi doctor` to verify runtime health",
      "Run `gws-axi auth login --account <email>` to add another account",
    ];
    return output;
  }

  // Intentionally do NOT include deep_links in CLI output — Console URLs
  // live only on setup.html. This prevents agents from opening them with
  // `open <url>`, which lands in whatever browser the OS picks (often the
  // wrong session / profile / an agent's debug browser). Instructions
  // reference setup-page buttons by label; the user clicks them in the
  // browser they chose when they opened setup.html.
  output.next_step = {
    step: nextOutcome.step,
    title: nextOutcome.title,
    ...(nextOutcome.detail ? { detail: nextOutcome.detail } : {}),
    ...(nextOutcome.instructions ? { instructions: nextOutcome.instructions } : {}),
  };

  const htmlPath = collapseHome(setupHtmlPath());
  const isFreshSetup = advanced.length === 0 && done === 0;

  output.setup_html = {
    path: htmlPath,
    note: "Open this page ONCE in the user's primary browser (the one they use for Google). Keep the tab open — it auto-refreshes as setup progresses. All Console actions happen via buttons on this page.",
  };

  if (nextOutcome.error) {
    throw new AxiError(
      nextOutcome.error,
      nextOutcome.code ?? "SETUP_ERROR",
      nextOutcome.instructions ?? [],
    );
  }

  const help: string[] = [];
  if (isFreshSetup) {
    help.push(
      `FIRST-TIME: ask the user to open \`${htmlPath}\` in their primary browser (where they're signed into Google) and keep it open. Don't invoke \`open\` yourself — browser session may differ.`,
    );
  } else if (stepHasConsoleButtons(nextOutcome.step)) {
    help.push(
      `Have the user click the button(s) for step '${nextOutcome.step}' on their gws-axi setup page (should already be open in their primary browser)`,
    );
  }
  if (nextOutcome.step === "tokens_obtained") {
    // Step 7 is special: the prepare has already happened (advanceTokensObtained
    // wrote pending state + setup.html). The agent relays the instructions
    // and then must invoke `auth login --wait` to block on the callback in a
    // SEPARATE bash turn — so the user sees the instructions before the wait.
    help.push(
      "Relay the instructions above to the user, then run `gws-axi auth login --wait` in a NEW bash turn to block on the callback (up to 5 minutes).",
    );
  } else {
    help.push(
      `Complete step ${nextOutcome.step} and re-run \`gws-axi auth setup\``,
    );
  }
  output.help = help;

  return output;
}

function stepHasConsoleButtons(step: SetupStepKey): boolean {
  // Steps where the user needs to click something on setup.html. Anything
  // automatable (gcp_project/apis_enabled with gcloud, tokens_obtained via
  // loopback) or pure-CLI (credentials_saved) doesn't need the setup page.
  return (
    step === "oauth_client" ||
    step === "consent_screen" ||
    step === "test_user_added"
  );
}

function handlerFor(
  key: SetupStepKey,
): (flags: SetupFlags, state: ReturnType<typeof readSetupState>) => Promise<StepOutcome> {
  switch (key) {
    case "gcp_project":
      return (flags) => advanceGcpProject(flags);
    case "apis_enabled":
      return (flags, state) => advanceApisEnabled(flags, state);
    case "oauth_client":
      return (flags, state) => advanceOauthClient(flags, state);
    case "credentials_saved":
      return (flags) => advanceCredentialsSaved(flags);
    case "consent_screen":
      return (flags, state) => advanceConsentScreen(flags, state);
    case "test_user_added":
      return (flags, state) => advanceTestUserAdded(flags, state);
    case "tokens_obtained":
      return () => advanceTokensObtained();
  }
}

function summarizeDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return "";
  if (typeof detail.project_id === "string") return detail.project_id;
  if (typeof detail.path === "string") return collapseHome(detail.path);
  if (Array.isArray(detail.apis)) return `${detail.apis.length} APIs enabled`;
  if (typeof detail.account === "string") return detail.account;
  if (typeof detail.scopes_granted === "number") {
    return `${detail.scopes_granted} scopes granted`;
  }
  return "";
}

function collapseHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

async function runLogin(args: string[]): Promise<Record<string, unknown>> {
  const { account, wait, noWait } = parseArgs(args);

  // --wait: block on a previously-prepared session (agent flow second step).
  if (wait) {
    return await blockOnCallback();
  }

  // Otherwise: always prepare. Then either return immediately (--no-wait,
  // agent flow first step) or block inline (default, human one-shot flow).
  const prepared = await prepareLogin(account);

  if (noWait) {
    return prepared;
  }

  // Default: emit a brief stderr note so the human sees what's happening,
  // then block on the callback. The Record we return becomes the final
  // success/failure output on stdout once the callback fires.
  const acct = (prepared.account as string | undefined) ?? "the target Google account";
  const htmlPath = prepared.setup_html as string;
  process.stderr.write(
    `Authenticating ${acct}. Open ${htmlPath} in the browser ` +
      `signed into that account and click "Authenticate with Google" ` +
      `(waiting up to 5 min)…\n`,
  );
  return await blockOnCallback();
}

async function prepareLogin(
  account: string | undefined,
): Promise<Record<string, unknown>> {
  if (!existsSync(credentialsPath())) {
    throw new AxiError(
      "OAuth credentials not saved — complete setup steps 1-4 first",
      "PRECONDITION_FAILED",
      ["Run `gws-axi auth setup` to continue progressive setup"],
    );
  }
  const prepared = await preparePendingAuth({
    expectedAccount: account ? normalizeEmail(account) : undefined,
  });
  if ("error" in prepared) {
    throw new AxiError(prepared.error, prepared.code, [
      "Run `gws-axi auth setup` to ensure credentials are saved",
    ]);
  }
  const htmlPath = collapseHome(prepared.htmlPath);
  const normalizedAccount = account ? normalizeEmail(account) : undefined;
  return {
    status: "prepared",
    ...(normalizedAccount ? { account: normalizedAccount } : {}),
    setup_html: htmlPath,
    expires_at: prepared.pending.expires_at,
    instructions: [
      `The gws-axi setup page (${htmlPath}) must be open in the browser PROFILE/SESSION where the user is signed into ${normalizedAccount ? `\`${normalizedAccount}\`` : "the target Google account"}. This may be a DIFFERENT browser profile than the one used for initial setup (e.g., personal Chrome profile vs work). If the setup page is open in the wrong profile, tell the user to open ${htmlPath} in the correct profile.`,
      `In that setup page tab, the user waits for the yellow "Authenticate with Google" button to appear (up to 10s auto-refresh), clicks it, signs in${normalizedAccount ? ` as \`${normalizedAccount}\`` : ""}, approves the requested scopes, and sees the success page.`,
      "After RELAYING these instructions to the user, IMMEDIATELY run `gws-axi auth login --wait` in a new bash turn — do NOT wait for the user to confirm they're ready. The wait command binds the callback server; it must be listening BEFORE the user clicks. If you delay, the user's click hits an unreachable localhost URL. The wait is harmless: it just listens for up to 5 minutes while the user takes their time.",
    ],
    help: [
      "Relay instructions, then IMMEDIATELY run `gws-axi auth login --wait` in the next bash turn — no user-confirmation step between them.",
      "The pending flow expires in 10 minutes — if you don't --wait by then, re-run this prepare step",
    ],
  };
}

async function blockOnCallback(): Promise<Record<string, unknown>> {
  const outcome = await awaitPendingAuth();
  if (!outcome.advanced) {
    throw new AxiError(
      outcome.error ?? "OAuth flow failed",
      outcome.code ?? "OAUTH_FAILED",
      outcome.instructions ?? [],
    );
  }

  // Post-auth health check: report whether the just-issued token is
  // permanent (post-publish) and whether restricted-scope access is
  // actually working at the API level. Both checks are best-effort —
  // a probe failure shouldn't block the success response since the
  // OAuth flow itself succeeded.
  const detail = (outcome.detail ?? {}) as Record<string, unknown>;
  const account = typeof detail.account === "string" ? detail.account : undefined;

  const result: Record<string, unknown> = {
    status: "ok",
    ...detail,
  };

  if (account) {
    const health = summarizeAccountHealth(account);
    if (health) {
      result.token_permanence = health.permanence_detail;
    }
    try {
      const tokens = await getValidAccessToken(account);
      const probe = await probeRestrictedScope(tokens);
      result.restricted_scope = probe.detail;
    } catch (err) {
      result.restricted_scope = `probe failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  result.accounts = listAccounts();
  result.default_account = getDefaultAccount();
  result.help = ["Run `gws-axi doctor` to verify runtime health for all accounts"];
  return result;
}

interface AccountSummary {
  email: string;
  default: boolean;
  name?: string;
  obtained_at?: string;
  scopes?: number;
}

function runAccounts(): Record<string, unknown> {
  const emails = listAccounts();
  if (emails.length === 0) {
    return {
      accounts: [],
      help: ["Run `gws-axi auth setup` (or `gws-axi auth login`) to add an account"],
    };
  }
  const defaultAccount = getDefaultAccount();
  const summaries: AccountSummary[] = emails.map((email) => {
    const summary: AccountSummary = { email, default: email === defaultAccount };
    try {
      const profile = JSON.parse(readFileSync(profilePathForAccount(email), "utf-8")) as {
        name?: string;
      };
      summary.name = profile.name;
    } catch {
      // no profile yet
    }
    try {
      const tokens = JSON.parse(readFileSync(tokensPathForAccount(email), "utf-8")) as {
        obtained_at?: string;
        scope?: string;
      };
      summary.obtained_at = tokens.obtained_at;
      summary.scopes = tokens.scope ? tokens.scope.split(" ").filter(Boolean).length : 0;
    } catch {
      // no tokens file (shouldn't happen given listAccounts filters on this)
    }
    return summary;
  });
  return {
    count: emails.length,
    accounts: summaries,
    default: defaultAccount,
    help: [
      "Run `gws-axi auth use <email>` to change default",
      "Run `gws-axi auth login --account <email>` to add another",
      "Run `gws-axi auth revoke <email>` to remove one",
    ],
  };
}

function runUse(args: string[]): Record<string, unknown> {
  const { positional } = parseArgs(args);
  const email = positional[0];
  if (!email) {
    throw new AxiError(
      "Usage: gws-axi auth use <email>",
      "VALIDATION_ERROR",
      ["Run `gws-axi auth accounts` to see authenticated accounts"],
    );
  }
  if (!hasAccount(email)) {
    throw new AxiError(
      `Account ${email} is not authenticated`,
      "ACCOUNT_NOT_FOUND",
      [
        `Authenticated accounts: ${listAccounts().join(", ") || "(none)"}`,
        `Run \`gws-axi auth login --account ${email}\` to add it`,
      ],
    );
  }
  setDefaultAccount(email);
  return {
    status: "ok",
    default: normalizeEmail(email),
    help: [`Commands without --account will now use ${normalizeEmail(email)}`],
  };
}

function runRevoke(args: string[]): Record<string, unknown> {
  const { positional } = parseArgs(args);
  const email = positional[0];
  if (!email) {
    throw new AxiError(
      "Usage: gws-axi auth revoke <email>",
      "VALIDATION_ERROR",
      ["Run `gws-axi auth accounts` to see authenticated accounts"],
    );
  }
  if (!hasAccount(email)) {
    return {
      status: "no-op",
      message: `${normalizeEmail(email)} was not authenticated`,
    };
  }
  removeAccount(email);
  const remaining = listAccounts();
  return {
    status: "revoked",
    removed: normalizeEmail(email),
    remaining_count: remaining.length,
    new_default: getDefaultAccount(),
    help:
      remaining.length === 0
        ? ["Run `gws-axi auth login` to add an account"]
        : [`${remaining.length} account(s) remain authenticated`],
  };
}

function runStatus(): Record<string, unknown> {
  const state = readSetupState();
  const { done, total, nextStep } = setupProgress(state);
  const accounts = listAccounts();

  if (done < total) {
    return {
      status: `incomplete (${done}/${total})`,
      next_step: nextStep,
      accounts_count: accounts.length,
    };
  }

  if (accounts.length === 0) {
    return { status: "broken: setup complete but no accounts authenticated" };
  }

  return {
    status: "ok",
    accounts_count: accounts.length,
    default: getDefaultAccount(),
  };
}

function runPublish(args: string[]): Record<string, unknown> {
  const { confirm } = parseArgs(args);
  const state = readSetupState();

  const projectId = state.steps.gcp_project.project_id;
  if (typeof projectId !== "string") {
    throw new AxiError(
      "OAuth project not yet configured — can't publish a consent screen we don't know about",
      "PRECONDITION_FAILED",
      ["Run `gws-axi auth setup` to provision the GCP project + OAuth client first"],
    );
  }

  // The current Cloud Console URL for the publish UI is under
  // /auth/audience (the new Auth Platform section). Google migrated away
  // from the older /apis/credentials/consent path; that one redirects but
  // can land on the wrong screen depending on project state.
  const audienceUrl = consoleUrl("/auth/audience", projectId);

  if (confirm) {
    // --confirm: record the change in setup state.
    state.published = { confirmed_at: new Date().toISOString() };
    writeSetupState(state);

    const tokenStatus = summarizeAccountTokens(state.published.confirmed_at);
    const help: string[] = [
      `Consent screen for project ${projectId} marked as published`,
    ];
    if (tokenStatus.preExisting.length > 0) {
      help.push(
        `Re-auth each account once to issue a permanent refresh token (existing tokens were issued before publish and still inherit the 7-day Testing-state expiry):`,
      );
      for (const email of tokenStatus.preExisting) {
        help.push(`  gws-axi auth login --account ${email}`);
      }
    } else {
      help.push(
        `All authenticated accounts are post-publish — their refresh tokens should already be permanent`,
      );
    }
    return {
      status: "ok",
      project_id: projectId,
      published_at: state.published.confirmed_at,
      accounts: tokenStatus.rows,
      help,
    };
  }

  if (state.published) {
    const tokenStatus = summarizeAccountTokens(state.published.confirmed_at);
    const help: string[] = [
      `Project ${projectId} is marked as published in setup state`,
    ];
    if (tokenStatus.preExisting.length > 0) {
      help.push(
        `${tokenStatus.preExisting.length} account${tokenStatus.preExisting.length === 1 ? " was" : "s were"} authenticated before publish — those tokens still expire on the 7-day clock until you re-auth:`,
      );
      for (const email of tokenStatus.preExisting) {
        help.push(`  gws-axi auth login --account ${email}`);
      }
    } else {
      help.push(
        `All authenticated accounts were re-auth'd after publish — refresh tokens should be permanent`,
      );
      help.push(
        `(Google doesn't expose a "permanent" flag we can read; the heuristic compares each account's obtained_at against the publish timestamp.)`,
      );
    }
    return {
      status: "already_published",
      project_id: projectId,
      published_at: state.published.confirmed_at,
      consent_screen_url: audienceUrl,
      accounts: tokenStatus.rows,
      help,
    };
  }

  // Not yet published — walkthrough.
  return {
    status: "instructions",
    project_id: projectId,
    consent_screen_url: audienceUrl,
    instructions: [
      `1. Open: ${audienceUrl}`,
      `2. Click "PUBLISH APP" near the top of the Audience page`,
      `3. Click "CONFIRM" on the warning dialog ("Push your app to production?")`,
      `4. Run \`gws-axi auth publish --confirm\` to mark it published in setup state`,
      `5. Re-auth each account once to issue permanent refresh tokens (\`gws-axi auth login --account <email>\`)`,
    ],
    notes: [
      "After publishing, the 7-day refresh-token expiry stops applying — that's a Testing-state-specific limit, NOT a verification requirement. Existing tokens still die on their natural schedule; re-running auth login post-publish issues a permanent refresh token in their place.",
      "Google may show a banner saying 'Your app requires verification' — that's about removing the unverified-app warning during OAuth consent, NOT about token longevity. For personal/single-developer use under 100 users, you can ignore it indefinitely.",
      "The 'unverified app' intermediate screen during OAuth consent will continue to appear (skip via 'Advanced → Go to <app> (unsafe)'). That's the cost of skipping formal verification.",
      "Both your Workspace and personal Gmail accounts go through the same publish action — your consent screen is already 'External' (otherwise the personal Gmail couldn't have authenticated), so flipping Testing → Production benefits both.",
    ],
    help: [
      `Run \`gws-axi auth publish --confirm\` after clicking "PUBLISH APP" in the Console`,
    ],
  };
}

interface AccountTokenRow {
  email: string;
  obtained_at: string;
  pre_publish: boolean;
}

interface TokenSummary {
  rows: AccountTokenRow[];
  preExisting: string[];
}

function summarizeAccountTokens(publishedAt: string): TokenSummary {
  const publishedMs = new Date(publishedAt).getTime();
  const rows: AccountTokenRow[] = [];
  const preExisting: string[] = [];
  for (const email of listAccounts()) {
    const tokens = readTokens(email);
    if (!tokens) continue;
    const obtainedMs = new Date(tokens.obtained_at).getTime();
    const prePublish = obtainedMs < publishedMs;
    rows.push({
      email,
      obtained_at: tokens.obtained_at,
      pre_publish: prePublish,
    });
    if (prePublish) preExisting.push(email);
  }
  return { rows, preExisting };
}

function runReset(args: string[]): Record<string, unknown> {
  const { resetFromKey } = parseArgs(args);
  if (resetFromKey && !SETUP_STEP_ORDER.includes(resetFromKey)) {
    throw new AxiError(
      `Unknown step: ${resetFromKey}`,
      "VALIDATION_ERROR",
      [`Valid steps: ${SETUP_STEP_ORDER.join(", ")}`],
    );
  }
  const state = resetFrom(resetFromKey ?? "gcp_project");
  const { done, total } = setupProgress(state);
  return {
    status: "reset",
    progress: `${done} of ${total} steps remain complete`,
    help: ["Run `gws-axi auth setup` to begin again"],
  };
}

export async function authCommand(
  args: string[],
): Promise<string | Record<string, unknown>> {
  const sub = args[0];
  if (!sub) return AUTH_HELP;

  const rest = args.slice(1);
  switch (sub) {
    case "setup":
      return runSetup(rest);
    case "login":
      return runLogin(rest);
    case "publish":
      return runPublish(rest);
    case "accounts":
      return runAccounts();
    case "use":
      return runUse(rest);
    case "revoke":
      return runRevoke(rest);
    case "status":
      return runStatus();
    case "reset":
      return runReset(rest);
    default:
      throw new AxiError(
        `Unknown auth subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `gws-axi auth --help` to see available subcommands"],
      );
  }
}
