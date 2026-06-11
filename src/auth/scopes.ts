export const BASE_SCOPES = ["openid", "email", "profile"] as const;

export const SERVICE_SCOPES = {
  gmail: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar",
  docs: "https://www.googleapis.com/auth/documents",
  drive: "https://www.googleapis.com/auth/drive",
  slides: "https://www.googleapis.com/auth/presentations",
} as const;

export type ServiceName = keyof typeof SERVICE_SCOPES;

// Scopes layered on top of the representative per-service scope above. Each is
// NOT implied by its parent SERVICE_SCOPES entry, so it must be requested
// explicitly and a pre-existing account must re-auth once to gain it. They are
// kept separate so the per-service *connectivity* probe keeps keying off the
// single representative scope — but doctor checks their presence individually
// (grouped under `service`) so a missing one is surfaced as a re-auth prompt
// rather than silently failing only when the dependent command is run.
export interface AdditionalScope {
  /** The full OAuth scope URL. */
  scope: string;
  /** Parent service — groups the doctor check and the `--check runtime.<service>` filter. */
  service: ServiceName;
  /** Human label for the capability this scope unlocks. */
  capability: string;
}

export const ADDITIONAL_SCOPE_INFO: AdditionalScope[] = [
  {
    scope: "https://www.googleapis.com/auth/gmail.settings.basic",
    service: "gmail",
    capability: "Gmail filter management",
  },
  {
    // drive.activity.readonly powers `drive activity`; read-only and incremental
    // on the already-restricted drive scope, so it doesn't worsen the consent posture.
    scope: "https://www.googleapis.com/auth/drive.activity.readonly",
    service: "drive",
    capability: "drive activity timeline",
  },
];

export const ADDITIONAL_SCOPES = ADDITIONAL_SCOPE_INFO.map((s) => s.scope);

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
