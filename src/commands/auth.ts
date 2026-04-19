import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { AxiError } from "axi-sdk-js";
import {
  credentialsPath,
  readSetupState,
  setupProgress,
  tokensPath,
  SETUP_STEP_ORDER,
  type SetupStepKey,
} from "../config.js";
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
subcommands[4]:
  setup   Progressive agent-guided OAuth setup (run repeatedly until complete)
  login   Re-run the OAuth loopback flow (step 7 only)
  status  Terse one-line status
  reset   Clear setup state, optionally from a specific step
setup flags[6]:
  --project <id>              Use existing GCP project (step 1)
  --create-project <id>       Create new GCP project (step 1, needs gcloud)
  --project-name <name>       Display name when creating (step 1)
  --credentials-json <path>   Path to downloaded OAuth client JSON (step 4)
  --test-user <email>         Record test user email (step 6 metadata)
  --confirm-step <step>       Mark a manual step done (consent_screen, test_user_added)
reset flags[1]:
  --from <step>               Clear from this step forward
examples:
  gws-axi auth setup
  gws-axi auth setup --create-project gws-axi-chris-9f3a
  gws-axi auth setup --credentials-json ~/Downloads/client_secret_xxx.json
  gws-axi auth setup --confirm-step consent_screen
  gws-axi auth login
  gws-axi auth reset --from oauth_client
`;

function parseFlags(args: string[]): {
  flags: SetupFlags;
  confirmStep?: SetupStepKey;
  resetFromKey?: SetupStepKey;
} {
  const flags: SetupFlags = {};
  let confirmStep: SetupStepKey | undefined;
  let resetFromKey: SetupStepKey | undefined;

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
    }
  }
  return { flags, confirmStep, resetFromKey };
}

function expandHome(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

async function runSetup(args: string[]): Promise<Record<string, unknown>> {
  const { flags, confirmStep } = parseFlags(args);

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

  // Loop until we hit a non-advancing step or completion
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
    output.status = "complete";
    output.help = [
      "All setup steps complete",
      "Run `gws-axi doctor` to verify runtime health",
      "Tokens are in " + collapseHome(tokensPath()),
    ];
    return output;
  }

  output.next_step = {
    step: nextOutcome.step,
    title: nextOutcome.title,
    ...(nextOutcome.detail ? { detail: nextOutcome.detail } : {}),
    ...(nextOutcome.instructions ? { instructions: nextOutcome.instructions } : {}),
    ...(nextOutcome.deep_links ? { deep_links: nextOutcome.deep_links } : {}),
  };

  output.setup_html = `file://${setupHtmlPath()}`;

  if (nextOutcome.error) {
    throw new AxiError(
      nextOutcome.error,
      nextOutcome.code ?? "SETUP_ERROR",
      nextOutcome.instructions ?? [],
    );
  }

  const help: string[] = [];
  help.push(`Complete step ${nextOutcome.step} and re-run \`gws-axi auth setup\``);
  help.push(`Open ${collapseHome(setupHtmlPath())} in a browser for clickable Console links`);
  output.help = help;

  return output;
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
  if (typeof detail.scopes_granted === "number") {
    return `${detail.scopes_granted} scopes granted`;
  }
  return "";
}

function collapseHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

async function runLogin(): Promise<Record<string, unknown>> {
  if (!existsSync(credentialsPath())) {
    throw new AxiError(
      "OAuth credentials not saved — complete setup steps 1-4 first",
      "PRECONDITION_FAILED",
      ["Run `gws-axi auth setup` to continue progressive setup"],
    );
  }
  const outcome = await advanceTokensObtained();
  if (outcome.advanced) {
    return {
      status: "ok",
      ...(outcome.detail ?? {}),
      help: ["Run `gws-axi doctor` to verify runtime health"],
    };
  }
  throw new AxiError(
    outcome.error ?? "OAuth flow failed",
    outcome.code ?? "OAUTH_FAILED",
    outcome.instructions ?? [],
  );
}

function runStatus(): Record<string, unknown> {
  const state = readSetupState();
  const { done, total, nextStep } = setupProgress(state);
  const hasTokens = existsSync(tokensPath());

  if (done < total) {
    return {
      status: `incomplete (${done}/${total})`,
      next_step: nextStep,
    };
  }

  if (!hasTokens) {
    return { status: "broken: setup complete but tokens missing" };
  }

  return { status: "ok", account: state.steps.tokens_obtained.account ?? "pending" };
}

function runReset(args: string[]): Record<string, unknown> {
  const { resetFromKey } = parseFlags(args);
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
      return runLogin();
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
