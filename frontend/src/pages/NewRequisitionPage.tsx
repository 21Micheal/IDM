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
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { templatesAPI, documentsAPI } from "@/services/api";
import TemplateForm, { requiredFieldLabels } from "@/components/templates/TemplateForm";
import BudgetBanner from "@/components/templates/BudgetBanner";
import { collectFormAttachments } from "@/components/templates/formAttachments";
import { toast } from "@/components/ui/vault-toast";
import { cn } from "@/lib/utils";
import {
  Loader2, ArrowLeft, FileText, PenTool, CheckCircle2,
  AlertCircle, RefreshCw, Sparkles
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

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(preselectedTemplateId || null);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [formDirty, setFormDirty] = useState(false);
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const [isSigningOpen, setIsSigningOpen] = useState(false);

  // Formula evaluation context
  const formulaContext = useMemo(
    () => ({
      user,
      now: new Date(),
      values: formValues,
    }),
    [user, formValues]
  );

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

  // Recalculate dynamic formulas whenever a field changes
  const handleFieldChange = (key: string, value: unknown) => {
    setFormDirty(true);
    setFormValues((prev) => {
      const nextValues = { ...prev, [key]: value };
      if (!selectedTemplate?.sections) return nextValues;

      // Recalculate any dependent dynamic formula fields (e.g. IF conditions, regex tests, sums)
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
        output_format: "pdf",
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
      if (docId) {
        navigate(`/${docId}`);
      } else {
        navigate("/list");
      }
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
        output_format: "pdf",
        values: jsonValues,
        title: (jsonValues.title as string) || (selectedTemplate?.name ? `Requisition — ${selectedTemplate.name}` : "Requisition"),
        document_type_id: selectedTemplate?.document_type_id,
        draft_from_template: false,
        attachments,
      };

      const res = await templatesAPI.fillTemplateWithAttachments(payload);
      const docId = res.data?.id || res.data?.document_id;

      if (docId) {
        return documentsAPI.submit(docId);
      }
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
      // Fallback if specific keys not mapped: inject standard keys
      if (result.signatureImage && !Object.keys(fieldValues).some((k) => /signature/i.test(k))) {
        next["signature"] = result.signatureImage;
      }
      return next;
    });
    setFormDirty(true);
    setIsSigningOpen(false);
    toast.success("Signature and date stamp applied to requisition form.");
  };

  if (loadingTemplates) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#F4F6F8]">
        <Loader2 className="h-8 w-8 animate-spin text-[#287EAD]" />
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="mx-auto mt-12 max-w-xl border border-[#C8CDD2] bg-white p-8 shadow-sm">
        <div className="flex items-start gap-3">
          <FileText className="mt-1 h-6 w-6 text-amber-500" />
          <div>
            <h2 className="text-xl font-semibold text-[#1F2933]">No Requisition Templates Found</h2>
            <p className="mt-2 text-sm text-[#5E6870]">
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
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F6F8] pb-16">
      {/* Top Header Bar */}
      <div className="border-b border-[#E4E7EB] bg-white px-6 py-4 shadow-sm sticky top-0 z-30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                if (formDirty && !window.confirm("Discard unsaved changes?")) return;
                navigate("/list");
              }}
              className="text-[#5E6870] hover:text-[#1F2933]"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-[#1F2933]">New Requisition</h1>
                {refreshingTemplate && (
                  <span className="flex items-center gap-1 text-[11px] text-[#287EAD]">
                    <RefreshCw className="h-3 w-3 animate-spin" /> Syncing template...
                  </span>
                )}
              </div>
              <p className="text-xs text-[#5E6870]">
                Live builder updates &amp; dynamic IF/regex formulas active
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
              Template:
            </label>
            <select
              value={selectedTemplateId || ""}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              className="h-9 border border-[#AEB5BB] bg-white px-3 text-sm font-medium text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]"
            >
              {templates.map((t: any) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setIsSigningOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-[#287EAD] bg-[#EEF6FB] px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#D9EDF8]"
            >
              <PenTool className="h-3.5 w-3.5" />
              Apply Signature / Date
            </button>
          </div>
        </div>
      </div>

      {/* Main Container */}
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        {/* Missing fields banner */}
        {missingFields.length > 0 && (
          <div className="rounded border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900">
            <div className="flex items-center gap-2 font-semibold">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              Please complete the following required fields before submitting:
            </div>
            <ul className="mt-2 list-disc list-inside space-y-0.5">
              {missingFields.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Live SunSystems Budget Check Banner */}
        {selectedTemplate && (
          <BudgetBanner
            values={formValues}
            templateId={selectedTemplateId || undefined}
            mapping={selectedTemplate?.sunsystems?.budget ?? null}
            sections={selectedTemplate.sections ?? []}
            enabled={true}
          />
        )}

        {/* Dynamic Requisition Form */}
        {loadingTemplate ? (
          <div className="flex h-64 items-center justify-center rounded border border-[#C8CDD2] bg-white">
            <Loader2 className="h-6 w-6 animate-spin text-[#287EAD]" />
          </div>
        ) : selectedTemplate ? (
          <div className="rounded border border-[#C8CDD2] bg-white p-6 shadow-sm">
            <TemplateForm
              sections={selectedTemplate.sections ?? []}
              values={formValues}
              onChange={handleFieldChange}
              readOnly={false}
              documentId={undefined}
              onLaunchSignatureModal={() => setIsSigningOpen(true)}
            />

            {/* Signature Modal */}
            {isSigningOpen && (
              <SignaturePlacementModal
                mode="form"
                formFields={detectedFormFields}
                confirmLabel="Apply to Form"
                onCancel={() => setIsSigningOpen(false)}
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
                  setFormDirty(true);
                  setIsSigningOpen(false);
                }}
                onApplyToForm={(fields) => {
                  setFormValues((prev) => ({ ...prev, ...fields }));
                  setFormDirty(true);
                }}
              />
            )}

            {/* Bottom Actions */}
            <div className="mt-8 flex items-center justify-between border-t border-[#E4E7EB] pt-5">
              <span className="text-xs text-[#5E6870]">
                {formDirty ? "● Unsaved edits" : "Form is up-to-date"}
              </span>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (formDirty && !window.confirm("Discard changes and return to list?")) return;
                    navigate("/list");
                  }}
                  className="rounded border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => saveDraftMutation.mutate()}
                  disabled={saveDraftMutation.isPending}
                  className="inline-flex items-center gap-2 rounded border border-[#287EAD] bg-white px-4 py-2 text-sm font-semibold text-[#287EAD] hover:bg-[#EEF6FB] disabled:opacity-50"
                >
                  {saveDraftMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save Draft
                </button>
                <button
                  type="button"
                  onClick={() => submitMutation.mutate()}
                  disabled={submitMutation.isPending}
                  className="inline-flex items-center gap-2 rounded bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50 shadow-sm"
                >
                  {submitMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Submit Requisition
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-64 items-center justify-center rounded border border-[#C8CDD2] bg-white text-[#5E6870]">
            Select a requisition template to begin
          </div>
        )}
      </div>

      {/* Signature Placement Modal (configured for direct Form mode) */}
      {isSigningOpen && (
        <SignaturePlacementModal
          mode="form"
          documentTitle={selectedTemplate?.name || "Requisition Authorization"}
          signerName={user?.full_name || ""}
          formFields={detectedFormFields}
          onCancel={() => setIsSigningOpen(false)}
          onConfirm={(result) => {
            if (result.formFieldValues) {
              handleApplySignature(result.formFieldValues, result);
            } else {
              setIsSigningOpen(false);
            }
          }}
          onApplyToForm={handleApplySignature}
        />
      )}
    </div>
  );
}