import { buildServiceStub } from "./service-stub.js";

const stub = buildServiceStub("slides", [
  { name: "get", mutation: false },
  { name: "page", mutation: false },
  { name: "summarize", mutation: false },
  { name: "create", mutation: true },
  { name: "update", mutation: true },
]);

export const SLIDES_HELP = stub.help;
export const slidesCommand = stub.command;
