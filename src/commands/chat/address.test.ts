import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseSpaceId, resolveSpaceTarget, spaceResourceName } from "./address.js";

const USAGE = "usage: gws-axi chat messages <space>";

function errorFrom(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AxiError);
    return err as AxiError;
  }
  throw new Error("expected a throw");
}

describe("parseSpaceId", () => {
  it("accepts the bare id and the resource name alike", () => {
    expect(parseSpaceId("AAAAxyz_-9")).toBe("AAAAxyz_-9");
    expect(parseSpaceId("spaces/AAAAxyz_-9")).toBe("AAAAxyz_-9");
    expect(parseSpaceId("  AAAAxyz  ")).toBe("AAAAxyz");
  });

  it.each([
    ["https://chat.google.com/room/AAAAxyz", "AAAAxyz"],
    ["https://chat.google.com/room/AAAAxyz?cls=11", "AAAAxyz"],
    ["https://chat.google.com/dm/BBBBabc", "BBBBabc"],
    ["https://mail.google.com/chat/u/0/#chat/space/AAAAxyz", "AAAAxyz"],
    ["https://mail.google.com/chat/u/1/#chat/dm/BBBBabc", "BBBBabc"],
    // A thread link still names its conversation first.
    ["https://chat.google.com/room/AAAAxyz/t8Qthread", "AAAAxyz"],
  ])("reduces %s to its id", (url, id) => {
    expect(parseSpaceId(url)).toBe(id);
  });

  it("rejects a URL with no conversation id in it", () => {
    const err = errorFrom(() => parseSpaceId("https://chat.google.com/"));
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a display name and explains that names are not addresses", () => {
    const err = errorFrom(() => parseSpaceId("Transit Data"));
    expect(err.code).toBe("VALIDATION_ERROR");
    const text = err.suggestions.join(" ");
    expect(text).toContain("not by name");
    expect(text).toContain("chat spaces --name");
    expect(text).toContain("--with <email>");
  });

  it("rejects an empty value", () => {
    expect(errorFrom(() => parseSpaceId("   ")).code).toBe("VALIDATION_ERROR");
  });
});

describe("spaceResourceName", () => {
  it("builds the API resource name", () => {
    expect(spaceResourceName("AAAAxyz")).toBe("spaces/AAAAxyz");
  });
});

describe("resolveSpaceTarget", () => {
  it("resolves a positional to a conversation", () => {
    expect(resolveSpaceTarget({ positional: "spaces/AAAAxyz" }, USAGE)).toEqual({
      kind: "space",
      id: "AAAAxyz",
    });
  });

  it("resolves --with to a direct message, normalizing the address", () => {
    expect(resolveSpaceTarget({ withEmail: " Bob@Example.com " }, USAGE)).toEqual({
      kind: "dm",
      email: "bob@example.com",
    });
  });

  it("refuses a positional together with --with", () => {
    const err = errorFrom(() =>
      resolveSpaceTarget({ positional: "AAAAxyz", withEmail: "bob@example.com" }, USAGE),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("not both");
  });

  it("refuses neither", () => {
    expect(errorFrom(() => resolveSpaceTarget({}, USAGE)).code).toBe("VALIDATION_ERROR");
  });

  it("refuses a --with value that is not an email address", () => {
    const err = errorFrom(() => resolveSpaceTarget({ withEmail: "Bob Tran" }, USAGE));
    expect(err.code).toBe("VALIDATION_ERROR");
  });
});
