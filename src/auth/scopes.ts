export const BASE_SCOPES = ["openid", "email", "profile"] as const;

export const SERVICE_SCOPES = {
  gmail: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar",
  docs: "https://www.googleapis.com/auth/documents",
  drive: "https://www.googleapis.com/auth/drive",
  slides: "https://www.googleapis.com/auth/presentations",
} as const;

// Scopes layered on top of the representative per-service scope above.
// gmail.settings.basic is required for Gmail filter management
// (users.settings.filters.*); it is NOT covered by gmail.modify. Kept
// separate so the per-service probe/health checks keep keying off the
// single representative scope in SERVICE_SCOPES.
export const ADDITIONAL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.basic",
  // drive.activity.readonly powers `drive activity`; it is read-only and NOT
  // implied by auth/drive, so it must be requested explicitly. Incremental on
  // the already-restricted drive scope, so it doesn't worsen the consent
  // posture. Pre-existing accounts must re-auth once to gain it.
  "https://www.googleapis.com/auth/drive.activity.readonly",
] as const;

export type ServiceName = keyof typeof SERVICE_SCOPES;

export const SERVICES: ServiceName[] = [
  "gmail",
  "calendar",
  "docs",
  "drive",
  "slides",
];

export const REQUIRED_APIS: Record<ServiceName, string> = {
  gmail: "gmail.googleapis.com",
  calendar: "calendar-json.googleapis.com",
  docs: "docs.googleapis.com",
  drive: "drive.googleapis.com",
  slides: "slides.googleapis.com",
};

// APIs required beyond the per-service REQUIRED_APIS map. The Drive Activity
// API is a distinct service backing the `drive activity` command — it must be
// enabled separately from the Drive API.
export const ADDITIONAL_APIS = ["driveactivity.googleapis.com"] as const;

export function allScopes(): string[] {
  return [...BASE_SCOPES, ...Object.values(SERVICE_SCOPES), ...ADDITIONAL_SCOPES];
}

export function allApis(): string[] {
  return [...Object.values(REQUIRED_APIS), ...ADDITIONAL_APIS];
}
