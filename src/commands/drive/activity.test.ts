import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import {
  buildFilter,
  parseFlags,
  primaryActionLabel,
  primaryActor,
  primaryTarget,
} from "./activity.js";

describe("drive activity parseFlags", () => {
  it("parses a bare itemId with defaults", () => {
    const f = parseFlags(["1V09rp"]);
    expect(f.itemId).toBe("1V09rp");
    expect(f.folder).toBe(false);
    expect(f.actions).toEqual([]);
    expect(f.limit).toBe(50);
  });

  it("parses --folder / --recursive as folder scope", () => {
    expect(parseFlags(["x", "--folder"]).folder).toBe(true);
    expect(parseFlags(["x", "--recursive"]).folder).toBe(true);
  });

  it("parses --action into a normalized list", () => {
    const f = parseFlags(["x", "--action", "Create, permission_change"]);
    expect(f.actions).toEqual(["create", "permission_change"]);
  });

  it("rejects an unknown --action with VALIDATION_ERROR", () => {
    try {
      parseFlags(["x", "--action", "frobnicate"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("throws VALIDATION_ERROR when itemId is missing", () => {
    try {
      parseFlags(["--folder"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("buildFilter", () => {
  it("is empty with no time/action constraints", () => {
    expect(buildFilter(parseFlags(["x"]))).toBe("");
  });

  it("combines time bounds and action cases with AND", () => {
    const f = parseFlags([
      "x",
      "--since",
      "2026-01-01",
      "--action",
      "permission_change,delete",
    ]);
    const filter = buildFilter(f);
    expect(filter).toContain('time >= "');
    expect(filter).toContain(
      "detail.action_detail_case:(PERMISSION_CHANGE DELETE)",
    );
    expect(filter).toContain(" AND ");
  });
});

describe("activity field extraction", () => {
  it("labels the primary action from actions[].detail", () => {
    const activity = { actions: [{ detail: { rename: {} } }] };
    expect(primaryActionLabel(activity)).toBe("rename");
  });

  it("falls back to primaryActionDetail", () => {
    const activity = { primaryActionDetail: { permissionChange: {} } };
    expect(primaryActionLabel(activity)).toBe("permission_change");
  });

  it("returns unknown when no recognizable action present", () => {
    expect(primaryActionLabel({})).toBe("unknown");
  });

  it("extracts a knownUser personName as actor", () => {
    const activity = {
      actors: [{ user: { knownUser: { personName: "people/123" } } }],
    };
    expect(primaryActor(activity)).toBe("people/123");
  });

  it("reports anonymous/deleted actors with a stable label", () => {
    expect(primaryActor({ actors: [{ anonymous: {} }] })).toBe("anonymous");
    expect(
      primaryActor({ actors: [{ user: { deletedUser: {} } }] }),
    ).toBe("deleted-user");
  });

  it("renders driveItem title with id when both present", () => {
    const activity = {
      targets: [{ driveItem: { title: "Roadmap.gdoc", name: "items/1V09rp" } }],
    };
    expect(primaryTarget(activity)).toBe("Roadmap.gdoc (1V09rp)");
  });

  it("falls back to the bare id when title is absent", () => {
    const activity = { targets: [{ driveItem: { name: "items/1V09rp" } }] };
    expect(primaryTarget(activity)).toBe("1V09rp");
  });
});
