import { describe, expect, it } from "vitest";
import { allApis } from "./auth/scopes.js";
import {
  defaultSetupState,
  isJoinedInstall,
  isStepComplete,
  missingApis,
  setupProgress,
  SETUP_STEP_ORDER,
  type SetupState,
  type SetupStep,
} from "./config.js";

/** A finished setup whose apis_enabled step is `apis`. */
function completeState(apis: SetupStep): SetupState {
  const state = defaultSetupState();
  for (const key of SETUP_STEP_ORDER) state.steps[key] = { done: true };
  state.steps.apis_enabled = apis;
  return state;
}

// What an install set up before a release added APIs looks like on disk.
const ALL = allApis();
const DROPPED = ALL[ALL.length - 1];
const OLDER_LIST = ALL.slice(0, -1);

describe("missingApis", () => {
  it("is empty when the recorded list covers every current API", () => {
    expect(missingApis(completeState({ done: true, apis: ALL }))).toEqual([]);
  });

  it("names exactly the APIs a later release added", () => {
    expect(missingApis(completeState({ done: true, apis: OLDER_LIST }))).toEqual([DROPPED]);
  });

  it("ignores recorded APIs that are no longer required", () => {
    const state = completeState({ done: true, apis: [...ALL, "retired.googleapis.com"] });
    expect(missingApis(state)).toEqual([]);
  });

  it("treats an owned step with no recorded list as stale on every API", () => {
    expect(missingApis(completeState({ done: true }))).toEqual(ALL);
  });

  it("treats a malformed recorded list as no list", () => {
    expect(missingApis(completeState({ done: true, apis: "gmail.googleapis.com" }))).toEqual(ALL);
    expect(missingApis(completeState({ done: true, apis: [42, null] }))).toEqual(ALL);
  });

  it("is never stale for a joined step, which asserted its APIs", () => {
    expect(missingApis(completeState({ done: true, via: "team-join" }))).toEqual([]);
  });

  it("is empty for a step that isn't done — that is incomplete, not stale", () => {
    expect(missingApis(completeState({ done: false }))).toEqual([]);
  });
});

describe("isStepComplete", () => {
  it("counts a stale apis_enabled as incomplete despite done: true", () => {
    const state = completeState({ done: true, apis: OLDER_LIST });
    expect(state.steps.apis_enabled.done).toBe(true);
    expect(isStepComplete(state, "apis_enabled")).toBe(false);
  });

  it("applies staleness to apis_enabled only", () => {
    const state = completeState({ done: true, apis: OLDER_LIST });
    for (const key of SETUP_STEP_ORDER) {
      if (key !== "apis_enabled") expect(isStepComplete(state, key)).toBe(true);
    }
  });
});

describe("setupProgress", () => {
  it("reports a current install complete", () => {
    const state = completeState({ done: true, apis: ALL });
    expect(setupProgress(state)).toEqual({ done: 7, total: 7, nextStep: null });
  });

  it("drops a stale install to 6 of 7 and makes apis_enabled the next step", () => {
    const state = completeState({ done: true, apis: OLDER_LIST });
    expect(setupProgress(state)).toEqual({ done: 6, total: 7, nextStep: "apis_enabled" });
  });

  it("leaves a joined install complete", () => {
    const state = completeState({ done: true, via: "team-join" });
    expect(setupProgress(state)).toEqual({ done: 7, total: 7, nextStep: null });
  });

  it("still counts a stale step's later steps as done", () => {
    // Staleness must not cascade: nothing after step 2 is reset or re-run.
    const state = completeState({ done: true, apis: OLDER_LIST });
    expect(state.steps.tokens_obtained.done).toBe(true);
    expect(setupProgress(state).done).toBe(SETUP_STEP_ORDER.length - 1);
  });
});

describe("isJoinedInstall", () => {
  it("is true when any step was marked via team-join", () => {
    expect(isJoinedInstall(completeState({ done: true, via: "team-join" }))).toBe(true);
  });

  it("is false for an owned install, including a hand-confirmed step", () => {
    expect(isJoinedInstall(completeState({ done: true, apis: ALL }))).toBe(false);
    expect(isJoinedInstall(completeState({ done: true, apis: ALL, via: "manual-confirm" }))).toBe(
      false,
    );
  });
});
