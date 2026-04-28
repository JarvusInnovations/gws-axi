import { execFileSync } from "node:child_process";
import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import {
  configDir,
  getDefaultAccount,
  listAccounts,
  readSetupState,
  setupProgress,
  SETUP_STEP_ORDER,
} from "../config.js";
import { probeAccount } from "../google/probe.js";
import { summarizeAccountHealth } from "../auth/health.js";
import { SERVICES } from "../auth/scopes.js";

function collapseHomeDirectory(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export const DOCTOR_HELP = `usage: gws-axi doctor [--check <tier|tier.service>] [--summary]
flags[3]:
  --check <tier>           Run only one tier (prerequisites|setup|runtime)
  --check runtime.<service> Run probes for one service (${SERVICES.join(" | ")})
  --summary                One-line summary output (used by SessionStart hook)
tiers:
  prerequisites  gcloud presence, node version, config dir perms
  setup          progress of the 7-step BYO onboarding
  runtime        live per-account × per-service API probes (token, scope, reachability)
exit codes:
  0  all checks passed (or warnings only)
  1  at least one failing check
examples:
  gws-axi doctor
  gws-axi doctor --summary
  gws-axi doctor --check prerequisites
  gws-axi doctor --check runtime
  gws-axi doctor --check runtime.gmail
`;

interface CheckRow {
  check: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function checkPrerequisites(): CheckRow[] {
  const rows: CheckRow[] = [];

  try {
    const version = execFileSync("gcloud", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")[0]
      .trim();
    rows.push({ check: "gcloud CLI", status: "ok", detail: version });
  } catch {
    rows.push({
      check: "gcloud CLI",
      status: "warn",
      detail: "not installed (setup will use deep-links instead)",
    });
  }

  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  rows.push({
    check: "node runtime",
    status: major >= 20 ? "ok" : "fail",
    detail: `v${nodeVersion}${major >= 20 ? "" : " (requires >=20)"}`,
  });

  const dir = configDir();
  if (!existsSync(dir)) {
    rows.push({
      check: "config dir",
      status: "warn",
      detail: `${collapseHomeDirectory(dir)} does not exist yet (created on first setup)`,
    });
  } else {
    try {
      accessSync(dir, constants.R_OK | constants.W_OK);
      rows.push({
        check: "config dir",
        status: "ok",
        detail: `${collapseHomeDirectory(dir)} (rw)`,
      });
    } catch {
      rows.push({
        check: "config dir",
        status: "fail",
        detail: `${collapseHomeDirectory(dir)} not writable`,
      });
    }
  }

  return rows;
}

function checkSetup(): CheckRow[] {
  const state = readSetupState();
  return SETUP_STEP_ORDER.map((key) => {
    const step = state.steps[key];
    if (step.done) {
      return {
        check: key,
        status: "ok" as const,
        detail:
          typeof step.project_id === "string"
            ? step.project_id
            : typeof step.email === "string"
              ? step.email
              : "",
      };
    }
    return { check: key, status: "fail" as const, detail: "not done" };
  });
}

interface RuntimeRow {
  account: string;
  service: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

async function checkRuntime(serviceFilter?: string): Promise<RuntimeRow[]> {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    return [
      {
        account: "(none)",
        service: "—",
        status: "fail",
        detail: "no accounts authenticated — run `gws-axi auth login`",
      },
    ];
  }

  // Probe all accounts in parallel. Per-account, services that can run in
  // parallel (gmail/calendar/drive) already do inside probeAccount.
  const perAccount = await Promise.all(
    accounts.map(async (email) => {
      const results = await probeAccount(email);
      return { email, results };
    }),
  );

  const rows: RuntimeRow[] = [];
  for (const { email, results } of perAccount) {
    for (const result of results) {
      if (serviceFilter && result.service !== serviceFilter) continue;
      rows.push({
        account: email,
        service: result.service,
        status: result.status,
        detail: result.detail,
      });
    }
  }
  return rows;
}

export async function doctorCommand(
  args: string[],
): Promise<Record<string, unknown>> {
  const summaryMode = args.includes("--summary");
  const checkIdx = args.indexOf("--check");
  const checkTarget = checkIdx >= 0 ? args[checkIdx + 1] : undefined;

  const [tier, name] = checkTarget ? checkTarget.split(".") : [undefined, undefined];

  if (tier && !["prerequisites", "setup", "runtime"].includes(tier)) {
    return {
      error: `Unknown tier: ${tier}`,
      code: "VALIDATION_ERROR",
      help: ["Valid tiers: prerequisites, setup, runtime"],
    };
  }

  const prereqs = !tier || tier === "prerequisites" ? checkPrerequisites() : [];
  const setupRows = !tier || tier === "setup" ? checkSetup() : [];
  const runtimeRows =
    !tier || tier === "runtime"
      ? await checkRuntime(tier === "runtime" ? name : undefined)
      : [];

  // Compute auth_health rows up front so they roll into the failing/warning
  // tally alongside the other tiers.
  const accountsForHealth = listAccounts();
  const authHealthRows: CheckRow[] =
    accountsForHealth.length > 0 && (!tier || tier === "setup" || tier === "runtime")
      ? accountsForHealth.map((email) => {
          const h = summarizeAccountHealth(email);
          if (!h) {
            return {
              check: email,
              status: "fail" as const,
              detail: "no stored tokens",
            };
          }
          return {
            check: email,
            status: (h.permanence === "permanent" ? "ok" : "warn") as
              | "ok"
              | "warn"
              | "fail",
            detail: h.permanence_detail,
          };
        })
      : [];

  const failing =
    prereqs.filter((r) => r.status === "fail").length +
    setupRows.filter((r) => r.status === "fail").length +
    authHealthRows.filter((r) => r.status === "fail").length +
    runtimeRows.filter((r) => r.status === "fail").length;
  const warning =
    prereqs.filter((r) => r.status === "warn").length +
    setupRows.filter((r) => r.status === "warn").length +
    authHealthRows.filter((r) => r.status === "warn").length +
    runtimeRows.filter((r) => r.status === "warn").length;

  if (summaryMode) {
    const state = readSetupState();
    const { done, total } = setupProgress(state);
    if (done < total) {
      return {
        status: `setup ${done}/${total} — run 'gws-axi auth setup' to continue`,
      };
    }
    if (failing > 0) {
      return {
        status: `${failing} failing check${failing === 1 ? "" : "s"} — run 'gws-axi doctor'`,
      };
    }
    return { status: "ok" };
  }

  const accounts = listAccounts();
  const defaultAccount = getDefaultAccount();
  const setupState = readSetupState();

  const output: Record<string, unknown> = {};
  if (accounts.length > 0) {
    output.accounts = accounts;
    if (defaultAccount) output.default_account = defaultAccount;
    if (accounts.length > 1) {
      output.write_protection = "enabled — writes require --account";
    }
  }
  if (prereqs.length > 0) output.prerequisites = prereqs;
  if (setupRows.length > 0) output.setup = setupRows;

  // Auth health: per-account token permanence (compares each token's
  // obtained_at against state.published.confirmed_at). Cheap, no API
  // calls — pure timestamp arithmetic on local data. Restricted-scope
  // verification stays in the runtime tier since it costs an API call.
  if (authHealthRows.length > 0) {
    output.auth_health = {
      published: setupState.published
        ? `yes (since ${setupState.published.confirmed_at})`
        : "no — consent screen still in Testing (run `auth publish`)",
      tokens: authHealthRows,
    };
  }

  if (runtimeRows.length > 0) output.runtime = runtimeRows;
  output.summary = `${failing} failing, ${warning} warning`;

  const help: string[] = [];
  const setupFailing = setupRows.some((r) => r.status === "fail");
  const runtimeFailing = runtimeRows.some((r) => r.status === "fail");
  const tokenFailures = runtimeRows.filter(
    (r) => r.status === "fail" && /401|revoked|refresh/i.test(r.detail),
  );
  const scopeFailures = runtimeRows.filter(
    (r) => r.status === "fail" && /scope/i.test(r.detail),
  );
  if (setupFailing) {
    help.push("Run `gws-axi auth setup` to advance incomplete setup steps");
  }
  if (tokenFailures.length > 0) {
    const accts = [...new Set(tokenFailures.map((r) => r.account))];
    help.push(
      `Token issues detected on ${accts.join(", ")} — run \`gws-axi auth login --account <email>\` + \`auth login --wait\` to re-auth`,
    );
  }
  if (scopeFailures.length > 0) {
    const accts = [...new Set(scopeFailures.map((r) => r.account))];
    help.push(
      `Scope gaps on ${accts.join(", ")} — re-auth to re-consent to the full scope set`,
    );
  }
  // Auth-health-specific hints: nudge towards `auth publish` if the
  // consent screen hasn't been published, or list pre-publish accounts
  // that need a one-time re-auth to upgrade to permanent tokens.
  if (!setupState.published && authHealthRows.length > 0) {
    help.push(
      "Consent screen still in Testing (7-day token expiry) — run `gws-axi auth publish` to lift the limit",
    );
  } else if (setupState.published) {
    const prePublish = authHealthRows.filter(
      (r) => r.status === "warn" && /pre-publish|7-day clock — issued/.test(r.detail),
    );
    if (prePublish.length > 0) {
      help.push(
        `${prePublish.length} account${prePublish.length === 1 ? " was" : "s were"} authenticated before publish — re-auth to upgrade to permanent tokens:`,
      );
      for (const r of prePublish) {
        help.push(`  gws-axi auth login --account ${r.check}`);
      }
    }
  }
  if (failing === 0 && warning === 0) {
    help.push("All checks passed — you can start using service commands");
  }
  help.push("Run `gws-axi doctor --help` for check targeting");
  output.help = help;

  process.exitCode = failing > 0 ? 1 : 0;

  return output;
}
