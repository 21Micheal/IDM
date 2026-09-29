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
import { templatesAPI, documentsAPI } from "@/services/api";
import TemplateForm, { requiredFieldLabels } from "@/components/templates/TemplateForm";
import { collectFormAttachments } from "@/components/templates/formAttachments";
import { toast } from "@/components/ui/vault-toast";
import { cn } from "@/lib/utils";
import {
  Loader2, ArrowLeft, FileText, CheckCircle2,
  AlertCircle, RefreshCw, Sparkles, ChevronDown, ClipboardList,
} from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import { applyFormulasAndDefaults, evaluateDynamicFormula } from "@/components/templates/formulas";
import SignaturePlacementModal, {
  FormTargetField,
  SignaturePlacementResult,
} from "@/components/signatures/SignaturePlacementModal";

export default function NewRequisitionPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
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
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

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
      const res = await templatesAPI.list({ type: "built" });
      const all = res.data?.results || res.data || [];
      return Array.isArray(all)
        ? all.filter(
            (t: any) =>
              t.name?.toLowerCase().includes("requisition") ||
              t.document_type_name?.toLowerCase().includes("requisition")
          )
        : [];
    },
    ...QUERY_SHORT_STALE,
  });

  // Fetch selected template with 30s polling so live editor updates arrive automatically
  const { data: selectedTemplate, isLoading: loadingTemplate, isFetching: refreshingTemplate } = useQuery({
    queryKey: ["template", selectedTemplateId],
    queryFn: () => templatesAPI.get(selectedTemplateId!).then((r) => r.data),
    enabled: !!selectedTemplateId,
    ...QUERY_SHORT_STALE,
    refetchInterval: 30_000,
  });

  // Auto-select first requisition template if not set
  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0 && !preselectedTemplateId) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [templates, selectedTemplateId, preselectedTemplateId]);

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
  const handleFieldChange = (key: string, value: unknown) => {
    setFormDirty(true);
    setFormValues((prev) => {
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
    mutationFn: async () => {
      if (!selectedTemplateId) throw new Error("No template selected");
      const missing = requiredFieldLabels(
        selectedTemplate?.sections ?? [],
        formValues,
        {
          groupNames: user?.group_names ?? [],
          isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
          canEditConditionalSections: true,
        },
        "draft"
      );
      if (missing.length) {
        setMissingFields(missing);
        toast.error(`${missing.length} required field${missing.length === 1 ? "" : "s"} need${missing.length === 1 ? "s" : ""} attention.`);
        throw new Error("Form validation failed");
      }
      setMissingFields([]);
      const { jsonValues, attachments } = collectFormAttachments(formValues);
      const payload = {
        template_id: selectedTemplateId,
        output_format: "pdf" as const,
        values: jsonValues,
        title: (jsonValues.title as string) || (selectedTemplate?.name ? `Requisition — ${selectedTemplate.name}` : "Requisition"),
        document_type_id: selectedTemplate?.document_type_id,
        draft_from_template: true,
        attachments,
      };
      return templatesAPI.fillTemplateWithAttachments(payload);
    },
    onSuccess: (res) => {
      toast.success("Requisition draft saved successfully");
      setFormDirty(false);
      const docId = res.data?.id || res.data?.document_id;
      navigate(docId ? `/${docId}` : "/list");
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail || "Failed to save draft");
    },
  });

  // Submit mutation
  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTemplateId) throw new Error("No template selected");
      const missing = requiredFieldLabels(
        selectedTemplate?.sections ?? [],
        formValues,
        {
          groupNames: user?.group_names ?? [],
          isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
          canEditConditionalSections: true,
        },
        "submit"
      );
      if (missing.length) {
        setMissingFields(missing);
        toast.error(`${missing.length} required field${missing.length === 1 ? "" : "s"} still need${missing.length === 1 ? "s" : ""} attention.`);
        throw new Error("Form validation failed");
      }
      setMissingFields([]);
      const { jsonValues, attachments } = collectFormAttachments(formValues);
      const payload = {
        template_id: selectedTemplateId,
        output_format: "pdf" as const,
        values: jsonValues,
        title: (jsonValues.title as string) || (selectedTemplate?.name ? `Requisition — ${selectedTemplate.name}` : "Requisition"),
        document_type_id: selectedTemplate?.document_type_id,
        draft_from_template: false,
        attachments,
      };
      const res = await templatesAPI.fillTemplateWithAttachments(payload);
      const docId = res.data?.id || res.data?.document_id;
      if (docId) return documentsAPI.submit(docId, { workflow_stage: "requisition" });
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
      toast.error(err?.response?.data?.detail || "Failed to submit requisition");
    },
  });

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
      <div className="flex h-screen items-center justify-center bg-[#F0F2F5]">
        <Loader2 className="h-8 w-8 animate-spin text-[#287EAD]" />
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#F0F2F5] p-6">
        <div className="w-full max-w-md border border-[#C8CDD2] bg-white p-8 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-amber-50">
              <FileText className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <h2 className="text-base font-bold text-[#1F2933]">No Requisition Templates Found</h2>
              <p className="mt-1.5 text-sm text-[#5E6870]">
                Create a requisition form template in your Form Builder to get started.
              </p>
            </div>
          </div>
          <button
            onClick={() => navigate("/forms/new/builder")}
            className="mt-6 inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99]"
          >
            <FileText className="h-4 w-4" /> Open Form Builder
          </button>
        </div>
      </div>
    );
  }

  const isSubmitting = submitMutation.isPending;
  const isSavingDraft = saveDraftMutation.isPending;

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#F0F2F5] pb-20">

      {/* ── Top Navigation Bar ── */}
      <div className="sticky top-0 z-30 border-b border-[#D9DDE2] bg-white shadow-sm">
        <div className="flex w-full items-center justify-between gap-4 px-6 py-3">

          {/* Left: back button */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => {
                if (formDirty && !window.confirm("Discard unsaved changes?")) return;
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
                <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
                Draft
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
                          setSelectedTemplateId(t.id);
                          setTemplatePickerOpen(false);
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
      <div className="px-6 pt-6 pb-4">

        {/* Missing fields banner */}
        {missingFields.length > 0 && (
          <div className="mb-4 border border-amber-300 bg-amber-50 p-4">
            <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              Please complete the following required fields before submitting:
            </div>
            <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs text-amber-800">
              {missingFields.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}

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
              sections={selectedTemplate.sections ?? []}
              values={formValues}
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

      {/* ── Floating Action Buttons (fixed bottom-right, no panel) ── */}
      {selectedTemplate && !loadingTemplate && (
        <div className="fixed bottom-6 right-6 z-40 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (formDirty && !window.confirm("Discard changes and return to list?")) return;
              navigate("/list");
            }}
            className="h-9 border border-[#C8CDD2] bg-white px-4 text-sm font-medium text-[#1F2933] shadow-md hover:bg-[#F5F7F8] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => saveDraftMutation.mutate()}
            disabled={isSavingDraft}
            className="inline-flex h-9 items-center gap-1.5 border border-[#287EAD] bg-white px-4 text-sm font-semibold text-[#287EAD] shadow-md hover:bg-[#EEF6FB] disabled:opacity-50 transition-colors"
          >
            {isSavingDraft && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save Draft
          </button>
          <button
            type="button"
            onClick={() => submitMutation.mutate()}
            disabled={isSubmitting}
            className="inline-flex h-9 items-center gap-1.5 bg-[#287EAD] px-5 text-sm font-semibold text-white shadow-md hover:bg-[#1E6F99] disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Submit Requisition
          </button>
        </div>
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
          }}
          onConfirm={(result) => {
            if (result.formFieldValues && Object.keys(result.formFieldValues).length > 0) {
              handleApplySignature(result.formFieldValues, result);
            } else if (result.signatureImage && targetSignatureField) {
              handleApplySignature({ [targetSignatureField]: result.signatureImage }, result);
            }
            setIsSigningOpen(false);
            setTargetSignatureField(null);
          }}
          onApplyToForm={(fields, rawResult) => {
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