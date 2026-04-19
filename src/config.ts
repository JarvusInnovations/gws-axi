import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SETUP_VERSION = 1;

export type SetupStepKey =
  | "gcp_project"
  | "apis_enabled"
  | "oauth_client"
  | "credentials_saved"
  | "consent_screen"
  | "test_user_added"
  | "tokens_obtained";

export interface SetupStep {
  done: boolean;
  at?: string;
  [key: string]: unknown;
}

export interface SetupState {
  version: number;
  auth_mode: "byo";
  steps: Record<SetupStepKey, SetupStep>;
  last_action?: string;
  resume_hint?: string;
}

const SETUP_STEP_ORDER: SetupStepKey[] = [
  "gcp_project",
  "apis_enabled",
  "oauth_client",
  "credentials_saved",
  "consent_screen",
  "test_user_added",
  "tokens_obtained",
];

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "gws-axi") : join(homedir(), ".config", "gws-axi");
}

export function setupStatePath(): string {
  return join(configDir(), "setup.json");
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

export function tokensPath(): string {
  return join(configDir(), "tokens.json");
}

export function defaultSetupState(): SetupState {
  return {
    version: SETUP_VERSION,
    auth_mode: "byo",
    steps: Object.fromEntries(
      SETUP_STEP_ORDER.map((key) => [key, { done: false }]),
    ) as Record<SetupStepKey, SetupStep>,
  };
}

export function readSetupState(): SetupState {
  const path = setupStatePath();
  if (!existsSync(path)) {
    return defaultSetupState();
  }

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SetupState;
  } catch {
    return defaultSetupState();
  }
}

export function writeSetupState(state: SetupState): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(setupStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function setupProgress(state: SetupState): {
  done: number;
  total: number;
  nextStep: SetupStepKey | null;
} {
  let done = 0;
  let nextStep: SetupStepKey | null = null;
  for (const key of SETUP_STEP_ORDER) {
    if (state.steps[key].done) {
      done++;
    } else if (nextStep === null) {
      nextStep = key;
    }
  }
  return { done, total: SETUP_STEP_ORDER.length, nextStep };
}

export { SETUP_STEP_ORDER };
