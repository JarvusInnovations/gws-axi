import { beforeEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import type { calendar_v3 } from "googleapis";
import type * as GoogleClient from "../../google/client.js";
import { calendarEventsCommand } from "./events.js";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../google/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GoogleClient>()),
  calendarClient: async () => ({ events: { list } }),
}));

const account = "alice@example.com";
const windowArgs = ["--from", "2026-04-20", "--to", "2026-04-20"];
const dates = { start: { date: "2026-04-20" }, end: { date: "2026-04-21" } };
const items: calendar_v3.Schema$Event[] = [
  { id: "leave", summary: "Out of office", eventType: "outOfOffice", status: "confirmed" },
  { id: "regular", summary: "Out of office", eventType: "default", status: "confirmed" },
  { id: "focus", eventType: "focusTime", status: "tentative" },
  { id: "new", eventType: "futureType", status: "confirmed" },
  { id: "missing", status: "confirmed" },
  { id: "null-type", eventType: null, status: "confirmed" },
].map((event) => ({ ...dates, ...event }));

function decodeEvents(output: string) {
  // The trailing AXI help block is guidance, not part of the TOON data.
  const data = decode(output.split("\nhelp[")[0]);
  if (!data || typeof data !== "object" || !("events" in data) || !Array.isArray(data.events)) {
    throw new Error("Expected a TOON event list");
  }
  return data.events;
}

describe("calendar events --fields eventType", () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue({ data: { items } });
  });

  it("shows exact Google types alongside status and the event interval", async () => {
    const output = await calendarEventsCommand(account, [
      ...windowArgs,
      "--fields",
      "status,eventType",
    ]);
    const events = decodeEvents(output);

    expect(output).toContain(
      "events[6]{id,summary,start,end,my_response,attachments,status,eventType}:",
    );
    expect(events).toMatchObject([
      { id: "leave", status: "ok", eventType: "outOfOffice", start: "2026-04-20", end: "2026-04-21" },
      { id: "regular", status: "ok", eventType: "default" },
      { id: "focus", status: "tentative", eventType: "focusTime" },
      { id: "new", status: "ok", eventType: "futureType" },
      { id: "missing", status: "ok", eventType: "" },
      { id: "null-type", status: "ok", eventType: "" },
    ]);
  });

  it("keeps the default columns when eventType is not requested", async () => {
    const output = await calendarEventsCommand(account, windowArgs);
    expect(output).toContain("events[6]{id,summary,start,end,my_response,attachments}:");
  });

  it("rejects a misspelled field before listing events", async () => {
    await expect(
      calendarEventsCommand(account, ["--fields", "status,eventtype"]),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Unknown --fields value: eventtype",
    });
    expect(list).not.toHaveBeenCalled();
  });
});
