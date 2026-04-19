import { buildServiceStub } from "./service-stub.js";

const stub = buildServiceStub("slides", [
  "create",
  "get",
  "page",
  "update",
  "summarize",
]);

export const SLIDES_HELP = stub.help;
export const slidesCommand = stub.command;
