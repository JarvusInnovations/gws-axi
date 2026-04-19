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
  type SetupFlags,
  type StepOutcome,
} from "../auth/steps.js";
import { advanceTokensObtained } from "../auth/loopback.js";
import { setupHtmlPath, writeSetupHtml } from "../auth/setup-html.js";

export const AUTH_HELP = `usage: gws-axi auth <subcommand> [flags]
subcommands[7]:
  setup     Progressive agent-guided OAuth setup (run repeatedly until complete)
  login     Run OAuth loopback flow; --account to add/re-auth a specific account
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
login flags[1]:
  --account <email>           Authenticate or re-auth a specific account
reset flags[1]:
  --from <step>               Clear from this step forward
examples:
  gws-axi auth setup
  gws-axi auth setup --create-project gws-axi-chris-9f3a
  gws-axi auth setup --credentials-json ~/Downloads/client_secret_xxx.json
  gws-axi auth login --account chris@personal.com
  gws-axi auth accounts
  gws-axi auth use chris@jarv.us
  gws-axi auth revoke chris@personal.com
`;

interface ParsedArgs {
  flags: SetupFlags;
  confirmStep?: SetupStepKey;
  resetFromKey?: SetupStepKey;
  account?: string;
  positional: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const flags: SetupFlags = {};
  const positional: string[] = [];
  let confirmStep: SetupStepKey | undefined;
  let resetFromKey: SetupStepKey | undefined;
  let account: string | undefined;

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
      default:
        if (!arg.startsWith("--")) {
          positional.push(arg);
        }
    }
  }
  return { flags, confirmStep, resetFromKey, account, positional };
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
  help.push(`Complete step ${nextOutcome.step} and re-run \`gws-axi auth setup\``);
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
  const { account } = parseArgs(args);
  if (!existsSync(credentialsPath())) {
    throw new AxiError(
      "OAuth credentials not saved — complete setup steps 1-4 first",
      "PRECONDITION_FAILED",
      ["Run `gws-axi auth setup` to continue progressive setup"],
    );
  }
  const outcome = await advanceTokensObtained({
    expectedAccount: account ? normalizeEmail(account) : undefined,
  });
  if (outcome.advanced) {
    return {
      status: "ok",
      ...(outcome.detail ?? {}),
      accounts: listAccounts(),
      default_account: getDefaultAccount(),
      help: ["Run `gws-axi doctor` to verify runtime health"],
    };
  }
  throw new AxiError(
    outcome.error ?? "OAuth flow failed",
    outcome.code ?? "OAUTH_FAILED",
    outcome.instructions ?? [],
  );
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
