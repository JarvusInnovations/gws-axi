import { copyFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { credentialsPath, type SetupState, type SetupStepKey } from "../config.js";
import { markStepDone, updateStepMetadata } from "./state.js";
import {
  createProject,
  enableApis,
  gcloudAccount,
  isGcloudInstalled,
  listEnabledApis,
  listProjects,
} from "./gcloud.js";
import { allApis, REQUIRED_APIS, SERVICES } from "./scopes.js";

export interface SetupFlags {
  projectId?: string;
  createProject?: string;
  projectName?: string;
  credentialsJson?: string;
  testUserEmail?: string;
  port?: number;
}

export interface DeepLink {
  label: string;
  url: string;
}

export interface StepOutcome {
  step: SetupStepKey;
  advanced: boolean;
  title: string;
  detail?: Record<string, unknown>;
  instructions?: string[];
  deep_links?: DeepLink[];
  error?: string;
  code?: string;
}

export function consoleUrl(path: string, projectId?: string): string {
  const base = `https://console.cloud.google.com${path}`;
  return projectId ? `${base}?project=${encodeURIComponent(projectId)}` : base;
}

// STEP 1 — gcp_project ─────────────────────────────────────────────
export async function advanceGcpProject(flags: SetupFlags): Promise<StepOutcome> {
  const step: SetupStepKey = "gcp_project";

  if (flags.projectId) {
    if (isGcloudInstalled()) {
      const projects = listProjects();
      if (projects.ok) {
        const found = projects.value.find((p) => p.projectId === flags.projectId);
        if (!found) {
          return {
            step,
            advanced: false,
            title: "Project not found",
            error: `No project with ID '${flags.projectId}' in this gcloud account`,
            code: "PROJECT_NOT_FOUND",
            instructions: [
              "List available projects: `gcloud projects list`",
              "Or create a new one: `gws-axi auth setup --create-project <id>`",
            ],
          };
        }
      }
    }
    markStepDone(step, {
      project_id: flags.projectId,
      created_by_us: false,
    });
    return {
      step,
      advanced: true,
      title: "GCP project selected",
      detail: { project_id: flags.projectId },
    };
  }

  if (flags.createProject) {
    if (!isGcloudInstalled()) {
      return {
        step,
        advanced: false,
        title: "gcloud CLI required for project creation",
        error: "Cannot create a GCP project without the gcloud CLI",
        code: "GCLOUD_REQUIRED",
        instructions: [
          "Install the gcloud CLI: https://cloud.google.com/sdk/docs/install",
          "Or in your gws-axi setup page tab, click 'Create project in Console', then re-run with --project <id>",
        ],
      };
    }
    const displayName = flags.projectName ?? flags.createProject;
    const result = createProject(flags.createProject, displayName);
    if (!result.ok) {
      return {
        step,
        advanced: false,
        title: "Failed to create GCP project",
        error: result.message,
        code: result.code,
        instructions: [
          "Try a different project ID (must be globally unique, 6-30 chars)",
          "Or create via Console and re-run with --project <id>",
        ],
      };
    }
    markStepDone(step, {
      project_id: flags.createProject,
      created_by_us: true,
      display_name: displayName,
    });
    return {
      step,
      advanced: true,
      title: "GCP project created",
      detail: { project_id: flags.createProject },
    };
  }

  if (!isGcloudInstalled()) {
    return {
      step,
      advanced: false,
      title: "Step 1 of 7: Choose a Google Cloud project",
      instructions: [
        "In your gws-axi setup page tab, click 'Create project in Console'",
        "Copy the project ID once the project is created",
        "Re-run: `gws-axi auth setup --project <your-project-id>`",
      ],
    };
  }

  const account = gcloudAccount();
  if (!account.ok) {
    return {
      step,
      advanced: false,
      title: "gcloud not authenticated",
      error: account.message,
      code: account.code,
      instructions: ["Run: `gcloud auth login`", "Then re-run: `gws-axi auth setup`"],
    };
  }

  const projects = listProjects();
  const projectList = projects.ok ? projects.value.slice(0, 10) : [];

  return {
    step,
    advanced: false,
    title: "Step 1 of 7: Choose or create a GCP project",
    detail: {
      gcloud_account: account.value,
      existing_projects: projectList.map((p) => p.projectId),
    },
    instructions: [
      `Use an existing project: \`gws-axi auth setup --project <id>\``,
      `Or create a new one: \`gws-axi auth setup --create-project <id> --project-name "Name"\``,
      `Project IDs must be globally unique, 6-30 chars, lowercase`,
    ],
  };
}

// STEP 2 — apis_enabled ────────────────────────────────────────────
export async function advanceApisEnabled(
  _flags: SetupFlags,
  state: SetupState,
): Promise<StepOutcome> {
  const step: SetupStepKey = "apis_enabled";
  const projectId = state.steps.gcp_project.project_id;
  if (typeof projectId !== "string") {
    return {
      step,
      advanced: false,
      title: "Cannot enable APIs — project not set",
      error: "Step 1 must be completed before Step 2",
      code: "PRECONDITION_FAILED",
      instructions: ["Run `gws-axi auth setup --project <id>` first"],
    };
  }

  if (!isGcloudInstalled()) {
    return {
      step,
      advanced: false,
      title: "Step 2 of 7: Enable required APIs",
      instructions: [
        "In your gws-axi setup page tab, click each 'Enable <service>' button to enable these APIs:",
        ...SERVICES.map((s) => `  - ${s} (${REQUIRED_APIS[s]})`),
        "Then re-run: `gws-axi auth setup`",
      ],
    };
  }

  const enabled = listEnabledApis(projectId);
  const enabledSet = new Set(enabled.ok ? enabled.value : []);
  const missing = allApis().filter((api) => !enabledSet.has(api));

  if (missing.length > 0) {
    const result = enableApis(projectId, missing);
    if (!result.ok) {
      return {
        step,
        advanced: false,
        title: "Failed to enable APIs",
        error: result.message,
        code: result.code,
        instructions: [
          `Try enabling manually via: gcloud services enable ${missing.join(" ")} --project=${projectId}`,
          "Or enable via Console and re-run `gws-axi auth setup`",
        ],
      };
    }
  }

  markStepDone(step, { apis: allApis(), project_id: projectId });
  return {
    step,
    advanced: true,
    title: "APIs enabled",
    detail: { apis: allApis(), project_id: projectId },
  };
}

// STEP 3 — oauth_client (manual only) ──────────────────────────────
export async function advanceOauthClient(
  _flags: SetupFlags,
  _state: SetupState,
): Promise<StepOutcome> {
  const step: SetupStepKey = "oauth_client";

  return {
    step,
    advanced: false,
    title: "Step 3 of 7: Create a Desktop OAuth client (manual)",
    instructions: [
      "Google does not allow Desktop OAuth clients to be created via CLI/API — this step must be done in the Console",
      "In your gws-axi setup page tab, click the 'OAuth clients → Create client' link",
      "On the OAuth clients page, click '+ CREATE CLIENT'",
      "If prompted to configure the consent screen first, complete Step 5 now and return",
      'Application type: "Desktop app", Name: "gws-axi" (or any name)',
      "Click Create, then DOWNLOAD the credentials JSON",
      "Re-run: `gws-axi auth setup --credentials-json <path-to-downloaded-json>`",
    ],
  };
}

// Shared Desktop-credentials parse + validate ──────────────────────
// The single source of truth for "is this a usable Desktop OAuth client
// JSON?" — consumed by `credentials_saved` (setup), the `oauth_client`
// auto-confirm in runSetup, and `auth join`. Callers wrap the classified
// result with their own context-specific titles/instructions; the
// definition of *valid* lives here once
// ([principles.md#single-source-of-truth-helpers]).
export interface DesktopCredentials {
  client_id: string;
  client_secret: string;
  project_id?: string;
}

export type DesktopCredentialsResult =
  | { ok: true; value: DesktopCredentials }
  | { ok: false; code: "FILE_NOT_FOUND" | "INVALID_JSON" | "WRONG_CLIENT_TYPE"; message: string };

export function parseDesktopCredentials(path: string): DesktopCredentialsResult {
  if (!existsSync(path)) {
    return { ok: false, code: "FILE_NOT_FOUND", message: `No file at: ${path}` };
  }

  let parsed: {
    installed?: { client_id?: string; client_secret?: string; project_id?: string };
  };
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { ok: false, code: "INVALID_JSON", message: "JSON parse failed" };
  }

  if (!parsed.installed?.client_id || !parsed.installed?.client_secret) {
    return {
      ok: false,
      code: "WRONG_CLIENT_TYPE",
      message: 'Expected an "installed" field with client_id and client_secret',
    };
  }

  return {
    ok: true,
    value: {
      client_id: parsed.installed.client_id,
      client_secret: parsed.installed.client_secret,
      project_id: parsed.installed.project_id,
    },
  };
}

