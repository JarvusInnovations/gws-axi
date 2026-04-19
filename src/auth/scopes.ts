export const BASE_SCOPES = ["openid", "email", "profile"] as const;

export const SERVICE_SCOPES = {
  gmail: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar",
  docs: "https://www.googleapis.com/auth/documents",
  drive: "https://www.googleapis.com/auth/drive",
  slides: "https://www.googleapis.com/auth/presentations",
} as const;

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
  return [...BASE_SCOPES, ...Object.values(SERVICE_SCOPES)];
}

export function allApis(): string[] {
  return Object.values(REQUIRED_APIS);
}
