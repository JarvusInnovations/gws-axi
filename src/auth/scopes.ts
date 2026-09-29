export const BASE_SCOPES = ["openid", "email", "profile"] as const;

export const SERVICE_SCOPES = {
  gmail: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar",
  docs: "https://www.googleapis.com/auth/documents",
  drive: "https://www.googleapis.com/auth/drive",
  slides: "https://www.googleapis.com/auth/presentations",
  sheets: "https://www.googleapis.com/auth/spreadsheets",
  // Read-only, and the scope the doctor probe's conversation-list call needs.
  // Message access is the additional `chat.messages` scope below.
  chat: "https://www.googleapis.com/auth/chat.spaces.readonly",
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
  {
    // One broad scope for reading, searching, and sending, rather than pairing
    // chat.messages.readonly with chat.messages.create. It also permits editing
    // and deleting messages, which no command does — that boundary is held in
    // code (specs/architecture.md § Scope model).
    scope: "https://www.googleapis.com/auth/chat.messages",
    service: "chat",
    capability: "read, search, and send chat messages",
  },
  {
    scope: "https://www.googleapis.com/auth/chat.memberships.readonly",
    service: "chat",
    capability: "list chat members and name direct messages",
  },
  {
    scope: "https://www.googleapis.com/auth/chat.users.readstate",
    service: "chat",
    capability: "mark chat conversations read or unread",
  },
];

export const ADDITIONAL_SCOPES = ADDITIONAL_SCOPE_INFO.map((s) => s.scope);

export const SERVICES: ServiceName[] = [
  "gmail",
  "calendar",
  "docs",
  "drive",
  "slides",
  "sheets",
  "chat",
];

export const REQUIRED_APIS: Record<ServiceName, string> = {
  gmail: "gmail.googleapis.com",
  calendar: "calendar-json.googleapis.com",
  docs: "docs.googleapis.com",
  drive: "drive.googleapis.com",
  slides: "slides.googleapis.com",
  sheets: "sheets.googleapis.com",
  chat: "chat.googleapis.com",
};

// APIs that back a capability rather than a service. The Drive Activity API is
// a distinct service behind `drive activity`, enabled separately from the Drive
// API.
export const ADDITIONAL_APIS = ["driveactivity.googleapis.com"] as const;

export function allScopes(): string[] {
  return [...BASE_SCOPES, ...Object.values(SERVICE_SCOPES), ...ADDITIONAL_SCOPES];
}

export function allApis(): string[] {
  return [...Object.values(REQUIRED_APIS), ...ADDITIONAL_APIS];
}