// STEP 4 — credentials_saved ───────────────────────────────────────
export async function advanceCredentialsSaved(flags: SetupFlags): Promise<StepOutcome> {
  const step: SetupStepKey = "credentials_saved";

  if (!flags.credentialsJson) {
    return {
      step,
      advanced: false,
      title: "Step 4 of 7: Save OAuth credentials JSON",
      instructions: [
        "Re-run with: `gws-axi auth setup --credentials-json <path>`",
        "Point to the JSON file you downloaded from the OAuth client creation page",
      ],
    };
  }

  const result = parseDesktopCredentials(flags.credentialsJson);
  if (!result.ok) {
    const meta: Record<string, { title: string; instructions: string[] }> = {
      FILE_NOT_FOUND: {
        title: "Credentials file not found",
        instructions: ["Check the path and re-run `gws-axi auth setup --credentials-json <path>`"],
      },
      INVALID_JSON: {
        title: "Credentials file is not valid JSON",
        instructions: ["Re-download the credentials file from the Google Cloud Console"],
      },
      WRONG_CLIENT_TYPE: {
        title: "Credentials file is not a Desktop OAuth client",
        instructions: [
          'Make sure the OAuth client type was "Desktop app" (not Web/Service account)',
          "Recreate the credentials in the Console if needed",
        ],
      },
    };
    return {
      step,
      advanced: false,
      title: meta[result.code].title,
      error: result.message,
      code: result.code,
      instructions: meta[result.code].instructions,
    };
  }

  const destPath = credentialsPath();
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(flags.credentialsJson, destPath);

  markStepDone(step, {
    path: destPath,
    client_id: result.value.client_id,
  });

  return {
    step,
    advanced: true,
    title: "Credentials saved",
    detail: { path: destPath },
  };
}

