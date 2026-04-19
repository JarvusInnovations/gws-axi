import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../config.js";

export interface PendingAuth {
  version: 1;
  url: string;
  port: number;
  verifier: string;
  state: string;
  expected_account?: string;
  started_at: string;
  expires_at: string;
}

export function pendingAuthPath(): string {
  return join(configDir(), "pending-auth.json");
}

export function readPendingAuth(): PendingAuth | null {
  const path = pendingAuthPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PendingAuth;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePendingAuth(pending: PendingAuth): void {
  const path = pendingAuthPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
}

export function clearPendingAuth(): void {
  const path = pendingAuthPath();
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

export function isPendingAuthExpired(pending: PendingAuth): boolean {
  return Date.parse(pending.expires_at) < Date.now();
}
