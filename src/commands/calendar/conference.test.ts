import type { calendar_v3 } from "googleapis";
import { describe, expect, it } from "vitest";
import { detectProvider, extractConference, resolveJoinUrl, scrapeJoinUrl } from "./conference.js";

// Real-shape fixtures drawn from live Calendar API responses (Meet + a
// Teams meeting synced in from Outlook whose join URL is description-only).

const meetEvent: calendar_v3.Schema$Event = {
  summary: "Delivery Team Meeting",
  hangoutLink: "https://meet.google.com/nqb-ptqo-koj",
  conferenceData: {
    entryPoints: [
      {
        entryPointType: "video",
        uri: "https://meet.google.com/nqb-ptqo-koj",
        label: "meet.google.com/nqb-ptqo-koj",
      },
      { entryPointType: "more", uri: "https://tel.meet/nqb-ptqo-koj?pin=9984343524328" },
      {
        entryPointType: "phone",
        uri: "tel:+1-470-268-2857",
        label: "+1 470-268-2857",
      },
    ],
    conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet" },
    conferenceId: "nqb-ptqo-koj",
  },
};

const teamsSyncedEvent: calendar_v3.Schema$Event = {
  summary: "Transit Data - Weekly Sync",
  location: "Microsoft Teams Meeting",
  // No hangoutLink, no conferenceData — join URL lives only in the body.
  description: [
    "Team,",
    "",
    "________________________________________________________________________________",
    "Microsoft Teams meeting",
    "Join: https://teams.microsoft.com/meet/23594392319690?p=8e5nhXSwJy8vtRgHXo",
    "Meeting ID: 235 943 923 196 90",
    "________________________________",
    "System reference<https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x>",
    "Dial in by phone",
    "+1 206-485-1387,,477344212# United States, Seattle",
  ].join("\n"),
};

describe("detectProvider", () => {
  it("identifies each supported provider from a URL host", () => {
    expect(detectProvider("https://meet.google.com/nqb-ptqo-koj")).toBe("Google Meet");
    expect(detectProvider("https://us02web.zoom.us/j/123456789")).toBe("Zoom");
    expect(detectProvider("https://teams.microsoft.com/meet/2359")).toBe("Microsoft Teams");
    expect(detectProvider("https://teams.live.com/meet/9988")).toBe("Microsoft Teams");
    expect(detectProvider("https://acme.webex.com/meet/room")).toBe("Webex");
  });

  it("returns empty string for an unrecognized host", () => {
    expect(detectProvider("https://example.com/join/x")).toBe("");
    expect(detectProvider("")).toBe("");
  });
});

describe("scrapeJoinUrl", () => {
  it("extracts a Teams join URL from boilerplate, preferring the /meet/ link over /l/meetup-join/", () => {
    const hit = scrapeJoinUrl(teamsSyncedEvent.description ?? "");
    expect(hit).toEqual({
      provider: "Microsoft Teams",
      url: "https://teams.microsoft.com/meet/23594392319690?p=8e5nhXSwJy8vtRgHXo",
    });
  });

  it("stops the URL at whitespace and does not swallow a trailing angle bracket", () => {
    const hit = scrapeJoinUrl(
      "reference<https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0> more",
    );
    expect(hit?.url).toBe(
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0",
    );
  });

  it("matches Zoom and Webex join URLs", () => {
    expect(scrapeJoinUrl("please join https://us02web.zoom.us/j/8912345?pwd=abc now")).toEqual({
      provider: "Zoom",
      url: "https://us02web.zoom.us/j/8912345?pwd=abc",
    });
    expect(scrapeJoinUrl("link: https://acme.webex.com/meet/pr123 end")).toEqual({
      provider: "Webex",
      url: "https://acme.webex.com/meet/pr123",
    });
  });

  it("returns null when no known provider URL is present", () => {
    expect(scrapeJoinUrl("just some notes, no meeting link here")).toBeNull();
    expect(scrapeJoinUrl("https://example.com/random")).toBeNull();
    expect(scrapeJoinUrl("")).toBeNull();
  });
});

