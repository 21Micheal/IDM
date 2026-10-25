/**
 * FormDetailPage
 *
 * Dedicated, full-page experience for a single Form (a "built"-template
 * document). This is the Forms-area counterpart to the form-handling branch
 * that currently lives inside DocumentDetailPage — extracted into its own
 * page rather than sharing chrome with the generic document workspace, since
 * forms have their own lifecycle (fill → submit → approve → retire) that
 * doesn't need the general document tabs (Relationships, Security, file
 * versions as "documents", etc.).
 *
 * Scope note: this first pass reuses the same mutations/permission rules as
 * DocumentDetailPage's form branch (canEditForm, formHasConditionalEditability,
 * isApprovalLockedStatus, isFinalFormProcessStep) so behaviour matches exactly.
 * Relationships/Security/side-by-side-compare tabs were intentionally left out
 * of the Forms detail page — they're generic-document concepts. If any of that
 * turns out to matter for forms too, say so and it can be ported over.
 */

import { Suspense, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { extractApiError } from "@/lib/apiError";
import { useParams, useNavigate, useLocation, useSearchParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, sunsystemsAPI, workflowAPI, type JournalPosting } from "@/services/api";
import TemplateForm, { hasVisibleEditableSection, hasVisibleRetirementEditSection, pastDateFieldLabels, requiredFieldLabels } from "@/components/templates/TemplateForm";
import PrintableRequisition from "@/components/templates/PrintableRequisition";
import BudgetBanner from "@/components/templates/BudgetBanner";
import JournalPostingCard from "@/components/templates/JournalPostingCard";
import JournalPayloadModal from "@/components/templates/JournalPayloadModal";
import { collectFormAttachments } from "@/components/templates/formAttachments";
import { ApprovalStagesTable } from "@/components/workflow/ApprovalStagesTable";
import WorkflowActionPanel from "@/components/workflow/WorkflowActionPanel";
import { WorkflowVisualizer } from "@/components/notifications/workflow-visualizer";
import { loadWorkflowData } from "@/components/notifications/workflow-data";
import { format } from "date-fns";
import {
  ArrowLeft, Send, Loader2, Edit2, Info, FileCode, Eye, EyeOff, Check, X, Save,
  MessageSquare, Download, AlertTriangle, ShieldCheck, PanelRightOpen, PanelRightClose,
  TrendingUp, TrendingDown, CheckCircle2, Printer, RefreshCw,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/lib/utils";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";
import SignaturePlacementModal, {
  FormTargetField,
  SignaturePlacementResult,
} from "@/components/signatures/SignaturePlacementModal";
import InvoiceAttachmentsPanel from "@/components/templates/InvoiceAttachmentsPanel";
import LpoPdfPreview from "@/components/documents/LpoPdfPreview";
import CustomListbox from "@/components/ui/CustomListbox";

/** Imprest request journals use stages 20000–29999; LPO POs use 1000–19999. */
function isImprestRequestPostingStage(stage: number) {
  return stage >= 20000 && stage < 30000;
}
function isLpoPurchaseOrderStage(stage: number) {
  return stage >= 1000 && stage < 20000;
}

function postingGateErrorSummary(postings: JournalPosting[]): string {
  const failed = postings.filter((p) => p.status === "failed" || p.status === "skipped");
  const first = failed[0];
  if (!first) return "SunSystems did not accept the posting.";
  const detail = (first.error || first.message || "").trim();
  const label = first.stage_label || `Stage ${first.stage}`;
  return detail ? `${label}: ${detail}` : `${label} posting failed.`;
}

function PostingGateOverlay({
  title,
  pendingMessage,
  failedPostings,
  retrying,
  onRetry,
  onDismiss,
}: {
  title: string;
  pendingMessage: string;
  failedPostings: JournalPosting[];
  retrying: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const failed = failedPostings.length > 0 && !retrying;
  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center bg-black/40 px-4 pt-[10vh]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="posting-gate-title"
        className="w-full max-w-md border border-[#C8CDD2] bg-white shadow-2xl"
      >
        <div className="flex items-start gap-3 px-6 pt-5 pb-4">
          {failed ? (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          ) : (
            <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[#287EAD]" />
          )}
          <div className="min-w-0">
            <h2 id="posting-gate-title" className="text-sm font-bold text-[#1F2933]">
              {failed ? "Posting failed" : title}
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-[#5E6870]">
              {failed
                ? postingGateErrorSummary(failedPostings)
                : retrying
                  ? "Retrying the SunSystems posting…"
                  : pendingMessage}
            </p>
            {failed && (
              <p className="mt-2 text-xs leading-relaxed text-[#5E6870]">
                The workflow stays at this step until posting succeeds. You can retry now, or dismiss — a reminder stays on this form until posting succeeds.
              </p>
            )}
          </div>
        </div>
        {failed && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-[#E8EDF2] bg-[#F8FAFC] px-4 py-3">
            <button
              type="button"
              onClick={onDismiss}
              className="border border-[#C8CDD2] bg-white px-3 py-2 text-xs font-semibold text-[#35434D] hover:bg-[#E9EEF1]"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 border border-[#287EAD] bg-[#287EAD] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1E6F99]"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry posting
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact header reminder when a Request/LPO posting gate is blocked.
 * Lives next to the reference number so it is visible without scrolling;
 * technical error detail stays in the SunSystems panel.
 */
function PostingGateHeaderReminder({
  kind,
  retrying,
  onRetry,
}: {
  kind: "imprest" | "lpo";
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" role="status">
      <span className="text-xs font-medium text-red-600">
        {kind === "lpo"
          ? "Later LPO approvals wait until this posting succeeds and the LPO is generated."
          : "The next Request approver is notified only after this posting succeeds."}
      </span>
      <button
        type="button"
        disabled={retrying}
        onClick={onRetry}
        className="inline-flex shrink-0 items-center gap-1 border border-red-600 px-2 py-0.5 text-[11px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
      >
        {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        {retrying ? "Retrying…" : "Retry posting"}
      </button>
    </div>
  );
}

const AUDIT_PAGE_SIZE = 5;

function normalizeApiFileUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, window.location.origin);
    // The API may build absolute file links using its internal Docker service
    // name (for example, http://backend:8000). Browser clients must use the
    // public origin serving this page, which proxies /api/ to the backend.
    if (parsed.pathname.startsWith("/api/")) {
      return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, window.location.origin).toString();
    }
  } catch {
    // Keep non-API and malformed URLs unchanged so callers can report errors.
  }
  return url;
}

function isApprovalLockedStatus(status?: string): boolean {
  return ["pending_approval", "request_pending", "retirement_pending", "requisition_pending", "rfq_pending", "lpo_pending", "on_hold"].includes(status || "");
}

function isWorkflowActiveOrCompleted(status?: string): boolean {
  return isApprovalLockedStatus(status) || ["approved", "request_approved", "requisition_approved", "rfq_approved", "lpo_approved", "retirement_approved", "fully_approved"].includes(status || "");
}

function isFinalFormProcessStep(step?: string): boolean {
  return ["retirement_approved", "fully_approved", "retirement_rejected", "requisition_rejected", "rfq_rejected", "lpo_rejected"].includes(step || "");
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function formatMoney(amount: number, currency?: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "KES" }).format(amount);
  } catch {
    return `${currency ?? ""} ${amount.toLocaleString()}`.trim();
  }
}

function getCommandStatusLabel(status: string) {
  return status
    ? status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
    : "Unknown";
}

function getCommandStatusClass(status: string) {
  const key = status?.toLowerCase?.().replace(/\s+/g, "_") ?? "";
  if (["approved", "active", "enabled", "completed", "request_approved", "requisition_approved", "rfq_approved", "fully_approved"].includes(key)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (["pending_review", "pending_approval", "on_hold", "returned", "request_pending", "retirement_pending"].includes(key)) {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (["rejected", "void", "retirement_rejected"].includes(key)) {
    return "border-red-200 bg-red-50 text-red-800";
  }
  if (key === "archived") {
    return "border-sky-200 bg-sky-50 text-sky-800";
  }
  return "border-slate-200 bg-white text-slate-800";
}

/** Mirrors what apps.sunsystems.variance.compute_retirement_variance persists
 * onto metadata.form.retirement_variance (see backend note on the banner
 * below) — kept as a local type since this page reads the raw `doc.metadata`
 * JSON directly rather than through a typed serializer. */
type RetirementVariance = {
  scenario?: "exact" | "under" | "over";
  kind?: "under" | "over" | null;
  amount?: string;
  issued?: string;
  spent?: string;
};

type TabId = "workflow" | "details" | "history" | "comments" | "audit";

export default function FormDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [activeTab, setActiveTab] = useState<TabId>("workflow");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [formEditing, setFormEditing] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const formDirtyRef = useRef(false);
  const [showJournalXml, setShowJournalXml] = useState(false);
  const [comment, setComment] = useState("");
  const [auditPage, setAuditPage] = useState(1);
  const navigationState = location.state as {
    workflowActionCompleted?: boolean;
    awaitLpo?: boolean;
  } | null;
  const [workflowActionCompleted, setWorkflowActionCompleted] = useState(
    Boolean(navigationState?.workflowActionCompleted && !navigationState?.awaitLpo),
  );
  const [awaitingLpo, setAwaitingLpo] = useState(
    Boolean(navigationState?.awaitLpo),
  );
  const [awaitingImprestPostSince, setAwaitingImprestPostSince] = useState(0);
  const [gateRetrying, setGateRetrying] = useState(false);
  const [isSigningOpen, setIsSigningOpen] = useState(false);
  const [targetSignatureField, setTargetSignatureField] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const taskPanelRef = useRef<HTMLDivElement>(null);

  // Required fields that failed the last save/submit attempt. Kept in state
  // (not just a toast) so a long list stays on screen while it's being fixed.
  const [missingFields, setMissingFields] = useState<string[]>([]);

  // Warn before leaving/reloading with unsaved form edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!formEditing || !formDirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [formEditing]);

  const awaitingPostingGate = awaitingLpo || awaitingImprestPostSince > 0;

  const { data: doc, isLoading, dataUpdatedAt: formDataUpdatedAt } = useQuery<any>({
    queryKey: ["form", id],
    queryFn: () => documentsAPI.get(id!).then((r) => r.data),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
    // Fast-poll while an overlay is open or the Request posting gate is held,
    // so a successful retry clears the persistent reminder promptly.
    refetchInterval: (query) => {
      if (awaitingPostingGate) return 1_000;
      const form = (query.state.data as { metadata?: { form?: { imprest_request_workflow_status?: string } } } | undefined)
        ?.metadata?.form;
      if (String(form?.imprest_request_workflow_status || "").toLowerCase() === "posting") return 3_000;
      return 8_000;
    },
  });

  const formData = (doc?.metadata as Record<string, any> | undefined)?.form as
    | {
      sections?: unknown[];
      values?: Record<string, unknown>;
      imprest_request_workflow_status?: string;
      print_config?: Record<string, any>;
      lpo_document_id?: string;
      lpo_reference?: string;
      lpo_documents?: Array<{ id: string; reference?: string; table_key?: string; table_label?: string }>;
    }
    | undefined;

  const imprestPostingGateActive =
    String(formData?.imprest_request_workflow_status || "").toLowerCase() === "posting";
  const workflowPhase = String(
    (formData as { workflow_phase?: string } | undefined)?.workflow_phase
    || doc?.builder_workflow_phase
    || "",
  ).toLowerCase();
  // PO rows without a generated LPO mean the LPO generation gate is still open.
  const generatedLpoCount = (formData?.lpo_documents?.length || 0)
    || (formData?.lpo_document_id ? 1 : 0);
  // Watch Request/LPO gates after dismiss/reopen so a failed post still surfaces.
  const watchPostingGate = awaitingPostingGate
    || imprestPostingGateActive
    || workflowPhase === "lpo";

  const { data: gatePostings = [] } = useQuery({
    queryKey: ["sunsystems-postings", id, "gate"],
    queryFn: () =>
      sunsystemsAPI.getPostings(id!)
        .then((r) => (Array.isArray(r.data) ? r.data : [] as JournalPosting[]))
        .catch(() => [] as JournalPosting[]),
    enabled: Boolean(id && watchPostingGate),
    refetchInterval: (awaitingPostingGate || imprestPostingGateActive) ? 2_000 : 10_000,
    staleTime: 0,
  });

  const failedImprestGatePostings = useMemo(
    () => gatePostings.filter(
      (p) => isImprestRequestPostingStage(p.stage) && (p.status === "failed" || p.status === "skipped"),
    ),
    [gatePostings],
  );
  const failedLpoGatePostings = useMemo(
    () => gatePostings.filter(
      (p) => isLpoPurchaseOrderStage(p.stage) && (p.status === "failed" || p.status === "skipped"),
    ),
    [gatePostings],
  );
  const lpoPostingGateActive = useMemo(() => {
    if (generatedLpoCount > 0 || workflowPhase !== "lpo") return false;
    return gatePostings.some((p) => isLpoPurchaseOrderStage(p.stage));
  }, [gatePostings, generatedLpoCount, workflowPhase]);
  // Hide the page banner while the modal overlay is already covering the same
  // failure — otherwise show it whenever the gate is still blocked.
  const showImprestGateBanner = imprestPostingGateActive && failedImprestGatePostings.length > 0
    && awaitingImprestPostSince === 0;
  const showLpoGateBanner = lpoPostingGateActive && failedLpoGatePostings.length > 0
    && !awaitingLpo;

  const retryGatePostings = useCallback(async (postings: JournalPosting[]) => {
    if (!id || !postings.length || gateRetrying) return;
    setGateRetrying(true);
    try {
      let anyPosted = false;
      let lastFailure: JournalPosting | null = null;
      for (const posting of postings) {
        try {
          const { data: result } = await sunsystemsAPI.retryPosting(id, posting.stage);
          if (result.status === "posted") {
            anyPosted = true;
          } else {
            lastFailure = result;
          }
        } catch (e: any) {
          // Failed retries often return 502 with the updated JournalPosting body.
          const body = e?.response?.data;
          if (body && typeof body === "object" && (body.status || body.error || body.message)) {
            lastFailure = { ...posting, ...body } as JournalPosting;
          } else {
            const detail = body?.detail || e?.message;
            toast.error(typeof detail === "string" ? detail : "Could not retry posting.");
            lastFailure = posting;
          }
        }
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["sunsystems-postings", id] }),
        qc.invalidateQueries({ queryKey: ["form", id] }),
      ]);
      if (lastFailure && !anyPosted) {
        toast.error(postingGateErrorSummary([lastFailure]));
      } else if (anyPosted && lastFailure) {
        toast.error("Some postings still failed. The workflow will advance only after every required posting succeeds.");
      } else if (anyPosted) {
        toast.success("Posting succeeded. Waiting for the workflow to advance…");
      }
    } finally {
      setGateRetrying(false);
    }
  }, [gateRetrying, id, qc]);

  const dismissImprestPostingGate = useCallback(() => {
    setAwaitingImprestPostSince(0);
    setGateRetrying(false);
    toast.info("A reminder stays on this form until posting succeeds. The next Request approver is not notified yet.");
  }, []);

  const dismissLpoGenerationGate = useCallback(() => {
    setAwaitingLpo(false);
    setGateRetrying(false);
    toast.info("A reminder stays on this form until the purchase order posts and the LPO is generated.");
  }, []);

  useEffect(() => {
    if (!awaitingImprestPostSince || formDataUpdatedAt <= awaitingImprestPostSince) return;
    if (String(formData?.imprest_request_workflow_status || "").toLowerCase() === "posting") return;
    // A failed posting leaves the form status as "posting"; only treat leaving
    // that state as success after the gate has actually resumed.
    setAwaitingImprestPostSince(0);
    setGateRetrying(false);
    setWorkflowActionCompleted(true);
  }, [awaitingImprestPostSince, formDataUpdatedAt, formData?.imprest_request_workflow_status]);
  const generatedLpos = formData?.lpo_documents?.length
    ? formData.lpo_documents
    : formData?.lpo_document_id
      ? [{ id: formData.lpo_document_id, reference: formData.lpo_reference }]
      : [];
  const [selectedLpoId, setSelectedLpoId] = useState<string | null>(
    (location.state as { selectedLpoId?: string } | null)?.selectedLpoId ?? null,
  );
  const selectedLpo = generatedLpos.find((lpo) => lpo.id === selectedLpoId) || generatedLpos[0];
  const generatedLpoId = selectedLpo?.id;
  const generatedLpoReference = selectedLpo?.reference || formData?.lpo_reference;
  const lpoSetKey = generatedLpos.map((lpo) => lpo.id).join(",");
  const [lpoModalOpen, setLpoModalOpen] = useState(false);
  const [lpoMinimized, setLpoMinimized] = useState(false);

  useEffect(() => {
    if (!generatedLpos.length) return;
    setAwaitingLpo(false);
    setGateRetrying(false);
    if (!generatedLpos.some((lpo) => lpo.id === selectedLpoId)) setSelectedLpoId(generatedLpos[0].id);
    setLpoModalOpen(true);
    setLpoMinimized(false);
    setWorkflowActionCompleted(false);
  }, [lpoSetKey]);

  const lpoPdfQuery = useQuery({
    queryKey: ["lpo-pdf", generatedLpoId],
    queryFn: async () => {
      const { data } = await documentsAPI.previewUrl(generatedLpoId!);
      return { ...data, url: normalizeApiFileUrl(data.url) ?? data.url };
    },
    enabled: Boolean(generatedLpoId),
    refetchInterval: (query) => query.state.data?.viewer === "processing" ? 1_500 : false,
  });
  const lpoDocumentQuery = useQuery({
    queryKey: ["generated-lpo-document", generatedLpoId],
    queryFn: () => documentsAPI.get(generatedLpoId!).then((r) => r.data),
    enabled: Boolean(generatedLpoId),
  });
  const lpoPdfUrl = lpoPdfQuery.data?.viewer === "pdfjs" ? lpoPdfQuery.data.url : null;

  useEffect(() => {
    if (!doc) return;
    const hasAdminAccess = Boolean(user?.has_admin_access);
    const canEdit = hasAdminAccess || (doc.permissions ?? []).includes("edit");
    // A returned document is back with its submitter for amendments. Evaluate
    // that user's conditions exactly as they would be on a draft; other users
    // continue to see the real workflow step and its narrower permissions.
    const returnedToSubmitter = doc.status === "returned" && doc.uploaded_by?.id === user?.id;
    const formProcessStep = returnedToSubmitter ? "draft" : doc.builder_process_step || doc.status;
    const viewer = {
      groupNames: user?.group_names ?? [],
      isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
      canEditConditionalSections: canEdit,
    };

    // Always sync form values from the server to get attachment descriptors
    // This ensures images show correctly after submission (storage_path instead of filename)
    if (!formEditing) {
      setFormValues({ ...(formData?.values ?? {}) });
    }

    // Post-approval edits are driven by the form's visible/editable rules for
    // this viewer. Drafts and returned forms use the explicit Edit form action.
    const hasConfiguredEditableSection = hasVisibleEditableSection(
      formData?.sections ?? [],
      formData?.values ?? {},
      formProcessStep,
      viewer,
    );
    const isEditableApprovalStep = ["request_approved", "requisition_approved", "rfq_approved", "lpo_approved", "retirement_approved"].includes(formProcessStep);
    if (!formEditing && canEdit && isEditableApprovalStep && !isFinalFormProcessStep(formProcessStep) && hasConfiguredEditableSection) {
      setFormValues({ ...(formData?.values ?? {}) });
      formDirtyRef.current = false;
      setFormEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, user, formData?.sections, formData?.values]);

  const { data: myTasks } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
  });
  const activeTask = myTasks?.find((t: { document_id: string }) => t.document_id === id);

  // When the page is opened via an email notification link (?task=<id>),
  // scroll the action panel into view once the approver's task has loaded.
  useEffect(() => {
    if (!searchParams.get("task") || !activeTask) return;
    const el = taskPanelRef.current;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTask]);

  // Approval tasks can arrive after the document query. Enter edit mode when
  // the reviewer's active task resolves; TemplateForm still enforces each
  // section/field's own visibility and editability rules.
  useEffect(() => {
    if (!doc || formEditing || activeTask?.status !== "in_progress") return;
    if (isFinalFormProcessStep(doc.builder_process_step || doc.status)) return;
    const permissions = doc.permissions ?? [];
    const hasEditPermission = Boolean(user?.has_admin_access)
      || permissions.includes("edit")
      || permissions.includes("approve");
    if (!hasEditPermission) return;
    setFormValues({ ...(formData?.values ?? {}) });
    formDirtyRef.current = false;
    setFormEditing(true);
  }, [doc, activeTask, formEditing, formData?.values, user?.has_admin_access]);

  const { data: workflowData, isLoading: workflowDataLoading } = useQuery({
    queryKey: ["form-workflow", id],
    queryFn: () => loadWorkflowData(id!, doc?.builder_workflow_phase),
    enabled: !!id && !!doc,
    ...QUERY_SHORT_STALE,
    refetchInterval: (query) => (query.state.data?.isActive ? 15_000 : false),
  });
  const workflowStepsCount = workflowData?.steps?.length ?? 0;

  // Inspect template schema for signature and date fields
  const detectedFormFields: FormTargetField[] = useMemo(() => {
    const list: FormTargetField[] = [];
    const secList = (formData?.sections ?? []) as Array<{ fields?: Array<Record<string, any>> }>;
    for (const s of secList) {
      for (const f of s.fields ?? []) {
        const k = f.key ?? f.id;
        const label = f.label || k;
        if (/signature|sign|sig/i.test(k) || f.type === "signature") {
          list.push({ key: k, label: `${label} (Signature)`, kind: "signature" });
        } else if (/date/i.test(k) || f.type === "date") {
          list.push({ key: k, label: `${label} (Date)`, kind: "date" });
        } else if (/signer|signed_by|authorizer|requester/i.test(k)) {
          list.push({ key: k, label: `${label} (Name)`, kind: "text" });
        }
      }
    }
    return list;
  }, [formData?.sections]);

  const { data: auditLogs } = useQuery({
    queryKey: ["form-audit", id, auditPage],
    queryFn: () => documentsAPI.auditTrail(id!, { page: auditPage, page_size: AUDIT_PAGE_SIZE }).then((r) => r.data),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
  });

  const submitMutation = useMutation({
    mutationFn: async (workflowStage?: "requisition" | "rfq" | "lpo" | "retirement") => {
      if (formEditing && formDirtyRef.current) {
        // Never advance a workflow with values that exist only in this tab.
        // Previously declining the optional save prompt still submitted the
        // workflow, so the next approver saw the last persisted (often blank)
        // retirement table.
        const missing = requiredFieldLabels(formData?.sections ?? [], formValues, {
          groupNames: user?.group_names ?? [],
          isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
          canEditConditionalSections: canEditConditionalSections(),
        }, formProcessStep());
        const pastDates = pastDateFieldLabels(formData?.sections ?? [], formValues, {
          groupNames: user?.group_names ?? [],
          isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
          canEditConditionalSections: canEditConditionalSections(),
        }, formProcessStep());
        if (missing.length || pastDates.length) {
          setMissingFields([...missing, ...pastDates.map((field) => `Past date: ${field}`)]);
          throw new Error("FORM_REQUIRED_FIELDS");
        }
        setMissingFields([]);
        await updateFormMutation.mutateAsync();
      }
      return documentsAPI.submit(id!, workflowStage ? { workflow_stage: workflowStage } : undefined);
    },
    onSuccess: () => {
      toast.success("Submitted for approval");
      setFormEditing(false);
      formDirtyRef.current = false;
      qc.invalidateQueries({ queryKey: ["form", id] });
      qc.invalidateQueries({ queryKey: ["form-workflow", id] });
      qc.invalidateQueries({ queryKey: ["forms"] });
    },
    onError: (err: any) => {
      if (err?.message === "FORM_REQUIRED_FIELDS") return;
      const message = extractApiError(err, "Submission failed");
      if (/required fields missing/i.test(message)) {
        const fieldList = message.split(/required fields missing:\s*/i)[1];
        setMissingFields(fieldList ? fieldList.split(/,\s*/) : [message]);
        return;
      }
      toast.error(message);
    },
  });

  const commentMutation = useMutation({
    mutationFn: (content: string) => documentsAPI.addComment(id!, content),
    onSuccess: () => { setComment(""); qc.invalidateQueries({ queryKey: ["form", id] }); },
    onError: (err) => toast.error(extractApiError(err, "Failed to add comment")),
  });

  const updateFormMutation = useMutation({
    mutationFn: () => {
      const { jsonValues, attachments } = collectFormAttachments(formValues);
      return documentsAPI.updateForm(id!, jsonValues, attachments);
    },
    onSuccess: () => {
      toast.success("Form updated.");
      setFormEditing(false);
      formDirtyRef.current = false;
      qc.invalidateQueries({ queryKey: ["form", id] });
      qc.invalidateQueries({ queryKey: ["forms"] });
    },
    onError: (err: any) => toast.error(extractApiError(err, "Could not update the form.")),
  });

  const saveFormAsDraftMutation = useMutation({
    mutationFn: () => {
      const { jsonValues, attachments } = collectFormAttachments(formValues);
      return documentsAPI.updateForm(id!, jsonValues, attachments);
    },
    onSuccess: () => {
      toast.success("Saved as draft.");
      formDirtyRef.current = false;
      qc.invalidateQueries({ queryKey: ["form", id] });
    },
    onError: (err: any) => toast.error(extractApiError(err, "Failed to save draft")),
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-white">
        <Loader2 className="h-8 w-8 animate-spin text-[#287EAD]" />
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="mx-auto mt-10 max-w-xl border border-[#C8CDD2] bg-white p-8 shadow-sm">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-1 h-6 w-6 text-amber-500" />
          <div>
            <h2 className="text-xl font-semibold text-[#1F2933]">Form not found</h2>
            <p className="mt-2 text-sm text-[#5E6870]">This form is no longer available.</p>
          </div>
        </div>
        <Link to="/list" className="mt-6 inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#246d9c]">
          <ArrowLeft className="h-4 w-4" /> Back to Requisitions
        </Link>
      </div>
    );
  }

  if (!formData?.sections) {
    return (
      <div className="mx-auto mt-10 max-w-xl border border-[#C8CDD2] bg-white p-8 shadow-sm">
        <div className="flex items-start gap-3">
          <Info className="mt-1 h-6 w-6 text-[#287EAD]" />
          <div>
            <h2 className="text-xl font-semibold text-[#1F2933]">This document isn't a form</h2>
            <p className="mt-2 text-sm text-[#5E6870]">
              It has no in-app form fields, so it belongs in the regular Documents area instead.
            </p>
          </div>
        </div>
        <div className="mt-6 flex gap-3">
          <Link to="/list" className="inline-flex items-center gap-2 border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F5F7F8]">
            Back to Requisitions
          </Link>
          <Link to={`/documents/${id}`} className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#246d9c]">
            Open in Documents
          </Link>
        </div>
      </div>
    );
  }

  const isOwnerOrSubmitter = doc.uploaded_by?.id === user?.id || doc.owned_by?.id === user?.id;
  const hasAdminAccess = Boolean(user?.has_admin_access);
  const canEdit = hasAdminAccess || (doc.permissions ?? []).includes("edit");
  const canDownload = hasAdminAccess || (doc.permissions ?? []).includes("download");
  const canDownloadLpo = hasAdminAccess || (lpoDocumentQuery.data?.permissions ?? []).includes("download");
  const canComment = hasAdminAccess || (doc.permissions ?? []).includes("comment");
  const canApprove = hasAdminAccess || (doc.permissions ?? []).includes("approve");
  const hasActiveApprovalTask = Boolean(activeTask && activeTask.status === "in_progress");

  function formProcessStep() {
    const returnedToSubmitter = doc.status === "returned" && doc.uploaded_by?.id === user?.id;
    return returnedToSubmitter ? "draft" : doc.builder_process_step || doc.status;
  }
  function canEditConditionalSections() {
    return hasAdminAccess || isOwnerOrSubmitter || hasActiveApprovalTask;
  }

  const step = formProcessStep();
  const completedStages = doc.metadata?.form?.completed_workflow_stages;
  const requisitionApproved = Array.isArray(completedStages) && completedStages.includes("requisition");
  const lpoApproved = Array.isArray(completedStages) && completedStages.includes("lpo");
  const canEditRetirementSection = canEdit
    && requisitionApproved
    && lpoApproved
    && step === "lpo_approved"
    && hasVisibleRetirementEditSection(formData.sections ?? [], formData.values ?? {}, step, {
      groupNames: user?.group_names ?? [],
      isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
    });
  const retirementOnlyEdit = canEditRetirementSection && isApprovalLockedStatus(step) && !hasActiveApprovalTask;
  const retirementSectionReadOnly = !lpoApproved;
  const canEditForm = ["draft", "returned"].includes(doc.status) && canEdit;

  const budgetEnabled = Boolean(doc.metadata?.sunsystems?.budget?.enabled);
  const journalEnabled = Boolean(doc.metadata?.sunsystems?.journal?.enabled);
  const purchaseOrderEnabled = Boolean(doc.metadata?.sunsystems?.purchase_order?.enabled)
    || String(doc.metadata?.sunsystems?.journal?.component ?? "").toLowerCase() === "purchaseorder";
  const sunSystemsPostingEnabled = journalEnabled || purchaseOrderEnabled;
  const journalStages = doc.metadata?.sunsystems?.journal?.stages as Array<{ stage: number; enabled?: boolean }> | undefined;
  const availableStages = journalStages?.filter((s) => s.enabled !== false).map((s) => s.stage).sort((a, b) => a - b) || [1];

  const isRetirementPhase = doc.builder_workflow_phase === "retirement";
  const isRetirementSubmitted = isRetirementPhase && step === "retirement_pending";
  const isLpoWorkflowStep = ["lpo_pending", "lpo_approved", "retirement_pending", "retirement_approved", "fully_approved"].includes(step);
  const canPreviewSunSystemsPayload = journalEnabled || (purchaseOrderEnabled && isLpoWorkflowStep);
  const payloadInitialStage = isRetirementSubmitted ? 2 : (purchaseOrderEnabled && isLpoWorkflowStep ? 1000 : 1);
  const isRetirementFinalized = isRetirementPhase && isFinalFormProcessStep(step);
  const canSubmitRequest = ["draft", "returned"].includes(doc.status)
    && (!isRetirementPhase || doc.status === "returned")
    && (canApprove || isOwnerOrSubmitter || (doc.permissions ?? []).includes("submit"));
  // Only allow retirement submission if template has multiple stages configured (Stage 2 exists)
  const hasRetirementStage = availableStages.includes(2)
    || Boolean(doc.metadata?.form?.travel_retirement?.enabled);
  const canSubmitRetirement = Boolean(doc.can_submit_retirement) && !isRetirementFinalized && hasRetirementStage
    && (canApprove || isOwnerOrSubmitter || (doc.permissions ?? []).includes("submit"));
  const canInitiateRetirement = canApprove || isOwnerOrSubmitter || (doc.permissions ?? []).includes("submit");
  const showRetirementSubmit = Boolean(doc.metadata?.form?.travel_retirement?.enabled)
    && requisitionApproved
    && canInitiateRetirement
    && hasVisibleRetirementEditSection(formData.sections ?? [], formData.values ?? {}, step, {
      groupNames: user?.group_names ?? [],
      isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
    });
  // Server-computed, travel-aware: requisition -> (rfq | lpo for Travel) -> lpo.
  const procurementNextStage = doc.builder_next_stage ?? null;
  const canSubmitProcurementStage = Boolean(procurementNextStage) && (canApprove || isOwnerOrSubmitter);
  const canSubmit = canSubmitRequest || canSubmitProcurementStage;
  const submitLabel = canSubmitProcurementStage
    ? `Submit ${procurementNextStage!.toUpperCase()}`
    : doc.status === "returned"
      ? "Resubmit"
      : "Submit for approval";

  const startFormEdit = () => {
    if (!(["draft", "returned"].includes(doc.status) && canEdit)) return;
    setFormValues({ ...(formData.values ?? {}) });
    formDirtyRef.current = false;
    setFormEditing(true);
  };
  const retryLpoPreview = async () => {
    await lpoPdfQuery.refetch();
  };
  const handlePrintRequisition = async () => {
    if (!canDownload) return;
    try {
      await documentsAPI.filePrintEvent(doc.id);
      const source = document.getElementById("requisition-printable");
      if (!source) throw new Error("Printable requisition is not available.");

      document.getElementById("requisition-print-root")?.remove();
      const printRoot = document.createElement("main");
      printRoot.id = "requisition-print-root";
      printRoot.setAttribute("aria-label", "Requisition print preview");
      const formCopy = source.cloneNode(true) as HTMLElement;
      formCopy.removeAttribute("id");
      formCopy.classList.remove("hidden");
      formCopy.classList.remove("requisition-print-source");
      const originalInputs = source.querySelectorAll<HTMLInputElement>("input");
      const copiedInputs = formCopy.querySelectorAll<HTMLInputElement>("input");
      originalInputs.forEach((input, index) => {
        const copy = copiedInputs[index];
        if (!copy) return;
        copy.value = input.value;
        copy.checked = input.checked;
      });
      const originalTextareas = source.querySelectorAll<HTMLTextAreaElement>("textarea");
      const copiedTextareas = formCopy.querySelectorAll<HTMLTextAreaElement>("textarea");
      originalTextareas.forEach((field, index) => {
        if (copiedTextareas[index]) copiedTextareas[index].value = field.value;
      });
      const originalSelects = source.querySelectorAll<HTMLSelectElement>("select");
      const copiedSelects = formCopy.querySelectorAll<HTMLSelectElement>("select");
      originalSelects.forEach((field, index) => {
        const copy = copiedSelects[index];
        if (!copy) return;
        Array.from(copy.options).forEach((option, optionIndex) => {
          option.selected = field.options[optionIndex]?.selected ?? false;
        });
      });
      formCopy.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
        const type = input.type.toLowerCase();
        if (type === "hidden" || type === "file") {
          input.remove();
          return;
        }
        if (type === "radio" && !input.checked) {
          input.remove();
          return;
        }
        const value = type === "checkbox"
          ? (input.checked ? "Yes" : "No")
          : type === "radio"
            ? "✓"
            : type === "date" && input.value
              ? (() => {
                const [year, month, day] = input.value.split("-");
                return `${day}/${month}/${year}`;
              })()
              : input.value.trim();
        const text = document.createElement("span");
        text.className = "requisition-print-value";
        text.textContent = value || "—";
        input.replaceWith(text);
      });
      formCopy.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((field) => {
        const text = document.createElement("span");
        text.className = "requisition-print-value";
        text.textContent = field.value.trim() || "—";
        field.replaceWith(text);
      });
      formCopy.querySelectorAll<HTMLSelectElement>("select").forEach((field) => {
        const text = document.createElement("span");
        text.className = "requisition-print-value";
        const selected = Array.from(field.selectedOptions).map((option) => option.label).filter(Boolean).join(", ");
        text.textContent = !selected || /^select\b/i.test(selected) ? "—" : selected;
        field.replaceWith(text);
      });
      formCopy.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"], button[data-external-select-trigger]').forEach((button) => {
        const label = button.textContent?.trim() ?? "";
        const text = document.createElement("span");
        text.className = "requisition-print-value";
        text.textContent = /^select\b/i.test(label) ? "—" : label || "—";
        button.replaceWith(text);
      });
      formCopy.querySelectorAll("button").forEach((button) => button.remove());
      printRoot.appendChild(formCopy);
      document.body.appendChild(printRoot);

      document.body.classList.add("requisition-print-enabled");
      const cleanup = () => {
        document.body.classList.remove("requisition-print-enabled");
        printRoot.remove();
      };
      window.addEventListener("afterprint", cleanup, { once: true });
      window.print();
      window.setTimeout(cleanup, 60_000);
    } catch {
      toast.error("Download permission is required to print this requisition.");
    }
  };
  const handleDownloadLpo = async () => {
    if (!generatedLpoId || !canDownloadLpo) return;
    try {
      const response = await documentsAPI.downloadAsPdf(generatedLpoId);
      const blobUrl = URL.createObjectURL(new Blob([response.data], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `Purchase_Order_${generatedLpoReference || "LPO"}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000);
    } catch {
      toast.error("Could not download the LPO. Check your Download permission and retry.");
    }
  };
  const saveForm = () => {
    const missing = requiredFieldLabels(formData.sections ?? [], formValues, {
      groupNames: user?.group_names ?? [],
      isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
      canEditConditionalSections: canEditConditionalSections(),
    }, step);
    const pastDates = pastDateFieldLabels(formData.sections ?? [], formValues, {
      groupNames: user?.group_names ?? [],
      isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
      canEditConditionalSections: canEditConditionalSections(),
    }, step);
    if (missing.length || pastDates.length) {
      setMissingFields([...missing, ...pastDates.map((field) => `Past date: ${field}`)]);
      toast.error(`${missing.length} required field${missing.length === 1 ? "" : "s"} still need${missing.length === 1 ? "s" : ""} attention.`);
      return;
    }
    setMissingFields([]);
    updateFormMutation.mutate();
  };
  const savePendingFormEditsBeforeApproval = async () => {
    if (formEditing && formDirtyRef.current) {
      await updateFormMutation.mutateAsync();
    }
  };

  // Leaving edit mode throws away unsaved work — always confirm first.
  const cancelFormEdit = () => {
    if (formDirtyRef.current && !window.confirm("Discard your unsaved changes to this form?")) return;
    setFormEditing(false);
    formDirtyRef.current = false;
    setMissingFields([]);
  };

  const auditCount = auditLogs?.count ?? 0;
  const auditPages = Math.max(1, Math.ceil(auditCount / AUDIT_PAGE_SIZE));

  const tabs: { id: TabId; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "history", label: `History (${(doc.versions ?? []).length})` },
    { id: "comments", label: `Comments (${doc.comments?.length ?? 0})` },
    { id: "audit", label: "Audit trail" },
  ];

  return (
    <div className="form-detail-page flex min-h-0 flex-1 flex-col bg-[#F2F6F9] text-[#1F2933]">
      <style>{`@page { size: A4 portrait; margin: 8mm; }
      @media print {
        body * { visibility: hidden !important; }
        body:not(.requisition-print-enabled) * { display: none !important; }
        body.requisition-print-enabled > #root { display: none !important; }
        body.requisition-print-enabled #requisition-print-root,
        body.requisition-print-enabled #requisition-print-root * { visibility: visible !important; }
        body.requisition-print-enabled #requisition-print-root { display: block !important; position: static !important; width: 100% !important; padding: 0 !important; color: #1f2933 !important; background: white !important; font-family: Arial, sans-serif !important; }
        #requisition-print-root * { color: #1f2933 !important; }
        #requisition-print-root .rq-print-document { display: block !important; width: 100% !important; color: #1f2933 !important; font: 8pt Arial, sans-serif !important; }
        #requisition-print-root .rq-print-org { display: block !important; padding: 2mm 0 1mm; margin-bottom: 0; border: 0; text-align: center; font-size: 10pt; font-weight: 700; line-height: 1.5; }
        #requisition-print-root .rq-print-title { position: relative; display: flex !important; justify-content: center; align-items: baseline; border-bottom: 1.5pt solid #287ead; padding: 1mm 0 2.5mm; margin-bottom: 3mm; text-align: center; }
        #requisition-print-root .rq-print-title h2 { margin: 0; padding: 0; border: 0; background: transparent !important; font-size: 9pt; font-weight: 600; text-transform: uppercase; }
        #requisition-print-root .rq-print-title span { position: absolute; right: 0; font-weight: 700; }
        #requisition-print-root .rq-print-document section { display: block !important; margin: 2.5mm 0; }
        #requisition-print-root .rq-print-document section h2 { margin: 0 0 1.5mm; padding: 1mm 1.5mm; border-bottom: 1pt solid #9aa6af; background: #eef3f7 !important; font-size: 8pt; text-transform: uppercase; }
        #requisition-print-root .rq-print-details { display: grid !important; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1mm 3mm; margin: 1.5mm 0; }
        #requisition-print-root .rq-print-details-two { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        #requisition-print-root .rq-print-details > div { display: flex !important; gap: 1mm; min-width: 0; }
        #requisition-print-root .rq-print-details b { min-width: 27mm; }
        #requisition-print-root .rq-print-details span { overflow-wrap: anywhere; }
        #requisition-print-root .rq-print-answer { display: grid !important; grid-template-columns: 40mm 1fr 20mm 2fr; gap: 2mm; }
        #requisition-print-root .rq-print-table { margin: 1.5mm 0; }
        #requisition-print-root .rq-print-subheading { margin: 2mm 0 1mm; color: #405767 !important; font-size: 7.5pt; font-weight: 700; text-transform: uppercase; }
        #requisition-print-root .rq-print-signatures { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2mm; margin-top: 2mm; }
        #requisition-print-root .rq-print-signature-pair { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2mm; margin-top: 2mm; }
        #requisition-print-root .rq-print-signature-pair .rq-print-signatures { display: block !important; margin-top: 0 !important; }
        #requisition-print-root .rq-print-signature { display: block !important; min-height: 16mm; padding: 1.5mm; border: 0.5pt solid #aeb5bb; }
        #requisition-print-root .rq-print-signature img { display: block !important; width: auto !important; max-width: 52mm; max-height: 19mm; object-fit: contain; }
        #requisition-print-root .rq-print-signature-has-image { min-height: 22mm !important; }
        #requisition-print-root .rq-print-signature-line { display: block !important; width: 40mm; height: 8mm; border-bottom: 0.5pt solid #333; }
        #requisition-print-root .rq-print-footnote { display: block !important; margin-top: 3mm; padding-top: 1mm; border-top: 0.5pt solid #9aa6af; font-size: 7pt; }
        #requisition-print-root .overflow-hidden, #requisition-print-root .overflow-x-auto, #requisition-print-root .overflow-auto { overflow: visible !important; }
        #requisition-print-root .min-w-full { min-width: 0 !important; width: 100% !important; }
        #requisition-print-root table { width: 100% !important; table-layout: fixed !important; border-collapse: collapse !important; }
        #requisition-print-root th, #requisition-print-root td { width: auto !important; min-width: 0 !important; padding: 5pt 4pt !important; border: 1px solid #aeb5bb !important; white-space: normal !important; overflow-wrap: anywhere !important; font-size: 8pt !important; }
        #requisition-print-root th { background: #eef3f7 !important; color: #263746 !important; }
        #requisition-print-root tr { break-inside: avoid; }
        #requisition-print-root thead { display: table-header-group; }
        #requisition-print-root h3, #requisition-print-root h4 { break-after: avoid; }
        #requisition-print-root input, #requisition-print-root textarea, #requisition-print-root select { display: none !important; }
        #requisition-print-root button, #requisition-print-root [role="button"] { display: none !important; }
        #requisition-print-root .requisition-print-value { display: block !important; min-height: 1em; color: #1f2933 !important; font-size: 9pt !important; font-weight: 400 !important; opacity: 1 !important; }
        #requisition-print-root .grid { gap: 4mm !important; }
        #requisition-print-root .shadow-sm { box-shadow: none !important; }
      }`}</style>
      <WorkspaceCommandBar>
        <button
          onClick={() => navigate("/list")}
          className="flex h-8 items-center gap-1 border border-white/20 bg-white/10 px-3 text-xs text-white/85 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Requisitions
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold">{doc.title}</h1>
            <span className={cn(
              "inline-flex items-center border px-2.5 py-0.5 text-xs font-bold shadow-sm",
              getCommandStatusClass(doc.status),
            )}>
              {getCommandStatusLabel(doc.status)}
            </span>
            {isRetirementPhase && (() => {
              const variance = (doc.metadata as any)?.form?.retirement_variance as RetirementVariance | undefined;
              if (!variance) return null;
              const amount = Number(variance.amount ?? 0);
              if (!variance.kind || !Number.isFinite(amount) || amount === 0) return null;
              const isOver = variance.kind === "over";
              return (
                <span className={cn(
                  "inline-flex items-center gap-1.5 border px-2.5 py-0.5 text-xs font-semibold shadow-sm",
                  isOver ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900",
                )}>
                  {isOver ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {isOver ? "Overspent" : "Underspent"} {formatMoney(amount, doc.currency)}
                </span>
              );
            })()}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-white/75">
            {doc.reference_number} · {doc.document_type?.name || "Form"}
          </p>
        </div>
      </WorkspaceCommandBar>

      <div className={cn(
        "scrollbar-minimal relative mx-auto grid min-h-0 w-full max-w-[1800px] flex-1 grid-cols-1 items-start gap-5 overflow-y-auto px-4 py-5 sm:px-6 lg:grid-cols-12 lg:gap-6",
        detailsOpen ? "pr-8" : "pr-12",
      )}>

        {/* Details-panel toggle — pinned to the right edge */}
        <button
          type="button"
          onClick={() => setDetailsOpen((o) => !o)}
          title={detailsOpen ? "Hide details panel" : "Show details panel"}
          className="absolute right-2 top-2 z-20 flex h-9 w-9 items-center justify-center rounded-xl border border-[#D7E2E9] bg-white text-[#5E6870] shadow-sm hover:bg-[#EEF6FB] hover:text-[#287EAD] transition-colors"
        >
          {detailsOpen
            ? <PanelRightClose className="h-4 w-4" />
            : <PanelRightOpen className="h-4 w-4" />}
        </button>

        {/* Form column */}
        <div className={cn(
          "space-y-4",
          detailsOpen ? "lg:col-span-8" : "lg:col-span-12",
        )}>
          <div className="overflow-hidden rounded-2xl border border-[#D7E2E9] bg-white shadow-[0_4px_18px_rgba(31,55,72,0.05)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2EAF0] bg-gradient-to-r from-white to-[#F7FAFC] px-4 py-3 sm:px-5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-[#1F2933]">Form</p>
                {doc.reference_number && (
                  <span className="inline-flex items-center border border-[#B7D7E8] bg-[#EEF6FB] px-2 py-0.5 text-[11px] font-semibold text-[#1E648A]">
                    {doc.reference_number}
                  </span>
                )}
                {(showImprestGateBanner || showLpoGateBanner) ? (
                  <PostingGateHeaderReminder
                    kind={showImprestGateBanner ? "imprest" : "lpo"}
                    retrying={gateRetrying}
                    onRetry={() => void retryGatePostings(
                      showImprestGateBanner ? failedImprestGatePostings : failedLpoGatePostings,
                    )}
                  />
                ) : (
                  <span className="text-xs text-[#5E6870]">
                    {formEditing ? (formDirtyRef.current ? "Editing — unsaved changes" : "Editing — fill and save") : canSubmitProcurementStage ? `${procurementNextStage!.toUpperCase()} stage is ready to start` : canSubmitRetirement ? "Retirement stage — fill expenditure, then submit" : canEditForm ? "Click Edit form to modify" : "Filled in-app"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {canSubmit && (
                  <button
                    type="button"
                    onClick={() => submitMutation.mutate(procurementNextStage ?? undefined)}
                    disabled={submitMutation.isPending}
                    className="inline-flex items-center gap-1.5 bg-[#287EAD] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50"
                  >
                    {submitMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <Send className="h-3.5 w-3.5" /> {submitLabel}
                  </button>
                )}
                {showRetirementSubmit && (
                  <button
                    type="button"
                    onClick={() => submitMutation.mutate("retirement")}
                    disabled={submitMutation.isPending || !canSubmitRetirement}
                    title={canSubmitRetirement ? "Submit this form to the configured Retirement workflow case" : "Available after LPO approval and on or after the configured travel return date"}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50",
                      canSubmitRetirement ? "bg-[#287EAD] text-white hover:bg-[#1E6F99]" : "border border-[#AEB5BB] bg-[#F5F7F8] text-[#5E6870]",
                    )}
                  >
                    {submitMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    Submit retirement
                  </button>
                )}
                {canPreviewSunSystemsPayload && (
                  <button type="button" onClick={() => setShowJournalXml((s) => !s)}
                    className={cn(
                      "inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F3F5F6]",
                      showJournalXml && "bg-[#EEF6FB] text-[#287EAD] border-[#287EAD]/50",
                    )}>
                    <FileCode className="h-3.5 w-3.5" /> {isRetirementSubmitted ? "Retirement XML" : purchaseOrderEnabled && isLpoWorkflowStep ? "LPO XML" : "Journal XML"}
                  </button>
                )}
                {canDownload && (
                  <button type="button" onClick={() => void handlePrintRequisition()}
                    className="inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
                    <Printer className="h-3.5 w-3.5" /> Print requisition
                  </button>
                )}
                {generatedLpos.length > 1 && (
                  <CustomListbox
                    value={generatedLpoId ?? ""}
                    onChange={(val) => setSelectedLpoId(val)}
                    options={generatedLpos.map((lpo, index) => ({
                      value: lpo.id,
                      label: `${lpo.table_label || `LPO ${index + 1}`} · ${lpo.reference || index + 1}`,
                    }))}
                    buttonClassName="max-w-44 border border-[#C8CDD1] bg-white px-2 py-1.5 text-xs text-[#1F2933] text-left hover:border-[#287EAD] transition-colors"
                    ariaLabel="Select LPO"
                  />
                )}
                {generatedLpoId && canDownloadLpo && (
                  <button type="button" onClick={() => void handleDownloadLpo()} className="inline-flex items-center gap-1.5 border border-[#287EAD] bg-[#287EAD] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#1E6F99]">
                    <Download className="h-3.5 w-3.5" /> Download LPO
                  </button>
                )}
                {generatedLpoId && (
                  <button type="button" onClick={() => { setLpoMinimized(false); setLpoModalOpen(true); }} className="inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
                    <Eye className="h-3.5 w-3.5" /> Open LPO
                  </button>
                )}
                {!formEditing && canEditForm && (
                  <button type="button" onClick={startFormEdit}
                    className="inline-flex items-center gap-1.5 border border-[#287EAD] px-2.5 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB]">
                    <Edit2 className="h-3.5 w-3.5" /> Edit form
                  </button>
                )}
                {formEditing && (
                  <>
                    <button type="button" onClick={cancelFormEdit}
                      disabled={updateFormMutation.isPending || saveFormAsDraftMutation.isPending}
                      className="inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F3F5F6] disabled:opacity-50">
                      <X className="h-3.5 w-3.5" /> Cancel
                    </button>
                    <button type="button" onClick={() => saveFormAsDraftMutation.mutate()} disabled={saveFormAsDraftMutation.isPending}
                      className="inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F3F5F6] disabled:opacity-50">
                      {saveFormAsDraftMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      Save draft
                    </button>
                    <button type="button" onClick={saveForm} disabled={updateFormMutation.isPending}
                      className="inline-flex items-center gap-1.5 bg-[#287EAD] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50">
                      {updateFormMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Save form
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="space-y-4 p-5">
              {budgetEnabled && formEditing && (() => {
                const budgetMeta = doc.metadata?.sunsystems?.budget ?? {};
                const amountField = budgetMeta.amount_field as string | undefined;
                const amount = amountField ? (formValues[amountField] ?? doc.amount ?? 0) : (doc.amount ?? 0);
                return (
                  <BudgetBanner
                    amount={amount as number | string}
                    budget={budgetMeta.limit ?? budgetMeta.budget ?? null}
                    currency={budgetMeta.currency ?? doc.currency ?? undefined}
                    accountCode={budgetMeta.account_code ?? undefined}
                  />
                );
              })()}
              <div id="requisition-printable" className="hidden requisition-print-source" aria-hidden="true">
                <PrintableRequisition
                  title="Travel Requisition and Authorisation Form"
                  reference={doc.reference_number || ""}
                  document={doc}
                  sections={(formData.sections ?? []) as Record<string, any>[]}
                  values={(formEditing ? formValues : (formData.values ?? {})) as Record<string, any>}
                  workflowSteps={workflowData?.steps ?? []}
                  printConfig={formData.print_config}
                  accountingPeriod={String((doc.metadata?.sunsystems as Record<string, any> | undefined)?.ui?.accountingPeriod ?? "")}
                  businessUnit={String((doc.metadata?.sunsystems as Record<string, any> | undefined)?.ui?.businessUnit ?? "")}
                />
              </div>
              <div className="form-renderer bg-white px-4 py-5 sm:px-5 sm:py-6">
                <TemplateForm
                  sections={formData.sections ?? []}
                  values={formEditing ? formValues : (formData.values ?? {})}
                  validationIssues={formEditing ? missingFields : []}
                  onChange={(k, v) => { formDirtyRef.current = true; setFormValues((prev) => ({ ...prev, [k]: v })); }}
                  readOnly={!formEditing}
                  documentId={doc.id}
                  documentStatus={step}
                  canEditConditionalSections={canEditConditionalSections()}
                  retirementOnlyEdit={retirementOnlyEdit}
                  retirementSectionReadOnly={retirementSectionReadOnly}
                  onLaunchSignatureModal={(fieldKey?: string) => {
                    setTargetSignatureField(fieldKey ?? null);
                    setIsSigningOpen(true);
                  }}
                />
              </div>
            </div>
          </div>

          {showJournalXml && (
            <JournalPayloadModal
              documentId={doc.id}
              values={formEditing ? formValues : undefined}
              title={doc.title}
              availableStages={availableStages}
              initialStage={payloadInitialStage}
              onClose={() => setShowJournalXml(false)}
            />
          )}

          {/* Signature Modal */}
          {isSigningOpen && (
            <SignaturePlacementModal
              mode="form"
              formFields={detectedFormFields}
              targetFieldKey={targetSignatureField}
              confirmLabel="Apply to Form"
              onCancel={() => {
                setIsSigningOpen(false);
                setTargetSignatureField(null);
              }}
              onConfirm={(result) => {
                // Use the formFieldValues from the modal result if available
                const fieldValues = result.formFieldValues || {};
                const updates: Record<string, unknown> = {};

                // Apply form field values from modal
                Object.entries(fieldValues).forEach(([key, value]) => {
                  updates[key] = value;
                });

                // Also process items for signature styling
                result.items.forEach((item) => {
                  if (item.kind === "signature" && item.image_data) {
                    updates[item.field_key || ""] = item.image_data;
                    // Store styling metadata
                    updates[`${item.field_key || ""}_style`] = {
                      color: item.color,
                      fontSize: item.font_percent ? `${item.font_percent * 10}px` : '16px',
                      fontFamily: item.font_family || 'helvetica',
                      bold: item.bold,
                      italic: item.italic,
                    };
                  } else if (item.kind === "date" && item.date_iso) {
                    updates[item.field_key || ""] = item.date_iso;
                    updates[`${item.field_key || ""}_date`] = item.date_iso;
                  } else if (item.kind === "text" && item.text) {
                    updates[item.field_key || ""] = item.text;
                    updates[`${item.field_key || ""}_name`] = item.text;
                  }
                });

                setFormValues((prev) => ({ ...prev, ...updates }));
                formDirtyRef.current = true;
                setIsSigningOpen(false);
                setTargetSignatureField(null);
              }}
              onApplyToForm={(fields) => {
                setFormValues((prev) => ({ ...prev, ...fields }));
                formDirtyRef.current = true;
              }}
            />
          )}

          {/* ── Supplier Invoices & Quotations panel (RFQ stage) ── */}
          {String((formData as any)?.workflow_phase || "").toLowerCase() === "rfq" && (
            <InvoiceAttachmentsPanel
              documentId={doc.id}
              values={formData?.values ?? {}}
              onBeforeSend={async () => {
                if (!formDirtyRef.current) return;
                const { jsonValues, attachments } = collectFormAttachments(formValues);
                await documentsAPI.updateForm(doc.id, jsonValues, attachments);
                formDirtyRef.current = false;
                qc.invalidateQueries({ queryKey: ["form", id] });
              }}
              onUpdated={() => qc.invalidateQueries({ queryKey: ["form", id] })}
            />
          )}

          {(isWorkflowActiveOrCompleted(step) || sunSystemsPostingEnabled) && (
            <div className={cn("grid gap-3", isWorkflowActiveOrCompleted(step) && sunSystemsPostingEnabled ? "lg:grid-cols-2" : "")}>
              {isWorkflowActiveOrCompleted(step) && (
                <ApprovalStagesTable
                  steps={workflowData?.steps ?? []}
                  isLoading={workflowDataLoading}
                  phase={doc.builder_workflow_phase}
                />
              )}
              <JournalPostingCard
                documentId={doc.id}
                expectPosting={
                  sunSystemsPostingEnabled
                  && (
                    ["request_approved", "fully_approved"].includes(step)
                    || imprestPostingGateActive
                    || lpoPostingGateActive
                  )
                }
                watchKey={`${step}:${doc.updated_at}`}
                availableStages={availableStages}
              />
            </div>
          )}

        </div>


        {/* Side column — tabs (only shown when detailsOpen is true) */}
        {detailsOpen && (
          <div className="overflow-hidden rounded-2xl border border-[#D7E2E9] bg-white shadow-[0_4px_18px_rgba(31,55,72,0.05)] lg:col-span-4">
            <div className="border-b border-[#E2EAF0] bg-[#FAFCFD] px-3 pt-2">
              <nav className="-mb-px flex flex-wrap gap-1">
                {tabs.map((tab) => (
                  <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      "whitespace-nowrap border-b-2 px-2.5 py-2 text-sm font-semibold transition-all",
                      activeTab === tab.id ? "border-[#287EAD] text-[#287EAD]" : "border-transparent text-[#5E6870] hover:border-[#C8CDD2] hover:text-[#1F2933]",
                    )}>
                    {tab.label}
                  </button>
                ))}
              </nav>
            </div>

            <div className="min-h-[24rem] bg-white p-4 sm:p-5">
              {activeTab === "details" && (
                <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-3 text-sm">
                  <span className="text-[#5E6870]">Document Type</span>
                  <span className="font-semibold text-[#1F2933]">{doc.document_type?.name || "—"}</span>
                  <span className="text-[#5E6870]">Requester</span>
                  <span className="font-semibold text-[#1F2933]">{doc.uploaded_by?.full_name || doc.uploaded_by?.email || "—"}</span>
                  <span className="text-[#5E6870]">Amount</span>
                  <span className="font-semibold text-[#1F2933]">{doc.amount ? `${doc.currency ?? ""} ${Number(doc.amount).toLocaleString()}` : "—"}</span>
                  <span className="text-[#5E6870]">Document date</span>
                  <span className="text-[#1F2933]">{doc.document_date ? format(new Date(doc.document_date), "dd MMM yyyy") : "—"}</span>
                  <span className="text-[#5E6870]">Created</span>
                  <span className="text-[#1F2933]">{format(new Date(doc.created_at), "dd MMM yyyy, HH:mm")}</span>
                  <span className="text-[#5E6870]">Updated</span>
                  <span className="text-[#1F2933]">{format(new Date(doc.updated_at), "dd MMM yyyy, HH:mm")}</span>
                  <span className="text-[#5E6870]">Reference</span>
                  <span className="font-mono text-[#1F2933]">{doc.reference_number}</span>
                </div>
              )}

              {activeTab === "history" && (
                <div className="space-y-2">
                  {(doc.versions ?? []).length === 0 ? (
                    <p className="py-8 text-center text-sm text-[#5E6870]">No version history.</p>
                  ) : (
                    [...(doc.versions ?? [])].sort((a: any, b: any) => b.version_number - a.version_number).map((v: any) => (
                      <div key={v.id} className="flex items-center justify-between border border-[#E3E7EA] px-3 py-2 text-sm">
                        <div>
                          <p className="font-semibold text-[#1F2933]">v{v.version_number} — {v.file_name}</p>
                          <p className="text-xs text-[#5E6870]">{format(new Date(v.created_at), "dd MMM yyyy HH:mm")} · {formatBytes(v.file_size)}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {activeTab === "comments" && (
                <div className="space-y-3">
                  <div className="max-h-64 space-y-2 overflow-y-auto">
                    {(!doc.comments || doc.comments.length === 0) && (
                      <p className="py-8 text-center text-sm text-[#5E6870]">No comments yet.</p>
                    )}
                    {doc.comments?.map((c: any) => (
                      <div key={c.id} className="border border-[#E3E7EA] p-2.5 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[#1F2933]">{c.author.first_name} {c.author.last_name}</span>
                          <span className="text-xs text-[#5E6870]">{format(new Date(c.created_at), "dd MMM yyyy HH:mm")}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-[#1F2933]">{c.content}</p>
                      </div>
                    ))}
                  </div>
                  <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3}
                    placeholder="Add a comment…" disabled={!canComment}
                    className="block w-full border border-[#AEB5BB] bg-white px-3 py-2 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]" />
                  <button onClick={() => comment.trim() && commentMutation.mutate(comment.trim())}
                    disabled={!comment.trim() || commentMutation.isPending || !canComment}
                    className="inline-flex items-center gap-2 bg-[#287EAD] px-3 py-2 text-sm font-semibold text-white hover:bg-[#206D99] disabled:opacity-50">
                    {commentMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <MessageSquare className="h-3.5 w-3.5" /> Add comment
                  </button>
                </div>
              )}

              {activeTab === "audit" && (
                <div className="space-y-3">
                  {auditLogs?.results?.length ? (
                    auditLogs.results.map((log: any) => (
                      <div key={log.id} className="flex gap-2 border-b border-[#E3E7EA] pb-2 text-sm">
                        <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#287EAD]" />
                        <div className="min-w-0">
                          <p className="text-[#1F2933]">{log.summary || log.event} — <span className="font-semibold">{log.actor_name || "System"}</span></p>
                          <p className="text-xs text-[#5E6870]">{format(new Date(log.timestamp), "dd MMM yyyy HH:mm:ss")}</p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="py-8 text-center text-sm text-[#5E6870]">No activity yet.</p>
                  )}
                  {auditCount > AUDIT_PAGE_SIZE && (
                    <div className="flex items-center justify-between border-t border-[#C8CDD2] pt-3 text-sm">
                      <span className="text-[#5E6870]">Page {auditPage} of {auditPages}</span>
                      <div className="flex gap-1.5">
                        <button onClick={() => setAuditPage((p) => Math.max(1, p - 1))} disabled={auditPage === 1}
                          className="border border-[#C8CDD2] bg-white px-3 py-1 disabled:opacity-40">Prev</button>
                        <button onClick={() => setAuditPage((p) => Math.min(auditPages, p + 1))} disabled={auditPage >= auditPages}
                          className="border border-[#C8CDD2] bg-white px-3 py-1 disabled:opacity-40">Next</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {activeTask && (
        <div ref={taskPanelRef} className="z-10 shrink-0 border-t border-[#C8CDD2] bg-white">
          <Suspense fallback={<div className="px-4 py-3 text-xs text-[#5E6870]">Loading actions...</div>}>
            <WorkflowActionPanel
              task={activeTask}
              documentId={id!}
              variant="bar"
              onBeforeApprove={savePendingFormEditsBeforeApproval}
              onCompleted={() => {
                setWorkflowActionCompleted(false);
                const phase = String((formData as any)?.workflow_phase ?? doc?.builder_workflow_phase ?? "").toLowerCase();
                const lpoApprovalSteps = (workflowData?.steps ?? []).filter((step) =>
                  step.kind === "task"
                  && /^approver-\d+$/.test(step.id)
                  && (!step.phase || step.phase === "lpo"),
                );
                const activeOrder = activeTask?.step?.order ?? 0;
                const laterLpoStepExists = lpoApprovalSteps.some((step) =>
                  Number(step.id.slice("approver-".length)) > activeOrder,
                );
                const isLastLpoApprover = phase === "lpo"
                  && activeOrder > 0
                  && lpoApprovalSteps.some((step) => step.id === `approver-${activeOrder}`)
                  && !laterLpoStepExists;
                const isLpoGenerationApprover = Boolean((activeTask?.step as any)?.post_lpo_after_approval);
                const isImprestPostingApprover = phase === "request"
                  && Boolean((activeTask?.step as any)?.post_imprest_request_after_approval);

                if (!isLpoGenerationApprover && !isLastLpoApprover) {
                  setAwaitingLpo(false);
                  if (isImprestPostingApprover) {
                    setWorkflowActionCompleted(false);
                    setAwaitingImprestPostSince(Date.now());
                    void qc.invalidateQueries({ queryKey: ["form", id] });
                    return;
                  }
                  setWorkflowActionCompleted(true);
                  return;
                }
                if (generatedLpos.length) {
                  setSelectedLpoId(generatedLpos[0].id);
                  setLpoModalOpen(true);
                  setLpoMinimized(false);
                  return;
                }
                setAwaitingLpo(true);
                void qc.invalidateQueries({ queryKey: ["form", id] });
              }}
            />
          </Suspense>
        </div>
      )}

      {generatedLpoId && lpoModalOpen && !lpoMinimized && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/50 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={`LPO ${generatedLpoReference || "document"}`}>
          <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden border border-[#AEB5BB] bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-bold text-[#1F2933]">Purchase Order {generatedLpoReference || ""}</h2>
                <p className="text-xs text-[#5E6870]">Generated LPO document</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {canDownloadLpo && (
                  <button type="button" onClick={() => void handleDownloadLpo()} className="inline-flex items-center gap-1.5 border border-[#287EAD] bg-[#287EAD] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1E6F99]">
                    <Download className="h-3.5 w-3.5" /> Download PDF
                  </button>
                )}
                <button type="button" aria-label="Minimize LPO" onClick={() => setLpoMinimized(true)} className="border border-[#C8CDD2] bg-white p-2 text-[#35434D] hover:bg-[#E9EEF1]"><PanelRightClose className="h-4 w-4" /></button>
                <button type="button" aria-label="Close LPO" onClick={() => setLpoModalOpen(false)} className="border border-[#C8CDD2] bg-white p-2 text-[#35434D] hover:bg-[#E9EEF1]"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="min-h-[50vh] flex-1 bg-[#E9EEF1]">
              {lpoPdfUrl ? (
                <LpoPdfPreview
                  url={lpoPdfUrl}
                  title={`Purchase Order ${generatedLpoReference || "LPO"}`}
                  canPrint={canDownloadLpo}
                  onPrint={() => documentsAPI.filePrintEvent(generatedLpoId!).then(() => undefined)}
                />
              ) : lpoPdfQuery.isError || lpoPdfQuery.data?.preview_status === "failed" ? (
                <div className="flex h-[50vh] flex-col items-center justify-center gap-2 px-6 text-center text-sm text-[#5E6870]">
                  <p>{lpoPdfQuery.data?.preview_error || "Could not load the LPO PDF. Retry, or reload the page to try again."}</p>
                  <button type="button" onClick={retryLpoPreview} className="border border-[#AEB5BB] bg-white px-3 py-2 text-xs font-semibold text-[#1F2933] hover:bg-[#F5F7F8]">Retry preview</button>
                </div>
              ) : (
                <div className="flex h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[#46545E]">
                  <Loader2 className="h-6 w-6 animate-spin text-[#287EAD]" />
                  <p>Loading the LPO PDF.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {awaitingLpo && !generatedLpos.length && (
        <PostingGateOverlay
          title="Approval complete"
          pendingMessage="Preparing the generated LPO after SunSystems returns the purchase order number…"
          failedPostings={failedLpoGatePostings}
          retrying={gateRetrying}
          onRetry={() => void retryGatePostings(failedLpoGatePostings)}
          onDismiss={dismissLpoGenerationGate}
        />
      )}

      {awaitingImprestPostSince > 0 && (
        <PostingGateOverlay
          title="Imprest posting in progress"
          pendingMessage="The next Request approver will be notified after SunSystems confirms the posting."
          failedPostings={failedImprestGatePostings}
          retrying={gateRetrying}
          onRetry={() => void retryGatePostings(failedImprestGatePostings)}
          onDismiss={dismissImprestPostingGate}
        />
      )}

      {workflowActionCompleted && !awaitingLpo && !activeTask && !generatedLpos.length && (
        <div className="fixed inset-0 z-[200] flex items-start justify-center bg-black/40 px-4 pt-[10vh]">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="workflow-complete-title"
            className="w-full max-w-sm border border-[#C8CDD2] bg-white shadow-2xl"
          >
            <div className="px-6 pt-5 pb-4">
              <h2 id="workflow-complete-title" className="text-sm font-bold text-[#1F2933]">
                Workflow action complete
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-[#5E6870]">
                This form has moved to the next stage and is no longer actionable from your current access level.
              </p>
            </div>
            <div className="flex justify-center pb-5">
              <button
                type="button"
                onClick={() => navigate("/list", { replace: true })}
                className="inline-flex items-center bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
