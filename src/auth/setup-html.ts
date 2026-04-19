import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  configDir,
  readSetupState,
  SETUP_STEP_ORDER,
  type SetupStepKey,
} from "../config.js";
import { consoleUrl } from "./steps.js";
import { REQUIRED_APIS, SERVICES } from "./scopes.js";

interface StepLink {
  label: string;
  url: string;
}

const STEP_LABELS: Record<SetupStepKey, string> = {
  gcp_project: "Choose or create GCP project",
  apis_enabled: "Enable Google Workspace APIs",
  oauth_client: "Create Desktop OAuth client",
  credentials_saved: "Save credentials JSON to config dir",
  consent_screen: "Configure OAuth consent screen",
  test_user_added: "Add yourself as test user",
  tokens_obtained: "Run OAuth loopback flow to obtain tokens",
};

function linksForStep(
  key: SetupStepKey,
  projectId: string | undefined,
): StepLink[] {
  switch (key) {
    case "gcp_project":
      return [
        {
          label: "Create project in Console",
          url: "https://console.cloud.google.com/projectcreate",
        },
      ];
    case "apis_enabled":
      return SERVICES.map((s) => ({
        label: `Enable ${s}`,
        url: consoleUrl(`/apis/library/${REQUIRED_APIS[s]}`, projectId),
      }));
    case "oauth_client":
      return [
        {
          label: "OAuth clients → Create client",
          url: consoleUrl("/auth/clients", projectId),
        },
      ];
    case "consent_screen":
      return [
        {
          label: "Branding (app name, emails)",
          url: consoleUrl("/auth/branding", projectId),
        },
        {
          label: "Audience (user type)",
          url: consoleUrl("/auth/audience", projectId),
        },
      ];
    case "test_user_added":
      return [
        {
          label: "Audience → Test users",
          url: consoleUrl("/auth/audience", projectId),
        },
      ];
    default:
      return [];
  }
}

export function setupHtmlPath(): string {
  return join(configDir(), "setup.html");
}

export interface SetupHtmlOptions {
  /**
   * When set, render a prominent "Authenticate now" button at the top of
   * setup.html pointing at this URL. Used by the OAuth loopback flow to
   * avoid printing the jumbo URL to the terminal (where it gets mangled).
   */
  pendingAuth?: {
    url: string;
    account?: string;
  };
}

export function writeSetupHtml(options: SetupHtmlOptions = {}): string {
  const state = readSetupState();
  const projectId = state.steps.gcp_project.project_id as string | undefined;

  const nextKey = SETUP_STEP_ORDER.find((k) => !state.steps[k].done);
  const rows = SETUP_STEP_ORDER.map((key, idx) => {
    const step = state.steps[key];
    const isNext = key === nextKey;
    const status = step.done ? "✓ done" : isNext ? "→ next" : "… pending";
    const statusClass = step.done ? "done" : isNext ? "next" : "pending";
    const links = linksForStep(key, projectId)
      .map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${l.label}</a>`)
      .join(" · ");
    return `<tr class="${statusClass}">
      <td class="num">${idx + 1}</td>
      <td class="status">${status}</td>
      <td class="name">${STEP_LABELS[key]}</td>
      <td class="links">${links || "<em>no external action needed</em>"}</td>
    </tr>`;
  }).join("\n");

  const progress = SETUP_STEP_ORDER.filter((k) => state.steps[k].done).length;
  const now = new Date();
  const nowLabel = now.toLocaleTimeString();

  const pendingAuthBlock = options.pendingAuth
    ? `<div class="pending-auth">
  <div class="pending-auth-title">Waiting for authentication${options.pendingAuth.account ? ` as <code>${options.pendingAuth.account}</code>` : ""}</div>
  <p>Click the button below to sign in to Google. After consent, your browser will redirect to a local success page and the CLI will save your tokens.</p>
  <a class="auth-button" href="${options.pendingAuth.url}" target="_self">Authenticate with Google &rarr;</a>
  <p class="pending-auth-note">The CLI is listening for the callback on 127.0.0.1 — this button only works while setup is running.</p>
</div>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>gws-axi — setup</title>
<style>
  body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; max-width: 900px; margin: 40px auto; padding: 24px; color: #222; }
  h1 { margin-top: 0; }
  .summary { background: #f4f8fb; border-left: 4px solid #3b82f6; padding: 12px 16px; border-radius: 4px; margin-bottom: 24px; }
  .refresh { font-size: 12px; color: #6b7280; margin-top: 6px; }
  .pending-auth { background: #fef3c7; border: 2px solid #f59e0b; padding: 20px 24px; border-radius: 6px; margin-bottom: 24px; }
  .pending-auth-title { font-size: 18px; font-weight: 600; color: #92400e; margin-bottom: 8px; }
  .pending-auth p { margin: 8px 0; }
  .pending-auth-note { font-size: 13px; color: #78350f; }
  .auth-button { display: inline-block; padding: 10px 20px; background: #4285f4; color: white; text-decoration: none; border-radius: 6px; font-weight: 500; margin: 8px 0; }
  .auth-button:hover { background: #3367d6; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e4e4e7; vertical-align: top; }
  th { background: #fafafa; font-size: 13px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  tr.done { opacity: 0.55; }
  tr.done .status { color: #1a7f37; font-weight: 500; }
  tr.next { background: #fffbeb; }
  tr.next .status { color: #b45309; font-weight: 600; }
  tr.pending .status { color: #8a5a00; }
  td.num { font-family: ui-monospace, Menlo, monospace; color: #999; width: 32px; }
  td.name { font-weight: 500; width: 260px; }
  td.links { font-size: 14px; }
  td.links a { display: inline-block; margin-right: 8px; padding: 4px 10px; border-radius: 4px; background: #eff6ff; color: #1d4ed8; text-decoration: none; font-size: 13px; }
  td.links a:hover { background: #dbeafe; }
  tr.done td.links a { background: #f4f4f5; color: #6b7280; }
  footer { margin-top: 32px; font-size: 13px; color: #666; }
  code { background: #f4f4f5; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
</style>
</head>
<body>
<h1>gws-axi · setup</h1>
${pendingAuthBlock}
<div class="summary">
  <strong>Project:</strong> ${projectId ? `<code>${projectId}</code>` : "(not set yet)"}<br>
  <strong>Progress:</strong> ${progress} of ${SETUP_STEP_ORDER.length} steps complete
  ${nextKey ? `<br><strong>Next step:</strong> <code>${STEP_LABELS[nextKey]}</code> — click the buttons below, then run <code>gws-axi auth setup</code> to continue` : `<br><strong>All steps complete</strong> — run <code>gws-axi doctor</code> to verify runtime health`}
  <div class="refresh">Auto-refreshes every 10 seconds · last rendered at ${nowLabel}</div>
</div>
<table>
<thead><tr><th>#</th><th>Status</th><th>Step</th><th>Console links</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<footer>
  Click the links above to complete each step in <em>this</em> browser (so you stay in the Google account you're signed into). Regenerated every time you run <code>gws-axi auth setup</code>.
</footer>
</body>
</html>
`;

  const path = setupHtmlPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  return path;
}
