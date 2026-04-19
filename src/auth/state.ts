import {
  readSetupState,
  writeSetupState,
  type SetupState,
  type SetupStepKey,
  SETUP_STEP_ORDER,
} from "../config.js";

export function markStepDone(
  key: SetupStepKey,
  detail: Record<string, unknown> = {},
): SetupState {
  const state = readSetupState();
  state.steps[key] = {
    ...state.steps[key],
    ...detail,
    done: true,
    at: new Date().toISOString(),
  };
  updateResumeHint(state);
  writeSetupState(state);
  return state;
}

export function updateStepMetadata(
  key: SetupStepKey,
  detail: Record<string, unknown>,
): SetupState {
  const state = readSetupState();
  state.steps[key] = { ...state.steps[key], ...detail };
  updateResumeHint(state);
  writeSetupState(state);
  return state;
}

export function resetFrom(key: SetupStepKey | null): SetupState {
  const state = readSetupState();
  const startIndex = key ? SETUP_STEP_ORDER.indexOf(key) : 0;
  for (let i = startIndex; i < SETUP_STEP_ORDER.length; i++) {
    state.steps[SETUP_STEP_ORDER[i]] = { done: false };
  }
  updateResumeHint(state);
  writeSetupState(state);
  return state;
}

function updateResumeHint(state: SetupState): void {
  const next = SETUP_STEP_ORDER.find((k) => !state.steps[k].done);
  if (!next) {
    state.last_action = "complete";
    state.resume_hint = "Run `gws-axi doctor` to verify runtime health";
    return;
  }
  state.last_action = `awaiting:${next}`;
  state.resume_hint = `Run \`gws-axi auth setup\` to continue at step ${next}`;
}
