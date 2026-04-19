import { execFileSync } from "node:child_process";

export interface GcloudProject {
  projectId: string;
  name: string;
  projectNumber: string;
}

export interface GcloudResult<T> {
  ok: true;
  value: T;
}

export interface GcloudError {
  ok: false;
  code: "NOT_INSTALLED" | "NOT_AUTHENTICATED" | "COMMAND_FAILED";
  message: string;
}

export type GcloudOutcome<T> = GcloudResult<T> | GcloudError;

function runGcloud(args: string[]): GcloudOutcome<string> {
  try {
    const out = execFileSync("gcloud", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, value: out };
  } catch (err: unknown) {
    const e = err as { code?: string; stderr?: Buffer | string };
    if (e.code === "ENOENT") {
      return {
        ok: false,
        code: "NOT_INSTALLED",
        message: "gcloud CLI is not installed",
      };
    }
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : (e.stderr?.toString("utf-8") ?? "");
    if (/you do not currently have an active account|please run.*auth login/i.test(stderr)) {
      return {
        ok: false,
        code: "NOT_AUTHENTICATED",
        message: "gcloud is not authenticated — run `gcloud auth login`",
      };
    }
    return {
      ok: false,
      code: "COMMAND_FAILED",
      message: stderr.split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "gcloud command failed",
    };
  }
}

export function isGcloudInstalled(): boolean {
  try {
    execFileSync("gcloud", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function gcloudAccount(): GcloudOutcome<string> {
  const result = runGcloud([
    "auth",
    "list",
    "--filter=status:ACTIVE",
    "--format=value(account)",
  ]);
  if (!result.ok) return result;
  const account = result.value.trim();
  if (!account) {
    return {
      ok: false,
      code: "NOT_AUTHENTICATED",
      message: "No active gcloud account — run `gcloud auth login`",
    };
  }
  return { ok: true, value: account };
}

export function listProjects(): GcloudOutcome<GcloudProject[]> {
  const result = runGcloud([
    "projects",
    "list",
    "--format=json",
    "--limit=100",
  ]);
  if (!result.ok) return result;
  try {
    const parsed = JSON.parse(result.value) as Array<{
      projectId: string;
      name: string;
      projectNumber: string;
    }>;
    return { ok: true, value: parsed };
  } catch {
    return {
      ok: false,
      code: "COMMAND_FAILED",
      message: "Failed to parse gcloud projects list output",
    };
  }
}

export function createProject(
  projectId: string,
  displayName: string,
): GcloudOutcome<GcloudProject> {
  const result = runGcloud([
    "projects",
    "create",
    projectId,
    `--name=${displayName}`,
    "--format=json",
  ]);
  if (!result.ok) return result;
  try {
    const parsed = JSON.parse(result.value) as {
      projectId: string;
      name: string;
      projectNumber: string;
    };
    return { ok: true, value: parsed };
  } catch {
    return {
      ok: true,
      value: { projectId, name: displayName, projectNumber: "" },
    };
  }
}

export function enableApis(
  projectId: string,
  apis: string[],
): GcloudOutcome<true> {
  const result = runGcloud([
    "services",
    "enable",
    ...apis,
    `--project=${projectId}`,
  ]);
  if (!result.ok) return result;
  return { ok: true, value: true };
}

export function listEnabledApis(
  projectId: string,
): GcloudOutcome<string[]> {
  const result = runGcloud([
    "services",
    "list",
    "--enabled",
    `--project=${projectId}`,
    "--format=value(config.name)",
  ]);
  if (!result.ok) return result;
  return {
    ok: true,
    value: result.value.split("\n").map((l) => l.trim()).filter(Boolean),
  };
}
