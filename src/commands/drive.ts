import { buildServiceStub } from "./service-stub.js";

const stub = buildServiceStub("drive", [
  { name: "search", mutation: false },
  { name: "get", mutation: false },
  { name: "ls", mutation: false },
  { name: "permissions", mutation: false },
  { name: "download", mutation: false },
  { name: "create", mutation: true },
  { name: "copy", mutation: true },
  { name: "move", mutation: true },
  { name: "rename", mutation: true },
  { name: "delete", mutation: true },
  { name: "mkdir", mutation: true },
]);

export const DRIVE_HELP = stub.help;
export const driveCommand = stub.command;
