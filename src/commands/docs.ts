import { buildServiceStub } from "./service-stub.js";

const stub = buildServiceStub("docs", [
  "read",
  "append",
  "insert-text",
  "delete-range",
  "style-text",
  "style-paragraph",
  "insert-table",
  "edit-cell",
  "find",
  "comments",
  "comment-add",
  "comment-reply",
  "comment-resolve",
]);

export const DOCS_HELP = stub.help;
export const docsCommand = stub.command;
