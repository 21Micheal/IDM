/**
 * NewRequisitionPage.tsx
 *
 * Dedicated requisition creation flow using dynamic form templates.
 *
 * Upgraded capabilities:
 *   • Live syncing with template builder (polls every 30s) while preserving typed values.
 *   • Full formula engine support: built-ins (current_user, today, now), regex conditions,
 *     IF logic (e.g. IF([amount] > 50000, "Capex", "Opex")), and arithmetic calculations.
 *   • Live Infor SunSystems budget checks via integrated BudgetBanner.
 *   • Direct in-form signature application with SignaturePlacementModal: users can apply
 *     their saved or freshly drawn signature, date (EAT), and text directly to the form fields.
 *   • Form renderer restyled to match the builder preview — document-width card, tinted section
 *     header strip, sticky bottom action bar with live unsaved-changes indicator.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { extractApiError } from "@/lib/apiError";
import { templatesAPI, documentsAPI, authAPI, profileAPI } from "@/services/api";
import TemplateForm, { pastDateFieldLabels, requiredFieldLabels } from "@/components/templates/TemplateForm";
import TravelPolicyNoticeModal from "@/components/templates/TravelPolicyNoticeModal";
import { useFormDraftAutosave } from "@/hooks/useFormDraftAutosave";
import { toast } from "@/components/ui/vault-toast";
import { cn } from "@/lib/utils";
import {
  Loader2, ArrowLeft, FileText, CheckCircle2, Trash2,
  RefreshCw, Sparkles, ChevronDown, ClipboardList, Info,
} from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import { applyFormulasAndDefaults, evaluateDynamicFormula } from "@/components/templates/formulas";
import { requisitionStartDate } from "@/lib/requisitionDates";
import SignaturePlacementModal, {
  FormTargetField,
  SignaturePlacementResult,
} from "@/components/signatures/SignaturePlacementModal";

function hasReceivedBySignature(values: Record<string, unknown>, sections: unknown) {
  const matchingKeys = new Set<string>();
  const collectFields = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collectFields);
    else if (value && typeof value === "object") {
      const field = value as Record<string, unknown>;
      const key = String(field.key ?? field.id ?? "").toLowerCase();
      const label = String(field.label ?? field.name ?? "").toLowerCase();
      if ((String(field.type ?? "").toLowerCase().includes("signature") || label.includes("signature"))
        && key && /(received|requisitioner|requester)/i.test(`${key} ${label}`)) matchingKeys.add(key);
      Object.values(field).forEach(collectFields);
    }
  };
  collectFields(sections);
  const visit = (value: unknown, path = ""): boolean => {
    if (Array.isArray(value)) return value.some((item, index) => visit(item, `${path}.${index}`));
    if (!value || typeof value !== "object") return false;
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
      const nextPath = `${path}.${key}`.toLowerCase();
      const matchingKey = [...matchingKeys].some((fieldKey) => nextPath.endsWith(`.${fieldKey}`));
      const roleMatches = /(received|requisitioner|requester)/i.test(nextPath) || matchingKey;
      if (roleMatches && nextPath.includes("signature") || (roleMatches && matchingKey)) {
        if (typeof child === "string" && child.startsWith("data:image/")) return true;
      }
      return visit(child, nextPath);
    });
  };
  return visit(values);
}

export default function NewRequisitionPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [searchParams] = useSearchParams();
  const preselectedTemplateId = searchParams.get("template_id");
  const supplierCode = searchParams.get("supplier_code");

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(preselectedTemplateId || null);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const supplierPrefillRef = useRef<string | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const [isSigningOpen, setIsSigningOpen] = useState(false);
  const [targetSignatureField, setTargetSignatureField] = useState<string | null>(null);
  const [pendingSubmitForSignature, setPendingSubmitForSignature] = useState<boolean | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [formInstanceKey, setFormInstanceKey] = useState(0);
  const [isClearingDraft, setIsClearingDraft] = useState(false);
  const [duplicateDateNotice, setDuplicateDateNotice] = useState<{
    travel_date: string;
    matches: Array<{ reference_number: string; date: string }>;
  } | null>(null);
  const [travelPolicyNotice, setTravelPolicyNotice] = useState<string | null>(null);
  const duplicateNoticeDismissedDate = useRef("");
  const duplicateNoticeObservedDate = useRef("");
  const dismissDuplicateNoticeForFeedback = () => {
    if (duplicateDateNotice?.travel_date) {
      duplicateNoticeDismissedDate.current = duplicateDateNotice.travel_date;
    }
    setDuplicateDateNotice(null);
  };

  // Refresh the signed-in user's profile before applying current-user formulas.
  // The persisted auth store can predate newly added profile fields, so relying
  // on it alone can leave those formula fields blank until a later session sync.
  const { data: freshUser } = useQuery({
    queryKey: ["auth", "me", "requisition", user?.id],
    queryFn: () => authAPI.me().then((response) => response.data),
    enabled: Boolean(user?.id),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  const { data: savedProfileSignature, isLoading: profileSignatureLoading } = useQuery({
    queryKey: ["profile-signature"],
    queryFn: () => profileAPI.getSignature().then((response) => response.data.signature ?? null),
    enabled: Boolean(user?.id),
  });
  const activeProfileSignature = (savedProfileSignature as any)?.signature ?? savedProfileSignature;

  useEffect(() => {
    if (freshUser) setUser(freshUser);
  }, [freshUser, setUser]);

  // Formula evaluation context
  const formulaContext = useMemo(
    () => ({
      user,
      now: new Date(),
      values: formValues,
    }),
    [user, formValues]
  );
  void formulaContext;

  // Fetch requisition templates
  const { data: templates = [], isLoading: loadingTemplates } = useQuery({
    queryKey: ["templates", "requisition-forms"],
    queryFn: async () => {
      const res = await templatesAPI.list({ type: "built", requisition_forms: true });
      const all = res.data?.results || res.data || [];
      return Array.isArray(all)
        ? all
        : [];
    },
    ...QUERY_SHORT_STALE,
    refetchOnMount: "always",
  });

  // Fetch selected template with 30s polling so live editor updates arrive automatically
  const { data: selectedTemplate, isLoading: loadingTemplate, isFetching: refreshingTemplate } = useQuery({
    queryKey: ["template", selectedTemplateId],
    queryFn: () => templatesAPI.get(selectedTemplateId!).then((r) => r.data),
    enabled: !!selectedTemplateId && templates.some((template: any) => template.id === selectedTemplateId),
    ...QUERY_SHORT_STALE,
    refetchInterval: 30_000,
  });

  const duplicateTravelDate = selectedTemplate
    ? requisitionStartDate(selectedTemplate.sections ?? [], formValues, selectedTemplate.travel_start_date_field)
    : "";
  const autosave = useFormDraftAutosave({
    enabled: Boolean(selectedTemplateId && selectedTemplate),
    dirty: formDirty,
    templateId: selectedTemplateId,
    documentTypeId: selectedTemplate?.document_type_id,
    title: String(formValues.title || (selectedTemplate?.name ? `Requisition — ${selectedTemplate.name}` : "Requisition")),
    values: formValues,
    requisitionSubmission: true,
    onCreated: () => {
      void qc.invalidateQueries({ queryKey: ["documents"] });
      void qc.invalidateQueries({ queryKey: ["requisitions"] });
    },
    onSaved: () => {
      setFormDirty(false);
      void qc.invalidateQueries({ queryKey: ["documents"] });
      void qc.invalidateQueries({ queryKey: ["requisitions"] });
    },
  });

  const { data: duplicateCheck } = useQuery({
    queryKey: ["requisition-travel-date-duplicate", selectedTemplateId, autosave.documentId, duplicateTravelDate],
    queryFn: () => documentsAPI.checkRequisitionDuplicateForTemplate(
      selectedTemplateId!,
      formValues,
      autosave.documentId ?? undefined,
    ).then((response) => response.data),
    enabled: Boolean(
      selectedTemplateId
      && duplicateTravelDate
      && String(selectedTemplate?.workflow_type || "requisition").toLowerCase() === "requisition"
    ),
    staleTime: 0,
  });

  useEffect(() => {
    if (duplicateNoticeObservedDate.current !== duplicateTravelDate) {
      duplicateNoticeObservedDate.current = duplicateTravelDate;
      duplicateNoticeDismissedDate.current = "";
      setDuplicateDateNotice(null);
    }
    const currentDateCheck = duplicateCheck?.travel_date === duplicateTravelDate ? duplicateCheck : null;
    if (
      currentDateCheck?.exists
      && currentDateCheck.travel_date
      && duplicateNoticeDismissedDate.current !== currentDateCheck.travel_date
    ) {
      setDuplicateDateNotice(currentDateCheck);
    }
  }, [duplicateTravelDate, duplicateCheck]);

  // Auto-select first requisition template if not set
  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0 && !preselectedTemplateId) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [templates, selectedTemplateId, preselectedTemplateId]);

  useEffect(() => {
    if (!preselectedTemplateId || loadingTemplates || templates.some((template: any) => template.id === preselectedTemplateId)) return;
    setSelectedTemplateId(templates[0]?.id ?? null);
  }, [templates, preselectedTemplateId, loadingTemplates]);

  useEffect(() => {
    if (!loadingTemplates && selectedTemplateId && !templates.some((template: any) => template.id === selectedTemplateId)) {
      setSelectedTemplateId(templates[0]?.id ?? null);
      setFormValues({});
      setFormDirty(false);
      setMissingFields([]);
    }
  }, [templates, selectedTemplateId, loadingTemplates]);

  const selectTemplate = async (templateId: string) => {
    if (templateId === selectedTemplateId) {
      setTemplatePickerOpen(false);
      return;
    }
    setDuplicateDateNotice(null);
    duplicateNoticeDismissedDate.current = "";
    duplicateNoticeObservedDate.current = "";
    if (formDirty) {
      try {
        await autosave.saveNow(true);
      } catch {
        toast.error("Could not save this requisition before switching templates.");
        return;
      }
    }
    setSelectedTemplateId(templateId);
    setFormValues({});
    setFormDirty(false);
    setMissingFields([]);
    supplierPrefillRef.current = null;
    setTemplatePickerOpen(false);
  };

  // Apply schema defaults and dynamic formulas (IF, regex, math) when template loads or updates
  // while preserving fields the user has already touched ("surviving updates").
  useEffect(() => {
    if (!selectedTemplate?.sections) return;
    setFormValues((prevValues) => {
      const merged = applyFormulasAndDefaults(
        selectedTemplate.sections,
        prevValues,
        { user, now: new Date(), values: prevValues },
        { preserveUserValues: true }
      );
      return merged;
    });
  }, [selectedTemplate?.sections, user]);

  // Supplier directory links carry the selected SunSystems code. Apply it to
  // the template's supplier account picker once per template/code pair.
  useEffect(() => {
    if (!supplierCode || !selectedTemplate?.sections) return;
    const prefillKey = `${selectedTemplateId}:${supplierCode}`;
    if (supplierPrefillRef.current === prefillKey) return;

    const supplierFields = (selectedTemplate.sections as Array<{ fields?: Array<Record<string, any>> }>)
      .flatMap((section) => section.fields ?? [])
      .filter((field) => field.type === "sunsystems_account" && (field.key || field.id));
    if (supplierFields.length === 0) {
      supplierPrefillRef.current = prefillKey;
      toast.info("This template has no supplier field to pre-fill.");
      return;
    }

    supplierPrefillRef.current = prefillKey;
    setFormValues((prev) => {
      const next = { ...prev };
      for (const field of supplierFields) {
        const key = field.key ?? field.id;
        if (!key) continue;
        next[key] = field.multi === false ? supplierCode : [supplierCode];
      }
      return next;
    });
  }, [selectedTemplate?.sections, selectedTemplateId, supplierCode]);

  // Recalculate dynamic formulas whenever a field changes
  const handleFieldChange = (key: string, value: unknown, meta?: { isInternal?: boolean }) => {
    if (!meta?.isInternal) {
      setFormDirty(true);
    }
    setFormValues((prev) => {
      if (JSON.stringify(prev[key]) === JSON.stringify(value)) return prev;
      const nextValues = { ...prev, [key]: value };
      if (!selectedTemplate?.sections) return nextValues;
      const secList = (selectedTemplate.sections ?? []) as Array<{ fields?: Array<Record<string, any>> }>;
      for (const s of secList) {
        for (const f of s.fields ?? []) {
          const fKey = f.key ?? f.id;
          if (!fKey || fKey === key) continue;
          const formula = f.formula || f.calculation;
          if (formula && (formula.startsWith("=") || formula.toUpperCase().includes("IF("))) {
            const recomputed = evaluateDynamicFormula(formula, nextValues, { user, values: nextValues });
            if (recomputed !== undefined && recomputed !== "") {
              nextValues[fKey] = recomputed;
            }
          }
        }
      }
      return nextValues;
    });
  };

  // Inspect template schema for signature and date fields
  const detectedFormFields: FormTargetField[] = useMemo(() => {
    const list: FormTargetField[] = [];
    const secList = (selectedTemplate?.sections ?? []) as Array<{ fields?: Array<Record<string, any>> }>;
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
  }, [selectedTemplate]);

  // Save Draft mutation
  const saveDraftMutation = useMutation({
    mutationFn: () => autosave.finalizeNow(),
    onSuccess: (docId) => {
      toast.success("Requisition draft saved successfully");
      setFormDirty(false);
      navigate(docId ? `/${docId}` : "/list");
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || "Failed to save draft");
    },
  });

  const clearDraft = async () => {
    if (!window.confirm("Delete this requisition draft? It will be moved to Trash.")) return;
    setIsClearingDraft(true);
    try {
      const deletedId = await autosave.discardDraft();
      setFormDirty(false);
      setMissingFields([]);
      supplierPrefillRef.current = null;
      if (deletedId) {
        qc.setQueryData(["requisitions", "pool"], (current: any) => current
          ? { ...current, results: (current.results ?? []).filter((doc: any) => String(doc.id) !== String(deletedId)) }
          : current);
      }
      void qc.invalidateQueries({ queryKey: ["documents"] });
      void qc.invalidateQueries({ queryKey: ["requisitions"] });
      void qc.invalidateQueries({ queryKey: ["requisitions", "pool"] });
      void qc.invalidateQueries({ queryKey: ["trash"] });
      if (deletedId) {
        toast.success("Draft deleted and moved to Trash.");
      } else {
        toast.success("Draft discarded.");
      }
      navigate("/list");
    } catch {
      toast.error("Could not delete this draft.");
    } finally {
      setIsClearingDraft(false);
    }
  };

  // Submit mutation
  const submitMutation = useMutation<any, Error, boolean | void>({
    mutationFn: async (allowUnreconciledRetirement = false) => {
      if (!selectedTemplateId) throw new Error("No template selected");
      // New requisitions are still in the draft process step — using "submit"
      // here skipped any column/field with draft-only editableWhen rules, so
      // mandatory table columns never warned.
      const missing = requiredFieldLabels(
        selectedTemplate?.sections ?? [],
        formValues,
        {
          groupNames: user?.group_names ?? [],
          isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
          canEditConditionalSections: true,
        },
        "draft",
      );
      const pastDates = pastDateFieldLabels(selectedTemplate?.sections ?? [], formValues, {
        groupNames: user?.group_names ?? [],
        isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
        canEditConditionalSections: true,
      }, "draft");
      if (missing.length || pastDates.length) {
        dismissDuplicateNoticeForFeedback();
        setMissingFields([...missing, ...pastDates.map((field) => `Past date: ${field}`)]);
        toast.error(
          `${missing.length + pastDates.length} required field${missing.length + pastDates.length === 1 ? "" : "s"} need${missing.length + pastDates.length === 1 ? "s" : ""} attention.`,
        );
        throw new Error("FORM_REQUIRED_FIELDS");
      }
      setMissingFields([]);
      if (duplicateTravelDate) {
        const duplicateResponse = await documentsAPI.checkRequisitionDuplicateForTemplate(
          selectedTemplateId,
          formValues,
          autosave.documentId ?? undefined,
        );
        if (duplicateResponse.data.exists) {
          setTravelPolicyNotice(null);
          setDuplicateDateNotice(duplicateResponse.data);
          throw new Error("DUPLICATE_REQUISITION_TRAVEL_DATE");
        }
      }
      const docId = await autosave.finalizeNow();
      if (docId) return documentsAPI.submit(docId, {
        workflow_stage: "requisition",
        ...(allowUnreconciledRetirement ? { allow_unreconciled_retirement: true } : {}),
      });
      throw new Error("Failed to initialize requisition document");
    },
    onSuccess: () => {
      toast.success("Requisition submitted for approval workflow");
      setFormDirty(false);
      qc.invalidateQueries({ queryKey: ["templates"] });
      qc.invalidateQueries({ queryKey: ["documents"] });
      navigate("/list");
    },
    onError: (err: any) => {
      if (err?.message === "FORM_REQUIRED_FIELDS" || err?.message === "DUPLICATE_REQUISITION_TRAVEL_DATE") return;
      if (err?.response?.data?.code === "overdue_retirement_policy") {
        setDuplicateDateNotice(null);
        setTravelPolicyNotice(String(err.response.data.detail || "Reconciliation for an earlier requisition is still outstanding. Reconcile that requisition before raising another one."));
        return;
      }
      if (err?.response?.data?.code === "duplicate_requisition_travel_date") {
        setTravelPolicyNotice(null);
        setDuplicateDateNotice({
          travel_date: String(err.response.data.travel_date || duplicateTravelDate || ""),
          matches: Array.isArray(err.response.data.matches) ? err.response.data.matches : [],
        });
        return;
      }
      dismissDuplicateNoticeForFeedback();
      const message = extractApiError(err, "Failed to submit requisition");
      if (/required fields missing/i.test(message)) {
        const fieldList = message.split(/required fields missing:\s*/i)[1];
        setMissingFields(fieldList ? fieldList.split(/,\s*/) : [message]);
        return;
      }
      toast.error(message);
    },
  });

  const hasImprestRequestPosting = (selectedTemplate?.sunsystems?.journal?.stages ?? []).some((stage: any) => {
    const number = Number(stage?.stage ?? stage?.stage_number ?? 0);
    return stage?.enabled !== false && number >= 20000 && number < 30000;
  });
  const requestRequisitionSubmit = (allowUnreconciledRetirement = false) => {
    if (hasImprestRequestPosting && profileSignatureLoading) {
      toast.info("Checking your saved signature. Please try again in a moment.");
      return;
    }
    if (
      hasImprestRequestPosting
      && !activeProfileSignature?.image_data
      && !hasReceivedBySignature(formValues, selectedTemplate?.sections)
    ) {
      setPendingSubmitForSignature(allowUnreconciledRetirement);
      const receivedSignatureField = detectedFormFields.find((field) =>
        field.kind === "signature" && /(received|requisitioner|requester)/i.test(field.key),
      );
      setTargetSignatureField(receivedSignatureField?.key ?? null);
      setIsSigningOpen(true);
      return;
    }
    submitMutation.mutate(allowUnreconciledRetirement);
  };

  // Handle direct signature injection into form values
  const handleApplySignature = (fieldValues: Record<string, unknown>, result: SignaturePlacementResult) => {
    setFormValues((prev) => {
      const next = { ...prev, ...fieldValues };
      if (result.signatureImage && !Object.keys(fieldValues).some((k) => /signature/i.test(k))) {
        next["signature"] = result.signatureImage;
      }
      return next;
    });
    setFormDirty(true);
    setIsSigningOpen(false);
    toast.success("Signature and date stamp applied to requisition form.");
  };

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loadingTemplates) {
    return (
      <div className="flex h-full items-center justify-center bg-[#F0F2F5]">
        <Loader2 className="h-8 w-8 animate-spin text-[#287EAD]" />
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-[#F0F2F5] p-6">
        <div className="w-full max-w-md border border-[#C8CDD2] bg-white p-8 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-amber-50">
              <FileText className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <h2 className="text-base font-bold text-[#1F2933]">No Requisition Forms Assigned</h2>
              <p className="mt-1.5 text-sm text-[#5E6870]">
                Ask an administrator to assign a requisition form to one of your groups.
              </p>
            </div>
          </div>
          <button
            onClick={() => navigate(-1)}
            className="mt-6 inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99]"
          >
            <ArrowLeft className="h-4 w-4" /> Go back
          </button>
        </div>
      </div>
    );
  }

  const isSubmitting = submitMutation.isPending;
  const isSavingDraft = saveDraftMutation.isPending;

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-full flex-col bg-[#F0F2F5]">

      {/* ── Top Navigation Bar ── */}
      <div className="sticky top-0 z-10 border-b border-[#D9DDE2] bg-white shadow-sm">
        <div className="flex w-full items-center justify-between gap-4 px-6 py-3">

          {/* Left: back button */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={async () => {
                if (formDirty) {
                  try {
                    await autosave.saveNow(true);
                  } catch {
                    toast.error("Could not save this requisition before leaving.");
                    return;
                  }
                }
                navigate("/list");
              }}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-[#E4E7EB] bg-white text-[#5E6870] hover:bg-[#F5F7F8] hover:text-[#1F2933] transition-colors"
              title="Back to requisitions"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="h-5 w-px flex-shrink-0 bg-[#E4E7EB]" />

            {/* Title area — shows form name when selected, generic title otherwise */}
            <div className="flex items-center gap-2 min-w-0">
              <ClipboardList className="h-4 w-4 flex-shrink-0 text-[#287EAD]" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-sm font-bold text-[#1F2933] truncate">
                    {selectedTemplate ? selectedTemplate.name : "New Requisition"}
                  </h1>
                  {refreshingTemplate && (
                    <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-[#EEF6FB] px-2 py-0.5 text-[10px] font-medium text-[#287EAD]">
                      <RefreshCw className="h-2.5 w-2.5 animate-spin" /> Syncing
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-[#8C969E] truncate">
                  {selectedTemplate
                    ? `Requested by ${user?.first_name ? `${user.first_name} ${user.last_name ?? ""}`.trim() : (user?.email ?? "—")}`
                    : "Fill in all required fields and submit for approval"}
                </p>
              </div>
            </div>
          </div>

          {/* Right: Draft status + template picker */}
          <div className="flex flex-shrink-0 items-center gap-3">
            {selectedTemplate && (
              <span className="inline-flex items-center gap-1.5 rounded border border-[#C8CDD2] bg-[#F5F7F8] px-2.5 py-1 text-[11px] font-semibold text-[#5E6870]">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    autosave.status === "saving"
                      ? "bg-amber-400 animate-pulse"
                      : autosave.status === "saved"
                        ? "bg-emerald-500"
                        : autosave.status === "error"
                          ? "bg-red-500"
                          : "bg-slate-400"
                  )}
                />
                {autosave.status === "saving" || autosave.status === "unsaved"
                  ? "Saving…"
                  : autosave.status === "saved"
                    ? "Draft saved"
                    : autosave.status === "error"
                      ? "Autosave failed"
                      : "Draft"}
              </span>
            )}
            {templates.length > 1 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setTemplatePickerOpen((o) => !o)}
                  className="flex h-8 items-center gap-2 rounded-lg border border-[#E4E7EB] bg-white px-3 text-xs font-medium text-[#1F2933] hover:bg-[#F5F7F8] transition-colors"
                >
                  <FileText className="h-3.5 w-3.5 text-[#287EAD]" />
                  <span className="max-w-[160px] truncate">{selectedTemplate?.name || "Select template"}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-[#5E6870]" />
                </button>
                {templatePickerOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-64 border border-[#D9DDE2] bg-white shadow-lg">
                    {templates.map((t: any) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          selectTemplate(t.id);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-[#F5F7F8]",
                          selectedTemplateId === t.id ? "bg-[#EEF6FB] font-semibold text-[#287EAD]" : "text-[#1F2933]"
                        )}
                      >
                        <FileText className="h-3.5 w-3.5 flex-shrink-0 text-[#287EAD]" />
                        <span className="truncate">{t.name}</span>
                        {selectedTemplateId === t.id && <CheckCircle2 className="ml-auto h-3.5 w-3.5" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

        </div>

      </div>

      {/* ── Main Document Area ── */}
      <div className="flex-1 px-6 pt-6 pb-6">

        {/* ── Document Card ── */}
        {loadingTemplate ? (
          <div className="flex h-64 items-center justify-center border border-[#C8CDD2] bg-white shadow-sm">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-[#287EAD]" />
              <p className="text-xs text-[#5E6870]">Loading form template…</p>
            </div>
          </div>
        ) : selectedTemplate ? (
          <>
            {/* Form sections — detached cards, matching builder preview */}
            <TemplateForm
              key={formInstanceKey}
              sections={selectedTemplate.sections ?? []}
              values={formValues}
              validationIssues={missingFields}
              onChange={handleFieldChange}
              readOnly={false}
              documentId={undefined}
              onLaunchSignatureModal={(fieldKey?: string) => {
                if (fieldKey && typeof fieldKey === "string") {
                  setTargetSignatureField(fieldKey);
                } else {
                  const firstSig = detectedFormFields.find((f) => f.kind === "signature");
                  setTargetSignatureField(firstSig ? firstSig.key : "signature");
                }
                setIsSigningOpen(true);
              }}
            />
          </>
        ) : (
          <div className="flex h-64 items-center justify-center border border-[#C8CDD2] bg-white shadow-sm">
            <div className="flex flex-col items-center gap-3">
              <FileText className="h-8 w-8 text-[#C1C7CD]" />
              <p className="text-sm text-[#5E6870]">Select a requisition template to begin</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Docked Bottom Action Bar ── */}
      {selectedTemplate && !loadingTemplate && (
        <div className="sticky bottom-0 z-20 border-t border-[#D9DDE2] bg-white/95 px-6 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] backdrop-blur">
          <div className="flex w-full items-center justify-end gap-2">
            <button
              type="button"
              onClick={clearDraft}
              disabled={isClearingDraft || isSavingDraft || isSubmitting || (!formDirty && !autosave.documentId)}
              className="inline-flex h-9 items-center gap-1.5 border border-red-300 bg-white px-3 text-sm font-medium text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              {isClearingDraft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete Draft
            </button>
            <button
              type="button"
              onClick={async () => {
                if (formDirty) {
                  try {
                    await autosave.saveNow(true);
                  } catch {
                    toast.error("Could not save this requisition before leaving.");
                    return;
                  }
                }
                navigate("/list");
              }}
              className="h-9 border border-[#C8CDD2] bg-white px-4 text-sm font-medium text-[#1F2933] shadow-sm hover:bg-[#F5F7F8] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => saveDraftMutation.mutate()}
              disabled={isSavingDraft || isClearingDraft}
              className="inline-flex h-9 items-center gap-1.5 border border-[#287EAD] bg-white px-4 text-sm font-semibold text-[#287EAD] shadow-sm hover:bg-[#EEF6FB] disabled:opacity-50 transition-colors"
            >
              {isSavingDraft && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save Draft
            </button>
            <button
              type="button"
              onClick={() => requestRequisitionSubmit()}
              disabled={isSubmitting || isClearingDraft}
              className="inline-flex h-9 items-center gap-1.5 bg-[#287EAD] px-5 text-sm font-semibold text-white shadow-sm hover:bg-[#1E6F99] disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Submit Requisition
            </button>
          </div>
        </div>
      )}

      {duplicateDateNotice?.travel_date === duplicateTravelDate && duplicateTravelDate && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-950/45 px-4 py-6" role="presentation">
          <div role="alertdialog" aria-modal="true" aria-labelledby="duplicate-travel-date-title" className="w-full max-w-md overflow-hidden border border-amber-200 bg-white shadow-2xl">
            <div className="flex items-start gap-4 px-6 pt-6 pb-5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center bg-amber-100 text-amber-700"><Info className="h-5 w-5" aria-hidden="true" /></div>
              <div>
                <h2 id="duplicate-travel-date-title" className="text-base font-semibold text-slate-900">Check the travel start date</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  You already have a requisition starting on <strong className="font-semibold text-slate-800">{duplicateDateNotice.travel_date}</strong>
                  {duplicateDateNotice.matches.length > 0 && <> ({duplicateDateNotice.matches.map((match) => match.reference_number).filter(Boolean).join(", ") || "another requisition"})</>}.
                </p>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">Choose a different travel start date before submitting this requisition.</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-6 py-4">
              <button type="button" onClick={() => {
                duplicateNoticeDismissedDate.current = duplicateDateNotice.travel_date;
                setDuplicateDateNotice(null);
              }} className="border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-100">Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {travelPolicyNotice && (
        <TravelPolicyNoticeModal
          message={travelPolicyNotice}
          onDismiss={() => setTravelPolicyNotice(null)}
          onRaiseAnyway={() => { setTravelPolicyNotice(null); requestRequisitionSubmit(true); }}
          submitting={submitMutation.isPending}
        />
      )}

      {/* ── Signature Placement Modal ── */}
      {isSigningOpen && (
        <SignaturePlacementModal
          mode="form"
          documentTitle={selectedTemplate?.name || "Requisition Authorization"}
          signerName={`${user?.first_name ?? ""} ${user?.last_name ?? ""}`.trim()}
          formFields={detectedFormFields}
          targetFieldKey={targetSignatureField}
          onCancel={() => {
            setIsSigningOpen(false);
            setTargetSignatureField(null);
            setPendingSubmitForSignature(null);
          }}
          onConfirm={(result) => {
            if (pendingSubmitForSignature !== null) {
              const allowUnreconciledRetirement = pendingSubmitForSignature;
              setPendingSubmitForSignature(null);
              setIsSigningOpen(false);
              setTargetSignatureField(null);
              submitMutation.mutate(allowUnreconciledRetirement);
              return;
            }
            if (result.formFieldValues && Object.keys(result.formFieldValues).length > 0) {
              handleApplySignature(result.formFieldValues, result);
            } else if (result.signatureImage && targetSignatureField) {
              handleApplySignature({ [targetSignatureField]: result.signatureImage }, result);
            }
            setIsSigningOpen(false);
            setTargetSignatureField(null);
          }}
          onApplyToForm={(fields, rawResult) => {
            if (pendingSubmitForSignature !== null) return;
            handleApplySignature(fields, rawResult);
            setIsSigningOpen(false);
            setTargetSignatureField(null);
          }}
        />
      )}

      {/* Backdrop to close template picker on outside click */}
      {templatePickerOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setTemplatePickerOpen(false)} />
      )}
    </div>
  );
}
