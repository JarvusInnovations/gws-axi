import {
  getAccountLock,
  getDefaultAccount,
  hasAccount,
  listAccounts,
  readSetupState,
  setupProgress,
} from "../config.js";
import { joinBlocks, renderHelp, renderObject } from "../output/index.js";

export async function homeCommand(): Promise<string> {
  const state = readSetupState();
  const { done, total, nextStep } = setupProgress(state);
  const accounts = listAccounts();
  const defaultAccount = getDefaultAccount();
  const lock = getAccountLock();
  const lockValid = lock !== undefined && hasAccount(lock);

  const fields: Record<string, unknown> = {};

  if (lock && !lockValid) {
    // A broken pin means NO account resolves — every command raises
    // ACCOUNT_LOCK_INVALID. Reporting an `account:` here would name one that
    // nothing will actually run as, so the lock line stands alone.
    fields.account_lock = `${lock} (GWS_AXI_ACCOUNT) — NOT AUTHENTICATED, every command will fail`;
    fields.authenticated_accounts = accounts;
  } else if (accounts.length > 0) {
    const active = lockValid ? (lock as string) : (defaultAccount ?? accounts[0]);
    fields.account = active;
    if (lockValid) fields.account_lock = `${lock} (GWS_AXI_ACCOUNT)`;
    if (accounts.length > 1) {
      fields.other_accounts = accounts.filter((a) => a !== active);
      // Under a valid pin the pin IS the explicit account choice write-protection
      // demands, so writes need no --account (specs/api/conventions.md#environment).
      fields.write_protection = lockValid
        ? "satisfied by the GWS_AXI_ACCOUNT pin (writes need no --account)"
        : "enabled (2+ accounts — writes require --account)";
    }
  }

  const setup: Record<string, unknown> = {
    progress: `${done} of ${total} steps complete`,
  };
  if (nextStep) setup.next_step = nextStep;
  fields.setup = setup;

  const help: string[] = [];
  if (done < total) {
    help.push("Run `gws-axi auth setup` to continue setup");
  } else if (accounts.length === 0) {
    help.push("Run `gws-axi auth login` to authenticate your first account");
  } else if (lock && !lockValid) {
    help.push(`Authenticate the pinned account: \`gws-axi auth login --account ${lock}\``);
    help.push("Or clear the pin for this shell: `unset GWS_AXI_ACCOUNT`");
  } else {
    help.push("Run `gws-axi doctor` to check auth + runtime health");
    help.push("Run `gws-axi calendar events` to list upcoming events");
    if (lockValid) {
      // No "add another account" nudge — this environment can only act as the
      // pinned one, so a second account would be unreachable from here.
      help.push("This environment is pinned by GWS_AXI_ACCOUNT; `--account <other>` is refused");
    } else if (accounts.length === 1) {
      help.push("Run `gws-axi auth login --account <email>` to add another account");
    } else {
      help.push("Run `gws-axi auth accounts` to see all accounts");
    }
  }
  help.push(
    "Run `gws-axi --help` to see the full command list, or `gws-axi <command> --help` for usage on any command",
  );

  // Return a composed string (not an object) so the help block renders
  // multi-line — the canonical AXI form. The SDK prepends the bin/description
  // header to a string home result.
  return joinBlocks(renderObject(fields), renderHelp(help));
}