// STEP 5 — consent_screen (manual only) ────────────────────────────
export async function advanceConsentScreen(
  _flags: SetupFlags,
  _state: SetupState,
): Promise<StepOutcome> {
  const step: SetupStepKey = "consent_screen";

  return {
    step,
    advanced: false,
    title: "Step 5 of 7: Configure the OAuth consent screen (manual)",
    instructions: [
      "Google split the OAuth consent screen into two pages — you'll need both",
      "In your gws-axi setup page tab, click the 'Branding (app name, emails)' link",
      "  → App name: 'gws-axi' (or anything)",
      "  → User support email + Developer contact email: your email",
      "  → Leave logo / homepage / privacy policy blank (optional for Testing mode)",
      "  → Save",
      "Then back on the setup page, click the 'Audience (user type)' link",
      "  → Verify 'Publishing status' shows 'Testing' — if it says 'In production', click 'Back to testing' (do NOT publish)",
      "  → Verify 'User type' shows 'External' — if it says 'Internal', click 'Make external' (required unless you have a Google Workspace domain and only want to use Workspace accounts)",
      "  → This page has no Save button — state changes take effect when you click those toggle buttons",
      "  → Staying in Testing mode means tokens expire every 7 days (expected, we'll handle this later)",
      "When done, mark this step complete: `gws-axi auth setup --confirm-step consent_screen`",
    ],
  };
}

// STEP 6 — test_user_added (manual only) ───────────────────────────
export async function advanceTestUserAdded(
  flags: SetupFlags,
  _state: SetupState,
): Promise<StepOutcome> {
  const step: SetupStepKey = "test_user_added";

  if (flags.testUserEmail) {
    updateStepMetadata(step, { email: flags.testUserEmail });
  }

  return {
    step,
    advanced: false,
    title: "Step 6 of 7: Add yourself as a test user (manual)",
    instructions: [
      "In your gws-axi setup page tab, click the 'Audience → Test users' link",
      'On that page, scroll to "Test users" and click "+ ADD USERS"',
      "Enter each Google account you plan to authenticate (personal, work, etc.) and click Save",
      "gws-axi supports multiple accounts with the same OAuth client — add them all now",
      "Without this, the OAuth flow will reject those users with access_denied",
      "When done, mark complete: `gws-axi auth setup --confirm-step test_user_added --test-user <primary-email>`",
      "After setup completes, use `gws-axi auth login --account <email>` to authenticate each additional account",
    ],
  };
}
