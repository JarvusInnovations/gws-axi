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

export function allScopes(): string[] {
  return [...BASE_SCOPES, ...Object.values(SERVICE_SCOPES), ...ADDITIONAL_SCOPES];
}

export function allApis(): string[] {
  return Object.values(REQUIRED_APIS);
}
