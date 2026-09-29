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
import { allApis } from "./auth/scopes.js";

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
  // Set when the user has published their OAuth consent screen to
  // "In Production" via `gws-axi auth publish --confirm`. Lifts the 7-day
  // refresh-token expiry that applies in "Testing" state.
  published?: { confirmed_at: string };
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

/**
 * Cache of remote per-account API preferences (currently the Calendar
 * `weekStart` setting). Deliberately NOT profile.json: the auth flow rewrites
 * that file wholesale from the id_token, which would clobber anything cached
 * alongside it on every re-login.
 */
export function settingsPathForAccount(email: string): string {
  return join(accountDir(email), "settings.json");
}

/**
 * Cache of people resolved through the People API. Its own file for the same
 * reason settings.json is: profile.json is rewritten wholesale on every login.
 */
export function peoplePathForAccount(email: string): string {
  return join(accountDir(email), "people.json");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The `GWS_AXI_ACCOUNT` pin — an account every command in this environment is
 * locked to — normalized, or `undefined` when unset.
 *
 * A blank value counts as UNSET, never as a pin matching no account: an
 * exported-but-empty `GWS_AXI_ACCOUNT=` would otherwise brick every command
 * with ACCOUNT_LOCK_INVALID. (Same class of bug as `Number("") === 0` in
 * week-start.ts — an empty value parsing as *valid* rather than absent.)
 *
 * Read from `process.env` per call, never cached at module load, so tests and
 * long-lived processes see the current environment.
 */
export function getAccountLock(): string | undefined {
  const raw = process.env.GWS_AXI_ACCOUNT;
  if (!raw || !raw.trim()) return undefined;
  return normalizeEmail(raw);
}

// Setup state ──────────────────────────────────────────────────────
export function defaultSetupState(): SetupState {
  return {
    version: SETUP_VERSION,
    auth_mode: "byo",
    steps: Object.fromEntries(SETUP_STEP_ORDER.map((key) => [key, { done: false }])) as Record<
      SetupStepKey,
      SetupStep
    >,
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

/**
 * Did this install adopt a shared OAuth client via `auth join`? A joined
 * teammate has no access to the shared GCP project, so nothing may send them to
 * the Cloud Console or to `auth setup` for project-side work.
 */
export function isJoinedInstall(state: SetupState): boolean {
  return SETUP_STEP_ORDER.some((key) => state.steps[key]?.via === "team-join");
}

/**
 * APIs a completed `apis_enabled` step has gone stale on — in `allApis()` now,
 * but absent from the list the step recorded when it ran. Empty when the step
 * is current, and empty when it isn't done at all (that is "incomplete", which
 * `done` already says).
 *
 * A joined step asserted its APIs rather than recording them and can't enable
 * one anyway, so it is never stale; a missing API reaches a joined install as
 * a runtime API_NOT_ENABLED instead. An owned step with no recorded list
 * (written before the list existed, or confirmed by hand) is stale on every
 * API — the list is the only evidence there is.
 *
 * See specs/architecture.md § Auth model.
 */
export function missingApis(state: SetupState): string[] {
  const step = state.steps.apis_enabled;
  if (!step?.done || step.via === "team-join") return [];
  const recorded = Array.isArray(step.apis)
    ? step.apis.filter((api): api is string => typeof api === "string")
    : [];
  return allApis().filter((api) => !recorded.includes(api));
}

/**
 * Whether a setup step counts as complete. Every reader of step completion
 * routes through this rather than `steps[key].done`, so a stale `apis_enabled`
 * is incomplete everywhere at once.
 */
export function isStepComplete(state: SetupState, key: SetupStepKey): boolean {
  if (!state.steps[key]?.done) return false;
  if (key === "apis_enabled") return missingApis(state).length === 0;
  return true;
}

export function setupProgress(state: SetupState): {
  done: number;
  total: number;
  nextStep: SetupStepKey | null;
} {
  let done = 0;
  let nextStep: SetupStepKey | null = null;
  for (const key of SETUP_STEP_ORDER) {
    if (isStepComplete(state, key)) {
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
        return statSync(p).isDirectory() && existsSync(join(p, "tokens.json"));
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
