import { buildServiceStub } from "./service-stub.js";

const stub = buildServiceStub("calendar", [
  { name: "events", mutation: false },
  { name: "get", mutation: false },
  { name: "calendars", mutation: false },
  { name: "search", mutation: false },
  { name: "freebusy", mutation: false },
  { name: "create", mutation: true },
  { name: "update", mutation: true },
  { name: "delete", mutation: true },
  { name: "respond", mutation: true },
]);

export const CALENDAR_HELP = stub.help;
export const calendarCommand = stub.command;
