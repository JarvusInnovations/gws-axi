import { buildServiceStub } from "./service-stub.js";

const stub = buildServiceStub("calendar", [
  "events",
  "get",
  "create",
  "update",
  "delete",
  "respond",
  "calendars",
  "search",
  "freebusy",
]);

export const CALENDAR_HELP = stub.help;
export const calendarCommand = stub.command;
