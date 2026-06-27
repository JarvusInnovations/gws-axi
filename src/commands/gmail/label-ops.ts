import { AxiError } from "axi-sdk-js";
import type { gmail_v1 } from "googleapis";
import { gmailClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { fetchLabels } from "./labels-shared.js";

export const LABEL_CREATE_HELP = `usage: gws-axi gmail label-create --name <text> [flags]
flags[2]:
  --name <text>        REQUIRED — label name. Use "Parent/Child" for nesting
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi gmail label-create --name Receipts
  gws-axi gmail label-create --name "Work/Clients"
notes:
  Idempotent: if a label with this exact name already exists, returns
  \`action: exists\` with its id rather than erroring. Apply the label to
  messages with \`gws-axi gmail modify <id> --add-label <name>\`.
`;

export const LABEL_UPDATE_HELP = `usage: gws-axi gmail label-update <label-id|name> --name <new-name> [flags]
args[1]:
  <label-id|name>      Existing label to rename (id or current name)
flags[2]:
  --name <new-name>    REQUIRED — the new label name
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi gmail label-update Receipts --name "Receipts/2026"
  gws-axi gmail label-update Label_42 --name Archive
notes:
  Only user labels can be renamed — system labels (INBOX, STARRED, …) are
  rejected. Run \`gws-axi gmail labels\` to find ids/names.
`;

export const LABEL_DELETE_HELP = `usage: gws-axi gmail label-delete <label-id|name> [flags]
args[1]:
  <label-id|name>      Label to delete (id or name)
flags[2]:
  --account <email>    REQUIRED when 2+ accounts are authenticated
  --yes                Reserved (no-op) — writes are already explicit
examples:
  gws-axi gmail label-delete Receipts
  gws-axi gmail label-delete Label_42
notes:
  Idempotent: deleting a label that doesn't exist returns \`action: noop\`.
  Deleting a label removes it from all messages but does not delete the
  messages. System labels cannot be deleted.
`;

function parseNameFlag(args: string[]): {
  name: string | undefined;
  positional: string | undefined;
} {
  let name: string | undefined;
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--name") {
      name = next;
      i++;
    } else if (arg === "--yes") {
      // no-op
    } else if (!arg.startsWith("--") && positional === undefined) {
      positional = arg;
    }
  }
  return { name, positional };
}

function findLabel(
  ref: string,
  labels: gmail_v1.Schema$Label[],
): gmail_v1.Schema$Label | undefined {
  return (
    labels.find((l) => l.name === ref) ??
    labels.find((l) => l.name?.toLowerCase() === ref.toLowerCase()) ??
    labels.find((l) => l.id === ref)
  );
}

export async function gmailLabelCreateCommand(account: string, args: string[]): Promise<string> {
  const { name } = parseNameFlag(args);
  if (!name) {
    throw new AxiError("--name is required", "VALIDATION_ERROR", [
      `Usage: gws-axi gmail label-create --name <text>`,
    ]);
  }

  const api = await gmailClient(account);
  const labels = await fetchLabels(api, account);

  // Idempotency: a label with this exact name already exists → no-op.
  const existing = labels.find((l) => l.name === name);
  if (existing) {
    return joinBlocks(
      renderObject({
        action: "exists",
        account,
        label: { id: existing.id ?? "", name: existing.name ?? "", type: existing.type ?? "user" },
      }),
      renderHelp([
        `Apply it with \`gws-axi gmail modify <message-id> --add-label ${JSON.stringify(name)}\``,
      ]),
    );
  }

  let created: gmail_v1.Schema$Label;
  try {
    const res = await api.users.labels.create({
      userId: "me",
      requestBody: {
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    created = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.labels.create",
    });
  }

  return joinBlocks(
    renderObject({
      action: "created",
      account,
      label: { id: created.id ?? "", name: created.name ?? "", type: created.type ?? "user" },
    }),
    renderHelp([
      `Apply it with \`gws-axi gmail modify <message-id> --add-label ${JSON.stringify(name)}\``,
    ]),
  );
}

export async function gmailLabelUpdateCommand(account: string, args: string[]): Promise<string> {
  const { name, positional } = parseNameFlag(args);
  if (!positional) {
    throw new AxiError("Missing label id/name argument", "VALIDATION_ERROR", [
      `Usage: gws-axi gmail label-update <label-id|name> --name <new-name>`,
    ]);
  }
  if (!name) {
    throw new AxiError("--name (new name) is required", "VALIDATION_ERROR", [
      `Usage: gws-axi gmail label-update <label-id|name> --name <new-name>`,
    ]);
  }

  const api = await gmailClient(account);
  const labels = await fetchLabels(api, account);
  const target = findLabel(positional, labels);
  if (!target?.id) {
    throw new AxiError(`Label '${positional}' not found`, "LABEL_NOT_FOUND", [
      `Run \`gws-axi gmail labels\` to see all available labels`,
    ]);
  }
  if (target.type === "system") {
    throw new AxiError(`Cannot rename system label '${target.name}'`, "OPERATION_NOT_SUPPORTED", [
      "Only user-created labels can be renamed",
    ]);
  }

  let updated: gmail_v1.Schema$Label;
  try {
    const res = await api.users.labels.patch({
      userId: "me",
      id: target.id,
      requestBody: { name },
    });
    updated = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.labels.patch",
    });
  }

  return renderObject({
    action: "updated",
    account,
    label: {
      id: updated.id ?? target.id,
      name: updated.name ?? name,
      previous_name: target.name ?? "",
    },
  });
}

export async function gmailLabelDeleteCommand(account: string, args: string[]): Promise<string> {
  const { positional } = parseNameFlag(args);
  if (!positional) {
    throw new AxiError("Missing label id/name argument", "VALIDATION_ERROR", [
      `Usage: gws-axi gmail label-delete <label-id|name>`,
    ]);
  }

  const api = await gmailClient(account);
  const labels = await fetchLabels(api, account);
  const target = findLabel(positional, labels);

  // Idempotent: nothing to delete.
  if (!target?.id) {
    return renderObject({
      action: "noop",
      account,
      label: positional,
      reason: "label not found (already deleted or never existed)",
    });
  }
  if (target.type === "system") {
    throw new AxiError(`Cannot delete system label '${target.name}'`, "OPERATION_NOT_SUPPORTED", [
      "Only user-created labels can be deleted",
    ]);
  }

  try {
    await api.users.labels.delete({ userId: "me", id: target.id });
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "gmail.labels.delete",
    });
    if (translated.code === "NOT_FOUND") {
      return renderObject({
        action: "noop",
        account,
        label: positional,
        reason: "label was already deleted",
      });
    }
    throw translated;
  }

  return renderObject({
    action: "deleted",
    account,
    label: { id: target.id, name: target.name ?? "" },
  });
}
