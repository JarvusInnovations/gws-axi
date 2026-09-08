import { AxiError } from "axi-sdk-js";
import {
  getAccountLock,
  getDefaultAccount,
  hasAccount,
  listAccounts,
  normalizeEmail,
} from "../config.js";

export interface ResolveAccountOptions {
  mutation: boolean;
  commandName: string;
}

/**
 * How the resolved account was chosen. `env` and `flag` are both *explicit*
 * for write-protection purposes (someone outside the command made the choice
 * deliberately); `single` and `default` are implicit.
 */
export type AccountSource = "env" | "flag" | "single" | "default";

export interface AccountResolution {
  account: string;
  source: AccountSource;
  totalAccounts: number;
  defaultAccount?: string;
  /** The GWS_AXI_ACCOUNT pin, when one is in force. */
  lockedTo?: string;
}

export function resolveAccount(
  requestedAccount: string | undefined,
  options: ResolveAccountOptions,
): AccountResolution {
  const accounts = listAccounts();

  if (accounts.length === 0) {
    throw new AxiError("No accounts authenticated", "NO_ACCOUNTS", [
      "Run `gws-axi auth setup` to configure OAuth and authenticate an account",
      "Run `gws-axi auth login` if setup is already complete",
    ]);
  }

  const defaultAccount = getDefaultAccount();

  // The GWS_AXI_ACCOUNT pin is checked BEFORE --account validation so a
  // conflict reports the lock rather than a misleading ACCOUNT_NOT_FOUND, and
  // so an invalid pin can never fall through to the default — silent fallback
  // is the exact outcome the pin was set to prevent.
  const lock = getAccountLock();
  if (lock) {
    if (!hasAccount(lock)) {
      throw new AxiError(
        `GWS_AXI_ACCOUNT is set to \`${lock}\`, which is not an authenticated account`,
        "ACCOUNT_LOCK_INVALID",
        [
          `Authenticated accounts: ${accounts.join(", ")}`,
          `Authenticate it: \`gws-axi auth login --account ${lock}\``,
          "Or clear the pin for this shell: `unset GWS_AXI_ACCOUNT`",
        ],
      );
    }
    const normalizedRequest = requestedAccount ? normalizeEmail(requestedAccount) : undefined;
    if (normalizedRequest && normalizedRequest !== lock) {
      throw new AxiError(
        `This environment is pinned to \`${lock}\` (GWS_AXI_ACCOUNT); \`--account ${normalizedRequest}\` cannot override it`,
        "ACCOUNT_LOCKED",
        [
          `Re-run without --account to act as ${lock}`,
          `To act as ${normalizedRequest}, run in an environment without the pin: \`env -u GWS_AXI_ACCOUNT gws-axi ${options.commandName} --account ${normalizedRequest} …\``,
        ],
      );
    }
    return {
      account: lock,
      source: "env",
      totalAccounts: accounts.length,
      defaultAccount,
      lockedTo: lock,
    };
  }

  if (requestedAccount) {
    const normalized = normalizeEmail(requestedAccount);
    if (!hasAccount(normalized)) {
      throw new AxiError(`Account ${normalized} is not authenticated`, "ACCOUNT_NOT_FOUND", [
        `Authenticated accounts: ${accounts.join(", ")}`,
        `Run \`gws-axi auth login --account ${normalized}\` to add it`,
        "Run `gws-axi auth accounts` to see all authenticated accounts",
      ]);
    }
    return {
      account: normalized,
      source: "flag",
      totalAccounts: accounts.length,
      defaultAccount,
    };
  }

  if (accounts.length === 1) {
    return {
      account: accounts[0],
      source: "single",
      totalAccounts: 1,
      defaultAccount,
    };
  }

  if (options.mutation) {
    throw new AxiError(
      `\`${options.commandName}\` mutates state; --account is required when multiple accounts are authenticated`,
      "ACCOUNT_REQUIRED",
      [
        `Authenticated accounts: ${accounts.join(", ")}`,
        `Default account: ${defaultAccount ?? "(none set)"}`,
        `Run with --account ${defaultAccount ?? accounts[0]} to use ${defaultAccount ? "the default" : "an account"}`,
        "Multi-account write protection prevents silent wrong-account mutations",
        "Or pin this environment to one account: `export GWS_AXI_ACCOUNT=<email>`",
      ],
    );
  }

  if (!defaultAccount) {
    throw new AxiError("No default account set", "NO_DEFAULT_ACCOUNT", [
      `Authenticated accounts: ${accounts.join(", ")}`,
      `Run \`gws-axi auth use <email>\` to set a default`,
      "Or pass --account <email> to this command",
    ]);
  }

  return {
    account: defaultAccount,
    source: "default",
    totalAccounts: accounts.length,
    defaultAccount,
  };
}

/**
 * The `account_source` value for a resolution, or undefined when the account
 * needs no disclosure (it was named on the command line, or it is the only one).
 *
 * `env` is disclosed unconditionally — with one account authenticated no
 * account_source line would otherwise appear, and that is precisely when a
 * reader most needs to know an invisible pin decided this.
 */
export function accountSourceLabel(resolution: AccountResolution): string | undefined {
  if (resolution.source === "env") return "env";
  if (resolution.source === "default" && resolution.totalAccounts > 1) return "default";
  return undefined;
}

export function accountHeaderFields(resolution: AccountResolution): Record<string, unknown> {
  const fields: Record<string, unknown> = { account: resolution.account };
  const source = accountSourceLabel(resolution);
  if (source) fields.account_source = source;
  return fields;
}

/**
 * Splice the `account_source` disclosure into a handler's rendered output.
 *
 * Handlers render `account: <email>` themselves but receive only the resolved
 * email, so the dispatcher is the last place that still knows *how* the account
 * was chosen. Inserting here keeps that knowledge in one place instead of
 * threading an AccountResolution through ~50 handler signatures.
 */
export function withAccountSource(resolution: AccountResolution, output: string): string {
  const source = accountSourceLabel(resolution);
  if (!source) return output;
  const line = `account_source: ${source}`;
  const lines = output.split("\n");
  const at = lines.findIndex((l) => l.startsWith("account:"));
  if (at === -1) return `${line}\n${output}`;
  lines.splice(at + 1, 0, line);
  return lines.join("\n");
}
