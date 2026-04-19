import { buildServiceStub } from "./service-stub.js";

const stub = buildServiceStub("gmail", [
  { name: "search", mutation: false },
  { name: "read", mutation: false },
  { name: "labels", mutation: false },
  { name: "filter-list", mutation: false },
  { name: "download", mutation: false },
  { name: "send", mutation: true },
  { name: "draft", mutation: true },
  { name: "modify", mutation: true },
  { name: "batch-modify", mutation: true },
  { name: "label-create", mutation: true },
  { name: "label-update", mutation: true },
  { name: "label-delete", mutation: true },
  { name: "filter-create", mutation: true },
  { name: "filter-delete", mutation: true },
]);

export const GMAIL_HELP = stub.help;
export const gmailCommand = stub.command;
