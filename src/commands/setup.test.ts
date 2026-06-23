import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { setupCommand, SETUP_HELP } from "./setup.js";

describe("setup command", () => {
  it("returns help for --help without installing", async () => {
    await expect(setupCommand(["--help"])).resolves.toBe(SETUP_HELP);
  });

  it("rejects an unknown action with VALIDATION_ERROR", async () => {
    await expect(setupCommand(["frobnicate"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects a missing action with VALIDATION_ERROR (AxiError)", async () => {
    try {
      await setupCommand([]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("SETUP_HELP documents the single `setup hooks` action", () => {
    expect(SETUP_HELP).toContain("gws-axi setup hooks");
  });
});
