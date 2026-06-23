import { extname } from "node:path";

/**
 * Minimal extension → MIME table for `drive upload`. Node has no built-in
 * MIME lookup, and pulling in a full database is overkill: this covers the
 * office/document/text/image/archive types an agent actually uploads. Unknown
 * extensions fall back to `application/octet-stream` (a safe generic binary
 * type Drive accepts), so detection never throws — it only ever under-labels.
 */
const EXTENSION_MIME: Record<string, string> = {
  // Office (OOXML)
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Office (legacy)
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  // Text & delimited
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  rtf: "application/rtf",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  // Documents
  pdf: "application/pdf",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  // Audio / video
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  // Archives
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

export const DEFAULT_MIME_TYPE = "application/octet-stream";

/**
 * Detect a MIME type from a file path's extension. Case-insensitive; returns
 * `application/octet-stream` for unknown or absent extensions.
 */
export function detectMimeType(path: string): string {
  const ext = extname(path).replace(/^\./, "").toLowerCase();
  if (!ext) return DEFAULT_MIME_TYPE;
  return EXTENSION_MIME[ext] ?? DEFAULT_MIME_TYPE;
}

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";

/**
 * Map a source MIME type to the native Google Workspace target Drive can
 * convert it into on upload (the `--convert` flag). Returns `null` when the
 * source has no sensible native target — the caller surfaces
 * `UNSUPPORTED_CONVERSION`.
 */
const CONVERSION_TARGETS: Record<string, string> = {
  // → Google Doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    GOOGLE_DOC,
  "application/msword": GOOGLE_DOC,
  "application/rtf": GOOGLE_DOC,
  "text/rtf": GOOGLE_DOC,
  "text/plain": GOOGLE_DOC,
  "text/markdown": GOOGLE_DOC,
  "text/html": GOOGLE_DOC,
  // → Google Sheet
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    GOOGLE_SHEET,
  "application/vnd.ms-excel": GOOGLE_SHEET,
  "text/csv": GOOGLE_SHEET,
  "text/tab-separated-values": GOOGLE_SHEET,
  // → Google Slides
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    GOOGLE_SLIDES,
  "application/vnd.ms-powerpoint": GOOGLE_SLIDES,
};

export function googleConversionTarget(sourceMime: string): string | null {
  return CONVERSION_TARGETS[sourceMime.toLowerCase()] ?? null;
}
