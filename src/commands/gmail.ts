import { buildServiceStub } from "./service-stub.js";

const stub = buildServiceStub("gmail", [
  "search",
  "read",
  "send",
  "draft",
  "labels",
  "modify",
  "batch-modify",
  "label-create",
  "label-update",
  "label-delete",
  "filter-create",
  "filter-list",
  "filter-delete",
  "download",
]);

export const GMAIL_HELP = stub.help;
export const gmailCommand = stub.command;
