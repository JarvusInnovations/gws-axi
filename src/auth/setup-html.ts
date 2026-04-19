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
      return [{ label: "Create project in Console", url: "https://console.cloud.google.com/projectcreate" }];
    case "apis_enabled":
      return SERVICES.map((s) => ({
        label: `Enable ${s}`,
        url: consoleUrl(`/apis/library/${REQUIRED_APIS[s]}`, projectId),
      }));
    case "oauth_client":
      return [{ label: "Credentials → Create OAuth client ID", url: consoleUrl("/apis/credentials", projectId) }];
    case "consent_screen":
      return [{ label: "OAuth consent screen", url: consoleUrl("/apis/credentials/consent", projectId) }];
    case "test_user_added":
      return [{ label: "Test users (consent screen)", url: consoleUrl("/apis/credentials/consent", projectId) }];
    default:
      return [];
  }
}

export function setupHtmlPath(): string {
  return join(configDir(), "setup.html");
}

export function writeSetupHtml(): string {
  const state = readSetupState();
  const projectId = state.steps.gcp_project.project_id as string | undefined;

  const rows = SETUP_STEP_ORDER.map((key, idx) => {
    const step = state.steps[key];
    const status = step.done ? "✓ done" : "… pending";
    const statusClass = step.done ? "done" : "pending";
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

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>gws-axi — setup</title>
<style>
  body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; max-width: 900px; margin: 40px auto; padding: 24px; color: #222; }
  h1 { margin-top: 0; }
  .summary { background: #f4f8fb; border-left: 4px solid #3b82f6; padding: 12px 16px; border-radius: 4px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e4e4e7; vertical-align: top; }
  th { background: #fafafa; font-size: 13px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  tr.done .status { color: #1a7f37; font-weight: 500; }
  tr.pending .status { color: #8a5a00; }
  td.num { font-family: ui-monospace, Menlo, monospace; color: #999; width: 32px; }
  td.name { font-weight: 500; width: 260px; }
  td.links { font-size: 14px; }
  td.links a { display: inline-block; margin-right: 8px; padding: 4px 10px; border-radius: 4px; background: #eff6ff; color: #1d4ed8; text-decoration: none; font-size: 13px; }
  td.links a:hover { background: #dbeafe; }
  footer { margin-top: 32px; font-size: 13px; color: #666; }
  code { background: #f4f4f5; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
</style>
</head>
<body>
<h1>gws-axi · setup</h1>
<div class="summary">
  <strong>Project:</strong> ${projectId ? `<code>${projectId}</code>` : "(not set yet)"}<br>
  <strong>Progress:</strong> ${SETUP_STEP_ORDER.filter((k) => state.steps[k].done).length} of ${SETUP_STEP_ORDER.length} steps complete<br>
  <strong>Next:</strong> run <code>gws-axi auth setup</code> in your terminal
</div>
<table>
<thead><tr><th>#</th><th>Status</th><th>Step</th><th>Console links</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<footer>
  This page is regenerated every time you run <code>gws-axi auth setup</code>. Links open the specific Cloud Console page relevant to each step; scoped to your project when known.
</footer>
</body>
</html>
`;

  const path = setupHtmlPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  return path;
}
