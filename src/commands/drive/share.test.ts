import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseRenameFlags } from "./rename.js";
import {
  checkAddresses,
  parseShareFlags,
  parseUnshareFlags,
  planShare,
  planUnshare,
} from "./share.js";

function errorFrom(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AxiError);
    return err as AxiError;
  }
  throw new Error("expected a throw");
}

const direct = (role: string) => ({
  id: "p1",
  role,
  emailAddress: "a@x.org",
  permissionDetails: [{ inherited: false, role }],
});
const inherited = (role: string) => ({
  id: "p2",
  role,
  emailAddress: "a@x.org",
  permissionDetails: [{ inherited: true, role }],
});

describe("addresses", () => {
  it("accepts named addresses, lowercased and de-duplicated", () => {
    expect(checkAddresses(["Lead@School.org", "lead@school.org", "b@x.org"])).toEqual([
      "lead@school.org",
      "b@x.org",
    ]);
  });

  it.each(["anyone", "anyoneWithLink", "school.org", "@school.org", "domain:school.org"])(
    "refuses %j as public or domain-wide sharing",
    (value) => {
      const err = errorFrom(() => checkAddresses([value]));
      expect(err.code).toBe("PUBLIC_SHARING_REFUSED");
      expect(err.suggestions.join(" ")).toContain("no flag");
    },
  );

  it("refuses the whole command if any address is bad", () => {
    expect(errorFrom(() => checkAddresses(["a@x.org", "anyone"])).code).toBe(
      "PUBLIC_SHARING_REFUSED",
    );
  });
});

describe("parseShareFlags", () => {
  it("takes comma-separated and repeated --with", () => {
    const flags = parseShareFlags([
      "F1",
      "--with",
      "a@x.org,b@x.org",
      "--with",
      "c@x.org",
      "--role",
      "reader",
    ]);
    expect(flags.addresses).toEqual(["a@x.org", "b@x.org", "c@x.org"]);
    expect(flags).toMatchObject({ fileId: "F1", role: "reader", notify: true, group: false });
  });

  it("requires a role from the allowed three — no ownership", () => {
    expect(errorFrom(() => parseShareFlags(["F1", "--with", "a@x.org"])).message).toContain(
      "--role",
    );
    expect(
      errorFrom(() => parseShareFlags(["F1", "--with", "a@x.org", "--role", "owner"])).code,
    ).toBe("VALIDATION_ERROR");
  });

  it("refuses a message when not notifying", () => {
    expect(
      errorFrom(() =>
        parseShareFlags([
          "F1",
          "--with",
          "a@x.org",
          "--role",
          "reader",
          "--no-notify",
          "--message",
          "hi",
        ]),
      ).code,
    ).toBe("VALIDATION_ERROR");
  });

  it("refuses an unknown flag rather than sharing without it", () => {
    expect(
      errorFrom(() => parseShareFlags(["F1", "--with", "a@x.org", "--role", "reader", "--public"]))
        .message,
    ).toContain("--public");
  });
});

describe("planShare", () => {
  it("creates when there's no permission, or only an inherited one", () => {
    expect(planShare(undefined, "reader")).toEqual({ kind: "create" });
    expect(planShare(inherited("reader"), "writer")).toEqual({ kind: "create" });
  });

  it("does nothing when the role already matches", () => {
    expect(planShare(direct("reader"), "reader")).toEqual({
      kind: "none",
      status: "already_shared",
    });
  });

  it("updates up and down — never relies on create, which ignores downgrades", () => {
    expect(planShare(direct("reader"), "writer")).toEqual({
      kind: "update",
      permissionId: "p1",
      from: "reader",
    });
    expect(planShare(direct("writer"), "reader")).toEqual({
      kind: "update",
      permissionId: "p1",
      from: "writer",
    });
  });
});

describe("planUnshare", () => {
  it("removes a direct permission", () => {
    expect(planUnshare(direct("reader"))).toEqual({
      kind: "delete",
      permissionId: "p1",
      role: "reader",
    });
  });

  it("reports rather than attempts the cases Drive would refuse", () => {
    expect(planUnshare(undefined)).toMatchObject({ kind: "none", status: "not_shared" });
    expect(planUnshare(inherited("reader"))).toMatchObject({ kind: "none", status: "inherited" });
    expect(planUnshare({ ...direct("owner"), role: "owner" })).toMatchObject({
      kind: "none",
      status: "owner",
    });
  });
});

describe("parseUnshareFlags / parseRenameFlags", () => {
  it("takes one file and addresses", () => {
    expect(parseUnshareFlags(["F1", "--with", "a@x.org"])).toEqual({
      fileId: "F1",
      addresses: ["a@x.org"],
    });
  });

  it("requires a non-blank name for rename", () => {
    expect(parseRenameFlags(["F1", "--name", "New"])).toEqual({ fileId: "F1", name: "New" });
    expect(errorFrom(() => parseRenameFlags(["F1", "--name", "  "])).code).toBe("VALIDATION_ERROR");
    expect(errorFrom(() => parseRenameFlags(["--name", "x"])).message).toContain("file id");
  });
});
