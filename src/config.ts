import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SETUP_VERSION = 1;
export const CONFIG_VERSION = 1;

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

export interface UserConfig {
  version: number;
  default_account?: string;
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

// Paths ────────────────────────────────────────────────────────────
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

export function userConfigPath(): string {
  return join(configDir(), "config.json");
}

export function accountsDir(): string {
  return join(configDir(), "accounts");
}

export function accountDir(email: string): string {
  return join(accountsDir(), normalizeEmail(email));
}

export function tokensPathForAccount(email: string): string {
  return join(accountDir(email), "tokens.json");
}

export function profilePathForAccount(email: string): string {
  return join(accountDir(email), "profile.json");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Setup state ──────────────────────────────────────────────────────
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

// User config (default_account, etc.) ──────────────────────────────
export function defaultUserConfig(): UserConfig {
  return { version: CONFIG_VERSION };
}

export function readUserConfig(): UserConfig {
  const path = userConfigPath();
  if (!existsSync(path)) return defaultUserConfig();
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as UserConfig;
  } catch {
    return defaultUserConfig();
  }
}

export function writeUserConfig(cfg: UserConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(userConfigPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}

// Accounts ─────────────────────────────────────────────────────────
export function listAccounts(): string[] {
  const dir = accountsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => {
        const p = join(dir, name);
        return (
          statSync(p).isDirectory() && existsSync(join(p, "tokens.json"))
        );
      })
      .map((name) => name.toLowerCase())
      .sort();
  } catch {
    return [];
  }
}

export function hasAccount(email: string): boolean {
  return existsSync(tokensPathForAccount(email));
}

export function removeAccount(email: string): void {
  const dir = accountDir(email);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  const cfg = readUserConfig();
  if (cfg.default_account === normalizeEmail(email)) {
    const remaining = listAccounts();
    cfg.default_account = remaining[0];
    writeUserConfig(cfg);
  }
}

export function getDefaultAccount(): string | undefined {
  const cfg = readUserConfig();
  if (cfg.default_account && hasAccount(cfg.default_account)) {
    return cfg.default_account;
  }
  const accounts = listAccounts();
  if (accounts.length === 1) return accounts[0];
  return undefined;
}

export function setDefaultAccount(email: string): void {
  const cfg = readUserConfig();
  cfg.default_account = normalizeEmail(email);
  writeUserConfig(cfg);
}

export { SETUP_STEP_ORDER };
