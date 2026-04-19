import { buildServiceStub } from "./service-stub.js";

const stub = buildServiceStub("docs", [
  { name: "read", mutation: false },
  { name: "find", mutation: false },
  { name: "comments", mutation: false },
  { name: "append", mutation: true },
  { name: "insert-text", mutation: true },
  { name: "delete-range", mutation: true },
  { name: "style-text", mutation: true },
  { name: "style-paragraph", mutation: true },
  { name: "insert-table", mutation: true },
  { name: "edit-cell", mutation: true },
  { name: "comment-add", mutation: true },
  { name: "comment-reply", mutation: true },
  { name: "comment-resolve", mutation: true },
]);

export const DOCS_HELP = stub.help;
export const docsCommand = stub.command;
