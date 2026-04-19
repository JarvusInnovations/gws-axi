import {
  getDefaultAccount,
  listAccounts,
  readSetupState,
  setupProgress,
} from "../config.js";

export async function homeCommand(): Promise<Record<string, unknown>> {
  const state = readSetupState();
  const { done, total, nextStep } = setupProgress(state);
  const accounts = listAccounts();
  const defaultAccount = getDefaultAccount();

  const output: Record<string, unknown> = {};

  if (accounts.length > 0) {
    output.account = defaultAccount ?? accounts[0];
    if (accounts.length > 1) {
      output.other_accounts = accounts.filter(
        (a) => a !== (defaultAccount ?? accounts[0]),
      );
      output.write_protection = "enabled (2+ accounts — writes require --account)";
    }
  }

  const setup: Record<string, unknown> = {
    progress: `${done} of ${total} steps complete`,
  };
  if (nextStep) setup.next_step = nextStep;
  output.setup = setup;

  const help: string[] = [];
  if (done < total) {
    help.push("Run `gws-axi auth setup` to continue setup");
  } else if (accounts.length === 0) {
    help.push("Run `gws-axi auth login` to authenticate your first account");
  } else {
    help.push("Run `gws-axi doctor` to check auth + runtime health");
    help.push("Run `gws-axi calendar events` to list upcoming events");
    if (accounts.length === 1) {
      help.push("Run `gws-axi auth login --account <email>` to add another account");
    } else {
      help.push("Run `gws-axi auth accounts` to see all accounts");
    }
  }
  help.push("Run `gws-axi --help` for the full command list");
  output.help = help;

  return output;
}
