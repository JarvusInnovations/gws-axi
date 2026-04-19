import { AxiError } from "axi-sdk-js";
import {
  getDefaultAccount,
  hasAccount,
  listAccounts,
  normalizeEmail,
} from "../config.js";

export interface ResolveAccountOptions {
  mutation: boolean;
  commandName: string;
}

export interface AccountResolution {
  account: string;
  totalAccounts: number;
  defaultAccount?: string;
  explicit: boolean;
}

export function resolveAccount(
  requestedAccount: string | undefined,
  options: ResolveAccountOptions,
): AccountResolution {
  const accounts = listAccounts();

  if (accounts.length === 0) {
    throw new AxiError(
      "No accounts authenticated",
      "NO_ACCOUNTS",
      [
        "Run `gws-axi auth setup` to configure OAuth and authenticate an account",
        "Run `gws-axi auth login` if setup is already complete",
      ],
    );
  }

  const defaultAccount = getDefaultAccount();

  if (requestedAccount) {
    const normalized = normalizeEmail(requestedAccount);
    if (!hasAccount(normalized)) {
      throw new AxiError(
        `Account ${normalized} is not authenticated`,
        "ACCOUNT_NOT_FOUND",
        [
          `Authenticated accounts: ${accounts.join(", ")}`,
          `Run \`gws-axi auth login --account ${normalized}\` to add it`,
          "Run `gws-axi auth accounts` to see all authenticated accounts",
        ],
      );
    }
    return {
      account: normalized,
      totalAccounts: accounts.length,
      defaultAccount,
      explicit: true,
    };
  }

  if (accounts.length === 1) {
    return {
      account: accounts[0],
      totalAccounts: 1,
      defaultAccount,
      explicit: false,
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
      ],
    );
  }

  if (!defaultAccount) {
    throw new AxiError(
      "No default account set",
      "NO_DEFAULT_ACCOUNT",
      [
        `Authenticated accounts: ${accounts.join(", ")}`,
        `Run \`gws-axi auth use <email>\` to set a default`,
        "Or pass --account <email> to this command",
      ],
    );
  }

  return {
    account: defaultAccount,
    totalAccounts: accounts.length,
    defaultAccount,
    explicit: false,
  };
}

export function accountHeaderFields(
  resolution: AccountResolution,
): Record<string, unknown> {
  const fields: Record<string, unknown> = { account: resolution.account };
  if (resolution.totalAccounts > 1 && !resolution.explicit) {
    fields.account_source = "default";
  }
  return fields;
}
