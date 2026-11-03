/**
 * Resolve the correct SPA workspace path for a document / workflow task /
 * notification link.
 *
 * Built forms (Imprest, Requisition, etc.) live under /forms/:id.
 * Uploaded / scanned documents live under /documents/:id.
 * Legacy notification emails still emit bare /:uuid links — those must be
 * rewritten or resolved so they don't fall through App's catch-all to "/".
 */
import type { WorkflowTask } from "@/types";
import { getTaskDocumentId, getTaskIsForm } from "@/lib/workflowTaskFilters";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isDocumentUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export type DocumentWorkspaceHints = {
  id?: string | null;
  is_form?: boolean | null;
  /** Nested form metadata, when present on a document payload. */
  metadata?: { form?: { sections?: unknown; workflow_type?: string } | null } | null;
  document_type_name?: string | null;
  document_type?: { name?: string | null; code?: string | null; is_form?: boolean | null } | null;
};

export function documentLooksLikeForm(doc: DocumentWorkspaceHints | null | undefined): boolean {
  if (!doc) return false;
  if (doc.is_form) return true;
  if (doc.metadata?.form?.sections) return true;
  if (doc.document_type?.is_form) return true;
  const typeName = `${doc.document_type_name ?? ""} ${doc.document_type?.name ?? ""} ${doc.document_type?.code ?? ""}`.toLowerCase();
  // Heuristic fallback when list payloads omit metadata (e.g. search hits).
  return /\b(imprest|requisition|form)\b/.test(typeName);
}

export function getDocumentWorkspacePath(
  docOrId: string | DocumentWorkspaceHints | null | undefined,
  options?: { taskId?: string | null; query?: Record<string, string | undefined | null> },
): string {
  const id =
    typeof docOrId === "string"
      ? docOrId
      : docOrId?.id ?? "";
  if (!id) return "/documents";

  const isForm =
    typeof docOrId === "string" ? false : documentLooksLikeForm(docOrId);

  const base = isForm ? `/forms/${id}` : `/documents/${id}`;
  const params = new URLSearchParams();
  if (options?.taskId) params.set("task", options.taskId);
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value != null && value !== "") params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function getTaskWorkspacePath(task: WorkflowTask): string | null {
  if (task.target_type === "payment_run" || task.payment_run_id) {
    return `/workflow?task=${task.id}`;
  }
  const documentId = getTaskDocumentId(task);
  if (!documentId) return null;
  return getDocumentWorkspacePath(
    {
      id: documentId,
      is_form: getTaskIsForm(task),
      document_type_name: task.document_type_name,
    },
    { taskId: task.id },
  );
}

/**
 * Rewrite notification / email links into the correct workspace path.
 * Returns null when the link should be resolved asynchronously (bare UUID
 * without form hints) — callers can then hit DocumentWorkspaceRedirect.
 */
export function rewriteWorkspaceLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const trimmed = link.trim();
  if (!trimmed) return null;

  // Absolute app-relative paths we already understand.
  if (
    trimmed.startsWith("/forms/") ||
    trimmed.startsWith("/documents/") ||
    trimmed.startsWith("/workflow") ||
    trimmed.startsWith("/approvals") ||
    trimmed.startsWith("/payment-run") ||
    trimmed.startsWith("/notifications/")
  ) {
    return trimmed;
  }

  // Legacy "/documents/{uuid}" is already correct for non-forms; keep as-is
  // (forms that were mis-linked as /documents/ still work via DocumentDetail
  // form branch, but prefer /forms when we know).

  // Bare "/{uuid}" or "/{uuid}?task=..." — route through the resolver so we
  // land on /forms or /documents instead of the dashboard catch-all.
  try {
    const url = new URL(trimmed, window.location.origin);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && isDocumentUuid(parts[0])) {
      const params = url.searchParams.toString();
      return params ? `/open/${parts[0]}?${params}` : `/open/${parts[0]}`;
    }
  } catch {
    /* fall through */
  }

  return trimmed;
}
