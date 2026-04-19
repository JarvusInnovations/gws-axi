import { buildServiceStub } from "./service-stub.js";

const stub = buildServiceStub("drive", [
  "search",
  "get",
  "create",
  "copy",
  "move",
  "rename",
  "delete",
  "mkdir",
  "ls",
  "permissions",
  "download",
]);

export const DRIVE_HELP = stub.help;
export const driveCommand = stub.command;
