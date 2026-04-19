import { readSetupState, setupProgress } from "../config.js";

export async function homeCommand(): Promise<Record<string, unknown>> {
  const state = readSetupState();
  const { done, total, nextStep } = setupProgress(state);

  const setup: Record<string, unknown> = {
    mode: state.auth_mode,
    progress: `${done} of ${total} steps complete`,
  };
  if (nextStep) {
    setup.next_step = nextStep;
  }

  const help: string[] = [];
  if (done < total) {
    help.push("Run `gws-axi auth setup` to continue setup");
  } else {
    help.push("Run `gws-axi doctor` to check auth + runtime health");
    help.push("Run `gws-axi calendar events` to list upcoming events");
  }
  help.push("Run `gws-axi --help` for the full command list");

  return {
    setup,
    help,
  };
}
