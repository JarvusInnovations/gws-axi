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

function collapseHomeDirectory(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export const DOCTOR_HELP = `usage: gws-axi doctor [--check <tier|tier.name>] [--summary]
flags[3]:
  --check <tier>         Run only one tier (prerequisites|setup|runtime)
  --check <tier>.<name>  Run one specific check (e.g., runtime.gmail)
  --summary              One-line summary output (used by SessionStart hook)
examples:
  gws-axi doctor
  gws-axi doctor --summary
  gws-axi doctor --check prerequisites
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

function checkRuntime(): CheckRow[] {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    return [
      {
        check: "accounts",
        status: "fail",
        detail: "no accounts authenticated — run `gws-axi auth login`",
      },
    ];
  }
  // Per-service live probes are not yet implemented; this stub will be
  // replaced by real calls to users.getProfile (Gmail), calendarList.list,
  // etc. once service clients are wired. For now, just report that tokens
  // exist for each account.
  return accounts.flatMap((email) => [
    {
      check: `${email} · tokens`,
      status: "warn" as const,
      detail: "stored (live API probes not yet implemented)",
    },
  ]);
}

export async function doctorCommand(
  args: string[],
): Promise<Record<string, unknown>> {
  const summaryMode = args.includes("--summary");
  const checkIdx = args.indexOf("--check");
  const checkTarget = checkIdx >= 0 ? args[checkIdx + 1] : undefined;

  const [tier, name] = checkTarget ? checkTarget.split(".") : [undefined, undefined];

  const prereqs = !tier || tier === "prerequisites" ? checkPrerequisites() : [];
  const setupRows = !tier || tier === "setup" ? checkSetup() : [];
  const runtimeRows = !tier || tier === "runtime" ? checkRuntime() : [];

  const filteredRuntime = name
    ? runtimeRows.filter((r) => r.check === name)
    : runtimeRows;

  const failing =
    prereqs.filter((r) => r.status === "fail").length +
    setupRows.filter((r) => r.status === "fail").length +
    filteredRuntime.filter((r) => r.status === "fail").length;
  const warning =
    prereqs.filter((r) => r.status === "warn").length +
    setupRows.filter((r) => r.status === "warn").length +
    filteredRuntime.filter((r) => r.status === "warn").length;

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
  if (filteredRuntime.length > 0) output.runtime = filteredRuntime;
  output.summary = `${failing} failing, ${warning} warning`;

  const help: string[] = [];
  if (failing > 0 || warning > 0) {
    help.push("Run `gws-axi auth setup` if any setup steps failed");
  }
  help.push("Run `gws-axi doctor --help` for check targeting");
  output.help = help;

  process.exitCode = failing > 0 ? 1 : 0;

  return output;
}