describe("extractConference — resolution chain", () => {
  it("prefers the structured conferenceData video entry point (Meet)", () => {
    const c = extractConference(meetEvent);
    expect(c).not.toBeNull();
    expect(c?.source).toBe("conferenceData");
    expect(c?.provider).toBe("Google Meet");
    expect(c?.joinUrl).toBe("https://meet.google.com/nqb-ptqo-koj");
    expect(c?.fromScrape).toBe(false);
    expect(c?.entryPoints).toHaveLength(3);
    expect(c?.entryPoints[0]).toEqual({
      type: "video",
      uri: "https://meet.google.com/nqb-ptqo-koj",
      label: "meet.google.com/nqb-ptqo-koj",
    });
  });

  it("falls back to hangoutLink when conferenceData is absent (legacy Meet)", () => {
    const c = extractConference({ hangoutLink: "https://meet.google.com/abc-defg-hij" });
    expect(c?.source).toBe("hangoutLink");
    expect(c?.provider).toBe("Google Meet");
    expect(c?.joinUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(c?.fromScrape).toBe(false);
    expect(c?.entryPoints).toHaveLength(0);
  });

  it("scrapes the description for externally-organized Teams meetings (no conferenceData)", () => {
    const c = extractConference(teamsSyncedEvent);
    expect(c?.source).toBe("description");
    expect(c?.provider).toBe("Microsoft Teams");
    expect(c?.joinUrl).toBe("https://teams.microsoft.com/meet/23594392319690?p=8e5nhXSwJy8vtRgHXo");
    expect(c?.fromScrape).toBe(true);
  });

  it("scrapes the location when the description has no link", () => {
    const c = extractConference({
      location: "Join here https://us02web.zoom.us/j/555?pwd=z",
      description: "no link in the body",
    });
    expect(c?.source).toBe("location");
    expect(c?.provider).toBe("Zoom");
    expect(c?.joinUrl).toBe("https://us02web.zoom.us/j/555?pwd=z");
    expect(c?.fromScrape).toBe(true);
  });

  it("structured data wins even when the description also contains a link", () => {
    const c = extractConference({
      ...meetEvent,
      description: "backup https://us02web.zoom.us/j/999",
    });
    expect(c?.source).toBe("conferenceData");
    expect(c?.joinUrl).toBe("https://meet.google.com/nqb-ptqo-koj");
  });

  it("scrapes when conferenceData has only phone entry points (no video)", () => {
    const c = extractConference({
      conferenceData: {
        entryPoints: [{ entryPointType: "phone", uri: "tel:+1-206-555-0100" }],
        conferenceSolution: { name: "Zoom" },
      },
      description: "video link: https://us02web.zoom.us/j/42",
    });
    expect(c?.source).toBe("description");
    expect(c?.joinUrl).toBe("https://us02web.zoom.us/j/42");
    // structured phone entry point still rides along
    expect(c?.entryPoints).toHaveLength(1);
  });

  it("surfaces the provider with an empty joinUrl when conferenceData has no usable link and nothing scrapes", () => {
    const c = extractConference({
      conferenceData: {
        entryPoints: [{ entryPointType: "phone", uri: "tel:+1-206-555-0100" }],
        conferenceSolution: { name: "Webex" },
      },
    });
    expect(c?.provider).toBe("Webex");
    expect(c?.joinUrl).toBe("");
    expect(c?.source).toBe("");
  });

  it("returns null for an event with no conferencing signal at all", () => {
    expect(extractConference({ summary: "Office" })).toBeNull();
    expect(extractConference({ summary: "x", description: "no meeting link" })).toBeNull();
  });
});

describe("resolveJoinUrl", () => {
  it("returns the best join URL across the chain", () => {
    expect(resolveJoinUrl(meetEvent)).toBe("https://meet.google.com/nqb-ptqo-koj");
    expect(resolveJoinUrl(teamsSyncedEvent)).toBe(
      "https://teams.microsoft.com/meet/23594392319690?p=8e5nhXSwJy8vtRgHXo",
    );
  });

  it("returns empty string when nothing resolves", () => {
    expect(resolveJoinUrl({ summary: "Office" })).toBe("");
  });
});
