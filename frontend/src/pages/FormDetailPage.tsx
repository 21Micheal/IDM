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

import { Suspense, useEffect, useRef, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, workflowAPI } from "@/services/api";
import TemplateForm, { requiredFieldLabels } from "@/components/templates/TemplateForm";
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
  TrendingUp, TrendingDown, CheckCircle2,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/lib/utils";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";

const AUDIT_PAGE_SIZE = 5;

function formHasConditionalEditability(sections?: unknown[]): boolean {
  const list = Array.isArray(sections) ? sections : [];
  return list.some((section: any) => {
    if (section?.editableWhen) return true;
    return Array.isArray(section?.fields) && section.fields.some((field: any) => Boolean(field?.editableWhen));
  });
}

function isApprovalLockedStatus(status?: string): boolean {
  return ["pending_approval", "request_pending", "retirement_pending", "on_hold"].includes(status || "");
}

function isWorkflowActiveOrCompleted(status?: string): boolean {
  return isApprovalLockedStatus(status) || ["approved", "request_approved", "fully_approved"].includes(status || "");
}

function isFinalFormProcessStep(step?: string): boolean {
  return ["fully_approved", "retirement_rejected"].includes(step || "");
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
  if (["approved", "active", "enabled", "completed", "request_approved", "fully_approved"].includes(key)) {
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
  const [workflowActionCompleted, setWorkflowActionCompleted] = useState(false);
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

  const { data: doc, isLoading } = useQuery<any>({
    queryKey: ["form", id],
    queryFn: () => documentsAPI.get(id!).then((r) => r.data),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
    refetchInterval: 8_000,
  });

  const formData = (doc?.metadata as Record<string, any> | undefined)?.form as
    | { sections?: unknown[]; values?: Record<string, unknown> }
    | undefined;

  useEffect(() => {
    if (!doc) return;
    const isOwnerOrSubmitter = doc.uploaded_by?.id === user?.id || doc.owned_by?.id === user?.id;
    const hasAdminAccess = Boolean(user?.has_admin_access);
    const canEdit = hasAdminAccess || (doc.permissions ?? []).includes("edit");
    const hasConditionalEditability = formHasConditionalEditability(formData?.sections);
    const formProcessStep = doc.builder_process_step || doc.status;
    const isRequestApproved = formProcessStep === "request_approved" || (!doc.builder_process_step && doc.status === "approved");
    const canEditForm = canEdit
      && !isApprovalLockedStatus(formProcessStep)
      && !isFinalFormProcessStep(formProcessStep)
      && (doc.status !== "approved" || (isRequestApproved && hasConditionalEditability && (hasAdminAccess || isOwnerOrSubmitter)));

    // Auto-enter edit mode when form has conditional editability and user is at a stage
    // where conditional editing should be allowed (request_approved for retirement, etc.)
    if (!formEditing && hasConditionalEditability && (isRequestApproved || canEditForm)) {
      setFormValues({ ...(formData?.values ?? {}) });
      formDirtyRef.current = false;
      setFormEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, user]);

  const { data: myTasks } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
  });
  const activeTask = myTasks?.find((t: { document_id: string }) => t.document_id === id);

  const { data: workflowData, isLoading: workflowDataLoading } = useQuery({
    queryKey: ["form-workflow", id],
    queryFn: () => loadWorkflowData(id!, doc?.builder_workflow_phase),
    enabled: !!id && !!doc,
    ...QUERY_SHORT_STALE,
    refetchInterval: (query) => (query.state.data?.isActive ? 15_000 : false),
  });
  const workflowStepsCount = workflowData?.steps?.length ?? 0;

  const { data: auditLogs } = useQuery({
    queryKey: ["form-audit", id, auditPage],
    queryFn: () => documentsAPI.auditTrail(id!, { page: auditPage, page_size: AUDIT_PAGE_SIZE }).then((r) => r.data),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (formEditing && formDirtyRef.current) {
        const shouldSave = window.confirm("You have unsaved changes in the form. Save them before submitting?");
        if (shouldSave) {
          const missing = requiredFieldLabels(formData?.sections ?? [], formValues, {
            groupNames: user?.group_names ?? [],
            isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
            canEditConditionalSections: canEditConditionalSections(),
          }, formProcessStep());
          if (missing.length) {
            setMissingFields(missing);
            toast.error(`${missing.length} required field${missing.length === 1 ? "" : "s"} still need${missing.length === 1 ? "s" : ""} attention.`);
            throw new Error("Form validation failed");
          }
          setMissingFields([]);
          await updateFormMutation.mutateAsync();
        }
      }
      return documentsAPI.submit(id!);
    },
    onSuccess: () => {
      toast.success("Submitted for approval");
      setFormEditing(false);
      formDirtyRef.current = false;
      qc.invalidateQueries({ queryKey: ["form", id] });
      qc.invalidateQueries({ queryKey: ["form-workflow", id] });
      qc.invalidateQueries({ queryKey: ["forms"] });
    },
    onError: (err) => toast.error(extractApiError(err, "Submission failed")),
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
        <Link to="/forms" className="mt-6 inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#246d9c]">
          <ArrowLeft className="h-4 w-4" /> Back to Forms
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
          <Link to="/forms" className="inline-flex items-center gap-2 border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F5F7F8]">
            Back to Forms
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
  const canComment = hasAdminAccess || (doc.permissions ?? []).includes("comment");
  const canApprove = hasAdminAccess || (doc.permissions ?? []).includes("approve");
  const hasConditionalEditability = formHasConditionalEditability(formData.sections);

  function formProcessStep() {
    return doc.builder_process_step || doc.status;
  }
  function canEditConditionalSections() {
    return hasAdminAccess || isOwnerOrSubmitter;
  }

  const step = formProcessStep();
  const isRequestApproved = step === "request_approved" || (!doc.builder_process_step && doc.status === "approved");
  const canEditForm = canEdit
    && !isApprovalLockedStatus(step)
    && !isFinalFormProcessStep(step)
    && (doc.status !== "approved" || (isRequestApproved && hasConditionalEditability && canEditConditionalSections()));

  const budgetEnabled = Boolean(doc.metadata?.sunsystems?.budget?.enabled);
  const journalEnabled = Boolean(doc.metadata?.sunsystems?.journal?.enabled);
  const journalStages = doc.metadata?.sunsystems?.journal?.stages as Array<{ stage: number; enabled?: boolean }> | undefined;
  const availableStages = journalStages?.filter((s) => s.enabled !== false).map((s) => s.stage).sort((a, b) => a - b) || [1];

  const isRetirementPhase = doc.builder_workflow_phase === "retirement";
  const isRetirementFinalized = isRetirementPhase && isFinalFormProcessStep(step);
  const canSubmitRequest = ["draft", "returned"].includes(doc.status) && (!isRetirementPhase || doc.status === "returned") && (canApprove || isOwnerOrSubmitter);
  // Only allow retirement submission if template has multiple stages configured (Stage 2 exists)
  const hasRetirementStage = availableStages.includes(2);
  const canSubmitRetirement = Boolean(doc.can_submit_retirement) && !isRetirementFinalized && hasRetirementStage && (canApprove || isOwnerOrSubmitter);
  const canSubmit = canSubmitRequest || canSubmitRetirement;
  const submitLabel = canSubmitRetirement ? "Submit retirement" : doc.status === "returned" ? "Resubmit" : "Start workflow";

  const startFormEdit = () => {
    setFormValues({ ...(formData.values ?? {}) });
    formDirtyRef.current = false;
    setFormEditing(true);
  };
  const saveForm = () => {
    const missing = requiredFieldLabels(formData.sections ?? [], formValues, {
      groupNames: user?.group_names ?? [],
      isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
      canEditConditionalSections: canEditConditionalSections(),
    }, step);
    if (missing.length) {
      setMissingFields(missing);
      toast.error(`${missing.length} required field${missing.length === 1 ? "" : "s"} still need${missing.length === 1 ? "s" : ""} attention.`);
      return;
    }
    setMissingFields([]);
    updateFormMutation.mutate();
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
    <div className="flex flex-1 flex-col bg-[#F5F7F8] text-[#1F2933]">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[#1E6F99] bg-[#287EAD] px-5 text-white">
        <button onClick={() => navigate("/forms")} className="flex h-9 items-center gap-1 border border-white/20 bg-white/10 px-3 text-xs text-white/85 hover:text-white">
          <ArrowLeft className="h-3.5 w-3.5" /> Forms
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
        {canSubmit && (
          <button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending}
            className="flex h-9 items-center gap-1.5 border border-white/20 bg-white/10 px-3 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-50">
            {submitMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {submitLabel}
          </button>
        )}
      </div>

      <div className={cn(
        "scrollbar-minimal relative grid min-h-0 flex-1 grid-cols-1 items-start gap-4 overflow-y-auto p-4 lg:grid-cols-12",
        activeTask && "pb-24",
        detailsOpen ? "pr-8" : "pr-12",
      )}>

        {/* Details-panel toggle — pinned to the right edge */}
        <button
          type="button"
          onClick={() => setDetailsOpen((o) => !o)}
          title={detailsOpen ? "Hide details panel" : "Show details panel"}
          className="absolute right-0 top-0 z-20 flex h-10 w-10 items-center justify-center border-l border-b border-[#C8CDD2] bg-white text-[#5E6870] hover:bg-[#EEF6FB] hover:text-[#287EAD] transition-colors"
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
          <div className="border border-[#C8CDD2] bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-sm font-bold text-[#1F2933]">Form</p>
                <span className="text-xs text-[#5E6870]">
                  {formEditing ? (formDirtyRef.current ? "Editing — unsaved changes" : "Editing — fill and save") : canSubmitRetirement ? "Retirement stage — fill expenditure, then submit" : canEditForm ? "Click Edit form to modify" : "Filled in-app"}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {journalEnabled && (
                  <button type="button" onClick={() => setShowJournalXml((s) => !s)}
                    className={cn(
                      "inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F3F5F6]",
                      showJournalXml && "bg-[#EEF6FB] text-[#287EAD] border-[#287EAD]/50",
                    )}>
                    <FileCode className="h-3.5 w-3.5" /> Journal XML
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
              {missingFields.length > 0 && formEditing && (
                <div className="border border-red-200 bg-red-50 px-4 py-3">
                  <p className="flex items-center gap-2 text-xs font-bold text-red-800">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {missingFields.length} required field{missingFields.length === 1 ? "" : "s"} to complete
                  </p>
                  <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-red-800">
                    {missingFields.map((m) => <li key={m} className="list-inside list-disc">{m}</li>)}
                  </ul>
                </div>
              )}
              {budgetEnabled && formEditing && (
                <BudgetBanner values={formValues} documentId={doc.id} sections={formData.sections ?? []} enabled />
              )}
              <TemplateForm
                sections={formData.sections ?? []}
                values={formEditing ? formValues : (formData.values ?? {})}
                onChange={(k, v) => { formDirtyRef.current = true; setFormValues((prev) => ({ ...prev, [k]: v })); }}
                readOnly={!formEditing}
                documentId={doc.id}
                documentStatus={step}
                canEditConditionalSections={canEditConditionalSections()}
              />
            </div>
          </div>

          {showJournalXml && (
            <JournalPayloadModal
              documentId={doc.id}
              values={formEditing ? formValues : undefined}
              title={doc.title}
              availableStages={availableStages}
              onClose={() => setShowJournalXml(false)}
            />
          )}

          {(isWorkflowActiveOrCompleted(step) || journalEnabled) && (
            <div className={cn("grid gap-3", isWorkflowActiveOrCompleted(step) && journalEnabled ? "lg:grid-cols-2" : "")}>
              {isWorkflowActiveOrCompleted(step) && (
                <ApprovalStagesTable steps={workflowData?.steps ?? []} isLoading={workflowDataLoading} phase={doc.builder_workflow_phase} />
              )}
              <JournalPostingCard
                documentId={doc.id}
                expectPosting={journalEnabled && ["request_approved", "fully_approved"].includes(step)}
                watchKey={`${step}:${doc.updated_at}`}
                availableStages={availableStages}
              />
            </div>
          )}

        </div>

        {/* Side column — tabs (only shown when detailsOpen is true) */}
        {detailsOpen && (
          <div className="space-y-3 lg:col-span-4">
            <div className="border-b border-[#C8CDD2] bg-white px-3 pt-2">
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

            <div className="min-h-[24rem] border border-[#C8CDD2] bg-white p-4 shadow-sm">
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
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-[#C8CDD2] bg-white/95 backdrop-blur-sm">
          <Suspense fallback={<div className="px-4 py-3 text-xs text-[#5E6870]">Loading actions...</div>}>
            <WorkflowActionPanel
              task={activeTask}
              documentId={id!}
              variant="bar"
              onCompleted={() => setWorkflowActionCompleted(true)}
            />
          </Suspense>
        </div>
      )}

      {workflowActionCompleted && !activeTask && (
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
                onClick={() => navigate(-1)}
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